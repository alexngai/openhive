/**
 * Hub-default task graph bootstrap (P2.4).
 *
 * Verifies ensureHubDefaultTaskGraph():
 * - no-op (null) on a pre-init DB with zero agents
 * - creates the .opentasks store + `hub/default` resource once
 * - idempotent across repeated calls (no duplicate rows, stable id)
 * - the resource is visible to a NON-owner agent (the public-visibility
 *   requirement — a private admin-owned resource would be invisible to
 *   everyone else's listAccessibleResources)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import {
  ensureHubDefaultTaskGraph,
  HUB_DEFAULT_GRAPH_NAME,
} from '../../map/hub-task-graph.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('hub-task-graph');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'hub-task-graph.db');
const DATA_DIR = path.join(TEST_ROOT, 'data');

describe('ensureHubDefaultTaskGraph', () => {
  beforeAll(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('returns null when no agents exist (pre-init instance)', () => {
    expect(ensureHubDefaultTaskGraph(DATA_DIR)).toBeNull();
    // And registers no resource row that a later call couldn't own.
    const count = getDatabase()
      .prepare(`SELECT COUNT(*) as n FROM syncable_resources WHERE resource_type = 'task'`)
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('creates the store + hub/default resource once an admin agent exists', async () => {
    const { agent: admin } = await agentsDAL.createAgent({
      name: 'hub-admin',
      description: 'admin',
      is_admin: true,
    });

    const resource = ensureHubDefaultTaskGraph(DATA_DIR);
    expect(resource).not.toBeNull();
    expect(resource!.name).toBe(HUB_DEFAULT_GRAPH_NAME);
    expect(resource!.resource_type).toBe('task');
    expect(resource!.visibility).toBe('public');
    expect(resource!.owner_agent_id).toBe(admin.id);

    const meta = resource!.metadata as Record<string, unknown>;
    expect(meta.opentasks).toBe(true);
    expect(meta.hub_default).toBe(true);
    expect(typeof meta.location_hash).toBe('string');

    // On-disk layout: config.json + graph.jsonl under <data>/task-graph/.opentasks
    const dir = path.join(DATA_DIR, 'task-graph', '.opentasks');
    expect(resource!.local_path).toBe(dir);
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'graph.jsonl'))).toBe(true);
  });

  it('is idempotent: repeated boots return the same resource, no duplicates', () => {
    const first = ensureHubDefaultTaskGraph(DATA_DIR)!;
    const second = ensureHubDefaultTaskGraph(DATA_DIR)!;
    expect(second.id).toBe(first.id);

    const count = getDatabase()
      .prepare(
        `SELECT COUNT(*) as n FROM syncable_resources WHERE resource_type = 'task' AND name = ?`,
      )
      .get(HUB_DEFAULT_GRAPH_NAME) as { n: number };
    expect(count.n).toBe(1);
  });

  it('is accessible to a non-owner agent (public visibility)', async () => {
    const { agent: other } = await agentsDAL.createAgent({
      name: 'random-agent',
      description: 'not the owner',
    });
    const resource = ensureHubDefaultTaskGraph(DATA_DIR)!;
    expect(resourcesDAL.canAccessResource(other.id, resource)).toBe(true);
  });

  it('honors a dir override and re-points an existing hub/default (git store)', () => {
    const before = ensureHubDefaultTaskGraph(DATA_DIR)!;

    const storeDir = path.join(TEST_ROOT, 'hive-store', '.opentasks');
    const resource = ensureHubDefaultTaskGraph(DATA_DIR, { dir: storeDir })!;

    // Same resource, re-pointed — not a duplicate row.
    expect(resource.id).toBe(before.id);
    expect(resource.local_path).toBe(storeDir);
    expect(fs.existsSync(path.join(storeDir, 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(storeDir, 'graph.jsonl'))).toBe(true);

    const count = getDatabase()
      .prepare(
        `SELECT COUNT(*) as n FROM syncable_resources WHERE resource_type = 'task' AND name = ?`,
      )
      .get(HUB_DEFAULT_GRAPH_NAME) as { n: number };
    expect(count.n).toBe(1);
  });
});
