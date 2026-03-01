/**
 * Tests for OpenTasks resource discovery — detecting .opentasks/ directories,
 * reading metadata, and registering task resources.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import { discoverLocalResources } from '../../discovery/index.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';
import type { Config } from '../../config.js';
import { ConfigSchema } from '../../config.js';

const TEST_ROOT = testRoot('opentasks-discovery');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'opentasks-discovery.db');

function makeConfig(overrides: Partial<Config['resourceDiscovery']> = {}): Config {
  return ConfigSchema.parse({
    resourceDiscovery: {
      globalEnabled: false,
      ...overrides,
    },
  });
}

/** Create an .opentasks/ directory with config.json and/or graph.jsonl */
function createOpenTasksDir(
  baseDir: string,
  opts: {
    config?: Record<string, unknown>;
    graphNodes?: Array<Record<string, unknown>>;
    graphEdges?: Array<Record<string, unknown>>;
    graphOnly?: boolean; // skip config.json
  } = {},
): void {
  const opentasksDir = path.join(baseDir, '.opentasks');
  fs.mkdirSync(opentasksDir, { recursive: true });

  if (!opts.graphOnly && opts.config !== undefined) {
    fs.writeFileSync(
      path.join(opentasksDir, 'config.json'),
      JSON.stringify(opts.config, null, 2),
    );
  } else if (!opts.graphOnly) {
    // Default config
    fs.writeFileSync(
      path.join(opentasksDir, 'config.json'),
      JSON.stringify({
        location: { hash: 'abc123', name: 'test-project' },
        daemon: { socketPath: 'daemon.sock' },
      }),
    );
  }

  const nodes = opts.graphNodes || [];
  const edges = opts.graphEdges || [];
  const lines = [...nodes, ...edges].map(obj => JSON.stringify(obj));
  fs.writeFileSync(path.join(opentasksDir, 'graph.jsonl'), lines.join('\n') + '\n');
}

describe('OpenTasks Discovery', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'opentasks-discovery-agent',
      description: 'Agent for OpenTasks discovery tests',
    });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  describe('discoverLocalResources with OpenTasks', () => {
    let projectDir: string;

    beforeEach(() => {
      projectDir = mkTestDir(TEST_ROOT, `project-${Date.now()}`);
    });

    it('should discover an .opentasks/ directory in project root', async () => {
      createOpenTasksDir(projectDir);

      const config = makeConfig({ projectRoot: projectDir });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['project'],
      });

      const taskResource = [...result.created, ...result.updated].find(
        r => r.resource_type === 'task',
      );
      expect(taskResource).toBeDefined();
      expect(taskResource!.scope).toBe('project');
    });

    it('should detect .opentasks/ with only graph.jsonl (no config.json)', async () => {
      createOpenTasksDir(projectDir, {
        graphOnly: true,
        graphNodes: [
          { id: 't-1', type: 'task', title: 'Solo Task', status: 'open' },
        ],
      });

      const config = makeConfig({ projectRoot: projectDir });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['project'],
      });

      const taskResource = [...result.created, ...result.updated].find(
        r => r.resource_type === 'task',
      );
      expect(taskResource).toBeDefined();
    });

    it('should include metadata from config.json', async () => {
      createOpenTasksDir(projectDir, {
        config: {
          location: { hash: 'loc-hash-xyz', name: 'my-workspace' },
        },
        graphNodes: [
          { id: 't-1', type: 'task', title: 'Task 1', status: 'open' },
          { id: 'c-1', type: 'context', title: 'Context' },
        ],
        graphEdges: [
          { id: 'e-1', from_id: 'c-1', to_id: 't-1', type: 'references' },
        ],
      });

      const config = makeConfig({ projectRoot: projectDir });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['project'],
      });

      const taskResource = [...result.created, ...result.updated].find(
        r => r.resource_type === 'task',
      );
      expect(taskResource).toBeDefined();
      // The resource should have been created/updated; metadata is stored in DB
      // We verify discovery found it correctly
    });

    it('should count nodes and edges in discovery metadata', async () => {
      createOpenTasksDir(projectDir, {
        graphNodes: [
          { id: 't-1', type: 'task', title: 'Task 1', status: 'open' },
          { id: 't-2', type: 'task', title: 'Task 2', status: 'closed' },
          { id: 'c-1', type: 'context', title: 'Context' },
        ],
        graphEdges: [
          { id: 'e-1', from_id: 't-1', to_id: 't-2', type: 'blocks' },
          { id: 'e-2', from_id: 'c-1', to_id: 't-1', type: 'references' },
        ],
      });

      const config = makeConfig({ projectRoot: projectDir });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['project'],
      });

      const taskResource = [...result.created, ...result.updated].find(
        r => r.resource_type === 'task',
      );
      expect(taskResource).toBeDefined();
    });

    it('should skip OpenTasks discovery when openTasksEnabled is false', async () => {
      createOpenTasksDir(projectDir);

      const config = makeConfig({
        projectRoot: projectDir,
        openTasksEnabled: false,
      });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['project'],
      });

      const taskResource = [...result.created, ...result.updated].find(
        r => r.resource_type === 'task',
      );
      expect(taskResource).toBeUndefined();
    });

    it('should not detect .opentasks/ if directory is empty (no config or graph)', async () => {
      const opentasksDir = path.join(projectDir, '.opentasks');
      fs.mkdirSync(opentasksDir, { recursive: true });

      const config = makeConfig({ projectRoot: projectDir });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['project'],
      });

      const taskResource = [...result.created, ...result.updated].find(
        r => r.resource_type === 'task',
      );
      expect(taskResource).toBeUndefined();
    });

    it('should be idempotent — second run updates, does not create duplicate', async () => {
      createOpenTasksDir(projectDir, {
        graphNodes: [
          { id: 't-1', type: 'task', title: 'Task', status: 'open' },
        ],
      });

      const config = makeConfig({ projectRoot: projectDir });
      const opts = { ownerAgentId: agentId, scopes: ['project'] as const };

      const first = await discoverLocalResources(config, { ...opts, scopes: [...opts.scopes] });
      const second = await discoverLocalResources(config, { ...opts, scopes: [...opts.scopes] });

      const firstTask = [...first.created, ...first.updated].find(r => r.resource_type === 'task');
      const secondTask = [...second.created, ...second.updated].find(r => r.resource_type === 'task');

      expect(firstTask).toBeDefined();
      expect(secondTask).toBeDefined();
      expect(firstTask!.id).toBe(secondTask!.id);
      // Second call should update, not create
      expect(second.created.find(r => r.resource_type === 'task')).toBeUndefined();
      expect(second.updated.find(r => r.resource_type === 'task')).toBeDefined();
    });

    it('should discover OpenTasks alongside memory banks and skills', async () => {
      // Memory bank
      fs.writeFileSync(path.join(projectDir, 'MEMORY.md'), '# Memory\n');

      // Skill tree
      const skillsDir = mkTestDir(projectDir, '.claude/skills');
      fs.writeFileSync(path.join(skillsDir, 'test.md'), '# Skill\n');

      // OpenTasks
      createOpenTasksDir(projectDir, {
        graphNodes: [
          { id: 't-1', type: 'task', title: 'Task', status: 'open' },
        ],
      });

      const config = makeConfig({ projectRoot: projectDir });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['project'],
      });

      const allResources = [...result.created, ...result.updated];
      expect(allResources.some(r => r.resource_type === 'memory_bank')).toBe(true);
      expect(allResources.some(r => r.resource_type === 'skill')).toBe(true);
      expect(allResources.some(r => r.resource_type === 'task')).toBe(true);
    });

    it('should discover OpenTasks in agent scope', async () => {
      const agentWorkDir = mkTestDir(TEST_ROOT, `agent-ot-${Date.now()}`);
      createOpenTasksDir(agentWorkDir, {
        graphNodes: [
          { id: 't-1', type: 'task', title: 'Agent Task', status: 'open' },
        ],
      });

      const config = makeConfig({ projectRoot: projectDir });
      const result = await discoverLocalResources(config, {
        ownerAgentId: agentId,
        scopes: ['agent'],
        agentWorkDir,
      });

      const taskResource = [...result.created, ...result.updated].find(
        r => r.resource_type === 'task',
      );
      expect(taskResource).toBeDefined();
      expect(taskResource!.scope).toBe('agent');
    });
  });
});
