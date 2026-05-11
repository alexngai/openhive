/**
 * DAL tests for loadout syncable resources.
 *
 * Parallel to team-templates.test.ts. Covers the V45 schema migration's
 * widened CHECK plus the typed wrapper's metadata.content round-trip.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as loadoutsDAL from '../../db/dal/loadouts.js';
import * as agentsDAL from '../../db/dal/agents.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('loadouts-dal');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'loadouts-dal.db');

const SAMPLE: LoadoutContent = {
  name: 'security-auditor',
  extends: 'code-reviewer',
  capabilities: ['file.read', 'git.diff', 'exec.test'],
  mcp_servers: [
    'opentasks',
    { 'chrome-devtools': ['navigate', 'screenshot'] },
  ],
  permissions: {
    allow: ['Read(**)', 'Bash(npm audit:*)'],
    deny: ['Bash(git push:*)'],
  },
  prompt_addendum: '## Security Focus\nPrioritize authn gaps, injection vectors, exposed secrets.',
};

describe('loadouts DAL', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'loadout-owner',
      description: 'dal test',
    });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase().prepare(`DELETE FROM syncable_resources WHERE resource_type = 'loadout'`).run();
  });

  it('creates a row with content stored in metadata.content', () => {
    const lo = loadoutsDAL.createLoadout({
      name: 'security-auditor',
      content: SAMPLE,
      ownerAgentId: agentId,
    });
    expect(lo.id).toMatch(/^res_/);
    expect(lo.resource_type).toBe('loadout');
    expect(lo.git_remote_url).toBe('local://loadout/security-auditor');
    const stored = loadoutsDAL.getLoadoutContent(lo);
    expect(stored?.name).toBe('security-auditor');
    expect(stored?.extends).toBe('code-reviewer');
    expect(stored?.permissions?.deny).toEqual(['Bash(git push:*)']);
  });

  it('round-trips heterogeneous mcp_servers entries', () => {
    const lo = loadoutsDAL.createLoadout({
      name: 'mcp-heavy',
      content: {
        ...SAMPLE,
        name: 'mcp-heavy',
        // Exercise all four shapes: string, scope-only object, inline install spec, ref.
        mcp_servers: [
          'opentasks',
          { 'ast-grep': { exclude: ['dangerous_replace'] } },
          { name: 'bespoke', command: 'node', args: ['./mcp.js'] },
          { ref: '@openhive/secrets-scanner' },
        ],
      },
      ownerAgentId: agentId,
    });
    const stored = loadoutsDAL.getLoadoutContent(lo);
    expect(stored?.mcp_servers).toHaveLength(4);
    expect(stored?.mcp_servers?.[0]).toBe('opentasks');
    expect((stored?.mcp_servers?.[3] as Record<string, unknown>).ref).toBe(
      '@openhive/secrets-scanner',
    );
  });

  it('getLoadout returns null for non-loadout rows', () => {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO syncable_resources (id, resource_type, name, git_remote_url, owner_agent_id)
      VALUES ('res_skill_sample', 'skill', 'a-skill', 'local://skill/x', ?)
    `).run(agentId);
    expect(loadoutsDAL.getLoadout('res_skill_sample')).toBeNull();
  });

  it('lists owned loadouts', () => {
    for (let i = 0; i < 2; i++) {
      loadoutsDAL.createLoadout({
        name: `lo-${i}`,
        content: { ...SAMPLE, name: `lo-${i}` },
        ownerAgentId: agentId,
      });
    }
    const result = loadoutsDAL.listLoadouts({ agentId, owned: true });
    expect(result.total).toBe(2);
    expect(result.data.every((r) => r.resource_type === 'loadout')).toBe(true);
  });

  it('updates content + preserves sibling metadata keys', () => {
    const lo = loadoutsDAL.createLoadout({
      name: 'updatable',
      content: SAMPLE,
      ownerAgentId: agentId,
      metadata: { tags: ['security'] },
    });
    const updated = loadoutsDAL.updateLoadout(lo.id, {
      content: { ...SAMPLE, prompt_addendum: 'updated focus' },
    });
    expect(updated).not.toBeNull();
    const stored = loadoutsDAL.getLoadoutContent(updated!);
    expect(stored?.prompt_addendum).toBe('updated focus');
    const meta = updated!.metadata as Record<string, unknown>;
    expect(meta.tags).toEqual(['security']);
  });

  it('deletes the row', () => {
    const lo = loadoutsDAL.createLoadout({
      name: 'deletable',
      content: SAMPLE,
      ownerAgentId: agentId,
    });
    expect(loadoutsDAL.deleteLoadout(lo.id)).toBe(true);
    expect(loadoutsDAL.getLoadout(lo.id)).toBeNull();
    expect(loadoutsDAL.deleteLoadout(lo.id)).toBe(false);
  });
});
