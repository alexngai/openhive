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

  // ── MCP expectation hint (Gap 3 Phase 0 — operator-provisioned model) ────

  it('omits MCP expectation hint when loadout has no providers or scope', () => {
    const out = build(
      makeTask({
        materializedLoadout: makeLoadout({ mcpProviders: [], mcpScope: [] }),
      }),
      { attempt: 1, turnCount: 0, role: 'reviewer' },
    );
    expect(out).not.toContain('Expected MCP servers');
  });

  it('emits MCP expectation hint listing provider names', () => {
    const out = build(
      makeTask({
        materializedLoadout: makeLoadout({
          mcpProviders: [
            { name: 'ast-grep', command: 'npx', args: ['ast-grep-mcp'] },
            { name: '@openhive/secrets-scanner', command: 'node', args: ['scanner.js'] },
          ],
        }),
      }),
      { attempt: 1, turnCount: 0, role: 'reviewer' },
    );
    expect(out).toContain('Expected MCP servers for this role: ast-grep, @openhive/secrets-scanner');
    expect(out).toContain('Verify availability before invoking');
  });

  it('includes scope-only declarations (bare names) in the hint', () => {
    const out = build(
      makeTask({
        materializedLoadout: makeLoadout({
          mcpProviders: [],
          mcpScope: [
            { server: 'chrome-devtools' },
            { server: 'playwright' },
          ],
        }),
      }),
      { attempt: 1, turnCount: 0, role: 'reviewer' },
    );
    expect(out).toContain('Expected MCP servers for this role: chrome-devtools, playwright');
  });

  it('deduplicates between providers and scope', () => {
    const out = build(
      makeTask({
        materializedLoadout: makeLoadout({
          mcpProviders: [{ name: 'ast-grep', command: 'npx' }],
          mcpScope: [{ server: 'ast-grep', tools: ['search'] }],
        }),
      }),
      { attempt: 1, turnCount: 0, role: 'reviewer' },
    );
    // Only one occurrence in the hint line.
    const hintLine = out.split('\n').find((l) => l.startsWith('Expected MCP servers'));
    expect(hintLine).toBeDefined();
    expect((hintLine!.match(/ast-grep/g) ?? []).length).toBe(1);
  });

  it('skips MCP hint on continuation turns', () => {
    const out = build(
      makeTask({
        materializedLoadout: makeLoadout({
          mcpProviders: [{ name: 'ast-grep', command: 'npx' }],
        }),
      }),
      { attempt: 1, turnCount: 1, role: 'reviewer' },
    );
    expect(out).not.toContain('Expected MCP servers');
  });
});

// ============================================================================
// Coordination section (dispatch inbox threads)
// ============================================================================

describe('openHivePromptBuilder coordination section', () => {
  it('includes coordination section with thread tag on first-run', () => {
    const out = build(
      makeTask({
        initiator: { type: 'user', id: 'user_abc' },
        linkedTasks: [{ title: 'Build the API' }],
      }),
      { attempt: 1, turnCount: 0, role: 'worker' },
    );

    expect(out).toContain('## Coordination');
    expect(out).toContain('Thread tag: dispatch-disp_test');
    expect(out).toContain('Initiator: user user_abc');
    expect(out).toContain('Linked tasks: Build the API');
    expect(out).toContain('thread_tag "dispatch-disp_test"');
  });

  it('coordination section appears after task content and before role line', () => {
    const out = build(
      makeTask({ initiator: { type: 'agent', id: 'agent_xyz' } }),
      { attempt: 1, turnCount: 0, role: 'worker' },
    );

    const bodyIdx = out.indexOf('# Body of the dispatched work');
    const coordIdx = out.indexOf('## Coordination');
    const roleIdx = out.indexOf('Role: worker');
    expect(coordIdx).toBeGreaterThan(bodyIdx);
    expect(roleIdx).toBeGreaterThan(coordIdx);
  });

  it('omits initiator line when initiator metadata is absent', () => {
    const out = build(
      makeTask({}),
      { attempt: 1, turnCount: 0, role: 'worker' },
    );

    expect(out).toContain('## Coordination');
    expect(out).not.toContain('Initiator:');
  });

  it('omits linked tasks line when no tasks are provided', () => {
    const out = build(
      makeTask({ initiator: { type: 'user', id: 'u1' } }),
      { attempt: 1, turnCount: 0, role: 'worker' },
    );

    expect(out).not.toContain('Linked tasks:');
  });

  it('retry prompt references existing thread when conversation_id is set', () => {
    const out = build(
      makeTask({ conversation_id: 'dispatch-conv-disp_test' }),
      { attempt: 2, turnCount: 0, previousError: 'timeout', role: 'worker' },
    );

    expect(out).toContain('Retry attempt 2');
    expect(out).toContain('Prior conversation history is available in thread dispatch-disp_test');
  });

  it('retry prompt omits thread reference when no conversation exists', () => {
    const out = build(
      makeTask({}),
      { attempt: 2, turnCount: 0, previousError: 'timeout', role: 'worker' },
    );

    expect(out).toContain('Retry attempt 2');
    expect(out).not.toContain('Prior conversation history');
  });

  it('continuation prompt mentions pending thread messages', () => {
    const out = build(
      makeTask({
        conversation_id: 'dispatch-conv-disp_test',
        pendingThreadMessages: 3,
      }),
      { attempt: 1, turnCount: 2, role: 'worker' },
    );

    expect(out).toContain('3 unread message(s)');
    expect(out).toContain('Check your inbox and respond');
  });

  it('continuation prompt omits thread notice when no pending messages', () => {
    const out = build(
      makeTask({ conversation_id: 'dispatch-conv-disp_test' }),
      { attempt: 1, turnCount: 2, role: 'worker' },
    );

    expect(out).not.toContain('unread message');
  });

  it('coordination section does not appear on continuation turns', () => {
    const out = build(
      makeTask({ initiator: { type: 'user', id: 'u1' } }),
      { attempt: 1, turnCount: 1, role: 'worker' },
    );

    expect(out).not.toContain('## Coordination');
  });
});
