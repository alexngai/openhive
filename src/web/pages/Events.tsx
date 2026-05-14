import { useCallback, useRef, useState } from 'react';
import {
  Plus, Trash2, Pencil, X, Bell, Radio, Activity, Pause, PlayCircle, Trash,
  ChevronDown, ChevronUp, Settings2, Check, XCircle,
  GitCommit, GitPullRequest, CircleDot, Github, MessageSquare, Play,
} from 'lucide-react';
import {
  useEventSubscriptions, useCreateSubscription, useUpdateSubscription, useDeleteSubscription,
  useDeliveryLog, useHives, useMapSwarms,
} from '../hooks/useApi';
import { useSwarmRealtime } from '../hooks/useRealtimeInvalidation';
import { useSubscribe, useWSEvent } from '../hooks/useWebSocket';
import type { EventSubscription } from '../lib/api';
import { PageLoader, LoadingSpinner } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import { Tabs, type TabDef } from '../components/common/Tabs';
import { StatusChip, type StatusTone } from '../components/common/StatusChip';
import { toast } from '../stores/toast';
import clsx from 'clsx';

// =============================================================================
// Shared
// =============================================================================

type Tab = 'subscriptions' | 'log' | 'live';
type FormMode = 'none' | 'create-sub' | 'edit-sub';

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <label
      className="block text-xs font-medium mb-1"
      style={{ color: 'var(--color-text-secondary)' }}
    >
      {children}
    </label>
  );
}

const SOURCE_TONE: Record<string, StatusTone> = {
  github:  'accent',
  slack:   'success',
  '*':     'info',
};

function SourceBadge({ source }: { source: string }) {
  return (
    <StatusChip
      label={source === '*' ? 'all' : source}
      tone={SOURCE_TONE[source] ?? 'neutral'}
      size="sm"
      shape="square"
    />
  );
}

const DELIVERY_TONE: Record<string, StatusTone> = {
  sent:    'success',
  offline: 'warning',
  failed:  'danger',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <StatusChip
      label={status}
      tone={DELIVERY_TONE[status] ?? 'neutral'}
      size="sm"
      shape="square"
    />
  );
}

function EnabledDot({ enabled }: { enabled: boolean }) {
  return (
    <span
      className="w-2 h-2 rounded-full shrink-0"
      style={{ backgroundColor: enabled ? '#22c55e' : 'var(--color-text-muted)' }}
      title={enabled ? 'Enabled' : 'Disabled'}
    />
  );
}

// =============================================================================
// Presets
// =============================================================================

interface Preset {
  label: string;
  icon: React.ElementType;
  source: string;
  event_types: string;
  thread_mode?: string;
}

const SUBSCRIPTION_PRESETS: Preset[] = [
  { label: 'GitHub Code', icon: GitCommit, source: 'github', event_types: 'push' },
  { label: 'GitHub PRs', icon: GitPullRequest, source: 'github', event_types: 'pull_request.*' },
  { label: 'GitHub Issues', icon: CircleDot, source: 'github', event_types: 'issues.*' },
  { label: 'GitHub CI', icon: Play, source: 'github', event_types: 'check_run.*, check_suite.*, workflow_run.*' },
  { label: 'GitHub All', icon: Github, source: 'github', event_types: '*' },
  { label: 'Slack Messages', icon: MessageSquare, source: 'slack', event_types: 'message' },
];

function PresetPicker({
  presets,
  selected,
  onSelect,
}: {
  presets: Preset[];
  selected: string | null;
  onSelect: (preset: Preset | null) => void;
}) {
  return (
    <div className="mb-3">
      <SectionLabel>Quick Setup</SectionLabel>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => onSelect(p)}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-2xs font-medium transition-colors border',
              selected === p.label
                ? 'border-honey-500/50 bg-honey-500/10 text-honey-500'
                : 'border-transparent hover:bg-workspace-hover',
            )}
            style={selected !== p.label ? { color: 'var(--color-text-secondary)', backgroundColor: 'var(--color-elevated)' } : undefined}
          >
            <p.icon className="w-3 h-3" />
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={clsx(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-2xs font-medium transition-colors border',
            selected === 'custom'
              ? 'border-honey-500/50 bg-honey-500/10 text-honey-500'
              : 'border-transparent hover:bg-workspace-hover',
          )}
          style={selected !== 'custom' ? { color: 'var(--color-text-secondary)', backgroundColor: 'var(--color-elevated)' } : undefined}
        >
          <Settings2 className="w-3 h-3" />
          Custom
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Subscription Form
// =============================================================================

function SubscriptionForm({
  mode,
  sub,
  onClose,
}: {
  mode: 'create-sub' | 'edit-sub';
  sub?: EventSubscription;
  onClose: () => void;
}) {
  const { data: hives } = useHives({ sort: 'popular', limit: 50 });
  const { data: swarms } = useMapSwarms();
  const createMutation = useCreateSubscription();
  const updateMutation = useUpdateSubscription();

  const [selectedPreset, setSelectedPreset] = useState<string | null>(mode === 'create-sub' ? null : null);
  const [hiveId, setHiveId] = useState(sub?.hive_id || '');
  const [swarmId, setSwarmId] = useState(sub?.swarm_id || '');
  const [source, setSource] = useState(sub?.source || 'github');
  const [eventTypesRaw, setEventTypesRaw] = useState(sub?.event_types.join(', ') || '');
  const [priority, setPriority] = useState(sub?.priority ?? 100);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [filtersRaw, setFiltersRaw] = useState(
    sub?.filters ? JSON.stringify(sub.filters, null, 2) : '',
  );

  const isPending = createMutation.isPending || updateMutation.isPending;

  const handlePresetSelect = (preset: Preset | null) => {
    if (preset) {
      setSelectedPreset(preset.label);
      setSource(preset.source);
      setEventTypesRaw(preset.event_types);
    } else {
      setSelectedPreset('custom');
      setSource('github');
      setEventTypesRaw('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const eventTypes = eventTypesRaw.split(',').map((s) => s.trim()).filter(Boolean);
    if (eventTypes.length === 0) {
      toast.error('Validation', 'At least one event type is required');
      return;
    }

    let filters = undefined;
    if (filtersRaw.trim()) {
      try {
        filters = JSON.parse(filtersRaw);
      } catch {
        toast.error('Invalid JSON', 'Filters must be valid JSON');
        return;
      }
    }

    try {
      if (mode === 'create-sub') {
        await createMutation.mutateAsync({
          hive_id: hiveId,
          swarm_id: swarmId || undefined,
          source,
          event_types: eventTypes,
          priority,
          filters,
        });
        toast.success('Subscription created', 'Event subscription has been created');
      } else if (sub) {
        await updateMutation.mutateAsync({
          id: sub.id,
          source,
          event_types: eventTypes,
          priority,
          filters: filtersRaw.trim() ? filters : null,
        });
        toast.success('Subscription updated', 'Event subscription has been updated');
      }
      onClose();
    } catch (err) {
      toast.error('Failed', (err as Error).message);
    }
  };

  return (
    <div className="card p-4 mb-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold flex items-center gap-1.5">
          <Radio className="w-3.5 h-3.5 text-honey-500" />
          {mode === 'create-sub' ? 'New Subscription' : 'Edit Subscription'}
        </h2>
        <button onClick={onClose} className="btn btn-ghost p-1">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {mode === 'create-sub' && (
        <PresetPicker
          presets={SUBSCRIPTION_PRESETS}
          selected={selectedPreset}
          onSelect={handlePresetSelect}
        />
      )}

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <SectionLabel>Hive <span className="text-red-400">*</span></SectionLabel>
            <select
              value={hiveId}
              onChange={(e) => setHiveId(e.target.value)}
              className="input w-full"
              required
              disabled={mode === 'edit-sub'}
            >
              <option value="">Select hive...</option>
              {hives?.map((h) => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
          </div>
          <div>
            <SectionLabel>Swarm</SectionLabel>
            <select
              value={swarmId}
              onChange={(e) => setSwarmId(e.target.value)}
              className="input w-full"
              disabled={mode === 'edit-sub'}
            >
              <option value="">All swarms (hive default)</option>
              {swarms?.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <p className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              Leave empty to broadcast to all swarms in the hive.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <SectionLabel>Source <span className="text-red-400">*</span></SectionLabel>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="input w-full"
            >
              <option value="github">github</option>
              <option value="slack">slack</option>
              <option value="*">* (all sources)</option>
            </select>
          </div>
          <div>
            <SectionLabel>Priority</SectionLabel>
            <input
              type="number"
              value={priority}
              onChange={(e) => setPriority(parseInt(e.target.value, 10) || 100)}
              className="input w-full"
              min={0}
              max={1000}
            />
          </div>
        </div>

        <div>
          <SectionLabel>Event Types <span className="text-red-400">*</span></SectionLabel>
          <input
            type="text"
            value={eventTypesRaw}
            onChange={(e) => setEventTypesRaw(e.target.value)}
            className="input w-full"
            placeholder="push, pull_request.*, issues.opened"
            required
          />
          <p className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            Comma-separated. Supports glob patterns (e.g., pull_request.*).
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1 text-2xs font-medium transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <Settings2 className="w-3 h-3" />
          Filters
          {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>

        {showAdvanced && (
          <div className="pl-3 border-l-2" style={{ borderColor: 'var(--color-border-subtle)' }}>
            <SectionLabel>Filters (JSON)</SectionLabel>
            <textarea
              value={filtersRaw}
              onChange={(e) => setFiltersRaw(e.target.value)}
              className="input w-full font-mono text-2xs min-h-[60px] resize-y"
              placeholder='{"repos": ["org/repo"], "channels": ["C_GENERAL"]}'
            />
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={isPending || !hiveId || !eventTypesRaw.trim()}
            className="btn btn-primary flex items-center gap-1.5 text-xs"
          >
            {isPending ? <LoadingSpinner size="sm" /> : mode === 'create-sub' ? <Plus className="w-3 h-3" /> : <Check className="w-3 h-3" />}
            {mode === 'create-sub' ? 'Create' : 'Save'}
          </button>
          <button type="button" onClick={onClose} className="btn btn-ghost text-xs">Cancel</button>
        </div>
      </form>
    </div>
  );
}

// =============================================================================
// Subscription Card
// =============================================================================

function SubscriptionCard({
  sub,
  hives,
  swarms,
  onEdit,
}: {
  sub: EventSubscription;
  hives?: Array<{ id: string; name: string }>;
  swarms?: Array<{ id: string; name: string }>;
  onEdit: () => void;
}) {
  const deleteMutation = useDeleteSubscription();
  const updateMutation = useUpdateSubscription();
  const hiveName = hives?.find((h) => h.id === sub.hive_id)?.name || sub.hive_id;
  const swarmName = sub.swarm_id
    ? swarms?.find((s) => s.id === sub.swarm_id)?.name || sub.swarm_id
    : 'All swarms';

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(sub.id);
      toast.success('Subscription deleted', 'Event subscription has been removed');
    } catch (err) {
      toast.error('Delete failed', (err as Error).message);
    }
  };

  const handleToggle = async () => {
    try {
      await updateMutation.mutateAsync({ id: sub.id, enabled: !sub.enabled });
    } catch (err) {
      toast.error('Update failed', (err as Error).message);
    }
  };

  const isTransitioning = deleteMutation.isPending || updateMutation.isPending;

  return (
    <div className="card px-3 py-2.5">
      <div className="flex items-center gap-3">
        <EnabledDot enabled={sub.enabled} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <SourceBadge source={sub.source} />
            <span className="text-xs font-medium truncate">
              {sub.event_types.join(', ')}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <span>#{hiveName}</span>
            <span>{swarmName}</span>
            <span>p:{sub.priority}</span>
            {sub.filters && <span>filtered</span>}
            {sub.created_by && <span>by {sub.created_by}</span>}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleToggle}
            disabled={isTransitioning}
            className="btn btn-ghost p-1.5"
            title={sub.enabled ? 'Disable' : 'Enable'}
          >
            {sub.enabled ? <Check className="w-3 h-3 text-green-400" /> : <XCircle className="w-3 h-3" />}
          </button>
          <button onClick={onEdit} className="btn btn-ghost p-1.5" title="Edit">
            <Pencil className="w-3 h-3" />
          </button>
          <button
            onClick={handleDelete}
            disabled={isTransitioning}
            className="btn btn-ghost p-1.5 text-red-400 hover:bg-red-500/10"
            title="Delete"
          >
            {deleteMutation.isPending ? <LoadingSpinner size="sm" /> : <Trash2 className="w-3 h-3" />}
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Delivery Log View
// =============================================================================

function DeliveryLogView() {
  const [swarmFilter, setSwarmFilter] = useState('');
  const [deliveryFilter, setDeliveryFilter] = useState('');
  const [limit] = useState(50);
  const [offset, setOffset] = useState(0);

  const { data, isLoading } = useDeliveryLog({
    swarm_id: swarmFilter || undefined,
    delivery_id: deliveryFilter || undefined,
    limit,
    offset,
  });

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <input
          type="text"
          value={swarmFilter}
          onChange={(e) => { setSwarmFilter(e.target.value); setOffset(0); }}
          className="input text-xs"
          placeholder="Filter by swarm ID..."
          style={{ width: 200 }}
        />
        <input
          type="text"
          value={deliveryFilter}
          onChange={(e) => { setDeliveryFilter(e.target.value); setOffset(0); }}
          className="input text-xs"
          placeholder="Filter by delivery ID..."
          style={{ width: 200 }}
        />
        {data && (
          <span className="text-2xs ml-auto" style={{ color: 'var(--color-text-muted)' }}>
            {data.total} total
          </span>
        )}
      </div>

      {isLoading ? (
        <PageLoader />
      ) : data?.data && data.data.length > 0 ? (
        <>
          <div className="space-y-1">
            {data.data.map((entry) => (
              <div key={entry.id} className="card px-3 py-2">
                <div className="flex items-center gap-3">
                  <StatusBadge status={entry.status} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <SourceBadge source={entry.source} />
                      <span className="font-medium">{entry.event_type}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                      <span>swarm: {entry.swarm_id}</span>
                      <span>delivery: {entry.delivery_id}</span>
                      {entry.error && <span className="text-red-400">{entry.error}</span>}
                    </div>
                  </div>
                  <span className="text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                    {new Date(entry.created_at).toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {data.total > limit && (
            <div className="flex items-center justify-center gap-2 mt-3">
              <button
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0}
                className="btn btn-ghost text-xs"
              >
                Previous
              </button>
              <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                {offset + 1}–{Math.min(offset + limit, data.total)} of {data.total}
              </span>
              <button
                onClick={() => setOffset(offset + limit)}
                disabled={offset + limit >= data.total}
                className="btn btn-ghost text-xs"
              >
                Next
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="py-8 text-center">
          <Bell className="w-8 h-8 mx-auto mb-2 opacity-20" style={{ color: 'var(--color-text-muted)' }} />
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>No deliveries recorded</p>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Main Page
// =============================================================================

export function Events() {
  const { data: subs, isLoading: subsLoading } = useEventSubscriptions();
  const { data: hives } = useHives({ sort: 'popular', limit: 50 });
  const { data: swarms } = useMapSwarms();
  useSwarmRealtime();

  const [activeTab, setActiveTab] = useState<Tab>('subscriptions');
  const [formMode, setFormMode] = useState<FormMode>('none');
  const [editingSub, setEditingSub] = useState<EventSubscription | undefined>();

  const tabs: TabDef<Tab>[] = [
    {
      id: 'subscriptions',
      label: 'Subscriptions',
      icon: Radio,
      badge: subs?.length != null ? (
        <span
          className="text-2xs px-1 py-0 rounded-full"
          style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)' }}
        >
          {subs.length}
        </span>
      ) : undefined,
    },
    { id: 'log', label: 'Delivery Log', icon: Bell },
    { id: 'live', label: 'Live', icon: Activity },
  ];

  const closeForm = () => {
    setFormMode('none');
    setEditingSub(undefined);
  };

  const isLoading = activeTab === 'subscriptions' ? subsLoading : false;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-lg font-semibold">Events</h1>
        {formMode === 'none' && activeTab === 'subscriptions' && (
          <button
            onClick={() => { setFormMode('create-sub'); setEditingSub(undefined); }}
            className="btn btn-primary flex items-center gap-1.5 text-xs"
          >
            <Plus className="w-3 h-3" />
            New Subscription
          </button>
        )}
      </div>

      {/* Form */}
      {(formMode === 'create-sub' || formMode === 'edit-sub') && (
        <SubscriptionForm mode={formMode} sub={editingSub} onClose={closeForm} />
      )}

      {/* Tabs */}
      <Tabs
        tabs={tabs}
        activeId={activeTab}
        onChange={(id) => { setActiveTab(id); closeForm(); }}
        variant="pill"
        className="mb-3"
      />

      {/* Content */}
      {isLoading ? (
        <PageLoader />
      ) : activeTab === 'subscriptions' ? (
        subs && subs.length > 0 ? (
          <div className="space-y-1">
            {subs.map((sub) => (
              <SubscriptionCard
                key={sub.id}
                sub={sub}
                hives={hives}
                swarms={swarms}
                onEdit={() => {
                  setEditingSub(sub);
                  setFormMode('edit-sub');
                }}
              />
            ))}
          </div>
        ) : (
          <div className="py-8 text-center">
            <Radio className="w-8 h-8 mx-auto mb-2 opacity-20" style={{ color: 'var(--color-text-muted)' }} />
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>No event subscriptions configured</p>
            <button
              onClick={() => { setFormMode('create-sub'); setEditingSub(undefined); }}
              className="mt-2 text-xs text-honey-500 hover:text-honey-400 transition-colors"
            >
              Create your first subscription
            </button>
          </div>
        )
      ) : activeTab === 'log' ? (
        <DeliveryLogView />
      ) : (
        <LiveStreamView />
      )}
    </div>
  );
}

// =============================================================================
// Live Stream View
// =============================================================================

/** Shape broadcast by the backend `routeEvent()` on the `events:live` channel. */
interface LiveEventEnvelope {
  received_at: string;
  event: {
    source: string;
    event_type: string;
    action?: string;
    delivery_id: string;
    metadata: Record<string, unknown>;
    raw_payload?: unknown;
  };
  matched_subs: number;
  deliveries: Array<{ swarm_id: string; status: string; error?: string }>;
}

const LIVE_BUFFER_LIMIT = 100;

function LiveStreamView() {
  // Subscribe to the live channel; refcounted so multiple openers don't leak.
  useSubscribe(['events:live']);

  const [events, setEvents] = useState<LiveEventEnvelope[]>([]);
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Pause guard via ref so the WS callback always sees the current value
  // (state inside the callback closure would be stale).
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const handleEvent = useCallback((raw: unknown) => {
    if (pausedRef.current) return;
    // The store unwraps the envelope so we get { received_at, event, ... } directly.
    const env = raw as LiveEventEnvelope | { data?: LiveEventEnvelope };
    const payload: LiveEventEnvelope = (env as { data?: LiveEventEnvelope }).data ?? (env as LiveEventEnvelope);
    if (!payload?.event) return;
    setEvents((prev) => [payload, ...prev].slice(0, LIVE_BUFFER_LIMIT));
  }, []);
  useWSEvent('events.received', handleEvent);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => setPaused(!paused)}
          className={clsx(
            'btn flex items-center gap-1.5 text-xs',
            paused ? 'btn-primary' : 'btn-ghost',
          )}
          title={paused ? 'Resume the stream' : 'Pause incoming events'}
        >
          {paused ? <PlayCircle className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          onClick={() => setEvents([])}
          disabled={events.length === 0}
          className="btn btn-ghost flex items-center gap-1.5 text-xs"
          title="Clear the buffer"
        >
          <Trash className="w-3.5 h-3.5" />
          Clear
        </button>
        <span className="text-2xs ml-auto" style={{ color: 'var(--color-text-muted)' }}>
          {events.length} / {LIVE_BUFFER_LIMIT}
          {paused && <span className="ml-2 text-amber-400">paused</span>}
        </span>
      </div>

      {events.length === 0 ? (
        <div className="py-8 text-center">
          <Activity className="w-8 h-8 mx-auto mb-2 opacity-20" style={{ color: 'var(--color-text-muted)' }} />
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Listening for events…
          </p>
          <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Inbound webhooks (matched or not) will appear here in real time.
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {events.map((env) => {
            const id = `${env.event.delivery_id}:${env.received_at}`;
            const isExpanded = expanded.has(id);
            const matchTone: StatusTone = env.matched_subs === 0 ? 'neutral' : 'success';
            return (
              <div key={id} className="card px-3 py-2">
                <button
                  onClick={() => toggleExpanded(id)}
                  className="w-full flex items-center gap-3 text-left"
                >
                  <SourceBadge source={env.event.source} />
                  <span className="text-xs font-medium truncate flex-1">
                    {env.event.event_type}
                    {env.event.action ? <span style={{ color: 'var(--color-text-muted)' }}>.{env.event.action}</span> : null}
                  </span>
                  <StatusChip
                    label={env.matched_subs === 0 ? 'no match' : `${env.matched_subs} matched`}
                    tone={matchTone}
                    size="sm"
                    shape="square"
                  />
                  <span className="text-2xs shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                    <TimeAgo date={env.received_at} />
                  </span>
                  {isExpanded
                    ? <ChevronUp className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
                    : <ChevronDown className="w-3 h-3 shrink-0" style={{ color: 'var(--color-text-muted)' }} />}
                </button>

                {isExpanded && (
                  <div className="mt-2 pt-2 border-t space-y-2" style={{ borderColor: 'var(--color-border-subtle)' }}>
                    {env.deliveries.length > 0 && (
                      <div>
                        <div className="text-2xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>
                          Deliveries
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {env.deliveries.map((d, i) => (
                            <StatusChip
                              key={`${d.swarm_id}-${i}`}
                              label={`${d.swarm_id}: ${d.status}`}
                              tone={d.status === 'sent' ? 'success' : d.status === 'offline' ? 'warning' : 'danger'}
                              size="sm"
                              shape="square"
                              title={d.error ?? undefined}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    <div>
                      <div className="text-2xs font-medium mb-1" style={{ color: 'var(--color-text-muted)' }}>
                        Payload
                      </div>
                      <pre
                        className="text-2xs font-mono p-2 rounded overflow-auto max-h-64"
                        style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-text-secondary)' }}
                      >
                        {JSON.stringify({ metadata: env.event.metadata, raw_payload: env.event.raw_payload }, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
