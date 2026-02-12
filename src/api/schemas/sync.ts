import { z } from 'zod';

export const CreateSyncGroupSchema = z.object({
  hive_name: z.string().min(1),
});

export const HandshakeSchema = z.object({
  sync_group_name: z.string().min(1),
  instance_id: z.string().min(1),
  signing_key: z.string().min(1),
  sync_endpoint: z.string().min(1),
});

export const PushEventsSchema = z.object({
  events: z.array(z.object({
    id: z.string(),
    event_type: z.string(),
    origin_instance_id: z.string(),
    origin_ts: z.number(),
    payload: z.string(),
    signature: z.string(),
  })),
  sender_seq: z.number(),
});

export const PullEventsQuerySchema = z.object({
  since: z.coerce.number().default(0),
  limit: z.coerce.number().default(100).pipe(z.number().max(1000)),
});

export const CreatePeerConfigSchema = z.object({
  name: z.string().min(1),
  sync_endpoint: z.string().min(1),
  shared_hives: z.array(z.string().min(1)).min(1),
});

export const UpdatePeerConfigSchema = z.object({
  name: z.string().min(1).optional(),
  sync_endpoint: z.string().min(1).optional(),
  shared_hives: z.array(z.string().min(1)).min(1).optional(),
});

export const HeartbeatSchema = z.object({
  instance_id: z.string().min(1),
  seq_by_hive: z.record(z.string(), z.number()),
  known_peers: z.array(z.object({
    sync_endpoint: z.string(),
    name: z.string(),
    shared_hives: z.array(z.string()),
    signing_key: z.string().nullable(),
    ttl: z.number(),
  })).optional(),
});
