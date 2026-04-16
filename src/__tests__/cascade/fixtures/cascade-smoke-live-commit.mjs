#!/usr/bin/env node
// One-shot: fire a single additional stream.committed event at the hub
// (bypassing the git ops from the first run) to test WS realtime invalidation
// on the open TaskDetail page.

import WebSocket from 'ws';

const HUB = process.env.HUB_URL ?? 'http://localhost:3000';
const WS_URL = HUB.replace(/^http/, 'ws') + '/ws/map';
const INGEST_KEY = process.env.INGEST_KEY;
const TASK_RESOURCE_ID = process.env.TASK_RESOURCE_ID;
const TASK_NODE_ID = process.env.TASK_NODE_ID ?? 'task-smoke-rt-1';
const SWARM_ID = process.env.SWARM_ID ?? `smoke-live-${Date.now()}`;
const STREAM_ID = process.env.STREAM_ID ?? '469b50ad';

if (!INGEST_KEY || !TASK_RESOURCE_ID) throw new Error('INGEST_KEY + TASK_RESOURCE_ID required');

const ws = new WebSocket(`${WS_URL}?token=${INGEST_KEY}&swarm_id=${SWARM_ID}`);
let id = 0;
const pending = new Map();

ws.on('message', (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.method === 'ping') ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong', params: {} }));
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
});

const rpc = (method, params) => new Promise((resolve, reject) => {
  const rid = ++id;
  pending.set(rid, { resolve, reject });
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }));
});

await new Promise((r, rj) => { ws.once('open', r); ws.once('error', rj); });
await new Promise((r) => setTimeout(r, 200));

await rpc('map/agents/register', {
  name: 'cascade-live-worker',
  role: 'worker',
  capabilities: {},
});

const commit = 'live' + Date.now().toString(16).padStart(12, '0');
const res = await rpc('x-cascade/stream.committed', {
  stream_id: STREAM_ID,
  commit_hash: commit,
  change_id: `c-live${Date.now().toString(16).slice(-6)}`,
  agent_id: 'smoke-agent',
  message_summary: 'feat: live realtime probe',
  files_touched: ['realtime.ts'],
  metadata: {
    task_ref: { resource_id: TASK_RESOURCE_ID, node_id: TASK_NODE_ID },
  },
});
console.log('live commit acknowledged:', res);

ws.close();
process.exit(0);
