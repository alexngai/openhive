import { useState } from 'react';
import {
  Plus, Trash2, Pencil, X, Bell, Radio, FileText,
  ChevronDown, ChevronUp, Settings2, Check, XCircle,
} from 'lucide-react';
import {
  usePostRules, useCreatePostRule, useUpdatePostRule, useDeletePostRule,
  useEventSubscriptions, useCreateSubscription, useUpdateSubscription, useDeleteSubscription,
  useDeliveryLog, useHives, useMapSwarms,
} from '../hooks/useApi';
import type { PostRule, EventSubscription } from '../lib/api';
import { PageLoader, LoadingSpinner } from '../components/common/LoadingSpinner';
import { toast } from '../stores/toast';
import clsx from 'clsx';

// =============================================================================
// Shared
// =============================================================================

type Tab = 'rules' | 'subscriptions' | 'log';
type FormMode = 'none' | 'create-rule' | 'edit-rule' | 'create-sub' | 'edit-sub';

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

function SourceBadge({ source }: { source: string }) {
  const colors: Record<string, string> = {
    github: 'bg-purple-500/15 text-purple-400',
    slack: 'bg-green-500/15 text-green-400',
    '*': 'bg-blue-500/15 text-blue-400',
  };
  return (
    <span className={clsx('text-2xs px-1.5 py-0.5 rounded font-medium', colors[source] || 'bg-gray-500/15 text-gray-400')}>
      {source === '*' ? 'all' : source}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    sent: 'bg-green-500/15 text-green-400',
    offline: 'bg-yellow-500/15 text-yellow-400',
    failed: 'bg-red-500/15 text-red-400',
  };
  return (
    <span className={clsx('text-2xs px-1.5 py-0.5 rounded font-medium', styles[status] || '')}>
      {status}
    </span>
  );
}

function EnabledDot({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={clsx('w-2 h-2 rounded-full shrink-0', enabled ? 'bg-green-400' : 'bg-gray-500')}
      title={enabled ? 'Enabled' : 'Disabled'}
    />
  );
}

// =============================================================================
// Post Rule Form
// =============================================================================

function PostRuleForm({
  mode,
  rule,
  onClose,
}: {
  mode: 'create-rule' | 'edit-rule';
  rule?: PostRule;
  onClose: () => void;
}) {
  const { data: hives } = useHives({ sort: 'popular', limit: 50 });
  const createMutation = useCreatePostRule();
  const updateMutation = useUpdatePostRule();

  const [hiveId, setHiveId] = useState(rule?.hive_id || '');
  const [source, setSource] = useState(rule?.source || 'github');
  const [eventTypesRaw, setEventTypesRaw] = useState(rule?.event_types.join(', ') || '');
  const [threadMode, setThreadMode] = useState(rule?.thread_mode || 'post_per_event');
  const [priority, setPriority] = useState(rule?.priority ?? 100);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [filtersRaw, setFiltersRaw] = useState(
    rule?.filters ? JSON.stringify(rule.filters, null, 2) : '',
  );

  const isPending = createMutation.isPending || updateMutation.isPending;

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
      if (mode === 'create-rule') {
        await createMutation.mutateAsync({
          hive_id: hiveId,
          source,
          event_types: eventTypes,
          thread_mode: threadMode as any,
          priority,
          filters,
        });
        toast.success('Rule created', 'Post rule has been created');
      } else if (rule) {
        await updateMutation.mutateAsync({
          id: rule.id,
          source,
          event_types: eventTypes,
          thread_mode: threadMode as any,
          priority,
          filters: filtersRaw.trim() ? filters : null,
        });
        toast.success('Rule updated', 'Post rule has been updated');
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
          <FileText className="w-3.5 h-3.5 text-honey-500" />
          {mode === 'create-rule' ? 'New Post Rule' : 'Edit Post Rule'}
        </h2>
        <button onClick={onClose} className="btn btn-ghost p-1">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <SectionLabel>Hive <span className="text-red-400">*</span></SectionLabel>
            <select
              value={hiveId}
              onChange={(e) => setHiveId(e.target.value)}
              className="input w-full"
              required
              disabled={mode === 'edit-rule'}
            >
              <option value="">Select hive...</option>
              {hives?.map((h) => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
          </div>
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
        </div>

        <div>
          <SectionLabel>Event Types <span className="text-red-400">*</span></SectionLabel>
          <input
            type="text"
            value={eventTypesRaw}
            onChange={(e) => setEventTypesRaw(e.target.value)}
            className="input w-full"
            placeholder="push, pull_request.opened, issues.*"
            required
          />
          <p className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            Comma-separated. Use * for all events.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <SectionLabel>Thread Mode</SectionLabel>
            <select
              value={threadMode}
              onChange={(e) => setThreadMode(e.target.value)}
              className="input w-full"
            >
              <option value="post_per_event">Post per event</option>
              <option value="single_thread">Single thread</option>
              <option value="skip">Skip (MAP only)</option>
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
              placeholder='{"repos": ["org/repo"], "branches": ["main"]}'
            />
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={isPending || !hiveId || !eventTypesRaw.trim()}
            className="btn btn-primary flex items-center gap-1.5 text-xs"
          >
            {isPending ? <LoadingSpinner size="sm" /> : mode === 'create-rule' ? <Plus className="w-3 h-3" /> : <Check className="w-3 h-3" />}
            {mode === 'create-rule' ? 'Create' : 'Save'}
          </button>
          <button type="button" onClick={onClose} className="btn btn-ghost text-xs">Cancel</button>
        </div>
      </form>
    </div>
  );
}

// =============================================================================
// Post Rule Card
// =============================================================================

function PostRuleCard({
  rule,
  hives,
  onEdit,
}: {
  rule: PostRule;
  hives?: Array<{ id: string; name: string }>;
  onEdit: () => void;
}) {
  const deleteMutation = useDeletePostRule();
  const updateMutation = useUpdatePostRule();
  const hiveName = hives?.find((h) => h.id === rule.hive_id)?.name || rule.hive_id;

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(rule.id);
      toast.success('Rule deleted', 'Post rule has been removed');
    } catch (err) {
      toast.error('Delete failed', (err as Error).message);
    }
  };

  const handleToggle = async () => {
    try {
      await updateMutation.mutateAsync({ id: rule.id, enabled: !rule.enabled });
    } catch (err) {
      toast.error('Update failed', (err as Error).message);
    }
  };

  const isTransitioning = deleteMutation.isPending || updateMutation.isPending;

  return (
    <div className="card px-3 py-2.5">
      <div className="flex items-center gap-3">
        <EnabledDot enabled={rule.enabled} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <SourceBadge source={rule.source} />
            <span className="text-xs font-medium truncate">
              {rule.event_types.join(', ')}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            <span>#{hiveName}</span>
            <span>p:{rule.priority}</span>
            {rule.thread_mode !== 'post_per_event' && (
              <span className="text-2xs px-1 py-0 rounded" style={{ backgroundColor: 'var(--color-elevated)' }}>
                {rule.thread_mode}
              </span>
            )}
            {rule.filters && <span>filtered</span>}
            {rule.created_by && <span>by {rule.created_by}</span>}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleToggle}
            disabled={isTransitioning}
            className="btn btn-ghost p-1.5"
            title={rule.enabled ? 'Disable' : 'Enable'}
          >
            {rule.enabled ? <Check className="w-3 h-3 text-green-400" /> : <XCircle className="w-3 h-3" />}
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
  const { data: rules, isLoading: rulesLoading } = usePostRules();
  const { data: subs, isLoading: subsLoading } = useEventSubscriptions();
  const { data: hives } = useHives({ sort: 'popular', limit: 50 });
  const { data: swarms } = useMapSwarms();

  const [activeTab, setActiveTab] = useState<Tab>('rules');
  const [formMode, setFormMode] = useState<FormMode>('none');
  const [editingRule, setEditingRule] = useState<PostRule | undefined>();
  const [editingSub, setEditingSub] = useState<EventSubscription | undefined>();

  const tabs: { id: Tab; label: string; icon: React.ElementType; count?: number }[] = [
    { id: 'rules', label: 'Post Rules', icon: FileText, count: rules?.length },
    { id: 'subscriptions', label: 'Subscriptions', icon: Radio, count: subs?.length },
    { id: 'log', label: 'Delivery Log', icon: Bell },
  ];

  const handleNewClick = () => {
    if (activeTab === 'rules') {
      setFormMode('create-rule');
      setEditingRule(undefined);
    } else if (activeTab === 'subscriptions') {
      setFormMode('create-sub');
      setEditingSub(undefined);
    }
  };

  const closeForm = () => {
    setFormMode('none');
    setEditingRule(undefined);
    setEditingSub(undefined);
  };

  const isLoading = activeTab === 'rules' ? rulesLoading : activeTab === 'subscriptions' ? subsLoading : false;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-lg font-semibold">Events</h1>
        {formMode === 'none' && activeTab !== 'log' && (
          <button
            onClick={handleNewClick}
            className="btn btn-primary flex items-center gap-1.5 text-xs"
          >
            <Plus className="w-3 h-3" />
            New {activeTab === 'rules' ? 'Rule' : 'Subscription'}
          </button>
        )}
      </div>

      {/* Forms */}
      {(formMode === 'create-rule' || formMode === 'edit-rule') && (
        <PostRuleForm mode={formMode} rule={editingRule} onClose={closeForm} />
      )}
      {(formMode === 'create-sub' || formMode === 'edit-sub') && (
        <SubscriptionForm mode={formMode} sub={editingSub} onClose={closeForm} />
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-3">
        {tabs.map(({ id, label, icon: Icon, count }) => (
          <button
            key={id}
            onClick={() => { setActiveTab(id); closeForm(); }}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors',
              activeTab === id
                ? 'bg-honey-500/10 text-honey-500'
                : 'hover:bg-workspace-hover',
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
      ) : activeTab === 'rules' ? (
        rules && rules.length > 0 ? (
          <div className="space-y-1">
            {rules.map((rule) => (
              <PostRuleCard
                key={rule.id}
                rule={rule}
                hives={hives}
                onEdit={() => {
                  setEditingRule(rule);
                  setFormMode('edit-rule');
                }}
              />
            ))}
          </div>
        ) : (
          <div className="py-8 text-center">
            <FileText className="w-8 h-8 mx-auto mb-2 opacity-20" style={{ color: 'var(--color-text-muted)' }} />
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>No post rules configured</p>
            <button
              onClick={() => { setFormMode('create-rule'); setEditingRule(undefined); }}
              className="mt-2 text-xs text-honey-500 hover:text-honey-400 transition-colors"
            >
              Create your first rule
            </button>
          </div>
        )
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
      ) : (
        <DeliveryLogView />
      )}
    </div>
  );
}
