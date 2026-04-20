/**
 * GitHub Event Normalizers
 *
 * Transform raw GitHub webhook payloads into NormalizedEvents. Post-shaping
 * (populating event.post for the old hive-post pipeline) was dropped with
 * the social layer; normalizers now only extract metadata used for
 * subscription filtering (repo, branch, sender).
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

  return {
    source: 'github',
    event_type: qualifiedType,
    action,
    delivery_id: deliveryId,
    timestamp: new Date().toISOString(),
    raw_payload: payload,
    metadata: extractMetadata(eventType, payload),
  };
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
