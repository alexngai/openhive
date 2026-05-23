/**
 * Phase 2.5 — hub-side task-graph resource resolution at agent registration.
 *
 * `resolveTaskGraphResourceId` backfills the OpenHive `syncable_resources` id
 * for an agent-declared `task_graph` when the runtime did not supply one.
 * cc-swarm sidecars identify their opentasks graph only by `location_hash`
 * (and/or a local `path`) — macro-agent sends `resource_id` directly.
 *
 * Resolution chain (first hit wins):
 *   1. explicit `resource_id` (macro-agent — unchanged)
 *   2. `location_hash` → existing task resource
 *   3. local valid opentasks `path` → idempotent auto-register
 *   4. none → undefined (registration still succeeds; auto-close won't fire)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { resolveTaskGraphResourceId } from '../../map/ws-map.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

const TEST_ROOT = testRoot('ws-map-task-graph-resolution');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'ws-map-task-graph-resolution.db');

describe('resolveTaskGraphResourceId (registration task-graph resolution)', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'task-graph-resolution-agent',
      description: 'Agent for task-graph resolution tests',
    });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('passes through an explicit resource_id (macro-agent path)', () => {
    const resolved = resolveTaskGraphResourceId(
      { resource_id: 'res_explicit_macro', location_hash: 'lh-ignored' },
      agentId
    );
    expect(resolved).toBe('res_explicit_macro');
  });

  it('resolves resource_id from location_hash when a matching task resource exists', () => {
    const locationHash = 'lh-ccswarm-existing-001';
    const resource = resourcesDAL.createResource({
      resource_type: 'task',
      name: 'cc-swarm task graph',
      git_remote_url: '/tmp/cc-swarm/.opentasks',
      owner_agent_id: agentId,
      metadata: { opentasks: true, location_hash: locationHash },
    });

    const resolved = resolveTaskGraphResourceId({ location_hash: locationHash }, agentId);
    expect(resolved).toBe(resource.id);
  });

  it('returns undefined when no resource matches the location_hash and no valid path', () => {
    const resolved = resolveTaskGraphResourceId(
      { location_hash: 'lh-no-match-whatsoever', path: '/nonexistent/path/.opentasks' },
      agentId
    );
    expect(resolved).toBeUndefined();
  });

  it('returns undefined for an empty task_graph (registration still succeeds)', () => {
    expect(resolveTaskGraphResourceId({}, agentId)).toBeUndefined();
  });

  it('auto-registers a resource when path points to a valid opentasks dir', () => {
    const opentasksDir = path.join(TEST_ROOT, 'fixture-graph', '.opentasks');
    fs.mkdirSync(opentasksDir, { recursive: true });
    fs.writeFileSync(
      path.join(opentasksDir, 'config.json'),
      JSON.stringify({ location: { hash: 'lh-from-config' } })
    );
    fs.writeFileSync(path.join(opentasksDir, 'graph.jsonl'), '');

    const resolved = resolveTaskGraphResourceId({ path: opentasksDir }, agentId);
    expect(resolved).toBeDefined();

    const resource = resourcesDAL.findResourceById(resolved!);
    expect(resource).not.toBeNull();
    expect(resource!.resource_type).toBe('task');

    // Idempotent — a second registration resolves to the same resource id.
    const again = resolveTaskGraphResourceId({ path: opentasksDir }, agentId);
    expect(again).toBe(resolved);
  });
});
