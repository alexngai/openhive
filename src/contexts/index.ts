/**
 * Contexts Module
 *
 * Ephemeral shared contexts between swarms, extracted from the coordination module.
 */

export { ContextsService } from './service.js';
export type {
  SharedContext,
  CreateContextInput,
  ContextShareParams,
} from './types.js';

// Singleton
import { ContextsService } from './service.js';

let instance: ContextsService | null = null;

export function initContextsService(): ContextsService {
  if (!instance) {
    instance = new ContextsService();
  }
  return instance;
}

export function getContextsService(): ContextsService {
  if (!instance) {
    instance = new ContextsService();
  }
  return instance;
}
