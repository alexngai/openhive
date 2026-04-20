import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Activity, AlertTriangle, Bell, ChevronRight, ChevronDown, ChevronUp, Clock, Cpu, FileText, Globe,
  GitBranch, Link2, Loader2, Megaphone, MessageSquare, Monitor, Network, Play, Plus, Send, Settings2, Share2,
  Square, RotateCw, Terminal, Trash2, User, Wifi, WifiOff,
  CheckCircle2, Zap,
} from 'lucide-react';
import {
  useMapSwarm, useMapNodes, useHostedSwarms, useSessionsList, useSwarmLogs,
  useStopSwarm, useRestartSwarm, useRemoveSwarm,
  useSwarmMessages, useSwarmPeers,
  useEventSubscriptions, useDeliveryLog,
  useConnectionHealth,
  useSpawnAgent,
  useConnectAcp,
  useStopAgent,
  useResumableSessions,
  useResumeAllSessions,
  useResumeSession,
  useCascadeDAG,
  type ResumableSession,
  type StreamDAGNode,
} from '../hooks/useApi';
import { useDispatchList } from '../hooks/useDispatch';
import { DispatchStatusChip } from '../components/dispatch/DispatchStatusChip';
import { StreamStatusDot } from '../components/streams/shared';
import { useSwarmRealtime, useSessionsRealtime } from '../hooks/useRealtimeInvalidation';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader, LoadingSpinner } from '../components/common/LoadingSpinner';
import { HostedStateBadge, MapStatusBadge, SandboxBadge } from '../components/swarm/StatusBadges';
import { toast } from '../stores/toast';
import type {
  MapSwarm, MapNode, HostedSwarm, SessionListItem,
  SwarmMessage, SwarmPeer, EventSubscription, DeliveryLogEntry,
} from '../lib/api';
import { useCallback, useRef, useState, useMemo } from 'react';
import {
  ChatMessageList,
  ChatInput,
  useChatChannel,
  type CapabilityResolver,
  type ChatAdapter,
  type ChatTarget,
} from 'swarmcraft/ui/embed';
import { createCoordinationChatAdapter } from '../adapters/coordination-chat-adapter';
import { SpawnAgentDialog } from '../components/swarm/SpawnAgentDialog';
import { getPeerMapId } from '../lib/map';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function SectionHeading({ icon: Icon, label, count }: {
  icon: React.ElementType;
  label: string;
  count?: number;
}) {
  return (
    <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
      <Icon className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
      {label}
      {count != null && count > 0 && (
        <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>{count}</span>
      )}
    </h3>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="card px-4 py-6 text-center" style={{ color: 'var(--color-text-muted)' }}>
      <p className="text-xs">{message}</p>
    </div>
  );
}

// ─── Swarm Info ──────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Compact unified header for the swarm detail page. Merges what used to be
 * three separate cards (identity + connection health + hosted instance) into
 * one dense strip: identifiers above, health/hosted stats below, lifecycle
 * actions inline with the title.
 */
function SwarmHeader({
  swarm,
  swarmId,
  hosted,
}: {
  swarm: MapSwarm;
  swarmId: string;
  hosted?: HostedSwarm;
}) {
  const navigate = useNavigate();
  const { data: health } = useConnectionHealth(swarmId);
  const stopMutation = useStopSwarm();
  const restartMutation = useRestartSwarm();
  const removeMutation = useRemoveSwarm();

  const canStop = hosted && (hosted.state === 'running' || hosted.state === 'unhealthy' || hosted.state === 'starting');
  const canRestart = hosted && (hosted.state === 'stopped' || hosted.state === 'failed');
  const canRemove = hosted && (hosted.state === 'stopped' || hosted.state === 'failed');
  const isTransitioning = stopMutation.isPending || restartMutation.isPending || removeMutation.isPending;

  const handleStop = async () => {
    if (!hosted) return;
    try {
      await stopMutation.mutateAsync(hosted.id);
      toast.success('Swarm stopped', `"${hosted.name}" has been stopped.`);
    } catch (err) {
      toast.error('Stop failed', (err as Error).message);
    }
  };
  const handleRestart = async () => {
    if (!hosted) return;
    try {
      await restartMutation.mutateAsync(hosted.id);
      toast.success('Swarm restarted', `"${hosted.name}" is restarting.`);
    } catch (err) {
      toast.error('Restart failed', (err as Error).message);
    }
  };
  const handleRemove = async () => {
    if (!hosted) return;
    try {
      await removeMutation.mutateAsync(hosted.id);
      toast.success('Swarm removed', `"${hosted.name}" has been removed.`);
      navigate('/swarms');
    } catch (err) {
      toast.error('Remove failed', (err as Error).message);
    }
  };

  const uptime = health?.connectedAt
    ? Math.floor((Date.now() - new Date(health.connectedAt).getTime()) / 1000)
    : 0;
  const isDegraded = (health?.missedPongs ?? 0) > 0;
  const healthPct = health
    ? Math.max(0, Math.round((1 - health.missedPongs / health.maxMissedPongs) * 100))
    : 100;

  return (
    <div className="card px-4 py-3">
      {/* Row 1: identity + badges + lifecycle actions */}
      <div className="flex items-start gap-3">
        <div
          className="w-10 h-10 rounded-md flex items-center justify-center shrink-0"
          style={{ backgroundColor: 'var(--color-accent-bg)' }}
        >
          <Globe className="w-5 h-5 text-honey-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-lg font-bold truncate">{swarm.name}</h2>
            <MapStatusBadge status={swarm.status} missedPongs={health?.missedPongs} />
            {hosted && <HostedStateBadge state={hosted.state} />}
            {swarm.map_endpoint === 'hub-inbound' && (
              <span className="text-2xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">inbound</span>
            )}
            {swarm.map_endpoint === 'local-hub' && (
              <span className="text-2xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">local</span>
            )}
            {hosted?.provider === 'local-sandboxed' && <SandboxBadge />}
          </div>
          {swarm.description && (
            <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
              {swarm.description}
            </p>
          )}
          {/* Row 2: identifiers, endpoint, hosted id, hives, last-seen */}
          <div className="flex items-center gap-3 mt-2 text-2xs flex-wrap" style={{ color: 'var(--color-text-muted)' }}>
            <span className="font-mono truncate max-w-[220px]">{swarm.id}</span>
            {swarm.map_endpoint !== 'hub-inbound' && swarm.map_endpoint !== 'local-hub' && (
              <span className="font-mono truncate max-w-[220px]">{swarm.map_endpoint}</span>
            )}
            {hosted && (
              <>
                <span className="opacity-30">·</span>
                <span className="font-mono truncate max-w-[180px]" title={`Hosted ${hosted.id}`}>{hosted.id}</span>
                <span>{hosted.provider === 'local-sandboxed' ? 'local' : hosted.provider}</span>
                {hosted.assigned_port && <span>:{hosted.assigned_port}</span>}
              </>
            )}
            {swarm.hives.length > 0 && <span>{swarm.hives.join(', ')}</span>}
            {swarm.last_seen_at && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                <TimeAgo date={swarm.last_seen_at} />
              </span>
            )}
          </div>
        </div>
        {/* Right rail: lifecycle action icons + connectivity indicator */}
        <div className="flex items-center gap-1 shrink-0">
          {canStop && (
            <button onClick={handleStop} disabled={isTransitioning} className="btn btn-ghost p-1.5 text-red-400 hover:bg-red-500/10" title="Stop hosted swarm">
              {stopMutation.isPending ? <LoadingSpinner size="sm" /> : <Square className="w-3.5 h-3.5" />}
            </button>
          )}
          {canRestart && (
            <button onClick={handleRestart} disabled={isTransitioning} className="btn btn-ghost p-1.5 hover:bg-emerald-500/10" style={{ color: 'var(--color-text-secondary)' }} title="Restart hosted swarm">
              {restartMutation.isPending ? <LoadingSpinner size="sm" /> : <RotateCw className="w-3.5 h-3.5" />}
            </button>
          )}
          {canRemove && (
            <button onClick={handleRemove} disabled={isTransitioning} className="btn btn-ghost p-1.5 text-red-400 hover:bg-red-500/10" title="Remove hosted swarm">
              {removeMutation.isPending ? <LoadingSpinner size="sm" /> : <Trash2 className="w-3.5 h-3.5" />}
            </button>
          )}
          {swarm.status === 'online' ? (
            <Wifi className="w-4 h-4 text-emerald-400 ml-1" />
          ) : swarm.status === 'unreachable' ? (
            <WifiOff className="w-4 h-4 text-red-400 ml-1" />
          ) : (
            <WifiOff className="w-4 h-4 ml-1" style={{ color: 'var(--color-text-muted)' }} />
          )}
        </div>
      </div>

      {/* Row 3: capabilities (compact pill strip) */}
      {swarm.capabilities && Object.keys(swarm.capabilities).length > 0 && (
        <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
          {Object.entries(swarm.capabilities)
            .filter(([, v]) => v && v !== false)
            .map(([key]) => {
              if (key === 'protocols') {
                const protos = swarm.capabilities![key] as string[];
                return protos.map((p) => (
                  <span key={p} className="text-2xs px-1.5 py-0.5 rounded font-medium" style={{ backgroundColor: 'var(--color-accent-bg)', color: 'var(--color-accent)' }}>
                    {p}
                  </span>
                ));
              }
              if (key === 'acp') return null; // shown via protocols badge
              return (
                <span
                  key={key}
                  className="text-2xs px-1.5 py-0.5 rounded capitalize"
                  style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
                >
                  {key}
                </span>
              );
            })}
        </div>
      )}

      {/* Row 4: inline health stats (uptime / last activity / agents / transport) */}
      {health && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--color-border)' }}>
          {/* Thin health bar — yellow when pongs missed, otherwise emerald */}
          <div className="w-full h-0.5 rounded-full mb-2" style={{ backgroundColor: 'var(--color-elevated)' }}>
            <div
              className={`h-full rounded-full transition-all duration-500 ${isDegraded ? 'bg-amber-400' : 'bg-emerald-400'}`}
              style={{ width: `${healthPct}%` }}
            />
          </div>
          <div className="flex items-center gap-4 text-2xs flex-wrap" style={{ color: 'var(--color-text-muted)' }}>
            <span>
              <span className="font-medium" style={{ color: 'var(--color-text-secondary)' }}>Uptime </span>
              {formatUptime(uptime)}
            </span>
            <span className="opacity-30">·</span>
            <span>
              <span className="font-medium" style={{ color: 'var(--color-text-secondary)' }}>Last </span>
              <TimeAgo date={health.lastMessageAt} />
            </span>
            <span className="opacity-30">·</span>
            <span>
              <span className="font-medium" style={{ color: 'var(--color-text-secondary)' }}>Agents </span>
              {health.registeredAgentCount}
            </span>
            <span className="opacity-30">·</span>
            <span>
              <span className="font-medium" style={{ color: 'var(--color-text-secondary)' }}>Transport </span>
              {health.transport}
              {health.tokenExpiresAt && (
                <span className="ml-1 text-amber-400" title={`Token expires: ${health.tokenExpiresAt}`}>(token)</span>
              )}
            </span>
            {isDegraded && (
              <>
                <span className="opacity-30">·</span>
                <span className="text-amber-400 font-medium">
                  {health.missedPongs}/{health.maxMissedPongs} pongs missed
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Error banner from hosted lifecycle */}
      {hosted?.error && (
        <div className="mt-2 px-2 py-1.5 bg-red-500/10 border border-red-500/20 rounded text-2xs text-red-400">
          {hosted.error}
        </div>
      )}
    </div>
  );
}

// ─── Capability-Gated Actions ───────────────────────────────────────────────

function useSwarmActions({
  swarm,
  swarmId,
  defaultCwd,
}: {
  swarm: MapSwarm;
  swarmId: string;
  /**
   * Effective swarm cwd. Computed by the caller using the full priority
   * chain (hosted bootstrap.cwd → swarm metadata.cwd → projectPath).
   * Used as the spawn cwd for the primary "Spawn Agent" button AND as the
   * placeholder/hint inside the advanced dialog.
   */
  defaultCwd?: string;
}) {
  const spawnAgent = useSpawnAgent();
  const isOnline = swarm.status === 'online' || swarm.status === 'unreachable';
  const projectPath = defaultCwd;

  // Synchronous click-guard. React Query's `isPending` flag flips after the
  // state commit, leaving a window where a fast double-click can fire two
  // handlers before the button's `disabled` attribute takes effect. The ref
  // is set in the same event tick as the click, so subsequent clicks bail
  // before any backend work starts.
  const inFlightRef = useRef(false);

  // Whether the advanced spawn dialog is open. Surfaced via the "⚙" icon
  // next to the primary Spawn Agent button.
  const [showAdvancedDialog, setShowAdvancedDialog] = useState(false);

  // Spawn a fresh coordinator. Stays on the swarm detail page; the new
  // coordinator card appears in the Registered Agents section, and the
  // user clicks Chat on it when they want to open a conversation. We
  // intentionally do NOT auto-open an ACP session here — that conflates
  // "spawn a worker" with "start chatting" and forces a navigation.
  const handleNewSession = async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const spawned = await spawnAgent.mutateAsync({
        swarmId,
        role: 'coordinator',
        cwd: projectPath,
        task: 'Head manager',
      });
      toast.success('Coordinator spawned', `${spawned.name ?? spawned.agent_id} is ready. Click Chat to start a conversation.`);
    } catch {
      // Error shown via mutation state (spawnAgent.error rendered below)
    } finally {
      inFlightRef.current = false;
    }
  };

  const isPending = spawnAgent.isPending;
  const isError = spawnAgent.isError;
  const errorMessage = (spawnAgent.error as Error | undefined)?.message;

  const button = isOnline ? (
    <div className="inline-flex items-center gap-1">
      <button
        onClick={handleNewSession}
        disabled={isPending}
        className="btn btn-primary inline-flex items-center gap-1.5 text-xs disabled:opacity-70 disabled:cursor-not-allowed disabled:hover:bg-honey-500"
      >
        {isPending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Zap className="w-3.5 h-3.5" />
        )}
        {isPending ? 'Spawning…' : 'Spawn Agent'}
      </button>
      <button
        type="button"
        onClick={() => setShowAdvancedDialog(true)}
        disabled={isPending}
        className="btn btn-ghost p-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
        title="Spawn with advanced config"
        aria-label="Spawn with advanced config"
      >
        <Settings2 className="w-3.5 h-3.5" />
      </button>
    </div>
  ) : null;

  const error = isOnline && isError && errorMessage ? (
    <div
      className="mb-2 rounded-md border px-3 py-2 text-xs"
      style={{
        borderColor: 'var(--color-border-subtle)',
        backgroundColor: 'rgba(239, 68, 68, 0.08)',
        color: '#fca5a5',
      }}
    >
      {errorMessage || 'Failed to create session'}
    </div>
  ) : null;

  const dialog = showAdvancedDialog ? (
    <SpawnAgentDialog
      swarmId={swarmId}
      defaultCwd={projectPath}
      onClose={() => setShowAdvancedDialog(false)}
    />
  ) : null;

  return { button, error, dialog };
}


// ─── Terminal Section ────────────────────────────────────────────────────────

function TerminalSection({ hosted }: { hosted: HostedSwarm }) {
  const navigate = useNavigate();
  if (hosted.state !== 'running') return null;

  return (
    <button
      onClick={() => navigate(`/terminal/${hosted.id}`)}
      className="mt-4 w-full card card-hover px-3 py-2.5 flex items-center gap-3 text-left transition-colors group"
      aria-label="Open TUI in a dedicated view"
    >
      <div
        className="w-7 h-7 rounded flex items-center justify-center shrink-0"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <Terminal className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium group-hover:text-honey-500 transition-colors">Open Terminal</div>
        <div className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
          Attach to the hosted process to tail output and drive the TUI.
        </div>
      </div>
      <ChevronRight
        className="w-3.5 h-3.5 shrink-0 group-hover:text-honey-500 transition-colors"
        style={{ color: 'var(--color-text-muted)' }}
      />
    </button>
  );
}

// ─── Logs Section ────────────────────────────────────────────────────────────

function LogsSection({ hosted }: { hosted: HostedSwarm }) {
  const [expanded, setExpanded] = useState(false);
  const { data: logs, isLoading } = useSwarmLogs(expanded ? hosted.id : null);

  return (
    <div className="mt-4">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full card card-hover px-3 py-2.5 flex items-center gap-3 text-left transition-colors group"
        aria-expanded={expanded}
        aria-controls="logs-panel"
      >
        <div
          className="w-7 h-7 rounded flex items-center justify-center shrink-0"
          style={{ backgroundColor: 'var(--color-elevated)' }}
        >
          <FileText className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium group-hover:text-honey-500 transition-colors">
            {expanded ? 'Hide Logs' : 'Show Logs'}
          </div>
          <div className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            Process logs, refreshed every 5 seconds while visible.
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 shrink-0 group-hover:text-honey-500 transition-colors" style={{ color: 'var(--color-text-muted)' }} />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 shrink-0 group-hover:text-honey-500 transition-colors" style={{ color: 'var(--color-text-muted)' }} />
        )}
      </button>
      {expanded && (
        <pre
          id="logs-panel"
          className="mt-2 p-2 rounded text-2xs overflow-x-auto max-h-64 overflow-y-auto font-mono"
          style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
        >
          {isLoading ? 'Loading…' : (logs || '(no logs available)')}
        </pre>
      )}
    </div>
  );
}

// ─── Nodes Section ───────────────────────────────────────────────────────────

const NODE_STATE_STYLES: Record<string, { bg: string; text: string }> = {
  active:     { bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
  busy:       { bg: 'bg-amber-500/10',   text: 'text-amber-400' },
  idle:       { bg: 'bg-blue-500/10',    text: 'text-blue-400' },
  registered: { bg: 'bg-gray-500/10',    text: 'text-gray-400' },
  suspended:  { bg: 'bg-orange-500/10',  text: 'text-orange-400' },
  stopped:    { bg: 'bg-gray-500/10',    text: 'text-gray-400' },
  failed:     { bg: 'bg-red-500/10',     text: 'text-red-400' },
};

function NodeCard({ node }: { node: MapNode }) {
  const isOffline = node.presence === 'offline';
  // When offline, don't render the last-known MAP state as if it were live —
  // show a single 'offline' pill instead. The row is also muted via opacity.
  const style = isOffline
    ? { bg: 'bg-gray-500/10', text: 'text-gray-400' }
    : (NODE_STATE_STYLES[node.state] || NODE_STATE_STYLES.registered);

  return (
    <div className={`card px-3 py-2 ${isOffline ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-3">
        <div
          className="w-7 h-7 rounded flex items-center justify-center shrink-0"
          style={{ backgroundColor: 'var(--color-elevated)' }}
        >
          <User className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{node.name || node.map_agent_id}</span>
            <span className={`text-2xs px-1.5 py-0.5 rounded font-medium ${style.bg} ${style.text}`}>
              {isOffline ? 'offline' : node.state}
            </span>
            {node.role && (
              <span className="text-2xs px-1.5 py-0.5 rounded capitalize" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
                {node.role}
              </span>
            )}
          </div>
          {node.description && (
            <p className="text-2xs mt-0.5 truncate" style={{ color: 'var(--color-text-muted)' }}>{node.description}</p>
          )}
        </div>
        {node.tags && node.tags.length > 0 && (
          <div className="flex items-center gap-1 shrink-0">
            {node.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="text-2xs px-1 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NodesSection({ swarmId }: { swarmId: string }) {
  const { data: nodes, isLoading } = useMapNodes({ swarm_id: swarmId });

  if (isLoading) return <LoadingSpinner size="sm" />;
  if (!nodes || nodes.length === 0) return null;

  return (
    <div>
      <SectionHeading icon={User} label="Agents" count={nodes.length} />
      <div className="space-y-1">
        {nodes.map((node) => (
          <NodeCard key={node.id} node={node} />
        ))}
      </div>
    </div>
  );
}

// ─── Live registered agents (per-agent ACP chat) ─────────────────────────────

interface LiveRegisteredAgent {
  id: string;
  name: string;
  role: string;
  state: string;
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Per-agent card that surfaces live capabilities and — for ACP-capable agents —
 * a "Chat" button that creates an ACP session targeting that specific agent
 * (useful when a swarm has multiple coordinators and the user wants to pick).
 */
function RegisteredAgentCard({
  agent,
  swarmId,
  projectPath,
  openChanges,
  activeSessionsCount,
}: {
  agent: LiveRegisteredAgent;
  swarmId: string;
  projectPath?: string;
  openChanges: StreamDAGNode[];
  activeSessionsCount: number;
}) {
  const navigate = useNavigate();
  const connectAcp = useConnectAcp();
  const stopAgent = useStopAgent();

  const caps = agent.capabilities ?? {};
  const protocols = Array.isArray(caps.protocols) ? (caps.protocols as string[]) : [];
  const supportsAcp = protocols.includes('acp');
  // Don't offer a Stop button for the sidecar — stopping it would take down
  // the whole swarm's hub connection. Use Swarms page controls for that.
  const canStop = agent.role !== 'sidecar';

  // Prefer the peer-side map id (targetable on the swarm's own MAP server).
  const targetAgentId = getPeerMapId(agent.metadata) ?? agent.id;

  const handleChat = async () => {
    try {
      const result = await connectAcp.mutateAsync({
        swarmId,
        cwd: projectPath,
        agentId: targetAgentId,
      });
      const params = new URLSearchParams({
        streamId: result.acp_stream_id,
        sessionId: result.acp_session_id,
      });
      navigate(`/threads/${result.session_resource_id}?${params}`);
    } catch {
      // Error state is rendered below via the mutation's isError flag
    }
  };

  const handleStop = async () => {
    try {
      const result = await stopAgent.mutateAsync({ swarmId, agentId: agent.id, reason: 'cancelled' });
      if (result?.method === 'map/agents/unregister') {
        // Older runtimes (no _macro/terminateAgent) only unregister from the
        // MAP registry — the underlying agent process may still be running.
        toast.success(
          'Agent unregistered',
          `"${agent.name || agent.id}" was removed from the registry. The agent process may still be running on the swarm.`,
        );
      } else {
        toast.success('Agent stopped', `"${agent.name || agent.id}" was terminated.`);
      }
    } catch (err) {
      toast.error('Stop failed', (err as Error).message);
    }
  };

  return (
    <div className="card px-3 py-2">
      <div className="flex items-center gap-3">
        <div
          className="w-7 h-7 rounded flex items-center justify-center shrink-0"
          style={{ backgroundColor: 'var(--color-elevated)' }}
        >
          <User className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{agent.name || agent.id}</span>
            <span className="text-2xs px-1.5 py-0.5 rounded capitalize" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
              {agent.role}
            </span>
            {protocols.map((p) => (
              <span
                key={p}
                className="text-2xs px-1.5 py-0.5 rounded font-medium"
                style={{ backgroundColor: 'var(--color-accent-bg)', color: 'var(--color-accent)' }}
              >
                {p}
              </span>
            ))}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <span className="font-mono truncate">{agent.id}</span>
            {openChanges.length > 0 && (
              <Link
                to="/changes"
                className="inline-flex items-center gap-0.5 shrink-0 hover:opacity-80"
                style={{ color: 'var(--color-text-muted)' }}
                title={`${openChanges.length} open change${openChanges.length === 1 ? '' : 's'}`}
              >
                <GitBranch className="w-3 h-3 text-honey-500" />
                {openChanges.length}
                {openChanges.some((c) => c.open_conflict_count > 0) && (
                  <AlertTriangle className="w-3 h-3 ml-0.5" style={{ color: 'var(--color-danger)' }} />
                )}
              </Link>
            )}
            {activeSessionsCount > 0 && (
              <Link
                to="/threads"
                className="inline-flex items-center gap-0.5 shrink-0 hover:opacity-80"
                style={{ color: 'var(--color-text-muted)' }}
                title={`${activeSessionsCount} session${activeSessionsCount === 1 ? '' : 's'}`}
              >
                <MessageSquare className="w-3 h-3 text-honey-500" />
                {activeSessionsCount}
              </Link>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {supportsAcp && (
            <button
              onClick={handleChat}
              disabled={connectAcp.isPending}
              className="btn btn-primary inline-flex items-center gap-1 px-2 py-1 text-2xs disabled:opacity-70 disabled:cursor-not-allowed disabled:hover:bg-honey-500"
              title="Start ACP session with this agent"
            >
              {connectAcp.isPending ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Zap className="w-3 h-3" />
              )}
              Chat
            </button>
          )}
          {canStop && (
            <button
              onClick={handleStop}
              disabled={stopAgent.isPending}
              className="btn btn-ghost p-1.5 text-red-400 hover:bg-red-500/10"
              title="Stop agent"
            >
              {stopAgent.isPending ? <LoadingSpinner size="sm" /> : <Square className="w-3 h-3" />}
            </button>
          )}
        </div>
      </div>
      {connectAcp.isError && (
        <div className="mt-1.5 text-2xs text-red-400">
          {(connectAcp.error as Error)?.message || 'Failed to create session'}
        </div>
      )}
    </div>
  );
}

/**
 * Active Work section — combines in-flight dispatches + open cascade changes
 * for this swarm into one operational-visibility surface. Hidden when both
 * lists are empty so it doesn't add chrome for idle swarms.
 */
function ActiveWorkSection({ swarmId }: { swarmId: string }) {
  const { data: dispatchResp } = useDispatchList({
    target_swarm_id: swarmId,
    status: ['queued', 'running'],
    limit: 10,
  });
  const { data: cascadeResp } = useCascadeDAG({ source_swarm_id: swarmId });

  const dispatches = dispatchResp?.data ?? [];
  const openChanges = useMemo(
    () => (cascadeResp?.data?.nodes ?? []).filter(
      (n) => n.status !== 'merged' && n.status !== 'abandoned',
    ),
    [cascadeResp],
  );

  if (dispatches.length === 0 && openChanges.length === 0) return null;

  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold flex items-center gap-2 mb-2">
        <Activity className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
        Active Work
      </h3>
      <div className="grid md:grid-cols-2 gap-3">
        {/* In-flight dispatches */}
        <div
          className="rounded-md border p-3"
          style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-surface)' }}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs flex items-center gap-1.5" style={{ color: 'var(--color-text-muted)' }}>
              <Send className="h-3.5 w-3.5 text-honey-500" />
              In-flight dispatches
              <span>{dispatches.length}</span>
            </div>
            {dispatches.length > 0 && (
              <Link
                to="/dispatch"
                className="text-2xs hover:opacity-80"
                style={{ color: 'var(--color-text-muted)' }}
              >
                View all →
              </Link>
            )}
          </div>
          {dispatches.length === 0 ? (
            <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
              Nothing running.
            </p>
          ) : (
            <ul className="space-y-1">
              {dispatches.slice(0, 5).map((d) => (
                <li key={d.id}>
                  <Link
                    to={`/dispatch/${d.id}`}
                    className="flex items-center justify-between gap-2 text-sm hover:opacity-80"
                    style={{ color: 'var(--color-text)' }}
                  >
                    <span className="font-mono text-xs truncate">{d.spec_id}</span>
                    <DispatchStatusChip status={d.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Open changes */}
        <div
          className="rounded-md border p-3"
          style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-surface)' }}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs flex items-center gap-1.5" style={{ color: 'var(--color-text-muted)' }}>
              <GitBranch className="h-3.5 w-3.5 text-honey-500" />
              Open changes
              <span>{openChanges.length}</span>
            </div>
            {openChanges.length > 0 && (
              <Link
                to="/changes"
                className="text-2xs hover:opacity-80"
                style={{ color: 'var(--color-text-muted)' }}
              >
                View all →
              </Link>
            )}
          </div>
          {openChanges.length === 0 ? (
            <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
              No streams open.
            </p>
          ) : (
            <ul className="space-y-1">
              {openChanges.slice(0, 5).map((n) => (
                <li key={n.id}>
                  <Link
                    to="/changes"
                    className="flex items-center gap-2 text-sm hover:opacity-80"
                    style={{ color: 'var(--color-text)' }}
                  >
                    <StreamStatusDot status={n.status} />
                    <span className="truncate">{n.name || n.stream_id}</span>
                    {n.open_conflict_count > 0 && (
                      <span
                        className="text-2xs flex items-center gap-0.5 shrink-0"
                        style={{ color: 'var(--color-danger)' }}
                      >
                        <AlertTriangle className="w-3 h-3" />
                        {n.open_conflict_count}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function RegisteredAgentsSection({ swarm, swarmId, hosted }: { swarm: MapSwarm; swarmId: string; hosted?: HostedSwarm }) {
  const allAgents = (swarm as any)?.registered_agents as LiveRegisteredAgent[] | undefined ?? [];
  const sidecars = allAgents.filter((a) => a.role === 'sidecar');
  const agents = allAgents.filter((a) => a.role !== 'sidecar');

  // Fan data into per-agent buckets for inline chips. Single query at the
  // section level; cards consume the derived maps.
  const { data: cascadeResp } = useCascadeDAG({ source_swarm_id: swarmId });
  const { data: sessionsResp } = useSessionsList({ swarm_id: swarmId, limit: 100 });

  const openChangesByAgent = useMemo(() => {
    const map = new Map<string, StreamDAGNode[]>();
    for (const n of cascadeResp?.data?.nodes ?? []) {
      if (n.status === 'merged' || n.status === 'abandoned') continue;
      const list = map.get(n.source_agent_id) ?? [];
      list.push(n);
      map.set(n.source_agent_id, list);
    }
    return map;
  }, [cascadeResp]);

  const sessionCountByAgent = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessionsResp?.data ?? []) {
      if (!s.acp_target_agent_id) continue;
      map.set(s.acp_target_agent_id, (map.get(s.acp_target_agent_id) ?? 0) + 1);
    }
    return map;
  }, [sessionsResp]);

  // Derive the swarm's effective cwd. Mirror the backend resolution chain in
  // src/api/routes/map.ts: hosted bootstrap.cwd → swarm metadata.cwd →
  // metadata.projectPath → capabilities.projectPath → hosted data_dir.
  // The first hit wins. The dialog uses this as a placeholder + fallback
  // hint so the user can see exactly where an empty-cwd spawn will land.
  // The hosted data_dir is the terminal fallback because it's where the
  // runtime process literally launched — `'.'` resolves to it at the
  // OS level when no other cwd flows through.
  const projectPath =
    hosted?.bootstrap?.cwd ??
    (swarm.metadata as any)?.cwd as string | undefined ??
    (swarm.metadata as any)?.projectPath as string | undefined ??
    (swarm.capabilities as any)?.projectPath as string | undefined ??
    hosted?.data_dir;

  const isOnline = swarm.status === 'online' || swarm.status === 'unreachable';
  const swarmActions = useSwarmActions({ swarm, swarmId, defaultCwd: projectPath });

  if (allAgents.length === 0 && !isOnline) return null;

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <User className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
          Registered Agents
          {agents.length > 0 && (
            <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>{agents.length}</span>
          )}
          {sidecars.length > 0 && (
            <span
              className="text-2xs font-normal px-1.5 py-0.5 rounded"
              style={{ color: 'var(--color-text-muted)', backgroundColor: 'var(--color-surface)' }}
              title={`Sidecar: ${sidecars.map((s) => s.id).join(', ')}`}
            >
              sidecar connected
            </span>
          )}
        </h3>
        {swarmActions.button}
      </div>
      {swarmActions.error}
      {swarmActions.dialog}
      {agents.length > 0 ? (
        <div className="space-y-1">
          {agents.map((agent) => {
            const peerId = getPeerMapId(agent.metadata) ?? agent.id;
            return (
              <RegisteredAgentCard
                key={agent.id}
                agent={agent}
                swarmId={swarmId}
                projectPath={projectPath}
                openChanges={openChangesByAgent.get(peerId) ?? []}
                activeSessionsCount={sessionCountByAgent.get(peerId) ?? 0}
              />
            );
          })}
        </div>
      ) : (
        <EmptyState message="No agents yet. Click Spawn Agent to create a coordinator." />
      )}
    </div>
  );
}

// ─── Messages Section ────────────────────────────────────────────────────────

function MessageCard({ message, swarmId }: { message: SwarmMessage; swarmId: string }) {
  const isInbound = message.to_swarm_id === swarmId;

  return (
    <div className="card px-3 py-2">
      <div className="flex items-start gap-3">
        <div
          className="w-7 h-7 rounded flex items-center justify-center shrink-0"
          style={{ backgroundColor: 'var(--color-elevated)' }}
        >
          <MessageSquare className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-2xs px-1.5 py-0.5 rounded font-medium ${
              isInbound ? 'bg-blue-500/10 text-blue-400' : 'bg-purple-500/10 text-purple-400'
            }`}>
              {isInbound ? 'in' : 'out'}
            </span>
            <span className="text-2xs font-mono truncate" style={{ color: 'var(--color-text-muted)' }}>
              {isInbound ? message.from_swarm_id : message.to_swarm_id || 'broadcast'}
            </span>
            {message.hive_id && (
              <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                in {message.hive_id}
              </span>
            )}
            {message.read_at && (
              <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" title="Read" />
            )}
          </div>
          <p className="text-xs mt-1 line-clamp-2" style={{ color: 'var(--color-text-secondary)' }}>
            {message.content_type === 'json' ? (
              <code className="font-mono text-2xs">{message.content.slice(0, 200)}</code>
            ) : (
              message.content.slice(0, 200)
            )}
          </p>
          <div className="mt-1 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <TimeAgo date={message.created_at} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ComposeMessageSection({ swarmId }: { swarmId: string }) {
  const [expanded, setExpanded] = useState(false);

  const adapters = useMemo<ChatAdapter[]>(
    () => [createCoordinationChatAdapter({ fromSwarmId: swarmId })],
    [swarmId],
  );
  const target = useMemo<ChatTarget>(
    () => ({ kind: 'agent', agentId: swarmId }),
    [swarmId],
  );
  // Coordination messaging is always available between swarms — the adapter
  // doesn't need MAP capability gating.
  const resolveCapabilities = useCallback<CapabilityResolver>(
    () => ({
      available: true,
      connected: true,
      mail: { canJoin: true, canCreate: true },
    }),
    [],
  );

  const channel = useChatChannel({
    target: expanded ? target : null,
    adapters,
    resolveCapabilities,
  });

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs font-medium px-2 py-1.5 rounded hover:bg-[var(--color-elevated)] transition-colors"
        style={{ color: 'var(--color-text-secondary)' }}
        title="Swarm-to-swarm coordination. Not the same as chatting with an agent — use the Chat button on an agent for that."
      >
        <Megaphone className="w-3.5 h-3.5" />
        {expanded ? 'Hide' : 'Open'} Coordination Broadcast
      </button>
      {expanded && (
        <div
          className="card mt-1 overflow-hidden flex flex-col"
          style={{ borderLeft: '2px solid var(--color-accent)' }}
        >
          <div
            className="px-3 py-1.5 text-2xs border-b"
            style={{
              color: 'var(--color-text-muted)',
              borderColor: 'var(--color-border-subtle)',
              backgroundColor: 'var(--color-elevated)',
            }}
          >
            Swarm-to-swarm coordination · not agent chat
          </div>
          <div className="h-52 flex flex-col">
            <ChatMessageList channel={channel} compact continuationHeaders />
            <ChatInput channel={channel} compact />
          </div>
        </div>
      )}
    </div>
  );
}

function MessagesSection({ swarmId }: { swarmId: string }) {
  const { data, isLoading } = useSwarmMessages(swarmId, { limit: 20 });
  const messages = data?.data ?? [];

  if (isLoading) return <LoadingSpinner size="sm" />;
  if (messages.length === 0) return null;

  return (
    <div>
      <SectionHeading icon={MessageSquare} label="Messages" count={data?.total} />
      <div className="space-y-1">
        {messages.map((msg) => (
          <MessageCard key={msg.id} message={msg} swarmId={swarmId} />
        ))}
      </div>
    </div>
  );
}

// ─── Events Section (Subscriptions + Delivery Log) ───────────────────────────

const DELIVERY_STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  sent:    { bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
  failed:  { bg: 'bg-red-500/10',     text: 'text-red-400' },
  offline: { bg: 'bg-gray-500/10',    text: 'text-gray-400' },
};

function EventsSection({ swarmId }: { swarmId: string }) {
  const { data: subscriptions, isLoading: subsLoading } = useEventSubscriptions({ swarm_id: swarmId });
  const { data: deliveryData, isLoading: logLoading } = useDeliveryLog({ swarm_id: swarmId, limit: 10 });
  const deliveries = deliveryData?.data ?? [];

  if (subsLoading || logLoading) return <LoadingSpinner size="sm" />;

  const subs = subscriptions ?? [];
  if (subs.length === 0 && deliveries.length === 0) return null;

  return (
    <div>
      <SectionHeading icon={Bell} label="Events" count={subs.length} />

      {/* Subscriptions */}
      {subs.length > 0 && (
        <div className="space-y-1 mb-3">
          {subs.map((sub) => (
            <div key={sub.id} className="card px-3 py-2">
              <div className="flex items-center gap-3">
                <div
                  className="w-7 h-7 rounded flex items-center justify-center shrink-0"
                  style={{ backgroundColor: 'var(--color-elevated)' }}
                >
                  <Bell className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{sub.source}</span>
                    {!sub.enabled && (
                      <span className="text-2xs px-1.5 py-0.5 rounded bg-gray-500/10 text-gray-400">disabled</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                    {sub.event_types.map((t) => (
                      <span key={t} className="text-2xs px-1 py-0.5 rounded font-mono" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Recent deliveries */}
      {deliveries.length > 0 && (
        <>
          <p className="text-2xs font-medium mb-1.5" style={{ color: 'var(--color-text-muted)' }}>Recent deliveries</p>
          <div className="space-y-1">
            {deliveries.map((d) => {
              const style = DELIVERY_STATUS_STYLES[d.status] || DELIVERY_STATUS_STYLES.offline;
              return (
                <div key={d.id} className="card px-3 py-1.5 flex items-center gap-3">
                  <span className={`text-2xs px-1.5 py-0.5 rounded font-medium ${style.bg} ${style.text}`}>
                    {d.status}
                  </span>
                  <span className="text-xs font-mono truncate" style={{ color: 'var(--color-text-secondary)' }}>
                    {d.source}/{d.event_type}
                  </span>
                  {d.error && (
                    <span className="text-2xs text-red-400 truncate max-w-[200px]" title={d.error}>
                      {d.error}
                    </span>
                  )}
                  <span className="ml-auto text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                    <TimeAgo date={d.created_at} />
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Peers Section ───────────────────────────────────────────────────────────

function PeersSection({ swarmId }: { swarmId: string }) {
  const { data: peers, isLoading, isError } = useSwarmPeers(swarmId);

  if (isLoading) return <LoadingSpinner size="sm" />;
  if (isError || !Array.isArray(peers) || peers.length === 0) return null;

  return (
    <div>
      <SectionHeading icon={Network} label="Peers" count={peers.length} />
      <div className="space-y-1">
        {peers.map((peer) => (
          <Link
            key={peer.swarm_id}
            to={`/swarms/${peer.swarm_id}`}
            className="card card-hover px-3 py-2 flex items-center gap-3 group"
          >
            <div
              className="w-7 h-7 rounded flex items-center justify-center shrink-0"
              style={{ backgroundColor: 'var(--color-elevated)' }}
            >
              <Link2 className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate group-hover:text-honey-500 transition-colors">
                  {peer.name}
                </span>
                <MapStatusBadge status={peer.status} />
                <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                  {peer.agent_count} agent{peer.agent_count !== 1 ? 's' : ''}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-0.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                {peer.shared_hives.length > 0 && (
                  <span>shared: {peer.shared_hives.join(', ')}</span>
                )}
                {peer.map_endpoint !== 'hub-inbound' && peer.map_endpoint !== 'local-hub' && (
                  <span className="font-mono truncate max-w-[200px]">{peer.map_endpoint}</span>
                )}
              </div>
            </div>
            <ChevronRight
              className="w-3.5 h-3.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ color: 'var(--color-text-muted)' }}
            />
          </Link>
        ))}
      </div>
    </div>
  );
}

// ─── Sessions Section ────────────────────────────────────────────────────────

function SessionCard({ session }: { session: SessionListItem }) {
  const totalTokens = session.total_input_tokens + session.total_output_tokens;

  return (
    <Link
      to={`/threads/${session.id}`}
      className="card card-hover px-3 py-2.5 flex items-start gap-3 group"
    >
      <div
        className="w-7 h-7 rounded flex items-center justify-center shrink-0 mt-0.5"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <Activity className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm truncate group-hover:text-honey-500 transition-colors">
            {session.name}
          </h3>
          {session.total_checkpoints > 0 && (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="Active" />
          )}
          <span className={`text-2xs px-1.5 py-0.5 rounded ${
            session.visibility === 'public' ? 'bg-emerald-500/10 text-emerald-400'
              : session.visibility === 'shared' ? 'bg-blue-500/10 text-blue-400'
              : 'bg-gray-500/10 text-gray-400'
          }`}>
            {session.visibility}
          </span>
        </div>

        <div className="flex items-center gap-3 mt-1 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          {session.latest_agent && (
            <span className="flex items-center gap-1">
              <User className="w-3 h-3" />
              {session.latest_agent}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Activity className="w-3 h-3" />
            {session.total_checkpoints}
          </span>
          {totalTokens > 0 && (
            <span className="flex items-center gap-1">
              <Cpu className="w-3 h-3" />
              {formatTokens(totalTokens)}
            </span>
          )}
          {session.last_synced_at && (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <TimeAgo date={session.last_synced_at} />
            </span>
          )}
        </div>
      </div>

      <ChevronRight
        className="w-4 h-4 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-1"
        style={{ color: 'var(--color-text-muted)' }}
      />
    </Link>
  );
}

/**
 * Per-row resume action. Navigates to the session on success with fresh
 * stream/session query params so the trajectory page hydrates against the
 * new ACP stream.
 */
function ResumableSessionRow({
  session,
  onSuccess,
}: {
  session: ResumableSession;
  onSuccess: (data: { acp_session_id: string; acp_stream_id: string }) => void;
}) {
  const navigate = useNavigate();
  const resumeMutation = useResumeSession();

  const handleResume = () => {
    resumeMutation.mutate(
      { sessionResourceId: session.session_resource_id },
      {
        onSuccess: (data) => {
          onSuccess(data);
          toast.success('Session resumed', session.name);
        },
        onError: (err) => {
          toast.error('Resume failed', (err as Error).message);
        },
      },
    );
  };

  const goToSession = () => {
    navigate(`/threads/${session.session_resource_id}`);
  };

  return (
    <div
      className="card px-3 py-2 flex items-center gap-3 hover:ring-1 hover:ring-honey-500/20 transition-shadow cursor-pointer"
      onClick={goToSession}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium truncate">{session.name}</span>
          {session.project && (
            <span
              className="text-2xs px-1.5 py-0.5 rounded shrink-0"
              style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
            >
              {session.project}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          <code className="font-mono">{session.provider_session_id_prefix}…</code>
          <TimeAgo date={session.updated_at} />
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          handleResume();
        }}
        disabled={resumeMutation.isPending}
        className="text-2xs px-2 py-1 rounded shrink-0 flex items-center gap-1 cursor-pointer disabled:cursor-wait disabled:opacity-60"
        style={{ backgroundColor: 'var(--color-honey-500, #f59e0b)', color: 'var(--color-bg)' }}
        title="Restart the swarm if needed, respawn the agent, and reload the session"
      >
        {resumeMutation.isPending ? (
          <>
            <Loader2 className="w-3 h-3 animate-spin" />
            Starting…
          </>
        ) : (
          <>
            <Play className="w-3 h-3" />
            Resume
          </>
        )}
      </button>
    </div>
  );
}

/**
 * Swarm-level panel listing resumable sessions + a batch "Resume all" action.
 * Only rendered when the query returns ≥1 session with a persisted
 * provider_session_id. Sessions without a psid are surfaced via the regular
 * Sessions section — resume doesn't apply to them.
 */
function ResumableSessionsSection({ swarmId }: { swarmId: string }) {
  const navigate = useNavigate();
  const { data, isLoading } = useResumableSessions(swarmId);
  const resumeAll = useResumeAllSessions();

  const sessions = data?.sessions ?? [];
  if (isLoading) return null; // avoid flashing an empty panel on initial load
  if (sessions.length === 0) return null;

  const handleResumeAll = async () => {
    try {
      const result = await resumeAll.mutateAsync({ swarmId });
      const fail = result.failed.length;
      const win = result.succeeded.length;
      if (fail === 0) {
        toast.success('Resumed all sessions', `${win} session${win === 1 ? '' : 's'} resumed.`);
      } else if (win === 0) {
        toast.error('Resume failed', `All ${fail} session${fail === 1 ? '' : 's'} failed.`);
      } else {
        toast.error(
          'Partial resume',
          `${win} resumed, ${fail} failed. Check each session for details.`,
        );
      }
    } catch (err) {
      toast.error('Resume failed', (err as Error).message);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <SectionHeading icon={Play} label="Resumable Sessions" count={sessions.length} />
        {sessions.length > 1 && (
          <button
            onClick={handleResumeAll}
            disabled={resumeAll.isPending}
            className="text-2xs px-2 py-1 rounded flex items-center gap-1 cursor-pointer disabled:cursor-wait disabled:opacity-60"
            style={{ backgroundColor: 'var(--color-honey-500, #f59e0b)', color: 'var(--color-bg)' }}
            title="Restart the swarm (if needed) and resume every session on it"
          >
            {resumeAll.isPending ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin" />
                Resuming {sessions.length}…
              </>
            ) : (
              <>
                <Play className="w-3 h-3" />
                Resume all ({sessions.length})
              </>
            )}
          </button>
        )}
      </div>

      {resumeAll.data && resumeAll.data.failed.length > 0 && (
        <div
          className="mb-2 px-3 py-2 rounded text-2xs flex items-start gap-2"
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.08)',
            color: 'var(--color-text-secondary)',
          }}
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-400" />
          <div className="flex-1">
            <div className="font-medium mb-0.5">{resumeAll.data.failed.length} session(s) failed to resume</div>
            {resumeAll.data.failed.slice(0, 3).map((f) => (
              <div key={f.session_resource_id} className="opacity-80">
                <code className="font-mono">{f.session_resource_id.slice(-8)}</code>: {f.error} — {f.message}
              </div>
            ))}
            {resumeAll.data.failed.length > 3 && (
              <div className="opacity-60">+{resumeAll.data.failed.length - 3} more</div>
            )}
          </div>
        </div>
      )}

      <div className="space-y-1">
        {sessions.map((s) => (
          <ResumableSessionRow
            key={s.session_resource_id}
            session={s}
            onSuccess={(data) =>
              navigate(
                `/sessions/${s.session_resource_id}?streamId=${data.acp_stream_id}&sessionId=${data.acp_session_id}`,
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

function SessionsSection({ swarmId }: { swarmId: string }) {
  const { data, isLoading } = useSessionsList({ swarm_id: swarmId });
  useSessionsRealtime();
  const sessions = data?.data ?? [];

  if (isLoading) return <LoadingSpinner size="sm" />;

  return (
    <div>
      <SectionHeading icon={Activity} label="Sessions" count={sessions.length} />
      {sessions.length > 0 ? (
        <div className="space-y-1">
          {sessions.map((session) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
      ) : (
        <EmptyState message="No sessions synced from this swarm yet." />
      )}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export function SwarmDetail() {
  const { id } = useParams<{ id: string }>();
  const { data: swarm, isLoading: mapLoading } = useMapSwarm(id!);
  const { data: hostedSwarms } = useHostedSwarms();
  useSwarmRealtime();

  // Find matching hosted swarm (by swarm_id linking to MAP registration).
  // useHostedSwarms has `select: d => d.data`, so `hostedSwarms` is the array.
  const hosted = hostedSwarms?.find(
    (h) => h.swarm_id === id || h.id === id
  );

  if (mapLoading) return <PageLoader />;

  if (!swarm) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6">
        <Link
          to="/swarms"
          className="inline-flex items-center gap-1 text-xs mb-4 hover:text-honey-500 transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <ArrowLeft className="w-3 h-3" />
          Back to Swarms
        </Link>
        <div className="card px-6 py-12 text-center" style={{ color: 'var(--color-text-muted)' }}>
          <Globe className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
            Swarm not found
          </p>
          <p className="text-xs">The swarm may have been removed or the ID is invalid.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <Link
          to="/swarms"
          className="inline-flex items-center gap-1 text-xs hover:text-honey-500 transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <ArrowLeft className="w-3 h-3" />
          Back to Swarms
        </Link>
        <Link
          to="/swarmcraft"
          className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md transition-colors"
          style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
        >
          <Monitor className="w-3.5 h-3.5" />
          Overview
        </Link>
      </div>

      <SwarmHeader swarm={swarm} swarmId={id!} hosted={hosted} />

      <ActiveWorkSection swarmId={id!} />

      {hosted && <TerminalSection hosted={hosted} />}

      {hosted && <LogsSection hosted={hosted} />}

      <NodesSection swarmId={id!} />

      <RegisteredAgentsSection swarm={swarm} swarmId={id!} hosted={hosted} />

      <ResumableSessionsSection swarmId={id!} />

      <SessionsSection swarmId={id!} />

      <ComposeMessageSection swarmId={id!} />

      <MessagesSection swarmId={id!} />

      <EventsSection swarmId={id!} />

      <PeersSection swarmId={id!} />
    </div>
  );
}
