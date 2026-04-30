/**
 * Built-in context-type registrations.
 *
 * Importing this module (even for side-effects) triggers registration of
 * every built-in type. Keep this as the single entry point so consumers
 * don't have to import each type file individually.
 */

import './spec';
import './tasks';
import './dispatch';
import './stream';
import './task';
import './swarm';
import './session';
import './conversation';

export { specContextItem, type SpecData } from './spec';
export { tasksContextItem, type TaskRef, type TasksData } from './tasks';
export {
  dispatchContextItem,
  type DispatchData,
  type DispatchAttemptRef,
} from './dispatch';
export { streamContextItem, type StreamData } from './stream';
export { taskContextItem, type TaskData } from './task';
export { swarmContextItem, type SwarmData } from './swarm';
export { sessionContextItem, type SessionData } from './session';
export {
  conversationContextItem,
  type ConversationData,
  type ConversationTurnRef,
} from './conversation';
