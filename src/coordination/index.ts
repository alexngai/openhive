/**
 * Coordination Module
 *
 * Inter-swarm coordination: task delegation, context sharing, and messaging.
 */

export { CoordinationService } from './service.js';
export type {
  CoordinationTask,
  SwarmMessage,
  SharedContext,
  CreateTaskInput,
  UpdateTaskInput,
  CreateMessageInput,
  CreateContextInput,
  MapCoordinationMethod,
  MapCoordinationParams,
  MapCoordinationMessage,
} from './types.js';
export { createCoordinationNotification } from './types.js';
export { COORDINATION_SCHEMA } from './schema.js';

// ============================================================================
// Singleton
// ============================================================================

import { CoordinationService } from './service.js';

let instance: CoordinationService | null = null;

export function initCoordinationService(): CoordinationService {
  if (!instance) {
    instance = new CoordinationService();
  }
  return instance;
}

export function getCoordinationService(): CoordinationService {
  if (!instance) {
    throw new Error('CoordinationService not initialized — call initCoordinationService() first');
  }
  return instance;
}
