import { FastifyInstance } from 'fastify';
import { authMiddleware, createAdminAuth, createAuthOrAdminKey } from '../middleware/auth.js';
import { KNOWN_CAPABILITIES, isKnownCapability } from '../middleware/capabilities.js';
import { revokeToken, isTokenServiceInitialized } from '../../map/token-service.js';
import { delegateForSpawn, ScopeNotGrantedError } from '../../map/delegate-for-spawn.js';
import { z } from 'zod';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as invitesDAL from '../../db/dal/invites.js';
import * as ingestKeysDAL from '../../db/dal/ingest-keys.js';
import type { Config } from '../../config.js';
import type { InstanceInfo } from '../../types.js';
import {
  CONFIG_SECTIONS,
  SECRET_PATHS,
  READONLY_PATHS,
  READONLY_SECTIONS,
  RESTART_REQUIRED_PATHS,
  SECRET_SENTINEL,
  matchesPath,
  buildMetaResponse,
} from '../../config-meta.js';
import { readConfigFile, writeConfigFile, deepMerge } from '../../config-persistence.js';
import { getLoadedConfigPath, isConfigEditable, setLoadedConfigPath } from '../../config.js';
import { resolveDataDir, dataDirPaths } from '../../data-dir.js';
import { getOpenteamsBundleFailures } from '../../openteams/sync-bridge.js';
import { listMcpRefs } from '../../openteams/mcp-registry.js';
import {
  isAutonomousDispatchPaused,
  setAutonomousDispatchPaused,
} from '../../map/dispatch-policy.js';

export async function adminRoutes(fastify: FastifyInstance, options: { config: Config }): Promise<void> {
  const adminAuth = createAdminAuth(options.config);

  // Get instance info
  fastify.get('/admin/instance', async (_request, reply) => {
    const info: InstanceInfo = {
      name: options.config.instance.name,
      description: options.config.instance.description || '',
      url: options.config.instance.url || '',
      version: '0.1.0',
      agent_count: agentsDAL.countAgents(),
      hive_count: hivesDAL.countHives(),
      federation_enabled: options.config.federation.enabled,
      swarm_hosting_enabled: options.config.swarmHosting.enabled,
      swarmcraft_enabled: options.config.swarmcraft.enabled,
      registration_open: true,
      auth_mode: options.config.auth.mode,
    };

    return reply.send(info);
  });

  // List all agents (admin)
  fastify.get<{ Querystring: { limit?: number; offset?: number; verified_only?: boolean } }>(
    '/admin/agents',
    { preHandler: adminAuth },
    async (request, reply) => {
      const limit = Math.min(request.query.limit || 50, 100);
      const offset = request.query.offset || 0;

      const agents = agentsDAL.listAgents({
        limit,
        offset,
        verified_only: request.query.verified_only,
      });

      const total = agentsDAL.countAgents();

      return reply.send({
        data: agents.map((a) => ({
          ...agentsDAL.toPublicAgent(a),
          is_admin: a.is_admin,
          verification_status: a.verification_status,
          last_seen_at: a.last_seen_at,
        })),
        total,
        limit,
        offset,
      });
    }
  );

  // Verify an agent (admin)
  fastify.post<{ Params: { id: string } }>(
    '/admin/agents/:id/verify',
    { preHandler: adminAuth },
    async (request, reply) => {
      const agent = agentsDAL.findAgentById(request.params.id);

      if (!agent) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent not found',
        });
      }

      agentsDAL.updateAgent(agent.id, {
        is_verified: true,
        verification_status: 'verified',
      });

      return reply.send({ success: true });
    }
  );

  // Reject an agent verification (admin)
  fastify.post<{ Params: { id: string } }>(
    '/admin/agents/:id/reject',
    { preHandler: adminAuth },
    async (request, reply) => {
      const agent = agentsDAL.findAgentById(request.params.id);

      if (!agent) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent not found',
        });
      }

      agentsDAL.updateAgent(agent.id, {
        is_verified: false,
        verification_status: 'rejected',
      });

      return reply.send({ success: true });
    }
  );

  // Make/remove admin (admin)
  fastify.post<{ Params: { id: string }; Body: { is_admin: boolean } }>(
    '/admin/agents/:id/admin',
    { preHandler: adminAuth },
    async (request, reply) => {
      const agent = agentsDAL.findAgentById(request.params.id);

      if (!agent) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent not found',
        });
      }

      const { is_admin } = request.body as { is_admin: boolean };
      agentsDAL.updateAgent(agent.id, { is_admin });

      // Note: v4 resolves session scopes at map/connect time. A demoted
      // admin's MAP session retains the scopes it was issued with until
      // the agent reconnects. If immediate invalidation matters for a
      // specific deployment, the operator can call revokeToken on the
      // agent's id to force disconnect — or wait for natural reconnect
      // (MAP SDK reconnects with exponential backoff on WS close).

      return reply.send({ success: true });
    }
  );

  // Delete an agent (admin)
  fastify.delete<{ Params: { id: string } }>(
    '/admin/agents/:id',
    { preHandler: adminAuth },
    async (request, reply) => {
      const deleted = agentsDAL.deleteAgent(request.params.id);

      if (!deleted) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Agent not found',
        });
      }

      // Invalidate any live agent-iam tokens the agent held. Tokens are
      // self-contained (signature + expiry survive the DB row's deletion)
      // so without this revocation, a deleted-but-compromised agent could
      // keep acting until the token expires.
      if (isTokenServiceInitialized()) {
        revokeToken(request.params.id, 'agent-deleted');
      }

      return reply.status(204).send();
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // Agent Capabilities (V42 — operator-gated narrow grants)
  // See docs/RFC_AGENT_CAPABILITIES.md.
  // ═══════════════════════════════════════════════════════════════

  // List an agent's current grants
  fastify.get<{ Params: { id: string } }>(
    '/admin/agents/:id/capabilities',
    { preHandler: adminAuth },
    async (request, reply) => {
      const agent = agentsDAL.findAgentById(request.params.id);
      if (!agent) {
        return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
      }
      return reply.send({
        agent_id: agent.id,
        capabilities: agentsDAL.getAgentCapabilities(agent.id),
        known_capabilities: Array.from(KNOWN_CAPABILITIES),
      });
    },
  );

  // Grant a capability
  fastify.post<{ Params: { id: string }; Body: { capability?: string } }>(
    '/admin/agents/:id/capabilities',
    { preHandler: adminAuth },
    async (request, reply) => {
      const agent = agentsDAL.findAgentById(request.params.id);
      if (!agent) {
        return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
      }
      const capability = request.body?.capability;
      if (!capability) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: '`capability` is required',
        });
      }
      if (!isKnownCapability(capability)) {
        return reply.status(400).send({
          error: 'Unknown Capability',
          message: `Unknown capability: ${capability}. Supported: ${Array.from(KNOWN_CAPABILITIES).join(', ')}`,
        });
      }
      const capabilities = agentsDAL.grantAgentCapability(agent.id, capability);
      return reply.send({ agent_id: agent.id, capabilities });
    },
  );

  // Revoke a capability
  fastify.delete<{ Params: { id: string; capability: string } }>(
    '/admin/agents/:id/capabilities/:capability',
    { preHandler: adminAuth },
    async (request, reply) => {
      const agent = agentsDAL.findAgentById(request.params.id);
      if (!agent) {
        return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
      }
      const capabilities = agentsDAL.revokeAgentCapability(agent.id, request.params.capability);
      return reply.send({ agent_id: agent.id, capabilities });
    },
  );

  // Create invite code (admin)
  fastify.post<{ Body: { uses?: number; expires_in_days?: number } }>(
    '/admin/invites',
    { preHandler: adminAuth },
    async (request, reply) => {
      const { uses, expires_in_days } = (request.body || {}) as { uses?: number; expires_in_days?: number };

      let expires_at: string | undefined;
      if (expires_in_days) {
        const date = new Date();
        date.setDate(date.getDate() + expires_in_days);
        expires_at = date.toISOString();
      }

      const invite = invitesDAL.createInviteCode({
        uses_left: uses || 1,
        expires_at,
      });

      return reply.status(201).send(invite);
    }
  );

  // List invite codes (admin)
  fastify.get<{ Querystring: { active_only?: boolean; limit?: number; offset?: number } }>(
    '/admin/invites',
    { preHandler: adminAuth },
    async (request, reply) => {
      const invites = invitesDAL.listInviteCodes({
        active_only: request.query.active_only,
        limit: request.query.limit || 50,
        offset: request.query.offset || 0,
      });

      return reply.send({ data: invites });
    }
  );

  // Delete invite code (admin)
  fastify.delete<{ Params: { id: string } }>(
    '/admin/invites/:id',
    { preHandler: adminAuth },
    async (request, reply) => {
      const deleted = invitesDAL.deleteInviteCode(request.params.id);

      if (!deleted) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Invite code not found',
        });
      }

      return reply.status(204).send();
    }
  );

  // ═══════════════════════════════════════════════════════════════
  // Onboarding tokens — operator bootstrap path
  // ═══════════════════════════════════════════════════════════════
  // Operators mint agent-iam tokens directly (without a live MAP session)
  // for bootstrap scripts: `openhive admin onboard-token create`. Admin
  // auth is the "parent authority" — the resulting token can carry any
  // scope the operator chooses, bounded only by reasonable TTL limits.
  //
  // Agent-to-agent onboarding uses `map/agents/spawn` over MAP WS
  // instead; this endpoint is only for the no-coordinator-in-the-loop
  // case. See docs/RFC_AGENT_CAPABILITIES.md v4 §"Onboarding flow
  // (operator-bootstrap)".

  const OnboardTokenSchema = z.object({
    // Default to the narrow `map:agents:spawn` — the common case is a
    // coordinator that itself mints children. Operators wanting broader
    // authority (e.g. full admin for a trusted swarm) pass `['map:*']`
    // explicitly. Per M3 of the v4 review, never default to wildcards.
    scopes: z.array(z.string()).min(1).default(['map:agents:spawn']),
    ttl_hours: z.number().int().min(1).max(24 * 30).default(24),
    agent_name: z.string().min(1).max(200).optional(),
    agent_id: z.string().min(1).optional(),
  });

  fastify.post('/admin/onboard-token', { preHandler: adminAuth }, async (request, reply) => {
    if (!isTokenServiceInitialized()) {
      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'Token service is not initialized',
      });
    }

    const parseResult = OnboardTokenSchema.safeParse(request.body ?? {});
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: parseResult.error.errors,
      });
    }
    const { scopes, ttl_hours, agent_name, agent_id } = parseResult.data;

    // Resolve the child agent — either create a new one or reuse an
    // existing id if the caller wants to re-issue for an existing agent.
    let childAgentId: string;
    if (agent_id) {
      const existing = agentsDAL.findAgentById(agent_id);
      if (!existing) {
        return reply.status(404).send({
          error: 'Not Found',
          message: `Agent ${agent_id} does not exist`,
        });
      }
      childAgentId = existing.id;
    } else {
      const name = agent_name ?? `onboarded-${Date.now()}`;
      const { agent } = await agentsDAL.createAgent({
        name,
        description: 'Onboarded via admin onboard-token',
        metadata: { onboarded_via: 'admin-token', onboarded_at: new Date().toISOString() },
      });
      childAgentId = agent.id;
    }

    // Admin is the "parent" with implicit map:* scope. Delegation still
    // runs scope-subset check (requestedScopes ⊆ ['map:*']) so typos in
    // the scope list surface as 403. No parent token is supplied — the
    // `delegateForSpawn` root-token path applies, capped at 30 days.
    try {
      const credentials = delegateForSpawn({
        parentAgentId: 'admin-key',
        parentScopes: ['map:*'],
        childAgentId,
        requestedScopes: scopes,
        ttlMinutes: ttl_hours * 60,
        childDelegatable: true,
      });

      // Report the *effective* TTL so operators can see when clamping
      // occurred (e.g. if they asked for 8760h=1yr, we return 720h).
      return reply.send({
        agent_id: childAgentId,
        token: credentials.credentials.token,
        method: credentials.method,
        env: credentials.env,
        scopes,
        ttl_hours: credentials.ttlMinutes / 60,
        expires_at: credentials.expiresAt,
      });
    } catch (err) {
      if (err instanceof ScopeNotGrantedError) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: err.message,
        });
      }
      throw err;
    }
  });

  // Get stats
  fastify.get('/admin/stats', { preHandler: adminAuth }, async (_request, reply) => {
    return reply.send({
      agents: {
        total: agentsDAL.countAgents(),
        verified: agentsDAL.listAgents({ verified_only: true }).length,
      },
      hives: {
        total: hivesDAL.countHives(),
      },
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Ingest API Keys
  // ═══════════════════════════════════════════════════════════════

  // Create ingest key
  fastify.post<{
    Body: { label: string; agent_id?: string; agent_name?: string; expires_in_hours?: number };
  }>(
    '/admin/ingest-keys',
    { preHandler: adminAuth },
    async (request, reply) => {
      const { label, agent_id, agent_name, scopes, expires_in_hours } = request.body as {
        label: string;
        agent_id?: string;
        agent_name?: string;
        scopes?: string[];
        expires_in_hours?: number;
      };

      if (!label) {
        return reply.status(400).send({ error: 'Validation Error', message: 'label is required' });
      }

      let targetAgentId = agent_id;

      if (!targetAgentId) {
        // Auto-create a synthetic agent for this key
        const name = agent_name || `ingest-${label}`;
        const existing = agentsDAL.findAgentByName(name);
        if (existing) {
          targetAgentId = existing.id;
        } else {
          const { agent } = await agentsDAL.createAgent({
            name,
            description: `Auto-created agent for ingest key: ${label}`,
          });
          targetAgentId = agent.id;
        }
      } else {
        const existing = agentsDAL.findAgentById(targetAgentId);
        if (!existing) {
          return reply.status(404).send({ error: 'Not Found', message: 'Agent not found' });
        }
      }

      // Validate scopes
      const validScopes = ['map', 'sessions', 'resources', 'admin', '*'];
      const keyScopes = scopes?.length ? scopes : ['map'];
      for (const s of keyScopes) {
        if (!validScopes.includes(s)) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: `Invalid scope '${s}'. Valid scopes: ${validScopes.join(', ')}`,
          });
        }
      }

      const result = ingestKeysDAL.createIngestKey(request.agent?.id ?? targetAgentId, {
        label,
        agent_id: targetAgentId,
        scopes: keyScopes as ingestKeysDAL.CreateIngestKeyInput['scopes'],
        expires_in_hours,
      });

      return reply.status(201).send({
        id: result.key.id,
        key: result.plaintext_key,
        label: result.key.label,
        scopes: result.key.scopes,
        agent_id: result.key.agent_id,
        expires_at: result.key.expires_at,
        created_at: result.key.created_at,
      });
    },
  );

  // List ingest keys
  fastify.get<{
    Querystring: { agent_id?: string; include_revoked?: boolean; limit?: number; offset?: number };
  }>(
    '/admin/ingest-keys',
    { preHandler: adminAuth },
    async (request, reply) => {
      const keys = ingestKeysDAL.listIngestKeys({
        agent_id: request.query.agent_id,
        include_revoked: request.query.include_revoked,
        limit: Math.min(request.query.limit || 50, 100),
        offset: request.query.offset || 0,
      });

      const data = keys.map((k) => ({
        id: k.id,
        label: k.label,
        key: k.key_value,
        scopes: k.scopes,
        agent_id: k.agent_id,
        revoked: k.revoked,
        expires_at: k.expires_at,
        created_by: k.created_by,
        created_at: k.created_at,
        last_used_at: k.last_used_at,
      }));

      return reply.send({ data });
    },
  );

  // Revoke ingest key (soft delete)
  fastify.post<{ Params: { id: string } }>(
    '/admin/ingest-keys/:id/revoke',
    { preHandler: adminAuth },
    async (request, reply) => {
      const revoked = ingestKeysDAL.revokeIngestKey(request.params.id);
      if (!revoked) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: 'Ingest key not found or already revoked' });
      }
      return reply.send({ success: true });
    },
  );

  // Delete ingest key (hard delete)
  fastify.delete<{ Params: { id: string } }>(
    '/admin/ingest-keys/:id',
    { preHandler: adminAuth },
    async (request, reply) => {
      const deleted = ingestKeysDAL.deleteIngestKey(request.params.id);
      if (!deleted) {
        return reply.status(404).send({ error: 'Not Found', message: 'Ingest key not found' });
      }
      return reply.status(204).send();
    },
  );

  // ============================================================================
  // Server Configuration
  // ============================================================================

  /** Redact secret fields from a config object (returns a deep copy) */
  function redactSecrets(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (matchesPath(path, SECRET_PATHS)) {
        // Show sentinel if a value exists, omit if undefined/null
        if (value !== undefined && value !== null && value !== '') {
          result[key] = SECRET_SENTINEL;
        }
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = redactSecrets(value as Record<string, unknown>, path);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /** Strip secret sentinel values from incoming PATCH body */
  function stripSentinels(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value === SECRET_SENTINEL) {
        // Skip — don't overwrite existing secret with sentinel
        continue;
      }
      if (matchesPath(path, READONLY_PATHS)) {
        // Skip read-only fields
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const stripped = stripSentinels(value as Record<string, unknown>, path);
        if (Object.keys(stripped).length > 0) {
          result[key] = stripped;
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  /** Check if any changed path requires a restart */
  function hasRestartRequired(obj: Record<string, unknown>, prefix = ''): boolean {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (matchesPath(path, RESTART_REQUIRED_PATHS)) return true;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (hasRestartRequired(value as Record<string, unknown>, path)) return true;
      }
    }
    return false;
  }

  /** Build the full config response (all sections, secrets redacted) */
  function buildConfigResponse() {
    const sectionKeys = CONFIG_SECTIONS.map(s => s.key);
    const response: Record<string, unknown> = {};

    for (const key of sectionKeys) {
      const val = (options.config as Record<string, unknown>)[key];
      if (val !== undefined) {
        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
          response[key] = redactSecrets(val as Record<string, unknown>, key);
        } else {
          response[key] = val;
        }
      }
    }

    // Include auth (not in CONFIG_SECTIONS but useful for display)
    response.auth = { mode: options.config.auth.mode };

    response._meta = buildMetaResponse();
    response._editable = isConfigEditable();
    response._configFormat = getLoadedConfigPath()?.endsWith('.js') ? 'js' : 'json';
    return response;
  }

  // GET /admin/config — any authenticated user can read (secrets redacted, PATCH is admin-only)
  const authOrAdminKey = createAuthOrAdminKey(options.config);

  fastify.get('/admin/config', { preHandler: authOrAdminKey }, async (_request, reply) => {
    return reply.send(buildConfigResponse());
  });

  // PATCH /admin/config — admin-only update of runtime configuration
  fastify.patch(
    '/admin/config',
    { preHandler: adminAuth },
    async (request, reply) => {
      const body = (request.body || {}) as Record<string, unknown>;

      // Filter out _meta, read-only sections, sentinels, and read-only fields
      const updates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (key === '_meta') continue;
        if (READONLY_SECTIONS.has(key)) continue;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const stripped = stripSentinels(value as Record<string, unknown>, key);
          if (Object.keys(stripped).length > 0) {
            updates[key] = stripped;
          }
        } else {
          updates[key] = value;
        }
      }

      if (Object.keys(updates).length === 0) {
        return reply.send({ ...buildConfigResponse(), restartRequired: false });
      }

      // Check if any changes require restart
      const restartRequired = hasRestartRequired(updates);

      // Apply to runtime config (deep merge into the reference object)
      for (const [key, value] of Object.entries(updates)) {
        const existing = (options.config as Record<string, unknown>)[key];
        if (existing && typeof existing === 'object' && !Array.isArray(existing) &&
            value && typeof value === 'object' && !Array.isArray(value)) {
          // Deep merge into existing object to preserve un-patched fields
          Object.assign(existing, deepMerge(
            existing as Record<string, unknown>,
            value as Record<string, unknown>,
          ));
        } else {
          (options.config as Record<string, unknown>)[key] = value;
        }
      }

      // Persist to config file (JSON only — JS configs are read-only)
      let configPath = getLoadedConfigPath();

      if (!configPath) {
        // No config file was loaded (running on defaults) — auto-create one
        const paths = dataDirPaths(resolveDataDir());
        configPath = paths.config; // <dataDir>/config.json
        setLoadedConfigPath(configPath);
      }

      if (isConfigEditable()) {
        try {
          const currentFile = readConfigFile(configPath);
          const merged = deepMerge(currentFile, updates);
          writeConfigFile(configPath, merged);
        } catch (err) {
          fastify.log.error({ err }, 'Failed to persist config to file');
          // Runtime config was already updated — don't fail the request
        }
      }

      return reply.send({ ...buildConfigResponse(), restartRequired });
    },
  );

  // GET /admin/git-sync-status — overview of all git-backed resources and their pull status
  fastify.get('/admin/git-sync-status', { preHandler: authMiddleware }, async (_request, reply) => {
    const { getDatabase } = await import('../../db/index.js');
    const { getGitSyncStatus } = await import('../../sync/git-content.js');

    const db = getDatabase();
    const rows = db.prepare(
      `SELECT * FROM syncable_resources WHERE local_path IS NOT NULL AND local_path != ''`,
    ).all() as Record<string, unknown>[];

    const results: Array<{
      id: string;
      name: string;
      resource_type: string;
      local_path: string | null;
      autoPull: boolean;
      sync_status: {
        hasUncommittedChanges: boolean;
        unpushedCommits: number;
        unpulledCommits: number;
        localHead: string | null;
        remoteHead: string | null;
      } | null;
      error?: string;
    }> = [];

    for (const row of rows) {
      const localPath = row.local_path as string;
      let meta: Record<string, unknown> | null = null;
      try {
        meta = row.metadata ? JSON.parse(row.metadata as string) : null;
      } catch { /* ignore */ }

      // Check if autoPull is enabled
      let autoPull = false;
      if (meta) {
        const otConfig = meta.opentasks_config as Record<string, unknown> | undefined;
        const syncGit = (otConfig?.sync as Record<string, unknown> | undefined)?.git as Record<string, unknown> | undefined;
        const genericGit = (meta.sync as Record<string, unknown> | undefined)?.git as Record<string, unknown> | undefined;
        autoPull = !!(syncGit?.autoPull || genericGit?.autoPull || meta.autoPull);
      }

      let syncStatus = null;
      let error: string | undefined;
      try {
        syncStatus = await getGitSyncStatus(localPath);
      } catch (err) {
        error = (err as Error).message;
      }

      results.push({
        id: row.id as string,
        name: row.name as string,
        resource_type: row.resource_type as string,
        local_path: localPath,
        autoPull,
        sync_status: syncStatus,
        error,
      });
    }

    return reply.send({ resources: results });
  });

  /**
   * Dispatch kill switch (Stream 2 D9 — autonomous-dispatch retrofit path).
   *
   * Hub-wide toggle. When `paused` is true, agent-initiated dispatches via
   * the MAP `map/specs/dispatch` method return -32004; user-initiated REST
   * dispatches keep working. Restarts default the toggle back to `false`.
   */
  fastify.get(
    '/admin/dispatch-policy',
    { preHandler: adminAuth },
    async (_request, reply) => {
      return reply.send({ autonomous_dispatch_paused: isAutonomousDispatchPaused() });
    },
  );

  fastify.post<{ Body: { paused: boolean } }>(
    '/admin/dispatch-policy',
    { preHandler: adminAuth },
    async (request, reply) => {
      const paused = request.body?.paused;
      if (typeof paused !== 'boolean') {
        return reply
          .status(422)
          .send({ error: 'VALIDATION_ERROR', message: 'paused must be a boolean' });
      }
      setAutonomousDispatchPaused(paused);
      return reply.send({ autonomous_dispatch_paused: isAutonomousDispatchPaused() });
    },
  );

  /**
   * OpenTeams bundle store health.
   *
   * Surfaces:
   *   - `bundle_failures`: recent auto-bundle failures (POST/PATCH/DELETE on
   *     /teams or /loadouts that couldn't be reflected into the bundle
   *     store). Capped at a 200-entry ring buffer.
   *   - `mcp_registry`: current symbolic-ref → install-spec mappings, so
   *     operators can audit what `{ ref: '@org/x' }` entries will resolve.
   */
  fastify.get(
    '/admin/openteams/health',
    { preHandler: adminAuth },
    async (_request, reply) => {
      return reply.send({
        bundle_failures: getOpenteamsBundleFailures(),
        mcp_registry: listMcpRefs(),
      });
    },
  );
}
