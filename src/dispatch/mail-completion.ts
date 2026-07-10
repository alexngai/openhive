/**
 * Mail-route dispatch completion observer.
 *
 * Gap this closes: swarm-dispatch's `MessagePort` contract has no
 * `onResult`/reply observation — only `onIncoming` for inbound NEW work.
 * For mail-route dispatches, the orchestrator dispatches via `deliver()`
 * and has no built-in way to learn when the agent has replied. Without
 * intervention, every mail-route dispatch sits at `running` until the
 * stall-timeout (~5 min) fires `dead` → `failed`. No mail-route dispatch
 * ever reaches `complete`.
 *
 * The fix is hub-side: subscribe to `mail.turn.added` events; for any
 * turn whose conversation_id matches an in-flight (`queued|running`)
 * dispatch and whose participant is NOT the dispatcher, mark that
 * dispatch `complete` via `finalizeDispatch`. The orchestrator's
 * reconcile loop will then observe `isStillActive=false` on the next
 * cycle, clean up its in-memory tracking, and (because the bridge's
 * guards skip already-terminal rows) leave the status alone.
 *
 * This is a hub-only change — no swarm-dispatch contract or library
 * publish required.
 */

import { findRunningDispatchByConversation } from '../db/dal/dispatches.js';
import type { DispatchOutcome } from '../db/dal/dispatches.js';
import { finalizeDispatch } from './finalize.js';
import { DISPATCHER_PARTICIPANT_ID } from './mail-transport.js';

interface MailTurnEventLike {
  conversation_id?: unknown;
  participant_id?: unknown;
  content?: unknown;
  content_type?: unknown;
}

export interface MailEventsLike {
  on(event: 'mail.turn.added', handler: (turn: unknown) => void): void;
  off(event: 'mail.turn.added', handler: (turn: unknown) => void): void;
}

export interface SetupMailCompletionOptions {
  getMailEvents: () => MailEventsLike;
  /**
   * Logger hook. Tests inject to capture observed completions. Defaults to
   * a one-line console.log so production has cheap, greppable observability.
   */
  log?: (msg: string) => void;
}

/**
 * Wire the mail-completion observer. Returns an unsubscribe function;
 * call on server shutdown.
 */
export function setupMailCompletionObserver(
  opts: SetupMailCompletionOptions,
): () => void {
  const log =
    opts.log ??
    ((msg: string) => {
      console.log(`[mail-completion] ${msg}`);
    });

  const onTurn = (turn: unknown): void => {
    if (!turn || typeof turn !== 'object') return;
    const t = turn as MailTurnEventLike;
    const conversationId =
      typeof t.conversation_id === 'string' ? t.conversation_id : null;
    const participantId =
      typeof t.participant_id === 'string' ? t.participant_id : null;
    if (!conversationId || !participantId) return;

    // Filter: only consider reply turns (participant != dispatcher).
    // The outbound dispatch envelope is posted by the dispatcher and
    // would otherwise self-trigger this observer.
    if (participantId === DISPATCHER_PARTICIPANT_ID) return;

    let dispatch;
    try {
      dispatch = findRunningDispatchByConversation(conversationId);
    } catch {
      // DB read failure shouldn't crash the listener loop.
      return;
    }
    if (!dispatch) return;

    // Decide complete-vs-failed by inspecting the reply content.
    //
    // The macro-agent mail-inbound consumer posts the worker's done()
    // summary directly as the turn content (see references/macro-agent/
    // src/dispatch/mail-inbound-consumer.ts:514). Three common shapes:
    //   - Plain text summary — the worker ran the prompt and called
    //     done(). Treat as success.
    //   - JSON envelope with `status: 'failed' | 'error'` — explicit
    //     failure signal (or a future structured-reply contract).
    //     Treat as failure.
    //   - Empty / whitespace-only — the worker stopped without producing
    //     a summary. Conservative: treat as failure rather than spurious
    //     success.
    //
    // A duplicate reply (same agent posts twice) is harmless because
    // finalizeDispatch is idempotent.
    const terminal = classifyReplyContent(t.content);
    if (terminal === 'skip') return;

    // Thread the reply content into the dispatch outcome. Classification
    // alone (complete/failed) is not enough: downstream consumers need the
    // actual summary — e.g. the review-verdict hook in finalizeDispatch
    // parses a fenced ```json verdict block out of `outcome.summary`, and a
    // structured reply may carry `review_verdict` directly. Without this the
    // mail path always produced a null outcome, so agent verdicts never
    // landed (QC station Q3).
    const outcome = buildOutcomeFromReply(t.content);

    try {
      finalizeDispatch(dispatch.id, terminal, outcome);
      log(
        `dispatch ${dispatch.id} marked ${terminal} from mail reply ` +
          `(conv=${conversationId}, from=${participantId})`,
      );
    } catch (err) {
      log(
        `failed to mark dispatch ${dispatch.id} ${terminal}: ` +
          `${(err as Error).message}`,
      );
    }
  };

  opts.getMailEvents().on('mail.turn.added', onTurn);
  return () => {
    try {
      opts.getMailEvents().off('mail.turn.added', onTurn);
    } catch {
      /* best-effort */
    }
  };
}

/**
 * Build a `DispatchOutcome` from the reply turn content so the terminal
 * dispatch row carries the agent's actual reply, not just a status.
 *
 * The raw text is ALWAYS preserved as `summary` (free-text replies carry
 * fenced ```json verdict blocks there); when the reply is itself a JSON
 * object, its fields are lifted onto the outcome too so a structured reply
 * carrying `review_verdict` (or `summary`/`error`) is read via the
 * structured path. Returns undefined for empty content so finalizeDispatch
 * falls back to a cascade-artifacts-only outcome (or null).
 *
 * Exported for unit testing in isolation.
 */
export function buildOutcomeFromReply(content: unknown): DispatchOutcome | undefined {
  if (content == null) return undefined;

  if (typeof content === 'string') {
    const text = content.trim();
    if (text.length === 0) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object') {
      // Structured reply delivered as a JSON string: keep the raw text as
      // summary AND lift its fields (a `summary` field, if present, wins).
      return { summary: text, ...(parsed as Record<string, unknown>) };
    }
    return { summary: text };
  }

  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    const summary = typeof obj.summary === 'string' ? obj.summary : JSON.stringify(obj);
    return { summary, ...obj };
  }

  return { summary: String(content) };
}

/**
 * Classify the turn content as a success, failure, or no-signal reply.
 * Exported for unit testing the classification rules in isolation.
 */
export function classifyReplyContent(
  content: unknown,
): 'complete' | 'failed' | 'skip' {
  if (content == null) return 'skip';

  // Plain text shape — the agent's done() summary verbatim.
  if (typeof content === 'string') {
    if (content.trim().length === 0) return 'skip';
    // Try to interpret as JSON first (consumers MAY upgrade to structured
    // replies later); otherwise treat as a free-text success summary.
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return 'complete';
    }
    return classifyParsedReply(parsed);
  }

  // Structured shape — content already parsed (some transports parse
  // application/json automatically).
  if (typeof content === 'object') {
    return classifyParsedReply(content);
  }

  // Anything else (number, boolean) — treat as success summary.
  return 'complete';
}

function classifyParsedReply(parsed: unknown): 'complete' | 'failed' | 'skip' {
  if (!parsed || typeof parsed !== 'object') return 'complete';
  const obj = parsed as Record<string, unknown>;
  const status = obj.status;
  if (typeof status === 'string') {
    const s = status.toLowerCase();
    if (s === 'failed' || s === 'error' || s === 'errored') return 'failed';
    if (s === 'completed' || s === 'complete' || s === 'success' || s === 'ok')
      return 'complete';
  }
  if (typeof obj.error === 'string' && obj.error.length > 0) return 'failed';
  // Structured but no failure markers — treat as success summary.
  return 'complete';
}
