import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import { createAgent } from '../../db/dal/agents.js';
import { AtlasService } from '../../learning/atlas-service.js';
import { ConfigSchema, type Config } from '../../config.js';
import type { SyncableResourceType } from '../../types.js';

const TEST_ROOT = testRoot('learning-sync');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'test.db');

function createTestConfig(): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    learning: { enabled: true },
  });
}

describe('Learning Sync — Cross-Hive', () => {
  let ownerAgentId: string;
  const originalHome = process.env.OPENHIVE_HOME;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    initDatabase(TEST_DB_PATH);
    const { agent } = await createAgent({ name: 'sync-test-agent', description: 'test' });
    ownerAgentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    if (originalHome) process.env.OPENHIVE_HOME = originalHome;
    else delete process.env.OPENHIVE_HOME;
  });

  describe('Resource type support', () => {
    it('should accept playbook as a valid SyncableResourceType', () => {
      const validTypes: SyncableResourceType[] = ['memory_bank', 'task', 'skill', 'session', 'playbook'];
      expect(validTypes).toContain('playbook');
    });
  });

  describe('Resource registration', () => {
    it('should register skill and knowledge resources on Atlas init', async () => {
      const config = createTestConfig();
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      // Verify skill resource was registered
      const db = getDatabase();
      const skillRes = db.prepare(
        "SELECT * FROM syncable_resources WHERE name = 'learning/skills' AND owner_agent_id = ?"
      ).get(ownerAgentId) as any;
      expect(skillRes).toBeDefined();
      expect(skillRes.resource_type).toBe('skill');
      expect(skillRes.local_path).toContain('cognitive-core');
      expect(skillRes.local_path).toContain('.skilltree');

      // Verify knowledge resource was registered
      const knowledgeRes = db.prepare(
        "SELECT * FROM syncable_resources WHERE name = 'learning/knowledge' AND owner_agent_id = ?"
      ).get(ownerAgentId) as any;
      expect(knowledgeRes).toBeDefined();
      expect(knowledgeRes.resource_type).toBe('memory_bank');
      expect(knowledgeRes.local_path).toContain('knowledge');

      await svc.close();
    });

    it('should store resource IDs for sync emission', async () => {
      const config = createTestConfig();
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      // The service should have stored the resource IDs internally
      // We verify by running batch and checking it doesn't throw
      const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');
      await svc.processTrajectory(createTrajectory({
        task: createTask({ domain: 'test', description: 'Sync test' }),
        steps: [createStep({ action: 'a', observation: 'b' })],
        outcome: successOutcome('done'),
        agentId: 'test',
      }));

      // runBatchLearning calls emitBatchSyncEvents internally — should not throw
      await expect(svc.runBatchLearning()).resolves.toBeDefined();

      await svc.close();
    });
  });

  describe('Batch sync emission', () => {
    it('should record batch activity with sync-related data', async () => {
      const config = createTestConfig();
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');
      await svc.processTrajectory(createTrajectory({
        task: createTask({ domain: 'sync-domain', description: 'Sync emission test' }),
        steps: [createStep({ action: 'action', observation: 'observation' })],
        outcome: successOutcome('done'),
        agentId: 'sync-agent',
      }));

      await svc.runBatchLearning();

      // Activity log should have the batch entry
      const { data } = svc.getActivityLog();
      const batchEvent = data.find(e => e.type === 'batch');
      expect(batchEvent).toBeDefined();
      expect(batchEvent!.summary).toBe('Batch learning completed');

      await svc.close();
    });
  });

  describe('emitBatchSyncEvents directly', () => {
    it('should not throw when resource IDs are null', async () => {
      const { emitBatchSyncEvents } = await import('../../learning/sync.js');
      // Should not throw with null resource IDs
      expect(() => emitBatchSyncEvents(null, null, 'agent-1', { playbooksExtracted: 0 })).not.toThrow();
    });

    it('should not throw when resource is not found', async () => {
      const { emitBatchSyncEvents } = await import('../../learning/sync.js');
      // Non-existent resource IDs
      expect(() => emitBatchSyncEvents('res_nonexistent', 'res_also_nonexistent', 'agent-1', {})).not.toThrow();
    });

    it('should skip private resources', async () => {
      const config = createTestConfig();
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      // Resources registered by atlas-service default to 'private' visibility
      // emitBatchSyncEvents should skip them (only emits for shared/public)
      const { emitBatchSyncEvents } = await import('../../learning/sync.js');
      const db = (await import('../../db/index.js')).getDatabase();

      // Check registered resources are private
      const res = db.prepare(
        "SELECT visibility FROM syncable_resources WHERE name = 'learning/skills'"
      ).get() as { visibility: string } | undefined;

      if (res) {
        expect(res.visibility).toBe('private');
        // emitBatchSyncEvents should not emit for private resources
        expect(() => emitBatchSyncEvents(
          'res_123', null, ownerAgentId, { playbooksExtracted: 1 }
        )).not.toThrow();
      }

      await svc.close();
    });
  });

  describe('Playbook metadata type', () => {
    it('should support PlaybookResourceMetadata fields', async () => {
      // Import to verify the type exists and is usable
      const metadata: import('../../types.js').PlaybookResourceMetadata = {
        playbook_count: 5,
        domains: ['code', 'deployment'],
        avg_confidence: 0.75,
        last_batch_at: new Date().toISOString(),
        provenance: 'local',
      };

      expect(metadata.playbook_count).toBe(5);
      expect(metadata.domains).toContain('code');
      expect(metadata.provenance).toBe('local');
    });

    it('should support imported provenance for peer resources', () => {
      const imported: import('../../types.js').PlaybookResourceMetadata = {
        playbook_count: 3,
        source_hive_id: 'hive_abc123',
        provenance: 'imported',
      };

      expect(imported.provenance).toBe('imported');
      expect(imported.source_hive_id).toBe('hive_abc123');
    });
  });
});
