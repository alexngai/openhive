/**
 * Lock-in test — `loadout.openhive.skillBankRef` resolution path.
 *
 * The skill-bank binding lives in the consumer extension namespace
 * (`loadout.openhive.skillBankRef`), not on openteams' core SkillsConfig.
 * This is intentional (see docs/LOADOUTS_DESIGN.md → "skillBankRef binding")
 * but fragile: it depends on openteams' loader preserving unknown top-level
 * keys verbatim through `LoadoutDefinition`'s `[key: string]: unknown`
 * index signature. A future openteams version that tightens its schema
 * would silently drop the `openhive` block and skill compilation would
 * stop running, with no error — `MaterializedLoadout.skills` would just
 * become `null`.
 *
 * These tests fire if that ever happens, before the regression reaches
 * production.
 *
 * Cases:
 *   (a) loadout-level ref drives skill compilation
 *   (b) team-level defaultSkillBankRef is the fallback when loadout has no ref
 *   (c) loadout-level ref wins over team-level default
 *   (d) ref pointing at a non-existent resource → skills:null (graceful)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as path from 'path';
import { initDatabase, closeDatabase, getDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import * as loadoutsDAL from '../../db/dal/loadouts.js';
import {
  materializeLoadoutById,
  materializeRoleLoadout,
} from '../../openteams/resolver.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { evictServingLayer } from '../../skill-tree/serving.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import {
  createTestSkillBank,
  MARKER_SKILL,
  SKILL_MARKER,
} from '../helpers/skill-bank-fixture.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';

const TEST_ROOT = testRoot('skill-bank-ref');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'skill-bank-ref.db');

describe('openhive.skillBankRef resolution (lock-in)', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({
      name: 'skill-bank-ref-test',
    });
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

  // ------------------------------------------------------------------------
  // (a) loadout-level ref survives openteams + drives skill-tree compilation
  // ------------------------------------------------------------------------
  it('loadout.openhive.skillBankRef resolves and skills compile against it', async () => {
    const bankId = createTestSkillBank({
      agentId,
      bankDir: path.join(TEST_ROOT, 'bank-loadout-level'),
      nameSuffix: '-loadout-level',
    });

    const loadoutContent = {
      name: 'with-bank-ref',
      skills: { include: [MARKER_SKILL.id] },
      openhive: { skillBankRef: bankId },
    } as LoadoutContent;

    const ldt = loadoutsDAL.createLoadout({
      name: 'with-bank-ref',
      content: loadoutContent,
      ownerAgentId: agentId,
    });

    const m = await materializeLoadoutById(ldt.id);

    // The whole point: skills compiled, marker is in the rendered fragment.
    expect(m.skills).not.toBeNull();
    expect(m.skills!.skillBankResourceId).toBe(bankId);
    expect(m.skills!.rendered).toContain(SKILL_MARKER);
    expect(m.skills!.items.map((i) => i.id)).toContain(MARKER_SKILL.id);

    evictServingLayer(bankId);
  });

  // ------------------------------------------------------------------------
  // (b) team-level defaultSkillBankRef is the fallback when loadout omits ref
  // ------------------------------------------------------------------------
  it('team_template.metadata.defaultSkillBankRef is used when loadout has no openhive block', async () => {
    const bankId = createTestSkillBank({
      agentId,
      bankDir: path.join(TEST_ROOT, 'bank-team-default'),
      nameSuffix: '-team-default',
    });

    const teamContent: TeamTemplateContent = {
      manifest: {
        name: 'team-default-bank',
        version: 1,
        roles: ['executor'],
        topology: { root: { role: 'executor' } },
      },
      roles: {
        executor: {
          name: 'executor',
          loadout: {
            name: 'no-ref',
            skills: { include: [MARKER_SKILL.id] },
            // No `openhive:` key — relies on team-level default.
          },
        },
      },
      loadouts: {},
      prompts: {},
    };

    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'team-default-bank',
      content: teamContent,
      ownerAgentId: agentId,
      metadata: { defaultSkillBankRef: bankId },
    });

    const m = await materializeRoleLoadout(tmpl.id, 'executor');

    expect(m.skills).not.toBeNull();
    expect(m.skills!.skillBankResourceId).toBe(bankId);
    expect(m.skills!.rendered).toContain(SKILL_MARKER);

    evictServingLayer(bankId);
  });

  // ------------------------------------------------------------------------
  // (c) loadout-level ref wins over team-level default
  // ------------------------------------------------------------------------
  it('loadout-level openhive.skillBankRef wins over team_template defaultSkillBankRef', async () => {
    const winningBankId = createTestSkillBank({
      agentId,
      bankDir: path.join(TEST_ROOT, 'bank-winning'),
      nameSuffix: '-winning',
    });
    // Different bank id — must NOT be the one that ends up bound.
    const losingBankId = createTestSkillBank({
      agentId,
      bankDir: path.join(TEST_ROOT, 'bank-losing'),
      nameSuffix: '-losing',
    });

    const teamContent: TeamTemplateContent = {
      manifest: {
        name: 'override-team',
        version: 1,
        roles: ['executor'],
        topology: { root: { role: 'executor' } },
      },
      roles: {
        executor: {
          name: 'executor',
          loadout: {
            name: 'override-loadout',
            skills: { include: [MARKER_SKILL.id] },
            openhive: { skillBankRef: winningBankId },
          },
        },
      },
      loadouts: {},
      prompts: {},
    };

    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'override-team',
      content: teamContent,
      ownerAgentId: agentId,
      metadata: { defaultSkillBankRef: losingBankId },
    });

    const m = await materializeRoleLoadout(tmpl.id, 'executor');

    expect(m.skills).not.toBeNull();
    expect(m.skills!.skillBankResourceId).toBe(winningBankId);
    expect(m.skills!.skillBankResourceId).not.toBe(losingBankId);

    evictServingLayer(winningBankId);
    evictServingLayer(losingBankId);
  });

  // ------------------------------------------------------------------------
  // (d) ref pointing at a non-existent resource → skills:null (graceful)
  // Locks in current behaviour. If we ever surface an
  // `unresolvedSkillBankRef` field on MaterializedLoadout, update here.
  // ------------------------------------------------------------------------
  it('skillBankRef pointing at a non-existent resource degrades to skills:null', async () => {
    const loadoutContent = {
      name: 'bad-ref',
      skills: { include: [MARKER_SKILL.id] },
      openhive: { skillBankRef: 'res_does_not_exist_xyz' },
    } as LoadoutContent;

    const ldt = loadoutsDAL.createLoadout({
      name: 'bad-ref',
      content: loadoutContent,
      ownerAgentId: agentId,
    });

    const m = await materializeLoadoutById(ldt.id);
    expect(m.skills).toBeNull();
  });
});
