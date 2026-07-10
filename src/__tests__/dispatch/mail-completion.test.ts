/**
 * Mail-route completion observer — unit test.
 *
 * Verifies the observer correctly maps mail reply turns to in-flight
 * dispatch rows and finalizes them as `complete`. Closes the gap in
 * swarm-dispatch's MessagePort contract (no `onResult` for outbound
 * deliveries) that left mail-route dispatches stuck at `running` until
 * the stall timeout fired `dead` → `failed`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as dispatches from '../../db/dal/dispatches.js';
import * as cascadeStreams from '../../db/dal/cascade-streams.js';
import { listVerdictsForStream } from '../../db/dal/cascade-review-verdicts.js';
import {
  setupMailCompletionObserver,
  classifyReplyContent,
  buildOutcomeFromReply,
} from '../../dispatch/mail-completion.js';
import { DISPATCHER_PARTICIPANT_ID } from '../../dispatch/mail-transport.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('mail-completion');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'mail-completion.db');

beforeAll(() => {
  cleanTestRoot(TEST_ROOT);
  initDatabase(TEST_DB_PATH);
});

afterAll(() => {
  closeDatabase();
  cleanTestRoot(TEST_ROOT);
});

beforeEach(() => {
  const db = getDatabase();
  db.exec('DELETE FROM dispatches');
});

function seedRunningDispatch(conversationId: string | null): dispatches.Dispatch {
  const d = dispatches.createDispatch({
    spec_resource_id: 'res_test',
    spec_id: 'c-test',
    target_swarm_id: 'swarm_test',
    initiator_type: 'user',
    initiator_id: 'agent_test',
  });
  dispatches.claimDispatch(d.id, 'orch-1');
  if (conversationId) {
    dispatches.setDispatchConversationId(d.id, conversationId);
  }
  return dispatches.findDispatchById(d.id)!;
}

describe('mail-completion observer', () => {
  it('flips a running dispatch to complete when a reply turn arrives', () => {
    const conv = 'conv-001';
    const d = seedRunningDispatch(conv);

    const emitter = new EventEmitter();
    const stop = setupMailCompletionObserver({
      getMailEvents: () => emitter,
      log: () => {},
    });

    emitter.emit('mail.turn.added', {
      conversation_id: conv,
      participant_id: 'worker_agent_1', // non-dispatcher
      content_type: 'text/plain',
      content: 'done',
    });

    const after = dispatches.findDispatchById(d.id)!;
    expect(after.status).toBe('complete');
    stop();
  });

  it('ignores turns from the dispatcher itself', () => {
    const conv = 'conv-002';
    const d = seedRunningDispatch(conv);

    const emitter = new EventEmitter();
    const stop = setupMailCompletionObserver({
      getMailEvents: () => emitter,
      log: () => {},
    });

    emitter.emit('mail.turn.added', {
      conversation_id: conv,
      participant_id: DISPATCHER_PARTICIPANT_ID,
      content_type: 'text/plain',
      content: 'outbound dispatch envelope',
    });

    expect(dispatches.findDispatchById(d.id)!.status).toBe('running');
    stop();
  });

  it('ignores turns for unknown conversations', () => {
    const d = seedRunningDispatch('conv-real');

    const emitter = new EventEmitter();
    const stop = setupMailCompletionObserver({
      getMailEvents: () => emitter,
      log: () => {},
    });

    emitter.emit('mail.turn.added', {
      conversation_id: 'conv-unknown',
      participant_id: 'worker_agent_1',
      content_type: 'text/plain',
      content: 'reply to nothing',
    });

    expect(dispatches.findDispatchById(d.id)!.status).toBe('running');
    stop();
  });

  it('ignores turns for dispatches already terminal (idempotent)', () => {
    const conv = 'conv-003';
    const d = seedRunningDispatch(conv);
    // Move to terminal first.
    dispatches.transitionDispatch(d.id, 'complete');

    const emitter = new EventEmitter();
    const stop = setupMailCompletionObserver({
      getMailEvents: () => emitter,
      log: () => {},
    });

    emitter.emit('mail.turn.added', {
      conversation_id: conv,
      participant_id: 'worker_agent_1',
      content_type: 'text/plain',
      content: 'late reply',
    });

    // No throw, still complete (idempotent).
    expect(dispatches.findDispatchById(d.id)!.status).toBe('complete');
    stop();
  });

  it('handles malformed turn payloads without crashing the listener', () => {
    const conv = 'conv-004';
    const d = seedRunningDispatch(conv);

    const emitter = new EventEmitter();
    const stop = setupMailCompletionObserver({
      getMailEvents: () => emitter,
      log: () => {},
    });

    // Various malformed shapes — none should throw.
    emitter.emit('mail.turn.added', null);
    emitter.emit('mail.turn.added', 'not an object');
    emitter.emit('mail.turn.added', {}); // missing fields
    emitter.emit('mail.turn.added', { conversation_id: conv }); // missing participant
    emitter.emit('mail.turn.added', { participant_id: 'x' }); // missing conversation_id

    expect(dispatches.findDispatchById(d.id)!.status).toBe('running');
    stop();
  });

  it('flips dispatch to FAILED when reply content carries explicit failure status', () => {
    const conv = 'conv-fail-1';
    const d = seedRunningDispatch(conv);
    const emitter = new EventEmitter();
    const stop = setupMailCompletionObserver({
      getMailEvents: () => emitter,
      log: () => {},
    });
    emitter.emit('mail.turn.added', {
      conversation_id: conv,
      participant_id: 'worker_agent_1',
      content_type: 'application/json',
      content: JSON.stringify({ status: 'failed', summary: 'agent reported error' }),
    });
    expect(dispatches.findDispatchById(d.id)!.status).toBe('failed');
    stop();
  });

  it('flips dispatch to FAILED when JSON content carries an `error` field', () => {
    const conv = 'conv-fail-2';
    const d = seedRunningDispatch(conv);
    const emitter = new EventEmitter();
    const stop = setupMailCompletionObserver({
      getMailEvents: () => emitter,
      log: () => {},
    });
    emitter.emit('mail.turn.added', {
      conversation_id: conv,
      participant_id: 'worker_agent_1',
      content_type: 'application/json',
      content: JSON.stringify({ error: 'something exploded' }),
    });
    expect(dispatches.findDispatchById(d.id)!.status).toBe('failed');
    stop();
  });

  it('SKIPS the flip when reply content is empty/whitespace only', () => {
    const conv = 'conv-empty';
    const d = seedRunningDispatch(conv);
    const emitter = new EventEmitter();
    const stop = setupMailCompletionObserver({
      getMailEvents: () => emitter,
      log: () => {},
    });
    emitter.emit('mail.turn.added', {
      conversation_id: conv,
      participant_id: 'worker_agent_1',
      content_type: 'text/plain',
      content: '   ',
    });
    expect(dispatches.findDispatchById(d.id)!.status).toBe('running');
    stop();
  });

  it('unsubscribe stops listening', () => {
    const conv = 'conv-005';
    const d = seedRunningDispatch(conv);

    const emitter = new EventEmitter();
    const stop = setupMailCompletionObserver({
      getMailEvents: () => emitter,
      log: () => {},
    });
    stop();

    emitter.emit('mail.turn.added', {
      conversation_id: conv,
      participant_id: 'worker_agent_1',
      content_type: 'text/plain',
      content: 'after unsubscribe',
    });

    expect(dispatches.findDispatchById(d.id)!.status).toBe('running');
  });

  it('threads a fenced-JSON verdict reply into an agent verdict (Q3 end-to-end)', () => {
    // Seed a stream with a commit + a review dispatch bound to it via the
    // `review:<streamRowId>` correlation.
    const { stream } = cascadeStreams.upsertStream({
      stream_id: 'st-mc-review',
      source_swarm_id: 'swarm_test',
      source_agent_id: 'agent-author',
      name: 'mc review stream',
      base_commit: '0'.repeat(40),
    });
    cascadeStreams.recordCommit({ stream_row_id: stream.id, commit_hash: 'a'.repeat(40) });

    const conv = 'conv-review-e2e';
    const d = dispatches.createDispatch({
      spec_resource_id: 'ad_hoc',
      spec_id: `review:${stream.id}`,
      target_swarm_id: 'swarm_test',
      initiator_type: 'user',
      initiator_id: `review:${stream.id}`,
      role: 'reviewer',
    });
    dispatches.claimDispatch(d.id, 'orch-1');
    dispatches.setDispatchConversationId(d.id, conv);

    const emitter = new EventEmitter();
    const stop = setupMailCompletionObserver({ getMailEvents: () => emitter, log: () => {} });

    emitter.emit('mail.turn.added', {
      conversation_id: conv,
      participant_id: 'worker_reviewer_1',
      content_type: 'text/plain',
      content:
        'Reviewed the diff.\n```json\n{"verdict": "changes_requested", "notes": "off-by-one in the pager loop"}\n```',
    });

    const after = dispatches.findDispatchById(d.id)!;
    expect(after.status).toBe('complete');
    // The reply summary is preserved on the outcome (was null before the fix).
    expect(after.outcome?.summary).toContain('off-by-one');

    // …and the Q3 finalize hook parsed it into an advisory agent verdict.
    const { verdicts } = listVerdictsForStream(stream.id);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      verdict: 'changes_requested',
      reviewer_kind: 'agent',
      dispatch_id: d.id,
      notes: 'off-by-one in the pager loop',
    });
    stop();
  });
});

// ─────────────────────────────────────────────────────────────────────
// classifyReplyContent — pure function, table-driven coverage
// ─────────────────────────────────────────────────────────────────────
describe('classifyReplyContent', () => {
  const cases: Array<{ name: string; input: unknown; expected: 'complete' | 'failed' | 'skip' }> = [
    { name: 'null',                    input: null,                                                  expected: 'skip' },
    { name: 'undefined',               input: undefined,                                             expected: 'skip' },
    { name: 'empty string',            input: '',                                                    expected: 'skip' },
    { name: 'whitespace string',       input: '\n\t ',                                               expected: 'skip' },
    { name: 'plain text summary',      input: 'task complete, wrote 3 files',                        expected: 'complete' },
    { name: 'JSON status=completed',   input: JSON.stringify({ status: 'completed' }),               expected: 'complete' },
    { name: 'JSON status=complete',    input: JSON.stringify({ status: 'complete' }),                expected: 'complete' },
    { name: 'JSON status=success',     input: JSON.stringify({ status: 'success' }),                 expected: 'complete' },
    { name: 'JSON status=ok',          input: JSON.stringify({ status: 'ok' }),                      expected: 'complete' },
    { name: 'JSON status=FAILED (case-insensitive)', input: JSON.stringify({ status: 'FAILED' }),    expected: 'failed' },
    { name: 'JSON status=error',       input: JSON.stringify({ status: 'error' }),                   expected: 'failed' },
    { name: 'JSON status=errored',     input: JSON.stringify({ status: 'errored' }),                 expected: 'failed' },
    { name: 'JSON with error field',   input: JSON.stringify({ error: 'boom' }),                     expected: 'failed' },
    { name: 'JSON unknown status',     input: JSON.stringify({ status: 'weird-value' }),             expected: 'complete' },
    { name: 'pre-parsed object: completed', input: { status: 'completed' },                          expected: 'complete' },
    { name: 'pre-parsed object: failed', input: { status: 'failed' },                                expected: 'failed' },
    { name: 'invalid JSON string',     input: '{not really json',                                    expected: 'complete' },
    { name: 'number',                  input: 42,                                                    expected: 'complete' },
    { name: 'JSON with empty error',   input: JSON.stringify({ error: '' }),                         expected: 'complete' },
  ];
  for (const c of cases) {
    it(`classifies "${c.name}" → ${c.expected}`, () => {
      expect(classifyReplyContent(c.input)).toBe(c.expected);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// buildOutcomeFromReply — preserves reply text + lifts structured fields
// ─────────────────────────────────────────────────────────────────────
describe('buildOutcomeFromReply', () => {
  it('returns undefined for empty content', () => {
    expect(buildOutcomeFromReply(null)).toBeUndefined();
    expect(buildOutcomeFromReply(undefined)).toBeUndefined();
    expect(buildOutcomeFromReply('')).toBeUndefined();
    expect(buildOutcomeFromReply('  \n\t ')).toBeUndefined();
  });

  it('keeps a plain-text reply as the summary (fenced block intact)', () => {
    const text = 'Reviewed.\n```json\n{"verdict": "approved"}\n```';
    expect(buildOutcomeFromReply(text)).toEqual({ summary: text });
  });

  it('lifts fields from a JSON-string reply while preserving the raw text', () => {
    const reply = JSON.stringify({ review_verdict: { verdict: 'rejected' }, status: 'complete' });
    const outcome = buildOutcomeFromReply(reply);
    expect(outcome?.summary).toBe(reply);
    expect(outcome?.review_verdict).toEqual({ verdict: 'rejected' });
  });

  it('prefers an explicit summary field when the JSON reply carries one', () => {
    const reply = JSON.stringify({ summary: 'all good', status: 'ok' });
    expect(buildOutcomeFromReply(reply)?.summary).toBe('all good');
  });

  it('handles a pre-parsed object reply', () => {
    expect(buildOutcomeFromReply({ summary: 'done', error: '' })).toMatchObject({
      summary: 'done',
    });
    // No summary field → stringify the object so nothing is lost.
    expect(buildOutcomeFromReply({ status: 'ok' })?.summary).toBe('{"status":"ok"}');
  });
});
