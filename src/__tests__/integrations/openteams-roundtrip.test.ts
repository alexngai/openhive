/**
 * openteams round-trip safety net.
 *
 * Verifies that authored content stored in OpenHive's resource model
 * round-trips cleanly through openteams' file-based loader. If openteams
 * ever changes its YAML expectations or its file layout assumptions, this
 * test fires before users see breakage in dispatch.
 *
 * Flow:
 *   1. Author content via OpenHive's DAL (matches what authoring API + UI write)
 *   2. Use stageTemplate (the actual production helper) to write to a tmpdir
 *   3. Run openteams' real TemplateLoader.loadAsync against that tmpdir
 *   4. Compare with what resolveTeam produces internally
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { TemplateLoader } from 'openteams';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as teamTemplatesDAL from '../../db/dal/team-templates.js';
import * as loadoutsDAL from '../../db/dal/loadouts.js';
import { resolveTeam } from '../../openteams/resolver.js';
import { stageTemplate } from '../../openteams/resolver.js';
import { _resetCacheForTest } from '../../openteams/cache.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';
import type { TeamTemplateContent } from '../../api/schemas/teams.js';
import type { LoadoutContent } from '../../api/schemas/loadouts.js';

const TEST_ROOT = testRoot('openteams-roundtrip');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'roundtrip.db');

function reviewerLoadout(): LoadoutContent {
  return {
    name: 'reviewer-base',
    description: 'Reviewer base loadout',
    capabilities: ['file.read', 'codebase.search'],
    permissions: { allow: ['Read(**)'], deny: ['Bash(rm -rf:*)'] },
    prompt_addendum: '## Reviewer\n\nFocus on correctness and safety.',
    mcp_servers: [
      'opentasks',
      { name: 'ast-grep', command: 'npx', args: ['ast-grep-mcp'] },
    ],
  };
}

function nonTrivialTeam(): TeamTemplateContent {
  return {
    manifest: {
      name: 'rt-demo',
      version: 1,
      roles: ['planner', 'reviewer', 'implementer'],
      topology: {
        root: { role: 'planner', prompt: 'prompts/planner.md' },
        spawn_rules: { planner: ['reviewer', 'implementer'] },
      },
      mcp_providers: {
        'ast-grep': { command: 'npx', args: ['ast-grep-mcp'] },
      },
    },
    roles: {
      planner: { name: 'planner', description: 'Plans the work' },
      reviewer: {
        name: 'reviewer',
        description: 'Reviews the work',
        // Inline loadout reference by name — must exist in `loadouts` map.
        loadout: 'reviewer-base',
      },
      implementer: {
        name: 'implementer',
        description: 'Writes the code',
        // Inline loadout definition — directly attached.
        loadout: {
          name: 'implementer-inline',
          capabilities: ['file.write', 'exec.test'],
          permissions: { allow: ['Read(**)', 'Write(src/**)'] },
          prompt_addendum: '## Implementer\n\nWrite working code.',
        },
      },
    },
    loadouts: {
      'reviewer-base': reviewerLoadout(),
    },
    prompts: {
      planner: { primary: '# Planner\n\nDecompose tasks.' },
      reviewer: { primary: '# Reviewer\n\nReview output.' },
    },
  };
}

describe('openteams round-trip', () => {
  let agentId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    const { agent } = await agentsDAL.createAgent({ name: 'roundtrip-agent' });
    agentId = agent.id;
    _resetCacheForTest();
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  it('stageTemplate output is parseable by openteams TemplateLoader.loadAsync', async () => {
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'rt-demo',
      content: nonTrivialTeam(),
      ownerAgentId: agentId,
    });

    const stagingDir = await stageTemplate(nonTrivialTeam());
    try {
      // Run openteams' actual loader against the staged directory.
      const direct = await TemplateLoader.loadAsync(stagingDir);

      // Manifest round-trips.
      expect(direct.manifest.name).toBe('rt-demo');
      expect(direct.manifest.roles).toEqual(['planner', 'reviewer', 'implementer']);

      // All three roles present.
      expect(direct.roles.has('planner')).toBe(true);
      expect(direct.roles.has('reviewer')).toBe(true);
      expect(direct.roles.has('implementer')).toBe(true);

      // Reviewer's loadout resolved from the loadouts/ directory.
      const reviewer = direct.roles.get('reviewer')!;
      expect(reviewer.loadout?.capabilities).toEqual(
        expect.arrayContaining(['file.read', 'codebase.search']),
      );
      expect(reviewer.loadout?.promptAddendum).toContain('Focus on correctness');

      // Implementer's inline loadout resolved.
      const implementer = direct.roles.get('implementer')!;
      expect(implementer.loadout?.capabilities).toEqual(
        expect.arrayContaining(['file.write', 'exec.test']),
      );

      // Prompts round-trip.
      const reviewerPrompts = direct.prompts.get('reviewer');
      expect(reviewerPrompts).toBeTruthy();

      // Cross-check: the resolveTeam internal path produces matching shape.
      const internal = await resolveTeam(tmpl.id);
      expect(internal.manifest.name).toBe(direct.manifest.name);
      expect(Array.from(internal.roles.keys()).sort()).toEqual(
        Array.from(direct.roles.keys()).sort(),
      );

      // Deeper structural check: loadout-bearing fields must match for each
      // role so that drift in capabilities, permissions, promptAddendum,
      // mcpScope, or mcpServers is caught before it reaches dispatch.
      for (const roleName of internal.roles.keys()) {
        const internalRole = internal.roles.get(roleName)!;
        const directRole = direct.roles.get(roleName)!;
        const iLdt = internalRole.loadout;
        const dLdt = directRole.loadout;

        if (!iLdt && !dLdt) continue; // no loadout on either — fine

        expect(iLdt).toBeDefined();
        expect(dLdt).toBeDefined();

        // Narrow so subsequent accesses are type-safe without non-null assertions.
        if (!iLdt || !dLdt) continue;

        // capabilities — order-independent comparison
        expect(iLdt.capabilities).toEqual(
          expect.arrayContaining(dLdt.capabilities),
        );
        expect(dLdt.capabilities).toEqual(
          expect.arrayContaining(iLdt.capabilities),
        );

        // permissions allow/deny/ask — order-independent
        expect(iLdt.permissions?.allow ?? []).toEqual(
          expect.arrayContaining(dLdt.permissions?.allow ?? []),
        );
        expect(dLdt.permissions?.allow ?? []).toEqual(
          expect.arrayContaining(iLdt.permissions?.allow ?? []),
        );
        expect(iLdt.permissions?.deny ?? []).toEqual(
          expect.arrayContaining(dLdt.permissions?.deny ?? []),
        );
        expect(dLdt.permissions?.deny ?? []).toEqual(
          expect.arrayContaining(iLdt.permissions?.deny ?? []),
        );
        expect(iLdt.permissions?.ask ?? []).toEqual(
          expect.arrayContaining(dLdt.permissions?.ask ?? []),
        );
        expect(dLdt.permissions?.ask ?? []).toEqual(
          expect.arrayContaining(iLdt.permissions?.ask ?? []),
        );

        // promptAddendum — exact string equality (markdown, ordering matters)
        expect(iLdt.promptAddendum).toBe(dLdt.promptAddendum);

        // mcpScope — order-independent by server name
        const normalizeScope = (scope: typeof iLdt.mcpScope) =>
          [...scope].sort((a, b) => a.server.localeCompare(b.server));
        expect(normalizeScope(iLdt.mcpScope)).toEqual(
          normalizeScope(dLdt.mcpScope),
        );

        // mcpServers (install-bearing entries) — order-independent by name
        const normalizeMcpServers = (entries: typeof iLdt.mcpServers) =>
          [...entries].sort((a, b) => {
            const nameA = 'name' in a ? a.name : ('ref' in a ? a.ref : '');
            const nameB = 'name' in b ? b.name : ('ref' in b ? b.ref : '');
            return nameA.localeCompare(nameB);
          });
        expect(normalizeMcpServers(iLdt.mcpServers)).toEqual(
          normalizeMcpServers(dLdt.mcpServers),
        );
      }
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('extends-chain across hub-stored loadouts resolves through openteams', async () => {
    // Hub-stored standalone loadout (the parent in the extends chain).
    loadoutsDAL.createLoadout({
      name: 'reviewer-base',
      content: reviewerLoadout(),
      ownerAgentId: agentId,
    });

    // Team whose role extends the hub-stored loadout.
    const tmpl = teamTemplatesDAL.createTeamTemplate({
      name: 'rt-extends',
      content: {
        manifest: {
          name: 'rt-extends',
          version: 1,
          roles: ['reviewer'],
          topology: { root: { role: 'reviewer' } },
        },
        roles: {
          reviewer: {
            name: 'reviewer',
            loadout: {
              name: 'reviewer-extends',
              extends: 'reviewer-base',
              capabilities_add: ['exec.test'],
            },
          },
        },
        loadouts: {},
        prompts: {},
      },
      ownerAgentId: agentId,
    });

    // resolveTeam exercises the hub-backed resolveExternalLoadout hook.
    const resolved = await resolveTeam(tmpl.id);
    const role = resolved.roles.get('reviewer')!;

    // Capabilities composed: parent's + capabilities_add.
    expect(role.loadout?.capabilities).toEqual(
      expect.arrayContaining(['file.read', 'codebase.search', 'exec.test']),
    );
    // PromptAddendum inherited from parent (no addendum on the child).
    expect(role.loadout?.promptAddendum).toContain('Focus on correctness');
  });

  it('staged YAML re-parses to a structurally equivalent template (no field loss)', async () => {
    const original = nonTrivialTeam();

    const stagingDir = await stageTemplate(original);
    try {
      const reloaded = await TemplateLoader.loadAsync(stagingDir);

      // Every authored role appears.
      for (const roleName of original.manifest.roles) {
        expect(reloaded.roles.has(roleName)).toBe(true);
      }

      // Manifest extension fields (e.g. mcp_providers) survive.
      expect(reloaded.manifest.mcp_providers).toBeTruthy();
      expect(Object.keys(reloaded.manifest.mcp_providers ?? {})).toContain('ast-grep');
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
