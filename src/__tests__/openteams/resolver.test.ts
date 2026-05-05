/**
 * Resolver tests — covers resolveTeam + materializeRoleLoadout end-to-end
 * against hub-stored team_template + loadout resources.
 *
 * Skill-tree compilation is exercised separately in skill-bridge.test.ts;
 * here we use loadouts without `skills:` so resolveTeam runs without
 * touching any SkillBank.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import * as loadoutsDAL from '../../db/dal/loadouts.js';
import {
  resolveTeam,
  materializeRoleLoadout,
  TemplateNotFoundError,
  RoleNotFoundError,
} from '../../openteams/resolver.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';

const TEST_ROOT = testRoot('openteams-resolver');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'openteams-resolver.db');

// A loadout with capabilities, MCP scope, permissions, prompt_addendum —
// everything except skills. Avoids needing a real SkillBank for these tests.
function reviewerLoadout(): LoadoutContent {
  return {
    name: 'reviewer-bundle',
    description: 'Reviewer loadout',
    capabilities: ['file.read', 'codebase.search'],
    mcp_servers: [
      { name: 'ast-grep', command: 'npx', args: ['ast-grep-mcp'] },
      { ref: '@openhive/secrets-scanner' },
    ],
    permissions: {
      allow: ['Read(**)'],
      deny: ['Bash(rm -rf:*)'],
    },
    prompt_addendum: '## Reviewer\n\nFocus on correctness.',
  };
}

function teamWithInlineLoadout(): TeamTemplateContent {
  return {
    manifest: {
      name: 'demo',
      version: 1,
      roles: ['reviewer'],
      topology: { root: { role: 'reviewer' } },
    },
    roles: {
      reviewer: { loadout: reviewerLoadout() },
    },
    loadouts: {},
    prompts: {},
  };
}

function teamWithExtendsHubLoadout(): TeamTemplateContent {
  return {
    manifest: {
      name: 'demo-extends',
      version: 1,
      roles: ['reviewer'],
      topology: { root: { role: 'reviewer' } },
    },
    roles: {
      reviewer: {
        loadout: {
          name: 'reviewer-extends',
          extends: 'reviewer-base',
          capabilities_add: ['exec.test'],
        },
      },
    },
    loadouts: {},
    prompts: {},
  };
}

describe('openteams resolver', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({ name: 'resolver-test-agent' });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    _resetCacheForTest();
    getDatabase().prepare('DELETE FROM syncable_resources').run();
  });

  // --------------------------------------------------------------------
  // resolveTeam
  // --------------------------------------------------------------------

  describe('resolveTeam', () => {
    it('resolves a team with an inline role loadout', async () => {
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'demo',
        content: teamWithInlineLoadout(),
        ownerAgentId: agentId,
      });

      const resolved = await resolveTeam(tmpl.id);
      expect(resolved.manifest.name).toBe('demo');
      expect(resolved.roles.has('reviewer')).toBe(true);
      const role = resolved.roles.get('reviewer')!;
      expect(role.loadout?.capabilities).toEqual(
        expect.arrayContaining(['file.read', 'codebase.search']),
      );
      expect(role.loadout?.promptAddendum).toContain('Focus on correctness');
    });

    it('throws TemplateNotFoundError for unknown ids', async () => {
      await expect(resolveTeam('res_nonexistent')).rejects.toBeInstanceOf(
        TemplateNotFoundError,
      );
    });

    it('uses content cache — second call does not re-resolve unless content changes', async () => {
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'cache-demo',
        content: teamWithInlineLoadout(),
        ownerAgentId: agentId,
      });

      const a = await resolveTeam(tmpl.id);
      const b = await resolveTeam(tmpl.id);
      expect(a).toBe(b); // identity check — cache hit returns the same object
    });

    it('cache invalidates when content changes', async () => {
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'invalidate-demo',
        content: teamWithInlineLoadout(),
        ownerAgentId: agentId,
      });

      const before = await resolveTeam(tmpl.id);
      const updatedContent = { ...teamWithInlineLoadout() };
      updatedContent.manifest = {
        ...updatedContent.manifest,
        description: 'edited',
      };
      teamTemplatesDAL.updateTeamTemplate(tmpl.id, { content: updatedContent });

      const after = await resolveTeam(tmpl.id);
      expect(after).not.toBe(before);
      expect(after.manifest.description).toBe('edited');
    });

    it('resolves extends against a hub-stored standalone loadout', async () => {
      // Standalone hub-stored loadout
      loadoutsDAL.createLoadout({
        name: 'reviewer-base',
        content: reviewerLoadout(),
        ownerAgentId: agentId,
      });

      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'extends-demo',
        content: teamWithExtendsHubLoadout(),
        ownerAgentId: agentId,
      });

      const resolved = await resolveTeam(tmpl.id);
      const role = resolved.roles.get('reviewer')!;
      expect(role.loadout).toBeTruthy();
      // capabilities_add union'd onto parent's capabilities
      expect(role.loadout!.capabilities).toEqual(
        expect.arrayContaining(['file.read', 'codebase.search', 'exec.test']),
      );
    });
  });

  // --------------------------------------------------------------------
  // materializeRoleLoadout
  // --------------------------------------------------------------------

  describe('materializeRoleLoadout', () => {
    it('returns a fully-baked artifact for a role with inline loadout', async () => {
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'mat-demo',
        content: teamWithInlineLoadout(),
        ownerAgentId: agentId,
      });

      const m = await materializeRoleLoadout(tmpl.id, 'reviewer');
      expect(m.capabilities).toEqual(
        expect.arrayContaining(['file.read', 'codebase.search']),
      );
      expect(m.permissions.allow).toEqual(['Read(**)']);
      expect(m.permissions.deny).toEqual(['Bash(rm -rf:*)']);
      expect(m.promptAddendum).toContain('Focus on correctness');
      expect(m.skills).toBeNull(); // no skills field → null
      expect(m.materializedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('passes inline install spec through as provider', async () => {
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'mcp-inline-demo',
        content: teamWithInlineLoadout(),
        ownerAgentId: agentId,
      });

      const m = await materializeRoleLoadout(tmpl.id, 'reviewer');
      const ag = m.mcpProviders.find((p) => p.name === 'ast-grep');
      expect(ag).toBeTruthy();
      expect(ag?.command).toBe('npx');
    });

    it('surfaces unknown refs in unresolvedRefs', async () => {
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'mcp-ref-demo',
        content: teamWithInlineLoadout(),
        ownerAgentId: agentId,
      });

      const m = await materializeRoleLoadout(tmpl.id, 'reviewer');
      expect(m.unresolvedRefs).toEqual([
        { ref: '@openhive/secrets-scanner', reason: 'not-in-registry' },
      ]);
    });

    it('throws RoleNotFoundError for an unknown role', async () => {
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'role-404',
        content: teamWithInlineLoadout(),
        ownerAgentId: agentId,
      });
      await expect(materializeRoleLoadout(tmpl.id, 'ghost')).rejects.toBeInstanceOf(
        RoleNotFoundError,
      );
    });

    it('returns empty materialization for a role with no loadout', async () => {
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'no-loadout',
        content: {
          manifest: {
            name: 'no-loadout',
            version: 1,
            roles: ['plain'],
            topology: { root: { role: 'plain' } },
          },
          roles: { plain: {} },
          loadouts: {},
          prompts: {},
        },
        ownerAgentId: agentId,
      });

      const m = await materializeRoleLoadout(tmpl.id, 'plain');
      expect(m.capabilities).toEqual([]);
      expect(m.mcpScope).toEqual([]);
      expect(m.skills).toBeNull();
    });
  });
});
