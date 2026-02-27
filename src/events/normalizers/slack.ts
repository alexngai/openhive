/**
 * Slack Event Normalizer
 *
 * Converts Slack event payloads (forwarded via SwarmHub) into NormalizedEvents.
 * Message events populate `post` for the post pipeline.
 */

import type { NormalizedEvent } from '../types.js';

type RawPayload = Record<string, unknown>;

/**
 * Normalize a Slack event from the SwarmHub forwarding envelope.
 *
 * The payload arriving from SwarmHub has shape:
 * { team_id, event_type, event: { type, channel, user, text, ts, ... }, event_id }
 */
export function normalizeSlackEvent(
  eventType: string,
  deliveryId: string,
  payload: RawPayload,
): NormalizedEvent {
  const slackEvent = payload.event as RawPayload | undefined;

  const event: NormalizedEvent = {
    source: 'slack',
    event_type: eventType,
    delivery_id: deliveryId,
    timestamp: new Date().toISOString(),
    raw_payload: payload,
    metadata: {
      channel_id: slackEvent?.channel as string | undefined,
      sender: slackEvent?.user as string | undefined,
    },
  };

  // Message events can create posts
  if (slackEvent?.type === 'message' && slackEvent.text && !slackEvent.bot_id) {
    const text = slackEvent.text as string;
    const user = slackEvent.user as string || 'unknown';
    const channel = slackEvent.channel as string || 'unknown';

    event.post = {
      title: `[Slack #${channel}] Message from ${user}`,
      content: text,
    };
  }

  return event;
}
