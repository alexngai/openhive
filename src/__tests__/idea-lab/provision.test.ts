/**
 * Idea-lab provisioning idempotency — the "reload reliably after install"
 * guarantee, encoded as a test. Provision twice, assert the second run
 * creates nothing new and produces no duplicates. Daemon-free: the pack has
 * no objectives, so no OpenTasks daemon is spawned (only resource + schedule
 * reconciliation is exercised).
 *
 * Mirrors src/__tests__/openteams/seed.test.ts (seed twice, same ids).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as schedulesDAL from '../../db/dal/schedules.js';
import { provisionIdeaLab, parseIdeaLabPack } from '../../idea-lab/index.js';
import { isValidPayload, getPayloadKind } from '../../scheduler/payload-types.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('idea-lab-provision');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'idea-lab-provision.db');

const silent = { info: () => {}, warn: () => {} };

/** Daemon-free pack: no objectives → no OpenTasks daemon interaction. */
const PACK = parseIdeaLabPack({
  version: 1,
  graph: { name: 'idea-lab/graph', description: 'test graph' },
  ledger: { name: 'idea-lab/ledger', description: 'test ledger' },
  objectives: [],
  roles: [
    { key: 'ideator', cron: '0 * * * *', prompt: 'ideator prompt v1' },
    { key: 'judge', cron: '0 */6 * * *', prompt: 'judge prompt v1' },
  ],
});

const parsePayload = (p: unknown): Record<string, unknown> =>
  typeof p === 'string' ? JSON.parse(p) : (p as Record<string, unknown>);

const labSchedules = () =>
  schedulesDAL.listSchedules({ initiator_id: 'idea-lab', limit: 100 }).data;

beforeAll(async () => {
  cleanTestRoot(TEST_ROOT);
  initDatabase(TEST_DB_PATH);
  // findDefaultOwnerAgent needs an agent to own the provisioned resources.
  await agentsDAL.createAgent({ name: 'admin', is_admin: true });
});

afterAll(() => {
  closeDatabase();
  cleanTestRoot(TEST_ROOT);
});

beforeEach(() => {
  const db = getDatabase();
  db.pragma('foreign_keys = OFF');
  db.exec('DELETE FROM schedules');
  try {
    db.exec('DELETE FROM resource_subscriptions');
  } catch {
    /* table name may differ across schema versions */
  }
  db.exec('DELETE FROM syncable_resources');
  db.pragma('foreign_keys = ON');
});

describe('provisionIdeaLab idempotency', () => {
  it('second run creates nothing new and never duplicates', async () => {
    const first = await provisionIdeaLab({
      dataDir: TEST_ROOT,
      pack: PACK,
      targetSwarmIds: ['swarm_a'],
      logger: silent,
    });

    expect(first.ok).toBe(true);
    expect(first.graph?.created).toBe(true);
    expect(first.ledger?.created).toBe(true);
    expect(first.schedules.created).toBe(2);
    expect(first.schedules.paused).toBe(0);

    const afterFirst = labSchedules();
    expect(afterFirst).toHaveLength(2);
    const graphId = first.graph?.resourceId;

    const second = await provisionIdeaLab({
      dataDir: TEST_ROOT,
      pack: PACK,
      targetSwarmIds: ['swarm_a'],
      logger: silent,
    });

    // Resources deduped by (owner, type, name) — same id, not re-created.
    expect(second.graph?.created).toBe(false);
    expect(second.ledger?.created).toBe(false);
    expect(second.graph?.resourceId).toBe(graphId);

    // Schedules matched by idealab_key — nothing new, nothing changed.
    expect(second.schedules.created).toBe(0);
    expect(second.schedules.unchanged).toBe(2);

    const afterSecond = labSchedules();
    expect(afterSecond).toHaveLength(2); // no duplicates
    expect(afterSecond.map((s) => s.id).sort()).toEqual(
      afterFirst.map((s) => s.id).sort(),
    );
  });

  it('provisions schedules whose payload the fire handler accepts', async () => {
    await provisionIdeaLab({
      dataDir: TEST_ROOT,
      pack: PACK,
      targetSwarmIds: ['swarm_a'],
      logger: silent,
    });
    const scheds = labSchedules();
    expect(scheds).toHaveLength(2);
    for (const s of scheds) {
      const payload = parsePayload(s.payload);
      expect(isValidPayload(payload)).toBe(true);
      expect(getPayloadKind(payload as never)).toBe('dispatch_prompt');
      expect(payload.target_swarm_ids).toEqual(['swarm_a']);
    }
  });

  it('creates role schedules paused when no target swarms are configured', async () => {
    const res = await provisionIdeaLab({
      dataDir: TEST_ROOT,
      pack: PACK,
      targetSwarmIds: [],
      logger: silent,
    });
    expect(res.schedules.created).toBe(2);
    expect(res.schedules.paused).toBe(2);
    const scheds = labSchedules();
    expect(scheds.filter((s) => s.paused).length).toBe(2);
  });

  it('managed reconcile updates a drifted role prompt without duplicating', async () => {
    await provisionIdeaLab({
      dataDir: TEST_ROOT,
      pack: PACK,
      targetSwarmIds: ['swarm_a'],
      logger: silent,
    });

    const drifted = parseIdeaLabPack({
      version: 2,
      graph: { name: 'idea-lab/graph' },
      ledger: { name: 'idea-lab/ledger' },
      objectives: [],
      roles: [
        { key: 'ideator', cron: '0 * * * *', prompt: 'ideator prompt v2 CHANGED' },
        { key: 'judge', cron: '0 */6 * * *', prompt: 'judge prompt v1' },
      ],
    });

    const res = await provisionIdeaLab({
      dataDir: TEST_ROOT,
      pack: drifted,
      targetSwarmIds: ['swarm_a'],
      reconcile: 'managed',
      logger: silent,
    });

    expect(res.schedules.updated).toBe(1);
    expect(res.schedules.unchanged).toBe(1);

    const scheds = labSchedules();
    expect(scheds).toHaveLength(2); // updated in place, not duplicated
    const ideator = scheds.find(
      (s) => parsePayload(s.payload).idealab_key === 'role:ideator',
    );
    expect(parsePayload(ideator!.payload).prompt).toBe('ideator prompt v2 CHANGED');
  });

  it('create-only reconcile leaves a drifted prompt untouched', async () => {
    await provisionIdeaLab({
      dataDir: TEST_ROOT,
      pack: PACK,
      targetSwarmIds: ['swarm_a'],
      logger: silent,
    });

    const drifted = parseIdeaLabPack({
      version: 2,
      graph: { name: 'idea-lab/graph' },
      ledger: { name: 'idea-lab/ledger' },
      objectives: [],
      roles: [
        { key: 'ideator', cron: '0 * * * *', prompt: 'SHOULD NOT APPLY' },
        { key: 'judge', cron: '0 */6 * * *', prompt: 'judge prompt v1' },
      ],
    });

    const res = await provisionIdeaLab({
      dataDir: TEST_ROOT,
      pack: drifted,
      targetSwarmIds: ['swarm_a'],
      reconcile: 'create-only',
      logger: silent,
    });

    expect(res.schedules.updated).toBe(0);
    expect(res.schedules.unchanged).toBe(2);
    const scheds = labSchedules();
    const ideator = scheds.find(
      (s) => parsePayload(s.payload).idealab_key === 'role:ideator',
    );
    expect(parsePayload(ideator!.payload).prompt).toBe('ideator prompt v1');
  });
});
