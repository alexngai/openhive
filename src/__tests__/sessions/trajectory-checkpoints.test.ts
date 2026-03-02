/**
 * Tests for trajectory checkpoints DAL.
 *
 * Covers CRUD, dedup, pagination, stats aggregation, and listAllSessions.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as trajectoryDAL from '../../db/dal/trajectory-checkpoints.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('trajectory-checkpoints');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'trajectory-checkpoints.db');

describe('Trajectory Checkpoints DAL', () => {
  let agentId: string;
  let sessionId1: string;
  let sessionId2: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'traj-test-agent',
      description: 'Agent for trajectory checkpoint tests',
    });
    agentId = agent.id;

    // Create two session resources
    const s1 = resourcesDAL.createResource({
      resource_type: 'session',
      name: 'session-alpha',
      git_remote_url: 'local://test/alpha',
      owner_agent_id: agentId,
    });
    sessionId1 = s1.id;

    const s2 = resourcesDAL.createResource({
      resource_type: 'session',
      name: 'session-beta',
      git_remote_url: 'local://test/beta',
      owner_agent_id: agentId,
    });
    sessionId2 = s2.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ═══════════════════════════════════════════════════════════════
  // createTrajectoryCheckpoint
  // ═══════════════════════════════════════════════════════════════

  describe('createTrajectoryCheckpoint', () => {
    it('should create a checkpoint with all fields', () => {
      const cp = trajectoryDAL.createTrajectoryCheckpoint({
        session_resource_id: sessionId1,
        checkpoint_id: 'chk_full',
        commit_hash: 'abc123',
        agent: 'claude-agent',
        branch: 'main',
        files_touched: ['src/index.ts', 'README.md'],
        checkpoints_count: 3,
        token_usage: { input_tokens: 1000, output_tokens: 500 },
        summary: { intent: 'refactor auth', outcome: 'success' },
        attribution: { claude: 0.8, human: 0.2 },
        source_swarm_id: 'swarm_001',
        source_agent_id: agentId,
      });

      expect(cp).not.toBeNull();
      expect(cp!.checkpoint_id).toBe('chk_full');
      expect(cp!.commit_hash).toBe('abc123');
      expect(cp!.agent).toBe('claude-agent');
      expect(cp!.branch).toBe('main');
      expect(cp!.files_touched).toEqual(['src/index.ts', 'README.md']);
      expect(cp!.checkpoints_count).toBe(3);
      expect(cp!.token_usage).toEqual({ input_tokens: 1000, output_tokens: 500 });
      expect(cp!.summary).toEqual({ intent: 'refactor auth', outcome: 'success' });
      expect(cp!.attribution).toEqual({ claude: 0.8, human: 0.2 });
      expect(cp!.source_swarm_id).toBe('swarm_001');
      expect(cp!.source_agent_id).toBe(agentId);
      expect(cp!.synced_at).toBeTruthy();
    });

    it('should create a checkpoint with minimal fields', () => {
      const cp = trajectoryDAL.createTrajectoryCheckpoint({
        session_resource_id: sessionId1,
        checkpoint_id: 'chk_minimal',
        commit_hash: 'def456',
        agent: 'minimal-agent',
      });

      expect(cp).not.toBeNull();
      expect(cp!.branch).toBeNull();
      expect(cp!.files_touched).toEqual([]);
      expect(cp!.checkpoints_count).toBe(0);
      expect(cp!.token_usage).toBeNull();
      expect(cp!.summary).toBeNull();
      expect(cp!.attribution).toBeNull();
      expect(cp!.source_swarm_id).toBeNull();
      expect(cp!.source_agent_id).toBeNull();
    });

    it('should dedup on (session_resource_id, checkpoint_id)', () => {
      const cp1 = trajectoryDAL.createTrajectoryCheckpoint({
        session_resource_id: sessionId1,
        checkpoint_id: 'chk_dedup',
        commit_hash: 'hash_v1',
        agent: 'agent-v1',
      });

      const cp2 = trajectoryDAL.createTrajectoryCheckpoint({
        session_resource_id: sessionId1,
        checkpoint_id: 'chk_dedup', // same checkpoint_id + session
        commit_hash: 'hash_v2',
        agent: 'agent-v2',
      });

      expect(cp1).not.toBeNull();
      expect(cp2).toBeNull(); // INSERT OR IGNORE
    });

    it('should allow same checkpoint_id across different sessions', () => {
      const cp1 = trajectoryDAL.createTrajectoryCheckpoint({
        session_resource_id: sessionId1,
        checkpoint_id: 'chk_cross_session',
        commit_hash: 'hash_s1',
        agent: 'agent-s1',
      });

      const cp2 = trajectoryDAL.createTrajectoryCheckpoint({
        session_resource_id: sessionId2,
        checkpoint_id: 'chk_cross_session', // same checkpoint_id, different session
        commit_hash: 'hash_s2',
        agent: 'agent-s2',
      });

      expect(cp1).not.toBeNull();
      expect(cp2).not.toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getTrajectoryCheckpoint
  // ═══════════════════════════════════════════════════════════════

  describe('getTrajectoryCheckpoint', () => {
    it('should get a checkpoint by ID', () => {
      const created = trajectoryDAL.createTrajectoryCheckpoint({
        session_resource_id: sessionId1,
        checkpoint_id: 'chk_get_test',
        commit_hash: 'get_hash',
        agent: 'get-agent',
      });

      const fetched = trajectoryDAL.getTrajectoryCheckpoint(created!.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created!.id);
      expect(fetched!.agent).toBe('get-agent');
    });

    it('should return null for non-existent ID', () => {
      const fetched = trajectoryDAL.getTrajectoryCheckpoint('nonexistent');
      expect(fetched).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // listCheckpointsForSession
  // ═══════════════════════════════════════════════════════════════

  describe('listCheckpointsForSession', () => {
    beforeAll(() => {
      // Create several checkpoints for session2 for pagination testing
      for (let i = 0; i < 5; i++) {
        trajectoryDAL.createTrajectoryCheckpoint({
          session_resource_id: sessionId2,
          checkpoint_id: `chk_page_${i}`,
          commit_hash: `page_hash_${i}`,
          agent: `agent_${i}`,
          token_usage: { input_tokens: 100 * (i + 1), output_tokens: 50 * (i + 1) },
          files_touched: [`file_${i}.ts`],
        });
      }
    });

    it('should list checkpoints for a session', () => {
      const result = trajectoryDAL.listCheckpointsForSession(sessionId2);
      expect(result.data.length).toBeGreaterThanOrEqual(5);
      expect(result.total).toBeGreaterThanOrEqual(5);
    });

    it('should order by synced_at DESC', () => {
      const result = trajectoryDAL.listCheckpointsForSession(sessionId2, 50, 0);

      for (let i = 0; i < result.data.length - 1; i++) {
        const curr = new Date(result.data[i].synced_at).getTime();
        const next = new Date(result.data[i + 1].synced_at).getTime();
        expect(curr).toBeGreaterThanOrEqual(next);
      }
    });

    it('should respect limit', () => {
      const result = trajectoryDAL.listCheckpointsForSession(sessionId2, 2, 0);
      expect(result.data.length).toBe(2);
      expect(result.total).toBeGreaterThanOrEqual(5);
    });

    it('should respect offset', () => {
      const page1 = trajectoryDAL.listCheckpointsForSession(sessionId2, 2, 0);
      const page2 = trajectoryDAL.listCheckpointsForSession(sessionId2, 2, 2);

      expect(page1.data[0].id).not.toBe(page2.data[0].id);
    });

    it('should return empty for unknown session', () => {
      const result = trajectoryDAL.listCheckpointsForSession('nonexistent_session');
      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // getSessionStats
  // ═══════════════════════════════════════════════════════════════

  describe('getSessionStats', () => {
    it('should aggregate stats for a session', () => {
      const stats = trajectoryDAL.getSessionStats(sessionId2);

      // 5+ checkpoints created in the beforeAll above + 1 from cross-session test
      expect(stats.total_checkpoints).toBeGreaterThanOrEqual(5);
      expect(stats.latest_agent).toBeTruthy();
      expect(stats.first_synced_at).toBeTruthy();
      expect(stats.last_synced_at).toBeTruthy();
    });

    it('should sum token usage across checkpoints', () => {
      const stats = trajectoryDAL.getSessionStats(sessionId2);

      // Checkpoints 0..4 have input_tokens: 100*(i+1), output_tokens: 50*(i+1)
      // Sum input: 100+200+300+400+500 = 1500
      // Sum output: 50+100+150+200+250 = 750
      expect(stats.total_input_tokens).toBeGreaterThanOrEqual(1500);
      expect(stats.total_output_tokens).toBeGreaterThanOrEqual(750);
    });

    it('should deduplicate files across checkpoints', () => {
      // Create a dedicated session for this test
      const s = resourcesDAL.createResource({
        resource_type: 'session',
        name: 'dedup-files-session',
        git_remote_url: 'local://test/dedup',
        owner_agent_id: agentId,
      });

      trajectoryDAL.createTrajectoryCheckpoint({
        session_resource_id: s.id,
        checkpoint_id: 'dedup_a',
        commit_hash: 'ha',
        agent: 'a',
        files_touched: ['shared.ts', 'only_a.ts'],
      });

      trajectoryDAL.createTrajectoryCheckpoint({
        session_resource_id: s.id,
        checkpoint_id: 'dedup_b',
        commit_hash: 'hb',
        agent: 'b',
        files_touched: ['shared.ts', 'only_b.ts'],
      });

      const stats = trajectoryDAL.getSessionStats(s.id);
      expect(stats.total_files_touched).toBe(3); // shared.ts, only_a.ts, only_b.ts
    });

    it('should return zeros for session with no checkpoints', () => {
      const s = resourcesDAL.createResource({
        resource_type: 'session',
        name: 'empty-session',
        git_remote_url: 'local://test/empty',
        owner_agent_id: agentId,
      });

      const stats = trajectoryDAL.getSessionStats(s.id);
      expect(stats.total_checkpoints).toBe(0);
      expect(stats.total_input_tokens).toBe(0);
      expect(stats.total_output_tokens).toBe(0);
      expect(stats.total_files_touched).toBe(0);
      expect(stats.latest_agent).toBeNull();
      expect(stats.first_synced_at).toBeNull();
      expect(stats.last_synced_at).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // listAllSessions
  // ═══════════════════════════════════════════════════════════════

  describe('listAllSessions', () => {
    it('should list all session resources with checkpoint stats', () => {
      const result = trajectoryDAL.listAllSessions(50, 0);

      expect(result.data.length).toBeGreaterThanOrEqual(2);
      expect(result.total).toBeGreaterThanOrEqual(2);

      for (const item of result.data) {
        expect(item.id).toBeTruthy();
        expect(item.name).toBeTruthy();
        expect(item.visibility).toBeTruthy();
        expect(item.owner_agent_id).toBeTruthy();
        expect(typeof item.total_checkpoints).toBe('number');
        expect(typeof item.total_input_tokens).toBe('number');
        expect(typeof item.total_output_tokens).toBe('number');
      }
    });

    it('should include sessions with zero checkpoints', () => {
      const result = trajectoryDAL.listAllSessions(100, 0);
      const empty = result.data.find((s) => s.name === 'empty-session');
      expect(empty).toBeDefined();
      expect(empty!.total_checkpoints).toBe(0);
    });

    it('should include sessions with checkpoints', () => {
      const result = trajectoryDAL.listAllSessions(100, 0);
      const active = result.data.find((s) => s.name === 'session-beta');
      expect(active).toBeDefined();
      expect(active!.total_checkpoints).toBeGreaterThanOrEqual(5);
      expect(active!.total_input_tokens).toBeGreaterThan(0);
    });

    it('should respect pagination', () => {
      const page1 = trajectoryDAL.listAllSessions(2, 0);
      const page2 = trajectoryDAL.listAllSessions(2, 2);

      expect(page1.data.length).toBeLessThanOrEqual(2);
      if (page1.total > 2) {
        expect(page2.data.length).toBeGreaterThan(0);
        expect(page1.data[0].id).not.toBe(page2.data[0].id);
      }
    });
  });
});
