/**
 * Normalizer Registry
 *
 * Maps (source, event_type) to normalizer functions.
 * Supports runtime registration for future sources.
 */

import type { NormalizedEvent } from '../types.js';
import { normalizeGithubEvent } from './github.js';
import { normalizeSlackEvent } from './slack.js';

type NormalizerFn = (
  eventType: string,
  deliveryId: string,
  payload: Record<string, unknown>,
) => NormalizedEvent;

const normalizers = new Map<string, NormalizerFn>();

// Register built-in normalizers
normalizers.set('github', normalizeGithubEvent);
normalizers.set('slack', normalizeSlackEvent);

/**
 * Get the normalizer for a given source.
 */
export function getNormalizer(source: string): NormalizerFn | undefined {
  return normalizers.get(source);
}

/**
 * Register a normalizer for a source (for runtime extension).
 */
export function registerNormalizer(source: string, fn: NormalizerFn): void {
  normalizers.set(source, fn);
}

/**
 * Normalize an event using the registered normalizer for its source.
 * Falls back to a passthrough normalizer if no source-specific one is found.
 */
export function normalize(
  source: string,
  eventType: string,
  deliveryId: string,
  payload: Record<string, unknown>,
): NormalizedEvent {
  const normalizer = normalizers.get(source);
  if (normalizer) {
    return normalizer(eventType, deliveryId, payload);
  }

  // Passthrough for unknown sources
  return {
    source,
    event_type: eventType,
    delivery_id: deliveryId,
    timestamp: new Date().toISOString(),
    raw_payload: payload,
    metadata: {},
  };
}
