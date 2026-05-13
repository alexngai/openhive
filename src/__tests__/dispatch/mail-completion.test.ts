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
import { setupMailCompletionObserver, classifyReplyContent } from '../../dispatch/mail-completion.js';
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
