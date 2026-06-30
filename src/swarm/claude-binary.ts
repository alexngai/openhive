/**
 * Claude Code binary resolution.
 *
 * The `claude` CLI ships from a few different places depending on how the
 * operator installed it: standalone npm install, the cmux app bundle, or
 * Anthropic's installer. We probe a small list of conventional locations
 * and PATH; if none match we return null and the caller surfaces a clear
 * error from the spawn pipeline ("claude not found — install Claude Code").
 *
 * Pattern mirrors src/terminal/resolve-tui.ts (SwarmRunner TUI resolver).
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const KNOWN_LOCATIONS = [
  // cmux app bundle (macOS): /Applications/cmux.app/Contents/Resources/bin/claude
  '/Applications/cmux.app/Contents/Resources/bin/claude',
  // Anthropic installer default on macOS
  '/Applications/Claude.app/Contents/Resources/bin/claude',
  // Common npm-global locations
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
];

/**
 * Resolve the `claude` binary path. Returns null if not found.
 *
 * Order:
 *   1. The PATH (`which claude`) — what the operator's shell would use.
 *   2. A short list of known install locations (cmux, Claude.app, etc.).
 */
export function resolveClaudeBinary(): string | null {
  // Try PATH first via `which`. We use execSync rather than fs.access because
  // PATH may include shell-only entries (e.g., aliases) that fs can't probe.
  try {
    const fromPath = execSync('which claude', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (fromPath && existsSync(fromPath)) {
      return fromPath;
    }
  } catch {
    // `which` returns non-zero when not found — fall through.
  }

  for (const candidate of KNOWN_LOCATIONS) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}
