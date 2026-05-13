/**
 * SessionPicker — agent picker for the ChatFab
 *
 * Shows one row per chat-capable agent across all online swarms, grouped by
 * parent swarm. Each swarm may expose multiple coordinators, so listing at
 * the agent level lets the user pick a specific one instead of always
 * landing on "whichever ACP agent the hub found first." Sidecars are
 * filtered out (they're the connection itself, not a participant).
 *
 * Each swarm group exposes a "+" button to spawn a new agent on that swarm
 * — covers the "swarm exists but no chat agent yet" case and the common
 * "spawn another coordinator here" case. After a successful spawn we
 * auto-connect via `connectAndOpen` so the user lands directly in chat.
 */

import { useState } from 'react';
import { Zap, Plus, Loader2, Radio, RotateCw, Play, Server } from 'lucide-react';
import { AgentAvatar } from '../common/AgentAvatar';
import clsx from 'clsx';
import { useMapSwarmsForPicker, useConnectAcp, useHostedSwarms, useRestartSwarm } from '../../hooks/useApi';
import { useSwarmRealtime } from '../../hooks/useRealtimeInvalidation';
import { useChatFabStore } from './ChatFabStore';
import type { MapSwarm, HostedSwarm } from '../../lib/api';
import { getPeerMapId } from '../../lib/map';
import { SpawnAgentDialog } from '../swarm/SpawnAgentDialog';
import { SpawnFormDialog } from '../../pages/Swarms';

interface RegisteredAgent {
  id: string;
  name?: string;
  role?: string;
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** An agent surfaced in the picker, annotated with its parent swarm's context. */
interface PickerAgent {
  agent: RegisteredAgent;
  swarm: MapSwarm;
  mode: 'acp' | 'mail';
}

interface SwarmGroup {
  swarm: MapSwarm;
  agents: PickerAgent[];
  spawnable: boolean;
}

function isOnline(s: MapSwarm): boolean {
  return s.status === 'online';
}

/**
 * Whether the swarm supports agent spawning via `_macro/spawnAgent`. Only
 * hub-spawned macro-agent swarms get `lifecycle: true` on their capabilities
 * record (set in `swarm/manager.ts`). cc-swarm self-registers without it.
 */
function canSpawnAgents(s: MapSwarm): boolean {
  const caps = s.capabilities as Record<string, unknown> | null | undefined;
  return !!caps?.lifecycle;
}

function getRegisteredAgents(s: MapSwarm): RegisteredAgent[] {
  return (
    (s as unknown as { registered_agents?: RegisteredAgent[] }).registered_agents ?? []
  );
}

function hasSwarmMail(s: MapSwarm): boolean {
  const mail = (s.capabilities as Record<string, unknown> | null | undefined)?.mail as
    | Record<string, unknown>
    | undefined;
  return !!mail && (mail.canCreate === true || mail.canJoin === true);
}

function agentHasAcp(agent: RegisteredAgent): boolean {
  const protos = agent.capabilities?.protocols;
  return Array.isArray(protos) && protos.includes('acp');
}

/**
 * Determine an agent's effective chat mode. ACP is per-agent (the agent
 * itself must declare `protocols: ['acp']`), but mail is a swarm-level
 * capability — any agent on a mail-capable swarm is addressable over mail.
 * Returns `null` when the agent isn't addressable at all.
 */
function getAgentChatMode(agent: RegisteredAgent, swarm: MapSwarm): 'acp' | 'mail' | null {
  if (agentHasAcp(agent)) return 'acp';
  if (hasSwarmMail(swarm)) return 'mail';
  return null;
}

/**
 * Best-effort default cwd surfaced to the spawn dialog as a placeholder /
 * fallback hint. Mirrors what `SwarmDetail` does (minus the hosted-swarm
 * data_dir, which the picker doesn't fetch).
 */
function getSwarmDefaultCwd(swarm: MapSwarm): string | undefined {
  const meta = swarm.metadata as Record<string, unknown> | null | undefined;
  const caps = swarm.capabilities as Record<string, unknown> | null | undefined;
  const candidates = [meta?.cwd, meta?.projectPath, caps?.projectPath];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  return undefined;
}

/**
 * Group online swarms with their chat-capable agents. Empty groups are kept
 * only when the swarm supports agent spawning (macro-agent) so the user can
 * spawn into them; non-spawnable swarms (e.g. cc-swarm) with zero chat
 * agents are dropped since they offer no actionable path.
 */
export function buildSwarmGroups(swarms: MapSwarm[]): SwarmGroup[] {
  return swarms
    .map((swarm) => {
      const agents: PickerAgent[] = [];
      for (const agent of getRegisteredAgents(swarm)) {
        if (agent.role === 'sidecar') continue;
        const mode = getAgentChatMode(agent, swarm);
        if (!mode) continue;
        agents.push({ agent, swarm, mode });
      }
      return { swarm, agents, spawnable: canSpawnAgents(swarm) };
    })
    .filter((g) => g.agents.length > 0 || g.spawnable);
}

/**
 * Flat per-agent view used by the original picker tests. Kept as a thin
 * derivation over `buildSwarmGroups` so the same filtering rules apply.
 */
export function buildPickerAgents(swarms: MapSwarm[]): PickerAgent[] {
  return buildSwarmGroups(swarms).flatMap((g) => g.agents);
}

export function SessionPicker() {
  // Subscribe to swarm lifecycle WS events so the picker auto-refreshes when
  // a swarm comes online or a coordinator gets spawned inside one.
  useSwarmRealtime();
  const { data: swarms = [] } = useMapSwarmsForPicker({ status: 'online' });
  const connectAcp = useConnectAcp();
  const setSession = useChatFabStore((s) => s.setSession);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spawnFor, setSpawnFor] = useState<MapSwarm | null>(null);
  const [showSpawnSwarm, setShowSpawnSwarm] = useState(false);

  const onlineSwarms = swarms.filter(isOnline);
  const groups = buildSwarmGroups(onlineSwarms);

  // Row key must be unique per agent, not per swarm, because a swarm may
  // surface multiple ACP coordinators.
  const rowKey = (p: PickerAgent) => `${p.swarm.id}:${p.agent.id}`;

  const connectToAgent = async (
    swarm: MapSwarm,
    agent: RegisteredAgent,
    mode: 'acp' | 'mail',
    keyForLoading: string,
  ) => {
    setConnecting(keyForLoading);
    setError(null);

    // Prefer the peer-side MAP id (the swarm-local ULID) so ACP streams
    // route correctly through the peer's MAP server. Falls back to the
    // hub-assigned id for flows that don't use a peer MAP server.
    const targetId = getPeerMapId(agent.metadata) ?? agent.id;
    const displayName = agent.name ?? agent.id;

    // agentRef carries the *hub* agent id (pre-peer-map), which is what
    // `registered_agents[].id` surfaces on the swarm detail. The header
    // also falls back to matching `metadata.peerMapId`, so passing
    // either is fine; we pass agent.id for consistency across ACP and
    // mail fallbacks.
    const agentRef = { swarmId: swarm.id, agentId: agent.id };

    try {
      if (mode === 'acp') {
        const result = await connectAcp.mutateAsync({ swarmId: swarm.id, agentId: targetId });
        setSession(
          result.session_resource_id,
          swarm.id,
          displayName,
          {
            acpStreamId: result.acp_stream_id,
            acpSessionId: result.acp_session_id,
          },
          agentRef,
        );
      } else {
        // Mail: try ACP-connect first (some backends auto-upgrade when the
        // target declares mail); on failure fall back to a bare mail
        // session resource id so useChatChannel picks mail mode.
        try {
          const result = await connectAcp.mutateAsync({ swarmId: swarm.id, agentId: targetId });
          setSession(
            result.session_resource_id,
            swarm.id,
            displayName,
            {
              acpStreamId: result.acp_stream_id,
              acpSessionId: result.acp_session_id,
            },
            agentRef,
          );
        } catch {
          setSession(
            `mail:${swarm.id}:${agent.id}`,
            swarm.id,
            displayName,
            undefined,
            agentRef,
          );
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }

    setConnecting(null);
  };

  const handleConnect = async (picked: PickerAgent) => {
    await connectToAgent(picked.swarm, picked.agent, picked.mode, rowKey(picked));
  };

  const handleSpawned = async (
    swarm: MapSwarm,
    spawned: { agent_id: string; peer_map_id: string; name?: string },
  ) => {
    // Synthesize a RegisteredAgent for the freshly spawned agent. We assume
    // ACP since spawn defaults to a coordinator with ACP capability; if
    // that's wrong the connect call falls back gracefully.
    const synthetic: RegisteredAgent = {
      id: spawned.agent_id,
      name: spawned.name,
      metadata: { peerMapId: spawned.peer_map_id },
      capabilities: { protocols: ['acp'] },
    };
    await connectToAgent(swarm, synthetic, 'acp', `spawn:${swarm.id}:${spawned.agent_id}`);
  };

  return (
    <div className="flex flex-col h-full">
      {error && (
        <div
          className="mx-3 mt-2 px-3 py-2 rounded text-xs"
          style={{ color: 'var(--color-text)', backgroundColor: 'rgba(239, 68, 68, 0.1)' }}
        >
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {groups.map(({ swarm, agents, spawnable }) => {
          const spawnLoadingPrefix = `spawn:${swarm.id}:`;
          const spawning = connecting?.startsWith(spawnLoadingPrefix);
          return (
            <div key={swarm.id} className="space-y-0.5">
              {/* Swarm header */}
              <div className="flex items-center gap-2 px-1 pt-1">
                <Zap className="h-3 w-3 text-honey-500/70 shrink-0" />
                <span
                  className="text-2xs font-medium uppercase tracking-wide truncate flex-1 min-w-0"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {swarm.name}
                </span>
                {spawnable && (
                  <button
                    type="button"
                    onClick={() => setSpawnFor(swarm)}
                    disabled={spawning}
                    className="p-0.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
                    style={{ color: 'var(--color-text-muted)' }}
                    title="Spawn agent on this swarm"
                  >
                    {spawning ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Plus className="h-3 w-3" />
                    )}
                  </button>
                )}
              </div>

              {/* Agent rows or empty hint */}
              {agents.length > 0 ? (
                agents.map((picked) => {
                  const key = rowKey(picked);
                  const { agent, mode } = picked;
                  const name = agent.name ?? agent.id;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => handleConnect(picked)}
                      disabled={connecting === key}
                      className={clsx(
                        'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left transition-colors',
                        'hover:bg-white/5 disabled:opacity-50',
                      )}
                      style={{ color: 'var(--color-text)' }}
                    >
                      {connecting === key ? (
                        <Loader2 className="h-4 w-4 animate-spin text-honey-500 shrink-0" />
                      ) : (
                        <AgentAvatar name={name} size={24} />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{name}</div>
                        <div
                          className="text-2xs truncate"
                          style={{ color: 'var(--color-text-muted)' }}
                        >
                          {agent.role ?? 'agent'}
                        </div>
                      </div>
                      <span
                        className="text-2xs shrink-0 px-1.5 py-0.5 rounded"
                        style={{ color: 'var(--color-text-muted)', backgroundColor: 'var(--color-surface)' }}
                      >
                        {mode}
                      </span>
                      <Radio className="h-3 w-3 text-emerald-400 shrink-0" />
                    </button>
                  );
                })
              ) : (
                <div
                  className="px-3 py-1.5 text-2xs italic"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {spawnable
                    ? 'No chat-capable agents — spawn one with +'
                    : 'No chat-capable agents'}
                </div>
              )}
            </div>
          );
        })}

        {onlineSwarms.length === 0 && (
          <NoSwarmsOnline />
        )}

        {/* Always show spawn swarm action */}
        <div className="space-y-1.5 pt-1">
          <button
            type="button"
            onClick={() => setShowSpawnSwarm(true)}
            className={clsx(
              'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors',
              'hover:bg-white/5 border border-dashed',
            )}
            style={{
              color: 'var(--color-text)',
              borderColor: 'var(--color-border-subtle)',
            }}
          >
            <Server className="h-4 w-4 text-honey-500/70 shrink-0" />
            <span className="flex-1 text-left">Spawn a new swarm</span>
            <Plus className="h-3 w-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
          </button>
        </div>
      </div>

      {spawnFor && (
        <SpawnAgentDialog
          swarmId={spawnFor.id}
          defaultCwd={getSwarmDefaultCwd(spawnFor)}
          onClose={() => setSpawnFor(null)}
          onSpawned={(result) => {
            const swarm = spawnFor;
            setSpawnFor(null);
            void handleSpawned(swarm, result);
          }}
        />
      )}

      {showSpawnSwarm && (
        <SpawnFormDialog onClose={() => setShowSpawnSwarm(false)} />
      )}
    </div>
  );
}

// ── Empty-state component when no swarms are online ──

function NoSwarmsOnline() {
  const { data: hostedSwarms = [] } = useHostedSwarms();
  const restartMutation = useRestartSwarm();

  const stoppedSwarms = hostedSwarms.filter(
    (s: HostedSwarm) => s.state === 'stopped' || s.state === 'failed',
  );

  const [restartingId, setRestartingId] = useState<string | null>(null);

  const handleRestart = async (swarm: HostedSwarm) => {
    setRestartingId(swarm.id);
    try {
      await restartMutation.mutateAsync(swarm.id);
    } catch {
      // toast or inline error could go here; for now the mutation's own
      // error state is enough and the picker auto-refreshes on lifecycle events
    }
    setRestartingId(null);
  };

  return (
    <div className="py-2 space-y-3">
      <p className="text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
        No swarms online.
      </p>

      {/* Stopped / failed hosted swarms that can be restarted */}
      {stoppedSwarms.length > 0 && (
        <div className="space-y-1">
          <p
            className="text-2xs font-medium uppercase tracking-wide px-1"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Restart a swarm
          </p>
          {stoppedSwarms.map((swarm: HostedSwarm) => (
            <button
              key={swarm.id}
              type="button"
              onClick={() => handleRestart(swarm)}
              disabled={restartingId === swarm.id}
              className={clsx(
                'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left transition-colors',
                'hover:bg-white/5 disabled:opacity-50',
              )}
              style={{ color: 'var(--color-text)' }}
            >
              {restartingId === swarm.id ? (
                <Loader2 className="h-4 w-4 animate-spin text-honey-500 shrink-0" />
              ) : (
                <RotateCw className="h-4 w-4 text-honey-500/70 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="truncate">{swarm.name}</div>
                <div
                  className="text-2xs truncate"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  {swarm.state === 'failed' ? 'Failed' : 'Stopped'}
                  {swarm.bootstrap?.cwd ? ` · ${swarm.bootstrap.cwd.split('/').pop()}` : ''}
                </div>
              </div>
              <Play className="h-3 w-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
