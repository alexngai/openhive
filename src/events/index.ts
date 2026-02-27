/**
 * Event Routing System
 *
 * Re-exports the main API surface for event routing.
 */

export { routeEvent } from './router.js';
export { normalize } from './normalizers/index.js';
export type {
  NormalizedEvent,
  PostRule,
  EventSubscription,
  EventFilters,
  EventDeliveryLog,
  RouteResult,
  MapWebhookEventMessage,
} from './types.js';
