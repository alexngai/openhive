/**
 * E2E for the full autonomation experiment flow through OpenHive's control plane.
 *
 * Deterministic and in-suite (no flag, no real autonomation, no subprocess):
 * boots a real Fastify hub with `app.listen` (so a real WS client can connect),
 * registers `experimentsRoutes` + `setupWebSocket`, then drives
 * `runExperimentWorker` against the LISTENING server with a real `fetch` as the
 * worker's `fetchImpl` and the deployment-path fake as `loadAutonomation`.
 *
 * It validates the FULL UI data contract (the read endpoints `useExperiments.ts`
 * consumes) AND the realtime fan-out a dashboard subscriber sees on
 * `map:experiments` across the lifecycle:
 *
 *   create → run create (run_started) → worker start (run_updated: running)
 *   → live events (candidate) → finalize (run_finished)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { experimentsRoutes } from '../../api/routes/experiments.js';
import { setupWebSocket, stopHeartbeat } from '../../realtime/index.js';
import { runExperimentWorker } from '../../experiments/worker/run-experiment-worker.js';
import { ConfigSchema, type Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { fakeAutonomation } from './helpers/fake-autonomation.js';

const TEST_ROOT = testRoot('experiments-flow-e2e');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'experiments-flow-e2e.db');
const ADMIN_KEY = 'flow-e2e-admin-key';
const ADMIN = { 'x-admin-key': ADMIN_KEY };

function makeConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Flow E2E Hub', description: 'experiments flow e2e' },
    admin: { createOnStartup: false, key: ADMIN_KEY },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    cors: { enabled: false },
  });
}

// ── WS client helpers (copied from headless-ws-e2e.test.ts) ─────────────────

/** Connect a WS client and wait for the welcome message. */
function connectWS(baseUrl: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = token
      ? `${baseUrl.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`
      : `${baseUrl.replace('http', 'ws')}/ws`;
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WS connection timeout'));
    }, 5000);
    ws.once('message', () => {
      clearTimeout(timeout);
      resolve(ws);
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

interface ParsedWSEvent {
  type: string;
  channel?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
}

/** Subscribe to channels and wait for the subscription ack. */
function subscribe(ws: WebSocket, channels: string[]): Promise<ParsedWSEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Subscribe ack timeout')), 5000);
    const handler = (data: Buffer | string) => {
      const msg: ParsedWSEvent = JSON.parse(data.toString());
      if (msg.data && 'subscribed' in msg.data) {
        clearTimeout(timeout);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ type: 'subscribe', channels }));
  });
}

/** Wait for a specific event type; resolves null on timeout. */
function waitForEvent(
  ws: WebSocket,
  eventType: string,
  timeoutMs = 5000,
): Promise<ParsedWSEvent | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(null);
    }, timeoutMs);
    const handler = (data: Buffer | string) => {
      const msg: ParsedWSEvent = JSON.parse(data.toString());
      if (msg.type === eventType) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

/** Attach a passive collector that records every parsed message until detached. */
function collectEvents(ws: WebSocket): { events: ParsedWSEvent[]; stop: () => void } {
  const events: ParsedWSEvent[] = [];
  const handler = (data: Buffer | string) => {
    try {
      events.push(JSON.parse(data.toString()) as ParsedWSEvent);
    } catch {
      /* ignore non-JSON frames */
    }
  };
  ws.on('message', handler);
  return { events, stop: () => ws.removeListener('message', handler) };
}

describe('Experiment flow E2E (deployment fake, real WS + listening hub)', () => {
  let app: FastifyInstance;
  let baseUrl: string;

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
  });

  afterAll(async () => {
    stopHeartbeat();
    await app?.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('drives create → run → worker loop → finalize, asserting WS fan-out + the UI read contract', async () => {
    // A real fetch against the listening server — this is exactly what the
    // worker subprocess would do over the wire.
    const realFetch: typeof fetch = (input, init) =>
      fetch(typeof input === 'string' ? input : String(input), init);

    // The dashboard subscriber: a real WS client on `map:experiments`.
    const ws = await connectWS(baseUrl, undefined);
    try {
      await subscribe(ws, ['map:experiments']);

      // 1. Create the experiment (admin) → 201.
      const createRes = await fetch(`${baseUrl}/api/v1/experiments`, {
        method: 'POST',
        headers: { ...ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'flow-e2e',
          objective_metric: 'eval.score',
          objective_direction: 'increase',
          config: { deployment: { deploymentPath: 'd.yaml', runPath: 'r.yaml' } },
        }),
      });
      expect(createRes.status).toBe(201);
      const experimentId = ((await createRes.json()) as { experiment: { id: string } })
        .experiment.id;
      expect(experimentId).toMatch(/^exp_/);

      // List includes it (GET /experiments — the useExperiments query surface).
      const listRes = await fetch(`${baseUrl}/api/v1/experiments?limit=100&offset=0`, {
        headers: ADMIN,
      });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as { data: Array<{ id: string }>; total: number };
      expect(list.data.some((e) => e.id === experimentId)).toBe(true);

      // Now collect every WS event for the rest of the lifecycle.
      const collector = collectEvents(ws);
      const runStartedP = waitForEvent(ws, 'experiment.run_started', 5000);

      // 2. Create the run (admin) → capture worker_token + run id.
      const runRes = await fetch(`${baseUrl}/api/v1/experiments/${experimentId}/runs`, {
        method: 'POST',
        headers: { ...ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(runRes.status).toBe(201);
      const runBody = (await runRes.json()) as {
        run: { id: string; status: string };
        worker_token: string;
      };
      const runId = runBody.run.id;
      const workerToken = runBody.worker_token;
      expect(runId).toMatch(/^exrun_/);
      expect(workerToken).toMatch(/^ohw_/);
      expect(runBody.run.status).toBe('queued');

      // 3. The run_started broadcast arrived on map:experiments.
      const runStarted = await runStartedP;
      expect(runStarted).not.toBeNull();
      expect(runStarted!.channel).toBe('map:experiments');
      expect(runStarted!.data).toMatchObject({
        experiment_id: experimentId,
        run_id: runId,
        status: 'queued',
      });

      // 4. Drive the worker to completion against the listening hub.
      const result = await runExperimentWorker({
        hubUrl: baseUrl,
        apiKey: workerToken,
        experimentId,
        runId,
        deploymentPath: 'd.yaml',
        runPath: 'r.yaml',
        objectiveMetric: 'eval.score',
        fetchImpl: realFetch,
        loadAutonomation: async () => fakeAutonomation(),
      });
      expect(result).toEqual({ status: 'complete', stopReason: 'cycle-budget', failed: false });

      // Give any trailing broadcasts a tick to land on the socket.
      await new Promise((r) => setTimeout(r, 100));
      collector.stop();

      // 5. The WS events observed across the run.
      const types = collector.events.map((e) => e.type);
      // running PATCH → run_updated; live promotion → candidate; finalize → run_finished.
      expect(types).toContain('experiment.run_updated');
      expect(types).toContain('experiment.candidate');
      expect(types).toContain('experiment.run_finished');
      // Each fanned out on the fleet channel.
      for (const e of collector.events) {
        if (e.type.startsWith('experiment.')) expect(e.channel).toBe('map:experiments');
      }
      // The run_updated→running transition is the worker's tracker.start.
      const runUpdated = collector.events.find(
        (e) => e.type === 'experiment.run_updated' && e.data?.status === 'running',
      );
      expect(runUpdated).toBeDefined();
      expect(runUpdated!.data).toMatchObject({ experiment_id: experimentId, run_id: runId });
      // The candidate broadcast names c1 with a keep projection.
      const candEvent = collector.events.find((e) => e.type === 'experiment.candidate');
      expect(candEvent!.data).toMatchObject({ candidate_ref: 'c1' });
      // run_finished carries the terminal status.
      const finished = collector.events.find((e) => e.type === 'experiment.run_finished');
      expect(finished!.data).toMatchObject({
        experiment_id: experimentId,
        run_id: runId,
        status: 'complete',
      });

      // 6. The UI read endpoints reflect the projected state.

      // GET /experiments/:id — run embedded, status complete, content_hash set.
      const detailRes = await fetch(`${baseUrl}/api/v1/experiments/${experimentId}`, {
        headers: ADMIN,
      });
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as {
        experiment: { id: string; content_hash: string | null };
        runs: Array<{ id: string; status: string; content_hash: string | null }>;
        run_total: number;
      };
      expect(detail.experiment.id).toBe(experimentId);
      // content_hash back-filled onto the experiment from the run's lock.
      expect(detail.experiment.content_hash).toBe('sha256:fakelock');
      const embedded = detail.runs.find((r) => r.id === runId)!;
      expect(embedded.status).toBe('complete');
      expect(embedded.content_hash).toBe('sha256:fakelock');

      // GET /experiments/:id/runs — the runs list.
      const runsRes = await fetch(`${baseUrl}/api/v1/experiments/${experimentId}/runs`, {
        headers: ADMIN,
      });
      const runs = (await runsRes.json()) as { data: Array<{ id: string; status: string }>; total: number };
      expect(runs.data.some((r) => r.id === runId && r.status === 'complete')).toBe(true);

      // GET /experiments/:id/runs/:runId — the single-run endpoint.
      const oneRunRes = await fetch(
        `${baseUrl}/api/v1/experiments/${experimentId}/runs/${runId}`,
        { headers: ADMIN },
      );
      expect(oneRunRes.status).toBe(200);
      const oneRun = (await oneRunRes.json()) as {
        run: {
          id: string;
          status: string;
          content_hash: string | null;
          claim_strength: { strength?: string } | null;
        };
      };
      expect(oneRun.run.id).toBe(runId);
      // worker_token_hash is stripped by publicRun.
      expect(oneRun.run).not.toHaveProperty('worker_token_hash');

      // GET /experiments/:id/candidates — c1 kept, scores from the lineage snapshot.
      const candsRes = await fetch(
        `${baseUrl}/api/v1/experiments/${experimentId}/candidates`,
        { headers: ADMIN },
      );
      const cands = (await candsRes.json()) as {
        data: Array<{
          candidate_ref: string;
          status: string;
          score_train: number | null;
          score_held_out: number | null;
          promoted: boolean;
        }>;
      };
      expect(cands.data).toHaveLength(1);
      const c1 = cands.data[0];
      expect(c1.candidate_ref).toBe('c1');
      expect(c1.status).toBe('keep');
      expect(c1.score_train).toBe(0.85); // from lineage card
      expect(c1.score_held_out).toBe(0.72); // from lineage gateCard
      expect(c1.promoted).toBe(true);

      // GET /experiments/:id/runs/:runId/events — the live tail, ordered by seq.
      const eventsRes = await fetch(
        `${baseUrl}/api/v1/experiments/${experimentId}/runs/${runId}/events?limit=500`,
        { headers: ADMIN },
      );
      const eventTail = (await eventsRes.json()) as {
        data: Array<{ seq: number; type: string }>;
        max_seq: number;
      };
      expect(eventTail.data.length).toBe(4);
      expect(eventTail.data.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
      expect(eventTail.data.map((e) => e.type)).toEqual([
        'experiment_start',
        'candidate_admitted',
        'promotion_keep',
        'experiment_complete',
      ]);

      // 7. Finalization: content_hash === the fake's lock; claim_strength present.
      expect(oneRun.run.content_hash).toBe('sha256:fakelock');
      expect(oneRun.run.claim_strength).toEqual({
        strength: 'capability',
        label: 'capability lift',
      });
    } finally {
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});
