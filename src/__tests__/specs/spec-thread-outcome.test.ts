/**
 * P3.5 — dispatch terminal outcomes → spec-thread system turns.
 *
 * Unit-tests the `postSpecThreadOutcome` factory helper against a real
 * in-memory agent-inbox module:
 *   - existing thread → exactly one system turn is posted
 *   - no thread → no turn, no conversation created (stays silent)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { initMail, getMailJsonRpc, getMailStorage } from '../../mail/index.js';
import {
  ensureSpecConversation,
  postSpecThreadOutcome,
  specThreadConversationId,
  SPEC_THREAD_SYSTEM_AUTHOR,
} from '../../specs/spec-conversation.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('spec-thread-outcome');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'spec-thread-outcome.db');

const deps = { getMailJsonRpc, getMailStorage };

describe('postSpecThreadOutcome', () => {
  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    await initMail();
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('does nothing when no discussion thread exists', async () => {
    const posted = await postSpecThreadOutcome(
      { resourceId: 'res-x', specId: 's-none', dispatchId: 'd-1', outcome: 'complete' },
      deps,
    );
    expect(posted).toBe(false);
    // No conversation was created as a side effect.
    expect(getMailStorage().getConversation(specThreadConversationId('res-x', 's-none'))).toBeUndefined();
  });

  it('posts exactly one system turn when the thread exists', async () => {
    const convId = await ensureSpecConversation(
      { resourceId: 'res-y', specId: 's-aaa', specTitle: 'Auth', initiatorAgentId: 'human-1' },
      deps,
    );

    const posted = await postSpecThreadOutcome(
      {
        resourceId: 'res-y',
        specId: 's-aaa',
        dispatchId: 'd-42',
        outcome: 'complete',
        swarmName: 'alpha',
        detail: 'All tests green',
      },
      deps,
    );
    expect(posted).toBe(true);

    const turns = getMailStorage().getTurns(convId);
    expect(turns).toHaveLength(1);
    const turn = turns[0];
    expect(turn.participant_id).toBe(SPEC_THREAD_SYSTEM_AUTHOR);
    const text =
      typeof turn.content === 'string'
        ? turn.content
        : (turn.content as { text?: string })?.text ?? '';
    expect(text).toContain('alpha');
    expect(text).toContain('completed');
    expect(text).toContain('All tests green');
    expect(text).toContain('/dispatch/d-42');
  });

  it('narrates a reviewer-role dispatch as a validation verdict (P5.4)', async () => {
    const convId = await ensureSpecConversation(
      { resourceId: 'res-v', specId: 's-val', specTitle: 'Rate limiting' },
      deps,
    );
    const posted = await postSpecThreadOutcome(
      {
        resourceId: 'res-v',
        specId: 's-val',
        dispatchId: 'd-val',
        outcome: 'complete',
        swarmName: 'reviewer-swarm',
        detail: 'APPROVED — meets acceptance criteria',
        kind: 'validation',
      },
      deps,
    );
    expect(posted).toBe(true);
    const turns = getMailStorage().getTurns(convId);
    const turn = turns[turns.length - 1];
    const text =
      typeof turn.content === 'string'
        ? turn.content
        : (turn.content as { text?: string })?.text ?? '';
    expect(text).toContain('Validation by reviewer-swarm completed');
    expect(text).toContain('APPROVED');
    expect(text).not.toContain('Dispatch to reviewer-swarm');
  });

  it('narrates failures with the error detail', async () => {
    const convId = await ensureSpecConversation(
      { resourceId: 'res-z', specId: 's-bbb', specTitle: 'Search' },
      deps,
    );
    const posted = await postSpecThreadOutcome(
      {
        resourceId: 'res-z',
        specId: 's-bbb',
        dispatchId: 'd-99',
        outcome: 'failed',
        swarmName: 'beta',
        detail: 'boom',
      },
      deps,
    );
    expect(posted).toBe(true);
    const turns = getMailStorage().getTurns(convId);
    const text =
      typeof turns[0].content === 'string'
        ? turns[0].content
        : (turns[0].content as { text?: string })?.text ?? '';
    expect(text).toContain('failed');
    expect(text).toContain('boom');
  });
});
