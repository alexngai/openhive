/**
 * TUI-kind spawn strategies.
 *
 * Both `claude-code` and `codex` follow the same shape: openhive spawns
 * an interactive TUI in a node-pty PTY, attaches the embedded terminal
 * to it, and manages lifecycle (stop/restart/crash). The work that
 * actually differs per kind is small — binary resolution, workspace
 * trust, env hygiene, "ready" detection, and any per-kind sidecar /
 * prelaunch artifacts. We pull that variation into a strategy object;
 * the manager has one shared spawn pipeline that consumes it.
 *
 * Adding a new TUI-shaped kind (e.g. `gemini`) is a single new strategy
 * implementation here plus a one-line entry in `getTuiKindStrategy`.
 */

import { resolveClaudeBinary } from './claude-binary.js';
import { resolveCodexBinary } from './codex-binary.js';
import {
  buildClaudeSwarmConfig,
  writeClaudeSwarmConfig,
  preTrustClaudeWorkdir,
} from './claude-code-config.js';
import { preTrustCodexWorkdir } from './codex-config.js';
import type { HostedSwarm, HostedSwarmKind } from './types.js';

/** Context passed to per-strategy hooks during spawn. */
export interface TuiPrelaunchCtx {
  /** Pre-registered MAP swarm id for this hosted row. */
  swarmId: string;
  /** Hosted swarm id (DB primary key). */
  hostedSwarmId: string;
  /** Onboard credential the TUI's sidecar (if any) uses to dial back. */
  onboardToken: string;
  /** WS URL of the openhive MAP hub. */
  mapServer: string;
  /** Where the TUI runs (cwd). */
  dataDir: string;
}

/** Per-kind sidecar liveness check. Used by waitForReady. */
export interface SidecarReadyCheck {
  /** Has the sidecar registered against the swarm? Returns true to stop polling. */
  isReady(swarmId: string): boolean;
}

export interface TuiKindStrategy {
  kind: HostedSwarmKind;

  /** Resolve the binary path (PATH + known locations). null = not installed. */
  resolveBinary(): string | null;

  /**
   * Stable placeholder endpoint for MAP pre-registration. The TUI doesn't
   * listen on a port; this is just a unique identity tag for the registry.
   */
  placeholderEndpoint(hostedSwarmId: string): string;

  /**
   * Pre-mark the data_dir as trusted in the TUI's user-level config so the
   * "Trust this folder?" gate doesn't block first-launch hooks. Best-effort:
   * a missing user config returns false and lets the user dismiss the prompt.
   */
  preTrustWorkdir(dataDir: string, homeDir: string): boolean;

  /**
   * Optional prelaunch files (e.g. cc-swarm's `.swarm/claude-swarm/config.json`).
   * Called AFTER any workspace clone, so the file lands inside the cloned tree
   * if there is one.
   */
  writePrelaunchFiles?(ctx: TuiPrelaunchCtx): void;

  /** Extra env to set on the spawned PTY (e.g. CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1). */
  extraEnv(): Record<string, string>;

  /**
   * Env-var names to strip before spawning. Avoids self-detection markers
   * that would make a TUI refuse to launch when invoked from inside another
   * TUI session of the same kind.
   */
  envVarsToStrip(): string[];

  /**
   * Whether this kind has a sidecar that registers against the openhive
   * MAP hub. claude-code yes (cc-swarm plugin); codex no in v1 (no plugin
   * yet — the codex-swarm plugin will land later).
   */
  hasSidecar: boolean;

  /**
   * If hasSidecar, the registration timeout (ms). Ignored when hasSidecar
   * is false — the spawn pipeline considers the kind ready as soon as the
   * PTY is up.
   */
  sidecarRegistrationTimeoutMs?: number;

  /**
   * Signal the sidecar process (best-effort). Only invoked when hasSidecar
   * is true. Reads PID files written under data_dir; tolerates missing
   * files and ESRCH.
   */
  signalSidecar?(hosted: HostedSwarm, signal: NodeJS.Signals): boolean;

  /**
   * Adapter label for the persisted provision config. Cosmetic — surfaces
   * as `config.adapter` on the row, which legacy code occasionally reads.
   */
  adapterLabel(): string;
}

// ============================================================================
// claude-code
// ============================================================================

export function makeClaudeCodeStrategy(opts: {
  signalSidecar: (hosted: HostedSwarm, signal: NodeJS.Signals) => boolean;
}): TuiKindStrategy {
  return {
    kind: 'claude-code',
    resolveBinary: resolveClaudeBinary,
    placeholderEndpoint: (id) => `internal:cc:${id}`,
    preTrustWorkdir: preTrustClaudeWorkdir,
    writePrelaunchFiles: (ctx) => {
      const cfg = buildClaudeSwarmConfig({
        mapServer: ctx.mapServer,
        scope: ctx.hostedSwarmId,
        systemId: ctx.swarmId,
        credential: ctx.onboardToken,
      });
      writeClaudeSwarmConfig(ctx.dataDir, cfg);
    },
    extraEnv: () => ({
      // cc-swarm requires this in older Claude Code versions; current Claude
      // Code accepts it as a no-op. Setting unconditionally is safe and
      // matches cc-swarm's settings.json convention.
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    }),
    envVarsToStrip: () => ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH'],
    hasSidecar: true,
    sidecarRegistrationTimeoutMs: 60_000,
    signalSidecar: opts.signalSidecar,
    adapterLabel: () => 'claude-code',
  };
}

// ============================================================================
// codex
// ============================================================================

export function makeCodexStrategy(): TuiKindStrategy {
  return {
    kind: 'codex',
    resolveBinary: resolveCodexBinary,
    placeholderEndpoint: (id) => `internal:cx:${id}`,
    preTrustWorkdir: preTrustCodexWorkdir,
    // No prelaunch files in v1 — codex doesn't have an openhive-aware plugin
    // yet. When codex-swarm lands, this hook gets a config writer analogous
    // to writeClaudeSwarmConfig.
    extraEnv: () => ({}),
    // Codex's TUI sets CODEX_* env vars on launch. Strip the ones that
    // signal "you're already inside a codex session" so the spawned codex
    // doesn't refuse to start when openhive itself was launched from a
    // codex shell. This mirrors the CLAUDECODE markers we strip for
    // claude-code; safe to strip even if codex doesn't currently set them.
    envVarsToStrip: () => ['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_ENTRYPOINT'],
    hasSidecar: false,
    adapterLabel: () => 'codex',
  };
}

// ============================================================================
// Registry
// ============================================================================

/**
 * Returns the strategy for a TUI-shaped kind. Returns null for kinds that
 * aren't TUI-shaped (e.g. swarm-runner, which routes through LocalProvider).
 */
export function getTuiKindStrategy(
  kind: HostedSwarmKind,
  deps: { signalSidecar: (hosted: HostedSwarm, signal: NodeJS.Signals) => boolean },
): TuiKindStrategy | null {
  if (kind === 'claude-code') return makeClaudeCodeStrategy({ signalSidecar: deps.signalSidecar });
  if (kind === 'codex') return makeCodexStrategy();
  return null;
}

export function isTuiKind(kind: HostedSwarmKind): boolean {
  return kind === 'claude-code' || kind === 'codex';
}
