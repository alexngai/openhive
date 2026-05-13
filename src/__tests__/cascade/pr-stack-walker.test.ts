/**
 * Stack-of-PRs walker tests.
 *
 * Linear chains, branching Y-shapes, base resolution chain
 * (publish_branch → branch_name → trunk fallback), terminal-status
 * filtering, lineage_id correctness for the route's blocked_by_parent
 * propagation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import {
  upsertStream,
  updatePublishBranch,
  updateStreamStatus,
} from '../../db/dal/cascade-streams.js';
import { createSwarm, updateSwarm } from '../../db/dal/map.js';
import {
  buildPRStackPlan,
  PRStackRootNotFoundError,
} from '../../cascade/pr-stack-walker.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('pr-stack-walker');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'pr-stack-walker.db');

let ownerAgentId: string;

interface StreamSpec {
  stream_id: string;
  parent?: string;
  /** Branch name on the runtime (matches what git-cascade emits). */
  branch_name?: string;
  /** Explicit publish-branch alias (set via PATCH /branch). */
  publish_branch?: string;
  status?: 'active' | 'merged' | 'abandoned' | 'conflicted' | 'paused';
}

interface SetupOptions {
  swarmId?: string;
  trunkBranch?: string;
  streams: StreamSpec[];
}

function setupSwarmAndStreams(opts: SetupOptions): {
  swarmId: string;
  rowByStream: Map<string, string>;
} {
  const swarmId = opts.swarmId ?? `swarm-walker-${Math.random().toString(36).slice(2, 8)}`;
  createSwarm(ownerAgentId, {
    id: swarmId,
    name: swarmId,
    map_endpoint: 'inline-test',
    map_transport: 'websocket',
    auth_method: 'none',
  });
  if (opts.trunkBranch) {
    updateSwarm(swarmId, { metadata: { trunk_branch: opts.trunkBranch } });
  }

  const rowByStream = new Map<string, string>();
  for (const spec of opts.streams) {
    const { stream } = upsertStream({
      stream_id: spec.stream_id,
      source_swarm_id: swarmId,
      source_agent_id: 'walker-agent',
      name: spec.stream_id,
      branch_name: spec.branch_name,
      parent_stream_id: spec.parent,
    });
    rowByStream.set(spec.stream_id, stream.id);
    if (spec.publish_branch) updatePublishBranch(stream.id, spec.publish_branch);
    if (spec.status) updateStreamStatus(stream.id, spec.status);
  }
  return { swarmId, rowByStream };
}

describe('pr-stack-walker — buildPRStackPlan', () => {
  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'pr-stack-walker-owner',
      description: 'test',
      is_admin: true,
    });
    ownerAgentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    const db = getDatabase();
    db.prepare('DELETE FROM cascade_changes').run();
    db.prepare('DELETE FROM cascade_streams').run();
    db.prepare('DELETE FROM map_swarms').run();
  });

  describe('linear chains', () => {
    it('single root', () => {
      const { rowByStream } = setupSwarmAndStreams({
        streams: [{ stream_id: 'A' }],
      });
      const plan = buildPRStackPlan(rowByStream.get('A')!);
      expect(plan.trunk).toBe('main');
      expect(plan.entries.map((e) => e.cascade_stream_id)).toEqual(['A']);
      expect(plan.entries[0].base_branch).toBe('main');
      expect(plan.entries[0].ancestor_row_ids).toEqual([]);
    });

    it('A → B → C with base resolution chain', () => {
      const { rowByStream } = setupSwarmAndStreams({
        streams: [
          { stream_id: 'A', publish_branch: 'feature/a' },
          { stream_id: 'B', parent: 'A', branch_name: 'stream/B' },
          { stream_id: 'C', parent: 'B' }, // no publish + no branch_name → defaultPublishBranch
        ],
      });
      const plan = buildPRStackPlan(rowByStream.get('A')!);
      expect(plan.entries.map((e) => e.cascade_stream_id)).toEqual(['A', 'B', 'C']);
      // A: trunk base
      expect(plan.entries[0].base_branch).toBe('main');
      expect(plan.entries[0].head_branch).toBe('feature/a');
      expect(plan.entries[0].ancestor_row_ids).toEqual([]);
      // B's base = A's head_branch
      expect(plan.entries[1].base_branch).toBe('feature/a');
      // B's head = its publish_branch (none) → defaultPublishBranch from name 'B'
      // i.e. 'cascade/B'
      expect(plan.entries[1].head_branch).toBe('cascade/B');
      expect(plan.entries[1].ancestor_row_ids).toEqual([rowByStream.get('A')]);
      // C's base = B's head
      expect(plan.entries[2].base_branch).toBe('cascade/B');
      expect(plan.entries[2].head_branch).toBe('cascade/C');
      expect(plan.entries[2].ancestor_row_ids).toEqual([
        rowByStream.get('A'),
        rowByStream.get('B'),
      ]);
    });

    it('honors swarm.metadata.trunk_branch override', () => {
      const { rowByStream } = setupSwarmAndStreams({
        trunkBranch: 'develop',
        streams: [{ stream_id: 'A' }],
      });
      const plan = buildPRStackPlan(rowByStream.get('A')!);
      expect(plan.trunk).toBe('develop');
      expect(plan.entries[0].base_branch).toBe('develop');
    });
  });

  describe('branching (Y-shape, D20)', () => {
    it('A → {B, C} — both share A as ancestor + base, root has empty ancestors', () => {
      const { rowByStream } = setupSwarmAndStreams({
        streams: [
          { stream_id: 'A', publish_branch: 'feat/a' },
          { stream_id: 'B', parent: 'A', publish_branch: 'feat/b' },
          { stream_id: 'C', parent: 'A', publish_branch: 'feat/c' },
        ],
      });
      const plan = buildPRStackPlan(rowByStream.get('A')!);
      expect(plan.entries.map((e) => e.cascade_stream_id).sort()).toEqual(['A', 'B', 'C']);
      const a = plan.entries.find((e) => e.cascade_stream_id === 'A')!;
      const b = plan.entries.find((e) => e.cascade_stream_id === 'B')!;
      const c = plan.entries.find((e) => e.cascade_stream_id === 'C')!;
      expect(b.base_branch).toBe('feat/a');
      expect(c.base_branch).toBe('feat/a');
      // Root has no ancestors; fork children both list root.
      expect(a.ancestor_row_ids).toEqual([]);
      expect(b.ancestor_row_ids).toEqual([rowByStream.get('A')]);
      expect(c.ancestor_row_ids).toEqual([rowByStream.get('A')]);
    });

    it('A → B → {C, D} — fork descendants share B + A as ancestors', () => {
      const { rowByStream } = setupSwarmAndStreams({
        streams: [
          { stream_id: 'A' },
          { stream_id: 'B', parent: 'A' },
          { stream_id: 'C', parent: 'B' },
          { stream_id: 'D', parent: 'B' },
        ],
      });
      const plan = buildPRStackPlan(rowByStream.get('A')!);
      const a = plan.entries.find((e) => e.cascade_stream_id === 'A')!;
      const b = plan.entries.find((e) => e.cascade_stream_id === 'B')!;
      const c = plan.entries.find((e) => e.cascade_stream_id === 'C')!;
      const d = plan.entries.find((e) => e.cascade_stream_id === 'D')!;
      expect(a.ancestor_row_ids).toEqual([]);
      expect(b.ancestor_row_ids).toEqual([rowByStream.get('A')]);
      expect(c.ancestor_row_ids).toEqual([rowByStream.get('A'), rowByStream.get('B')]);
      expect(d.ancestor_row_ids).toEqual([rowByStream.get('A'), rowByStream.get('B')]);
    });
  });

  describe('terminal-status filtering', () => {
    it('skips merged stream in the plan but descends through it', () => {
      const { rowByStream } = setupSwarmAndStreams({
        streams: [
          { stream_id: 'A' },
          { stream_id: 'B', parent: 'A', status: 'merged' },
          { stream_id: 'C', parent: 'B' },
        ],
      });
      const plan = buildPRStackPlan(rowByStream.get('A')!);
      expect(plan.entries.map((e) => e.cascade_stream_id)).toEqual(['A', 'C']);
      // C's base falls back to A's head_branch (B was skipped).
      const a = plan.entries[0];
      const c = plan.entries[1];
      expect(c.base_branch).toBe(a.head_branch);
    });

    it('skips abandoned stream in the plan', () => {
      const { rowByStream } = setupSwarmAndStreams({
        streams: [
          { stream_id: 'A' },
          { stream_id: 'B', parent: 'A', status: 'abandoned' },
        ],
      });
      const plan = buildPRStackPlan(rowByStream.get('A')!);
      expect(plan.entries.map((e) => e.cascade_stream_id)).toEqual(['A']);
    });

    it('skips paused stream in the plan but descends through it (transparent)', () => {
      // A → paused-B → C. Paused-B should collapse out: C surfaces with
      // base = A's head_branch, ancestor_row_ids should NOT include B.
      const { rowByStream } = setupSwarmAndStreams({
        streams: [
          { stream_id: 'A' },
          { stream_id: 'B', parent: 'A', status: 'paused' },
          { stream_id: 'C', parent: 'B' },
        ],
      });
      const plan = buildPRStackPlan(rowByStream.get('A')!);
      expect(plan.entries.map((e) => e.cascade_stream_id)).toEqual(['A', 'C']);
      const a = plan.entries[0];
      const c = plan.entries[1];
      expect(c.base_branch).toBe(a.head_branch);
      // Paused B was transparent — only A is in C's ancestor chain.
      expect(c.ancestor_row_ids).toEqual([rowByStream.get('A')]);
    });

    it('does NOT skip conflicted stream — still in plan', () => {
      const { rowByStream } = setupSwarmAndStreams({
        streams: [
          { stream_id: 'A' },
          { stream_id: 'B', parent: 'A', status: 'conflicted' },
        ],
      });
      const plan = buildPRStackPlan(rowByStream.get('A')!);
      expect(plan.entries.map((e) => e.cascade_stream_id)).toEqual(['A', 'B']);
    });

    it('descends through chain of merged ancestors', () => {
      // A (merged) → B (merged) → C (active) — walker should still surface C
      // with base = trunk since both ancestors are terminal.
      const { rowByStream } = setupSwarmAndStreams({
        streams: [
          { stream_id: 'A', status: 'merged' },
          { stream_id: 'B', parent: 'A', status: 'merged' },
          { stream_id: 'C', parent: 'B' },
        ],
      });
      const plan = buildPRStackPlan(rowByStream.get('A')!);
      expect(plan.entries.map((e) => e.cascade_stream_id)).toEqual(['C']);
      expect(plan.entries[0].base_branch).toBe('main');
    });
  });

  describe('errors', () => {
    it('throws PRStackRootNotFoundError on unknown row id', () => {
      expect(() => buildPRStackPlan('does-not-exist')).toThrow(
        PRStackRootNotFoundError,
      );
    });
  });
});
