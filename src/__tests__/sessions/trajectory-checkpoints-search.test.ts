/**
 * Tests for listAllSessions search and source_swarm_id features.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as trajectoryDAL from '../../db/dal/trajectory-checkpoints.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('trajectory-checkpoints-search');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'trajectory-search.db');

describe('listAllSessions search and source_swarm_id', () => {
  let agentId: string;
  let sessionProjectA: string;
  let sessionProjectB: string;
  let sessionNoCheckpoints: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);

    const { agent } = await agentsDAL.createAgent({
      name: 'search-test-agent',
      description: 'Agent for search tests',
    });
    agentId = agent.id;

    // Session with checkpoints from swarm-1, agent "alice"
    const s1 = resourcesDAL.createResource({
      resource_type: 'session',
      name: 'my-frontend-project (main)',
      git_remote_url: 'local://test/frontend',
      owner_agent_id: agentId,
    });
    sessionProjectA = s1.id;

    trajectoryDAL.createTrajectoryCheckpoint({
      session_resource_id: sessionProjectA,
      checkpoint_id: 'search_a1',
      commit_hash: 'aaa111',
      agent: 'alice',
      source_swarm_id: 'swarm-1',
      source_agent_id: agentId,
      token_usage: { input_tokens: 100, output_tokens: 50 },
    });

    // Session with checkpoints from swarm-2, agent "bob"
    const s2 = resourcesDAL.createResource({
      resource_type: 'session',
      name: 'backend-api (develop)',
      git_remote_url: 'local://test/backend',
      owner_agent_id: agentId,
    });
    sessionProjectB = s2.id;

    trajectoryDAL.createTrajectoryCheckpoint({
      session_resource_id: sessionProjectB,
      checkpoint_id: 'search_b1',
      commit_hash: 'bbb222',
      agent: 'bob',
      source_swarm_id: 'swarm-2',
      source_agent_id: agentId,
      token_usage: { input_tokens: 200, output_tokens: 100 },
    });

    // Session with no checkpoints
    const s3 = resourcesDAL.createResource({
      resource_type: 'session',
      name: 'empty-project',
      git_remote_url: 'local://test/empty',
      owner_agent_id: agentId,
    });
    sessionNoCheckpoints = s3.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ═══════════════════════════════════════════════════════════════
  // source_swarm_id
  // ═══════════════════════════════════════════════════════════════

  describe('source_swarm_id in results', () => {
    it('should include source_swarm_id from the latest checkpoint', () => {
      const result = trajectoryDAL.listAllSessions(50, 0);
      const s = result.data.find((s) => s.id === sessionProjectA);
      expect(s).toBeDefined();
      expect(s!.source_swarm_id).toBe('swarm-1');
    });

    it('should return null source_swarm_id for sessions with no checkpoints', () => {
      const result = trajectoryDAL.listAllSessions(50, 0);
      const s = result.data.find((s) => s.id === sessionNoCheckpoints);
      expect(s).toBeDefined();
      expect(s!.source_swarm_id).toBeNull();
    });

    it('should return a non-null source_swarm_id when checkpoints exist', () => {
      // Add another checkpoint from a different swarm
      trajectoryDAL.createTrajectoryCheckpoint({
        session_resource_id: sessionProjectA,
        checkpoint_id: 'search_a2',
        commit_hash: 'aaa222',
        agent: 'alice',
        source_swarm_id: 'swarm-3',
        source_agent_id: agentId,
      });

      const result = trajectoryDAL.listAllSessions(50, 0);
      const s = result.data.find((s) => s.id === sessionProjectA);
      // Should be one of the swarm IDs from existing checkpoints
      expect(['swarm-1', 'swarm-3']).toContain(s!.source_swarm_id);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // search
  // ═══════════════════════════════════════════════════════════════

  describe('search parameter', () => {
    it('should filter sessions by name', () => {
      const result = trajectoryDAL.listAllSessions(50, 0, undefined, 'frontend');
      expect(result.data.length).toBe(1);
      expect(result.data[0].name).toContain('frontend');
      expect(result.total).toBe(1);
    });

    it('should filter sessions by agent name', () => {
      const result = trajectoryDAL.listAllSessions(50, 0, undefined, 'bob');
      expect(result.data.length).toBe(1);
      expect(result.data[0].id).toBe(sessionProjectB);
      expect(result.total).toBe(1);
    });

    it('should be case-insensitive for session name', () => {
      const result = trajectoryDAL.listAllSessions(50, 0, undefined, 'BACKEND');
      expect(result.data.length).toBe(1);
      expect(result.data[0].id).toBe(sessionProjectB);
    });

    it('should return empty for non-matching search', () => {
      const result = trajectoryDAL.listAllSessions(50, 0, undefined, 'nonexistent-xyz');
      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should return all sessions when search is undefined', () => {
      const result = trajectoryDAL.listAllSessions(50, 0);
      expect(result.data.length).toBeGreaterThanOrEqual(3);
    });

    it('should combine search with pagination', () => {
      // All sessions match "project"
      const page1 = trajectoryDAL.listAllSessions(1, 0, undefined, 'project');
      expect(page1.data.length).toBe(1);
      expect(page1.total).toBeGreaterThanOrEqual(2);

      const page2 = trajectoryDAL.listAllSessions(1, 1, undefined, 'project');
      expect(page2.data.length).toBe(1);
      expect(page2.data[0].id).not.toBe(page1.data[0].id);
    });

    it('should combine search with swarm filter', () => {
      const result = trajectoryDAL.listAllSessions(50, 0, 'swarm-2', 'backend');
      expect(result.data.length).toBe(1);
      expect(result.data[0].id).toBe(sessionProjectB);

      // swarm-1 + backend name = no match
      const empty = trajectoryDAL.listAllSessions(50, 0, 'swarm-1', 'backend');
      expect(empty.data.length).toBe(0);
    });
  });
});
