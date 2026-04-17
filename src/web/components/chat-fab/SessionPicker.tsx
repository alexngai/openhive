/**
 * SessionPicker — agent picker for the ChatFab
 *
 * Shows one row per chat-capable agent across all online swarms, grouped by
 * parent swarm. Each swarm may expose multiple coordinators, so listing at
 * the agent level lets the user pick a specific one instead of always
 * landing on "whichever ACP agent the hub found first." Sidecars are
 * filtered out (they're the connection itself, not a participant).
 *
 * Swarms that carry no chat-capable agents (sidecar-only, or purely
 * observational) fall into the "Online (no chat)" section so they're still
 * visible but unclickable.
 */

import { useState } from 'react';
import { Zap, Plus, MessageSquare, Loader2, Radio } from 'lucide-react';
import clsx from 'clsx';
import { useMapSwarmsForPicker, useConnectAcp } from '../../hooks/useApi';
import { useChatFabStore } from './ChatFabStore';
import type { MapSwarm } from '../../lib/api';
import { getPeerMapId } from '../../lib/map';

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

function isOnline(s: MapSwarm): boolean {
  return s.status === 'online';
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
 * Flatten online swarms into per-agent picker rows. Sidecars and agents
 * without chat capability are dropped. Ordering: stable by swarm order,
 * then by agent order inside each swarm (so the UI doesn't reshuffle on
 * every refetch).
 *
 * Exported for unit testing only.
 */
export function buildPickerAgents(swarms: MapSwarm[]): PickerAgent[] {
  const out: PickerAgent[] = [];
  for (const swarm of swarms) {
    for (const agent of getRegisteredAgents(swarm)) {
      if (agent.role === 'sidecar') continue;
      const mode = getAgentChatMode(agent, swarm);
      if (!mode) continue;
      out.push({ agent, swarm, mode });
    }
  }
  return out;
}

export function SessionPicker() {
  const { data: swarms = [] } = useMapSwarmsForPicker({ status: 'online' });
  const connectAcp = useConnectAcp();
  const setSession = useChatFabStore((s) => s.setSession);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onlineSwarms = swarms.filter(isOnline);
  const pickerAgents = buildPickerAgents(onlineSwarms);

  // Swarms that surfaced zero chat-capable agents go into the "no chat"
  // bucket so they're still visible but greyed out.
  const swarmsWithAgents = new Set(pickerAgents.map((p) => p.swarm.id));
  const otherSwarms = onlineSwarms.filter((s) => !swarmsWithAgents.has(s.id));

  // Row key must be unique per agent, not per swarm, because a swarm may
  // surface multiple ACP coordinators.
  const rowKey = (p: PickerAgent) => `${p.swarm.id}:${p.agent.id}`;

  const handleConnect = async (picked: PickerAgent) => {
    const key = rowKey(picked);
    setConnecting(key);
    setError(null);

    const { agent, swarm, mode } = picked;
    // Prefer the peer-side MAP id (the swarm-local ULID) so ACP streams
    // route correctly through the peer's MAP server. Falls back to the
    // hub-assigned id for flows that don't use a peer MAP server.
    const targetId = getPeerMapId(agent.metadata) ?? agent.id;
    const displayName = agent.name ?? agent.id;

    try {
      if (mode === 'acp') {
        const result = await connectAcp.mutateAsync({ swarmId: swarm.id, agentId: targetId });
        // Persist the ACP stream/session ids so ChatPanel can `loadSession`
        // instead of `createStream` on subsequent remounts (e.g. when the
        // user toggles the FAB between floating and docked). Without this
        // each remount tears down the server-side stream.
        setSession(result.session_resource_id, swarm.id, displayName, {
          acpStreamId: result.acp_stream_id,
          acpSessionId: result.acp_session_id,
        });
      } else {
        // Mail: try ACP-connect first (some backends auto-upgrade when the
        // target declares mail); on failure fall back to a bare mail
        // session resource id so useChatChannel picks mail mode.
        try {
          const result = await connectAcp.mutateAsync({ swarmId: swarm.id, agentId: targetId });
          setSession(result.session_resource_id, swarm.id, displayName, {
            acpStreamId: result.acp_stream_id,
            acpSessionId: result.acp_session_id,
          });
        } catch {
          setSession(`mail:${swarm.id}:${agent.id}`, swarm.id, displayName);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }

    setConnecting(null);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          Start a conversation
        </h3>
        <p className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
          Pick an agent to chat with, or resume a session.
        </p>
      </div>

      {error && (
        <div
          className="mx-3 mt-2 px-3 py-2 rounded text-xs"
          style={{ color: 'var(--color-text)', backgroundColor: 'rgba(239, 68, 68, 0.1)' }}
        >
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {/* Chat-capable agents */}
        {pickerAgents.length > 0 && (
          <>
            <div className="text-2xs px-1 pt-2 pb-1" style={{ color: 'var(--color-text-muted)' }}>
              Online agents
            </div>
            {pickerAgents.map((picked) => {
              const key = rowKey(picked);
              const { agent, swarm, mode } = picked;
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
                    <Zap className="h-4 w-4 text-honey-500 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="truncate">{name}</div>
                    <div
                      className="text-2xs truncate"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {agent.role ?? 'agent'} · {swarm.name}
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
            })}
          </>
        )}

        {/* Online swarms with no chat-capable agents yet */}
        {otherSwarms.length > 0 && (
          <>
            <div className="text-2xs px-1 pt-2 pb-1" style={{ color: 'var(--color-text-muted)' }}>
              Online (no chat agents)
            </div>
            {otherSwarms.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-sm opacity-40"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <Zap className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{s.name}</span>
              </div>
            ))}
          </>
        )}

        {onlineSwarms.length === 0 && (
          <div
            className="px-3 py-6 text-center text-xs"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p>No swarms online.</p>
            <p className="mt-1">Connect a swarm to start chatting.</p>
          </div>
        )}
      </div>
    </div>
  );
}
