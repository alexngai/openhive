// ============================================================================
// Session-Specific API Routes
// Extended functionality for agent session sync
// ============================================================================

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { authMiddleware } from '../middleware/auth.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as trajectoryDAL from '../../db/dal/trajectory-checkpoints.js';
import { findSwarmById } from '../../db/dal/map.js';
import { getDatabase } from '../../db/index.js';
import { broadcastToChannel } from '../../realtime/index.js';
import { fetchTranscriptFromSwarm } from '../../map/trajectory-content.js';
import { findAcpAgentInfo, getInbound, getPeerMapId } from '../../map/connection-registry.js';
import { findHostedSwarmBySwarmId } from '../../swarm/dal.js';
import type { SwarmManager } from '../../swarm/manager.js';
import {
  detectFormatExtended,
  getSupportedFormats,
  quickExtractStats,
  toAcpEventsPaginated,
  getAdapter,
} from '../../sessions/adapters/index.js';
import {
  getSessionStorage,
  isSessionStorageInitialized,
  calculateChecksum,
} from '../../sessions/storage/index.js';
import type { SessionManifest } from '../../sessions/storage/types.js';
import type {
  SessionResourceMetadata,
  SessionParticipant,
  SessionCheckpoint,
  SessionFormatEntry,
} from '../../types.js';
import type { Config } from '../../config.js';
import { sessionChatRoutes } from './session-chat.js';

// ============================================================================
// Validation Schemas
// ============================================================================

const UploadSessionSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  visibility: z.enum(['private', 'shared', 'public']).default('private'),
  format_id: z.string().optional(), // Auto-detect if not provided
  tags: z.array(z.string().max(50)).max(10).optional(),
  storage_backend: z.enum(['git', 'local', 's3', 'gcs']).default('local'),
  // Relationship fields
  parent_session_id: z.string().optional(), // For continuations
  fork_from: z
    .object({
      session_id: z.string(),
      event_index: z.number().int().min(0),
      reason: z.string().max(500).optional(),
    })
    .optional(),
});

const CreateCheckpointSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  event_index: z.number().int().min(0),
  event_id: z.string().optional(),
});

const AddParticipantSchema = z.object({
  agent_id: z.string().min(1),
  role: z.enum(['collaborator', 'observer']).default('observer'),
});

const UpdateCursorSchema = z.object({
  event_index: z.number().int().min(0),
  event_id: z.string().optional(),
});

const QuerySessionsSchema = z.object({
  format_id: z.string().optional(),
  format_vendor: z.string().optional(),
  state: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
  min_messages: z.coerce.number().int().min(0).optional(),
  max_messages: z.coerce.number().int().min(0).optional(),
  has_tool_calls: z
    .string()
    .transform((v) => v === 'true')
    .optional(),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// ============================================================================
// Local Sessionlog Transcript Lookup
// ============================================================================

/**
 * Try to read a session transcript directly from sessionlog's local state.
 * Works when OpenHive runs on the same machine as the Claude Code agent.
 *
 * Extracts the session ID from checkpoint data, finds the sessionlog state
 * file at .git/sessionlog-sessions/<sessionID>.json, reads the transcriptPath,
 * and returns the raw JSONL content.
 *
 * @returns transcript string or null if not available locally
 */
async function trySessionlogDir(sessionlogDir: string, sessionId: string): Promise<string | null> {
  try {
    const statePath = path.join(sessionlogDir, `${sessionId}.json`);
    await fsp.access(statePath);
    const stateRaw = await fsp.readFile(statePath, 'utf-8');
    const state = JSON.parse(stateRaw);
    const transcriptPath = state.transcriptPath;
    if (!transcriptPath) return null;
    await fsp.access(transcriptPath);
    return await fsp.readFile(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
}

async function readLocalSessionlogTranscript(sessionResourceId: string, config?: Config): Promise<string | null> {
  try {
    // Get session_id from the latest checkpoint's checkpoint_id
    // Checkpoint IDs are formatted as: {sessionID}-step{N} or just {sessionID}
    const { data: checkpoints } = trajectoryDAL.listCheckpointsForSession(sessionResourceId, 1, 0);
    if (checkpoints.length === 0) return null;

    const checkpointId = checkpoints[0].checkpoint_id;
    // Extract session ID: either everything before -step, or the whole ID
    const sessionId = checkpointId.replace(/-step\d+$/, '');
    if (!sessionId) return null;

    // Build list of directories to search for sessionlog state files.
    // Priority: configured paths → resource projectPath → swarm projectPath → CWD fallback
    const searchDirs: string[] = [
      ...(config?.sessionlog?.sessionDirs ?? []),
    ];

    // Get the agent's project directory from the resource metadata.
    // This is stored during checkpoint handling and points to the agent's
    // actual working directory where .git/sessionlog-sessions/ lives.
    const resource = resourcesDAL.findResourceById(sessionResourceId);
    const resourceMeta = resource?.metadata as Record<string, unknown> | undefined;
    const resourceProjectPath = resourceMeta?.projectPath as string | undefined;
    if (resourceProjectPath) {
      searchDirs.push(path.join(resourceProjectPath, '.git', 'sessionlog-sessions'));
    }

    // Also check the swarm's metadata as a fallback
    const swarmId = checkpoints[0].source_swarm_id;
    if (swarmId) {
      const swarm = findSwarmById(swarmId);
      const swarmMeta = swarm?.metadata as Record<string, unknown> | undefined;
      const swarmProjectPath = swarmMeta?.projectPath as string | undefined;
      if (swarmProjectPath && swarmProjectPath !== resourceProjectPath) {
        searchDirs.push(path.join(swarmProjectPath, '.git', 'sessionlog-sessions'));
      }
    }

    // Fall back to OpenHive server's working directory
    searchDirs.push(path.join(process.cwd(), '.git', 'sessionlog-sessions'));

    for (const sessionlogDir of searchDirs) {
      const result = await trySessionlogDir(sessionlogDir, sessionId);
      if (result) return result;
    }

    // Last resort: scan sibling directories of CWD for the session state file.
    // Handles the common case where project repos live under the same parent
    // (e.g. ~/GitHub/openhive, ~/GitHub/openhive-3, ~/GitHub/other-project).
    // Only triggered when projectPath is not yet stored in metadata.
    const parentDir = path.dirname(process.cwd());
    try {
      const siblings = await fsp.readdir(parentDir, { withFileTypes: true });
      for (const entry of siblings) {
        if (!entry.isDirectory()) continue;
        const siblingSessionlogDir = path.join(parentDir, entry.name, '.git', 'sessionlog-sessions');
        // Skip directories we already checked
        if (searchDirs.some(d => d === siblingSessionlogDir)) continue;
        const result = await trySessionlogDir(siblingSessionlogDir, sessionId);
        if (result) return result;
      }
    } catch {
      // Parent directory not readable — skip scan
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Routes
// ============================================================================

export async function sessionsRoutes(
  fastify: FastifyInstance,
  _options: { config: Config }
): Promise<void> {

  // Register session chat sub-routes
  await sessionChatRoutes(fastify);

  // ============================================================================
  // Format Registry Endpoints
  // ============================================================================

  // List supported formats
  fastify.get('/sessions/formats', async (_request, reply) => {
    const formats = getSupportedFormats();

    // Also get custom formats from database
    const db = getDatabase();
    const customFormats = db
      .prepare('SELECT * FROM session_format_registry')
      .all() as SessionFormatEntry[];

    return reply.send({
      builtin: formats.filter((f) => f.builtin),
      custom: customFormats.map((f) => ({
        id: f.id,
        name: f.name,
        vendor: f.vendor,
        version: f.version,
        is_acp_native: Boolean(f.is_acp_native),
        adapter_type: f.adapter_type,
      })),
    });
  });

  // Detect format of content
  fastify.post(
    '/sessions/detect-format',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const body = request.body as { content: string; filename?: string };

      if (!body.content) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Content is required',
        });
      }

      const detection = detectFormatExtended({
        content: body.content,
        filename: body.filename,
        sizeBytes: body.content.length,
      });

      const stats = quickExtractStats(body.content, detection.formatId);

      return reply.send({
        format_id: detection.formatId,
        format_name: detection.formatName,
        confidence: detection.confidence,
        index: stats.index,
      });
    }
  );

  // ============================================================================
  // Session Upload Endpoint
  // ============================================================================

  // Upload a session (creates resource + stores content)
  fastify.post(
    '/sessions/upload',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const parseResult = UploadSessionSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const {
        name,
        description,
        visibility,
        format_id,
        tags,
        storage_backend,
        parent_session_id,
        fork_from,
      } = parseResult.data;

      // Get content from body
      const content = (request.body as { content?: string }).content;
      if (!content) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Session content is required',
        });
      }

      // Validate parent session if provided
      let parentSession: ReturnType<typeof resourcesDAL.findResourceById> | null = null;
      if (parent_session_id) {
        parentSession = resourcesDAL.findResourceById(parent_session_id);
        if (!parentSession || parentSession.resource_type !== 'session') {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Parent session not found',
          });
        }
        if (!resourcesDAL.canAccessResource(request.agent!.id, parentSession)) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'You do not have access to the parent session',
          });
        }
      }

      // Validate fork source if provided
      let forkSourceSession: ReturnType<typeof resourcesDAL.findResourceById> | null = null;
      if (fork_from) {
        forkSourceSession = resourcesDAL.findResourceById(fork_from.session_id);
        if (!forkSourceSession || forkSourceSession.resource_type !== 'session') {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Fork source session not found',
          });
        }
        if (!resourcesDAL.canAccessResource(request.agent!.id, forkSourceSession)) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'You do not have access to the fork source session',
          });
        }
      }

      // Detect or validate format
      const detection = detectFormatExtended({
        content,
        sizeBytes: content.length,
      });

      const effectiveFormatId = format_id || detection.formatId;

      // Extract index/stats
      const stats = quickExtractStats(content, effectiveFormatId);
      const adapter = getAdapter(effectiveFormatId);
      const sessionConfig = adapter?.extractConfig?.(content);

      // Build session metadata with relationships
      const sessionMetadata: SessionResourceMetadata = {
        format: {
          id: effectiveFormatId,
          detected: !format_id,
        },
        acp: {
          native: effectiveFormatId === 'acp_v1',
        },
        config: sessionConfig,
        index: stats.index,
        storage: {
          backend: storage_backend,
          sizeBytes: content.length,
        },
        // Track relationships
        relationships:
          parent_session_id || fork_from
            ? {
                parentSessionId: parent_session_id,
                forkedFromId: fork_from?.session_id,
                forkPointEventIndex: fork_from?.event_index,
              }
            : undefined,
      };

      // For non-git storage, we need to store the content
      let gitRemoteUrl = '';
      let storageLocation: string | undefined;

      if (storage_backend !== 'git') {
        if (!isSessionStorageInitialized()) {
          return reply.status(503).send({
            error: 'Service Unavailable',
            message: 'Session storage is not configured',
          });
        }

        const sessionId = `ses_${nanoid()}`;
        const storage = getSessionStorage();

        // Create manifest
        const manifest: SessionManifest = {
          version: '1.0',
          sessionId,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          format: {
            id: effectiveFormatId,
            detected: !format_id,
          },
          files: {
            primary: 'session.jsonl',
          },
          checksums: {
            'session.jsonl': await calculateChecksum(content),
          },
          stats: {
            messageCount: stats.index.messageCount,
            toolCallCount: stats.index.toolCallCount,
            sizeBytes: content.length,
          },
        };

        // Store session
        const result = await storage.store(
          { sessionId, agentId: request.agent!.id },
          [
            { path: 'session.jsonl', content },
            { path: 'manifest.json', content: JSON.stringify(manifest, null, 2) },
          ]
        );

        storageLocation = result.location;
        sessionMetadata.storage!.location = storageLocation;

        // Use storage location as pseudo git URL for the resource
        gitRemoteUrl = `local://${result.location}`;
      } else {
        // Git-backed session requires a git_remote_url in the request
        const gitUrl = (request.body as { git_remote_url?: string }).git_remote_url;
        if (!gitUrl) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'git_remote_url is required for git-backed sessions',
          });
        }
        gitRemoteUrl = gitUrl;
      }

      // Create the resource
      try {
        const resource = resourcesDAL.createResource({
          resource_type: 'session',
          name,
          description,
          git_remote_url: gitRemoteUrl,
          visibility,
          owner_agent_id: request.agent!.id,
          metadata: sessionMetadata as unknown as Record<string, unknown>,
        });

        // Set tags if provided
        if (tags && tags.length > 0) {
          resourcesDAL.setResourceTags(resource.id, tags);
        }

        // Add owner as participant
        const db = getDatabase();
        const participantId = nanoid();
        db.prepare(`
          INSERT INTO session_participants (id, session_resource_id, agent_id, role)
          VALUES (?, ?, ?, 'owner')
        `).run(participantId, resource.id, request.agent!.id);

        // Create fork record if this is a forked session
        let forkId: string | undefined;
        if (fork_from) {
          forkId = `fork_${nanoid()}`;
          db.prepare(`
            INSERT INTO session_forks
            (id, parent_session_id, child_session_id, fork_point_event_index, fork_reason)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            forkId,
            fork_from.session_id,
            resource.id,
            fork_from.event_index,
            fork_from.reason || null
          );
        }

        const resourceWithMeta = resourcesDAL.getResourceWithMeta(
          resource.id,
          request.agent!.id
        );

        return reply.status(201).send({
          ...resourceWithMeta,
          session: {
            format_id: effectiveFormatId,
            format_detected: !format_id,
            detection_confidence: detection.confidence,
            storage_backend,
            storage_location: storageLocation,
            // Include relationship info in response
            parent_session_id: parent_session_id || undefined,
            forked_from: fork_from
              ? {
                  session_id: fork_from.session_id,
                  event_index: fork_from.event_index,
                  fork_id: forkId,
                }
              : undefined,
          },
        });
      } catch (error) {
        if ((error as Error).message?.includes('UNIQUE constraint failed')) {
          return reply.status(409).send({
            error: 'Conflict',
            message: 'A session with this name already exists for your account',
          });
        }
        throw error;
      }
    }
  );

  // ============================================================================
  // Session Content Endpoints
  // ============================================================================

  // Get session content
  fastify.get<{ Params: { id: string } }>(
    '/sessions/:id/content',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'session') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Session not found',
        });
      }

      if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have access to this session',
        });
      }

      const metadata = resource.metadata as SessionResourceMetadata | null;
      const storageBackend = metadata?.storage?.backend;

      if (storageBackend && storageBackend !== 'git') {
        if (!isSessionStorageInitialized()) {
          return reply.status(503).send({
            error: 'Service Unavailable',
            message: 'Session storage is not configured',
          });
        }

        const storage = getSessionStorage();

        // Extract session ID from resource - try git_remote_url or metadata
        const sessionIdMatch = resource.git_remote_url.match(/ses_[a-zA-Z0-9_-]+/);
        if (!sessionIdMatch) {
          return reply.status(500).send({
            error: 'Internal Error',
            message: 'Could not determine session storage location',
          });
        }

        const content = await storage.retrieve(
          { sessionId: sessionIdMatch[0], agentId: resource.owner_agent_id },
          'session.jsonl'
        );

        if (!content) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Session content not found',
          });
        }

        return reply
          .header('Content-Type', 'application/x-ndjson')
          .send(content);
      }

      // Git-backed session - return git info
      return reply.send({
        storage: 'git',
        git_remote_url: resource.git_remote_url,
        last_commit_hash: resource.last_commit_hash,
        message: 'Retrieve content from git repository',
      });
    }
  );

  // Get session events (ACP-converted)
  fastify.get<{ Params: { id: string }; Querystring: { limit?: number; offset?: number; order?: string } }>(
    '/sessions/:id/events',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'session') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Session not found',
        });
      }

      if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have access to this session',
        });
      }

      const metadata = resource.metadata as SessionResourceMetadata | null;
      const storageBackend = metadata?.storage?.backend;
      const limit = Math.min(Number(request.query.limit) || 100, 500);
      const offset = Number(request.query.offset) || 0;
      const order = request.query.order === 'asc' ? 'asc' as const : 'desc' as const;

      let content: string | null = null;
      let formatId = metadata?.format?.id || 'claude_jsonl_v1';

      // Try local storage first (uploaded sessions use ses_ IDs, cached trajectories use resource ID)
      if (storageBackend && storageBackend !== 'git' && isSessionStorageInitialized()) {
        const storage = getSessionStorage();
        const sessionIdMatch = resource.git_remote_url.match(/ses_[a-zA-Z0-9_-]+/);
        const storageSessionId = sessionIdMatch?.[0] || resource.id;
        content = await storage.retrieve(
          { sessionId: storageSessionId, agentId: resource.owner_agent_id },
          'session.jsonl'
        ) as string | null;
      }

      // Fall back to on-demand fetch from connected swarm
      if (!content) {
        content = await fetchTranscriptFromSwarm(resource.id);
        if (content) {
          formatId = 'claude_jsonl_v1';

          // Cache the transcript to session storage for subsequent requests
          if (isSessionStorageInitialized()) {
            try {
              const storage = getSessionStorage();
              await storage.store(
                { sessionId: resource.id, agentId: resource.owner_agent_id },
                [{ path: 'session.jsonl', content }],
              );
              resourcesDAL.updateResource(resource.id, {
                metadata: {
                  ...(resource.metadata as Record<string, unknown> || {}),
                  format: { id: 'claude_jsonl_v1' },
                  storage: { backend: 'local', cachedAt: new Date().toISOString() },
                  trajectory: { source: 'swarm' },
                },
              });
            } catch {
              // Non-critical — cache failure doesn't block the response
            }
          }
        }
      }

      // Try reading transcript directly from sessionlog on local disk.
      // Works when OpenHive runs on the same machine as the Claude Code agent.
      // Uses the session_id from checkpoint metadata to find the sessionlog state,
      // which contains the transcriptPath to the Claude Code JSONL file.
      if (!content) {
        content = await readLocalSessionlogTranscript(resource.id, _options.config);
        if (content) {
          formatId = 'claude_jsonl_v1';
        }
      }

      // Last resort: try stale cache on disk (swarm offline, metadata invalidated by checkpoint)
      if (!content && isSessionStorageInitialized()) {
        try {
          const storage = getSessionStorage();
          const staleContent = await storage.retrieve(
            { sessionId: resource.id, agentId: resource.owner_agent_id },
            'session.jsonl'
          ) as string | null;
          if (staleContent) {
            content = staleContent;
            formatId = 'claude_jsonl_v1';
          }
        } catch {
          // No stale cache available
        }
      }

      if (!content) {
        // No trajectory transcript available yet. This is the normal case for
        // ACP sessions before any checkpoint has been persisted — the client
        // should then call ACP session/load on the stream to replay history
        // from the agent. Returning 200 with empty events lets the session
        // detail page load cleanly instead of blocking on a 503.
        return reply.send({
          format_id: formatId,
          total: 0,
          limit,
          offset,
          events: [],
        });
      }

      // Convert to ACP events (paginated — only parses enough lines for the requested page)
      const { events: paginatedEvents, total, formatId: resolvedFormatId } =
        toAcpEventsPaginated(content, limit, offset, formatId, order);

      return reply.send({
        format_id: resolvedFormatId,
        total,
        limit,
        offset,
        events: paginatedEvents,
      });
    }
  );

  // ============================================================================
  // Session Participants
  // ============================================================================

  // List participants
  fastify.get<{ Params: { id: string } }>(
    '/sessions/:id/participants',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'session') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Session not found',
        });
      }

      if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have access to this session',
        });
      }

      const db = getDatabase();
      const participants = db
        .prepare(
          `
        SELECT sp.*, a.name as agent_name, a.avatar_url as agent_avatar_url
        FROM session_participants sp
        JOIN agents a ON sp.agent_id = a.id
        WHERE sp.session_resource_id = ?
        ORDER BY sp.joined_at
      `
        )
        .all(resource.id) as Array<
        SessionParticipant & { agent_name: string; agent_avatar_url: string | null }
      >;

      return reply.send({ participants });
    }
  );

  // Add participant
  fastify.post<{ Params: { id: string } }>(
    '/sessions/:id/participants',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'session') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Session not found',
        });
      }

      if (!resourcesDAL.canModifyResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to add participants',
        });
      }

      const parseResult = AddParticipantSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const { agent_id, role } = parseResult.data;

      const db = getDatabase();

      // Check if already a participant
      const existing = db
        .prepare(
          'SELECT id FROM session_participants WHERE session_resource_id = ? AND agent_id = ?'
        )
        .get(resource.id, agent_id);

      if (existing) {
        return reply.status(409).send({
          error: 'Conflict',
          message: 'Agent is already a participant',
        });
      }

      const participantId = nanoid();
      db.prepare(
        `
        INSERT INTO session_participants (id, session_resource_id, agent_id, role)
        VALUES (?, ?, ?, ?)
      `
      ).run(participantId, resource.id, agent_id, role);

      // Also grant resource access
      resourcesDAL.subscribeToResource(
        agent_id,
        resource.id,
        role === 'collaborator' ? 'write' : 'read'
      );

      // Broadcast participant joined
      const channel = resourcesDAL.getResourceChannel(resource);
      broadcastToChannel(channel, {
        type: 'resource_updated',
        data: {
          resource_id: resource.id,
          event_type: 'participant_joined',
          agent_id,
          role,
        },
      });

      return reply.status(201).send({
        id: participantId,
        session_resource_id: resource.id,
        agent_id,
        role,
        joined_at: new Date().toISOString(),
      });
    }
  );

  // Update participant cursor
  fastify.patch<{ Params: { id: string } }>(
    '/sessions/:id/cursor',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'session') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Session not found',
        });
      }

      const parseResult = UpdateCursorSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const { event_index, event_id } = parseResult.data;

      const db = getDatabase();
      const result = db
        .prepare(
          `
        UPDATE session_participants
        SET cursor_event_index = ?, cursor_event_id = ?, last_active_at = datetime('now')
        WHERE session_resource_id = ? AND agent_id = ?
      `
        )
        .run(event_index, event_id || null, resource.id, request.agent!.id);

      if (result.changes === 0) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'You are not a participant in this session',
        });
      }

      return reply.send({ success: true, event_index, event_id });
    }
  );

  // ============================================================================
  // Session Checkpoints
  // ============================================================================

  // List checkpoints
  fastify.get<{ Params: { id: string } }>(
    '/sessions/:id/checkpoints',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'session') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Session not found',
        });
      }

      if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have access to this session',
        });
      }

      const db = getDatabase();

      // Query both manual checkpoints (session_checkpoints) and
      // trajectory checkpoints (trajectory_checkpoints) from agent sidecars.
      const manualCheckpoints = db
        .prepare(
          `
        SELECT sc.*, a.name as creator_name
        FROM session_checkpoints sc
        LEFT JOIN agents a ON sc.created_by_agent_id = a.id
        WHERE sc.session_resource_id = ?
        ORDER BY sc.event_index
      `
        )
        .all(resource.id) as Array<SessionCheckpoint & { creator_name: string | null }>;

      const trajectoryCheckpoints = db
        .prepare(
          `
        SELECT id, session_resource_id, checkpoint_id, commit_hash, agent,
               branch, files_touched, checkpoints_count, token_usage,
               source_swarm_id, source_agent_id
        FROM trajectory_checkpoints
        WHERE session_resource_id = ?
        ORDER BY rowid
      `
        )
        .all(resource.id) as Array<Record<string, unknown>>;

      // Merge both sources — trajectory checkpoints are normalized to match the API shape
      const checkpoints = [
        ...manualCheckpoints,
        ...trajectoryCheckpoints.map((tc) => ({
          id: tc.id,
          session_resource_id: tc.session_resource_id,
          checkpoint_id: tc.checkpoint_id,
          commit_hash: tc.commit_hash,
          agent: tc.agent,
          branch: tc.branch,
          files_touched: typeof tc.files_touched === 'string' ? JSON.parse(tc.files_touched as string) : tc.files_touched,
          checkpoints_count: tc.checkpoints_count,
          token_usage: typeof tc.token_usage === 'string' ? JSON.parse(tc.token_usage as string) : tc.token_usage,
          source_swarm_id: tc.source_swarm_id,
          source_agent_id: tc.source_agent_id,
          creator_name: tc.agent,
        })),
      ];

      return reply.send({ checkpoints, data: checkpoints, total: checkpoints.length });
    }
  );

  // Create checkpoint
  fastify.post<{ Params: { id: string } }>(
    '/sessions/:id/checkpoints',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'session') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Session not found',
        });
      }

      // Check write permission
      const permission = resourcesDAL.getAgentPermission(
        request.agent!.id,
        resource
      );
      if (!permission || permission === 'read') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have permission to create checkpoints',
        });
      }

      const parseResult = CreateCheckpointSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const { name, description, event_index, event_id } = parseResult.data;

      const db = getDatabase();
      const checkpointId = `chk_${nanoid()}`;

      db.prepare(
        `
        INSERT INTO session_checkpoints
        (id, session_resource_id, name, description, event_index, event_id, created_by_agent_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        checkpointId,
        resource.id,
        name,
        description || null,
        event_index,
        event_id || null,
        request.agent!.id
      );

      // Broadcast checkpoint created
      const channel = resourcesDAL.getResourceChannel(resource);
      broadcastToChannel(channel, {
        type: 'resource_updated',
        data: {
          resource_id: resource.id,
          event_type: 'checkpoint_created',
          checkpoint_id: checkpointId,
          name,
          event_index,
        },
      });

      return reply.status(201).send({
        id: checkpointId,
        session_resource_id: resource.id,
        name,
        description,
        event_index,
        event_id,
        created_at: new Date().toISOString(),
        created_by_agent_id: request.agent!.id,
      });
    }
  );

  // ============================================================================
  // Session Forks
  // ============================================================================

  // List forks of a session
  fastify.get<{ Params: { id: string } }>(
    '/sessions/:id/forks',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'session') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Session not found',
        });
      }

      if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have access to this session',
        });
      }

      const db = getDatabase();

      // Get sessions forked FROM this session
      const childForks = db
        .prepare(
          `
        SELECT
          sf.*,
          r.name as child_name,
          r.description as child_description,
          a.name as child_owner_name
        FROM session_forks sf
        JOIN syncable_resources r ON sf.child_session_id = r.id
        JOIN agents a ON r.owner_agent_id = a.id
        WHERE sf.parent_session_id = ?
        ORDER BY sf.created_at DESC
      `
        )
        .all(resource.id);

      // Get the session this was forked FROM (if any)
      const parentFork = db
        .prepare(
          `
        SELECT
          sf.*,
          r.name as parent_name,
          r.description as parent_description,
          a.name as parent_owner_name
        FROM session_forks sf
        JOIN syncable_resources r ON sf.parent_session_id = r.id
        JOIN agents a ON r.owner_agent_id = a.id
        WHERE sf.child_session_id = ?
      `
        )
        .get(resource.id);

      return reply.send({
        forked_from: parentFork || null,
        forks: childForks,
      });
    }
  );

  // Get session lineage (full ancestry chain)
  fastify.get<{ Params: { id: string } }>(
    '/sessions/:id/lineage',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);

      if (!resource || resource.resource_type !== 'session') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Session not found',
        });
      }

      if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'You do not have access to this session',
        });
      }

      const db = getDatabase();
      const lineage: Array<{
        id: string;
        name: string;
        fork_point_event_index: number;
        depth: number;
      }> = [];

      // Walk up the ancestry chain
      let currentId = resource.id;
      let depth = 0;
      const maxDepth = 100; // Prevent infinite loops

      while (depth < maxDepth) {
        const parent = db
          .prepare(
            `
          SELECT
            sf.parent_session_id,
            sf.fork_point_event_index,
            r.name
          FROM session_forks sf
          JOIN syncable_resources r ON sf.parent_session_id = r.id
          WHERE sf.child_session_id = ?
        `
          )
          .get(currentId) as {
          parent_session_id: string;
          fork_point_event_index: number;
          name: string;
        } | undefined;

        if (!parent) break;

        lineage.push({
          id: parent.parent_session_id,
          name: parent.name,
          fork_point_event_index: parent.fork_point_event_index,
          depth: depth + 1,
        });

        currentId = parent.parent_session_id;
        depth++;
      }

      return reply.send({
        session_id: resource.id,
        session_name: resource.name,
        ancestors: lineage,
        depth: lineage.length,
      });
    }
  );

  // ============================================================================
  // Session Query Endpoint
  // ============================================================================

  // Query sessions with filters
  fastify.get<{ Querystring: z.infer<typeof QuerySessionsSchema> }>(
    '/sessions/query',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const parseResult = QuerySessionsSchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          details: parseResult.error.issues,
        });
      }

      const {
        format_id,
        format_vendor,
        min_messages,
        max_messages,
        has_tool_calls,
        created_after,
        created_before,
        search,
        limit,
        offset,
      } = parseResult.data;

      const db = getDatabase();

      // Build query with metadata JSON extraction
      let whereClause = "r.resource_type = 'session'";
      const params: unknown[] = [];

      // Access control
      whereClause += ` AND (
        r.owner_agent_id = ?
        OR r.id IN (SELECT resource_id FROM resource_subscriptions WHERE agent_id = ?)
        OR r.visibility = 'public'
      )`;
      params.push(request.agent!.id, request.agent!.id);

      if (format_id) {
        whereClause += ` AND json_extract(r.metadata, '$.format.id') = ?`;
        params.push(format_id);
      }

      if (format_vendor) {
        // This would require joining with format registry
        // For now, skip vendor filtering
      }

      if (min_messages !== undefined) {
        whereClause += ` AND json_extract(r.metadata, '$.index.messageCount') >= ?`;
        params.push(min_messages);
      }

      if (max_messages !== undefined) {
        whereClause += ` AND json_extract(r.metadata, '$.index.messageCount') <= ?`;
        params.push(max_messages);
      }

      if (has_tool_calls !== undefined) {
        if (has_tool_calls) {
          whereClause += ` AND json_extract(r.metadata, '$.index.toolCallCount') > 0`;
        } else {
          whereClause += ` AND (json_extract(r.metadata, '$.index.toolCallCount') = 0 OR json_extract(r.metadata, '$.index.toolCallCount') IS NULL)`;
        }
      }

      if (created_after) {
        whereClause += ` AND r.created_at >= ?`;
        params.push(created_after);
      }

      if (created_before) {
        whereClause += ` AND r.created_at <= ?`;
        params.push(created_before);
      }

      if (search) {
        whereClause += ` AND (r.name LIKE ? OR r.description LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
      }

      // Get total count
      const countRow = db
        .prepare(`SELECT COUNT(*) as count FROM syncable_resources r WHERE ${whereClause}`)
        .get(...params) as { count: number };

      // Get paginated results
      const rows = db
        .prepare(
          `
        SELECT r.*, a.name as owner_name, a.avatar_url as owner_avatar_url
        FROM syncable_resources r
        JOIN agents a ON r.owner_agent_id = a.id
        WHERE ${whereClause}
        ORDER BY r.updated_at DESC
        LIMIT ? OFFSET ?
      `
        )
        .all(...params, limit, offset) as Array<
        Record<string, unknown> & { owner_name: string; owner_avatar_url: string | null }
      >;

      const data = rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        visibility: row.visibility,
        owner: {
          id: row.owner_agent_id,
          name: row.owner_name,
          avatar_url: row.owner_avatar_url,
        },
        metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }));

      return reply.send({
        data,
        total: countRow.count,
        limit,
        offset,
      });
    }
  );

  // ============================================================================
  // Trajectory Checkpoint Endpoints (from MAP sync)
  // ============================================================================

  // List all sessions with trajectory checkpoint stats
  fastify.get<{ Querystring: { limit?: number; offset?: number; swarm_id?: string; search?: string } }>(
    '/sessions/overview',
    async (request, reply) => {
      const limit = Math.min(Number(request.query.limit) || 50, 100);
      const offset = Number(request.query.offset) || 0;
      const swarmId = request.query.swarm_id || undefined;
      const search = request.query.search?.trim() || undefined;
      const result = trajectoryDAL.listAllSessions(limit, offset, swarmId, search);
      return reply.send(result);
    }
  );

  // List trajectory checkpoints for a session
  fastify.get<{ Params: { id: string }; Querystring: { limit?: number; offset?: number } }>(
    '/sessions/:id/trajectory-checkpoints',
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);
      if (!resource || resource.resource_type !== 'session') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Session not found',
        });
      }

      const limit = Math.min(Number(request.query.limit) || 50, 100);
      const offset = Number(request.query.offset) || 0;
      const result = trajectoryDAL.listCheckpointsForSession(resource.id, limit, offset);
      return reply.send(result);
    }
  );

  // Get trajectory stats for a session
  fastify.get<{ Params: { id: string } }>(
    '/sessions/:id/trajectory-stats',
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);
      if (!resource || resource.resource_type !== 'session') {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Session not found',
        });
      }

      const stats = trajectoryDAL.getSessionStats(resource.id);
      return reply.send(stats);
    }
  );

  // Open an ACP session against an already-registered ACP-capable agent on
  // a swarm. Eagerly creates the session resource + ACP stream so the user
  // can navigate to the session immediately and start chatting.
  //
  // `agent_id` is required — pass the hub's agent id (preferred) or the
  // agent's peerMapId. The caller is expected to have already spawned the
  // agent via POST /map/swarms/:id/agents (or it was spawned elsewhere).
  //
  // Callers that want a one-click "spawn + connect" flow should chain the
  // two endpoints client-side.
  fastify.post<{ Body: { swarm_id: string; agent_id: string; peer_map_id?: string; cwd?: string } }>(
    '/sessions/acp-connect',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const { swarm_id, agent_id, peer_map_id, cwd } = request.body || ({} as any);
      if (!swarm_id) {
        return reply.status(400).send({ error: 'swarm_id is required' });
      }
      if (!agent_id) {
        return reply.status(400).send({ error: 'agent_id is required' });
      }

      const swarm = findSwarmById(swarm_id);
      if (!swarm) {
        return reply.status(404).send({ error: 'Swarm not found' });
      }

      // Access SwarmCraft's ACP stream manager via the fastify instance
      const sc = (fastify as any).swarmcraft;
      if (!sc?.acpStreamManager) {
        return reply.status(503).send({ error: 'SwarmCraft ACP not available' });
      }

      // Resolve target cwd. Reused for both the ACP session's cwd parameter
      // AND for display-name inference below. Matches macro-agent's
      // getOrCreateHeadManager cwd so we reuse the agent's existing head
      // manager rather than causing it to spawn a duplicate.
      const swarmMeta = (swarm.metadata as Record<string, unknown>) || {};
      const targetCwd = cwd
        ?? (typeof swarmMeta.cwd === 'string' ? swarmMeta.cwd : undefined)
        ?? (typeof swarmMeta.projectPath === 'string' ? swarmMeta.projectPath : undefined)
        ?? '.';

      // Resolve the agent on the hub. Accept either the hub-assigned id or
      // the agent's peer-side map id (published in registered_agents[].metadata
      // as `peerMapId` for cc-swarm or `localAgentId` for macro-agent).
      // The ACP target ID (the ID the swarm's own MAP server routes on) is
      // not always derivable from the hub registry — macro-agent's spawn
      // returns a separate `peer_map_id` for this purpose. Callers should
      // pass it through; otherwise we fall back to deriving from metadata.
      const inboundConn = getInbound(swarm_id);
      let acpAgent: string | undefined;
      let targetAgentEntry: { name?: string; metadata?: Record<string, unknown> } | undefined;
      if (inboundConn) {
        const direct = inboundConn.registeredAgents.get(agent_id);
        if (direct) {
          targetAgentEntry = direct;
          acpAgent = peer_map_id ?? getPeerMapId(direct.metadata) ?? agent_id;
        } else {
          for (const entry of inboundConn.registeredAgents.values()) {
            const peer = getPeerMapId(entry.metadata);
            if (peer === agent_id || (peer_map_id && peer === peer_map_id)) {
              targetAgentEntry = entry;
              acpAgent = peer_map_id ?? agent_id;
              break;
            }
          }
        }
      }
      // If the caller explicitly supplied a peer_map_id but the registry
      // hasn't caught up (race between spawn and lifecycle-bridge register),
      // accept it: the swarm's MAP server is the source of truth for ACP
      // routing, and the registry entry is just for capability metadata.
      if (!acpAgent && peer_map_id) {
        acpAgent = peer_map_id;
      }
      if (!acpAgent) {
        return reply.status(404).send({
          error: `Agent ${agent_id} not registered on swarm ${swarm_id}`,
        });
      }

      // Guard: agent must declare ACP support. Early 400 is friendlier than
      // letting the stream handshake fail partway through. Skip the check if
      // we fell through with peer_map_id only (registry race) — caller has
      // explicitly asserted the target supports ACP by passing peer_map_id.
      if (targetAgentEntry) {
        const agentCaps = (targetAgentEntry as any)?.capabilities as Record<string, unknown> | undefined;
        const agentProtocols = Array.isArray(agentCaps?.protocols)
          ? (agentCaps!.protocols as string[])
          : [];
        if (!agentProtocols.includes('acp')) {
          return reply.status(400).send({
            error: `Agent ${agent_id} does not advertise ACP support`,
          });
        }
      }

      try {
        // 1. Create ACP stream. acp-manager already closes any prior stream
        //    targeting the same agent on the same server (per-target dedup).
        //    Do NOT proactively close streams targeting OTHER agents on this
        //    swarm — that breaks any session the user is actively viewing
        //    against those agents (clicking Chat on coordinator B would kill
        //    coordinator A's open session, surfacing as "ACP stream closed"
        //    when the user revisits A's session URL).
        const stream = await sc.acpStreamManager.createStream(swarm_id, acpAgent);

        // 2. Initialize
        await sc.acpStreamManager.initialize(stream.streamId);

        // 3. Create ACP session (this spawns the agent inside macro-agent
        //    via getOrCreateHeadManager). Reuse the same cwd as the spawn
        //    above so getOrCreateHeadManager finds the existing head manager
        //    and doesn't spawn a second coordinator.
        const projectPath = targetCwd;
        const sessionResult = await sc.acpStreamManager.newSession(stream.streamId, {
          cwd: projectPath,
          mcpServers: [],
        });

        const acpSessionId = sessionResult.sessionId;

        // Pull display metadata from the agent entry we already resolved
        // before the stream handshake. Fall back to the first ACP-capable
        // agent for provider_session_id if the targeted agent hasn't
        // published one yet.
        const coordinatorName = (targetAgentEntry as any)?.name as string | undefined;
        let providerSessionId: string | undefined;
        const psidFromTarget = targetAgentEntry?.metadata?.provider_session_id;
        if (typeof psidFromTarget === 'string') {
          providerSessionId = psidFromTarget;
        } else {
          const fallback = findAcpAgentInfo(swarm_id);
          const psid = fallback?.metadata?.provider_session_id;
          if (typeof psid === 'string') providerSessionId = psid;
        }

        // 4. Eagerly create the session resource. Build a display name that
        // prefers the coordinator's name when the project name is uninformative
        // (empty, "." or "/"), so a user with multiple sessions can tell them
        // apart by which coordinator they're with.
        const remoteUrl = `map://session/${acpSessionId}`;
        const projectFromPath = projectPath.split('/').filter(Boolean).pop() ?? '';
        const isBadProject = !projectFromPath || projectFromPath === '.' || projectFromPath === '..';
        const shortId = acpSessionId.slice(-8);
        const nameBase = isBadProject ? (coordinatorName ?? 'session') : projectFromPath;
        const displayName = `${nameBase} [${shortId}]`;
        const project = isBadProject ? 'session' : projectFromPath;

        const { resource, created } = resourcesDAL.upsertDiscoveredResource({
          resource_type: 'session',
          name: displayName,
          description: `ACP session with ${swarm.name}`,
          git_remote_url: remoteUrl,
          owner_agent_id: request.agent!.id,
          scope: 'manual',
          metadata: {
            project,
            projectPath,
            sessionId: acpSessionId,
            source_swarm_id: swarm_id,
            acpStreamId: stream.streamId,
            ...(providerSessionId ? { provider_session_id: providerSessionId } : {}),
          },
        });

        // 5. Broadcast so the sessions list updates in real-time
        broadcastToChannel('global', {
          type: 'trajectory:sync',
          data: { session_resource_id: resource.id },
        });

        return reply.send({
          session_resource_id: resource.id,
          acp_session_id: acpSessionId,
          acp_stream_id: stream.streamId,
          created,
        });
      } catch (err) {
        return reply.status(500).send({
          error: 'Failed to create ACP session',
          message: (err as Error).message,
        });
      }
    }
  );

  // Resume an existing session whose swarm may be stopped or offline.
  //
  // Durable resume: reads provider_session_id + source_swarm_id off the
  // session resource metadata (persisted when the session was first created
  // via /sessions/acp-connect). Does NOT depend on the live connection
  // registry carrying the session's agent — macro-agent is the source of
  // truth for agent identity + provider_session_id and will rebuild its own
  // routing when asked.
  //
  // Steps:
  //   1. Restart the hosted swarm if it's stopped/failed.
  //   2. Wait for macro-agent to reconnect to the MAP hub.
  //   3. Call `_macro/resumeAgent` on macro-agent with the persisted
  //      provider_session_id. macro-agent resolves the agent, respawns the
  //      coordinator if dead, and returns `{peerMapId, acpSessionId}`.
  //   4. Open a fresh ACP stream against the returned peerMapId and call
  //      session/load with `_meta.provider_session_id` so Claude Code replays
  //      its on-disk transcript.
  //   5. Update the session resource metadata with the new streamId.
  fastify.post<{ Params: { id: string }; Body?: { cwd?: string } }>(
    '/sessions/:id/resume',
    { preHandler: authMiddleware },
    async (request, reply) => {
      const resource = resourcesDAL.findResourceById(request.params.id);
      if (!resource || resource.resource_type !== 'session') {
        return reply.status(404).send({ error: 'Session not found' });
      }
      if (!resourcesDAL.canAccessResource(request.agent!.id, resource)) {
        return reply.status(403).send({ error: 'Access denied' });
      }

      const meta = (resource.metadata ?? {}) as Record<string, unknown>;
      const sourceSwarmId = typeof meta.source_swarm_id === 'string' ? meta.source_swarm_id : undefined;
      const providerSessionId = typeof meta.provider_session_id === 'string' ? meta.provider_session_id : undefined;
      const priorAcpSessionId = typeof meta.sessionId === 'string' ? meta.sessionId : undefined;
      const projectPath = request.body?.cwd
        ?? (typeof meta.projectPath === 'string' ? meta.projectPath : undefined)
        ?? '.';

      if (!sourceSwarmId) {
        return reply.status(400).send({
          error: 'NOT_RESUMABLE',
          message: 'Session has no source_swarm_id — cannot be resumed',
        });
      }
      if (!providerSessionId) {
        return reply.status(400).send({
          error: 'NOT_RESUMABLE',
          message: 'Session has no provider_session_id — cannot be resumed durably',
        });
      }

      const sc = (fastify as any).swarmcraft;
      if (!sc?.mapClientManager || !sc?.acpStreamManager) {
        return reply.status(503).send({ error: 'SwarmCraft not available' });
      }

      // 1. Restart the hosted swarm if stopped/failed. Only applies when this
      //    instance owns the hosted process (not remote swarms).
      const hosted = findHostedSwarmBySwarmId(sourceSwarmId);
      if (hosted && (hosted.state === 'stopped' || hosted.state === 'failed')) {
        if (hosted.spawned_by !== request.agent!.id) {
          return reply.status(403).send({
            error: 'NOT_OWNER',
            message: 'Swarm is stopped and you did not spawn it',
          });
        }
        const swarmManager = (fastify as unknown as { swarmManager?: SwarmManager }).swarmManager;
        if (!swarmManager) {
          return reply.status(503).send({
            error: 'SWARM_MANAGER_UNAVAILABLE',
            message: 'Swarm hosting is not configured',
          });
        }
        try {
          await swarmManager.restart(hosted.id, request.agent!.id);
        } catch (err) {
          return reply.status(502).send({
            error: 'SWARM_START_FAILED',
            message: (err as Error).message,
          });
        }
      }

      // 2. Wait for macro-agent to reconnect inbound (and for SwarmCraft's
      //    MAP client to hold a live connection to the swarm's MAP server).
      //    The restart path above only handles local hosted swarms; remote
      //    swarms rely on their own operator to bring them back.
      const waitDeadline = Date.now() + 30_000;
      let mapClient: { callExtension: (m: string, p: unknown) => Promise<unknown> } | null = null;
      while (Date.now() < waitDeadline) {
        const client = sc.mapClientManager.getClient(sourceSwarmId);
        if (client?.isConnected) {
          mapClient = client;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!mapClient) {
        return reply.status(504).send({
          error: 'SWARM_NOT_CONNECTED',
          message: 'Swarm did not reconnect within timeout',
        });
      }

      // 3. Ask macro-agent to resume the agent owning this provider_session_id.
      //    macro-agent is idempotent: if the coordinator is already alive it
      //    returns the current handle; if dead it respawns.
      let resumeResult: {
        success?: boolean;
        error?: string;
        agent?: { id: string; localId: string; name?: string; role?: string };
        acpSessionId?: string;
        providerSessionId?: string;
      };
      try {
        resumeResult = (await mapClient.callExtension('_macro/resumeAgent', {
          providerSessionId,
          cwd: projectPath,
        })) as typeof resumeResult;
      } catch (err) {
        return reply.status(502).send({
          error: 'RESUME_FAILED',
          message: (err as Error).message,
        });
      }
      if (!resumeResult?.success || !resumeResult.agent?.id) {
        return reply.status(502).send({
          error: 'RESUME_FAILED',
          message: resumeResult?.error ?? 'macro-agent did not resume the agent',
        });
      }

      const peerMapId = resumeResult.agent.id;
      const peerAgentId = resumeResult.agent.localId;

      // 4. Wait briefly for the lifecycle bridge to re-register the agent on
      //    the hub. This mirrors /map/swarms/:id/agents — we don't strictly
      //    need the hub-assigned ID for ACP routing (peerMapId is enough),
      //    but polling for it confirms the bridge has caught up before we
      //    try to open a stream.
      const regDeadline = Date.now() + 2000;
      while (Date.now() < regDeadline) {
        const conn = getInbound(sourceSwarmId);
        if (conn) {
          let found = false;
          for (const [, entry] of conn.registeredAgents) {
            const peer = getPeerMapId(entry.metadata);
            if (peer === peerMapId || peer === peerAgentId) { found = true; break; }
          }
          if (found) break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      // 5. Open a fresh ACP stream and load the session. Pass
      //    _meta.provider_session_id so Claude Code replays history from
      //    its on-disk JSONL even if macro-agent started fresh.
      try {
        const stream = await sc.acpStreamManager.createStream(sourceSwarmId, peerMapId);
        await sc.acpStreamManager.initialize(stream.streamId);

        const targetAcpSessionId = resumeResult.acpSessionId ?? priorAcpSessionId;
        if (!targetAcpSessionId) {
          return reply.status(502).send({
            error: 'NO_SESSION_ID',
            message: 'Neither macro-agent nor resource metadata provided an ACP session id',
          });
        }

        await sc.acpStreamManager.loadSession(stream.streamId, {
          sessionId: targetAcpSessionId,
          cwd: projectPath,
          mcpServers: [],
          _meta: { provider_session_id: providerSessionId },
        });

        // 6. Persist the new stream + session ids on the resource so reloads
        //    reuse them (matches the metadata shape written by /sessions/acp-connect).
        const updatedMeta = {
          ...meta,
          sessionId: targetAcpSessionId,
          acpStreamId: stream.streamId,
          source_swarm_id: sourceSwarmId,
          provider_session_id: providerSessionId,
          projectPath,
        };
        resourcesDAL.updateResource(resource.id, { metadata: updatedMeta });

        broadcastToChannel('global', {
          type: 'trajectory:sync',
          data: { session_resource_id: resource.id },
        });

        return reply.send({
          session_resource_id: resource.id,
          acp_session_id: targetAcpSessionId,
          acp_stream_id: stream.streamId,
        });
      } catch (err) {
        return reply.status(502).send({
          error: 'LOAD_FAILED',
          message: (err as Error).message,
        });
      }
    },
  );
}
