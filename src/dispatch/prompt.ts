/**
 * OpenHive Prompt Builder
 *
 * Flexible, data-driven prompt assembly for dispatched work. The spec content,
 * linked tasks, and instructions are provided as DispatchTask fields by the
 * source adapter; this builder formats them for the agent.
 *
 * Turn-aware: first-run gets full context, continuations get minimal guidance,
 * retries get an error banner. Agents can influence format via spec metadata
 * (metadata.promptHints).
 *
 * When the spec carries a loadout_ref or team_role_ref, the dispatch source
 * pre-materializes the loadout and the builder embeds it. Section ordering
 * (first-run prompts only):
 *
 *   [skills.rendered]            — system-prompt fragment, top of prompt
 *   [task.content / title]       — the dispatched work
 *   [acceptance criteria]
 *   [relevant files]
 *   [promptHints.additionalContext]
 *   [promptAddendum]             — role-specific addendum from the loadout
 *   [role line]                  — "Role: <role>"
 */

import type { PromptBuilder, DispatchTask } from 'swarm-dispatch';
import type { MaterializedLoadout } from '../openteams/types.js';

export const openHivePromptBuilder: PromptBuilder = (
  task: DispatchTask,
  context: { attempt: number; turnCount: number; previousError?: string; role: string },
): string => {
  const meta = task.metadata ?? {};
  const lines: string[] = [];

  if (context.turnCount > 0) {
    lines.push(`Continue work on dispatch ${task.id} (turn ${context.turnCount + 1}).`);
    lines.push('Re-check progress against the original task and proceed.');
    lines.push('');
    lines.push(`Role: ${context.role}`);
    return lines.join('\n');
  }

  if (context.attempt > 1 && context.previousError) {
    lines.push(`> **Retry attempt ${context.attempt}.**`);
    lines.push(`> The previous attempt failed.`);
    lines.push(`> Error: ${context.previousError}`);
    lines.push(`> Review the current state before starting fresh.`);
    lines.push('');
  }

  // Loadout skill bundle goes first so the agent loads it as background
  // context before reading the work.
  const loadout = meta.materializedLoadout as MaterializedLoadout | undefined;
  if (loadout?.skills?.rendered) {
    lines.push(loadout.skills.rendered);
    lines.push('');
  }

  if (task.content) {
    lines.push(task.content);
  } else {
    lines.push(`# ${task.title}`);
    if (meta.description) {
      lines.push('');
      lines.push(String(meta.description));
    }
  }

  if (Array.isArray(meta.criteria) && meta.criteria.length > 0) {
    lines.push('');
    lines.push('## Acceptance Criteria');
    for (const c of meta.criteria) {
      lines.push(`- ${c}`);
    }
  }

  if (Array.isArray(meta.files) && meta.files.length > 0) {
    lines.push('');
    lines.push('## Relevant Files');
    for (const f of meta.files) {
      lines.push(`- ${f}`);
    }
  }

  const hints = meta.promptHints as Record<string, unknown> | undefined;
  if (hints?.additionalContext) {
    lines.push('');
    lines.push(String(hints.additionalContext));
  }

  // Role-specific addendum sits below criteria so it shapes execution
  // style without overriding what to do.
  if (loadout?.promptAddendum) {
    lines.push('');
    lines.push(loadout.promptAddendum);
  }

  lines.push('');
  lines.push(`Role: ${context.role}`);

  return lines.join('\n');
};
