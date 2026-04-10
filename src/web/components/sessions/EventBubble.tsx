/**
 * Re-export facade — event rendering has moved to components/events/.
 * This file preserves backward compatibility for existing imports.
 */
export { EventBubble, ToolCallBlock } from '../events/EventBubble';
export { formatTokens, extractText, truncate, groupConsecutiveCustomEvents } from '../events/event-utils';
