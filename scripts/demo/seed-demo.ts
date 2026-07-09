/**
 * Demo data seeder — populates an ISOLATED database with believable content for
 * documentation screenshots. NOT for production use.
 *
 * Point it at a throwaway DB via OPENHIVE_DATABASE, then run the server against
 * the same DB:
 *
 *   OPENHIVE_DATABASE=/tmp/demo/demo.db npx tsx scripts/demo/seed-demo.ts
 *   OPENHIVE_DATABASE=/tmp/demo/demo.db OPENHIVE_ADMIN_TRUST_LOCAL_MODE=1 \
 *     npx tsx src/cli.ts serve
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { initDatabase, closeDatabase, getDatabase } from '../../src/db/index.js';
import { createAgent } from '../../src/db/dal/agents.js';
import { ensureHubDefaultTaskGraph } from '../../src/map/hub-task-graph.js';
import {
  resolveDaemonSocket,
  daemonCreateSpec,
  daemonCreateTask,
  daemonCreateLink,
} from '../../src/map/task-daemon-client.js';
import { resolveLocalPath } from '../../src/api/routes/_resource-helpers.js';
import { createResource } from '../../src/db/dal/syncable-resources.js';
import { createSwarm } from '../../src/db/dal/map.js';
import { createDispatch, updateDispatchStatus } from '../../src/db/dal/dispatches.js';
import {
  upsertStream,
  recordCommit,
  recordConflict,
  recordMerge,
  updateStreamStatus,
} from '../../src/db/dal/cascade-streams.js';
import { createTeamTemplate } from '../../src/db/dal/team-templates.js';
import { createLoadout } from '../../src/db/dal/loadouts.js';

const dbPath = process.env.OPENHIVE_DATABASE;
if (!dbPath) {
  console.error('Refusing to run: set OPENHIVE_DATABASE to an isolated demo DB path first.');
  process.exit(1);
}

/**
 * Seed an ISOLATED opentasks graph (specs + tasks) under the demo data dir.
 * The daemon writes graph.jsonl synchronously. Two subtleties:
 *  - We rename the resource off `hub/default` so the server's own startup
 *    bootstrap can't match-and-overwrite this isolated graph's path (the
 *    upsert keys on owner+name).
 *  - main() must process.exit() afterward — the spawned daemon child keeps the
 *    event loop alive, so closeDatabase() alone won't let the script exit.
 */
async function seedTaskGraph(dataDir: string): Promise<void> {
  const graph = ensureHubDefaultTaskGraph(dataDir);
  if (!graph) { console.warn('task graph skipped (no owner agent)'); return; }
  const localPath = resolveLocalPath(graph);
  if (!localPath) { console.warn('task graph skipped (no local path)'); return; }
  const sock = resolveDaemonSocket(localPath);

  const oauthSpec = (await daemonCreateSpec(sock, {
    title: 'Add OAuth login to the dashboard',
    content: '## Goal\nLet operators sign in with GitHub OAuth.\n\n## Acceptance\n- Login button\n- Callback route\n- Session cookie',
    priority: 2,
  }, localPath)) as { id: string };
  await daemonCreateSpec(sock, {
    title: 'Federate memory banks across instances',
    content: 'Pull-based mesh sync for memory_bank resources between two hubs.',
    priority: 1,
  }, localPath);

  const tasks: Array<[string, string, boolean]> = [
    ['Scaffold auth routes', 'completed', true],
    ['Wire the OAuth callback route', 'completed', true],
    ['Add session-cookie middleware', 'in_progress', true],
    ['Rate-limit the token endpoint', 'in_progress', true],
    ['Write the e2e login test', 'open', true],
    ['Decide refresh-token strategy', 'blocked', true],
  ];
  for (const [title, status, linkToOauth] of tasks) {
    const t = (await daemonCreateTask(sock, { title, status }, localPath)) as { id: string };
    if (linkToOauth) {
      try { await daemonCreateLink(sock, { fromId: t.id, toId: oauthSpec.id, type: 'implements' }, localPath); }
      catch { /* link is best-effort */ }
    }
  }

  // The daemon flushes graph.jsonl on a debounce; wait for our nodes to land on
  // disk before the process exits (a later server-spawned daemon loads from it).
  const graphFile = path.join(localPath, 'graph.jsonl');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const n = readFileSync(graphFile, 'utf8').trim().split('\n').filter(Boolean).length;
      if (n >= 8) break; // 2 specs + 6 tasks
    } catch { /* not flushed yet */ }
  }

  // Rename off hub/default (see doc comment above).
  getDatabase().prepare('UPDATE syncable_resources SET name = ? WHERE id = ?').run('acme/dashboard', graph.id);
  const finalCount = (() => { try { return readFileSync(graphFile, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } })();
  console.log(`Task graph seeded (isolated) → acme/dashboard (${finalCount} nodes on disk)`);
}

async function main(): Promise<void> {
  initDatabase(dbPath!);
  console.log('Seeding demo data →', dbPath);

  // Operator (admin) + a few working agents.
  const { agent: operator } = await createAgent({
    name: 'operator',
    description: 'Human operator',
  });
  const owner = operator.id;

  for (const [name, description] of [
    ['research-lead', 'Coordinator for the research swarm'],
    ['builder-01', 'Implements features from specs'],
    ['reviewer-01', 'Reviews diffs and enforces standards'],
    ['scout-02', 'Fans out searches and gathers sources'],
  ] as const) {
    await createAgent({ name, description });
  }

  // Swarms — fixed ids so the mock (scripts/demo/mock-swarm.ts) can connect AS these
  // swarms over the hub's inbound MAP WS (bringing them online). Endpoints use a
  // non-ws:// scheme (`map://`) on purpose: the swarmcraft bridge only runs its
  // outbound reachability probe for ws://|wss:// endpoints, so a map:// endpoint
  // means the bridge leaves these inbound-only demo swarms alone and the mock's
  // heartbeat keeps them 'online' instead of the bridge flipping them.
  createSwarm(owner, {
    id: 'swarm_research',
    name: 'research-swarm',
    description: 'Multi-agent research + synthesis',
    map_endpoint: 'map://research.swarm.local/map',
    capabilities: { protocols: ['acp'], mail: { canJoin: true }, messaging: { canReceive: true } },
  });
  createSwarm(owner, {
    id: 'swarm_build',
    name: 'build-swarm',
    description: 'Spec-driven implementation swarm',
    map_endpoint: 'map://build.swarm.local/map',
    capabilities: { mail: { canJoin: true }, tasks: { canCreate: true } },
  });
  createSwarm(owner, {
    id: 'swarm_ops',
    name: 'ops-swarm',
    description: 'Scheduled maintenance + housekeeping jobs',
    map_endpoint: 'map://ops.swarm.local/map',
    capabilities: { mail: { canJoin: true } },
  });

  // Memory banks + skills (public so they render regardless of the viewer).
  const memory: Array<[string, string]> = [
    ['project-memory', 'Long-term memory for the OpenHive project'],
    ['research-notes', 'Synthesized findings across sources'],
    ['coding-standards', 'House style and review conventions'],
  ];
  for (const [name, description] of memory) {
    createResource({
      resource_type: 'memory_bank',
      name,
      description,
      owner_agent_id: owner,
      git_remote_url: `https://github.com/acme/${name}`,
      visibility: 'public',
    });
  }

  const skills: Array<[string, string]> = [
    ['web-research', 'Fan-out search with adversarial verification'],
    ['pr-review', 'Structured diff review with severity ratings'],
    ['spec-to-tasks', 'Decompose a spec into a task graph'],
    ['release-notes', 'Draft release notes from merged changes'],
  ];
  for (const [name, description] of skills) {
    createResource({
      resource_type: 'skill',
      name,
      description,
      owner_agent_id: owner,
      git_remote_url: `https://github.com/acme/skill-${name}`,
      visibility: 'public',
    });
  }

  // Dispatches / Jobs — varied statuses so the Jobs list shows the lifecycle.
  createDispatch({
    spec_resource_id: null, spec_id: 'ctx_oauth_login', target_swarm_id: 'swarm_build',
    initiator_type: 'user', initiator_id: owner, status: 'queued',
    prompt_override: 'Implement the OAuth login spec end to end.',
  });
  createDispatch({
    spec_resource_id: null, spec_id: 'ctx_memory_federation', target_swarm_id: 'swarm_research',
    initiator_type: 'agent', initiator_id: owner, status: 'running',
  });
  const dDone = createDispatch({
    spec_resource_id: null, spec_id: 'ctx_rate_limit', target_swarm_id: 'swarm_ops',
    initiator_type: 'user', initiator_id: owner, status: 'complete',
  });
  updateDispatchStatus(dDone.id, 'complete', {
    summary: 'Landed rate limiting on the token route; 3 files changed.',
    artifacts: [{ kind: 'pr', ref: 'https://github.com/acme/hub/pull/42' }],
  });
  const dFailed = createDispatch({
    spec_resource_id: null, spec_id: 'ctx_e2e_login', target_swarm_id: 'swarm_build',
    initiator_type: 'agent', initiator_id: owner, status: 'failed',
  });
  updateDispatchStatus(dFailed.id, 'failed', { error: 'Playwright timed out on the callback redirect.' });

  // Changes / cascade streams — fills all three triage buckets (in-progress,
  // needs-attention w/ conflict, recently-landed w/ merge edge).
  const s1 = upsertStream({
    stream_id: 'stream-oauth-login', source_swarm_id: 'swarm_build',
    source_agent_id: 'builder-lead', name: 'feat/oauth-login', branch_name: 'cascade/oauth-login',
  }).stream;
  recordCommit({ stream_row_id: s1.id, commit_hash: 'a1b2c3d4', message_summary: 'Add login button + callback route', author_agent_id: 'builder-lead', files_touched: ['src/auth/oauth.ts', 'src/web/Login.tsx'] });
  recordCommit({ stream_row_id: s1.id, commit_hash: 'e5f6a7b8', message_summary: 'Wire session cookie', author_agent_id: 'builder-lead', files_touched: ['src/auth/session.ts'] });

  const s2 = upsertStream({
    stream_id: 'stream-memory-fed', source_swarm_id: 'swarm_research',
    source_agent_id: 'research-lead', name: 'feat/memory-federation',
  }).stream;
  recordCommit({ stream_row_id: s2.id, commit_hash: 'c0ffee01', message_summary: 'Mesh sync scaffolding', files_touched: ['src/sync/materializer.ts'] });
  recordConflict({ stream_row_id: s2.id, conflict_id: 'cf-1', conflicted_files: ['src/sync/materializer.ts'], source: 'rebase' });
  updateStreamStatus(s2.id, 'conflicted');

  const parent = upsertStream({ stream_id: 'stream-main', source_swarm_id: 'swarm_ops', source_agent_id: 'ops-runner', name: 'main' }).stream;
  const s3 = upsertStream({
    stream_id: 'stream-rate-limit', source_swarm_id: 'swarm_ops',
    source_agent_id: 'ops-runner', name: 'fix/rate-limit', parent_stream_id: 'stream-main',
  }).stream;
  recordCommit({ stream_row_id: s3.id, commit_hash: 'deadbeef', message_summary: 'Rate-limit token route', files_touched: ['src/api/middleware/rate-limit.ts'] });
  recordMerge({
    source_swarm_id: 'swarm_ops', source_stream_id: 'stream-rate-limit', target_stream_id: 'stream-main',
    merge_commit: 'merge123', source_stream_row_id: s3.id, target_stream_row_id: parent.id,
  });
  updateStreamStatus(s3.id, 'merged', { closed: true });

  // Teams — templates + loadouts (Library → Teams tabs).
  createTeamTemplate({
    name: 'ship-a-feature', description: 'Planner + two builders + a reviewer.',
    ownerAgentId: owner, visibility: 'public',
    content: {
      manifest: { name: 'ship-a-feature', version: 1, roles: ['planner', 'builder', 'reviewer'], topology: { root: { role: 'planner' }, companions: [{ role: 'builder' }, { role: 'reviewer' }] } },
      roles: {
        planner: { name: 'planner', capabilities: ['plan', 'delegate'] },
        builder: { name: 'builder', capabilities: ['code', 'test'] },
        reviewer: { name: 'reviewer', capabilities: ['review'] },
      },
    },
  });
  createTeamTemplate({
    name: 'research-pod', description: 'A lead researcher with two scouts.',
    ownerAgentId: owner, visibility: 'public',
    content: {
      manifest: { name: 'research-pod', version: 1, roles: ['lead', 'scout'], topology: { root: { role: 'lead' }, companions: [{ role: 'scout' }] } },
      roles: { lead: { name: 'lead' }, scout: { name: 'scout' } },
    },
  });
  createLoadout({
    name: 'full-stack-builder', description: 'MCP + skills + permissions for a coding agent.',
    ownerAgentId: owner, visibility: 'public',
    content: {
      name: 'full-stack-builder', capabilities: ['code', 'test', 'git'], mcp_servers: ['filesystem', 'git'],
      permissions: { allow: ['Bash', 'Edit', 'Write'], ask: ['WebFetch'] }, prompt_addendum: 'Prefer small, verified commits.',
    },
  });
  createLoadout({
    name: 'reviewer-lite', description: 'Read-only review loadout.',
    ownerAgentId: owner, visibility: 'public',
    content: { name: 'reviewer-lite', capabilities: ['review'], permissions: { deny: ['Write', 'Bash'] } },
  });

  // Task graph last — it spawns the opentasks daemon (async). Best-effort:
  // the daemon can be finicky to auto-start from a one-shot script, so a
  // failure here must not abort the rest of the (already-committed) seed.
  try {
    await seedTaskGraph(path.dirname(dbPath!));
  } catch (err) {
    console.warn('[seed] task graph skipped — opentasks daemon unavailable:', (err as Error).message);
    try { getDatabase().prepare("DELETE FROM syncable_resources WHERE resource_type = 'task'").run(); } catch { /* ignore */ }
  }

  console.log('Demo seed complete.');
  closeDatabase();
  // The opentasks daemon child keeps the event loop alive; force a clean exit.
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
