// Browser-E2E seed script: populates a running OpenHive dev DB with
// realistic cascade projections so the TaskDetail page + CascadeBlock
// component have data to render.
//
// Not a vitest test — this is a developer/CI helper invoked manually:
//
//   # 1. Make sure the dev API + Vite are running (npm run dev / dev:web)
//   # 2. Point at the API's DB and run:
//   OPENHIVE_DB=./.openhive/data/openhive.db \
//     node src/__tests__/cascade/fixtures/cascade-seed.mjs
//   # 3. Open the printed URL in a browser to see the rendered changelog
//
// It calls the public API for the syncable_resource (so it goes through
// validation) but writes cascade projection rows directly with better-sqlite3
// since cascade events normally arrive via MAP and we don't want to spin up
// a sidecar in this dev-time helper. For a programmatic E2E that does
// exercise the real handler chain, see live-emission-e2e.test.ts in the
// same directory.

const API = 'http://localhost:3000/api/v1';
const RESOURCE_NAME = 'cascade-e2e-tasks';
const NODE_ID = 't-cascade-e2e';

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return parsed;
}

// 1. Find or create the task resource.
const list = await api('GET', `/resources?type=task`);
let resource = (list.data ?? []).find((r) => r.name === RESOURCE_NAME);
if (!resource) {
  resource = await api('POST', '/resources', {
    name: RESOURCE_NAME,
    resource_type: 'task',
    git_remote_url: `local://cascade-e2e/${Date.now()}`,
    sync_strategy: 'metadata',
    visibility: 'private',
    metadata: { opentasks: true },
  });
}
console.log('resource:', resource.id, resource.name);

// 2. Drop cascade events through the MAP cascade handler — but the handler
// expects to be called with a swarm context. We don't have a swarm. So
// we'll write straight to the cascade DAL via a separate script that loads
// the openhive db module. That requires running inside the openhive repo
// with NODE_PATH pointing at it, which is fiddly. Instead: open the SQLite
// database directly with better-sqlite3.

import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import path from 'path';
import os from 'os';

const dbPath = process.env.OPENHIVE_DB ??
  path.join(os.homedir(), '.openhive', 'openhive.db');
const db = new Database(dbPath);

const SWARM_ID = 'swarm-cascade-e2e';
const STREAM_ID = 'stream-e2e-1';

// Create stream row (idempotent on UNIQUE (source_swarm_id, stream_id))
const existingStream = db.prepare(
  `SELECT id FROM cascade_streams WHERE source_swarm_id = ? AND stream_id = ?`
).get(SWARM_ID, STREAM_ID);
let streamRowId;
if (existingStream) {
  streamRowId = existingStream.id;
  console.log('stream row exists:', streamRowId);
} else {
  streamRowId = nanoid();
  db.prepare(`
    INSERT INTO cascade_streams
      (id, stream_id, source_swarm_id, source_agent_id, name, branch_name,
       base_commit, status, is_local_mode, task_resource_id, task_node_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?)
  `).run(
    streamRowId, STREAM_ID, SWARM_ID, 'agent-alpha', 'feature/oauth',
    `stream/${STREAM_ID}`, '0000000000000000000000000000000000000000',
    resource.id, NODE_ID,
    JSON.stringify({ task_ref: { resource_id: resource.id, node_id: NODE_ID } })
  );
  console.log('stream row created:', streamRowId);
}

// Add 3 commits with task_ref
const commits = [
  { hash: 'a1b2c3d4e5f60001', msg: 'feat: scaffold OAuth endpoints', files: ['src/auth/oauth.ts', 'src/auth/types.ts'] },
  { hash: 'a1b2c3d4e5f60002', msg: 'test: OAuth callback edge cases', files: ['test/auth/oauth.test.ts'] },
  { hash: 'a1b2c3d4e5f60003', msg: 'docs: OAuth flow + threat model', files: ['docs/auth.md', 'src/auth/oauth.ts'] },
];
let parent = '0000000000000000000000000000000000000000';
for (const c of commits) {
  const exists = db.prepare(
    `SELECT id FROM cascade_changes WHERE stream_row_id = ? AND commit_hash = ?`
  ).get(streamRowId, c.hash);
  if (exists) continue;
  db.prepare(`
    INSERT INTO cascade_changes
      (id, stream_row_id, change_id, commit_hash, parent_commit, author_agent_id,
       message_summary, files_touched, task_resource_id, task_node_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nanoid(), streamRowId, `c-${c.hash.slice(0,8)}`, c.hash, parent,
    'agent-alpha', c.msg, JSON.stringify(c.files),
    resource.id, NODE_ID,
    JSON.stringify({ task_ref: { resource_id: resource.id, node_id: NODE_ID } })
  );
  parent = c.hash;
}
console.log('commits seeded');

// Add a merge to main
const mergeCommit = 'mmmmmmm-merged-1234';
const existingMerge = db.prepare(
  `SELECT id FROM cascade_merges WHERE source_swarm_id = ? AND merge_commit = ?`
).get(SWARM_ID, mergeCommit);
if (!existingMerge) {
  db.prepare(`
    INSERT INTO cascade_merges
      (id, source_stream_row_id, source_swarm_id, source_stream_id, target_stream_id,
       merge_commit, agent_id, strategy, source_commit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nanoid(), streamRowId, SWARM_ID, STREAM_ID, 'main',
    mergeCommit, 'agent-alpha', 'merge-commit', commits[2].hash
  );
}
console.log('merge seeded');

// Add 1 open conflict on a different stream so the conflict UI shows
const STREAM2_ID = 'stream-e2e-2';
const existingStream2 = db.prepare(
  `SELECT id FROM cascade_streams WHERE source_swarm_id = ? AND stream_id = ?`
).get(SWARM_ID, STREAM2_ID);
let stream2RowId;
if (existingStream2) {
  stream2RowId = existingStream2.id;
} else {
  stream2RowId = nanoid();
  db.prepare(`
    INSERT INTO cascade_streams
      (id, stream_id, source_swarm_id, source_agent_id, name, branch_name,
       base_commit, status, is_local_mode, task_resource_id, task_node_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'conflicted', 0, ?, ?, ?)
  `).run(
    stream2RowId, STREAM2_ID, SWARM_ID, 'agent-beta', 'feature/oauth-cleanup',
    `stream/${STREAM2_ID}`, '0000000000000000000000000000000000000000',
    resource.id, NODE_ID,
    JSON.stringify({ task_ref: { resource_id: resource.id, node_id: NODE_ID } })
  );
  // commit on stream2 also bound to same task
  db.prepare(`
    INSERT INTO cascade_changes
      (id, stream_row_id, change_id, commit_hash, parent_commit, author_agent_id,
       message_summary, files_touched, task_resource_id, task_node_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    nanoid(), stream2RowId, 'c-cleanup1', 'b1c2d3e4f5a60001', '0000000000000000000000000000000000000000',
    'agent-beta', 'refactor: extract OAuth helper', JSON.stringify(['src/auth/oauth.ts']),
    resource.id, NODE_ID,
    JSON.stringify({ task_ref: { resource_id: resource.id, node_id: NODE_ID } })
  );
  // pending conflict
  db.prepare(`
    INSERT INTO cascade_conflicts
      (id, stream_row_id, conflict_id, conflicted_files, agent_id,
       conflicting_commit, target_commit, source, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    nanoid(), stream2RowId, 'cf-e2e-pending',
    JSON.stringify(['src/auth/oauth.ts']),
    'agent-beta', 'b1c2d3e4f5a60001', 'a1b2c3d4e5f60003', 'sync'
  );
}
console.log('conflict + secondary stream seeded');

// 3. Also add a corresponding opentasks node so the TaskDetail header has a title.
// We need to write to the opentasks graph file at the resource's local_path.
// Skip for now — the page handles missing-node gracefully.

console.log('\nUI URL:');
console.log(`  http://localhost:5173/tasks/${resource.id}/${NODE_ID}`);
db.close();
