/**
 * Codex binary resolution.
 *
 * Mirrors `claude-binary.ts`. The `codex` CLI typically lands in a
 * Homebrew or npm-global bin path on macOS/Linux; we probe PATH first,
 * then a small list of conventional locations. Returns null if not found,
 * letting the caller surface a clear "install Codex" error from the spawn
 * pipeline.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const KNOWN_LOCATIONS = [
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
];

export function resolveCodexBinary(): string | null {
  try {
    const fromPath = execSync('which codex', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    if (fromPath && existsSync(fromPath)) return fromPath;
  } catch {
    // not on PATH — fall through
  }

  for (const candidate of KNOWN_LOCATIONS) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}
