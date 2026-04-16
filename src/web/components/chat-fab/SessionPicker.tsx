/**
 * SessionPicker — agent/session picker for the ChatFab
 *
 * Shows connected swarms (online, deduped), recent sessions, and a "Spawn new" action.
 * When the user picks a swarm + agent, creates an ACP session and activates the chat.
 */

import { useState } from 'react';
import { Zap, Plus, MessageSquare, Loader2, Radio } from 'lucide-react';
import clsx from 'clsx';
import { useMapSwarmsForPicker, useConnectAcp } from '../../hooks/useApi';
import { useChatFabStore } from './ChatFabStore';
import { TimeAgo } from '../common/TimeAgo';
import type { MapSwarm } from '../../lib/api';

function isOnline(s: MapSwarm): boolean {
  return s.status === 'online';
}

function hasChatCapability(s: MapSwarm): boolean {
  const caps = (s.capabilities ?? {}) as Record<string, unknown>;
  const protocols = Array.isArray(caps.protocols) ? (caps.protocols as string[]) : [];
  const hasAcp = protocols.includes('acp');
  const mail = caps.mail as Record<string, unknown> | undefined;
  const hasMail = !!mail && (mail.canCreate === true || mail.canJoin === true);
  return hasAcp || hasMail;
}

function getChatMode(s: MapSwarm): 'acp' | 'mail' {
  const caps = (s.capabilities ?? {}) as Record<string, unknown>;
  const protocols = Array.isArray(caps.protocols) ? (caps.protocols as string[]) : [];
  return protocols.includes('acp') ? 'acp' : 'mail';
}

export function SessionPicker() {
  const { data: swarms = [] } = useMapSwarmsForPicker({ status: 'online' });
  const connectAcp = useConnectAcp();
  const setSession = useChatFabStore((s) => s.setSession);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onlineSwarms = swarms.filter(isOnline);
  const chatSwarms = onlineSwarms.filter(hasChatCapability);
  const otherSwarms = onlineSwarms.filter((s) => !hasChatCapability(s));

  const handleConnect = async (swarm: MapSwarm) => {
    setConnecting(swarm.id);
    setError(null);

    const mode = getChatMode(swarm);
    const registeredAgents = (swarm as unknown as { registered_agents?: Array<{
      id: string; name?: string; capabilities?: Record<string, unknown>; metadata?: Record<string, unknown>;
    }> }).registered_agents ?? [];

    if (mode === 'acp') {
      // ACP: find the ACP-capable agent and create a stream
      const acpAgent = registeredAgents.find((a) => {
        const protos = Array.isArray(a.capabilities?.protocols) ? a.capabilities!.protocols as string[] : [];
        return protos.includes('acp');
      });

      if (!acpAgent) {
        setError(`No ACP-capable agent on ${swarm.name}`);
        setConnecting(null);
        return;
      }

      // Peer-side map id may be `peerMapId` (cc-swarm) or `localAgentId`
      // (macro-agent). Either is the swarm-local ULID we need to target.
      const peerMapId = (typeof acpAgent.metadata?.peerMapId === 'string' && acpAgent.metadata.peerMapId)
        ? acpAgent.metadata.peerMapId
        : (typeof acpAgent.metadata?.localAgentId === 'string' && acpAgent.metadata.localAgentId)
          ? acpAgent.metadata.localAgentId
          : undefined;
      const targetId = peerMapId ?? acpAgent.id;

      try {
        const result = await connectAcp.mutateAsync({ swarmId: swarm.id, agentId: targetId });
        setSession(result.session_resource_id, swarm.id, swarm.name);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } else {
      // Mail: use the first registered agent (or the swarm itself) as session target.
      // The chat channel will detect mail capability and use mail mode.
      const agent = registeredAgents[0];
      const agentId = agent?.id ?? swarm.id;

      try {
        const result = await connectAcp.mutateAsync({ swarmId: swarm.id, agentId });
        setSession(result.session_resource_id, swarm.id, swarm.name);
      } catch {
        // ACP connect failed (expected for mail-only) — create a session resource
        // directly and let useChatChannel fall back to mail mode.
        setSession(`mail:${swarm.id}`, swarm.id, swarm.name);
      }
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
          Pick a swarm to chat with, or resume a session.
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
        {/* Chat-capable swarms (ACP or mail) */}
        {chatSwarms.length > 0 && (
          <>
            <div className="text-2xs px-1 pt-2 pb-1" style={{ color: 'var(--color-text-muted)' }}>
              Online swarms
            </div>
            {chatSwarms.map((s) => {
              const mode = getChatMode(s);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handleConnect(s)}
                  disabled={connecting === s.id}
                  className={clsx(
                    'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left transition-colors',
                    'hover:bg-white/5 disabled:opacity-50',
                  )}
                  style={{ color: 'var(--color-text)' }}
                >
                  {connecting === s.id ? (
                    <Loader2 className="h-4 w-4 animate-spin text-honey-500 shrink-0" />
                  ) : (
                    <Zap className="h-4 w-4 text-honey-500 shrink-0" />
                  )}
                  <span className="flex-1 truncate">{s.name}</span>
                  <span className="text-2xs shrink-0 px-1.5 py-0.5 rounded" style={{ color: 'var(--color-text-muted)', backgroundColor: 'var(--color-surface)' }}>
                    {mode}
                  </span>
                  <Radio className="h-3 w-3 text-emerald-400 shrink-0" />
                </button>
              );
            })}
          </>
        )}

        {/* Other online swarms (no chat capability) */}
        {otherSwarms.length > 0 && (
          <>
            <div className="text-2xs px-1 pt-2 pb-1" style={{ color: 'var(--color-text-muted)' }}>
              Online (no chat)
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
