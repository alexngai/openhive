/**
 * Builder for the `.swarm/claude-swarm/config.json` prelaunch file consumed
 * by claude-code-swarm's `SessionStart` hook.
 *
 * Contract — what cc-swarm actually reads:
 *   - `map.server`     : MAP WebSocket URL the sidecar dials (required for
 *                        observability; setting this implicitly enables MAP)
 *   - `map.scope`      : MAP scope name; we use the hosted-swarm id so the
 *                        sidecar's scope messages are namespaced per swarm
 *   - `map.systemId`   : Stable swarm identity passed to MAP. We use the
 *                        pre-registered MAP swarm id so cc-swarm registers
 *                        under the same id we already pre-registered.
 *   - `map.auth.token` : The verified-mode access token. cc-swarm appends
 *                        this as `?token=...` to the WS URL (see
 *                        cc-swarm's `src/config.mjs` and `connectToMAP`),
 *                        which is exactly what openhive's `/ws/map`
 *                        endpoint authenticates against (`query.token`).
 *                        We also set `auth.credential` to the same value
 *                        so cc-swarm's verified-mode `map/authenticate`
 *                        flow (if exercised) has it available — they're
 *                        the same delegated agent-iam token; openhive
 *                        accepts it via either path.
 *   - `sessionlog.enabled` / `sessionlog.sync` : trajectory bridging.
 *   - `opentasks.enabled`  : leave off in v1 — we don't yet wire opentasks
 *                            for hosted Claude Code sessions.
 *
 * See `references/claude-code-swarm/CLAUDE.md` for the full schema and the
 * environment-variable overrides cc-swarm also reads.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

export interface ClaudeSwarmConfigOptions {
  /** WebSocket URL of the openhive MAP hub (e.g. ws://127.0.0.1:7836/ws/map). */
  mapServer: string;
  /** Scope name — we use the hosted-swarm id. */
  scope: string;
  /** Pre-registered MAP swarm id (cc-swarm registers under this id). */
  systemId: string;
  /** Bearer credential for the sidecar's MAP connection. */
  credential: string;
  /** Whether to enable sessionlog → MAP trajectory bridging. Defaults to true. */
  sessionlogEnabled?: boolean;
  /** sessionlog sync level. Defaults to 'metrics'. */
  sessionlogSync?: 'off' | 'lifecycle' | 'metrics' | 'full';
}

export interface ClaudeSwarmConfig {
  map: {
    server: string;
    scope: string;
    systemId: string;
    swarmId: string;
    auth: { token: string };
  };
  sessionlog: { enabled: boolean; sync: 'off' | 'lifecycle' | 'metrics' | 'full' };
  opentasks: { enabled: false };
}

export function buildClaudeSwarmConfig(opts: ClaudeSwarmConfigOptions): ClaudeSwarmConfig {
  return {
    map: {
      server: opts.mapServer,
      scope: opts.scope,
      systemId: opts.systemId,
      // Pin the URL-side swarm id so cc-swarm appends `?swarm_id=...` to
      // its WS URL. cc-swarm reads `map.swarmId` (falls back to the
      // Claude session id) for the open-mode identity hint — openhive's
      // open-mode `/ws/map` keys the inbound registration by this query
      // param. We use the pre-registered MAP swarm id so the sidecar's
      // connection lands on the row our spawn pipeline already created.
      swarmId: opts.systemId,
      // `auth.token` drives the `?token=...` query-param auth (verified
      // bearer). DON'T set `auth.credential` here: cc-swarm's
      // buildServerUrl skips appending `?swarm_id=` when `credential`
      // is set (it assumes identity comes from the credential itself in
      // verified mode). Open-mode openhive *needs* the swarm_id query
      // param, so we keep credential unset.
      auth: { token: opts.credential },
    },
    sessionlog: {
      enabled: opts.sessionlogEnabled ?? true,
      sync: opts.sessionlogSync ?? 'metrics',
    },
    opentasks: { enabled: false },
  };
}

/**
 * Write the config to `<dataDir>/.swarm/claude-swarm/config.json`. Creates
 * intermediate directories as needed. Sync — caller is the manager's spawn
 * pipeline, which is already async-aware but this write is fast.
 */
export function writeClaudeSwarmConfig(dataDir: string, config: ClaudeSwarmConfig): string {
  const dir = path.join(dataDir, '.swarm', 'claude-swarm');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'config.json');
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf8');
  return filePath;
}
