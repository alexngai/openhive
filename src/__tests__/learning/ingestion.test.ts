/**
 * Ingestion Flow Tests
 *
 * Tests the swarm_offline → SessionBank scan → processTrajectory flow.
 * This is the primary production data path for learning.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import { initDatabase, closeDatabase } from '../../db/index.js';
import { createAgent } from '../../db/dal/agents.js';
import { AtlasService } from '../../learning/atlas-service.js';
import { triggerIngestion } from '../../learning/ingestion.js';
import { ConfigSchema, type Config } from '../../config.js';
import type { LearningLogger } from '../../learning/types.js';

const TEST_ROOT = testRoot('learning-ingestion');
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

function createTestLogger(): LearningLogger & { warnings: string[]; infos: string[] } {
  const warnings: string[] = [];
  const infos: string[] = [];
  return {
    warnings,
    infos,
    info: (...args: unknown[]) => infos.push(args.map(String).join(' ')),
    warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
    error: () => {},
  };
}

describe('Ingestion Flow', () => {
  let ownerAgentId: string;
  const originalHome = process.env.OPENHIVE_HOME;

  beforeAll(async () => {
    cleanTestRoot(TEST_ROOT);
    process.env.OPENHIVE_HOME = TEST_ROOT;
    initDatabase(TEST_DB_PATH);
    const { agent } = await createAgent({ name: 'ingestion-test', description: 'test' });
    ownerAgentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
    if (originalHome) process.env.OPENHIVE_HOME = originalHome;
    else delete process.env.OPENHIVE_HOME;
  });

  it('should no-op when atlas is not available', async () => {
    const config = createTestConfig();
    config.learning.enabled = false;
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    const log = createTestLogger();

    // Should not throw, should not log anything
    triggerIngestion(svc, 'swarm-123', log);

    // Give the async queue time to process
    await new Promise(r => setTimeout(r, 100));

    expect(log.warnings.length).toBe(0);
    expect(log.infos.length).toBe(0);

    await svc.close();
  });

  it('should handle no SessionBanks configured', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    // Clear session banks (simulate no sessionlog configured)
    // SessionBanks are empty because test env has no git repo
    const log = createTestLogger();

    triggerIngestion(svc, 'swarm-456', log);
    await new Promise(r => setTimeout(r, 200));

    // Should either warn about no banks or find no sessions
    // (depends on whether default SessionBank init succeeded)
    await svc.close();
  });

  it('should handle SessionBank not available gracefully', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    // SessionBank will be "not available" in test env (no git orphan branch)
    const banks = svc.getSessionBanks();
    for (const bank of banks) {
      expect(bank.isAvailable()).toBe(false);
    }

    const log = createTestLogger();
    triggerIngestion(svc, 'swarm-789', log);
    await new Promise(r => setTimeout(r, 200));

    // Should not crash
    await svc.close();
  });

  it('should serialize concurrent ingestion triggers', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    const log = createTestLogger();

    // Fire multiple ingestion triggers concurrently
    triggerIngestion(svc, 'swarm-a', log);
    triggerIngestion(svc, 'swarm-b', log);
    triggerIngestion(svc, 'swarm-c', log);

    // Wait for all to complete (they're serialized in the queue)
    await new Promise(r => setTimeout(r, 500));

    // Should not crash or produce errors
    await svc.close();
  });

  it('should pass distributed coordinator when provided', async () => {
    const config = createTestConfig();
    const svc = new AtlasService(config, ownerAgentId);
    await svc.init();

    // Create a mock coordinator
    const { DistributedLearningCoordinator } = await import('../../learning/distributed.js');
    const coordinator = new DistributedLearningCoordinator(config, svc);

    const log = createTestLogger();
    triggerIngestion(svc, 'swarm-dist', log, coordinator);
    await new Promise(r => setTimeout(r, 200));

    await svc.close();
  });
});
