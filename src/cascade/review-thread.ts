/**
 * Verdict → thread turn (the review-flow feedback link, design §11
 * discussion 2026-07-09).
 *
 * A recorded verdict is only useful if the author hears about it. This
 * module posts every verdict as a `system:dispatch-orchestrator` turn into
 * the conversation the author already lives in, resolved from the stream's
 * task binding:
 *
 *   1. the linked dispatch's coordination thread (`conversation_id`) —
 *      reaches the author agent directly over the mail fabric;
 *   2. else the spec's discussion thread — only when one already exists
 *      (same never-create rule as `postSpecThreadOutcome`).
 *
 * No thread resolvable → stay silent. Best-effort everywhere: a failed
 * narrative turn must never break verdict recording.
 */

import type { MailJsonRpcServer } from 'agent-inbox';
import { listDispatches } from '../db/dal/dispatches.js';
import type { CascadeStream } from '../db/dal/cascade-streams.js';
import type { CascadeReviewVerdict } from '../db/dal/cascade-review-verdicts.js';
import {
  specThreadConversationId,
  SPEC_THREAD_SYSTEM_AUTHOR,
} from '../specs/spec-conversation.js';

const VERDICT_LABEL: Record<CascadeReviewVerdict['verdict'], string> = {
  approved: 'APPROVED',
  changes_requested: 'CHANGES REQUESTED',
  rejected: 'REJECTED',
};

/**
 * Post a verdict turn into the stream's work thread. Returns true when a
 * turn was posted, false when no thread was resolvable (or posting failed).
 * Never throws.
 */
export async function postVerdictThreadTurn(
  verdict: CascadeReviewVerdict,
  stream: Pick<CascadeStream, 'id' | 'name' | 'task_resource_id' | 'task_node_id'>,
): Promise<boolean> {
  try {
    if (!stream.task_resource_id) return false; // unbound stream — no work thread

    const { getMailJsonRpc, getMailStorage } = await import('../mail/index.js');
    const jsonRpc = getMailJsonRpc();

    const conversationId = resolveConversationId(stream, (id) =>
      Boolean(getMailStorage().getConversation(id)),
    );
    if (!conversationId) return false;

    const who =
      verdict.reviewer_kind === 'human'
        ? `by ${verdict.reviewer_id ?? 'operator'}`
        : `by reviewer agent ${verdict.reviewer_id ?? '(unknown)'} (advisory)`;
    const parts = [
      `Review verdict on "${stream.name}": ${VERDICT_LABEL[verdict.verdict]} ${who}.`,
    ];
    if (verdict.notes) parts.push(verdict.notes);
    parts.push(`See /changes?stream=${verdict.stream_row_id}`);

    await invokeMailTurn(jsonRpc, {
      conversationId,
      participantId: SPEC_THREAD_SYSTEM_AUTHOR,
      content: parts.join(' '),
      contentType: 'text',
      importance: verdict.verdict === 'approved' ? 'normal' : 'high',
      metadata: {
        system: true,
        kind: 'review_verdict',
        verdict: verdict.verdict,
        reviewer_kind: verdict.reviewer_kind,
        stream_row_id: verdict.stream_row_id,
        head_commit: verdict.head_commit,
        verdict_id: verdict.id,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stream → conversation, via the dispatches linked to the stream's task.
 * Prefers a dispatch coordination thread (author-reachable); falls back to
 * the spec discussion thread when one already exists.
 */
function resolveConversationId(
  stream: Pick<CascadeStream, 'task_resource_id' | 'task_node_id'>,
  conversationExists: (id: string) => boolean,
): string | null {
  const { data: dispatches } = listDispatches({
    task_resource_id: stream.task_resource_id!,
    task_node_id: stream.task_node_id ?? undefined,
    limit: 10,
  });

  for (const d of dispatches) {
    if (d.conversation_id && conversationExists(d.conversation_id)) {
      return d.conversation_id;
    }
  }

  for (const d of dispatches) {
    if (d.spec_resource_id && d.spec_id && d.spec_resource_id !== 'ad_hoc') {
      const specConv = specThreadConversationId(d.spec_resource_id, d.spec_id);
      if (conversationExists(specConv)) return specConv;
    }
  }

  return null;
}

async function invokeMailTurn(
  jsonRpc: MailJsonRpcServer,
  params: Record<string, unknown>,
): Promise<void> {
  const id = `review-verdict-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await jsonRpc.handleRequest({
    jsonrpc: '2.0',
    id,
    method: 'mail/turn',
    params,
  } as Parameters<MailJsonRpcServer['handleRequest']>[0]);
  if (response && typeof response === 'object' && 'error' in response && response.error) {
    const err = response.error as { message?: string };
    throw new Error(err.message ?? 'mail/turn failed');
  }
}
