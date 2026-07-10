/**
 * QC station Q3 — reviewer dispatch (docs/design/cascade-review-verdicts.md §5.3).
 *
 *   - requestReviewDispatch: queued prompt dispatch with role 'reviewer',
 *     `review:<stream_row_id>` correlation, diff inlined when the resolver
 *     serves it and a local-inspection fallback when it can't
 *   - extractVerdictFromOutcome: structured field, fenced JSON (last valid
 *     block wins), malformed/invalid rejected
 *   - finalizeDispatch write-back: completed review dispatch → advisory
 *     agent verdict carrying dispatch_id; idempotent across double
 *     finalize; no-ops for non-review and failed dispatches
 *   - POST /cascade/streams/:id/request-review route surface
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { upsertStream, recordCommit } from '../../db/dal/cascade-streams.js';
import { createDispatch, findDispatchById } from '../../db/dal/dispatches.js';
import { listVerdictsForStream } from '../../db/dal/cascade-review-verdicts.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { DiffResult } from '../../cascade/diff-types.js';

const broadcastMock = vi.fn();
vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (channel: string, msg: unknown) => broadcastMock(channel, msg),
}));

// Same shape as diff-route.test.ts — cascade.ts imports all three resolvers.
const resolveStreamMock = vi.fn<(args: Record<string, unknown>) => Promise<DiffResult>>();
vi.mock('../../cascade/diff-resolver.js', () => ({
  resolveCommitDiff: vi.fn(),
  resolveStreamDiff: (args: Record<string, unknown>) => resolveStreamMock(args),
  resolveStackDiff: vi.fn(),
}));

import {
  requestReviewDispatch,
  extractVerdictFromOutcome,
  REVIEW_INITIATOR_PREFIX,
} from '../../cascade/review-dispatch.js';
import { finalizeDispatch } from '../../dispatch/finalize.js';
import { cascadeRoutes } from '../../api/routes/cascade.js';

const TEST_ROOT = testRoot('cascade-review-dispatch');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'review-dispatch.db');
const SWARM = 'swarm-review';

function makeStream(streamId: string): string {
  const { stream } = upsertStream({
    stream_id: streamId,
    source_swarm_id: SWARM,
    source_agent_id: 'agent-author',
    name: `stream ${streamId}`,
    base_commit: '0'.repeat(40),
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

beforeEach(() => {
  resolveStreamMock.mockReset();
  broadcastMock.mockClear();
});

// ── requestReviewDispatch ──────────────────────────────────────────────

describe('requestReviewDispatch', () => {
  it('creates a queued reviewer dispatch with the diff inlined', async () => {
    const rowId = makeStream('st-rd-1');
    recordCommit({ stream_row_id: rowId, commit_hash: 'a'.repeat(40) });
    resolveStreamMock.mockResolvedValueOnce({
      ok: true,
      payload: { diff: 'diff --git a/x b/x\n+added line\n', files_touched: ['x'], truncated: false },
    });

    const result = await requestReviewDispatch({
      streamRowId: rowId,
      initiatorType: 'user',
    });
    expect(result).not.toBeNull();
    expect(result!.diff_inlined).toBe(true);

    const d = result!.dispatch;
    expect(d.status).toBe('queued');
    expect(d.role).toBe('reviewer');
    expect(d.target_swarm_id).toBe(SWARM);
    expect(d.initiator_id).toBe(`${REVIEW_INITIATOR_PREFIX}${rowId}`);
    expect(d.prompt_override).toContain('st-rd-1');
    expect(d.prompt_override).toContain('+added line');
    expect(d.prompt_override).toContain('"verdict"');
    expect(d.prompt_override).toContain('ADVISORY');
  });

  it('degrades to local inspection when the diff is unavailable', async () => {
    const rowId = makeStream('st-rd-2');
    resolveStreamMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'swarm_offline', message: 'no connection' },
    });

    const result = await requestReviewDispatch({
      streamRowId: rowId,
      targetSwarmId: 'swarm-elsewhere',
      initiatorType: 'agent',
    });
    expect(result!.diff_inlined).toBe(false);
    expect(result!.dispatch.target_swarm_id).toBe('swarm-elsewhere');
    expect(result!.dispatch.prompt_override).toContain('Diff unavailable');
    expect(result!.dispatch.prompt_override).toContain('swarm_offline');
  });

  it('returns null for an unknown stream', async () => {
    expect(
      await requestReviewDispatch({ streamRowId: 'nope', initiatorType: 'user' }),
    ).toBeNull();
  });
});

// ── extractVerdictFromOutcome ──────────────────────────────────────────

describe('extractVerdictFromOutcome', () => {
  it('reads a structured review_verdict field', () => {
    expect(
      extractVerdictFromOutcome({
        review_verdict: { verdict: 'approved', notes: 'clean change' },
      }),
    ).toEqual({ verdict: 'approved', notes: 'clean change' });
  });

  it('reads the last valid fenced JSON block from summary', () => {
    const summary = [
      'Here is the required format:',
      '```json\n{"verdict": "approved", "notes": "example from the prompt"}\n```',
      'After reviewing, my actual verdict:',
      '```json\n{"verdict": "changes_requested", "notes": "off-by-one in pager"}\n```',
    ].join('\n');
    expect(extractVerdictFromOutcome({ summary })).toEqual({
      verdict: 'changes_requested',
      notes: 'off-by-one in pager',
    });
  });

  it('skips malformed blocks and rejects invalid verdict values', () => {
    const summary =
      '```json\n{not json}\n```\n```json\n{"verdict": "lgtm"}\n```';
    expect(extractVerdictFromOutcome({ summary })).toBeNull();
    expect(extractVerdictFromOutcome(null)).toBeNull();
    expect(extractVerdictFromOutcome({ summary: 'no verdict here' })).toBeNull();
  });
});

// ── finalize write-back ────────────────────────────────────────────────

describe('finalizeDispatch verdict write-back', () => {
  function makeReviewDispatch(rowId: string): string {
    const d = createDispatch({
      spec_resource_id: 'ad_hoc',
      spec_id: `${REVIEW_INITIATOR_PREFIX}${rowId}`,
      target_swarm_id: SWARM,
      initiator_type: 'user',
      initiator_id: `${REVIEW_INITIATOR_PREFIX}${rowId}`,
      prompt_override: 'review prompt',
      role: 'reviewer',
    });
    return d.id;
  }

  it('records an advisory agent verdict at the current head, idempotently', () => {
    const rowId = makeStream('st-fb-1');
    const head = 'b'.repeat(40);
    recordCommit({ stream_row_id: rowId, commit_hash: head });
    const dispatchId = makeReviewDispatch(rowId);

    finalizeDispatch(dispatchId, 'complete', {
      summary: 'Done.\n```json\n{"verdict": "approved", "notes": "solid"}\n```',
    });

    let { verdicts } = listVerdictsForStream(rowId);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      verdict: 'approved',
      reviewer_kind: 'agent',
      dispatch_id: dispatchId,
      head_commit: head,
      notes: 'solid',
    });
    // WS fan-out fired with the verdict event.
    expect(
      broadcastMock.mock.calls.some(
        (c) => (c[1] as { type: string }).type === 'cascade:review_verdict',
      ),
    ).toBe(true);

    // Double finalize (agent report + orchestrator bridge) → still one row.
    finalizeDispatch(dispatchId, 'complete', {
      summary: '```json\n{"verdict": "approved", "notes": "solid"}\n```',
    });
    ({ verdicts } = listVerdictsForStream(rowId));
    expect(verdicts).toHaveLength(1);
  });

  it('no-ops for failed review dispatches and non-review dispatches', () => {
    const rowId = makeStream('st-fb-2');
    recordCommit({ stream_row_id: rowId, commit_hash: 'c'.repeat(40) });

    const failedId = makeReviewDispatch(rowId);
    finalizeDispatch(failedId, 'failed', {
      summary: '```json\n{"verdict": "approved"}\n```',
    });

    const plain = createDispatch({
      spec_resource_id: 'ad_hoc',
      spec_id: 'plain',
      target_swarm_id: SWARM,
      initiator_type: 'user',
      initiator_id: 'some-user',
      prompt_override: 'do work',
    });
    finalizeDispatch(plain.id, 'complete', {
      summary: '```json\n{"verdict": "approved"}\n```',
    });

    expect(listVerdictsForStream(rowId).verdicts).toHaveLength(0);
  });

  it('completes without a verdict when the summary has none', () => {
    const rowId = makeStream('st-fb-3');
    const dispatchId = makeReviewDispatch(rowId);
    finalizeDispatch(dispatchId, 'complete', { summary: 'I reviewed it, looks fine!' });
    expect(listVerdictsForStream(rowId).verdicts).toHaveLength(0);
    expect(findDispatchById(dispatchId)?.status).toBe('complete');
  });
});

// ── Route surface ──────────────────────────────────────────────────────

describe('POST /cascade/streams/:id/request-review', () => {
  let app: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    const { apiKey: key } = await agentsDAL.createAgent({
      name: 'review-dispatch-route',
      description: 'route test',
      is_admin: true,
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

  it('201 with the queued reviewer dispatch', async () => {
    const rowId = makeStream('st-route-rr-1');
    resolveStreamMock.mockResolvedValueOnce({
      ok: true,
      payload: { diff: 'diff --git a/y b/y\n', files_touched: ['y'], truncated: false },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/cascade/streams/${rowId}/request-review`,
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { dispatch_id: string; role: string; status: string } };
    expect(body.data.role).toBe('reviewer');
    expect(body.data.status).toBe('queued');
    expect(findDispatchById(body.data.dispatch_id)?.initiator_id).toBe(
      `${REVIEW_INITIATOR_PREFIX}${rowId}`,
    );
  });

  it('404 for an unknown stream', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/cascade/streams/nope/request-review',
      headers: { Authorization: `Bearer ${apiKey}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});
