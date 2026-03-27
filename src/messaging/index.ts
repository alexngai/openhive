/**
 * Messaging Module
 *
 * Swarm-to-swarm direct messaging, extracted from the coordination module.
 */

export { MessagingService } from './service.js';
export type {
  SwarmMessage,
  CreateMessageInput,
  MessageSendParams,
} from './types.js';

// Singleton
import { MessagingService } from './service.js';

let instance: MessagingService | null = null;

export function initMessagingService(): MessagingService {
  if (!instance) {
    instance = new MessagingService();
  }
  return instance;
}

export function getMessagingService(): MessagingService {
  if (!instance) {
    instance = new MessagingService();
  }
  return instance;
}
