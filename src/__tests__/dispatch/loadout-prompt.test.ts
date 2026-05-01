/**
 * Prompt-builder + dispatch-source loadout integration tests.
 *
 * Covers the prompt assembly contract documented in src/dispatch/prompt.ts:
 *
 *   [skills.rendered]            — top of prompt (first-run only)
 *   [task.content]
 *   [promptAddendum]             — below criteria (first-run only)
 *   [role line]
 *
 * Continuation/retry prompts intentionally skip the loadout sections —
 * the agent already loaded them on turn 0.
 */

import { describe, it, expect } from 'vitest';
import { openHivePromptBuilder } from '../../dispatch/prompt.js';
import type { MaterializedLoadout } from '../../openteams/types.js';
import type { DispatchTask } from 'swarm-dispatch';

function makeTask(metadata: Record<string, unknown> = {}): DispatchTask {
  return {
    id: 'disp_test',
    title: 'Test dispatch',
    content: '# Body of the dispatched work',
    status: 'open',
    created_at: new Date().toISOString(),
    metadata,
  };
}

function makeLoadout(overrides: Partial<MaterializedLoadout> = {}): MaterializedLoadout {
  return {
    capabilities: ['file.read'],
    mcpScope: [],
    mcpProviders: [],
    permissions: { allow: [], deny: [], ask: [] },
    promptAddendum: '## Reviewer\n\nFocus on correctness.',
    skills: {
      rendered: '<skills>\n  <skill name="security-review" />\n</skills>',
      estimatedTokens: 1234,
      skillBankResourceId: 'res_skillbank',
      items: [{ id: 's1', name: 'security-review' }],
    },
    unresolvedRefs: [],
    materializedAt: new Date().toISOString(),
    ...overrides,
  };
}

// PromptBuilder returns `string | Promise<string>` in the swarm-dispatch
// signature; openHivePromptBuilder is fully synchronous, so this cast
// keeps the test ergonomics clean.
function build(
  task: DispatchTask,
  ctx: { attempt: number; turnCount: number; previousError?: string; role: string },
): string {
  return openHivePromptBuilder(task, ctx) as string;
}

describe('openHivePromptBuilder + materializedLoadout', () => {
  it('embeds rendered skills above task content on first run', () => {
    const out = build(
      makeTask({ materializedLoadout: makeLoadout() }),
      { attempt: 1, turnCount: 0, role: 'reviewer' },
    );

    const skillsIdx = out.indexOf('<skill name="security-review"');
    const bodyIdx = out.indexOf('# Body of the dispatched work');
    expect(skillsIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(skillsIdx);
  });

  it('appends promptAddendum below task body and above role line', () => {
    const out = build(
      makeTask({ materializedLoadout: makeLoadout() }),
      { attempt: 1, turnCount: 0, role: 'reviewer' },
    );

    const bodyIdx = out.indexOf('# Body of the dispatched work');
    const addendumIdx = out.indexOf('## Reviewer');
    const roleIdx = out.indexOf('Role: reviewer');
    expect(addendumIdx).toBeGreaterThan(bodyIdx);
    expect(roleIdx).toBeGreaterThan(addendumIdx);
  });

  it('produces unchanged prompt when no loadout is bound', () => {
    const out = build(
      makeTask({}),
      { attempt: 1, turnCount: 0, role: 'reviewer' },
    );

    expect(out).toContain('# Body of the dispatched work');
    expect(out).toContain('Role: reviewer');
    expect(out).not.toContain('<skill ');
  });

  it('skips loadout sections on continuation (turn > 0)', () => {
    const out = build(
      makeTask({ materializedLoadout: makeLoadout() }),
      { attempt: 1, turnCount: 1, role: 'reviewer' },
    );

    expect(out).toContain('Continue work on dispatch');
    expect(out).not.toContain('<skill ');
    expect(out).not.toContain('## Reviewer');
  });

  it('omits skills section when loadout has no skills', () => {
    const out = build(
      makeTask({ materializedLoadout: makeLoadout({ skills: null }) }),
      { attempt: 1, turnCount: 0, role: 'reviewer' },
    );

    expect(out).not.toContain('<skill ');
    expect(out).toContain('## Reviewer');
  });

  it('handles loadout without promptAddendum gracefully', () => {
    const out = build(
      makeTask({
        materializedLoadout: makeLoadout({
          promptAddendum: '',
        }),
      }),
      { attempt: 1, turnCount: 0, role: 'reviewer' },
    );

    expect(out).toContain('<skill ');
    expect(out).toContain('Role: reviewer');
    expect(out).not.toContain('## Reviewer');
  });
});
