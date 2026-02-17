import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as hivesDAL from '../../db/dal/hives.js';
import * as dal from '../../swarm/dal.js';

const TEST_DB_PATH = './test-data/swarm-dal-test.db';

function cleanupTestData() {
  if (fs.existsSync(TEST_DB_PATH)) {
    fs.unlinkSync(TEST_DB_PATH);
  }
}

describe('Swarm DAL', () => {
  let testAgentId: string;
  let testAgentApiKey: string;

  beforeAll(async () => {
    cleanupTestData();
    const dir = path.dirname(TEST_DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    initDatabase(TEST_DB_PATH);

    // Create a test agent
    const result = await agentsDAL.createAgent({
      name: 'swarm-test-agent',
      description: 'Agent for swarm DAL tests',
    });
    testAgentId = result.agent.id;
    testAgentApiKey = result.apiKey;
  });

  afterAll(() => {
    closeDatabase();
    cleanupTestData();
  });

  describe('createHostedSwarm', () => {
    it('should create a hosted swarm record', () => {
      const hosted = dal.createHostedSwarm({
        provider: 'local',
        spawned_by: testAgentId,
        assigned_port: 9001,
        bootstrap_token_hash: 'abc123hash',
        config: {
          name: 'test-swarm',
          adapter: 'macro-agent',
          bootstrap_token: 'token123',
          assigned_port: 9001,
          data_dir: '/tmp/test-swarm',
        },
      });

      expect(hosted).toBeDefined();
      expect(hosted.id).toMatch(/^hswarm_/);
      expect(hosted.provider).toBe('local');
      expect(hosted.state).toBe('provisioning');
      expect(hosted.spawned_by).toBe(testAgentId);
      expect(hosted.assigned_port).toBe(9001);
      expect(hosted.bootstrap_token_hash).toBe('abc123hash');
      expect(hosted.config).toBeDefined();
      expect(hosted.config!.name).toBe('test-swarm');
      expect(hosted.config!.adapter).toBe('macro-agent');
    });

    it('should create multiple hosted swarms', () => {
      const hosted1 = dal.createHostedSwarm({
        provider: 'local',
        spawned_by: testAgentId,
        assigned_port: 9002,
      });
      const hosted2 = dal.createHostedSwarm({
        provider: 'docker',
        spawned_by: testAgentId,
        assigned_port: 9003,
      });

      expect(hosted1.id).not.toBe(hosted2.id);
      expect(hosted1.provider).toBe('local');
      expect(hosted2.provider).toBe('docker');
    });
  });

  describe('findHostedSwarmById', () => {
    it('should find an existing hosted swarm', () => {
      const created = dal.createHostedSwarm({
        provider: 'local',
        spawned_by: testAgentId,
        assigned_port: 9010,
      });

      const found = dal.findHostedSwarmById(created.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
      expect(found!.provider).toBe('local');
    });

    it('should return null for non-existent ID', () => {
      const found = dal.findHostedSwarmById('hswarm_nonexistent');
      expect(found).toBeNull();
    });
  });

  describe('findHostedSwarmByBootstrapHash', () => {
    it('should find by bootstrap token hash', () => {
      const created = dal.createHostedSwarm({
        provider: 'local',
        spawned_by: testAgentId,
        bootstrap_token_hash: 'unique_hash_123',
      });

      const found = dal.findHostedSwarmByBootstrapHash('unique_hash_123');
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);
    });

    it('should return null for non-existent hash', () => {
      const found = dal.findHostedSwarmByBootstrapHash('nonexistent_hash');
      expect(found).toBeNull();
    });
  });

  describe('updateHostedSwarm', () => {
    it('should update state', () => {
      const created = dal.createHostedSwarm({
        provider: 'local',
        spawned_by: testAgentId,
      });

      const updated = dal.updateHostedSwarm(created.id, { state: 'running' });
      expect(updated).toBeDefined();
      expect(updated!.state).toBe('running');
    });

    it('should update multiple fields at once', () => {
      const created = dal.createHostedSwarm({
        provider: 'local',
        spawned_by: testAgentId,
      });

      const updated = dal.updateHostedSwarm(created.id, {
        state: 'running',
        pid: 12345,
        endpoint: 'ws://127.0.0.1:9001',
        error: null,
      });

      expect(updated!.state).toBe('running');
      expect(updated!.pid).toBe(12345);
      expect(updated!.endpoint).toBe('ws://127.0.0.1:9001');
      expect(updated!.error).toBeNull();
    });

    it('should update error field', () => {
      const created = dal.createHostedSwarm({
        provider: 'local',
        spawned_by: testAgentId,
      });

      const updated = dal.updateHostedSwarm(created.id, {
        state: 'failed',
        error: 'Process exited with code 1',
      });

      expect(updated!.state).toBe('failed');
      expect(updated!.error).toBe('Process exited with code 1');
    });

    it('should return null for non-existent ID', () => {
      const updated = dal.updateHostedSwarm('hswarm_nonexistent', { state: 'stopped' });
      expect(updated).toBeNull();
    });
  });

  describe('listHostedSwarms', () => {
    let listAgentId: string;

    beforeAll(async () => {
      const result = await agentsDAL.createAgent({
        name: 'list-test-agent',
        description: 'Agent for list tests',
      });
      listAgentId = result.agent.id;

      // Create swarms with different states and providers
      const s1 = dal.createHostedSwarm({ provider: 'local', spawned_by: listAgentId });
      dal.updateHostedSwarm(s1.id, { state: 'running' });

      const s2 = dal.createHostedSwarm({ provider: 'local', spawned_by: listAgentId });
      dal.updateHostedSwarm(s2.id, { state: 'stopped' });

      const s3 = dal.createHostedSwarm({ provider: 'docker', spawned_by: listAgentId });
      dal.updateHostedSwarm(s3.id, { state: 'running' });
    });

    it('should list all hosted swarms', () => {
      const result = dal.listHostedSwarms();
      expect(result.data.length).toBeGreaterThan(0);
      expect(result.total).toBeGreaterThan(0);
    });

    it('should filter by state', () => {
      const result = dal.listHostedSwarms({ state: 'running', spawned_by: listAgentId });
      expect(result.data.length).toBe(2);
      result.data.forEach((s) => expect(s.state).toBe('running'));
    });

    it('should filter by provider', () => {
      const result = dal.listHostedSwarms({ provider: 'docker', spawned_by: listAgentId });
      expect(result.data.length).toBe(1);
      expect(result.data[0].provider).toBe('docker');
    });

    it('should filter by spawned_by', () => {
      const result = dal.listHostedSwarms({ spawned_by: listAgentId });
      expect(result.data.length).toBe(3);
      result.data.forEach((s) => expect(s.spawned_by).toBe(listAgentId));
    });

    it('should respect limit and offset', () => {
      const page1 = dal.listHostedSwarms({ spawned_by: listAgentId, limit: 2, offset: 0 });
      const page2 = dal.listHostedSwarms({ spawned_by: listAgentId, limit: 2, offset: 2 });

      expect(page1.data.length).toBe(2);
      expect(page2.data.length).toBe(1);
      expect(page1.total).toBe(3);
    });
  });

  describe('countActiveHostedSwarms', () => {
    it('should count non-stopped/non-failed swarms', () => {
      // We have multiple swarms from previous tests, some running, some stopped
      const count = dal.countActiveHostedSwarms();
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('getActiveHostedSwarms', () => {
    it('should return only active swarms', () => {
      const active = dal.getActiveHostedSwarms();
      active.forEach((s) => {
        expect(['provisioning', 'starting', 'running', 'unhealthy']).toContain(s.state);
      });
    });
  });

  describe('deleteHostedSwarm', () => {
    it('should delete a hosted swarm', () => {
      const created = dal.createHostedSwarm({
        provider: 'local',
        spawned_by: testAgentId,
      });

      const deleted = dal.deleteHostedSwarm(created.id);
      expect(deleted).toBe(true);

      const found = dal.findHostedSwarmById(created.id);
      expect(found).toBeNull();
    });

    it('should return false for non-existent ID', () => {
      const deleted = dal.deleteHostedSwarm('hswarm_nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('findHostedSwarmBySwarmId', () => {
    it('should find by MAP swarm ID when a real swarm exists', () => {
      // Create a real MAP swarm first so FK constraint is satisfied
      const db = getDatabase();
      const swarmId = 'swarm_dal_test_' + Date.now();
      db.prepare(`
        INSERT INTO map_swarms (id, name, map_endpoint, owner_agent_id)
        VALUES (?, ?, ?, ?)
      `).run(swarmId, 'test-swarm', 'ws://localhost:9999', testAgentId);

      const created = dal.createHostedSwarm({
        provider: 'local',
        spawned_by: testAgentId,
      });
      dal.updateHostedSwarm(created.id, { swarm_id: swarmId });

      const found = dal.findHostedSwarmBySwarmId(swarmId);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.id);

      // Cleanup
      db.prepare('DELETE FROM map_swarms WHERE id = ?').run(swarmId);
    });

    it('should return null when swarm_id not linked', () => {
      const found = dal.findHostedSwarmBySwarmId('map_swarm_nonexistent');
      expect(found).toBeNull();
    });
  });
});
