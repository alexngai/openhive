import { useState } from 'react';
import {
  Zap, Square, RotateCw, Terminal, ChevronDown, ChevronUp, Plus, X, Cpu,
  Link2, Globe, Wifi, WifiOff, Settings2, Trash2,
} from 'lucide-react';
import { toast } from '../stores/toast';
import {
  useHostedSwarms, useSpawnSwarm, useStopSwarm, useRestartSwarm, useRemoveSwarm, useSwarmLogs,
  useMapSwarms, useConnectSwarm, useHives,
} from '../hooks/useApi';
import { PageLoader, LoadingSpinner } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import type { HostedSwarm, MapSwarm } from '../lib/api';
import clsx from 'clsx';

// =============================================================================
// Constants
// =============================================================================

const HOSTED_STATE_STYLES: Record<HostedSwarm['state'], { label: string; bg: string; text: string }> = {
  running:      { label: 'Running',      bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
  starting:     { label: 'Starting',     bg: 'bg-amber-500/10',   text: 'text-amber-400' },
  provisioning: { label: 'Provisioning', bg: 'bg-amber-500/10',   text: 'text-amber-400' },
  unhealthy:    { label: 'Unhealthy',    bg: 'bg-orange-500/10',  text: 'text-orange-400' },
  stopping:     { label: 'Stopping',     bg: 'bg-gray-500/10',    text: 'text-gray-400' },
  stopped:      { label: 'Stopped',      bg: 'bg-gray-500/10',    text: 'text-gray-400' },
  failed:       { label: 'Failed',       bg: 'bg-red-500/10',     text: 'text-red-400' },
};

const MAP_STATUS_STYLES: Record<string, { label: string; bg: string; text: string }> = {
  online:      { label: 'Online',      bg: 'bg-emerald-500/10', text: 'text-emerald-400' },
  offline:     { label: 'Offline',     bg: 'bg-gray-500/10',    text: 'text-gray-400' },
  unreachable: { label: 'Unreachable', bg: 'bg-red-500/10',     text: 'text-red-400' },
};

const PROVIDERS = [
  { value: 'local',  label: 'Local',   desc: 'Sidecar process on this machine' },
  { value: 'docker', label: 'Docker',  desc: 'Docker container' },
  { value: 'fly',    label: 'Fly.io',  desc: 'Fly.io machine' },
  { value: 'ssh',    label: 'SSH',     desc: 'Remote host via SSH' },
  { value: 'k8s',    label: 'K8s',     desc: 'Kubernetes pod' },
] as const;

const TRANSPORTS = [
  { value: 'websocket', label: 'WebSocket' },
  { value: 'http-sse',  label: 'HTTP SSE' },
  { value: 'ndjson',    label: 'NDJSON' },
] as const;

const AUTH_METHODS = [
  { value: 'none',    label: 'None' },
  { value: 'bearer',  label: 'Bearer Token' },
  { value: 'api-key', label: 'API Key' },
  { value: 'mtls',    label: 'mTLS' },
] as const;

// =============================================================================
// Shared Components
// =============================================================================

function HostedStateBadge({ state }: { state: HostedSwarm['state'] }) {
  const style = HOSTED_STATE_STYLES[state] || HOSTED_STATE_STYLES.stopped;
  return (
    <span className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium', style.bg, style.text)}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', state === 'running' ? 'bg-emerald-400 animate-pulse' : 'bg-current opacity-50')} />
      {style.label}
    </span>
  );
}

function MapStatusBadge({ status }: { status: string }) {
  const style = MAP_STATUS_STYLES[status] || MAP_STATUS_STYLES.offline;
  return (
    <span className={clsx('inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs font-medium', style.bg, style.text)}>
      <span className={clsx('w-1.5 h-1.5 rounded-full', status === 'online' ? 'bg-emerald-400 animate-pulse' : 'bg-current opacity-50')} />
      {style.label}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
      {children}
    </label>
  );
}

// =============================================================================
// Spawn Form
// =============================================================================

function SpawnForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [adapter, setAdapter] = useState('');
  const [hive, setHive] = useState('');
  const [provider, setProvider] = useState('local');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [adapterConfigRaw, setAdapterConfigRaw] = useState('');
  const [metadataRaw, setMetadataRaw] = useState('');

  const spawnMutation = useSpawnSwarm();
  const { data: hives } = useHives({ sort: 'popular', limit: 50 });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    let adapter_config: Record<string, unknown> | undefined;
    let metadata: Record<string, unknown> | undefined;

    if (adapterConfigRaw.trim()) {
      try {
        adapter_config = JSON.parse(adapterConfigRaw);
      } catch {
        toast.error('Invalid JSON', 'Adapter config must be valid JSON.');
        return;
      }
    }
    if (metadataRaw.trim()) {
      try {
        metadata = JSON.parse(metadataRaw);
      } catch {
        toast.error('Invalid JSON', 'Metadata must be valid JSON.');
        return;
      }
    }

    try {
      await spawnMutation.mutateAsync({
        name,
        description: description || undefined,
        adapter: adapter || undefined,
        hive: hive || undefined,
        provider: provider !== 'local' ? provider : undefined,
        adapter_config,
        metadata,
      });
      toast.success('Swarm spawned', `"${name}" is starting up.`);
      onClose();
    } catch (err) {
      toast.error('Spawn failed', (err as Error).message);
    }
  };

  return (
    <div className="card p-4 mb-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5 text-honey-500" />
          Spawn Swarm
        </h2>
        <button onClick={onClose} className="btn btn-ghost p-1">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Row 1: Name + Provider */}
        <div className="flex gap-3">
          <div className="flex-1">
            <SectionLabel>Name <span className="text-red-400">*</span></SectionLabel>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input w-full"
              placeholder="my-research-swarm"
              required
              maxLength={100}
            />
          </div>
          <div className="w-40">
            <SectionLabel>Provider</SectionLabel>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="input w-full"
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <p className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              {PROVIDERS.find(p => p.value === provider)?.desc}
            </p>
          </div>
        </div>

        {/* Row 2: Description */}
        <div>
          <SectionLabel>Description</SectionLabel>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input w-full"
            placeholder="What this swarm does..."
            maxLength={500}
          />
        </div>

        {/* Row 3: Adapter + Hive */}
        <div className="flex gap-3">
          <div className="flex-1">
            <SectionLabel>Adapter</SectionLabel>
            <input
              type="text"
              value={adapter}
              onChange={(e) => setAdapter(e.target.value)}
              className="input w-full"
              placeholder="macro-agent"
              maxLength={100}
            />
            <p className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              Defaults to macro-agent
            </p>
          </div>
          <div className="flex-1">
            <SectionLabel>Auto-join Hive</SectionLabel>
            <select
              value={hive}
              onChange={(e) => setHive(e.target.value)}
              className="input w-full"
            >
              <option value="">None</option>
              {hives?.map((h) => (
                <option key={h.id} value={h.name}>{h.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Advanced toggle */}
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1 text-2xs font-medium transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <Settings2 className="w-3 h-3" />
          Advanced
          {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>

        {showAdvanced && (
          <div className="space-y-3 pl-3 border-l-2" style={{ borderColor: 'var(--color-border-subtle)' }}>
            <div>
              <SectionLabel>Adapter Config (JSON)</SectionLabel>
              <textarea
                value={adapterConfigRaw}
                onChange={(e) => setAdapterConfigRaw(e.target.value)}
                className="input w-full font-mono text-2xs min-h-[60px] resize-y"
                placeholder='{"model": "claude-sonnet-4-5-20250929", "temperature": 0.7}'
              />
            </div>
            <div>
              <SectionLabel>Metadata (JSON)</SectionLabel>
              <textarea
                value={metadataRaw}
                onChange={(e) => setMetadataRaw(e.target.value)}
                className="input w-full font-mono text-2xs min-h-[60px] resize-y"
                placeholder='{"team": "research", "project": "docs"}'
              />
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={spawnMutation.isPending || !name.trim()}
            className="btn btn-primary flex items-center gap-1.5 text-xs"
          >
            {spawnMutation.isPending ? <LoadingSpinner size="sm" /> : <Zap className="w-3 h-3" />}
            Spawn
          </button>
          <button type="button" onClick={onClose} className="btn btn-ghost text-xs">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// =============================================================================
// Connect Form
// =============================================================================

function ConnectForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [transport, setTransport] = useState<'websocket' | 'http-sse' | 'ndjson'>('websocket');
  const [authMethod, setAuthMethod] = useState<'bearer' | 'api-key' | 'mtls' | 'none'>('none');
  const [authToken, setAuthToken] = useState('');
  const [capabilities, setCapabilities] = useState({ observation: true, messaging: true, lifecycle: true });

  const connectMutation = useConnectSwarm();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      await connectMutation.mutateAsync({
        name,
        description: description || undefined,
        map_endpoint: endpoint,
        map_transport: transport,
        capabilities,
        auth_method: authMethod,
        auth_token: authMethod !== 'none' ? authToken || undefined : undefined,
      });
      toast.success('Swarm connected', `"${name}" registered in MAP hub.`);
      onClose();
    } catch (err) {
      toast.error('Connect failed', (err as Error).message);
    }
  };

  return (
    <div className="card p-4 mb-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Link2 className="w-3.5 h-3.5 text-honey-500" />
          Connect External Swarm
        </h2>
        <button onClick={onClose} className="btn btn-ghost p-1">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Name + Transport */}
        <div className="flex gap-3">
          <div className="flex-1">
            <SectionLabel>Name <span className="text-red-400">*</span></SectionLabel>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input w-full"
              placeholder="external-swarm"
              required
              maxLength={100}
            />
          </div>
          <div className="w-36">
            <SectionLabel>Transport</SectionLabel>
            <select
              value={transport}
              onChange={(e) => setTransport(e.target.value as typeof transport)}
              className="input w-full"
            >
              {TRANSPORTS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Endpoint */}
        <div>
          <SectionLabel>MAP Endpoint <span className="text-red-400">*</span></SectionLabel>
          <input
            type="url"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            className="input w-full font-mono text-xs"
            placeholder="ws://192.168.1.50:3000"
            required
          />
          <p className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            The MAP server endpoint of the swarm to connect
          </p>
        </div>

        {/* Description */}
        <div>
          <SectionLabel>Description</SectionLabel>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input w-full"
            placeholder="What this swarm does..."
            maxLength={500}
          />
        </div>

        {/* Auth */}
        <div className="flex gap-3">
          <div className="w-36">
            <SectionLabel>Auth Method</SectionLabel>
            <select
              value={authMethod}
              onChange={(e) => setAuthMethod(e.target.value as typeof authMethod)}
              className="input w-full"
            >
              {AUTH_METHODS.map((a) => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </select>
          </div>
          {authMethod !== 'none' && (
            <div className="flex-1">
              <SectionLabel>Auth Token</SectionLabel>
              <input
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                className="input w-full font-mono text-xs"
                placeholder="Token or API key..."
              />
            </div>
          )}
        </div>

        {/* Capabilities */}
        <div>
          <SectionLabel>Capabilities</SectionLabel>
          <div className="flex items-center gap-4 mt-1">
            {(['observation', 'messaging', 'lifecycle'] as const).map((cap) => (
              <label key={cap} className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={capabilities[cap]}
                  onChange={(e) => setCapabilities({ ...capabilities, [cap]: e.target.checked })}
                  className="rounded"
                />
                <span className="capitalize">{cap}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={connectMutation.isPending || !name.trim() || !endpoint.trim()}
            className="btn btn-primary flex items-center gap-1.5 text-xs"
          >
            {connectMutation.isPending ? <LoadingSpinner size="sm" /> : <Link2 className="w-3 h-3" />}
            Connect
          </button>
          <button type="button" onClick={onClose} className="btn btn-ghost text-xs">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// =============================================================================
// Swarm Cards
// =============================================================================

function HostedSwarmCard({ swarm }: { swarm: HostedSwarm }) {
  const [showLogs, setShowLogs] = useState(false);
  const stopMutation = useStopSwarm();
  const restartMutation = useRestartSwarm();
  const removeMutation = useRemoveSwarm();
  const { data: logs } = useSwarmLogs(showLogs ? swarm.id : null);

  const canStop = swarm.state === 'running' || swarm.state === 'unhealthy' || swarm.state === 'starting';
  const canRestart = swarm.state === 'stopped' || swarm.state === 'failed';
  const canRemove = swarm.state === 'stopped' || swarm.state === 'failed';
  const isTransitioning = stopMutation.isPending || restartMutation.isPending || removeMutation.isPending;

  const handleStop = async () => {
    try {
      await stopMutation.mutateAsync(swarm.id);
      toast.success('Swarm stopped', `"${swarm.id}" has been stopped.`);
    } catch (err) {
      toast.error('Stop failed', (err as Error).message);
    }
  };

  const handleRestart = async () => {
    try {
      await restartMutation.mutateAsync(swarm.id);
      toast.success('Swarm restarted', `"${swarm.id}" is restarting.`);
    } catch (err) {
      toast.error('Restart failed', (err as Error).message);
    }
  };

  const handleRemove = async () => {
    try {
      await removeMutation.mutateAsync(swarm.id);
      toast.success('Swarm removed', `"${swarm.id}" has been removed.`);
    } catch (err) {
      toast.error('Remove failed', (err as Error).message);
    }
  };

  return (
    <div className="card px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div
          className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
          style={{ backgroundColor: 'var(--color-accent-bg)' }}
        >
          <Cpu className="w-4 h-4 text-honey-500" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{swarm.id}</span>
            <HostedStateBadge state={swarm.state} />
            <span className="text-2xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
              {swarm.provider}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            {swarm.assigned_port && <span>:{swarm.assigned_port}</span>}
            {swarm.endpoint && (
              <>
                <span className="opacity-30">&middot;</span>
                <span className="truncate max-w-[200px] font-mono">{swarm.endpoint}</span>
              </>
            )}
            <span className="opacity-30">&middot;</span>
            <TimeAgo date={swarm.created_at} />
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {canStop && (
            <button
              onClick={handleStop}
              disabled={isTransitioning}
              className="btn btn-ghost p-1.5 text-red-400 hover:bg-red-500/10"
              title="Stop"
            >
              {stopMutation.isPending ? <LoadingSpinner size="sm" /> : <Square className="w-3 h-3" />}
            </button>
          )}
          {canRestart && (
            <button
              onClick={handleRestart}
              disabled={isTransitioning}
              className="btn btn-ghost p-1.5 hover:bg-emerald-500/10"
              style={{ color: 'var(--color-text-secondary)' }}
              title="Restart"
            >
              {restartMutation.isPending ? <LoadingSpinner size="sm" /> : <RotateCw className="w-3 h-3" />}
            </button>
          )}
          {canRemove && (
            <button
              onClick={handleRemove}
              disabled={isTransitioning}
              className="btn btn-ghost p-1.5 text-red-400 hover:bg-red-500/10"
              title="Remove"
            >
              {removeMutation.isPending ? <LoadingSpinner size="sm" /> : <Trash2 className="w-3 h-3" />}
            </button>
          )}
          <button
            onClick={() => setShowLogs(!showLogs)}
            className={clsx('btn btn-ghost p-1.5', showLogs ? 'text-honey-500' : '')}
            style={!showLogs ? { color: 'var(--color-text-secondary)' } : undefined}
            title="Toggle logs"
          >
            <Terminal className="w-3 h-3" />
          </button>
        </div>
      </div>

      {swarm.error && (
        <div className="mt-2 px-2 py-1.5 bg-red-500/10 border border-red-500/20 rounded text-2xs text-red-400">
          {swarm.error}
        </div>
      )}

      {showLogs && (
        <div className="mt-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Logs</span>
            <button onClick={() => setShowLogs(false)} className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
              <ChevronUp className="w-3 h-3" />
            </button>
          </div>
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

function MapSwarmCard({ swarm }: { swarm: MapSwarm }) {
  return (
    <div className="card px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div
          className="w-8 h-8 rounded-md flex items-center justify-center shrink-0"
          style={{ backgroundColor: 'var(--color-accent-bg)' }}
        >
          <Globe className="w-4 h-4 text-honey-500" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{swarm.name}</span>
            <MapStatusBadge status={swarm.status} />
            <span className="text-2xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}>
              {swarm.map_transport}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <span className="truncate max-w-[250px] font-mono">{swarm.map_endpoint}</span>
            {swarm.agent_count > 0 && (
              <>
                <span className="opacity-30">&middot;</span>
                <span>{swarm.agent_count} agent{swarm.agent_count !== 1 ? 's' : ''}</span>
              </>
            )}
            {swarm.hives.length > 0 && (
              <>
                <span className="opacity-30">&middot;</span>
                <span>{swarm.hives.join(', ')}</span>
              </>
            )}
            <span className="opacity-30">&middot;</span>
            <TimeAgo date={swarm.created_at} />
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {swarm.status === 'online' ? (
            <Wifi className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <WifiOff className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
          )}
        </div>
      </div>

      {swarm.description && (
        <p className="mt-1.5 text-xs pl-11" style={{ color: 'var(--color-text-secondary)' }}>
          {swarm.description}
        </p>
      )}

      {/* Capabilities */}
      {swarm.capabilities && Object.keys(swarm.capabilities).length > 0 && (
        <div className="mt-1.5 pl-11 flex items-center gap-1.5">
          {Object.entries(swarm.capabilities)
            .filter(([, v]) => v === true)
            .map(([key]) => (
              <span
                key={key}
                className="text-2xs px-1.5 py-0.5 rounded capitalize"
                style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
              >
                {key}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Main Page
// =============================================================================

type Tab = 'hosted' | 'registered';
type FormMode = 'none' | 'spawn' | 'connect';

export function Swarms() {
  const { data: hostedSwarms, isLoading: hostedLoading } = useHostedSwarms();
  const { data: mapSwarms, isLoading: mapLoading } = useMapSwarms();
  const [activeTab, setActiveTab] = useState<Tab>('hosted');
  const [formMode, setFormMode] = useState<FormMode>('none');

  const isLoading = activeTab === 'hosted' ? hostedLoading : mapLoading;

  const tabs: { id: Tab; label: string; icon: React.ElementType; count?: number }[] = [
    { id: 'hosted', label: 'Hosted', icon: Cpu, count: hostedSwarms?.length },
    { id: 'registered', label: 'Registered', icon: Globe, count: mapSwarms?.length },
  ];

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-lg font-semibold">Swarms</h1>
        {formMode === 'none' && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setFormMode('spawn')}
              className="btn btn-primary flex items-center gap-1.5 text-xs"
            >
              <Plus className="w-3 h-3" />
              Spawn
            </button>
            <button
              onClick={() => setFormMode('connect')}
              className="btn btn-secondary flex items-center gap-1.5 text-xs"
            >
              <Link2 className="w-3 h-3" />
              Connect
            </button>
          </div>
        )}
      </div>

      {/* Forms */}
      {formMode === 'spawn' && <SpawnForm onClose={() => setFormMode('none')} />}
      {formMode === 'connect' && <ConnectForm onClose={() => setFormMode('none')} />}

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-3">
        {tabs.map(({ id, label, icon: Icon, count }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors',
              activeTab === id
                ? 'bg-honey-500/10 text-honey-500'
                : 'hover:bg-workspace-hover'
            )}
            style={activeTab !== id ? { color: 'var(--color-text-secondary)' } : undefined}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
            {count !== undefined && (
              <span
                className="text-2xs ml-0.5 px-1 py-0 rounded-full"
                style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
              >
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <PageLoader />
      ) : activeTab === 'hosted' ? (
        hostedSwarms && hostedSwarms.length > 0 ? (
          <div className="space-y-1">
            {hostedSwarms.map((swarm) => (
              <HostedSwarmCard key={swarm.id} swarm={swarm} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Cpu}
            message="No hosted swarms"
            action={formMode === 'none' ? () => setFormMode('spawn') : undefined}
            actionLabel="Spawn your first swarm"
          />
        )
      ) : (
        mapSwarms && mapSwarms.length > 0 ? (
          <div className="space-y-1">
            {mapSwarms.map((swarm) => (
              <MapSwarmCard key={swarm.id} swarm={swarm} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={Globe}
            message="No registered swarms"
            action={formMode === 'none' ? () => setFormMode('connect') : undefined}
            actionLabel="Connect an external swarm"
          />
        )
      )}
    </div>
  );
}

function EmptyState({ icon: Icon, message, action, actionLabel }: {
  icon: React.ElementType;
  message: string;
  action?: () => void;
  actionLabel?: string;
}) {
  return (
    <div className="py-8 text-center">
      <Icon className="w-8 h-8 mx-auto mb-2 opacity-20" style={{ color: 'var(--color-text-muted)' }} />
      <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{message}</p>
      {action && actionLabel && (
        <button
          onClick={action}
          className="mt-2 text-xs text-honey-500 hover:text-honey-400 transition-colors"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
