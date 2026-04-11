import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Activity, Bell, ChevronRight, Clock, Cpu, FileText, Globe,
  Link2, MessageSquare, Monitor, Network, Plus, Share2,
  Square, RotateCw, Terminal, Trash2, User, Wifi, WifiOff,
  CheckCircle2, Zap,
} from 'lucide-react';
import {
  useMapSwarm, useMapNodes, useHostedSwarms, useSessionsList, useSwarmLogs,
  useStopSwarm, useRestartSwarm, useRemoveSwarm,
  useSwarmMessages, useSwarmPeers,
  useEventSubscriptions, useDeliveryLog,
  useConnectionHealth,
  useCreateAcpSession,
} from '../hooks/useApi';
import { useSwarmRealtime, useSessionsRealtime } from '../hooks/useRealtimeInvalidation';
import { TimeAgo } from '../components/common/TimeAgo';
import { PageLoader, LoadingSpinner } from '../components/common/LoadingSpinner';
import { HostedStateBadge, MapStatusBadge, SandboxBadge } from '../components/swarm/StatusBadges';
import { toast } from '../stores/toast';
import type {
  MapSwarm, MapNode, HostedSwarm, SessionListItem,
  SwarmMessage, SwarmPeer, EventSubscription, DeliveryLogEntry,
} from '../lib/api';
import { useState, useMemo } from 'react';
import { AgentChat } from 'swarmcraft/ui/embed';
import type { ChatChannelConfig } from 'swarmcraft/ui/embed';
import { createCoordinationChatAdapter } from '../adapters/coordination-chat-adapter';

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

function SwarmInfo({ swarm, swarmId }: { swarm: MapSwarm; swarmId: string }) {
  const { data: health } = useConnectionHealth(swarmId);
  return (
    <div className="card px-4 py-3">
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
            {swarm.map_endpoint === 'hub-inbound' && (
              <span className="text-2xs px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400">inbound</span>
            )}
            {swarm.map_endpoint === 'local-hub' && (
              <span className="text-2xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400">local</span>
            )}
          </div>
          {swarm.description && (
            <p className="text-sm mt-1" style={{ color: 'var(--color-text-secondary)' }}>
              {swarm.description}
            </p>
          )}
          <div className="flex items-center gap-3 mt-2 text-2xs flex-wrap" style={{ color: 'var(--color-text-muted)' }}>
            <span className="font-mono">{swarm.id}</span>
            {swarm.map_endpoint !== 'hub-inbound' && swarm.map_endpoint !== 'local-hub' && (
              <span className="font-mono truncate max-w-[250px]">{swarm.map_endpoint}</span>
            )}
            <span>{swarm.agent_count} agent{swarm.agent_count !== 1 ? 's' : ''}</span>
            {swarm.hives.length > 0 && <span>{swarm.hives.join(', ')}</span>}
            {swarm.last_seen_at && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                <TimeAgo date={swarm.last_seen_at} />
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0">
          {swarm.status === 'online' ? (
            <Wifi className="w-4 h-4 text-emerald-400" />
          ) : swarm.status === 'unreachable' ? (
            <WifiOff className="w-4 h-4 text-red-400" />
          ) : (
            <WifiOff className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
          )}
        </div>
      </div>

      {swarm.capabilities && Object.keys(swarm.capabilities).length > 0 && (
        <div className="mt-3 flex items-center gap-1.5 flex-wrap">
          {Object.entries(swarm.capabilities)
            .filter(([, v]) => v && v !== false)
            .map(([key]) => {
              const isProtocol = key === 'protocols';
              const isAcp = key === 'acp';
              if (isProtocol) {
                const protos = swarm.capabilities![key] as string[];
                return protos.map((p) => (
                  <span key={p} className="text-2xs px-1.5 py-0.5 rounded font-medium" style={{ backgroundColor: 'var(--color-accent-bg)', color: 'var(--color-accent)' }}>
                    {p}
                  </span>
                ));
              }
              if (isAcp) return null; // shown via protocols badge
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
    </div>
  );
}

// ─── Capability-Gated Actions ───────────────────────────────────────────────

function SwarmActions({ swarm, swarmId }: { swarm: MapSwarm; swarmId: string }) {
  const navigate = useNavigate();
  const createAcpSession = useCreateAcpSession();

  const caps = (swarm.capabilities || {}) as Record<string, unknown>;
  const protocols = Array.isArray(caps.protocols) ? caps.protocols as string[] : [];
  const supportsAcp = protocols.includes('acp');
  const isOnline = swarm.status === 'online' || swarm.status === 'unreachable';

  if (!isOnline || !supportsAcp) return null;

  const projectPath = (caps as any)?.projectPath as string
    ?? (swarm.metadata as any)?.projectPath as string
    ?? undefined;

  const handleNewSession = async () => {
    try {
      const result = await createAcpSession.mutateAsync({
        swarmId,
        cwd: projectPath,
      });
      navigate(`/sessions/${result.session_resource_id}`, {
        state: {
          acpStreamId: result.acp_stream_id,
          acpSessionId: result.acp_session_id,
        },
      });
    } catch {
      // Error shown via mutation state
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleNewSession}
        disabled={createAcpSession.isPending}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
        style={{ backgroundColor: 'var(--color-accent)', color: 'white' }}
      >
        {createAcpSession.isPending ? (
          <LoadingSpinner size="sm" />
        ) : (
          <Zap className="w-3.5 h-3.5" />
        )}
        New Agent Session
      </button>
      {createAcpSession.isError && (
        <span className="text-2xs text-red-400">
          {(createAcpSession.error as Error)?.message || 'Failed to create session'}
        </span>
      )}
    </div>
  );
}

// ─── Connection Health ──────────────────────────────────────────────────────

function ConnectionHealthBar({ swarmId }: { swarmId: string }) {
  const { data: health } = useConnectionHealth(swarmId);
  if (!health) return null;

  const uptime = health.connectedAt
    ? Math.floor((Date.now() - new Date(health.connectedAt).getTime()) / 1000)
    : 0;
  const formatUptime = (s: number) => {
    if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${s}s`;
  };

  const isDegraded = health.missedPongs > 0;
  const healthPct = Math.max(0, Math.round((1 - health.missedPongs / health.maxMissedPongs) * 100));

  return (
    <div className="card px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <Activity className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-xs font-semibold">Connection Health</span>
        {isDegraded && (
          <span className="text-2xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 font-medium">
            {health.missedPongs}/{health.maxMissedPongs} pongs missed
          </span>
        )}
      </div>

      {/* Health bar */}
      <div className="w-full h-1.5 rounded-full mb-3" style={{ backgroundColor: 'var(--color-elevated)' }}>
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            isDegraded ? 'bg-amber-400' : 'bg-emerald-400'
          }`}
          style={{ width: `${healthPct}%` }}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
        <div>
          <div className="font-medium mb-0.5" style={{ color: 'var(--color-text-secondary)' }}>Uptime</div>
          {formatUptime(uptime)}
        </div>
        <div>
          <div className="font-medium mb-0.5" style={{ color: 'var(--color-text-secondary)' }}>Last Activity</div>
          <TimeAgo date={health.lastMessageAt} />
        </div>
        <div>
          <div className="font-medium mb-0.5" style={{ color: 'var(--color-text-secondary)' }}>Agents</div>
          {health.registeredAgentCount}
        </div>
        <div>
          <div className="font-medium mb-0.5" style={{ color: 'var(--color-text-secondary)' }}>Transport</div>
          {health.transport}
          {health.tokenExpiresAt && (
            <span className="ml-1 text-amber-400" title={`Token expires: ${health.tokenExpiresAt}`}>
              (token)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Hosted Info ─────────────────────────────────────────────────────────────

function HostedInfo({ hosted }: { hosted: HostedSwarm }) {
  const navigate = useNavigate();
  const [showLogs, setShowLogs] = useState(false);
  const stopMutation = useStopSwarm();
  const restartMutation = useRestartSwarm();
  const removeMutation = useRemoveSwarm();
  const { data: logs } = useSwarmLogs(showLogs ? hosted.id : null);

  const canStop = hosted.state === 'running' || hosted.state === 'unhealthy' || hosted.state === 'starting';
  const canRestart = hosted.state === 'stopped' || hosted.state === 'failed';
  const canRemove = hosted.state === 'stopped' || hosted.state === 'failed';
  const isTransitioning = stopMutation.isPending || restartMutation.isPending || removeMutation.isPending;

  const handleStop = async () => {
    try {
      await stopMutation.mutateAsync(hosted.id);
      toast.success('Swarm stopped', `"${hosted.name}" has been stopped.`);
    } catch (err) {
      toast.error('Stop failed', (err as Error).message);
    }
  };

  const handleRestart = async () => {
    try {
      await restartMutation.mutateAsync(hosted.id);
      toast.success('Swarm restarted', `"${hosted.name}" is restarting.`);
    } catch (err) {
      toast.error('Restart failed', (err as Error).message);
    }
  };

  const handleRemove = async () => {
    try {
      await removeMutation.mutateAsync(hosted.id);
      toast.success('Swarm removed', `"${hosted.name}" has been removed.`);
      navigate('/swarms');
    } catch (err) {
      toast.error('Remove failed', (err as Error).message);
    }
  };

  return (
    <div className="card px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Cpu className="w-4 h-4 text-honey-500" />
          Hosted Instance
        </h3>
        <HostedStateBadge state={hosted.state} />
      </div>

      <div className="flex items-center gap-3 text-2xs flex-wrap" style={{ color: 'var(--color-text-muted)' }}>
        <span className="font-mono">{hosted.id}</span>
        <span>{hosted.provider === 'local-sandboxed' ? 'local' : hosted.provider}</span>
        {hosted.provider === 'local-sandboxed' && <SandboxBadge />}
        {hosted.assigned_port && <span>:{hosted.assigned_port}</span>}
        <TimeAgo date={hosted.updated_at > hosted.created_at ? hosted.updated_at : hosted.created_at} />
      </div>

      {hosted.error && (
        <div className="mt-2 px-2 py-1.5 bg-red-500/10 border border-red-500/20 rounded text-2xs text-red-400">
          {hosted.error}
        </div>
      )}

      <div className="flex items-center gap-1 mt-3">
        {canStop && (
          <button onClick={handleStop} disabled={isTransitioning} className="btn btn-ghost p-1.5 text-red-400 hover:bg-red-500/10" title="Stop">
            {stopMutation.isPending ? <LoadingSpinner size="sm" /> : <Square className="w-3.5 h-3.5" />}
          </button>
        )}
        {canRestart && (
          <button onClick={handleRestart} disabled={isTransitioning} className="btn btn-ghost p-1.5 hover:bg-emerald-500/10" style={{ color: 'var(--color-text-secondary)' }} title="Restart">
            {restartMutation.isPending ? <LoadingSpinner size="sm" /> : <RotateCw className="w-3.5 h-3.5" />}
          </button>
        )}
        {canRemove && (
          <button onClick={handleRemove} disabled={isTransitioning} className="btn btn-ghost p-1.5 text-red-400 hover:bg-red-500/10" title="Remove">
            {removeMutation.isPending ? <LoadingSpinner size="sm" /> : <Trash2 className="w-3.5 h-3.5" />}
          </button>
        )}
        {hosted.state === 'running' && (
          <button onClick={() => navigate(`/terminal/${hosted.id}`)} className="btn btn-ghost p-1.5 hover:bg-purple-500/10" style={{ color: 'var(--color-text-secondary)' }} title="Open TUI">
            <Terminal className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={() => setShowLogs(!showLogs)}
          className={`btn btn-ghost p-1.5 ${showLogs ? 'text-honey-500' : ''}`}
          style={!showLogs ? { color: 'var(--color-text-secondary)' } : undefined}
          title="Toggle logs"
        >
          <FileText className="w-3.5 h-3.5" />
        </button>
      </div>

      {showLogs && (
        <div className="mt-2">
          <pre
            className="p-2 rounded text-2xs overflow-x-auto max-h-48 overflow-y-auto font-mono"
            style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
          >
            {logs || '(no logs available)'}
          </pre>
        </div>
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
  const style = NODE_STATE_STYLES[node.state] || NODE_STATE_STYLES.registered;

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
            <span className="text-sm font-medium truncate">{node.name || node.map_agent_id}</span>
            <span className={`text-2xs px-1.5 py-0.5 rounded font-medium ${style.bg} ${style.text}`}>
              {node.state}
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

  // Use the swarm itself as the "from" identity for coordination messages
  const channelConfig: ChatChannelConfig = useMemo(() => ({
    adapters: [createCoordinationChatAdapter({ fromSwarmId: swarmId })],
  }), [swarmId]);

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs font-medium px-2 py-1.5 rounded hover:bg-[var(--color-elevated)] transition-colors"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        <MessageSquare className="w-3.5 h-3.5" />
        {expanded ? 'Hide' : 'Send'} Coordination Message
      </button>
      {expanded && (
        <div className="card mt-1 overflow-hidden h-52">
          <AgentChat
            agentId={swarmId}
            channelConfig={channelConfig}
            showHeader={false}
            compact
          />
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
      to={`/sessions/${session.id}`}
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

  // Find matching hosted swarm (by swarm_id linking to MAP registration)
  const hosted = hostedSwarms?.data?.find(
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

      <SwarmInfo swarm={swarm} swarmId={id!} />

      <SwarmActions swarm={swarm} swarmId={id!} />

      {swarm.status === 'online' && <ConnectionHealthBar swarmId={id!} />}

      {hosted && <HostedInfo hosted={hosted} />}

      <NodesSection swarmId={id!} />

      <SessionsSection swarmId={id!} />

      <ComposeMessageSection swarmId={id!} />

      <MessagesSection swarmId={id!} />

      <EventsSection swarmId={id!} />

      <PeersSection swarmId={id!} />
    </div>
  );
}
