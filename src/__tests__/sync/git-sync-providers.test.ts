/**
 * Tests for git-based sync providers (ls-remote + mirror)
 *
 * Covers:
 * - GitContentManager: clone, fetch, freshness, graph path resolution, cleanup
 * - LsRemoteProvider: lazy clone, staleness tracking, content query triggers clone
 * - MirrorProvider: eager fetch on sync event, always-fresh content
 * - Provider registration with config
 * - Materializer integration (orchestrator hooks)
 *
 * These tests create real git repos in temp directories for integration testing.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as gitContent from '../../sync/git-content.js';
import { LsRemoteProvider } from '../../sync/providers/ls-remote.js';
import { MirrorProvider } from '../../sync/providers/mirror.js';
import { initProviders, getProvider, hasProvider } from '../../sync/providers/index.js';
import { SyncOrchestrator } from '../../sync/sync-orchestrator.js';
import { ConfigSchema } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';
import type { SyncableResource } from '../../types.js';

const TEST_ROOT = testRoot('git-sync-providers');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'git-sync.db');

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
    ...overrides,
  };
}

/**
 * Create a real git repo with .opentasks/ content.
 * Returns the repo path.
 */
function createTestGitRepo(name: string): string {
  const repoDir = mkTestDir(TEST_ROOT, `repo-${name}-${Date.now()}`);
  execSync('git init', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'pipe' });

  // Create .opentasks directory with graph and config
  const otDir = path.join(repoDir, '.opentasks');
  fs.mkdirSync(otDir, { recursive: true });
  fs.writeFileSync(path.join(otDir, 'config.json'), JSON.stringify({
    location: { hash: `test-${name}`, name: name },
  }));
  fs.writeFileSync(path.join(otDir, 'graph.jsonl'),
    '{"id":"t1","type":"task","title":"Initial task","status":"open"}\n'
  );

  execSync('git add -A', { cwd: repoDir, stdio: 'pipe' });
  execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: 'pipe' });

  return repoDir;
}

/** Get the HEAD commit hash from a repo */
function getHead(repoDir: string): string {
  return execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf-8' }).trim();
}

/** Add a new task to the graph and commit */
function addTaskAndCommit(repoDir: string, taskId: string): string {
  const graphPath = path.join(repoDir, '.opentasks', 'graph.jsonl');
  fs.appendFileSync(graphPath, `{"id":"${taskId}","type":"task","title":"Task ${taskId}","status":"open"}\n`);
  execSync('git add -A', { cwd: repoDir, stdio: 'pipe' });
  execSync(`git commit -m "Add task ${taskId}"`, { cwd: repoDir, stdio: 'pipe' });
  return getHead(repoDir);
}

describe('Git Sync Providers (ls-remote + mirror)', () => {
  let agentId: string;
  let dataDir: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'git-sync-test-agent',
      description: 'Agent for git sync provider tests',
    });
    agentId = agent.id;
    dataDir = mkTestDir(TEST_ROOT, 'clone-data');
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ============================================================================
  // GitContentManager Tests
  // ============================================================================

  describe('GitContentManager', () => {
    let remoteRepo: string;

    beforeAll(() => {
      remoteRepo = createTestGitRepo('git-content');
    });

    it('should get clone path under data directory', () => {
      const clonePath = gitContent.getClonePath(dataDir, 'res_abc');
      expect(clonePath).toBe(path.resolve(dataDir, 'res_abc'));
    });

    it('should report no clone when none exists', () => {
      expect(gitContent.hasLocalClone(dataDir, 'res_nonexistent')).toBe(false);
    });

    it('should clone a remote repo', async () => {
      const resource = makeResource({
        id: 'res_clone_test',
        git_remote_url: remoteRepo,
      });

      const clonePath = await gitContent.ensureClone(resource, dataDir);
      expect(fs.existsSync(path.join(clonePath, '.git'))).toBe(true);
      expect(fs.existsSync(path.join(clonePath, '.opentasks', 'graph.jsonl'))).toBe(true);
      expect(gitContent.hasLocalClone(dataDir, 'res_clone_test')).toBe(true);
    });

    it('should return existing clone on second ensureClone call', async () => {
      const resource = makeResource({
        id: 'res_clone_test',
        git_remote_url: remoteRepo,
      });

      const clonePath = await gitContent.ensureClone(resource, dataDir);
      expect(fs.existsSync(path.join(clonePath, '.git'))).toBe(true);
    });

    it('should get local HEAD from a clone', async () => {
      const clonePath = gitContent.getClonePath(dataDir, 'res_clone_test');
      const head = await gitContent.getLocalHead(clonePath);
      expect(head).toBeTruthy();
      expect(head!.length).toBe(40); // SHA-1 hash
    });

    it('should return null for getLocalHead on nonexistent path', async () => {
      const head = await gitContent.getLocalHead('/tmp/nonexistent-repo-path');
      expect(head).toBeNull();
    });

    it('should fetch latest and detect changes', async () => {
      // Add a new commit to the remote
      addTaskAndCommit(remoteRepo, 't2');

      const clonePath = gitContent.getClonePath(dataDir, 'res_clone_test');
      const result = await gitContent.fetchLatest(clonePath);

      expect(result.changed).toBe(true);
      expect(result.newHead).toBe(getHead(remoteRepo));
    });

    it('should detect no changes when already up to date', async () => {
      const clonePath = gitContent.getClonePath(dataDir, 'res_clone_test');
      const result = await gitContent.fetchLatest(clonePath);

      expect(result.changed).toBe(false);
    });

    it('should resolve graph path in cloned repo', () => {
      const clonePath = gitContent.getClonePath(dataDir, 'res_clone_test');
      const graphPath = gitContent.resolveGraphPath(clonePath);
      expect(graphPath).toBe(path.join(clonePath, '.opentasks'));
    });

    it('should return null for resolveGraphPath when no graph exists', () => {
      const emptyDir = mkTestDir(TEST_ROOT, 'empty-repo');
      expect(gitContent.resolveGraphPath(emptyDir)).toBeNull();
    });

    it('should check freshness against remote', async () => {
      const resource = makeResource({
        id: 'res_clone_test',
        git_remote_url: remoteRepo,
      });

      // Currently up to date
      const fresh = await gitContent.checkFreshness(resource, dataDir);
      expect(fresh.stale).toBe(false);
      expect(fresh.remoteHead).toBeTruthy();
      expect(fresh.localHead).toBeTruthy();
      expect(fresh.remoteHead).toBe(fresh.localHead);

      // Add a commit to make it stale
      addTaskAndCommit(remoteRepo, 't3');
      const stale = await gitContent.checkFreshness(resource, dataDir);
      expect(stale.stale).toBe(true);
      expect(stale.remoteHead).not.toBe(stale.localHead);
    });

    it('should remove a clone', async () => {
      // Create a new clone to remove
      const resource = makeResource({
        id: 'res_removable',
        git_remote_url: remoteRepo,
      });
      await gitContent.ensureClone(resource, dataDir);
      expect(gitContent.hasLocalClone(dataDir, 'res_removable')).toBe(true);

      await gitContent.removeClone(dataDir, 'res_removable');
      expect(gitContent.hasLocalClone(dataDir, 'res_removable')).toBe(false);
    });

    it('should not throw when removing nonexistent clone', async () => {
      await expect(gitContent.removeClone(dataDir, 'res_nonexistent')).resolves.toBeUndefined();
    });
  });

  // ============================================================================
  // LsRemoteProvider Tests
  // ============================================================================

  describe('LsRemoteProvider', () => {
    let provider: LsRemoteProvider;
    let remoteRepo: string;
    let lsDataDir: string;

    beforeAll(() => {
      lsDataDir = mkTestDir(TEST_ROOT, 'ls-remote-data');
      provider = new LsRemoteProvider(lsDataDir, 60);
      remoteRepo = createTestGitRepo('ls-remote');
    });

    it('should have strategy=ls-remote', () => {
      expect(provider.strategy).toBe('ls-remote');
    });

    it('should mark resource as stale on sync event', async () => {
      const resource = makeResource({
        id: 'res_ls_test',
        git_remote_url: remoteRepo,
        sync_strategy: 'ls-remote',
      });
      const result = await provider.onSyncEvent(resource, 'abc123');
      expect(result).toBe(false); // Doesn't fetch, just marks stale
    });

    it('should clone on first ensureContent', async () => {
      // Create a real DB resource so updateLocalPath works
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'ls-remote-clone-test',
        git_remote_url: remoteRepo,
        owner_agent_id: agentId,
        sync_strategy: 'ls-remote',
      });

      const contentPath = await provider.ensureContent(resource);
      expect(contentPath).toBeTruthy();
      expect(fs.existsSync(path.join(contentPath!, '.git'))).toBe(true);

      // Verify local_path was persisted
      const updated = resourcesDAL.findResourceById(resource.id)!;
      expect(updated.local_path).toBeTruthy();
    });

    it('should return existing clone on subsequent ensureContent', async () => {
      const resource = resourcesDAL.findResourceById(
        resourcesDAL.createResource({
          resource_type: 'task',
          name: 'ls-remote-existing-test',
          git_remote_url: remoteRepo,
          owner_agent_id: agentId,
          sync_strategy: 'ls-remote',
        }).id
      )!;

      const first = await provider.ensureContent(resource);
      const second = await provider.ensureContent(resource);
      expect(first).toBe(second);
    });

    it('should resolve graph path through ensureContent', async () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'ls-remote-graph-test',
        git_remote_url: remoteRepo,
        owner_agent_id: agentId,
        sync_strategy: 'ls-remote',
      });

      const graphPath = await provider.resolveGraphPath(resource);
      expect(graphPath).toBeTruthy();
      expect(fs.existsSync(path.join(graphPath!, 'graph.jsonl'))).toBe(true);
    });

    it('should return null for ensureContent with no git URL', async () => {
      const resource = makeResource({ git_remote_url: '', sync_strategy: 'ls-remote' });
      const result = await provider.ensureContent(resource);
      expect(result).toBeNull();
    });

    it('should clean up clone on cleanup', async () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'ls-remote-cleanup-test',
        git_remote_url: remoteRepo,
        owner_agent_id: agentId,
        sync_strategy: 'ls-remote',
      });

      await provider.ensureContent(resource);
      expect(gitContent.hasLocalClone(lsDataDir, resource.id)).toBe(true);

      await provider.cleanup(resource);
      expect(gitContent.hasLocalClone(lsDataDir, resource.id)).toBe(false);

      const updated = resourcesDAL.findResourceById(resource.id)!;
      expect(updated.local_path).toBeNull();
    });
  });

  // ============================================================================
  // MirrorProvider Tests
  // ============================================================================

  describe('MirrorProvider', () => {
    let provider: MirrorProvider;
    let remoteRepo: string;
    let mirrorDataDir: string;

    beforeAll(() => {
      mirrorDataDir = mkTestDir(TEST_ROOT, 'mirror-data');
      provider = new MirrorProvider(mirrorDataDir, 30000);
      remoteRepo = createTestGitRepo('mirror');
    });

    it('should have strategy=mirror', () => {
      expect(provider.strategy).toBe('mirror');
    });

    it('should clone and fetch on first sync event', async () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'mirror-sync-test',
        git_remote_url: remoteRepo,
        owner_agent_id: agentId,
        sync_strategy: 'mirror',
      });

      const result = await provider.onSyncEvent(resource, getHead(remoteRepo));
      // First sync creates the clone — may or may not report changed
      // depending on whether clone matches the commit
      expect(typeof result).toBe('boolean');

      // Clone should exist now
      expect(gitContent.hasLocalClone(mirrorDataDir, resource.id)).toBe(true);

      // local_path should be persisted
      const updated = resourcesDAL.findResourceById(resource.id)!;
      expect(updated.local_path).toBeTruthy();
    });

    it('should detect changes on sync event after remote update', async () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'mirror-change-test',
        git_remote_url: remoteRepo,
        owner_agent_id: agentId,
        sync_strategy: 'mirror',
      });

      // First sync: create clone
      await provider.onSyncEvent(resource, getHead(remoteRepo));

      // Add a commit to remote
      const newHead = addTaskAndCommit(remoteRepo, 'mirror-t2');

      // Second sync: should fetch and detect change
      const result = await provider.onSyncEvent(resource, newHead);
      expect(result).toBe(true);
    });

    it('should serve content from clone via ensureContent', async () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'mirror-content-test',
        git_remote_url: remoteRepo,
        owner_agent_id: agentId,
        sync_strategy: 'mirror',
      });

      const contentPath = await provider.ensureContent(resource);
      expect(contentPath).toBeTruthy();
      expect(fs.existsSync(path.join(contentPath!, '.opentasks', 'graph.jsonl'))).toBe(true);
    });

    it('should resolve graph path', async () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'mirror-graph-test',
        git_remote_url: remoteRepo,
        owner_agent_id: agentId,
        sync_strategy: 'mirror',
      });

      const graphPath = await provider.resolveGraphPath(resource);
      expect(graphPath).toBeTruthy();
      expect(fs.existsSync(path.join(graphPath!, 'graph.jsonl'))).toBe(true);
    });

    it('should clean up clone on cleanup', async () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'mirror-cleanup-test',
        git_remote_url: remoteRepo,
        owner_agent_id: agentId,
        sync_strategy: 'mirror',
      });

      await provider.ensureContent(resource);
      expect(gitContent.hasLocalClone(mirrorDataDir, resource.id)).toBe(true);

      await provider.cleanup(resource);
      expect(gitContent.hasLocalClone(mirrorDataDir, resource.id)).toBe(false);
    });

    it('should return null for ensureContent with no git URL', async () => {
      const resource = makeResource({ git_remote_url: '', sync_strategy: 'mirror' });
      const result = await provider.ensureContent(resource);
      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // Provider Registration Tests
  // ============================================================================

  describe('Provider Registration', () => {
    it('should register ls-remote and mirror providers via initProviders', () => {
      const config = ConfigSchema.parse({
        resourceStorage: { dataDir: mkTestDir(TEST_ROOT, 'reg-data') },
        resourceSync: { lsRemoteTtl: 30, mirrorFetchTimeout: 15000 },
      });

      initProviders(config);

      expect(hasProvider('ls-remote')).toBe(true);
      expect(hasProvider('mirror')).toBe(true);
      expect(getProvider('ls-remote').strategy).toBe('ls-remote');
      expect(getProvider('mirror').strategy).toBe('mirror');
    });
  });

  // ============================================================================
  // SyncOrchestrator Integration Tests
  // ============================================================================

  describe('SyncOrchestrator with git providers', () => {
    let orchestrator: SyncOrchestrator;
    let remoteRepo: string;
    let orchDataDir: string;

    beforeAll(() => {
      orchDataDir = mkTestDir(TEST_ROOT, 'orch-data');
      remoteRepo = createTestGitRepo('orchestrator');

      // Register providers for orchestrator to use
      const config = ConfigSchema.parse({
        resourceStorage: { dataDir: orchDataDir },
        resourceSync: { lsRemoteTtl: 60, mirrorFetchTimeout: 30000 },
      });
      initProviders(config);
      orchestrator = new SyncOrchestrator();
    });

    it('should dispatch ensureContent to ls-remote provider', async () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'orch-ls-remote-test',
        git_remote_url: remoteRepo,
        owner_agent_id: agentId,
        sync_strategy: 'ls-remote',
      });

      const result = await orchestrator.ensureContent(resource);
      expect(result).toBeTruthy();
    });

    it('should dispatch handleSyncEvent to mirror provider', async () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'orch-mirror-test',
        git_remote_url: remoteRepo,
        owner_agent_id: agentId,
        sync_strategy: 'mirror',
      });

      // Should not throw
      await expect(orchestrator.handleSyncEvent(resource, getHead(remoteRepo))).resolves.toBeUndefined();

      // Clone should have been created
      expect(gitContent.hasLocalClone(orchDataDir, resource.id)).toBe(true);
    });

    it('should dispatch cleanup to mirror provider', async () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'task',
        name: 'orch-cleanup-test',
        git_remote_url: remoteRepo,
        owner_agent_id: agentId,
        sync_strategy: 'mirror',
      });

      await orchestrator.ensureContent(resource);
      expect(gitContent.hasLocalClone(orchDataDir, resource.id)).toBe(true);

      await orchestrator.cleanup(resource);
      expect(gitContent.hasLocalClone(orchDataDir, resource.id)).toBe(false);
    });
  });
});
