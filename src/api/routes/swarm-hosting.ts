/**
 * Swarm Hosting API Routes
 *
 * REST API for spawning, managing, and monitoring SwarmRunner instances
 * hosted by this OpenHive instance.
 *
 * Routes:
 *   POST   /map/hosted/spawn         - Spawn a new hosted swarm
 *   GET    /map/hosted               - List hosted swarms
 *   GET    /map/hosted/:id           - Get hosted swarm details
 *   POST   /map/hosted/:id/stop      - Stop a hosted swarm
 *   POST   /map/hosted/:id/restart   - Restart a hosted swarm
 *   DELETE /map/hosted/:id           - Remove a stopped/failed hosted swarm
 *   GET    /map/hosted/:id/logs      - Get logs from a hosted swarm
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'node:path';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { SwarmHostingError } from '../../swarm/manager.js';
import * as dal from '../../swarm/dal.js';
import * as mapDal from '../../db/dal/map.js';
import { listRepos } from '../../db/dal/repos.js';
import type { SwarmManager } from '../../swarm/manager.js';
import type { Config } from '../../config.js';

// ============================================================================
// Zod Schemas
// ============================================================================

const WorkspaceRepoSchema = z.object({
  url: z.string().min(1).max(2000),
  branch: z.string().max(200).optional(),
  path: z.string().max(500).optional(),
  depth: z.number().int().positive().optional(),
});

const WorkspaceSchema = z.object({
  repos: z.array(WorkspaceRepoSchema).min(1).max(10),
});

const BootstrapSchema = z.object({
  coordinator: z.boolean().optional(),
  cwd: z.string().max(2000).optional(),
});

/**
 * Per-swarm workspace policy. Mirrors `WorkspacePolicy` in `src/swarm/types.ts`.
 *
 *   - `open` (default if omitted): any agent declare is accepted.
 *   - `allow_listed`: declares must canonicalize to one of `allowed_repos`.
 *     `allowed_repos` is required + non-empty when this mode is set.
 *   - `pinned`: declares must canonicalize to `pinned_repo`. Required when
 *     this mode is set. Auto-bind on swarm-register is not yet implemented;
 *     this gate currently behaves like a single-entry allow_list.
 */
// Exported so the PATCH endpoint in `map.ts` can reuse the same shape +
// `superRefine` rules. Both endpoints write to the same column; sharing
// the validator means a typo in one place doesn't drift the other.
export const WorkspacePolicySchema = z
  .object({
    mode: z.enum(['open', 'allow_listed', 'pinned']),
    allowed_repos: z.array(z.string().min(1).max(2000)).max(50).optional(),
    pinned_repo: z.string().min(1).max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === 'allow_listed') {
      if (!data.allowed_repos || data.allowed_repos.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['allowed_repos'],
          message: 'allowed_repos must be a non-empty array when mode="allow_listed"',
        });
      }
    }
    if (data.mode === 'pinned' && !data.pinned_repo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pinned_repo'],
        message: 'pinned_repo is required when mode="pinned"',
      });
    }
  });

// Exported so it can be unit-tested in isolation. Importing test code
// should treat this as the source of truth for the request shape — the
// route's HTTP plumbing (auth, manager lookup) is deliberately separate.
const HostedSwarmKindSchema = z.preprocess(
  (value) => (value === 'openswarm' ? 'swarm-runner' : value),
  z.enum(['swarm-runner', 'claude-code', 'codex']),
);

export const SpawnSwarmSchema = z
  .object({
    // Defaults to 'swarm-runner' to preserve the existing API contract for clients
    // that don't pass kind. See docs/HOSTED_SWARM_KINDS_DESIGN.md.
    kind: HostedSwarmKindSchema.optional().default('swarm-runner'),
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    adapter: z.string().max(100).optional(),
    adapter_config: z.record(z.unknown()).optional(),
    hive: z.string().max(100).optional(),
    provider: z.enum(['local', 'local-sandboxed', 'docker', 'fly', 'ssh', 'k8s']).optional(),
    metadata: z.record(z.unknown()).optional(),
    credential_overrides: z.record(z.string(), z.string()).optional(),
    workspace: WorkspaceSchema.optional(),
    bootstrap: BootstrapSchema.optional(),
    /**
     * Optional first-turn prompt. For claude-code, passed to `claude` as a
     * positional arg so the TUI opens with the prompt prefilled. Length cap
     * is generous — Claude Code itself accepts large prompts.
     */
    initial_prompt: z.string().max(8000).optional(),
    /**
     * Pre-attached repo resource. When set, the spawned swarm resolves
     * the repo and injects WORKSPACE_* env vars. For TUI kinds, the
     * provider also clones (if no local checkout exists) and sets the
     * TUI's cwd to the repo directory.
     */
    repo_id: z.string().max(200).optional(),
    /**
     * Per-swarm workspace policy. Persisted on `map_swarms.workspace_policy`
     * and consulted by `OpenHiveRepoHandler.onDeclare` to validate every
     * `x-workspace/repo.declare` from this swarm. See `WorkspacePolicy` in
     * `src/swarm/types.ts` for semantics. Omitted = `open`.
     */
    workspace_policy: WorkspacePolicySchema.optional(),
    /**
     * For kind=codex only: which surface to spawn.
     *   - 'rpc' (default): spawn `codex app-server`, openhive chat drives it
     *   - 'tui': spawn `codex` TUI in a PTY (operator-driven, no chat path)
     * Other kinds reject this field.
     */
    mode: z.enum(['rpc', 'tui']).optional(),
    /**
     * Free-form working directory the process is spawned in. Valid only
     * for `claude-code` and `codex` (both modes). SwarmRunner uses its own
     * `bootstrap.cwd` mechanism and rejects this field. Mutually exclusive
     * with `repo_id` and `workspace` — those have their own cwd resolution.
     * Path validation (absolute / exists / is dir) runs in the manager so
     * fs concerns stay out of the schema layer.
     */
    cwd: z.string().min(1).max(2000).optional(),
    // Layer 4 — optional openteams binding. SwarmManager.spawn() materializes
    // the loadout up front and forwards MCP scope + prompt addendum through
    // the BootstrapToken. team_bundle_id and role flow as advisory metadata.
    loadout_bundle_id: z.string().min(1).max(200).optional(),
    team_bundle_id: z.string().min(1).max(200).optional(),
    role: z.string().min(1).max(100).optional(),
  })

  .superRefine((data, ctx) => {
    // `mode` is codex-only — reject for any other kind so users get a
    // clear error rather than a silently-ignored field.
    if (data.mode !== undefined && data.kind !== 'codex') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mode'],
        message: `mode is only valid when kind="codex"; got kind="${data.kind ?? 'swarm-runner'}"`,
      });
    }

    // `cwd` validation: reject for swarm-runner (it uses bootstrap.cwd via env
    // var bridge — having a second spelling would just confuse operators),
    // and reject combinations that would otherwise fight over cwd resolution.
    // The manager validates the actual path exists; we only enforce shape +
    // exclusivity here.
    if (data.cwd !== undefined) {
      const kindForCwd = data.kind ?? 'swarm-runner';
      if (kindForCwd === 'swarm-runner') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cwd'],
          message: 'cwd is not valid for kind="swarm-runner"; use bootstrap.cwd instead',
        });
      }
      if (data.repo_id !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cwd'],
          message: 'cwd and repo_id are mutually exclusive; pick one source of truth for the working directory',
        });
      }
      if (data.workspace !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cwd'],
          message: 'cwd and workspace are mutually exclusive; workspace clones into data_dir which conflicts with a chosen cwd',
        });
      }
    }

    // Reject swarm-runner-specific fields for TUI-shaped kinds (claude-code,
    // codex). They route through PtyManager (no provider config, no
    // adapter, no bootstrap-coordinator) — these fields are dead. Keep
    // the schema permissive for swarm-runner. Workspace IS supported (clones
    // land under data_dir before the PTY spawn). The error message names
    // the kind so the operator sees which validation tripped.
    if (data.kind !== 'claude-code' && data.kind !== 'codex') return;
    const adapterMsg = data.kind === 'claude-code'
      ? 'cc-swarm plugin handles agent setup; no adapter to pick'
      : 'codex spawns its own TUI; no adapter to pick';
    const adapterConfigMsg = data.kind === 'claude-code'
      ? 'no adapter for claude-code'
      : 'no adapter for codex';
    const hiveMsg = 'hive-bound credentials are swarm-runner-specific';
    const bootstrapMsg = 'macro-agent bootstrap-coordinator is swarm-runner-specific';
    const credsMsg = `${data.kind} uses operator local creds; no overrides`;
    const blocked: Array<[keyof typeof data, string]> = [
      ['adapter', adapterMsg],
      ['adapter_config', adapterConfigMsg],
      ['hive', hiveMsg],
      ['bootstrap', bootstrapMsg],
      ['credential_overrides', credsMsg],
    ];
    for (const [field, reason] of blocked) {
      if (data[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `kind=${data.kind} does not support "${field}": ${reason}`,
        });
      }
    }
  });

// ============================================================================
// Error Handler
// ============================================================================

function handleSwarmError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof SwarmHostingError) {
    const statusMap: Record<string, number> = {
      MAX_SWARMS_REACHED: 429,
      PROVIDER_NOT_AVAILABLE: 400,
      NO_PORTS_AVAILABLE: 503,
      HIVE_NOT_FOUND: 404,
      ONBOARD_TOKEN_FAILED: 500,
      REPO_NOT_FOUND: 404,
      WORKSPACE_SETUP_FAILED: 500,
      SPAWN_FAILED: 500,
      NOT_FOUND: 404,
      NOT_OWNER: 403,
      RESTART_NOT_SUPPORTED: 400,
      RESTART_FAILED: 500,
      NOT_IMPLEMENTED: 501,
    };
    return reply.status(statusMap[error.code] || 500).send({
      error: error.code,
      message: error.message,
    });
  }
  if (error instanceof z.ZodError) {
    return reply.status(422).send({
      error: 'VALIDATION_ERROR',
      message: 'Invalid request body',
      details: error.errors,
    });
  }
  throw error;
}

// ============================================================================
// Route Registration
// ============================================================================

export async function swarmHostingRoutes(
  fastify: FastifyInstance,
  opts: { config: Config }
): Promise<void> {
  // Helper to get the SwarmManager from the fastify instance
  function getManager(request: FastifyRequest): SwarmManager {
    const manager = (request.server as unknown as { swarmManager?: SwarmManager }).swarmManager;
    if (!manager) {
      throw new SwarmHostingError(
        'PROVIDER_NOT_AVAILABLE',
        'Swarm hosting is not enabled. Set swarmHosting.enabled = true in config.'
      );
    }
    return manager;
  }

  // POST /map/hosted/spawn — Spawn a new hosted swarm
  fastify.post('/map/hosted/spawn', {
    preHandler: [authMiddleware],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const manager = getManager(request);
      const body = SpawnSwarmSchema.parse(request.body);
      const hosted = await manager.spawn(request.agent!.id, body);

      return reply.status(201).send({
        id: hosted.id,
        name: hosted.config?.name ?? hosted.id,
        swarm_id: hosted.swarm_id,
        provider: hosted.provider,
        state: hosted.state,
        endpoint: hosted.endpoint,
        assigned_port: hosted.assigned_port,
        created_at: hosted.created_at,
      });
    } catch (error) {
      return handleSwarmError(error, reply);
    }
  });

  // GET /map/hosted/spawn/preflight?kind=<kind>&mode=<rpc|tui> — Readiness
  // probe for a prospective spawn. Side-effect free; the spawn form calls
  // this on kind/mode selection to surface missing binaries, capacity, or
  // uninitialized runtimes BEFORE submit instead of as a post-submit toast.
  fastify.get<{
    Querystring: { kind?: string; mode?: string };
  }>(
    '/map/hosted/spawn/preflight',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const manager = getManager(request);
        const rawKind = request.query.kind ?? 'swarm-runner';
        if (rawKind !== 'swarm-runner' && rawKind !== 'claude-code' && rawKind !== 'codex') {
          return reply.status(422).send({
            error: 'VALIDATION_ERROR',
            message: `Unknown kind "${rawKind}". Expected swarm-runner | claude-code | codex.`,
          });
        }
        const rawMode = request.query.mode;
        if (rawMode !== undefined && rawMode !== 'rpc' && rawMode !== 'tui') {
          return reply.status(422).send({
            error: 'VALIDATION_ERROR',
            message: `Unknown mode "${rawMode}". Expected rpc | tui.`,
          });
        }
        return reply.send(manager.preflight(rawKind, rawMode));
      } catch (error) {
        return handleSwarmError(error, reply);
      }
    },
  );

  // GET /map/known-project-paths — Distinct directories worth suggesting
  // in the Spawn Swarm dialog's working-directory combobox. Sources:
  //   • hosted-swarm config.cwd (claude-code / codex) — listKnownTuiCwds
  //   • hosted-swarm bootstrap.cwd (swarm-runner)        — listKnownBootstrapCwds
  //   • registered swarms' metadata.projectPath       — listKnownProjectPaths
  //   • registered repo resources' local_path         — listRepos
  //
  // Returns BOTH the legacy flat `paths` array (back-compat for any
  // existing consumer) and a new `entries` array of `{ path, source,
  // label? }` so the frontend can group by source and show optional repo
  // names. Cheap lookup; no auth required beyond the standard middleware.
  fastify.get('/map/known-project-paths', {
    preHandler: [authMiddleware],
  }, async (_request, reply) => {
    const fromTui = dal.listKnownTuiCwds(50);
    const fromBootstrap = dal.listKnownBootstrapCwds(50);
    const fromSwarms = mapDal.listKnownProjectPaths(50);
    // listRepos returns the full table; we cap during the merge below.
    // Registered repo counts are small (tens, not thousands) in practical
    // openhive deployments — an unbounded read here is fine.
    const fromRepos = listRepos({})
      .map((r) => ({
        path: (r.local_path ?? '').trim(),
        // Surface the repo name as the entry's label so the combobox can
        // render "myrepo — /Users/.../myrepo" instead of bare paths.
        label: r.name || undefined,
      }))
      .filter((e) => e.path.length > 0);

    type Source = 'hosted-tui' | 'hosted-bootstrap' | 'registered-swarm' | 'repo';
    interface Entry { path: string; source: Source; label?: string }
    const ordered: Entry[] = [
      ...fromTui.map<Entry>((p) => ({ path: p, source: 'hosted-tui' })),
      ...fromBootstrap.map<Entry>((p) => ({ path: p, source: 'hosted-bootstrap' })),
      ...fromSwarms.map<Entry>((p) => ({ path: p, source: 'registered-swarm' })),
      ...fromRepos.map<Entry>((e) => ({ path: e.path, source: 'repo', label: e.label })),
    ];

    // Dedupe by path, first source wins (hosted-tui beats repo). Cap at
    // 50 — keeps the dropdown scannable.
    const seen = new Set<string>();
    const entries: Entry[] = [];
    const paths: string[] = [];
    for (const e of ordered) {
      if (seen.has(e.path)) continue;
      seen.add(e.path);
      entries.push(e);
      paths.push(e.path);
      if (entries.length >= 50) break;
    }
    return reply.send({ paths, entries });
  });

  // GET /map/hosted — List hosted swarms
  fastify.get<{
    Querystring: {
      state?: string;
      provider?: string;
      mine?: string;
      limit?: string;
      offset?: string;
    };
  }>('/map/hosted', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const { state, provider, mine, limit, offset } = request.query;

    const result = dal.listHostedSwarms({
      state: state as never,
      provider: provider as never,
      spawned_by: mine === 'true' ? request.agent!.id : undefined,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    // Strip sensitive fields from config; surface bootstrap + data_dir so
    // the frontend can show "swarm cwd" hints for spawn dialogs without a
    // second request. data_dir is the runtime fallback cwd for any spawn
    // call that doesn't specify one (chain ends here at macro-agent).
    const data = result.data.map((h) => ({
      id: h.id,
      name: h.config?.name ?? h.id,
      kind: h.kind,
      mode: h.config?.mode,
      swarm_id: h.swarm_id,
      provider: h.provider,
      state: h.state,
      pid: h.pid,
      assigned_port: h.assigned_port,
      endpoint: h.endpoint,
      error: h.error,
      spawned_by: h.spawned_by,
      created_at: h.created_at,
      updated_at: h.updated_at,
      bootstrap: h.config?.bootstrap,
      // data_dir is stored as-written by manager.ts (path.join, may be
      // relative). Absolutize for display so callers show a real path.
      data_dir: h.config?.data_dir ? path.resolve(h.config.data_dir) : undefined,
      // Operator-chosen working directory (TUI / codex `cwd` input). When
      // set, the spawned process opens here instead of data_dir — the
      // frontend prefers this for thread terminal hints so the displayed
      // path matches what's inside the TUI.
      cwd: h.config?.cwd ? path.resolve(h.config.cwd) : undefined,
      // Surface workspace repos so the frontend can show repo/branch hints
      // (e.g. on Threads terminal rows) without a per-swarm lookup.
      workspace: h.config?.workspace,
    }));

    return reply.send({ data, total: result.total });
  });

  // GET /map/hosted/:id — Get hosted swarm details
  fastify.get<{ Params: { id: string } }>('/map/hosted/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const hosted = dal.findHostedSwarmById(request.params.id);
    if (!hosted) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Hosted swarm not found' });
    }

    return reply.send({
      id: hosted.id,
      name: hosted.config?.name ?? hosted.id,
      kind: hosted.kind,
      mode: hosted.config?.mode,
      swarm_id: hosted.swarm_id,
      provider: hosted.provider,
      state: hosted.state,
      pid: hosted.pid,
      container_id: hosted.container_id,
      assigned_port: hosted.assigned_port,
      endpoint: hosted.endpoint,
      error: hosted.error,
      spawned_by: hosted.spawned_by,
      created_at: hosted.created_at,
      updated_at: hosted.updated_at,
      bootstrap: hosted.config?.bootstrap,
      data_dir: hosted.config?.data_dir,
      // Already absolute when persisted (validateSpawnCwd resolves) —
      // no need to re-resolve like data_dir.
      cwd: hosted.config?.cwd,
    });
  });

  // POST /map/hosted/:id/stop — Stop a hosted swarm
  fastify.post<{ Params: { id: string } }>('/map/hosted/:id/stop', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const manager = getManager(request);
      const hosted = await manager.stop(request.params.id, request.agent!.id);

      // SwarmCraft's outbound MAP client to this swarm's MAP server still holds
      // a now-dead WebSocket (the swarm-runner process just exited). Without
      // explicit disconnect, a subsequent spawn against this swarm (after
      // restart or a fresh spawn reusing the same swarm_id) would try to use
      // the stale client and fail with "Connection closed". Force disconnect
      // so the next connect opens a fresh client.
      if (hosted.swarm_id) {
        const sc = (fastify as any).swarmcraft;
        try {
          await sc?.mapClientManager?.disconnect?.(hosted.swarm_id);
        } catch { /* best-effort */ }
      }

      return reply.send({
        id: hosted.id,
        state: hosted.state,
        message: 'Swarm stopped successfully',
      });
    } catch (error) {
      return handleSwarmError(error, reply);
    }
  });

  // POST /map/hosted/:id/restart — Restart a hosted swarm
  fastify.post<{ Params: { id: string } }>('/map/hosted/:id/restart', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const manager = getManager(request);

      // Drop any stale MAP client BEFORE re-provisioning. restart() may be a
      // hot bounce (same process) or a cold-start (process recreated); in
      // either case, the old client's socket may be dead. Disconnect first,
      // then let swarmcraft's bridge auto-connect on the spawned event.
      const existing = dal.findHostedSwarmById(request.params.id);
      if (existing?.swarm_id) {
        const sc = (fastify as any).swarmcraft;
        try {
          await sc?.mapClientManager?.disconnect?.(existing.swarm_id);
        } catch { /* best-effort */ }
      }

      const hosted = await manager.restart(request.params.id, request.agent!.id);

      // Trigger swarmcraft to reconnect its outbound MAP client. Its bridge
      // only auto-connects on swarm_registered (first-time registration), not
      // on restart of an existing swarm — so without this, post-restart spawn
      // calls would 503 ("MAP client not connected"). Use the same URL shape
      // the bridge uses (port+2 + /map path).
      if (hosted.swarm_id && hosted.endpoint) {
        const sc = (fastify as any).swarmcraft;
        try {
          const basePort = parseInt(new URL(hosted.endpoint).port, 10);
          if (Number.isFinite(basePort) && sc?.mapClientManager?.connect) {
            await sc.mapClientManager.connect({
              id: hosted.swarm_id,
              name: hosted.config?.name ?? hosted.id,
              url: `ws://127.0.0.1:${basePort + 2}/map`,
              auth: { method: 'none' },
              skipSubscription: true,
            });
          }
        } catch { /* best-effort; next action will surface the error */ }
      }

      return reply.send({
        id: hosted.id,
        state: hosted.state,
        endpoint: hosted.endpoint,
        message: 'Swarm restarted successfully',
      });
    } catch (error) {
      return handleSwarmError(error, reply);
    }
  });

  // DELETE /map/hosted/:id — Remove a stopped/failed hosted swarm record
  fastify.delete<{ Params: { id: string } }>('/map/hosted/:id', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    const hosted = dal.findHostedSwarmById(request.params.id);
    if (!hosted) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Hosted swarm not found' });
    }
    if (hosted.spawned_by !== request.agent!.id) {
      return reply.status(403).send({ error: 'NOT_OWNER', message: 'You did not spawn this swarm' });
    }
    if (hosted.state !== 'stopped' && hosted.state !== 'failed') {
      return reply.status(409).send({
        error: 'INVALID_STATE',
        message: `Cannot remove a swarm in "${hosted.state}" state. Stop it first.`,
      });
    }

    dal.deleteHostedSwarm(hosted.id);
    return reply.status(204).send();
  });

  // POST /map/hosted/:id/chat/turn — Send a user turn to a programmatic-mode
  // hosted swarm. Provider-agnostic — manager dispatches based on the
  // row's kind+mode. Streaming output fans out as normalized
  // `hosted-chat.event` notifications on the WS channel
  // `hosted-chat:<hostedSwarmId>` — subscribe there before posting if you
  // want to capture the stream. Body: { text }.
  fastify.post<{ Params: { id: string }; Body: { text?: string } }>(
    '/map/hosted/:id/chat/turn',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const manager = getManager(request);
        const text = (request.body?.text ?? '').toString();
        if (!text.trim()) {
          return reply.status(422).send({ error: 'VALIDATION_ERROR', message: 'text is required' });
        }
        const ack = await manager.sendChatTurn(request.params.id, request.agent!.id, text);
        return reply.send(ack);
      } catch (error) {
        return handleSwarmError(error, reply);
      }
    },
  );

  // POST /map/hosted/:id/chat/permission/:requestId — Answer a pending
  // provider-issued approval prompt (e.g. codex execCommandApproval).
  // Body: { decision: 'approved' | 'denied' }. Returns 404 when no
  // pending prompt matches the id (idempotent — a sibling tab may have
  // answered first). The reply is forwarded to the provider's JSON-RPC
  // channel and a permission.resolved event is fanned out so sibling
  // tabs dismiss their dialogs.
  fastify.post<{
    Params: { id: string; requestId: string };
    Body: { decision?: 'approved' | 'denied' };
  }>(
    '/map/hosted/:id/chat/permission/:requestId',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const manager = getManager(request);
        const decision = request.body?.decision;
        if (decision !== 'approved' && decision !== 'denied') {
          return reply.status(422).send({
            error: 'VALIDATION_ERROR',
            message: 'decision must be "approved" or "denied"',
          });
        }
        // Owner check mirrors sendChatTurn — only the spawner can answer
        // a permission prompt for their hosted swarm.
        const hosted = dal.findHostedSwarmById(request.params.id);
        if (!hosted) {
          return reply.status(404).send({ error: 'NOT_FOUND', message: 'Hosted swarm not found' });
        }
        if (hosted.spawned_by !== request.agent!.id) {
          return reply.status(403).send({ error: 'NOT_OWNER', message: 'You did not spawn this swarm' });
        }
        manager.replyCodexPermission(request.params.id, request.params.requestId, decision);
        return reply.status(204).send();
      } catch (error) {
        return handleSwarmError(error, reply);
      }
    },
  );

  // POST /map/hosted/:id/chat/interrupt — Clean cancel of the active turn.
  // Body: { turn_id }. The session stays usable; only the in-flight turn
  // stops. Provider-agnostic — manager dispatches.
  fastify.post<{ Params: { id: string }; Body: { turn_id?: string } }>(
    '/map/hosted/:id/chat/interrupt',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      try {
        const manager = getManager(request);
        const turnId = (request.body?.turn_id ?? '').toString();
        if (!turnId.trim()) {
          return reply.status(422).send({ error: 'VALIDATION_ERROR', message: 'turn_id is required' });
        }
        await manager.interruptChatTurn(request.params.id, request.agent!.id, turnId);
        return reply.status(204).send();
      } catch (error) {
        return handleSwarmError(error, reply);
      }
    },
  );

  // GET /map/hosted/:id/logs — Get logs from a hosted swarm
  fastify.get<{
    Params: { id: string };
    Querystring: { lines?: string };
  }>('/map/hosted/:id/logs', {
    preHandler: [authMiddleware],
  }, async (request, reply) => {
    try {
      const manager = getManager(request);
      const lines = request.query.lines ? parseInt(request.query.lines, 10) : undefined;
      const logs = await manager.getLogs(request.params.id, request.agent!.id, { lines });

      return reply.type('text/plain').send(logs);
    } catch (error) {
      return handleSwarmError(error, reply);
    }
  });

  // GET /map/hosted/:id/terminal-info — Resolve the terminal session config
  // for a hosted swarm. Two modes:
  //   ?mode=tui   (default) — SwarmRunner TUI tunneled into the browser PTY
  //                          (or, for kind=claude-code, attach to the
  //                          existing claude PTY session by sessionId)
  //   ?mode=shell           — User's $SHELL in the swarm's data dir, sandboxed
  fastify.get<{ Params: { id: string }; Querystring: { mode?: string } }>(
    '/map/hosted/:id/terminal-info',
    { preHandler: [authMiddleware] },
    async (request, reply) => {
      const hosted = dal.findHostedSwarmById(request.params.id);
      if (!hosted) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: 'Hosted swarm not found' });
      }
      if (hosted.state !== 'running') {
        return reply.status(409).send({ error: 'NOT_RUNNING', message: 'Swarm is not running' });
      }

      const mode = request.query.mode === 'shell' ? 'shell' : 'tui';

      // claude-code TUI: don't spawn a fresh PTY — attach to the
      // existing one SwarmManager already started for this row. Falls
      // through to shell mode below for ?mode=shell (the swarm's data
      // dir + sandboxed $SHELL works for any kind).
      if (mode === 'tui' && (hosted.kind === 'claude-code' || hosted.kind === 'codex')) {
        let sessionId: string | null = null;
        try {
          const manager = getManager(request);
          sessionId = manager.getTuiPtySessionId(request.params.id);
        } catch {
          // Manager not available — surface as unavailable, not 5xx
        }
        console.log('[terminal-info] swarm=%s mode=tui kind=claude-code session=%s', request.params.id, sessionId ?? 'NONE');
        return reply.send({
          mode: 'tui',
          binding: 'attach',
          available: !!sessionId,
          sessionId,
          // No command/args — caller attaches by sessionId.
          command: null,
          args: [],
          sandbox: false,
          // Endpoint isn't meaningful for claude-code (no MAP server on
          // the swarm); leave the field for shape compatibility.
          endpoint: null,
        });
      }

      // Point the TUI at openhive's own MAP hub, not the hosted swarm's
      // assigned port. The swarm-runner `serve` gateway exposes /health, /metrics,
      // /api/stats — it has no MAP WebSocket bound to assigned_port. MAP traffic
      // for hosted swarms flows inbound to this hub via the sidecar pattern, so
      // the TUI must dial the hub to see anything useful.
      //
      // Use 127.0.0.1 because the PTY runs on this host. `config.host` is the
      // bind address ("0.0.0.0" by default) and isn't a usable connect target.
      const hubMapEndpoint = `ws://127.0.0.1:${opts.config.port}/ws/map`;

      // Shell mode: drop the user into their $SHELL inside the swarm's data
      // dir. Sandboxed by default — the PTY ends up with full host access
      // otherwise. data_dir is stored as written by manager.ts (path.join, no
      // resolve) so it can be relative; absolute-ize here so the sandbox
      // allow_write list and the PTY cwd match the directory on disk.
      if (mode === 'shell') {
        const shell = process.env.SHELL || '/bin/bash';
        const rawDataDir = hosted.config?.data_dir;
        if (!rawDataDir) {
          return reply.status(409).send({
            error: 'NO_CWD',
            message: 'Hosted swarm has no resolved data_dir for shell mode.',
          });
        }
        const cwd = path.resolve(rawDataDir);
        console.log('[terminal-info] swarm=%s mode=shell shell=%s cwd=%s', request.params.id, shell, cwd);
        return reply.send({
          mode: 'shell',
          available: true,
          command: shell,
          args: [],
          cwd,
          sandbox: true,
          endpoint: hubMapEndpoint,
        });
      }

      // TUI mode (default).
      try {
        const { resolveSwarmRunnerTuiBinary } = await import('../../terminal/resolve-tui.js');
        const binaryPath = resolveSwarmRunnerTuiBinary();

        console.log(
          '[terminal-info] swarm=%s mode=tui hub=%s binary=%s',
          request.params.id,
          hubMapEndpoint,
          binaryPath ?? 'NOT_FOUND',
        );

        return reply.send({
          mode: 'tui',
          available: !!binaryPath,
          command: binaryPath,
          args: binaryPath ? ['--url', hubMapEndpoint, '--auto-connect'] : [],
          sandbox: false,
          endpoint: hubMapEndpoint,
        });
      } catch (err) {
        console.warn('[terminal-info] resolve failed for swarm=%s:', request.params.id, err);
        return reply.send({
          mode: 'tui',
          available: false,
          command: null,
          args: [],
          sandbox: false,
          endpoint: hubMapEndpoint,
        });
      }
    },
  );
}
