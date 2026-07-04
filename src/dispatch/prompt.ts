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

    // Notify about pending thread messages so the agent prioritizes replies
    const pendingCount = meta.pendingThreadMessages as number | undefined;
    if (meta.conversation_id && pendingCount && pendingCount > 0) {
      lines.push('');
      lines.push(`You have ${pendingCount} unread message(s) in the dispatch thread.`);
      lines.push('Check your inbox and respond before continuing work.');
    }

    lines.push('');
    lines.push(`Role: ${context.role}`);
    return lines.join('\n');
  }

  if (context.attempt > 1 && context.previousError) {
    lines.push(`> **Retry attempt ${context.attempt}.**`);
    lines.push(`> The previous attempt failed.`);
    lines.push(`> Error: ${context.previousError}`);
    lines.push(`> Review the current state before starting fresh.`);
    if (meta.conversation_id) {
      lines.push(`> Prior conversation history is available in thread dispatch-${task.id}.`);
    }
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

  // Coordination channel (dispatch inbox thread)
  // Advertises the thread without creating it — creation is lazy on first message.
  {
    const initiator = meta.initiator as { type?: string; id?: string } | undefined;
    const linkedTasks = Array.isArray(meta.linkedTasks)
      ? (meta.linkedTasks as Array<{ title?: string }>)
          .map((t) => t.title)
          .filter(Boolean)
          .join(', ')
      : undefined;
    lines.push('');
    lines.push('## Coordination');
    lines.push('');
    lines.push('A dispatch thread is available for this work. If you need');
    lines.push('clarification, hit a blocker, or want input from the dispatch');
    lines.push('initiator, post a message.');
    lines.push('');
    lines.push(`  Thread tag: dispatch-${task.id}`);
    if (initiator?.type && initiator?.id) {
      lines.push(`  Initiator: ${initiator.type} ${initiator.id}`);
    }
    if (linkedTasks) {
      lines.push(`  Linked tasks: ${linkedTasks}`);
    }
    lines.push('');
    lines.push('To post, use the agent-inbox send_message tool with');
    lines.push(`thread_tag "dispatch-${task.id}".`);
    lines.push('The thread will be created on your first message.');

    // Coordinated-team mode (P4.2): name the peers and point at the *shared*
    // thread (a real, already-created conversation — advertise its true id so
    // posts land where teammates can see them).
    const peers = Array.isArray(meta.peers)
      ? (meta.peers as Array<{ swarmName?: string; role?: string }>)
      : [];
    const teamThreadId = meta.team_conversation_id as string | undefined;
    if (teamThreadId && peers.length > 0) {
      const roster = peers
        .map((p) => (p.role ? `${p.swarmName} (${p.role})` : p.swarmName))
        .filter(Boolean)
        .join(', ');
      lines.push('');
      lines.push("You're on a coordinated team for this spec. Teammates:");
      lines.push(`  ${roster}`);
      lines.push('');
      lines.push('A shared team thread coordinates all teammates. Post progress,');
      lines.push('blockers, and hand-offs there so peers stay in sync.');
      lines.push(`  Shared thread tag: ${teamThreadId}`);
      lines.push('');
      lines.push('To post to the team, use the agent-inbox send_message tool with');
      lines.push(`thread_tag "${teamThreadId}".`);
    }
  }

  // MCP expectations — advisory list of servers the role expects.
  // OpenHive does not ship MCP install configs to workers (see
  // docs/LOADOUTS_DESIGN.md → "MCP defaults — graceful degradation").
  // Provisioning is the operator's responsibility; this hint exists so the
  // worker can verify availability against its environment's active set.
  if (loadout) {
    const expectedMcps = collectExpectedMcpNames(loadout);
    if (expectedMcps.length > 0) {
      lines.push('');
      lines.push(
        `Expected MCP servers for this role: ${expectedMcps.join(', ')}. ` +
          `Verify availability before invoking; missing servers are not a hard failure.`,
      );
    }
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

/**
 * Collect unique MCP server names from a materialized loadout for the
 * advisory expected-MCP hint. Pulls from both:
 *   - mcpProviders[].name (resolved install specs from authored refs +
 *     inline specs)
 *   - mcpScope[].server (scope-only declarations like bare names)
 *
 * Deduplicated and order-preserving (providers first, then scope).
 */
function collectExpectedMcpNames(loadout: MaterializedLoadout): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const provider of loadout.mcpProviders) {
    if (provider.name && !seen.has(provider.name)) {
      seen.add(provider.name);
      names.push(provider.name);
    }
  }
  for (const scope of loadout.mcpScope) {
    if (scope.server && !seen.has(scope.server)) {
      seen.add(scope.server);
      names.push(scope.server);
    }
  }
  return names;
}
