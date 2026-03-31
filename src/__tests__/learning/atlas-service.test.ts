import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { createAgent } from '../../db/dal/agents.js';
import { AtlasService } from '../../learning/atlas-service.js';
import { ConfigSchema, type Config } from '../../config.js';
import * as path from 'path';
import * as fs from 'fs';

const TEST_ROOT = testRoot('learning-atlas');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'test.db');

function createTestConfig(overrides?: Partial<Config['learning']>): Config {
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    learning: {
      enabled: true,
      ...overrides,
    },
  });
}

describe('AtlasService', () => {
  let ownerAgentId: string;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    initDatabase(TEST_DB_PATH);
    const { agent } = await createAgent({ name: 'test-agent', description: 'test' });
    ownerAgentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('should initialize Atlas when learning is enabled', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    expect(svc.isAvailable()).toBe(true);
    expect(svc.getAtlas()).not.toBeNull();

    await svc.close();
    expect(svc.isAvailable()).toBe(false);
  });

  it('should not initialize when learning is disabled', async () => {
    const config = createTestConfig();
    config.learning.enabled = false;
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    expect(svc.isAvailable()).toBe(false);
    expect(svc.getAtlas()).toBeNull();

    await svc.close();
  });

  it('should create storage directories on init', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    const baseDir = svc.getBaseDir();
    expect(fs.existsSync(baseDir)).toBe(true);
    expect(fs.existsSync(path.join(baseDir, '.skilltree'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'knowledge'))).toBe(true);

    await svc.close();
  });

  it('should return stats when available', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    const stats = await svc.getStats();
    expect(stats).toBeDefined();
    expect(stats).toHaveProperty('memory');
    expect(stats).toHaveProperty('learning');

    await svc.close();
  });

  it('should throw when calling getStats on unavailable service', async () => {
    const config = createTestConfig();
    config.learning.enabled = false;
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    await expect(svc.getStats()).rejects.toThrow('Learning engine is not available');

    await svc.close();
  });

  it('should process a trajectory and return result', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    // Create a minimal trajectory (cognitive-core's createTrajectory helper)
    const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');

    const trajectory = createTrajectory({
      task: createTask({
        domain: 'test',
        description: 'Test task for integration test',
      }),
      steps: [
        createStep({
          action: 'read file',
          observation: 'file contents: hello world',
        }),
      ],
      outcome: successOutcome('done'),
      agentId: 'test-agent',
    });

    const result = await svc.processTrajectory(trajectory);
    expect(result).not.toBeNull();

    // Verify experience was stored by checking stats
    const stats = await svc.getStats() as { memory: { experienceCount: number } };
    expect(stats.memory.experienceCount).toBeGreaterThanOrEqual(1);

    await svc.close();
  });

  it('should trigger batch learning', async () => {
    const config = createTestConfig({
      atlas: { minTrajectories: 1 },
    });
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    // Feed a trajectory first
    const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');
    const trajectory = createTrajectory({
      task: createTask({ domain: 'test', description: 'Batch test' }),
      steps: [createStep({ action: 'test action', observation: 'test result' })],
      outcome: successOutcome('done'),
      agentId: 'test-agent',
    });
    await svc.processTrajectory(trajectory);

    // Run batch learning (should not throw even with minimal data)
    const result = await svc.runBatchLearning();
    expect(result).toBeDefined();

    await svc.close();
  });

  it('should gracefully degrade on init failure', async () => {
    const config = createTestConfig();
    // Corrupt the config to cause init failure
    (config.learning.atlas as any).embedding = { provider: 'nonexistent' as any };
    const svc = new AtlasService(config, ownerAgentId);

    // Should not throw — just logs warning and sets atlas to null
    await svc.init();

    // May or may not fail depending on cognitive-core validation
    // Either way, calling operations should be safe
    if (!svc.isAvailable()) {
      expect(svc.getAtlas()).toBeNull();
      const result = await svc.processTrajectory({} as any);
      expect(result).toBeNull();
    }

    await svc.close();
  });
});
