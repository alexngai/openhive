/**
 * Review flow — the derived inbox and the verdict→thread feedback link
 * (design §11 discussion, 2026-07-09).
 *
 *   - listStreamsAwaitingReview: derived membership — enters with commits
 *     under a non-none policy, agent verdicts keep it in, any human verdict
 *     removes it, a new commit re-enters it
 *   - GET /cascade/review-inbox route surface
 *   - postVerdictThreadTurn: dispatch-conversation first, spec-thread
 *     fallback, silent when unbound or no thread exists
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { upsertStream, recordCommit } from '../../db/dal/cascade-streams.js';
import {
  createDispatch,
  setDispatchConversationId,
  addDispatchLinkedTasks,
} from '../../db/dal/dispatches.js';
import { recordVerdict, type CascadeReviewVerdict } from '../../db/dal/cascade-review-verdicts.js';
import { specThreadConversationId } from '../../specs/spec-conversation.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

// Mail fabric double: `handleRequest` records turns; `getConversation`
// answers from a test-controlled set of existing conversation ids.
const mailTurns: Array<{ method: string; params: Record<string, unknown> }> = [];
const knownConversations = new Set<string>();
vi.mock('../../mail/index.js', () => ({
  getMailJsonRpc: () => ({
    handleRequest: async (req: { id: string; method: string; params: Record<string, unknown> }) => {
      mailTurns.push({ method: req.method, params: req.params });
      return { jsonrpc: '2.0', id: req.id, result: {} };
    },
  }),
  getMailStorage: () => ({
    getConversation: (id: string) => (knownConversations.has(id) ? { id } : null),
  }),
}));

import {
  listStreamsAwaitingReview,
  startReviewMonitor,
  stopReviewMonitor,
} from '../../cascade/review-monitor.js';
import { postVerdictThreadTurn } from '../../cascade/review-thread.js';
import { cascadeRoutes } from '../../api/routes/cascade.js';

const TEST_ROOT = testRoot('cascade-review-flow');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'review-flow.db');
const SWARM = 'swarm-flow';

let streamSeq = 0;
function makeStream(opts: { task_resource_id?: string; task_node_id?: string } = {}): {
  rowId: string;
  streamId: string;
} {
  const streamId = `st-flow-${++streamSeq}`;
  const { stream } = upsertStream({
    stream_id: streamId,
    source_swarm_id: SWARM,
    source_agent_id: 'agent-author',
    name: `stream ${streamId}`,
    base_commit: '0'.repeat(40),
    task_resource_id: opts.task_resource_id,
    task_node_id: opts.task_node_id,
  });
  return { rowId: stream.id, streamId };
}

function verdictFor(
  rowId: string,
  streamId: string,
  overrides: Partial<Parameters<typeof recordVerdict>[0]> = {},
): CascadeReviewVerdict {
  return recordVerdict({
    stream_row_id: rowId,
    source_swarm_id: SWARM,
    stream_id: streamId,
    head_commit: 'a'.repeat(40),
    verdict: 'changes_requested',
    reviewer_kind: 'human',
    reviewer_id: 'alex',
    ...overrides,
  });
}

beforeAll(() => {
  initDatabase(TEST_DB_PATH);
});

afterAll(() => {
  closeDatabase();
  cleanTestRoot(TEST_ROOT);
});

beforeEach(() => {
  mailTurns.length = 0;
  knownConversations.clear();
});

afterEach(() => {
  stopReviewMonitor();
});

// ── Derived inbox ──────────────────────────────────────────────────────

describe('listStreamsAwaitingReview', () => {
  const inboxIds = () => new Set(listStreamsAwaitingReview('required').map((e) => e.stream_row_id));

  it('derives membership through the review lifecycle', () => {
    const { rowId, streamId } = makeStream();

    // No commits yet → not reviewable.
    expect(inboxIds().has(rowId)).toBe(false);

    // Commit lands → enters the inbox.
    const head = 'a'.repeat(40);
    recordCommit({ stream_row_id: rowId, commit_hash: head });
    let entries = listStreamsAwaitingReview('required');
    const entry = entries.find((e) => e.stream_row_id === rowId);
    expect(entry).toMatchObject({ policy: 'required', head_commit: head, agent_verdict: null });

    // Agent (advisory) approval → still awaiting the human, verdict surfaced.
    verdictFor(rowId, streamId, {
      verdict: 'approved',
      reviewer_kind: 'agent',
      reviewer_id: 'reviewer-bot',
      notes: 'looks fine',
    });
    entries = listStreamsAwaitingReview('required');
    expect(entries.find((e) => e.stream_row_id === rowId)?.agent_verdict).toMatchObject({
      verdict: 'approved',
      reviewer_id: 'reviewer-bot',
    });

    // Any HUMAN verdict → leaves the inbox (ball is elsewhere).
    verdictFor(rowId, streamId, { verdict: 'changes_requested' });
    expect(inboxIds().has(rowId)).toBe(false);

    // New commit moves the head → re-enters automatically. `synced_at` has
    // second precision, so pin the new commit strictly later to keep
    // getLatestCommitForStream deterministic inside a fast test.
    recordCommit({ stream_row_id: rowId, commit_hash: 'b'.repeat(40) });
    getDatabase()
      .prepare(
        `UPDATE cascade_changes SET synced_at = datetime('now', '+1 hour')
         WHERE stream_row_id = ? AND commit_hash = ?`,
      )
      .run(rowId, 'b'.repeat(40));
    expect(inboxIds().has(rowId)).toBe(true);
  });

  it('is empty under policy none', () => {
    const { rowId } = makeStream();
    recordCommit({ stream_row_id: rowId, commit_hash: 'c'.repeat(40) });
    expect(
      listStreamsAwaitingReview('none').some((e) => e.stream_row_id === rowId),
    ).toBe(false);
  });
});

// ── Route surface ──────────────────────────────────────────────────────

describe('GET /cascade/review-inbox', () => {
  let app: FastifyInstance;
  let apiKey: string;

  beforeAll(async () => {
    const { apiKey: key } = await agentsDAL.createAgent({
      name: 'review-flow-route',
      description: 'route test',
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

  it('serves the derived set under the monitor-supplied hub default', async () => {
    startReviewMonitor({ defaultReviewPolicy: 'required' });
    const { rowId } = makeStream();
    recordCommit({ stream_row_id: rowId, commit_hash: 'd'.repeat(40) });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cascade/review-inbox',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ stream_row_id: string }>; total: number };
    expect(body.data.some((e) => e.stream_row_id === rowId)).toBe(true);
    expect(body.total).toBe(body.data.length);
  });
});

// ── Verdict → thread turn ──────────────────────────────────────────────

describe('postVerdictThreadTurn', () => {
  it('posts to the linked dispatch conversation, with review metadata', async () => {
    const { rowId, streamId } = makeStream({
      task_resource_id: 'res_flow_1',
      task_node_id: 'task-1',
    });
    const dispatch = createDispatch({
      spec_resource_id: 'res_spec_1',
      spec_id: 'spec-1',
      target_swarm_id: SWARM,
      initiator_type: 'user',
      initiator_id: 'alex',
    });
    addDispatchLinkedTasks(dispatch.id, [{ resource_id: 'res_flow_1', node_id: 'task-1' }]);
    setDispatchConversationId(dispatch.id, 'conv-author-1');
    knownConversations.add('conv-author-1');

    const verdict = verdictFor(rowId, streamId, { notes: 'off-by-one in pager' });
    const posted = await postVerdictThreadTurn(verdict, {
      id: rowId,
      name: `stream ${streamId}`,
      task_resource_id: 'res_flow_1',
      task_node_id: 'task-1',
    });

    expect(posted).toBe(true);
    expect(mailTurns).toHaveLength(1);
    expect(mailTurns[0].method).toBe('mail/turn');
    expect(mailTurns[0].params.conversationId).toBe('conv-author-1');
    const content = mailTurns[0].params.content as string;
    expect(content).toContain('CHANGES REQUESTED');
    expect(content).toContain('off-by-one in pager');
    expect(mailTurns[0].params.metadata).toMatchObject({
      kind: 'review_verdict',
      verdict: 'changes_requested',
      stream_row_id: rowId,
    });
  });

  it('falls back to an existing spec thread when no dispatch conversation exists', async () => {
    const { rowId, streamId } = makeStream({
      task_resource_id: 'res_flow_2',
      task_node_id: 'task-2',
    });
    const dispatch = createDispatch({
      spec_resource_id: 'res_spec_2',
      spec_id: 'spec-2',
      target_swarm_id: SWARM,
      initiator_type: 'user',
      initiator_id: 'alex',
    });
    addDispatchLinkedTasks(dispatch.id, [{ resource_id: 'res_flow_2', node_id: 'task-2' }]);
    const specConv = specThreadConversationId('res_spec_2', 'spec-2');
    knownConversations.add(specConv);

    const verdict = verdictFor(rowId, streamId, { verdict: 'approved' });
    const posted = await postVerdictThreadTurn(verdict, {
      id: rowId,
      name: `stream ${streamId}`,
      task_resource_id: 'res_flow_2',
      task_node_id: 'task-2',
    });

    expect(posted).toBe(true);
    expect(mailTurns[0].params.conversationId).toBe(specConv);
    expect(mailTurns[0].params.content as string).toContain('APPROVED');
  });

  it('stays silent for unbound streams and when no thread exists', async () => {
    const unbound = makeStream();
    const v1 = verdictFor(unbound.rowId, unbound.streamId);
    expect(
      await postVerdictThreadTurn(v1, {
        id: unbound.rowId,
        name: 'unbound',
        task_resource_id: null,
        task_node_id: null,
      }),
    ).toBe(false);

    // Task-bound but no dispatch conversation and no spec thread created.
    const bound = makeStream({ task_resource_id: 'res_flow_3', task_node_id: 'task-3' });
    const v2 = verdictFor(bound.rowId, bound.streamId);
    expect(
      await postVerdictThreadTurn(v2, {
        id: bound.rowId,
        name: 'bound-no-thread',
        task_resource_id: 'res_flow_3',
        task_node_id: 'task-3',
      }),
    ).toBe(false);
    expect(mailTurns).toHaveLength(0);
  });
});
