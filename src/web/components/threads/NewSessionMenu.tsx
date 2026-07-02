/**
 * NewSessionMenu — "New session" entry point on the Threads page
 * (north-star P1.1).
 *
 * Threads used to be consume-only: starting a conversation meant a detour
 * through Swarms or the Dashboard ChatFab. This dialog offers the two
 * paths inline:
 *
 * - **Connect** — online ACP agents (grouping/filtering shared with the
 *   ChatFab's SessionPicker via `buildSwarmGroups`), plus a spawn-agent
 *   row for lifecycle-capable swarms. Connecting POSTs
 *   `/sessions/acp-connect` and navigates straight to
 *   `/threads/:sessionResourceId?streamId=…&sessionId=…` (SessionDetail
 *   reads the resume params).
 * - **Spawn** — a compact hosted-spawn form (not the full SpawnFormDialog):
 *   kind selector defaulting to codex/rpc, cwd combobox, optional first
 *   prompt, with P2.1 preflight inline. On success navigates to
 *   `/threads/hosted-chat/:id` (rpc) or `/threads/hosted-tui/:id` (tui).
 *
 * Exported `NewSessionButton` renders the trigger + dialog; `variant`
 * picks the compact header icon-button or the block button used in the
 * empty sidebar.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, MessageSquarePlus, Plus, Radio, Zap } from 'lucide-react';
import clsx from 'clsx';
import {
  uniqueNamesGenerator,
  adjectives,
  colors,
  animals,
} from 'unique-names-generator';
import { Dialog } from '../common/Dialog';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { AgentAvatar } from '../common/AgentAvatar';
import { WorkingDirectoryCombobox } from '../swarm/WorkingDirectoryCombobox';
import { SpawnPreflightCallout } from '../swarm/SpawnPreflightCallout';
import { SpawnAgentDialog } from '../swarm/SpawnAgentDialog';
import { buildSwarmGroups } from '../chat-fab/SessionPicker';
import {
  useMapSwarmsForPicker,
  useSpawnSwarm,
  useSpawnPreflight,
} from '../../hooks/useApi';
import { useSwarmRealtime } from '../../hooks/useRealtimeInvalidation';
import { api } from '../../lib/api';
import type { MapSwarm } from '../../lib/api';
import { getPeerMapId } from '../../lib/map';
import { toast } from '../../stores/toast';

// ── Connect path ────────────────────────────────────────────────────────

interface AcpConnectResult {
  session_resource_id: string;
  acp_session_id: string;
  acp_stream_id: string;
  created: boolean;
}

/**
 * Create (or reuse) an ACP session and return the Threads deep link.
 * Mirrors ChatFabStore.connectAndOpen's request shape, but lands on the
 * Threads detail route instead of opening the floating panel.
 */
async function acpConnectPath(
  swarmId: string,
  agentId: string,
  peerMapId?: string,
): Promise<string> {
  const result = await api.post<AcpConnectResult>('/sessions/acp-connect', {
    swarm_id: swarmId,
    agent_id: agentId,
    ...(peerMapId ? { peer_map_id: peerMapId } : {}),
  });
  const params = new URLSearchParams({
    streamId: result.acp_stream_id,
    sessionId: result.acp_session_id,
  });
  return `/threads/${result.session_resource_id}?${params}`;
}

function ConnectTab({ onDone }: { onDone: () => void }) {
  useSwarmRealtime();
  const navigate = useNavigate();
  const { data: swarms = [] } = useMapSwarmsForPicker({ status: 'online' });
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spawnFor, setSpawnFor] = useState<MapSwarm | null>(null);

  // ACP only — mail threads need a conversation to exist first, and the
  // Threads list already surfaces those. Keep spawnable empty groups so
  // "swarm online but no coordinator yet" has a path.
  const groups = buildSwarmGroups(swarms.filter((s) => s.status === 'online'))
    .map((g) => ({ ...g, agents: g.agents.filter((a) => a.mode === 'acp') }))
    .filter((g) => g.agents.length > 0 || g.spawnable);

  const connect = async (
    swarmId: string,
    agentId: string,
    peerMapId: string | undefined,
    loadingKey: string,
  ) => {
    setConnecting(loadingKey);
    setError(null);
    try {
      const path = await acpConnectPath(swarmId, agentId, peerMapId);
      onDone();
      navigate(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(null);
    }
  };

  return (
    <div className="space-y-2">
      {error && (
        <p className="text-2xs text-red-400 px-1" role="alert">
          {error}
        </p>
      )}

      {groups.length === 0 && (
        <p className="text-xs px-1 py-3 text-center" style={{ color: 'var(--color-text-muted)' }}>
          No online ACP agents. Spawn a hosted agent from the Spawn tab, or
          connect an external one from Swarms.
        </p>
      )}

      {groups.map(({ swarm, agents, spawnable }) => (
        <div key={swarm.id} className="space-y-0.5">
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
                className="p-0.5 rounded hover:bg-white/10 transition-colors"
                style={{ color: 'var(--color-text-muted)' }}
                title="Spawn agent on this swarm"
              >
                <Plus className="h-3 w-3" />
              </button>
            )}
          </div>

          {agents.length > 0 ? (
            agents.map(({ agent }) => {
              const key = `${swarm.id}:${agent.id}`;
              const name = agent.name ?? agent.id;
              const peerMapId = getPeerMapId(agent.metadata);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() =>
                    void connect(
                      swarm.id,
                      agent.id,
                      peerMapId && peerMapId !== agent.id ? peerMapId : undefined,
                      key,
                    )
                  }
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
                    <div className="text-2xs truncate" style={{ color: 'var(--color-text-muted)' }}>
                      {agent.role ?? 'agent'}
                    </div>
                  </div>
                  <Radio className="h-3 w-3 text-emerald-400 shrink-0" />
                </button>
              );
            })
          ) : (
            <div className="px-3 py-1.5 text-2xs italic" style={{ color: 'var(--color-text-muted)' }}>
              No chat-capable agents — spawn one with +
            </div>
          )}
        </div>
      ))}

      {spawnFor && (
        <SpawnAgentDialog
          swarmId={spawnFor.id}
          onClose={() => setSpawnFor(null)}
          onSpawned={(result) => {
            const swarm = spawnFor;
            setSpawnFor(null);
            void connect(
              swarm.id,
              result.agent_id,
              result.peer_map_id !== result.agent_id ? result.peer_map_id : undefined,
              `spawn:${swarm.id}`,
            );
          }}
        />
      )}
    </div>
  );
}

// ── Spawn path (compact) ────────────────────────────────────────────────

type SpawnChoice = 'codex-rpc' | 'codex-tui' | 'claude-code';

const SPAWN_CHOICES: Array<{ id: SpawnChoice; label: string; hint: string }> = [
  { id: 'codex-rpc', label: 'Codex chat', hint: 'chat-driven, streams here' },
  { id: 'codex-tui', label: 'Codex terminal', hint: 'embedded TUI' },
  { id: 'claude-code', label: 'Claude Code', hint: 'embedded TUI' },
];

function choiceKindMode(choice: SpawnChoice): {
  kind: 'codex' | 'claude-code';
  mode: 'rpc' | 'tui';
} {
  if (choice === 'claude-code') return { kind: 'claude-code', mode: 'tui' };
  return { kind: 'codex', mode: choice === 'codex-rpc' ? 'rpc' : 'tui' };
}

function SpawnTab({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const spawnMutation = useSpawnSwarm();
  const [choice, setChoice] = useState<SpawnChoice>('codex-rpc');
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const [attemptAnyway, setAttemptAnyway] = useState(false);

  const { kind, mode } = choiceKindMode(choice);
  const { data: preflight } = useSpawnPreflight(kind, kind === 'codex' ? mode : undefined);
  const preflightBlocked = preflight?.ready === false && !attemptAnyway;

  const handleSpawn = async () => {
    const name = uniqueNamesGenerator({
      dictionaries: [adjectives, colors, animals],
      separator: '-',
      length: 3,
    });
    try {
      const hosted = await spawnMutation.mutateAsync({
        kind,
        ...(kind === 'codex' && mode === 'tui' ? { mode: 'tui' as const } : {}),
        name,
        cwd: cwd.trim() || undefined,
        initial_prompt: prompt.trim() || undefined,
      });
      onDone();
      navigate(
        kind === 'codex' && mode === 'rpc'
          ? `/threads/hosted-chat/${hosted.id}`
          : `/threads/hosted-tui/${hosted.id}`,
      );
    } catch (err) {
      toast.error('Spawn failed', (err as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      <div
        className="inline-flex p-0.5 rounded-md"
        style={{ backgroundColor: 'var(--color-elevated)' }}
        role="radiogroup"
        aria-label="Agent kind"
      >
        {SPAWN_CHOICES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={choice === c.id}
            onClick={() => {
              setChoice(c.id);
              setAttemptAnyway(false);
            }}
            className="px-2.5 py-1 rounded text-2xs font-medium transition-colors"
            style={{
              backgroundColor: choice === c.id ? 'var(--color-bg)' : 'transparent',
              color: choice === c.id ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="text-2xs -mt-2" style={{ color: 'var(--color-text-muted)' }}>
        {SPAWN_CHOICES.find((c) => c.id === choice)?.hint}
      </p>

      <SpawnPreflightCallout
        preflight={preflight}
        attemptAnyway={attemptAnyway}
        onAttemptAnywayChange={setAttemptAnyway}
      />

      <div>
        <label
          className="block text-2xs font-medium mb-1"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          Working directory
        </label>
        <WorkingDirectoryCombobox value={cwd} onChange={setCwd} />
      </div>

      <div>
        <label
          className="block text-2xs font-medium mb-1"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          First prompt (optional)
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          className="input w-full resize-y text-xs"
          placeholder="What should the agent start on?"
        />
      </div>

      <button
        type="button"
        onClick={() => void handleSpawn()}
        disabled={spawnMutation.isPending || preflightBlocked}
        title={
          preflightBlocked
            ? 'Preflight checks failed — see the callout above (or tick "attempt anyway")'
            : undefined
        }
        className="btn btn-primary flex items-center gap-1.5 text-xs"
      >
        {spawnMutation.isPending ? <LoadingSpinner size="sm" /> : <Zap className="w-3 h-3" />}
        Spawn &amp; open
      </button>
      <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
        Need repos, hives, or credentials? Use the full spawn form on the Swarms page.
      </p>
    </div>
  );
}

// ── Dialog + trigger ────────────────────────────────────────────────────

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'connect' | 'spawn'>('connect');

  return (
    <Dialog open onClose={onClose} maxWidth="max-w-md">
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <MessageSquarePlus className="w-3.5 h-3.5 text-honey-500" />
            New session
          </h2>
        </div>

        <div
          className="inline-flex p-0.5 rounded-md mb-3"
          style={{ backgroundColor: 'var(--color-elevated)' }}
          role="tablist"
        >
          {(
            [
              { id: 'connect', label: 'Connect to an agent' },
              { id: 'spawn', label: 'Spawn a new agent' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className="px-3 py-1 rounded text-2xs font-medium transition-colors"
              style={{
                backgroundColor: tab === t.id ? 'var(--color-bg)' : 'transparent',
                color: tab === t.id ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {tab === 'connect' ? <ConnectTab onDone={onClose} /> : <SpawnTab onDone={onClose} />}
        </div>
      </div>
    </Dialog>
  );
}

export function NewSessionButton({ variant = 'icon' }: { variant?: 'icon' | 'block' }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {variant === 'icon' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="p-1 rounded-md transition-colors hover:bg-hover"
          style={{ color: 'var(--color-text-secondary)' }}
          title="New session"
          aria-label="New session"
        >
          <MessageSquarePlus className="w-4 h-4" />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn btn-primary inline-flex items-center gap-1.5 text-xs"
        >
          <MessageSquarePlus className="w-3 h-3" />
          New session
        </button>
      )}
      {open && <NewSessionDialog onClose={() => setOpen(false)} />}
    </>
  );
}
