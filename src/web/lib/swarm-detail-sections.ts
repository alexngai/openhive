/**
 * SwarmDetail section registry.
 *
 * SwarmDetail was originally shaped around swarm-runner's "fleet of agents"
 * model — multiple MAP-registered agents, dispatchable specs, coordination
 * broadcasts, etc. For hosted-swarm kinds that own ONE process (claude-code
 * TUI, codex TUI, codex RPC), most of those sections are noise: there's no
 * fleet to spawn into, no nodes to mesh with, no audience for a coordination
 * broadcast.
 *
 * Rather than scatter `if (hosted.kind === ...)` checks across the page,
 * this single function decides which sections render for a given hosted
 * swarm + map-swarm combo. Callers iterate the returned set; new kinds slot
 * in by adding a branch here without touching the page layout.
 *
 * For claude-code specifically, ActiveWork (specs/dispatches) and
 * ComposeMessage (coordination broadcast) are gated on the cc-swarm sidecar
 * actually being connected — their value depends on a recipient that reads
 * mail and acts on it. Pre-sidecar (still booting) or post-disconnect those
 * sections are confusing UI noise.
 */

export type SwarmDetailSectionId =
  | 'active-work'
  | 'terminal'
  | 'logs'
  | 'nodes'
  | 'registered-agents'
  | 'spawn-agent'
  | 'resumable-sessions'
  | 'sessions'
  | 'compose-message'
  | 'messages'
  | 'events'
  | 'peers';

interface SwarmShape {
  status?: 'online' | 'unreachable' | 'offline';
  registered_agents?: ReadonlyArray<unknown>;
}

interface HostedShape {
  kind?: 'swarm-runner' | 'claude-code' | 'codex';
  mode?: 'tui' | 'rpc';
}

/**
 * "Has the cc-swarm sidecar (or any inbound MAP agent) actually registered?"
 * Without this, claude-code rows that just spawned (or got disconnected)
 * would surface ActiveWork / ComposeMessage even though there's no agent
 * listening to act on them.
 */
function hasLiveSidecar(swarm: SwarmShape): boolean {
  return (swarm.registered_agents?.length ?? 0) > 0;
}

export function getSwarmDetailSections(
  hosted: HostedShape | undefined | null,
  swarm: SwarmShape,
): ReadonlySet<SwarmDetailSectionId> {
  const kind = hosted?.kind ?? 'swarm-runner';
  const mode = hosted?.mode;

  // swarm-runner: the historical full layout. Every section makes sense
  // because there's a real fleet, real mesh, real coordination surface.
  if (kind === 'swarm-runner') {
    return new Set<SwarmDetailSectionId>([
      'active-work',
      'terminal',
      'logs',
      'nodes',
      'registered-agents',
      'spawn-agent',
      'resumable-sessions',
      'sessions',
      'compose-message',
      'messages',
      'events',
      'peers',
    ]);
  }

  // claude-code: one TUI driven by a human, observed by cc-swarm sidecar.
  // No fleet to spawn; no peers; logs are the embedded terminal itself.
  if (kind === 'claude-code') {
    const ids = new Set<SwarmDetailSectionId>([
      'terminal',
      // RegisteredAgents stays so the operator can confirm the sidecar
      // attached, but `spawn-agent` is intentionally absent — the user
      // asked to remove the spawn affordance for kinds with no fleet.
      'registered-agents',
      'resumable-sessions',
      'sessions',
    ]);
    if (hasLiveSidecar(swarm)) {
      // Only expose mail-driven surfaces when the sidecar is there to
      // receive them. Pre-sidecar these would be dead ends.
      ids.add('active-work');
      ids.add('compose-message');
    }
    return ids;
  }

  // codex (RPC): chat lives on the Threads page (`/threads/hosted-chat/:id`)
  // alongside session/mail threads, NOT inline on this page. SwarmDetail
  // for an rpc-mode swarm is just the SwarmHeader (process status,
  // controls); the operator goes to Threads to actually drive the chat.
  if (kind === 'codex' && mode === 'rpc') {
    return new Set<SwarmDetailSectionId>();
  }

  // codex (TUI, default): minimal — operator drives the embedded terminal,
  // openhive doesn't see what's going on. Hide everything else until a
  // codex-side observer plugin lands.
  if (kind === 'codex') {
    return new Set<SwarmDetailSectionId>(['terminal']);
  }

  // Unknown kind: render nothing extra; SwarmHeader still mounts in the
  // page directly and gives the operator a way out.
  return new Set();
}
