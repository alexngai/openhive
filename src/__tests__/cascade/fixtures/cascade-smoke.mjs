#!/usr/bin/env node
// Cascade smoke script: drives a real macro-agent GitCascadeAdapter + CascadeBridge
// against a live OpenHive hub over a real MAP WebSocket.
//
// Usage:
//   HUB_URL=http://localhost:3000 \
//   INGEST_KEY=ohk_... \
//   TASK_RESOURCE_ID=res_... \
//   node src/__tests__/cascade/fixtures/cascade-smoke.mjs
//
// What it does:
//   1. Opens ws://HUB/ws/map?token=INGEST_KEY&swarm_id=<smoke-swarm>
//   2. Waits for hub/welcome and registers a worker agent via map/agents/register
//   3. Spins up GitCascadeAdapter on a fresh temp git repo
//   4. Subscribes createCascadeBridge to forward x-cascade/* via the WS as
//      JSON-RPC requests (real wire format, not a mock)
//   5. Runs: createStream → commit → commit → abandon
//   6. Prints the TaskDetail URL so you can verify CascadeBlock populates

import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import WebSocket from 'ws';
import { GitCascadeAdapter } from 'macro-agent/dist/workspace/git-cascade-adapter.js';
import { createCascadeBridge } from 'macro-agent/dist/map/cascade-bridge.js';

const HUB = process.env.HUB_URL ?? 'http://localhost:3000';
const WS_URL = HUB.replace(/^http/, 'ws') + '/ws/map';
const INGEST_KEY = process.env.INGEST_KEY;
const TASK_RESOURCE_ID = process.env.TASK_RESOURCE_ID;
const TASK_NODE_ID = process.env.TASK_NODE_ID ?? 'task-smoke-rt-1';
const SWARM_ID = process.env.SWARM_ID ?? `smoke-swarm-${Date.now()}`;

if (!INGEST_KEY) throw new Error('INGEST_KEY env required');
if (!TASK_RESOURCE_ID) throw new Error('TASK_RESOURCE_ID env required');

const url = `${WS_URL}?token=${encodeURIComponent(INGEST_KEY)}&swarm_id=${encodeURIComponent(SWARM_ID)}`;
console.log(`[smoke] connecting to ${url}`);

const ws = new WebSocket(url);

let rpcId = 0;
const pending = new Map();

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.method === 'ping') {
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong', params: {} }));
    return;
  }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(Object.assign(new Error(msg.error.message ?? 'RPC error'), { code: msg.error.code }));
    else resolve(msg.result);
  }
});

ws.on('error', (e) => console.error('[smoke] ws error:', e.message));

function rpc(method, params = {}) {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 10_000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── LifecycleBridgeConnection adapter ────────────────────────────────────────
// The cascade bridge only needs `callExtension` + `isConnected`. All hub
// routing happens inside OpenHive's MAP server — we just speak JSON-RPC.
const connection = {
  get isConnected() { return ws.readyState === WebSocket.OPEN; },
  async callExtension(method, params) {
    return rpc(method, params ?? {});
  },
};

await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

// Wait for hub/welcome (delivered as a server-initiated notification).
await sleep(200);

// Register the agent so the hub knows who's talking.
console.log(`[smoke] registering agent on swarm ${SWARM_ID}`);
const reg = await rpc('map/agents/register', {
  name: 'cascade-smoke-worker',
  role: 'worker',
  capabilities: {},
  metadata: { project: 'openhive', run: 'cascade-smoke' },
});
console.log(`[smoke] registered: ${reg.agent.id}`);

// ── Build a fresh git repo for the adapter ──────────────────────────────────
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-smoke-'));
execSync('git init -q', { cwd: repo });
execSync('git config user.email smoke@test', { cwd: repo });
execSync('git config user.name Smoke', { cwd: repo });
fs.writeFileSync(path.join(repo, 'README.md'), '# smoke\n');
execSync('git add .', { cwd: repo });
execSync('git commit -q -m init', { cwd: repo });
fs.mkdirSync(path.join(repo, '.git-cascade'), { recursive: true });
console.log(`[smoke] repo ready: ${repo}`);

const adapter = new GitCascadeAdapter({ repoPath: repo, tablePrefix: 'smoke_' });
const bridge = createCascadeBridge(connection, adapter, { verbose: true });

// ── Drive the scenario ──────────────────────────────────────────────────────
const taskRef = { resource_id: TASK_RESOURCE_ID, node_id: TASK_NODE_ID };

const streamId = adapter.createStream({
  name: 'smoke-feature',
  agentId: 'smoke-agent',
  metadata: { task_ref: taskRef },
});
console.log(`[smoke] stream created: ${streamId}`);
await sleep(300); // let the bridge forward stream.opened

// Make a worktree and commit twice.
const wt = path.join(os.tmpdir(), `smoke-wt-${Date.now()}`);
execSync(`git worktree add -q "${wt}" stream/${streamId}`, { cwd: repo });

for (let i = 1; i <= 3; i++) {
  fs.writeFileSync(path.join(wt, `file${i}.txt`), `content ${i}\n`);
  execSync('git add .', { cwd: wt });
  const res = adapter.commitChanges({
    streamId,
    agentId: 'smoke-agent',
    worktree: wt,
    message: `feat: smoke change ${i}`,
    metadata: { task_ref: taskRef },
  });
  console.log(`[smoke] commit ${i}: ${res.commit.slice(0, 8)}`);
  await sleep(200);
}

// Surface a pending conflict for the UI to render.
adapter.createConflict({
  streamId,
  conflictingCommit: 'aaaa1111bbbb2222',
  targetCommit: 'cccc3333dddd4444',
  conflictedFiles: ['file1.txt'],
});
await sleep(200);

console.log(`[smoke] done. UI:`);
console.log(`  http://localhost:5174/tasks/${TASK_RESOURCE_ID}/${TASK_NODE_ID}`);

// Keep process alive briefly so late broadcasts flush, then exit.
await sleep(500);
bridge.dispose();
adapter.close?.();
ws.close();
process.exit(0);
