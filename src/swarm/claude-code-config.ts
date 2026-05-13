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

/**
 * Pre-trust a working directory in Claude Code's user config (`~/.claude.json`).
 *
 * Without this, the freshly-created data_dir hits Claude Code's "Trust this
 * folder?" security prompt on first launch, which blocks SessionStart from
 * firing. cc-swarm's plugin hooks only run after SessionStart, so the sidecar
 * never registers and the spawn lands at `unhealthy`. Pre-trusting the dir
 * does what the user clicking "Yes, I trust" would do — Claude Code stores
 * trusted directories in `projects.<path>.hasTrustDialogAccepted`.
 *
 * Idempotent: skips the rewrite if already trusted. Tolerant of missing or
 * malformed config (no-op + warn, NOT a hard fail — the spawn proceeds and
 * the user can dismiss the prompt manually if needed).
 *
 * Returns true if the dir is now trusted (either already, or just written).
 */
export function preTrustClaudeWorkdir(workdir: string, homeDir: string): boolean {
  // Claude canonicalizes the cwd via realpath before checking trust, so on
  // macOS where `/tmp` → `/private/tmp` (and `/var` → `/private/var`) the
  // unresolved path won't match. Resolve symlinks here so the entry we
  // write matches what claude looks up.
  let resolvedWorkdir = workdir;
  try { resolvedWorkdir = fs.realpathSync(workdir); } catch { /* dir may not exist yet — fall back to as-given */ }

  const claudeConfigPath = path.join(homeDir, '.claude.json');
  let raw: string;
  try {
    raw = fs.readFileSync(claudeConfigPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No claude.json — likely Claude Code has never run. Skip silently;
      // claude will create the file on first launch (and prompt for trust).
      return false;
    }
    console.warn(`[claude-code] could not read ${claudeConfigPath}: ${(err as Error).message}`);
    return false;
  }

  let parsed: { projects?: Record<string, { hasTrustDialogAccepted?: boolean } & Record<string, unknown>> } & Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[claude-code] ${claudeConfigPath} is not valid JSON: ${(err as Error).message}`);
    return false;
  }

  const projects = parsed.projects ?? {};
  const existing = projects[resolvedWorkdir];
  if (existing?.hasTrustDialogAccepted === true) return true;

  // Mirror the shape claude itself writes when the user clicks Yes.
  projects[resolvedWorkdir] = {
    ...(existing ?? {}),
    allowedTools: (existing?.allowedTools as unknown) ?? [],
    mcpContextUris: (existing?.mcpContextUris as unknown) ?? [],
    mcpServers: (existing?.mcpServers as unknown) ?? {},
    enabledMcpjsonServers: (existing?.enabledMcpjsonServers as unknown) ?? [],
    disabledMcpjsonServers: (existing?.disabledMcpjsonServers as unknown) ?? [],
    hasTrustDialogAccepted: true,
    projectOnboardingSeenCount: (existing?.projectOnboardingSeenCount as unknown) ?? 0,
    hasClaudeMdExternalIncludesApproved: (existing?.hasClaudeMdExternalIncludesApproved as unknown) ?? false,
    hasClaudeMdExternalIncludesWarningShown: (existing?.hasClaudeMdExternalIncludesWarningShown as unknown) ?? false,
  };
  parsed.projects = projects;

  // Atomic write: temp + rename so a crash mid-write doesn't truncate the
  // user's claude config. The temp file lands in the same dir so rename is
  // atomic (same filesystem).
  const tmp = claudeConfigPath + '.openhive.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf8');
    fs.renameSync(tmp, claudeConfigPath);
    return true;
  } catch (err) {
    console.warn(`[claude-code] could not pre-trust ${resolvedWorkdir} in ${claudeConfigPath}: ${(err as Error).message}`);
    try { fs.unlinkSync(tmp); } catch { /* may not exist */ }
    return false;
  }
}
