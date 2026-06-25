/**
 * LIVE full-stack E2E for the autonomation experiment flow.
 *
 * Real launcher → real `openhive experiment-worker` subprocess (from
 * `dist/cli.js`) → real command-based autonomation run (NO LLM) → real event
 * stream → real finalization, all against a listening hub.
 *
 * FLAGGED + self-skipping: only runs when OPENHIVE_LIVE_AUTONOMATION is set AND
 * `dist/cli.js` exists AND the autonomation experiment-config dist module is
 * resolvable (i.e. the symlink + a built SDK are present). Otherwise it skips
 * with a clear reason rather than failing.
 *
 * The fixture is a deterministic, no-LLM command loop (mirrors autonomation's
 * config-runner.test.ts): an evaluator scores `train.txt` ("good" → 1, else 0)
 * and ALWAYS exits 0 (so the baseline scores cleanly), and an evolver rewrites
 * `train.txt` to "good". The inline (lightweight) config path is exercised, so
 * `content_hash` is null — the degraded-verifiability path must render cleanly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { experimentsRoutes } from '../../api/routes/experiments.js';
import { setupWebSocket, stopHeartbeat } from '../../realtime/index.js';
import { launchRun, cancelRunProcess } from '../../experiments/launcher.js';
import * as expDal from '../../db/dal/experiments.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const REPO_ROOT = process.cwd();
const CLI_ENTRY = resolve(REPO_ROOT, 'dist/cli.js');
const CONFIG_MODULE = resolve(
  REPO_ROOT,
  'node_modules/autonomation/dist/experiment-config/index.js',
);

// ── Skip guard ──────────────────────────────────────────────────────────────
const flagSet = Boolean(process.env.OPENHIVE_LIVE_AUTONOMATION);
const haveCli = existsSync(CLI_ENTRY);
const haveConfigModule = existsSync(CONFIG_MODULE);
const RUN_LIVE = flagSet && haveCli && haveConfigModule;
const skipReason = !flagSet
  ? 'OPENHIVE_LIVE_AUTONOMATION not set'
  : !haveCli
    ? `dist/cli.js missing (${CLI_ENTRY}) — run \`npm run build\``
    : `autonomation config module missing (${CONFIG_MODULE}) — symlink + build the SDK`;

const TEST_ROOT = testRoot('experiments-flow-live-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'experiments-flow-live-e2e.db');
const ADMIN_KEY = 'flow-live-e2e-admin-key';
const ADMIN = { 'x-admin-key': ADMIN_KEY };

function makeConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Flow Live E2E Hub', description: 'experiments live flow e2e' },
    admin: { createOnStartup: false, key: ADMIN_KEY },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** Build the deterministic no-LLM fixture repo. */
function buildFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openhive-live-e2e-'));
  git(['init', '--quiet', '--initial-branch=main'], dir);
  writeFileSync(join(dir, 'train.txt'), 'bad\n');
  git(['add', 'train.txt'], dir);
  git(
    ['-c', 'user.name=test', '-c', 'user.email=t@test', 'commit', '-m', 'init', '--quiet'],
    dir,
  );

  // Evaluator: score train.txt; ALWAYS exit 0 so the baseline scores cleanly.
  writeFileSync(
    join(dir, 'eval.mjs'),
    [
      "import { readFileSync } from 'node:fs';",
      "const train = readFileSync('train.txt', 'utf8').trim();",
      "const score = train === 'good' ? 1 : 0;",
      "console.log(`eval.score: ${score}`);",
      // NOTE: never process.exit(1) — the baseline must score cleanly.
    ].join('\n'),
  );
  // Evolver: rewrite train.txt to the "good" candidate.
  writeFileSync(
    join(dir, 'evolve.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync('train.txt', 'good\\n');",
      "console.log('evolved');",
    ].join('\n'),
  );
  return dir;
}

interface OneRunResponse {
  run: { id: string; status: string; content_hash: string | null };
}

const describeMaybe = RUN_LIVE ? describe : describe.skip;

describeMaybe('Experiment flow LIVE E2E (real worker subprocess, command autonomation)', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let fixtureDir: string | undefined;
  let experimentId: string | undefined;
  let runId: string | undefined;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);

    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(websocket);
    setupWebSocket(app);
    const config = makeConfig();
    await app.register(async (api) => api.register(experimentsRoutes, { config }), {
      prefix: '/api/v1',
    });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('Failed to bind ephemeral port');
    baseUrl = `http://127.0.0.1:${addr.port}`;

    fixtureDir = buildFixture();
  });

  afterAll(async () => {
    // Guard against leaking the spawned worker.
    if (runId) {
      try {
        cancelRunProcess(runId);
      } catch {
        /* best effort */
      }
    }
    stopHeartbeat();
    await app?.close();
    closeDatabase();
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    cleanTestRoot(TEST_ROOT);
  });

  it(
    'spawns the real worker for an inline command loop and finalizes the run complete',
    async () => {
      const repoRoot = fixtureDir!;
      const evalPath = join(repoRoot, 'eval.mjs');
      const evolvePath = join(repoRoot, 'evolve.mjs');

      // The inline DOMAIN ExperimentConfig (lightweight, no deployment lock).
      const inline = {
        repoRoot,
        experimentBranch: 'autonomation/experiment/live-e2e',
        target: {
          substrateId: 'sub-a',
          variableId: 'train',
          file: 'train.txt',
          kind: 'code-region',
          language: 'text',
        },
        evaluator: {
          kind: 'command',
          command: [process.execPath, evalPath],
          metric: { id: 'eval.score', pattern: 'eval\\.score:\\s+([0-9.]+)' },
          env: {},
          extraMetrics: [],
        },
        evolver: {
          kind: 'command',
          command: [process.execPath, evolvePath],
          env: {},
          inheritEnv: [],
        },
        objective: { metric: 'eval.score', direction: 'increase', aggregate: 'mean' },
        evalSet: [{ id: 'objective', prompt: 'Run the objective evaluator.' }],
        cycles: 1,
        run: { failOnNoCandidate: false },
        allowedPaths: ['train.txt'],
        requireBaselineMetric: true,
        lineage: { kind: 'memory' },
        keepExperimentWorktree: false,
      };

      // Create the experiment via the API with config.inline.
      const createRes = await fetch(`${baseUrl}/api/v1/experiments`, {
        method: 'POST',
        headers: { ...ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'live-e2e',
          objective_metric: 'eval.score',
          objective_direction: 'increase',
          config: { inline },
        }),
      });
      expect(createRes.status).toBe(201);
      experimentId = ((await createRes.json()) as { experiment: { id: string } }).experiment.id;

      // Create a run.
      const runRes = await fetch(`${baseUrl}/api/v1/experiments/${experimentId}/runs`, {
        method: 'POST',
        headers: { ...ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(runRes.status).toBe(201);
      runId = ((await runRes.json()) as { run: { id: string } }).run.id;

      // Launch the REAL worker subprocess against the actual bound port.
      const experiment = expDal.findExperimentById(experimentId!)!;
      const run = expDal.findRunById(runId!)!;
      const launch = launchRun(experiment, run, {
        hubUrl: baseUrl,
        cliEntry: CLI_ENTRY,
        execPath: process.execPath,
      });
      expect(launch.pid).toBeGreaterThan(0);

      // Poll the single-run endpoint until terminal or timeout (~90s).
      const deadline = Date.now() + 90_000;
      let status = 'queued';
      let lastRun: OneRunResponse['run'] | undefined;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const res = await fetch(
          `${baseUrl}/api/v1/experiments/${experimentId}/runs/${runId}`,
          { headers: ADMIN },
        );
        if (res.status !== 200) continue;
        lastRun = ((await res.json()) as OneRunResponse).run;
        status = lastRun.status;
        if (status === 'complete' || status === 'failed' || status === 'cancelled') break;
      }

      // Assert: the run reached complete.
      expect(status).toBe('complete');

      // Events streamed; includes a promotion_keep or experiment_complete marker.
      const eventsRes = await fetch(
        `${baseUrl}/api/v1/experiments/${experimentId}/runs/${runId}/events?limit=500`,
        { headers: ADMIN },
      );
      const eventTail = (await eventsRes.json()) as { data: Array<{ type: string }> };
      expect(eventTail.data.length).toBeGreaterThan(0);
      const eventTypes = new Set(eventTail.data.map((e) => e.type));
      expect(
        eventTypes.has('promotion_keep') || eventTypes.has('experiment_complete'),
      ).toBe(true);

      // A candidate was projected — the "good" candidate, kept/promoted.
      const candsRes = await fetch(
        `${baseUrl}/api/v1/experiments/${experimentId}/candidates`,
        { headers: ADMIN },
      );
      const cands = (await candsRes.json()) as {
        data: Array<{ status: string; promoted: boolean }>;
      };
      expect(cands.data.length).toBeGreaterThan(0);
      expect(
        cands.data.some((c) => c.status === 'keep' || c.promoted === true),
      ).toBe(true);

      // content_hash === null on the inline lightweight path — the degraded
      // verifiability path renders cleanly, not an error.
      expect(lastRun!.content_hash).toBeNull();
    },
    120_000,
  );
});

// Surface the skip reason in CI logs when the suite is skipped.
if (!RUN_LIVE) {
  // eslint-disable-next-line no-console
  console.log(`[flow-live-e2e] skipped: ${skipReason}`);
}
