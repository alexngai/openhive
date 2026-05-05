/**
 * DAL tests for team_template + loadout resource types.
 * Exercises CRUD round-trip, content persistence in metadata, name lookup,
 * and visibility/access semantics inherited from syncable-resources.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import * as loadoutsDAL from '../../db/dal/loadouts.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';

const TEST_ROOT = testRoot('team-templates-loadouts');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'team-templates-loadouts.db');

function sampleLoadout(overrides: Partial<LoadoutContent> = {}): LoadoutContent {
  return {
    name: 'security-auditor',
    description: 'Deep security review loadout',
    skills: { profile: 'security-engineer', max_tokens: 4000 },
    capabilities: ['file.read', 'codebase.search'],
    permissions: { allow: ['Read(**)'], deny: ['Bash(rm -rf:*)'] },
    prompt_addendum: 'Focus on OWASP top 10.',
    ...overrides,
  };
}

function sampleTeamTemplate(overrides: Partial<TeamTemplateContent> = {}): TeamTemplateContent {
  return {
    manifest: {
      name: 'loadout-demo',
      version: 1,
      roles: ['reviewer', 'implementer'],
      topology: { root: { role: 'reviewer' } },
    },
    roles: { reviewer: { loadout: 'security-auditor' } },
    loadouts: { 'security-auditor': sampleLoadout() },
    prompts: { reviewer: '# Reviewer prompt\n\nReview code carefully.' },
    ...overrides,
  };
}

describe('team-templates + loadouts DAL', () => {
  let agentId: string;
  let otherAgentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({ name: 'tmpl-test-agent' });
    agentId = agent.id;
    const { agent: other } = await agentsDAL.createAgent({ name: 'tmpl-other-agent' });
    otherAgentId = other.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    // Wipe any test resources between cases (preserve agents).
    getDatabase().prepare('DELETE FROM syncable_resources').run();
  });

  // ------------------------------------------------------------------
  // loadouts DAL
  // ------------------------------------------------------------------

  describe('loadouts', () => {
    it('createLoadout persists content into metadata.content', () => {
      const ldt = loadoutsDAL.createLoadout({
        name: 'security-auditor',
        content: sampleLoadout(),
        ownerAgentId: agentId,
      });

      expect(ldt.id).toMatch(/^res_/);
      expect(ldt.resource_type).toBe('loadout');
      expect(ldt.name).toBe('security-auditor');
      expect(ldt.owner_agent_id).toBe(agentId);

      const content = loadoutsDAL.getLoadoutContent(ldt);
      expect(content?.skills?.profile).toBe('security-engineer');
      expect(content?.capabilities).toEqual(['file.read', 'codebase.search']);
    });

    it('getLoadout returns null for non-loadout resources', () => {
      const memBank = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'a-bank',
        git_remote_url: '/tmp/bank',
        owner_agent_id: agentId,
      });
      expect(loadoutsDAL.getLoadout(memBank.id)).toBeNull();
    });

    it('getLoadoutByName scopes to (owner, name)', () => {
      loadoutsDAL.createLoadout({
        name: 'shared-name',
        content: sampleLoadout({ name: 'shared-name' }),
        ownerAgentId: agentId,
      });
      loadoutsDAL.createLoadout({
        name: 'shared-name',
        content: sampleLoadout({ name: 'shared-name', description: 'other-owner' }),
        ownerAgentId: otherAgentId,
      });

      const a = loadoutsDAL.getLoadoutByName('shared-name', agentId);
      const b = loadoutsDAL.getLoadoutByName('shared-name', otherAgentId);
      expect(a?.owner_agent_id).toBe(agentId);
      expect(b?.owner_agent_id).toBe(otherAgentId);
      expect(a?.id).not.toBe(b?.id);
    });

    it('updateLoadout merges content without clobbering other metadata keys', () => {
      const ldt = loadoutsDAL.createLoadout({
        name: 'lt',
        content: sampleLoadout(),
        ownerAgentId: agentId,
        metadata: { custom_tag: 'preserve-me' },
      });

      const updated = loadoutsDAL.updateLoadout(ldt.id, {
        content: sampleLoadout({ description: 'updated desc' }),
      });

      expect(updated).not.toBeNull();
      const meta = updated!.metadata as Record<string, unknown>;
      expect(meta.custom_tag).toBe('preserve-me');
      expect(loadoutsDAL.getLoadoutContent(updated!)?.description).toBe('updated desc');
    });

    it('deleteLoadout removes the resource', () => {
      const ldt = loadoutsDAL.createLoadout({
        name: 'gone',
        content: sampleLoadout(),
        ownerAgentId: agentId,
      });
      expect(loadoutsDAL.deleteLoadout(ldt.id)).toBe(true);
      expect(loadoutsDAL.getLoadout(ldt.id)).toBeNull();
    });

    it('listLoadouts returns only loadout-typed resources', () => {
      loadoutsDAL.createLoadout({
        name: 'a',
        content: sampleLoadout({ name: 'a' }),
        ownerAgentId: agentId,
      });
      resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'a-bank',
        git_remote_url: '/tmp/x',
        owner_agent_id: agentId,
      });

      const result = loadoutsDAL.listLoadouts({ agentId });
      expect(result.data.every((r) => r.resource_type === 'loadout')).toBe(true);
      expect(result.data.length).toBeGreaterThanOrEqual(1);
    });

    it('UNIQUE(owner, type, name) enforced for same-owner same-name creation', () => {
      loadoutsDAL.createLoadout({
        name: 'dup',
        content: sampleLoadout({ name: 'dup' }),
        ownerAgentId: agentId,
      });
      expect(() =>
        loadoutsDAL.createLoadout({
          name: 'dup',
          content: sampleLoadout({ name: 'dup' }),
          ownerAgentId: agentId,
        }),
      ).toThrow();
    });
  });

  // ------------------------------------------------------------------
  // team_templates DAL
  // ------------------------------------------------------------------

  describe('team_templates', () => {
    it('createTeamTemplate persists nested content (manifest, roles, loadouts, prompts)', () => {
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'loadout-demo',
        content: sampleTeamTemplate(),
        ownerAgentId: agentId,
      });

      expect(tmpl.resource_type).toBe('team_template');
      const content = teamTemplatesDAL.getTeamTemplateContent(tmpl);
      expect(content?.manifest.name).toBe('loadout-demo');
      expect(content?.manifest.roles).toEqual(['reviewer', 'implementer']);
      expect(content?.loadouts['security-auditor'].skills?.profile).toBe('security-engineer');
      expect(content?.prompts.reviewer).toContain('Review code carefully');
    });

    it('getTeamTemplateByName scopes to owner', () => {
      teamTemplatesDAL.createTeamTemplate({
        name: 'gsd',
        content: sampleTeamTemplate({
          manifest: { name: 'gsd', version: 1, roles: ['planner'], topology: { root: { role: 'planner' } } },
        }),
        ownerAgentId: agentId,
      });
      const found = teamTemplatesDAL.getTeamTemplateByName('gsd', agentId);
      expect(found?.id).toBeTruthy();
      expect(teamTemplatesDAL.getTeamTemplateByName('gsd', otherAgentId)).toBeNull();
    });

    it('updateTeamTemplate replaces content while preserving extra metadata', () => {
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'team-x',
        content: sampleTeamTemplate(),
        ownerAgentId: agentId,
        metadata: { upstreamRef: 'github:foo/bar#abc' },
      });

      const next = sampleTeamTemplate({ prompts: { reviewer: 'updated' } });
      const updated = teamTemplatesDAL.updateTeamTemplate(tmpl.id, { content: next });

      expect(updated).not.toBeNull();
      const meta = updated!.metadata as Record<string, unknown>;
      expect(meta.upstreamRef).toBe('github:foo/bar#abc');
      expect(teamTemplatesDAL.getTeamTemplateContent(updated!)?.prompts.reviewer).toBe('updated');
    });

    it('listTeamTemplates only returns team_template-typed resources', () => {
      teamTemplatesDAL.createTeamTemplate({
        name: 't1',
        content: sampleTeamTemplate({
          manifest: { name: 't1', version: 1, roles: ['r'], topology: { root: { role: 'r' } } },
        }),
        ownerAgentId: agentId,
      });
      loadoutsDAL.createLoadout({
        name: 'a-loadout',
        content: sampleLoadout({ name: 'a-loadout' }),
        ownerAgentId: agentId,
      });

      const result = teamTemplatesDAL.listTeamTemplates({ agentId });
      expect(result.data.every((r) => r.resource_type === 'team_template')).toBe(true);
    });

    it('deleteTeamTemplate removes the resource', () => {
      const tmpl = teamTemplatesDAL.createTeamTemplate({
        name: 'doomed',
        content: sampleTeamTemplate({
          manifest: { name: 'doomed', version: 1, roles: ['r'], topology: { root: { role: 'r' } } },
        }),
        ownerAgentId: agentId,
      });
      expect(teamTemplatesDAL.deleteTeamTemplate(tmpl.id)).toBe(true);
      expect(teamTemplatesDAL.getTeamTemplate(tmpl.id)).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // Cross-type interactions
  // ------------------------------------------------------------------

  describe('type isolation', () => {
    it('listAccessibleResources with type filter returns the right type only', () => {
      teamTemplatesDAL.createTeamTemplate({
        name: 'team-iso',
        content: sampleTeamTemplate({
          manifest: { name: 'team-iso', version: 1, roles: ['r'], topology: { root: { role: 'r' } } },
        }),
        ownerAgentId: agentId,
      });
      loadoutsDAL.createLoadout({
        name: 'ldt-iso',
        content: sampleLoadout({ name: 'ldt-iso' }),
        ownerAgentId: agentId,
      });

      const teamsList = resourcesDAL.listAccessibleResources({
        agentId,
        resourceType: 'team_template',
      });
      const loadoutsList = resourcesDAL.listAccessibleResources({
        agentId,
        resourceType: 'loadout',
      });
      expect(teamsList.data.every((r) => r.resource_type === 'team_template')).toBe(true);
      expect(loadoutsList.data.every((r) => r.resource_type === 'loadout')).toBe(true);
    });
  });
});
