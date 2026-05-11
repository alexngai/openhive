/**
 * DAL tests for team_template syncable resources.
 *
 * Exercises the V45 schema migration (CHECK widened for the new type) and
 * the typed wrapper's metadata.content round-trip.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import * as agentsDAL from '../../db/dal/agents.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('team-templates-dal');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'team-templates-dal.db');

const SAMPLE: TeamTemplateContent = {
  manifest: {
    name: 'gsd-mini',
    version: 1,
    description: 'tiny three-role team',
    roles: ['orchestrator', 'planner', 'executor'],
    topology: {
      root: { role: 'orchestrator' },
      spawn_rules: { orchestrator: ['planner', 'executor'] },
    },
  },
  roles: {
    orchestrator: { name: 'orchestrator', capabilities: ['plan', 'coordinate'] },
    planner: { name: 'planner', extends: 'orchestrator' },
    executor: { name: 'executor', capabilities: ['code', 'test'] },
  },
};

describe('team_templates DAL', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'team-template-owner',
      description: 'dal test',
    });
    agentId = agent.id;
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  beforeEach(() => {
    getDatabase().prepare(`DELETE FROM syncable_resources WHERE resource_type = 'team_template'`).run();
  });

  it('creates a row with content stored in metadata.content', () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'gsd-mini',
      content: SAMPLE,
      ownerAgentId: agentId,
    });
    expect(tmpl.id).toMatch(/^res_/);
    expect(tmpl.resource_type).toBe('team_template');
    expect(tmpl.git_remote_url).toBe('local://team_template/gsd-mini');
    const stored = teamTemplatesDAL.getTeamTemplateContent(tmpl);
    expect(stored?.manifest.name).toBe('gsd-mini');
    expect(stored?.roles?.planner.extends).toBe('orchestrator');
  });

  it('round-trips arbitrary extension namespaces in content', () => {
    const withExt: TeamTemplateContent = {
      ...SAMPLE,
      // openteams stores extension namespaces verbatim per the design.
      macro_agent: { task_assignment: { mode: 'pull' } },
    } as TeamTemplateContent;
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'with-ext',
      content: withExt,
      ownerAgentId: agentId,
    });
    const stored = teamTemplatesDAL.getTeamTemplateContent(tmpl) as Record<string, unknown>;
    expect(stored.macro_agent).toEqual({ task_assignment: { mode: 'pull' } });
  });

  it('getTeamTemplate is type-narrowed: returns null for non-team_template rows', () => {
    // A row created via a different DAL flow should not be returned here.
    // We synthesize one by inserting a `task` row directly.
    const db = getDatabase();
    db.prepare(`
      INSERT INTO syncable_resources (id, resource_type, name, git_remote_url, owner_agent_id)
      VALUES (?, 'task', 'sample-task', 'local://task/x', ?)
    `).run('res_task_sample', agentId);
    expect(teamTemplatesDAL.getTeamTemplate('res_task_sample')).toBeNull();
  });

  it('lists owned templates with pagination', () => {
    for (let i = 0; i < 3; i++) {
      teamTemplatesDAL.createTeamTemplate({
        name: `tmpl-${i}`,
        content: { ...SAMPLE, manifest: { ...SAMPLE.manifest, name: `tmpl-${i}` } },
        ownerAgentId: agentId,
      });
    }
    const result = teamTemplatesDAL.listTeamTemplates({ agentId, owned: true, limit: 10 });
    expect(result.total).toBe(3);
    expect(result.data).toHaveLength(3);
    expect(result.data.every((r) => r.resource_type === 'team_template')).toBe(true);
  });

  it('updates content + preserves other metadata keys', () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'updatable',
      content: SAMPLE,
      ownerAgentId: agentId,
      metadata: { tags: ['research'], publisher: { id: 'did:example' } },
    });
    const updated = teamTemplatesDAL.updateTeamTemplate(tmpl.id, {
      content: {
        ...SAMPLE,
        manifest: { ...SAMPLE.manifest, description: 'updated' },
      },
    });
    expect(updated).not.toBeNull();
    const stored = teamTemplatesDAL.getTeamTemplateContent(updated!);
    expect(stored?.manifest.description).toBe('updated');
    // Sibling metadata keys are not clobbered by the content update.
    const meta = updated!.metadata as Record<string, unknown>;
    expect(meta.tags).toEqual(['research']);
    expect(meta.publisher).toEqual({ id: 'did:example' });
  });

  it('returns null when updating a missing id', () => {
    expect(teamTemplatesDAL.updateTeamTemplate('res_does_not_exist', { description: 'x' })).toBeNull();
  });

  it('deletes the row', () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'deletable',
      content: SAMPLE,
      ownerAgentId: agentId,
    });
    expect(teamTemplatesDAL.deleteTeamTemplate(tmpl.id)).toBe(true);
    expect(teamTemplatesDAL.getTeamTemplate(tmpl.id)).toBeNull();
    // Idempotency: deleting again returns false.
    expect(teamTemplatesDAL.deleteTeamTemplate(tmpl.id)).toBe(false);
  });
});
