/**
 * Codex pre-launch configuration helpers.
 *
 * Codex stores per-project trust in `~/.codex/config.toml` under a
 *   [projects."<absolute-path>"]
 *   trust_level = "trusted"
 * stanza. Without it, `codex` shows a folder-trust prompt on first launch
 * for an unfamiliar directory — same gate `claude` has, same need to
 * pre-mark our spawn-owned data_dir as trusted before launch so the TUI
 * comes up clean.
 *
 * We don't depend on a TOML library: the format is line-oriented, the
 * stanza shape is small, and we only need to add (never remove) entries.
 * Read the file, look for the section, append a fresh one if absent,
 * upsert `trust_level` if the section exists. Atomic write via temp+rename.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const TRUST_LINE = 'trust_level = "trusted"';

/**
 * Pre-mark the given workdir as trusted in `~/.codex/config.toml`.
 *
 * Idempotent. Tolerant of missing config (creates `~/.codex/` + minimal
 * file). Tolerant of malformed TOML — falls back to appending a new
 * stanza after a leading comment, since codex itself lenient-parses.
 *
 * Returns true if the dir is now trusted (already, or newly written).
 */
export function preTrustCodexWorkdir(workdir: string, homeDir: string): boolean {
  // Codex resolves cwd to its real path before checking trust, same as
  // claude — symlinked /tmp paths on macOS won't match without realpath.
  let resolvedWorkdir = workdir;
  try { resolvedWorkdir = fs.realpathSync(workdir); } catch { /* may not exist yet */ }

  const codexDir = path.join(homeDir, '.codex');
  const codexConfigPath = path.join(codexDir, 'config.toml');

  // Section header pattern: [projects."<path>"]   (we accept either quoting
  // codex uses; codex emits double quotes consistently).
  const escapedPath = resolvedWorkdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionRegex = new RegExp(
    `^\\[projects\\.["\']${escapedPath}["\']\\]\\s*$`,
    'm',
  );

  let raw = '';
  let exists = false;
  try {
    raw = fs.readFileSync(codexConfigPath, 'utf8');
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[codex] could not read ${codexConfigPath}: ${(err as Error).message}`);
      return false;
    }
  }

  // Already trusted? Look for the section, then check if its body has
  // trust_level = "trusted" before the next section header (or EOF).
  if (exists) {
    const sectionMatch = sectionRegex.exec(raw);
    if (sectionMatch) {
      const sectionStart = sectionMatch.index + sectionMatch[0].length;
      const remainder = raw.slice(sectionStart);
      const nextSection = remainder.search(/^\[/m);
      const sectionBody = nextSection >= 0 ? remainder.slice(0, nextSection) : remainder;
      if (/trust_level\s*=\s*"trusted"/m.test(sectionBody)) {
        return true;
      }
      // Section exists but doesn't have trust_level — append it inside.
      const insertAt = sectionStart;
      const before = raw.slice(0, insertAt);
      const after = raw.slice(insertAt);
      const ensureLeadingNewline = before.endsWith('\n') ? '' : '\n';
      raw = `${before}${ensureLeadingNewline}${TRUST_LINE}\n${after}`;
      return atomicWrite(codexDir, codexConfigPath, raw);
    }
  }

  // No section yet — append a fresh stanza. Pad with a blank line so the
  // file stays human-readable.
  const stanza = `\n[projects."${resolvedWorkdir}"]\n${TRUST_LINE}\n`;
  raw = exists && raw.length > 0 && !raw.endsWith('\n')
    ? raw + '\n' + stanza.trimStart()
    : raw + stanza;
  return atomicWrite(codexDir, codexConfigPath, raw);
}

function atomicWrite(dir: string, file: string, content: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.openhive.tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.warn(`[codex] could not pre-trust workdir in ${file}: ${(err as Error).message}`);
    return false;
  }
}
