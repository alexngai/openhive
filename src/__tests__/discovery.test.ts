import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../db/index.js';
import * as agentsDAL from '../db/dal/agents.js';
import * as resourcesDAL from '../db/dal/syncable-resources.js';
import { discoverLocalResources } from '../discovery/index.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from './helpers/test-dirs.js';
import type { Config } from '../config.js';
import { ConfigSchema } from '../config.js';

const TEST_ROOT = testRoot('discovery');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'discovery-test.db');

// Create a minimal config for testing
function makeConfig(overrides: Partial<Config['resourceDiscovery']> = {}): Config {
  return ConfigSchema.parse({
    resourceDiscovery: {
      globalEnabled: false,
      ...overrides,
    },
  });
}

describe('Resource Discovery', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'discovery-test-agent',
      description: 'Agent for discovery tests',
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
    it('should create a resource with scope field', () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'test-scoped-resource',
        git_remote_url: '/tmp/test-resource',
        owner_agent_id: agentId,
        scope: 'project',
      });

      expect(resource.scope).toBe('project');
    });

    it('should default scope to manual', () => {
      const resource = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'test-default-scope',
        git_remote_url: '/tmp/test-default',
        owner_agent_id: agentId,
      });

      expect(resource.scope).toBe('manual');
    });

    it('should upsert a discovered resource (create)', () => {
      const { resource, created } = resourcesDAL.upsertDiscoveredResource({
        resource_type: 'memory_bank',
        name: 'test-upsert-new',
        description: 'First time',
        git_remote_url: '/tmp/upsert-test',
        owner_agent_id: agentId,
        scope: 'global',
      });

      expect(created).toBe(true);
      expect(resource.name).toBe('test-upsert-new');
      expect(resource.scope).toBe('global');
      expect(resource.description).toBe('First time');
    });

    it('should upsert a discovered resource (update)', () => {
      const { resource, created } = resourcesDAL.upsertDiscoveredResource({
        resource_type: 'memory_bank',
        name: 'test-upsert-new', // same name + type + owner = existing
        description: 'Updated',
        git_remote_url: '/tmp/upsert-test-v2',
        owner_agent_id: agentId,
        scope: 'global',
      });

      expect(created).toBe(false);
      expect(resource.description).toBe('Updated');
      expect(resource.git_remote_url).toBe('/tmp/upsert-test-v2');
    });

    it('should filter resources by scope', () => {
      // Create a project-scoped resource
      resourcesDAL.createResource({
        resource_type: 'skill',
        name: 'test-scope-filter',
        git_remote_url: '/tmp/scope-filter',
        owner_agent_id: agentId,
        scope: 'project',
      });

      const globalResult = resourcesDAL.listAccessibleResources({
        agentId,
        scope: 'global',
      });

      const projectResult = resourcesDAL.listAccessibleResources({
        agentId,
        scope: 'project',
      });

      // Global scope should have the upserted resource
      expect(globalResult.data.some(r => r.name === 'test-upsert-new')).toBe(true);
      // Project scope should have the project resource
      expect(projectResult.data.some(r => r.name === 'test-scope-filter')).toBe(true);
      // Global scope should NOT have the project resource
      expect(globalResult.data.some(r => r.name === 'test-scope-filter')).toBe(false);
    });
  });

  // ============================================================================
  // Discovery Service Tests
  // ============================================================================

  describe('discoverLocalResources', () => {
    let projectDir: string;
    let memoryDir: string;
    let skillDir: string;

    beforeEach(() => {
      // Create fresh test directories for each test
      projectDir = mkTestDir(TEST_ROOT, `project-${Date.now()}`);
    });

    it('should discover a minimem memory bank in project root', async () => {
      // Create a MEMORY.md file (minimem detects MEMORY.md or memory/*.md)
      fs.writeFileSync(path.join(projectDir, 'MEMORY.md'), '# My Memory\n\nSome content.\n');

      const config = makeConfig({ projectRoot: projectDir });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['project'],
      });

      expect(result.created.length).toBeGreaterThanOrEqual(1);
      const memResource = result.created.find(r => r.resource_type === 'memory_bank');
      expect(memResource).toBeDefined();
      expect(memResource!.name).toBe('project/minimem-memory');
      expect(memResource!.scope).toBe('project');
      expect(memResource!.path).toBe(projectDir);
    });

    it('should discover minimem memory bank in memory/ subdirectory', async () => {
      // Create memory/notes.md
      memoryDir = mkTestDir(projectDir, 'memory');
      fs.writeFileSync(path.join(memoryDir, 'notes.md'), '# Notes\n\nSome notes.\n');

      const config = makeConfig({ projectRoot: projectDir });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['project'],
      });

      const memResource = [...result.created, ...result.updated].find(
        r => r.resource_type === 'memory_bank' && r.name === 'project/minimem-memory'
      );
      expect(memResource).toBeDefined();
    });

    it('should discover .claude/skills directory', async () => {
      const claudeSkillsDir = mkTestDir(projectDir, '.claude/skills');
      fs.writeFileSync(path.join(claudeSkillsDir, 'test.md'), '# Test Skill\n');

      const config = makeConfig({ projectRoot: projectDir });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['project'],
      });

      const skillResource = [...result.created, ...result.updated].find(
        r => r.name === 'project/claude-skills'
      );
      expect(skillResource).toBeDefined();
      expect(skillResource!.resource_type).toBe('skill');
      expect(skillResource!.scope).toBe('project');
    });

    it('should skip global discovery when disabled', async () => {
      const config = makeConfig({ globalEnabled: false });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['global'],
      });

      expect(result.created.length).toBe(0);
      expect(result.skipped.some(s => s.reason.includes('disabled'))).toBe(true);
    });

    it('should be idempotent on repeated calls', async () => {
      fs.writeFileSync(path.join(projectDir, 'MEMORY.md'), '# Memory\n');

      const config = makeConfig({ projectRoot: projectDir });
      const opts = { ownerAgentId: agentId, scopes: ['project'] as const };

      const first = await discoverLocalResources(config, { ...opts, scopes: [...opts.scopes] });
      const second = await discoverLocalResources(config, { ...opts, scopes: [...opts.scopes] });

      // Both calls should produce a result (create or update)
      const firstMem = [...first.created, ...first.updated].find(r => r.resource_type === 'memory_bank');
      const secondMem = [...second.created, ...second.updated].find(r => r.resource_type === 'memory_bank');

      expect(firstMem).toBeDefined();
      expect(secondMem).toBeDefined();
      // Should be the same resource ID
      expect(firstMem!.id).toBe(secondMem!.id);
      // Second call should be an update, not a create
      expect(second.created.find(r => r.resource_type === 'memory_bank')).toBeUndefined();
      expect(second.updated.find(r => r.resource_type === 'memory_bank')).toBeDefined();
    });

    it('should discover agent-scope resources', async () => {
      const agentWorkDir = mkTestDir(TEST_ROOT, `agent-workdir-${Date.now()}`);
      fs.writeFileSync(path.join(agentWorkDir, 'MEMORY.md'), '# Agent Memory\n');

      const config = makeConfig({ projectRoot: projectDir });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['agent'],
        agentWorkDir,
      });

      const memResource = result.created.find(
        r => r.resource_type === 'memory_bank' && r.name === 'agent/minimem-memory'
      );
      expect(memResource).toBeDefined();
      expect(memResource!.scope).toBe('agent');
    });

    it('should skip non-existent paths', async () => {
      const config = makeConfig({
        projectRoot: '/tmp/nonexistent-path-for-testing-12345',
      });

      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['project'],
      });

      expect(result.created.length).toBe(0);
      expect(result.skipped.some(s => s.reason === 'Path does not exist')).toBe(true);
    });

    it('should discover all scopes in a single call', async () => {
      fs.writeFileSync(path.join(projectDir, 'MEMORY.md'), '# Project Memory\n');

      const agentWorkDir = mkTestDir(TEST_ROOT, `multi-scope-agent-${Date.now()}`);
      fs.writeFileSync(path.join(agentWorkDir, 'MEMORY.md'), '# Agent Memory\n');

      const config = makeConfig({
        globalEnabled: false,
        projectRoot: projectDir,
      });

      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['global', 'project', 'agent'],
        agentWorkDir,
      });

      // Global is disabled, so skipped
      expect(result.skipped.some(s => s.reason.includes('disabled'))).toBe(true);

      // Project and agent should each have a memory bank
      const allResources = [...result.created, ...result.updated];
      expect(allResources.some(r => r.scope === 'project' && r.resource_type === 'memory_bank')).toBe(true);
      expect(allResources.some(r => r.scope === 'agent' && r.resource_type === 'memory_bank')).toBe(true);
    });
  });
});
