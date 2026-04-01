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

function createTestConfig(overrides?: Record<string, unknown>): Config {
  const learning: Record<string, unknown> = { enabled: true };
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      learning[k] = v;
    }
  }
  return ConfigSchema.parse({
    database: TEST_DB_PATH,
    instance: { name: 'Test', description: 'Test' },
    admin: { createOnStartup: false },
    auth: { mode: 'local' },
    rateLimit: { enabled: false },
    learning,
  });
}

describe('AtlasService', () => {
  let ownerAgentId: string;

  const originalHome = process.env.OPENHIVE_HOME;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    initDatabase(TEST_DB_PATH);
    const { agent } = await createAgent({ name: 'test-agent', description: 'test' });
    ownerAgentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    if (originalHome) process.env.OPENHIVE_HOME = originalHome;
    else delete process.env.OPENHIVE_HOME;
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

  it('should record activity log entries on processTrajectory', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');
    const trajectory = createTrajectory({
      task: createTask({ domain: 'activity-test', description: 'Activity log test' }),
      steps: [createStep({ action: 'test', observation: 'result' })],
      outcome: successOutcome('done'),
      agentId: 'test-agent',
    });

    await svc.processTrajectory(trajectory);

    const { data, total } = svc.getActivityLog();
    expect(total).toBeGreaterThanOrEqual(1);
    const instant = data.find(e => e.type === 'instant');
    expect(instant).toBeDefined();
    expect(instant!.summary).toBe('Trajectory processed');
    expect(instant!.data).toHaveProperty('domain', 'activity-test');
    expect(instant!.data).toHaveProperty('outcome', 'success');

    await svc.close();
  });

  it('should record activity log entries on batch learning', async () => {
    const config = createTestConfig({ atlas: { minTrajectories: 1 } });
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');
    await svc.processTrajectory(createTrajectory({
      task: createTask({ domain: 'test', description: 'Batch activity test' }),
      steps: [createStep({ action: 'a', observation: 'b' })],
      outcome: successOutcome('done'),
      agentId: 'test',
    }));

    await svc.runBatchLearning();

    const { data } = svc.getActivityLog();
    const batch = data.find(e => e.type === 'batch');
    expect(batch).toBeDefined();
    expect(batch!.summary).toBe('Batch learning completed');

    await svc.close();
  });

  it('should respect activity log pagination', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');
    // Feed 3 trajectories
    for (let i = 0; i < 3; i++) {
      await svc.processTrajectory(createTrajectory({
        task: createTask({ domain: 'test', description: `Pagination test ${i}` }),
        steps: [createStep({ action: 'a', observation: 'b' })],
        outcome: successOutcome('done'),
        agentId: 'test',
      }));
    }

    const all = svc.getActivityLog(100);
    expect(all.total).toBeGreaterThanOrEqual(3);

    const page = svc.getActivityLog(2, 0);
    expect(page.data.length).toBe(2);

    const page2 = svc.getActivityLog(2, 2);
    expect(page2.data.length).toBeGreaterThanOrEqual(1);

    await svc.close();
  });

  it('should return detailed status with session bank info', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    const status = await svc.getDetailedStatus();
    expect(status.available).toBe(true);
    expect(status).toHaveProperty('session_banks');
    expect(status).toHaveProperty('maintenance');
    expect(status.maintenance.scheduled).toBe(true);
    expect(status.maintenance).toHaveProperty('schedule');

    await svc.close();
  });

  it('should not start maintenance scheduler when autoRun is false', async () => {
    const config = createTestConfig();
    config.learning.maintenance.autoRun = false;
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    const status = await svc.getDetailedStatus();
    expect(status.maintenance.scheduled).toBe(false);

    await svc.close();
  });

  it('should parse schedule hour correctly', async () => {
    const config = createTestConfig();
    config.learning.maintenance.schedule = '0 15 * * *'; // 3pm
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    const status = await svc.getDetailedStatus();
    expect(status.maintenance.scheduled).toBe(true);
    expect(status.maintenance.schedule).toBe('0 15 * * *');

    await svc.close();
  });

  it('should evict old entries when activity log exceeds 200', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    const { createTrajectory, createTask, createStep, successOutcome } = await import('cognitive-core');

    // Feed 210 trajectories to fill the activity log beyond capacity
    for (let i = 0; i < 210; i++) {
      await svc.processTrajectory(createTrajectory({
        task: createTask({ domain: 'overflow', description: `overflow-${i}` }),
        steps: [createStep({ action: 'a', observation: 'b' })],
        outcome: successOutcome('done'),
        agentId: 'test',
      }));
    }

    const { data, total } = svc.getActivityLog(300);
    // Should be capped at 200
    expect(total).toBeLessThanOrEqual(200);
    expect(data.length).toBeLessThanOrEqual(200);

    // Most recent entry should be the last one processed
    const newest = data[0];
    expect(newest.type).toBe('instant');

    await svc.close();
  });

  it('should clean up event listener and timer on close', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();
    expect(svc.isAvailable()).toBe(true);

    await svc.close();
    expect(svc.isAvailable()).toBe(false);

    // Double-close should be safe
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
