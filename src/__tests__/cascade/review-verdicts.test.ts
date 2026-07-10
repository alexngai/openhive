/**
 * QC station Q1 — cascade review verdicts (docs/design/cascade-review-verdicts.md).
 *
 * Covers the DAL semantics (append-only, latest-per-head wins, human-only
 * gate predicate) and the route surface:
 *
 *   - POST records a verdict with a server-resolved head + principal-derived
 *     reviewer_kind (admin credential → human, plain agent key → agent)
 *   - a new commit invalidates the current approval by construction
 *   - 401 / 404 / 400 error contract
 *   - WS fan-out on record
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { upsertStream, recordCommit } from '../../db/dal/cascade-streams.js';
import {
  recordVerdict,
  listVerdictsForStream,
  getCurrentVerdict,
  isApprovedAtHead,
} from '../../db/dal/cascade-review-verdicts.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const broadcastMock = vi.fn();
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (channel: string, msg: unknown) => broadcastMock(channel, msg),
}));

import { cascadeRoutes } from '../../api/routes/cascade.js';

const TEST_ROOT = testRoot('cascade-review-verdicts');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'review-verdicts.db');

async function createTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent');
  await app.register(
    async (api) => {
      await api.register(cascadeRoutes);
    },
    { prefix: '/api/v1' },
  );
  return app;
}

function makeStream(streamId: string): string {
  const { stream } = upsertStream({
    stream_id: streamId,
    source_swarm_id: 'swarm-1',
    source_agent_id: 'agent-x',
    name: `stream ${streamId}`,
  });
  return stream.id;
}

beforeAll(() => {
  initDatabase(TEST_DB_PATH);
});

afterAll(() => {
  closeDatabase();
  cleanTestRoot(TEST_ROOT);
});

describe('cascade-review-verdicts DAL', () => {
  it('appends and lists newest-first', () => {
    const rowId = makeStream('st-dal-1');
    const v1 = recordVerdict({
      stream_row_id: rowId,
      source_swarm_id: 'swarm-1',
      stream_id: 'st-dal-1',
      head_commit: 'a'.repeat(40),
      verdict: 'changes_requested',
      reviewer_kind: 'human',
      reviewer_id: 'alex',
    });
    const v2 = recordVerdict({
      stream_row_id: rowId,
      source_swarm_id: 'swarm-1',
      stream_id: 'st-dal-1',
      head_commit: 'a'.repeat(40),
      verdict: 'approved',
      reviewer_kind: 'human',
      reviewer_id: 'alex',
    });
    const { verdicts, total } = listVerdictsForStream(rowId);
    expect(total).toBe(2);
    expect(verdicts[0].id).toBe(v2.id);
    expect(verdicts[1].id).toBe(v1.id);
    expect(v1.id.startsWith('rv_')).toBe(true);
  });

  it('getCurrentVerdict matches per-head, including null heads', () => {
    const rowId = makeStream('st-dal-2');
    recordVerdict({
      stream_row_id: rowId,
      source_swarm_id: 'swarm-1',
      stream_id: 'st-dal-2',
      head_commit: null,
      verdict: 'approved',
      reviewer_kind: 'human',
    });
    expect(getCurrentVerdict(rowId, null)?.verdict).toBe('approved');
    // A different head has no current verdict — approval doesn't travel.
    expect(getCurrentVerdict(rowId, 'b'.repeat(40))).toBeNull();
  });

  it('isApprovedAtHead requires a current HUMAN approved ([D3])', () => {
    const rowId = makeStream('st-dal-3');
    const head = 'c'.repeat(40);
    recordVerdict({
      stream_row_id: rowId,
      source_swarm_id: 'swarm-1',
      stream_id: 'st-dal-3',
      head_commit: head,
      verdict: 'approved',
      reviewer_kind: 'agent',
      reviewer_id: 'reviewer-bot',
    });
    // Agent approval is advisory — never satisfies the gate.
    expect(isApprovedAtHead(rowId, head)).toBe(false);

    recordVerdict({
      stream_row_id: rowId,
      source_swarm_id: 'swarm-1',
      stream_id: 'st-dal-3',
      head_commit: head,
      verdict: 'approved',
      reviewer_kind: 'human',
      reviewer_id: 'alex',
    });
    expect(isApprovedAtHead(rowId, head)).toBe(true);

    // Superseding with changes_requested flips the gate off (append-only,
    // latest wins).
    recordVerdict({
      stream_row_id: rowId,
      source_swarm_id: 'swarm-1',
      stream_id: 'st-dal-3',
      head_commit: head,
      verdict: 'changes_requested',
      reviewer_kind: 'human',
      reviewer_id: 'alex',
    });
    expect(isApprovedAtHead(rowId, head)).toBe(false);
  });
});

describe('verdict routes', () => {
  let app: FastifyInstance;
  let agentKey: string;
  let adminKey: string;
  let adminAgentId: string;

  beforeAll(async () => {
    const plain = await agentsDAL.createAgent({
      name: 'verdict-agent',
      description: 'plain agent key',
    });
    agentKey = plain.apiKey;
    const admin = await agentsDAL.createAgent({
      name: 'verdict-admin',
      description: 'operator credential',
      is_admin: true,
    });
    adminKey = admin.apiKey;
    adminAgentId = admin.agent.id;
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('401 without Authorization', async () => {
    const rowId = makeStream('st-route-0');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${rowId}/verdicts`,
      payload: { verdict: 'approved' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('404 for unknown stream', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cascade/streams/nope/verdicts',
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { verdict: 'approved' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400 for an invalid verdict value', async () => {
    const rowId = makeStream('st-route-1');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${rowId}/verdicts`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { verdict: 'lgtm' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('records with server-resolved head + admin principal → human', async () => {
    broadcastMock.mockClear();
    const rowId = makeStream('st-route-2');
    const head = 'd'.repeat(40);
    recordCommit({ stream_row_id: rowId, commit_hash: head });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${rowId}/verdicts`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { verdict: 'approved', notes: 'ship it' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: Record<string, unknown> };
    expect(body.data.head_commit).toBe(head);
    expect(body.data.reviewer_kind).toBe('human');
    expect(body.data.reviewer_id).toBe(adminAgentId);
    expect(body.data.notes).toBe('ship it');

    // WS fan-out: stream + swarm + global channels.
    const channels = broadcastMock.mock.calls.map((c) => c[0]);
    expect(channels).toContain(`cascade:stream:${rowId}`);
    expect(channels).toContain('cascade:swarm:swarm-1');
    expect(channels).toContain('global');
    expect(broadcastMock.mock.calls[0][1]).toMatchObject({
      type: 'cascade:review_verdict',
    });

    expect(isApprovedAtHead(rowId, head)).toBe(true);
  });

  it('plain agent key → reviewer_kind agent (advisory)', async () => {
    const rowId = makeStream('st-route-3');
    const head = 'e'.repeat(40);
    recordCommit({ stream_row_id: rowId, commit_hash: head });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${rowId}/verdicts`,
      headers: { Authorization: `Bearer ${agentKey}` },
      payload: { verdict: 'approved', dispatch_id: 'disp-1' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: Record<string, unknown> };
    expect(body.data.reviewer_kind).toBe('agent');
    expect(body.data.dispatch_id).toBe('disp-1');
    expect(isApprovedAtHead(rowId, head)).toBe(false);
  });

  it('a new commit invalidates the current approval (GET ?current=true)', async () => {
    const rowId = makeStream('st-route-4');
    recordCommit({ stream_row_id: rowId, commit_hash: 'f'.repeat(40) });

    await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${rowId}/verdicts`,
      headers: { Authorization: `Bearer ${adminKey}` },
      payload: { verdict: 'approved' },
    });

    let res = await app.inject({
      method: 'GET',
      url: `/api/v1/cascade/streams/${rowId}/verdicts?current=true`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { data: { verdict: string } | null }).data?.verdict).toBe('approved');

    // New head → the approval is no longer current. `synced_at` has
    // second precision, so pin the new commit strictly later to keep
    // getLatestCommitForStream deterministic inside a fast test.
    recordCommit({ stream_row_id: rowId, commit_hash: '0'.repeat(40) });
    getDatabase()
      .prepare(
        `UPDATE cascade_changes SET synced_at = datetime('now', '+1 hour') WHERE commit_hash = ?`
      )
      .run('0'.repeat(40));
    res = await app.inject({
      method: 'GET',
      url: `/api/v1/cascade/streams/${rowId}/verdicts?current=true`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: unknown; head_commit: string };
    expect(body.data).toBeNull();
    expect(body.head_commit).toBe('0'.repeat(40));
  });

  it('GET lists full history newest-first', async () => {
    const rowId = makeStream('st-route-5');
    for (const verdict of ['changes_requested', 'approved'] as const) {
      await app.inject({
        method: 'POST',
        url: `/api/v1/cascade/streams/${rowId}/verdicts`,
        headers: { Authorization: `Bearer ${adminKey}` },
        payload: { verdict },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/cascade/streams/${rowId}/verdicts`,
      headers: { Authorization: `Bearer ${adminKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ verdict: string }>; total: number };
    expect(body.total).toBe(2);
    expect(body.data[0].verdict).toBe('approved');
    expect(body.data[1].verdict).toBe('changes_requested');
  });
});
