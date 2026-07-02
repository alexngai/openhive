import { useState, useRef, useEffect } from 'react';
import { UserPlus, Loader2, Zap, Radio } from 'lucide-react';
import clsx from 'clsx';
import { useMapSwarmsForPicker, useInviteMailParticipant } from '../../hooks/useApi';
import { useSwarmRealtime } from '../../hooks/useRealtimeInvalidation';
import { AgentAvatar } from '../common/AgentAvatar';
import type { MapSwarm } from '../../lib/api';

interface RegisteredAgent {
  id: string;
  name?: string;
  role?: string;
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface InviteGroup {
  swarm: MapSwarm;
  agents: RegisteredAgent[];
}

function hasSwarmMail(s: MapSwarm): boolean {
  const mail = (s.capabilities as Record<string, unknown> | null | undefined)?.mail as
    | Record<string, unknown>
    | undefined;
  return !!mail && (mail.canCreate === true || mail.canJoin === true);
}

function getRegisteredAgents(s: MapSwarm): RegisteredAgent[] {
  return (s as unknown as { registered_agents?: RegisteredAgent[] }).registered_agents ?? [];
}

/**
 * Build invite candidates: agents on mail-capable swarms (the relevant
 * capability for a discussion thread — any agent on a `mail.canJoin` swarm is
 * addressable). Sidecars and already-present participants are filtered out.
 */
function buildInviteGroups(swarms: MapSwarm[], existing: Set<string>): InviteGroup[] {
  return swarms
    .filter((s) => s.status === 'online' && hasSwarmMail(s))
    .map((swarm) => ({
      swarm,
      agents: getRegisteredAgents(swarm).filter(
        (a) => a.role !== 'sidecar' && !existing.has(a.id),
      ),
    }))
    .filter((g) => g.agents.length > 0);
}

/**
 * "Invite agent" control for a mail conversation (P3.4). Lists online,
 * mail-capable agents grouped by swarm; selecting one POSTs to the generic
 * participants route. Roster refresh comes from the conversation query
 * invalidation + the live `mail.participant.joined` event.
 *
 * Note on delivery: mail is store-and-pull with best-effort push, so an
 * invited agent may not reply until it is next active/dispatched — the
 * popover states this so the async semantics aren't surprising.
 */
export function InviteAgentButton({
  conversationId,
  existingParticipantIds = [],
}: {
  conversationId: string;
  existingParticipantIds?: string[];
}) {
  useSwarmRealtime();
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: swarms = [] } = useMapSwarmsForPicker({ status: 'online' });
  const invite = useInviteMailParticipant();

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const groups = buildInviteGroups(swarms, new Set(existingParticipantIds));

  const handleInvite = async (agent: RegisteredAgent) => {
    setPendingId(agent.id);
    try {
      await invite.mutateAsync({ conversationId, agentId: agent.id });
      setOpen(false);
    } catch {
      // mutation error state surfaces below
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-2xs font-medium transition-colors hover:bg-white/5"
        style={{ color: 'var(--color-text-muted)', border: '1px solid var(--color-border-subtle)' }}
        title="Invite an agent into this discussion"
        aria-label="Invite agent"
      >
        <UserPlus className="h-3.5 w-3.5" />
        Invite
      </button>

      {open && (
        <div
          className="absolute right-0 z-20 mt-1 w-64 rounded-md border shadow-lg"
          style={{
            backgroundColor: 'var(--color-surface)',
            borderColor: 'var(--color-border-subtle)',
          }}
          role="dialog"
          aria-label="Invite agent picker"
        >
          <div
            className="border-b px-3 py-2 text-2xs"
            style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-muted)' }}
          >
            Invited agents see this on next activation or dispatch.
          </div>
          <div className="max-h-64 overflow-y-auto p-1.5">
            {groups.length === 0 ? (
              <p
                className="px-2 py-3 text-center text-2xs italic"
                style={{ color: 'var(--color-text-muted)' }}
              >
                No mail-capable agents online.
              </p>
            ) : (
              groups.map(({ swarm, agents }) => (
                <div key={swarm.id} className="space-y-0.5">
                  <div className="flex items-center gap-1.5 px-1 pt-1">
                    <Zap className="h-3 w-3 text-honey-500/70 shrink-0" />
                    <span
                      className="truncate text-2xs font-medium uppercase tracking-wide"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      {swarm.name}
                    </span>
                  </div>
                  {agents.map((agent) => {
                    const name = agent.name ?? agent.id;
                    const busy = pendingId === agent.id;
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => handleInvite(agent)}
                        disabled={busy}
                        className={clsx(
                          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                          'hover:bg-white/5 disabled:opacity-50',
                        )}
                        style={{ color: 'var(--color-text)' }}
                      >
                        {busy ? (
                          <Loader2 className="h-4 w-4 animate-spin text-honey-500 shrink-0" />
                        ) : (
                          <AgentAvatar name={name} size={20} />
                        )}
                        <span className="flex-1 min-w-0 truncate">{name}</span>
                        <Radio className="h-3 w-3 shrink-0 text-emerald-400" />
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
          {invite.isError && (
            <div
              className="border-t px-3 py-2 text-2xs"
              style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-danger)' }}
            >
              {invite.error instanceof Error ? invite.error.message : 'Invite failed'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
