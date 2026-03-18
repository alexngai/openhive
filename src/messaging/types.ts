/**
 * Messaging Types
 *
 * Domain models and input types for swarm-to-swarm direct messaging.
 * Extracted from src/coordination/types.ts as a standalone module.
 */

export interface SwarmMessage {
  id: string;
  hive_id: string | null;
  from_swarm_id: string;
  to_swarm_id: string | null;
  content_type: 'text' | 'json' | 'binary_ref';
  content: string;
  reply_to: string | null;
  metadata: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

export interface CreateMessageInput {
  hive_id?: string;
  from_swarm_id: string;
  to_swarm_id: string;
  content_type?: 'text' | 'json' | 'binary_ref';
  content: string;
  reply_to?: string;
  metadata?: Record<string, unknown>;
  /** Cross-instance origin tracking (set by materializer) */
  origin_instance_id?: string;
  origin_message_id?: string;
}

/** Wire format for x-openhive/message.send JSON-RPC notification */
export interface MessageSendParams {
  message_id: string;
  from_swarm_id: string;
  to_swarm_id: string;
  hive_id?: string;
  content_type: 'text' | 'json' | 'binary_ref';
  content: unknown;
  reply_to?: string;
  metadata?: Record<string, unknown>;
}
