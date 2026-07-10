/**
 * QC station Q2 — review policy resolver, route gates, and the
 * unreviewed-merge monitor (docs/design/cascade-review-verdicts.md §4–§6).
 *
 *   - resolveReviewPolicy: three-scope chain, invalid values fall through
 *   - merge action gate: 409 review_required when policy=required and no
 *     current-head human approval; passes once approved; other actions and
 *     agent-only approvals never satisfy it
 *   - review monitor: emits cascade_unreviewed_merge + WS fan-out for
 *     merges landing without a qualifying approval under advisory/required
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { createResource } from '../../db/dal/syncable-resources.js';
import { upsertStream, recordCommit } from '../../db/dal/cascade-streams.js';
import { recordVerdict } from '../../db/dal/cascade-review-verdicts.js';
import { resolveReviewPolicy } from '../../cascade/policy.js';
import {
  startReviewMonitor,
  stopReviewMonitor,
  resolveStreamReviewGate,
  handleStreamMergedForReview,
} from '../../cascade/review-monitor.js';
import { mapHubEvents } from '../../map/service.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const broadcastMock = vi.fn();
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (channel: string, msg: unknown) => broadcastMock(channel, msg),
}));

import { cascadeRoutes } from '../../api/routes/cascade.js';

const TEST_ROOT = testRoot('cascade-review-gates');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'review-gates.db');

function makeStream(streamId: string, opts: { task_resource_id?: string } = {}): string {
  const { stream } = upsertStream({
    stream_id: streamId,
    source_swarm_id: 'swarm-gate',
    source_agent_id: 'agent-x',
    name: `stream ${streamId}`,
    task_resource_id: opts.task_resource_id,
  });
  return stream.id;
}

function approveAtHead(rowId: string, streamId: string, head: string): void {
  recordVerdict({
    stream_row_id: rowId,
    source_swarm_id: 'swarm-gate',
    stream_id: streamId,
    head_commit: head,
    verdict: 'approved',
    reviewer_kind: 'human',
    reviewer_id: 'alex',
  });
}

beforeAll(() => {
  initDatabase(TEST_DB_PATH);
});

afterAll(() => {
  closeDatabase();
  cleanTestRoot(TEST_ROOT);
});

afterEach(() => {
  stopReviewMonitor();
  broadcastMock.mockClear();
});

// ── Pure resolver ──────────────────────────────────────────────────────

describe('resolveReviewPolicy', () => {
  const hub = (defaultReviewPolicy: 'none' | 'advisory' | 'required') => ({
    defaultReviewPolicy,
  });

  it('falls through to the hub default', () => {
    expect(resolveReviewPolicy({ hubConfig: hub('none') })).toBe('none');
    expect(resolveReviewPolicy({ hubConfig: hub('required') })).toBe('required');
  });

  it('task scope wins over swarm and hub', () => {
    expect(
      resolveReviewPolicy({
        taskMetadata: { review_policy: 'required' },
        swarmCapabilities: { cascade: { reviewPolicy: 'none' } },
        hubConfig: hub('none'),
      }),
    ).toBe('required');
  });

  it('swarm scope wins over hub; explicit none overrides a strict hub', () => {
    expect(
      resolveReviewPolicy({
        swarmCapabilities: { cascade: { reviewPolicy: 'none' } },
        hubConfig: hub('required'),
      }),
    ).toBe('none');
  });

  it('invalid values fall through scope by scope', () => {
    expect(
      resolveReviewPolicy({
        taskMetadata: { review_policy: 'yes-please' },
        swarmCapabilities: { cascade: { reviewPolicy: 42 } },
        hubConfig: hub('advisory'),
      }),
    ).toBe('advisory');
  });
});

// ── Gate resolution (I/O join) ─────────────────────────────────────────

describe('resolveStreamReviewGate', () => {
  it('blocks under required with no verdict; unblocks after human approval', () => {
    const rowId = makeStream('st-gate-1');
    const head = 'a'.repeat(40);
    recordCommit({ stream_row_id: rowId, commit_hash: head });

    const stream = { id: rowId, source_swarm_id: 'swarm-gate', task_resource_id: null };
    let gate = resolveStreamReviewGate(stream, 'required');
    expect(gate).toMatchObject({ policy: 'required', approved: false, blocked: true, head_commit: head });

    approveAtHead(rowId, 'st-gate-1', head);
    gate = resolveStreamReviewGate(stream, 'required');
    expect(gate).toMatchObject({ approved: true, blocked: false });
  });

  it('agent approval never unblocks required ([D3])', () => {
    const rowId = makeStream('st-gate-2');
    const head = 'b'.repeat(40);
    recordCommit({ stream_row_id: rowId, commit_hash: head });
    recordVerdict({
      stream_row_id: rowId,
      source_swarm_id: 'swarm-gate',
      stream_id: 'st-gate-2',
      head_commit: head,
      verdict: 'approved',
      reviewer_kind: 'agent',
      reviewer_id: 'reviewer-bot',
    });
    const gate = resolveStreamReviewGate(
      { id: rowId, source_swarm_id: 'swarm-gate', task_resource_id: null },
      'required',
    );
    expect(gate.blocked).toBe(true);
    expect(gate.current_verdict?.reviewer_kind).toBe('agent');
  });

  it('reads the per-task scope from the bound resource', async () => {
    const { agent: owner } = await agentsDAL.createAgent({
      name: 'gate-resource-owner',
      description: 'owns the task resource',
    });
    const resource = createResource({
      resource_type: 'task',
      name: 'gate-task-scope',
      git_remote_url: 'local:///tmp/nonexistent-gate-repo',
      owner_agent_id: owner.id,
      metadata: { review_policy: 'required' },
    });
    const rowId = makeStream('st-gate-3', { task_resource_id: resource.id });
    // Hub default is none — the task scope alone must produce the block.
    const gate = resolveStreamReviewGate(
      { id: rowId, source_swarm_id: 'swarm-gate', task_resource_id: resource.id },
      'none',
    );
    expect(gate.policy).toBe('required');
    expect(gate.blocked).toBe(true);
  });
});

// ── Merge-action route gate ────────────────────────────────────────────

describe('POST /cascade/streams/:id/actions/merge gate', () => {
  let app: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    const { apiKey: key } = await agentsDAL.createAgent({
      name: 'gate-agent',
      description: 'route gate test',
    });
    apiKey = key;
    app = Fastify({ logger: false });
    app.decorateRequest('agent');
    await app.register(
      async (api) => {
        await api.register(cascadeRoutes);
      },
      { prefix: '/api/v1' },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('409 review_required under a required hub default with no approval', async () => {
    startReviewMonitor({ defaultReviewPolicy: 'required' });
    const rowId = makeStream('st-route-gate-1');
    recordCommit({ stream_row_id: rowId, commit_hash: 'c'.repeat(40) });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${rowId}/actions/merge`,
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string; policy: string };
    expect(body.code).toBe('review_required');
    expect(body.policy).toBe('required');
  });

  it('passes the gate once human-approved (fails later only on offline swarm)', async () => {
    startReviewMonitor({ defaultReviewPolicy: 'required' });
    const rowId = makeStream('st-route-gate-2');
    const head = 'd'.repeat(40);
    recordCommit({ stream_row_id: rowId, commit_hash: head });
    approveAtHead(rowId, 'st-route-gate-2', head);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${rowId}/actions/merge`,
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: {},
    });
    // Gate passed; the action then fails with 422 because no runtime is
    // connected in the test harness — which proves we got past the gate.
    expect(res.statusCode).toBe(422);
  });

  it('non-merge actions are never review-gated', async () => {
    startReviewMonitor({ defaultReviewPolicy: 'required' });
    const rowId = makeStream('st-route-gate-3');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${rowId}/actions/pause`,
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(422); // offline swarm, not 409
  });

  it('gate is off under the fleet default (none)', async () => {
    stopReviewMonitor(); // default policy resolves to 'none'
    const rowId = makeStream('st-route-gate-4');
    recordCommit({ stream_row_id: rowId, commit_hash: 'e'.repeat(40) });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${rowId}/actions/merge`,
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(422); // offline swarm, not 409
  });
});

// ── Unreviewed-merge monitor ───────────────────────────────────────────

describe('unreviewed-merge detection', () => {
  function captureHubEvent(): { events: unknown[]; dispose: () => void } {
    const events: unknown[] = [];
    const listener = (e: unknown) => events.push(e);
    mapHubEvents.on('cascade_unreviewed_merge', listener);
    return { events, dispose: () => mapHubEvents.off('cascade_unreviewed_merge', listener) };
  }

  it('flags a merge without qualifying approval under advisory/required', () => {
    const rowId = makeStream('st-mon-1');
    recordCommit({ stream_row_id: rowId, commit_hash: 'f'.repeat(40) });
    const { events, dispose } = captureHubEvent();

    handleStreamMergedForReview(
      {
        source_swarm_id: 'swarm-gate',
        source_stream_row_id: rowId,
        source_stream_id: 'st-mon-1',
        merge_commit: '9'.repeat(40),
      },
      { defaultReviewPolicy: 'advisory' },
    );
    dispose();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      stream_row_id: rowId,
      policy: 'advisory',
      current_verdict: null,
    });
    const channels = broadcastMock.mock.calls.map((c) => c[0]);
    expect(channels).toContain(`cascade:stream:${rowId}`);
    expect(channels).toContain('global');
    expect(broadcastMock.mock.calls[0][1]).toMatchObject({ type: 'cascade:unreviewed_merge' });
  });

  it('stays silent for approved merges and under policy none', () => {
    const rowId = makeStream('st-mon-2');
    const head = '1'.repeat(40);
    recordCommit({ stream_row_id: rowId, commit_hash: head });
    approveAtHead(rowId, 'st-mon-2', head);
    const { events, dispose } = captureHubEvent();

    // Approved → silent even under required.
    handleStreamMergedForReview(
      { source_swarm_id: 'swarm-gate', source_stream_row_id: rowId },
      { defaultReviewPolicy: 'required' },
    );
    // Policy none → silent even unapproved.
    const rowId2 = makeStream('st-mon-3');
    handleStreamMergedForReview(
      { source_swarm_id: 'swarm-gate', source_stream_row_id: rowId2 },
      { defaultReviewPolicy: 'none' },
    );
    dispose();

    expect(events).toHaveLength(0);
  });

  it('start/stop subscribes and unsubscribes the live handler', () => {
    const rowId = makeStream('st-mon-4');
    const { events, dispose } = captureHubEvent();

    startReviewMonitor({ defaultReviewPolicy: 'required' });
    mapHubEvents.emit('cascade_stream_merged', {
      source_swarm_id: 'swarm-gate',
      source_stream_row_id: rowId,
    });
    expect(events).toHaveLength(1);

    stopReviewMonitor();
    mapHubEvents.emit('cascade_stream_merged', {
      source_swarm_id: 'swarm-gate',
      source_stream_row_id: rowId,
    });
    expect(events).toHaveLength(1); // no second event after stop
    dispose();
  });
});
