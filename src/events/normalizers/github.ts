/**
 * GitHub Event Normalizers
 *
 * Transform raw GitHub webhook payloads into NormalizedEvents.
 * Each normalizer decides whether to populate `post` (for the post pipeline)
 * or leave it undefined (MAP-only).
 */

import type { NormalizedEvent } from '../types.js';

type RawPayload = Record<string, unknown>;

/**
 * Normalize a raw GitHub webhook into a NormalizedEvent.
 */
export function normalizeGithubEvent(
  eventType: string,
  deliveryId: string,
  payload: RawPayload,
): NormalizedEvent {
  const action = payload.action as string | undefined;
  const qualifiedType = action ? `${eventType}.${action}` : eventType;

  const base: NormalizedEvent = {
    source: 'github',
    event_type: qualifiedType,
    action,
    delivery_id: deliveryId,
    timestamp: new Date().toISOString(),
    raw_payload: payload,
    metadata: extractMetadata(eventType, payload),
  };

  // Populate post data for events that should create posts
  switch (eventType) {
    case 'push':
      return normalizePush(base, payload);
    case 'pull_request':
      return normalizePullRequest(base, payload);
    case 'issues':
      return normalizeIssue(base, payload);
    default:
      return base;
  }
}

function extractMetadata(eventType: string, payload: RawPayload): NormalizedEvent['metadata'] {
  const repo = payload.repository as RawPayload | undefined;
  const sender = payload.sender as RawPayload | undefined;

  const metadata: NormalizedEvent['metadata'] = {};

  if (repo?.full_name) metadata.repo = repo.full_name as string;
  if (sender?.login) metadata.sender = sender.login as string;

  if (eventType === 'push') {
    const ref = payload.ref as string | undefined;
    if (ref?.startsWith('refs/heads/')) {
      metadata.branch = ref.replace('refs/heads/', '');
    }
  }

  if (eventType === 'pull_request') {
    const pr = payload.pull_request as RawPayload | undefined;
    const head = pr?.head as RawPayload | undefined;
    if (head?.ref) metadata.branch = head.ref as string;
  }

  return metadata;
}

function normalizePush(event: NormalizedEvent, payload: RawPayload): NormalizedEvent {
  const commits = payload.commits as RawPayload[] | undefined;
  if (!commits || commits.length === 0) return event;

  const repo = (payload.repository as RawPayload)?.full_name as string || 'unknown';
  const branch = event.metadata.branch || 'unknown';
  const count = commits.length;

  const commitLines = commits
    .slice(0, 5)
    .map((c) => `- \`${(c.id as string).slice(0, 7)}\` ${c.message as string}`)
    .join('\n');

  const more = count > 5 ? `\n- ... and ${count - 5} more` : '';

  event.post = {
    title: `[${repo}] ${count} commit(s) pushed to ${branch}`,
    content: `**${count} commit(s)** pushed to \`${branch}\`\n\n${commitLines}${more}`,
    url: payload.compare as string | undefined,
  };

  return event;
}

function normalizePullRequest(event: NormalizedEvent, payload: RawPayload): NormalizedEvent {
  const action = payload.action as string;
  if (!['opened', 'closed', 'reopened'].includes(action)) return event;

  const pr = payload.pull_request as RawPayload;
  const repo = (payload.repository as RawPayload)?.full_name as string || 'unknown';
  const number = pr.number as number;
  const title = pr.title as string;
  const merged = pr.merged as boolean;

  const verb = action === 'closed' && merged ? 'merged' : action;

  event.post = {
    title: `[${repo}] PR #${number} ${verb}: ${title}`,
    content: (pr.body as string) || `Pull request #${number} was ${verb}.`,
    url: pr.html_url as string | undefined,
  };

  return event;
}

function normalizeIssue(event: NormalizedEvent, payload: RawPayload): NormalizedEvent {
  const action = payload.action as string;
  if (!['opened', 'closed', 'reopened'].includes(action)) return event;

  const issue = payload.issue as RawPayload;
  const repo = (payload.repository as RawPayload)?.full_name as string || 'unknown';
  const number = issue.number as number;
  const title = issue.title as string;

  event.post = {
    title: `[${repo}] Issue #${number} ${action}: ${title}`,
    content: (issue.body as string) || `Issue #${number} was ${action}.`,
    url: issue.html_url as string | undefined,
  };

  return event;
}
