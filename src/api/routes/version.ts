import type { FastifyInstance } from 'fastify';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve openhive's version by walking up from this module's location
 * until we find the package.json whose name === 'openhive'. Works in both
 * the unbundled source (src/api/routes/version.ts) and the tsup bundle
 * (dist/index.js), which have different ancestor depths to the root.
 */
function resolveOpenhiveVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === 'openhive' && typeof parsed.version === 'string') {
        return parsed.version;
      }
    } catch { /* not found or unreadable, keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

const CURRENT = resolveOpenhiveVersion();

// Cache the npm lookup so banner polling doesn't hammer registry.npmjs.org.
// 1h cache on success, 5min on failure so transient errors recover quickly.
const CACHE_OK_MS = 60 * 60 * 1000;
const CACHE_FAIL_MS = 5 * 60 * 1000;

let cache: { at: number; latest: string | null; ok: boolean } | null = null;

/**
 * Source: GitHub Releases. Single source of truth — electron-updater uses
 * the same feed, so desktop and web version numbers can never drift. npm
 * isn't consulted because the name "openhive" on npm may point at a
 * different package entirely (unrelated publisher).
 */
const RELEASES_URL =
  'https://api.github.com/repos/alexngai/openhive/releases/latest';

async function fetchLatestVersion(): Promise<string | null> {
  const now = Date.now();
  if (cache) {
    const ttl = cache.ok ? CACHE_OK_MS : CACHE_FAIL_MS;
    if (now - cache.at < ttl) return cache.latest;
  }
  try {
    const r = await fetch(RELEASES_URL, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) throw new Error(`github returned ${r.status}`);
    const data = (await r.json()) as { tag_name?: string };
    if (typeof data.tag_name !== 'string') throw new Error('no tag_name in response');
    // GitHub tags are conventionally `v0.1.2` — strip the `v` prefix.
    const version = data.tag_name.replace(/^v/, '');
    cache = { at: now, latest: version, ok: true };
    return version;
  } catch {
    cache = { at: now, latest: null, ok: false };
    return null;
  }
}

/**
 * `a` newer than `b`? Simple semver compare that tolerates pre-release tags
 * by falling back to string compare on them. Good enough for the update
 * banner — returns `true` only when there's a clearly-newer release.
 */
function isNewer(a: string, b: string): boolean {
  const [aCore, aPre] = a.split('-', 2);
  const [bCore, bPre] = b.split('-', 2);
  const aParts = aCore.split('.').map(Number);
  const bParts = bCore.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const ai = aParts[i] ?? 0;
    const bi = bParts[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  if (aPre && !bPre) return false;  // a is pre-release, b is final → b newer
  if (!aPre && bPre) return true;
  if (aPre && bPre) return aPre > bPre;
  return false;  // equal
}

export async function versionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/version/check', async (_req, reply) => {
    const latest = await fetchLatestVersion();
    const updateAvailable = latest != null && isNewer(latest, CURRENT);
    // `deployment` tells the frontend how to present the update CTA.
    // `process.versions.electron` is set whenever the process is running
    // Electron's embedded Node (including ELECTRON_RUN_AS_NODE=1 forks).
    const deployment = process.versions.electron ? 'electron' : 'web';
    return reply.send({
      current: CURRENT,
      latest,
      updateAvailable,
      deployment,
      // How the client should help the user update. The client branches
      // on `deployment`; these strings are for display.
      instructions:
        deployment === 'electron'
          ? 'The desktop app will update itself — restart when prompted.'
          : `Download v${latest ?? 'latest'} from https://github.com/alexngai/openhive/releases/latest and redeploy.`,
    });
  });
}
