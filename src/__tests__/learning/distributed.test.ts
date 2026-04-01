import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { createAgent } from '../../db/dal/agents.js';
import { AtlasService } from '../../learning/atlas-service.js';
import { DistributedLearningCoordinator } from '../../learning/distributed.js';
import { ConfigSchema, type Config } from '../../config.js';

const TEST_ROOT = testRoot('learning-distributed');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'test.db');

function createTestConfig(distributed?: Partial<Config['learning']['distributed']>): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    learning: {
      enabled: true,
      distributed: distributed || { mode: 'local' },
    },
  });
}

describe('DistributedLearningCoordinator', () => {
  let ownerAgentId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    const { agent } = await createAgent({ name: 'dist-test', description: 'test' });
    ownerAgentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  describe('local mode', () => {
    it('should resolve all domains to local', async () => {
      const config = createTestConfig({ mode: 'local' });
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      const coordinator = new DistributedLearningCoordinator(config, svc);
      expect(coordinator.getMode()).toBe('local');
      expect(coordinator.resolveTarget('any-domain')).toBe('local');
      expect(coordinator.resolveTarget('code')).toBe('local');

      await svc.close();
    });

    it('should report local status', async () => {
      const config = createTestConfig({ mode: 'local' });
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      const coordinator = new DistributedLearningCoordinator(config, svc);
      const status = await coordinator.getStatus();

      expect(status.mode).toBe('local');
      expect(status.local_processing).toBe(true);
      expect(status.health.local_atlas_available).toBe(true);

      await svc.close();
    });
  });

  describe('centralized mode', () => {
    it('should resolve all domains to learning hive URL', async () => {
      const config = createTestConfig({
        mode: 'centralized',
        learningHiveUrl: 'https://learning-hive.example.com',
      });
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      const coordinator = new DistributedLearningCoordinator(config, svc);
      expect(coordinator.getMode()).toBe('centralized');
      expect(coordinator.resolveTarget('code')).toBe('https://learning-hive.example.com');
      expect(coordinator.resolveTarget('deployment')).toBe('https://learning-hive.example.com');

      await svc.close();
    });

    it('should fallback to local if no learningHiveUrl configured', async () => {
      const config = createTestConfig({
        mode: 'centralized',
        learningHiveUrl: null,
      });
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      const coordinator = new DistributedLearningCoordinator(config, svc);
      expect(coordinator.resolveTarget('code')).toBe('local');

      await svc.close();
    });

    it('should report centralized status with forwarding URL', async () => {
      const config = createTestConfig({
        mode: 'centralized',
        learningHiveUrl: 'https://learning-hive.example.com',
      });
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      const coordinator = new DistributedLearningCoordinator(config, svc);
      const status = await coordinator.getStatus();

      expect(status.mode).toBe('centralized');
      expect(status.forwarding_to).toBe('https://learning-hive.example.com');
      // Remote won't be reachable in test
      expect(status.health.remote_hive_reachable).toBe(false);

      await svc.close();
    });
  });

  describe('domain-partitioned mode', () => {
    it('should route domains to configured hive URLs', async () => {
      const config = createTestConfig({
        mode: 'domain-partitioned',
        domainRouting: {
          'deployment': 'https://deploy-hive.example.com',
          'debugging': 'https://debug-hive.example.com',
        },
      });
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      const coordinator = new DistributedLearningCoordinator(config, svc);
      expect(coordinator.getMode()).toBe('domain-partitioned');
      expect(coordinator.resolveTarget('deployment')).toBe('https://deploy-hive.example.com');
      expect(coordinator.resolveTarget('debugging')).toBe('https://debug-hive.example.com');

      await svc.close();
    });

    it('should route unmatched domains to local', async () => {
      const config = createTestConfig({
        mode: 'domain-partitioned',
        domainRouting: {
          'deployment': 'https://deploy-hive.example.com',
        },
      });
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      const coordinator = new DistributedLearningCoordinator(config, svc);
      expect(coordinator.resolveTarget('code')).toBe('local');
      expect(coordinator.resolveTarget('unknown')).toBe('local');

      await svc.close();
    });

    it('should report domain routing in status', async () => {
      const config = createTestConfig({
        mode: 'domain-partitioned',
        domainRouting: {
          'deployment': 'https://deploy-hive.example.com',
          'debugging': 'https://debug-hive.example.com',
        },
      });
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      const coordinator = new DistributedLearningCoordinator(config, svc);
      const status = await coordinator.getStatus();

      expect(status.mode).toBe('domain-partitioned');
      expect(status.domain_routing).toEqual({
        'deployment': 'https://deploy-hive.example.com',
        'debugging': 'https://debug-hive.example.com',
      });

      await svc.close();
    });
  });

  describe('forwarding', () => {
    it('should handle unreachable remote gracefully', async () => {
      const config = createTestConfig({
        mode: 'centralized',
        learningHiveUrl: 'http://127.0.0.1:99999',
      });
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      const coordinator = new DistributedLearningCoordinator(config, svc);
      const result = await coordinator.forwardTrajectory(
        { task: { domain: 'test' } },
        'http://127.0.0.1:99999',
      );

      expect(result).toBe(false);

      const status = await coordinator.getStatus();
      expect(status.health.last_forward_error).toBeDefined();

      await svc.close();
    });
  });

  describe('Atlas integration', () => {
    it('should include distributed status in detailed status', async () => {
      const config = createTestConfig({
        mode: 'centralized',
        learningHiveUrl: 'https://learning-hive.example.com',
      });
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      const status = await svc.getDetailedStatus();
      expect(status.distributed).toBeDefined();
      expect(status.distributed!.mode).toBe('centralized');
      expect(status.distributed!.forwarding_to).toBe('https://learning-hive.example.com');

      await svc.close();
    });

    it('should show local mode when distributed is not configured', async () => {
      const config = createTestConfig({ mode: 'local' });
      const svc = new AtlasService(config, ownerAgentId);
      await svc.init();

      const status = await svc.getDetailedStatus();
      expect(status.distributed).toBeDefined();
      expect(status.distributed!.mode).toBe('local');
      expect(status.distributed!.local_processing).toBe(true);

      await svc.close();
    });
  });
});
