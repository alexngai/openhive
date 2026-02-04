// ============================================================================
// Session-Specific API Routes
// Extended functionality for agent session sync
// ============================================================================

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { authMiddleware } from '../middleware/auth.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { getDatabase } from '../../db/index.js';
import { broadcastToChannel } from '../../realtime/index.js';
import {
  detectFormatExtended,
  getSupportedFormats,
  quickExtractStats,
  toAcpEvents,
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
// Routes
// ============================================================================

export async function sessionsRoutes(
  fastify: FastifyInstance,
  _options: { config: Config }
): Promise<void> {

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

      const { name, description, visibility, format_id, tags, storage_backend } =
        parseResult.data;

      // Get content from body
      const content = (request.body as { content?: string }).content;
      if (!content) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Session content is required',
        });
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

      // Build session metadata
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
        const sessionIdMatch = resource.git_remote_url.match(/ses_[a-zA-Z0-9]+/);
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
  fastify.get<{ Params: { id: string }; Querystring: { limit?: number; offset?: number } }>(
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

      if (!storageBackend || storageBackend === 'git') {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Event parsing is only available for locally stored sessions',
        });
      }

      if (!isSessionStorageInitialized()) {
        return reply.status(503).send({
          error: 'Service Unavailable',
          message: 'Session storage is not configured',
        });
      }

      const storage = getSessionStorage();
      const sessionIdMatch = resource.git_remote_url.match(/ses_[a-zA-Z0-9]+/);
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

      // Convert to ACP events
      const formatId = metadata?.format?.id || 'raw';
      const { events } = toAcpEvents(content as string, formatId);

      // Apply pagination
      const limit = Math.min(request.query.limit || 100, 500);
      const offset = request.query.offset || 0;
      const paginatedEvents = events.slice(offset, offset + limit);

      return reply.send({
        format_id: formatId,
        total: events.length,
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
      const checkpoints = db
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

      return reply.send({ checkpoints });
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
}
