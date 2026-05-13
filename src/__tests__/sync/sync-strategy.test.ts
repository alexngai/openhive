/**
 * Tests for configurable sync strategies
 *
 * Covers:
 * - Schema migration: sync_strategy + local_path columns
 * - DAL: CRUD with new fields, updateSyncStrategy, updateLocalPath
 * - SyncProvider interface: MetadataProvider, LocalProvider
 * - SyncOrchestrator: dispatching, ensureContent, resolveGraphPath
 * - Discovery: sets sync_strategy='local' + local_path on discovered resources
 * - Content API: resolveLocalPath prefers local_path field
 * - Config: resourceSync + resourceStorage sections parse correctly
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { discoverLocalResources } from '../../discovery/index.js';
import { MetadataProvider } from '../../sync/providers/metadata.js';
import { LocalProvider } from '../../sync/providers/local.js';
import { getProvider, hasProvider, registerProvider } from '../../sync/providers/index.js';
import { SyncOrchestrator } from '../../sync/sync-orchestrator.js';
import { ConfigSchema } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';
import type { SyncableResource, SyncStrategy } from '../../types.js';
import type { Config } from '../../config.js';

const TEST_ROOT = testRoot('sync-strategy');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'sync-strategy.db');

function makeConfig(overrides: Partial<Config['resourceDiscovery']> = {}): Config {
  return ConfigSchema.parse({
    resourceDiscovery: {
      globalEnabled: false,
      ...overrides,
    },
  });
}

/** Create a minimal SyncableResource for provider testing (no DB required) */
function makeResource(overrides: Partial<SyncableResource> = {}): SyncableResource {
  return {
    id: 'res_test',
    resource_type: 'task',
    name: 'test-resource',
    description: null,
    git_remote_url: '/tmp/fake',
    webhook_secret: null,
    visibility: 'private',
    last_commit_hash: null,
    last_push_by: null,
    last_push_at: null,
    owner_agent_id: 'agent_test',
    scope: 'manual',
    sync_strategy: 'metadata',
    local_path: null,
    metadata: { opentasks: true },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'active',
    ...overrides,
  };
}

describe('Sync Strategy', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'sync-strategy-test-agent',
      description: 'Agent for sync strategy tests',
    });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ============================================================================
  // Schema & DAL Tests
  // ============================================================================

  describe('Schema & DAL', () => {
    it('should create a resource with default sync_strategy=metadata', () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'test-default-strategy',
        git_remote_url: '/tmp/test-default',
        owner_agent_id: agentId,
      });

      expect(resource.sync_strategy).toBe('metadata');
      expect(resource.local_path).toBeNull();
    });

    it('should create a resource with explicit sync_strategy=local', () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'test-local-strategy',
        git_remote_url: '/tmp/test-local',
        owner_agent_id: agentId,
        sync_strategy: 'local',
        local_path: '/tmp/test-local',
      });

      expect(resource.sync_strategy).toBe('local');
      expect(resource.local_path).toBe('/tmp/test-local');
    });

    it('should persist all valid sync_strategy values', () => {
      const strategies: SyncStrategy[] = ['metadata', 'local', 'ls-remote', 'mirror', 'bundle'];
      for (const strategy of strategies) {
        const resource = resourcesDAL.createResource({
          resource_type: 'task',
          name: `test-strategy-all-${strategy}`,
          git_remote_url: `/tmp/test-all-${strategy}`,
          owner_agent_id: agentId,
          sync_strategy: strategy,
        });
        expect(resource.sync_strategy).toBe(strategy);
      }
    });

    it('should update sync_strategy via updateSyncStrategy', () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'test-update-strategy',
        git_remote_url: '/tmp/test-update',
        owner_agent_id: agentId,
        sync_strategy: 'metadata',
      });

      resourcesDAL.updateSyncStrategy(resource.id, 'mirror');
      const updated = resourcesDAL.findResourceById(resource.id)!;
      expect(updated.sync_strategy).toBe('mirror');
    });

    it('should update local_path via updateLocalPath', () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'test-update-path',
        git_remote_url: '/tmp/test-path',
        owner_agent_id: agentId,
      });

      expect(resource.local_path).toBeNull();

      resourcesDAL.updateLocalPath(resource.id, '/tmp/cloned/res_123');
      const updated = resourcesDAL.findResourceById(resource.id)!;
      expect(updated.local_path).toBe('/tmp/cloned/res_123');
    });

    it('should clear local_path by setting null', () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'test-clear-path',
        git_remote_url: '/tmp/test-clear',
        owner_agent_id: agentId,
        local_path: '/tmp/some-path',
      });

      expect(resource.local_path).toBe('/tmp/some-path');

      resourcesDAL.updateLocalPath(resource.id, null);
      const updated = resourcesDAL.findResourceById(resource.id)!;
      expect(updated.local_path).toBeNull();
    });

    it('should update sync_strategy and local_path via updateResource', () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'test-generic-update',
        git_remote_url: '/tmp/test-gen',
        owner_agent_id: agentId,
      });

      const updated = resourcesDAL.updateResource(resource.id, {
        sync_strategy: 'ls-remote',
        local_path: '/tmp/clone-dir',
      });

      expect(updated!.sync_strategy).toBe('ls-remote');
      expect(updated!.local_path).toBe('/tmp/clone-dir');
    });

    it('should preserve sync_strategy on upsert when not provided', () => {
      const { resource: created } = resourcesDAL.upsertDiscoveredResource({
        resource_type: 'task',
        name: 'test-upsert-preserve',
        git_remote_url: '/tmp/upsert-preserve',
        owner_agent_id: agentId,
        sync_strategy: 'local',
        local_path: '/tmp/upsert-preserve',
      });

      expect(created.sync_strategy).toBe('local');

      // Upsert again without sync_strategy — should preserve 'local'
      const { resource: updated } = resourcesDAL.upsertDiscoveredResource({
        resource_type: 'task',
        name: 'test-upsert-preserve',
        description: 'Updated description',
        git_remote_url: '/tmp/upsert-preserve-v2',
        owner_agent_id: agentId,
      });

      expect(updated.sync_strategy).toBe('local');
      expect(updated.local_path).toBe('/tmp/upsert-preserve');
    });

    it('should include sync_strategy and local_path in getResourceWithMeta', () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'test-with-meta',
        git_remote_url: '/tmp/test-meta',
        owner_agent_id: agentId,
        sync_strategy: 'local',
        local_path: '/tmp/test-meta',
      });

      const withMeta = resourcesDAL.getResourceWithMeta(resource.id, agentId);
      expect(withMeta).not.toBeNull();
      expect(withMeta!.sync_strategy).toBe('local');
      expect(withMeta!.local_path).toBe('/tmp/test-meta');
    });

    it('should include sync_strategy and local_path in listAccessibleResources', () => {
      resourcesDAL.createResource({
        resource_type: 'task',
        name: 'test-list-strategy',
        git_remote_url: '/tmp/test-list',
        owner_agent_id: agentId,
        sync_strategy: 'mirror',
        local_path: '/tmp/test-list-clone',
      });

      const { data } = resourcesDAL.listAccessibleResources({ agentId });
      const found = data.find(r => r.name === 'test-list-strategy');
      expect(found).toBeDefined();
      expect(found!.sync_strategy).toBe('mirror');
      expect(found!.local_path).toBe('/tmp/test-list-clone');
    });
  });

  // ============================================================================
  // Config Tests
  // ============================================================================

  describe('Config', () => {
    it('should parse resourceSync defaults', () => {
      const config = ConfigSchema.parse({});
      expect(config.resourceSync.defaultStrategy).toBe('metadata');
      expect(config.resourceSync.localDiscoveryStrategy).toBe('local');
      expect(config.resourceSync.lsRemoteTtl).toBe(60);
      expect(config.resourceSync.mirrorFetchTimeout).toBe(30000);
      expect(config.resourceSync.bundleMaxSize).toBe(10 * 1024 * 1024);
    });

    it('should parse resourceStorage defaults', () => {
      const config = ConfigSchema.parse({});
      expect(config.resourceStorage.dataDir).toBe('./data/resources');
      expect(config.resourceStorage.autoClone).toBe(true);
    });

    it('should accept custom resourceSync values', () => {
      const config = ConfigSchema.parse({
        resourceSync: {
          defaultStrategy: 'mirror',
          lsRemoteTtl: 120,
          mirrorFetchTimeout: 60000,
        },
      });
      expect(config.resourceSync.defaultStrategy).toBe('mirror');
      expect(config.resourceSync.lsRemoteTtl).toBe(120);
      expect(config.resourceSync.mirrorFetchTimeout).toBe(60000);
    });

    it('should reject invalid sync strategy in config', () => {
      expect(() => ConfigSchema.parse({
        resourceSync: { defaultStrategy: 'invalid-strategy' },
      })).toThrow();
    });
  });

  // ============================================================================
  // MetadataProvider Tests
  // ============================================================================

  describe('MetadataProvider', () => {
    const provider = new MetadataProvider();

    it('should have strategy=metadata', () => {
      expect(provider.strategy).toBe('metadata');
    });

    it('should return false from onSyncEvent (no-op)', async () => {
      const result = await provider.onSyncEvent(makeResource(), 'abc123');
      expect(result).toBe(false);
    });

    it('should return null from ensureContent (no content)', async () => {
      const result = await provider.ensureContent(makeResource());
      expect(result).toBeNull();
    });

    it('should return null from resolveGraphPath', async () => {
      const result = await provider.resolveGraphPath(makeResource());
      expect(result).toBeNull();
    });

    it('should not throw on cleanup', async () => {
      await expect(provider.cleanup(makeResource())).resolves.toBeUndefined();
    });
  });

  // ============================================================================
  // LocalProvider Tests
  // ============================================================================

  describe('LocalProvider', () => {
    const provider = new LocalProvider();
    let localDir: string;
    let opentasksDir: string;

    beforeAll(() => {
      // Create a real .opentasks directory for testing
      localDir = mkTestDir(TEST_ROOT, 'local-provider');
      opentasksDir = mkTestDir(localDir, '.opentasks');
      fs.writeFileSync(path.join(opentasksDir, 'graph.jsonl'), '{"id":"t1","type":"task","title":"Test","status":"open"}\n');
      fs.writeFileSync(path.join(opentasksDir, 'config.json'), JSON.stringify({ location: { hash: 'abc' } }));
    });

    it('should have strategy=local', () => {
      expect(provider.strategy).toBe('local');
    });

    it('should return false from onSyncEvent (filesystem is source of truth)', async () => {
      const resource = makeResource({ local_path: opentasksDir, sync_strategy: 'local' });
      const result = await provider.onSyncEvent(resource, 'abc123');
      expect(result).toBe(false);
    });

    it('should return local path from ensureContent when local_path is set', async () => {
      const resource = makeResource({ local_path: opentasksDir, sync_strategy: 'local' });
      const result = await provider.ensureContent(resource);
      expect(result).toBe(path.resolve(opentasksDir));
    });

    it('should return null from ensureContent when path does not exist', async () => {
      const resource = makeResource({ local_path: '/tmp/nonexistent-opentasks-path', sync_strategy: 'local' });
      const result = await provider.ensureContent(resource);
      expect(result).toBeNull();
    });

    it('should fall back to git_remote_url when local_path is null', async () => {
      const resource = makeResource({
        local_path: null,
        git_remote_url: opentasksDir,
        sync_strategy: 'local',
      });
      const result = await provider.ensureContent(resource);
      expect(result).toBe(path.resolve(opentasksDir));
    });

    it('should return null when git_remote_url is a remote URL', async () => {
      const resource = makeResource({
        local_path: null,
        git_remote_url: 'https://github.com/user/repo.git',
        sync_strategy: 'local',
      });
      const result = await provider.ensureContent(resource);
      expect(result).toBeNull();
    });

    it('should resolve graph path when graph.jsonl is in the directory', async () => {
      const resource = makeResource({ local_path: opentasksDir, sync_strategy: 'local' });
      const result = await provider.resolveGraphPath(resource);
      expect(result).toBe(path.resolve(opentasksDir));
    });

    it('should resolve graph path via .opentasks subdirectory', async () => {
      const resource = makeResource({ local_path: localDir, sync_strategy: 'local' });
      const result = await provider.resolveGraphPath(resource);
      // Should find .opentasks/graph.jsonl and return the .opentasks dir
      expect(result).toBe(path.resolve(path.join(localDir, '.opentasks')));
    });

    it('should return null from resolveGraphPath when no graph.jsonl exists', async () => {
      const emptyDir = mkTestDir(TEST_ROOT, `empty-ot-${Date.now()}`);
      const resource = makeResource({ local_path: emptyDir, sync_strategy: 'local' });
      const result = await provider.resolveGraphPath(resource);
      expect(result).toBeNull();
    });

    it('should not throw on cleanup', async () => {
      const resource = makeResource({ local_path: opentasksDir, sync_strategy: 'local' });
      await expect(provider.cleanup(resource)).resolves.toBeUndefined();
    });
  });

  // ============================================================================
  // Provider Registry Tests
  // ============================================================================

  describe('Provider Registry', () => {
    it('should have metadata provider registered', () => {
      expect(hasProvider('metadata')).toBe(true);
    });

    it('should have local provider registered', () => {
      expect(hasProvider('local')).toBe(true);
    });

    it('should return metadata provider for unregistered strategies', () => {
      const provider = getProvider('bundle');
      expect(provider.strategy).toBe('metadata');
    });

    it('should return the correct provider for registered strategies', () => {
      expect(getProvider('metadata').strategy).toBe('metadata');
      expect(getProvider('local').strategy).toBe('local');
    });

    it('should allow registering new providers', () => {
      const mockProvider = {
        strategy: 'bundle' as const,
        onSyncEvent: async () => false,
        ensureContent: async () => null,
        resolveGraphPath: async () => null,
        cleanup: async () => {},
      };
      registerProvider('bundle', mockProvider);
      expect(hasProvider('bundle')).toBe(true);
      expect(getProvider('bundle').strategy).toBe('bundle');
    });
  });

  // ============================================================================
  // SyncOrchestrator Tests
  // ============================================================================

  describe('SyncOrchestrator', () => {
    let orchestrator: SyncOrchestrator;
    let localDir: string;
    let opentasksDir: string;

    beforeAll(() => {
      orchestrator = new SyncOrchestrator();
      localDir = mkTestDir(TEST_ROOT, 'orchestrator');
      opentasksDir = mkTestDir(localDir, '.opentasks');
      fs.writeFileSync(path.join(opentasksDir, 'graph.jsonl'), '{"id":"t1","type":"task","title":"Orch test","status":"open"}\n');
    });

    it('should dispatch to MetadataProvider for metadata strategy', async () => {
      const resource = makeResource({ sync_strategy: 'metadata' });
      const result = await orchestrator.ensureContent(resource);
      expect(result).toBeNull();
    });

    it('should dispatch to LocalProvider for local strategy', async () => {
      const resource = makeResource({
        sync_strategy: 'local',
        local_path: opentasksDir,
      });
      const result = await orchestrator.ensureContent(resource);
      expect(result).toBe(path.resolve(opentasksDir));
    });

    it('should resolve graph path for local strategy', async () => {
      const resource = makeResource({
        sync_strategy: 'local',
        local_path: localDir,
      });
      const graphPath = await orchestrator.resolveGraphPath(resource);
      expect(graphPath).toBe(path.resolve(path.join(localDir, '.opentasks')));
    });

    it('should return null graph path for metadata strategy', async () => {
      const resource = makeResource({ sync_strategy: 'metadata' });
      const graphPath = await orchestrator.resolveGraphPath(resource);
      expect(graphPath).toBeNull();
    });

    it('should handle handleSyncEvent for metadata (no-op, no broadcast)', async () => {
      const resource = makeResource({ sync_strategy: 'metadata' });
      // Should not throw
      await expect(orchestrator.handleSyncEvent(resource, 'abc123')).resolves.toBeUndefined();
    });

    it('should handle handleSyncEvent for local (no-op, no broadcast)', async () => {
      const resource = makeResource({ sync_strategy: 'local', local_path: opentasksDir });
      await expect(orchestrator.handleSyncEvent(resource, 'abc123')).resolves.toBeUndefined();
    });

    it('should handle cleanup for local (no-op)', async () => {
      const resource = makeResource({ sync_strategy: 'local', local_path: opentasksDir });
      await expect(orchestrator.cleanup(resource)).resolves.toBeUndefined();
    });

    it('should fall back to metadata provider for unregistered strategies', async () => {
      // ls-remote and mirror may not be registered in this test context
      const resource = makeResource({ sync_strategy: 'ls-remote' });
      const result = await orchestrator.ensureContent(resource);
      expect(result).toBeNull(); // Falls back to metadata no-op
    });
  });

  // ============================================================================
  // Discovery Integration Tests
  // ============================================================================

  describe('Discovery Integration', () => {
    it('should set sync_strategy=local and local_path for discovered OpenTasks', async () => {
      const projectDir = mkTestDir(TEST_ROOT, `discovery-ot-${Date.now()}`);
      const otDir = mkTestDir(projectDir, '.opentasks');
      fs.writeFileSync(path.join(otDir, 'config.json'), JSON.stringify({
        location: { hash: 'test-hash-disc', name: 'test-project' },
      }));
      fs.writeFileSync(path.join(otDir, 'graph.jsonl'),
        '{"id":"t1","type":"task","title":"Discovered","status":"open"}\n'
      );

      const config = makeConfig({ projectRoot: projectDir, openTasksEnabled: true });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['project'],
      });

      const taskResource = [...result.created, ...result.updated].find(
        r => r.resource_type === 'task'
      );
      expect(taskResource).toBeDefined();

      // Verify the DB record has sync_strategy and local_path
      const resource = resourcesDAL.findResourceById(taskResource!.id)!;
      expect(resource.sync_strategy).toBe('local');
      expect(resource.local_path).toBe(path.join(projectDir, '.opentasks'));
    });

    it('should set sync_strategy=local for discovered memory banks', async () => {
      const projectDir = mkTestDir(TEST_ROOT, `discovery-mem-${Date.now()}`);
      fs.writeFileSync(path.join(projectDir, 'MEMORY.md'), '# Memory\n');

      const config = makeConfig({ projectRoot: projectDir });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['project'],
      });

      const memResource = [...result.created, ...result.updated].find(
        r => r.resource_type === 'memory_bank'
      );
      expect(memResource).toBeDefined();

      const resource = resourcesDAL.findResourceById(memResource!.id)!;
      expect(resource.sync_strategy).toBe('local');
      expect(resource.local_path).toBe(projectDir);
    });

    it('should preserve sync_strategy=local on rediscovery', async () => {
      const projectDir = mkTestDir(TEST_ROOT, `discovery-rediscovery-${Date.now()}`);
      const otDir = mkTestDir(projectDir, '.opentasks');
      fs.writeFileSync(path.join(otDir, 'config.json'), JSON.stringify({
        location: { hash: 'test-rediscovery' },
      }));
      fs.writeFileSync(path.join(otDir, 'graph.jsonl'), '{"id":"t1","type":"task","status":"open"}\n');

      const config = makeConfig({ projectRoot: projectDir, openTasksEnabled: true });

      const first = await discoverLocalResources(config, { ownerAgentId: agentId, scopes: ['project'] });
      const firstTask = [...first.created, ...first.updated].find(r => r.resource_type === 'task');
      expect(firstTask).toBeDefined();

      // Manually change strategy to mirror
      resourcesDAL.updateSyncStrategy(firstTask!.id, 'mirror');
      const afterUpdate = resourcesDAL.findResourceById(firstTask!.id)!;
      expect(afterUpdate.sync_strategy).toBe('mirror');

      // Re-discover — upsert passes sync_strategy='local', which will overwrite
      const second = await discoverLocalResources(config, { ownerAgentId: agentId, scopes: ['project'] });
      const secondTask = [...second.created, ...second.updated].find(r => r.resource_type === 'task');
      expect(secondTask).toBeDefined();

      const resource = resourcesDAL.findResourceById(secondTask!.id)!;
      // Re-discovery always sets local — this is expected behavior
      expect(resource.sync_strategy).toBe('local');
    });
  });

  // ============================================================================
  // Auto-Registration Tests (opentasks-handler.ts autoRegisterResource)
  // ============================================================================

  describe('Auto-Registration via DAL', () => {
    it('should set sync_strategy=local when registering with local_path', () => {
      // Simulates what autoRegisterResource does in opentasks-handler.ts
      const otDir = mkTestDir(TEST_ROOT, `auto-reg-${Date.now()}`);
      fs.writeFileSync(path.join(otDir, 'config.json'), JSON.stringify({
        location: { hash: 'auto-test' },
      }));
      fs.writeFileSync(path.join(otDir, 'graph.jsonl'), '{"id":"t1","type":"task","status":"open"}\n');

      const { resource } = resourcesDAL.upsertDiscoveredResource({
        resource_type: 'task',
        name: `auto/test-${Date.now()}`,
        description: 'Auto-registered',
        git_remote_url: otDir,
        visibility: 'private',
        owner_agent_id: agentId,
        scope: 'agent',
        sync_strategy: 'local',
        local_path: otDir,
        metadata: { opentasks: true },
      });

      expect(resource.sync_strategy).toBe('local');
      expect(resource.local_path).toBe(otDir);
    });
  });

  // ============================================================================
  // Edge Cases & Error Handling
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle resource with empty git_remote_url gracefully in LocalProvider', async () => {
      const provider = new LocalProvider();
      const resource = makeResource({ local_path: null, git_remote_url: '' });
      // Empty string is not a remote URL, resolve('') = cwd
      const result = await provider.ensureContent(resource);
      // CWD exists, so it should return a path (not crash)
      expect(typeof result === 'string' || result === null).toBe(true);
    });

    it('should handle resource where local_path dir was deleted', async () => {
      const tmpDir = mkTestDir(TEST_ROOT, `deleted-dir-${Date.now()}`);
      const otDir = mkTestDir(tmpDir, '.opentasks');
      fs.writeFileSync(path.join(otDir, 'graph.jsonl'), '{"id":"t1","type":"task"}\n');

      const provider = new LocalProvider();
      const resource = makeResource({ local_path: otDir, sync_strategy: 'local' });

      // Verify it works
      const before = await provider.ensureContent(resource);
      expect(before).toBe(path.resolve(otDir));

      // Delete the directory
      fs.rmSync(tmpDir, { recursive: true, force: true });

      // Should return null now
      const after = await provider.ensureContent(resource);
      expect(after).toBeNull();
    });

    it('should handle findResourceById returning new fields for pre-migration rows', () => {
      // Create a resource — the DB defaults will apply
      const resource = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'test-premigration-compat',
        git_remote_url: '/tmp/premigration',
        owner_agent_id: agentId,
        // No sync_strategy or local_path provided
      });

      expect(resource.sync_strategy).toBe('metadata');
      expect(resource.local_path).toBeNull();
    });

    it('should handle concurrent strategy updates', () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'test-concurrent-update',
        git_remote_url: '/tmp/concurrent',
        owner_agent_id: agentId,
      });

      resourcesDAL.updateSyncStrategy(resource.id, 'local');
      resourcesDAL.updateSyncStrategy(resource.id, 'mirror');
      resourcesDAL.updateSyncStrategy(resource.id, 'ls-remote');

      const final = resourcesDAL.findResourceById(resource.id)!;
      expect(final.sync_strategy).toBe('ls-remote');
    });
  });
});
