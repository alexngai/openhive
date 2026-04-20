import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Lock, Trash2, Sun, Moon, Monitor, Key, Plus, X, Copy, Eye, EyeOff, ShieldOff, Clock, Check, Server, Shield, Unlock, ChevronDown, ChevronRight, AlertTriangle, RefreshCw, Boxes, Globe, GitBranch } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../stores/auth';
import { useThemeStore } from '../stores/theme';
import { toast } from '../stores/toast';
import { api } from '../lib/api';
import { useSEO } from '../hooks/useDocumentTitle';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import { SwarmKitSettings } from './settings/SwarmKitSettings';
import { SwarmHubSettings } from './settings/SwarmHubSettings';
import { ConnectivityCard } from './settings/ConnectivityCard';
import { DispatchPolicyCard } from '../components/dispatch/DispatchPolicyCard';
import { Dialog } from '../components/common/Dialog';
import { useGitLog, useGitForceFetch, useGitPull as useGitPullHook, useGitPush as useGitPushHook, useUpdateResource } from '../hooks/useApi';
import { ArrowDownToLine, ArrowUpFromLine, RotateCcw, ExternalLink, Unlink } from 'lucide-react';
import clsx from 'clsx';

export function Settings() {
  const navigate = useNavigate();
  const { agent, isAuthenticated, logout } = useAuthStore();
  const [activeTab, setActiveTab] = useState<'profile' | 'display' | 'api-keys' | 'server' | 'swarmkit' | 'swarmhub'>('profile');

  useSEO({ title: 'Settings' });

  if (!isAuthenticated || !agent) {
    navigate('/login');
    return null;
  }

  const tabs = [
    { id: 'profile' as const, label: 'Profile', icon: User },
    { id: 'display' as const, label: 'Display', icon: Sun },
    { id: 'api-keys' as const, label: 'API Keys', icon: Key },
    { id: 'server' as const, label: 'Server', icon: Server },
    { id: 'swarmkit' as const, label: 'SwarmKit', icon: Boxes },
    { id: 'swarmhub' as const, label: 'SwarmHub', icon: Globe },
    { id: 'git-sync' as const, label: 'Git Sync', icon: GitBranch },
  ];

  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold mb-4">Settings</h1>

      <div className="flex gap-4">
        {/* Sidebar tabs */}
        <nav className="w-36 shrink-0">
          <ul className="space-y-0.5">
            {tabs.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  onClick={() => setActiveTab(id)}
                  className={clsx(
                    'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors',
                    activeTab === id
                      ? 'bg-honey-500/10 text-honey-500'
                      : 'hover:bg-workspace-hover'
                  )}
                  style={activeTab !== id ? { color: 'var(--color-text-secondary)' } : undefined}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Content */}
        <div className="flex-1">
          {activeTab === 'profile' && <ProfileSettings agent={agent} />}
          {activeTab === 'display' && <DisplaySettings />}
          {activeTab === 'api-keys' && <ApiKeysSettings />}
          {activeTab === 'server' && <ServerSettings isAdmin={!!agent.is_admin} />}
          {activeTab === 'swarmkit' && <SwarmKitSettings isAdmin={!!agent.is_admin} />}
          {activeTab === 'swarmhub' && <SwarmHubSettings />}
          {activeTab === 'git-sync' && <GitSyncSettings />}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Server Settings
// ═══════════════════════════════════════════════════════════════

interface FieldMetaInfo {
  label: string;
  description?: string;
  secret?: boolean;
  readOnly?: boolean;
  restartRequired?: boolean;
}

interface SectionMetaInfo {
  label: string;
  description: string;
  group: string;
  readOnly?: boolean;
  fields: Record<string, FieldMetaInfo>;
}

interface ServerConfigResponse {
  [key: string]: unknown;
  _meta: Record<string, SectionMetaInfo>;
  _editable?: boolean;
  _configFormat?: 'json' | 'js';
  restartRequired?: boolean;
}

const SECRET_SENTINEL = '********';

const GROUP_ORDER = ['general', 'swarms', 'integrations', 'networking', 'storage', 'resources'];
const GROUP_LABELS: Record<string, string> = {
  general: 'General',
  swarms: 'Swarms',
  integrations: 'Integrations',
  networking: 'Networking',
  storage: 'Storage',
  resources: 'Resources',
};

/** Known enum values for select dropdowns */
const ENUM_OPTIONS: Record<string, string[]> = {
  'mapHub.trustModel': ['open', 'verified'],
  'auth.mode': ['local', 'swarmhub'],
  'swarmHosting.default_provider': ['local', 'local-sandboxed', 'docker', 'fly', 'ssh', 'k8s'],
  'swarmcraft.logLevel': ['debug', 'info', 'warn', 'error'],
  'learning.atlas.creditStrategy': ['simple', 'causal'],
  'learning.atlas.embedding.provider': ['none', 'openai', 'voyage', 'local'],
  'learning.ingestion.mode': ['deferred'],
  'learning.compute.spawnProvider': ['local', 'sandboxed'],
  'learning.sync.conflictStrategy': ['merge', 'local-wins', 'remote-wins'],
  'learning.distributed.mode': ['local', 'centralized', 'domain-partitioned'],
  'network.provider': ['tailscale-cloud', 'headscale-sidecar', 'headscale-external', 'none'],
  'sync.discovery': ['hub', 'manual', 'both'],
  'sessions.type': ['local', 's3', 'none'],
  'resourceSync.defaultStrategy': ['metadata', 'local', 'ls-remote', 'mirror', 'bundle'],
  'resourceSync.localDiscoveryStrategy': ['metadata', 'local', 'ls-remote', 'mirror', 'bundle'],
};

function ServerSettings({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['general', 'swarms', 'integrations']));
  const [restartBanner, setRestartBanner] = useState(false);

  const { data: config, isLoading } = useQuery<ServerConfigResponse>({
    queryKey: ['server-config'],
    queryFn: () => api.get('/admin/config'),
  });

  const toggleGroup = useCallback((group: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  if (isLoading || !config) {
    return (
      <div className="card py-12 flex justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  const meta = config._meta || {};

  // Group sections
  const grouped: Record<string, string[]> = {};
  for (const [sectionKey, sectionMeta] of Object.entries(meta)) {
    const sm = sectionMeta as SectionMetaInfo;
    const group = sm.group || 'general';
    if (!grouped[group]) grouped[group] = [];
    grouped[group].push(sectionKey);
  }

  return (
    <div className="space-y-2">
      {restartBanner && (
        <div
          className="p-2.5 rounded-lg border flex items-center gap-2 text-xs"
          style={{ backgroundColor: 'rgba(245, 158, 11, 0.06)', borderColor: 'rgba(245, 158, 11, 0.2)', color: 'rgb(245, 158, 11)' }}
        >
          <RefreshCw className="w-3.5 h-3.5 shrink-0" />
          <span>Some changes require a server restart to take effect.</span>
          <button onClick={() => setRestartBanner(false)} className="ml-auto btn btn-ghost p-0.5">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Connection info — top of the tab so agent operators see it first. */}
      <ConnectivityCard />

      {/* Runtime safety: dispatch kill switch (Stream 2 D9). */}
      <DispatchPolicyCard isAdmin={isAdmin} />

      {!isAdmin && (
        <div className="p-2 rounded-md text-2xs" style={{ color: 'var(--color-text-muted)', backgroundColor: 'var(--color-elevated)' }}>
          Only admins can modify server configuration.
        </div>
      )}

      {config._configFormat === 'js' && isAdmin && (
        <div
          className="p-2.5 rounded-lg border flex items-start gap-2 text-xs"
          style={{ backgroundColor: 'rgba(245, 158, 11, 0.06)', borderColor: 'rgba(245, 158, 11, 0.2)', color: 'rgb(245, 158, 11)' }}
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">Config is read-only</p>
            <p className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
              Your instance uses a JavaScript config file which cannot be edited from the UI.
              Migrate to JSON format (<code className="text-2xs">config.json</code>) to enable editing.
              Changes made here will apply at runtime but won't persist across restarts.
            </p>
          </div>
        </div>
      )}

      {GROUP_ORDER.map(group => {
        const sections = grouped[group];
        if (!sections || sections.length === 0) return null;
        const isExpanded = expandedGroups.has(group);

        return (
          <div key={group}>
            <button
              onClick={() => toggleGroup(group)}
              className="w-full flex items-center gap-1.5 py-1.5 text-xs font-semibold hover:opacity-80 transition-opacity"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {GROUP_LABELS[group] || group}
            </button>

            {isExpanded && (
              <div className="space-y-2 mb-3">
                {sections.map(sectionKey => (
                  <ConfigSectionCard
                    key={sectionKey}
                    sectionKey={sectionKey}
                    sectionData={(config[sectionKey] as Record<string, unknown>) || {}}
                    sectionMeta={meta[sectionKey] as SectionMetaInfo}
                    isAdmin={isAdmin}
                    queryClient={queryClient}
                    onRestartRequired={() => setRestartBanner(true)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Config Section Card ─────────────────────────────────────────

function ConfigSectionCard({
  sectionKey,
  sectionData,
  sectionMeta,
  isAdmin,
  queryClient,
  onRestartRequired,
}: {
  sectionKey: string;
  sectionData: Record<string, unknown>;
  sectionMeta: SectionMetaInfo;
  isAdmin: boolean;
  queryClient: ReturnType<typeof useQueryClient>;
  onRestartRequired: () => void;
}) {
  const [localData, setLocalData] = useState<Record<string, unknown>>(sectionData);
  const [isDirty, setIsDirty] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.patch<ServerConfigResponse>('/admin/config', body),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['server-config'] });
      toast.success('Config updated', `${sectionMeta.label} has been saved.`);
      setIsDirty(false);
      if (data.restartRequired) {
        onRestartRequired();
      }
    },
    onError: (err: Error) => {
      toast.error('Update failed', err.message);
    },
  });

  const handleSave = () => {
    // Build a diff: only send changed values
    const diff = buildDiff(sectionData, localData);
    if (Object.keys(diff).length === 0) return;
    updateMutation.mutate({ [sectionKey]: diff });
  };

  const handleReset = () => {
    setLocalData(sectionData);
    setIsDirty(false);
  };

  const updateField = (path: string, value: unknown) => {
    setLocalData(prev => setNestedValue({ ...prev }, path, value));
    setIsDirty(true);
  };

  // Flatten fields for rendering
  const fields = flattenFields(localData, sectionKey, sectionMeta.fields);

  // Show first 3 fields collapsed, all fields expanded
  const visibleFields = isExpanded ? fields : fields.slice(0, 3);
  const hasMore = fields.length > 3;

  return (
    <div className="card p-3">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-xs font-semibold">{sectionMeta.label}</h3>
        {isDirty && isAdmin && (
          <div className="flex items-center gap-1.5">
            <button onClick={handleReset} className="btn btn-ghost text-2xs px-2 py-0.5">
              Reset
            </button>
            <button
              onClick={handleSave}
              disabled={updateMutation.isPending}
              className="btn btn-primary text-2xs px-2 py-0.5 flex items-center gap-1"
            >
              {updateMutation.isPending && <LoadingSpinner size="sm" />}
              Save
            </button>
          </div>
        )}
      </div>
      <p className="text-2xs mb-2.5" style={{ color: 'var(--color-text-muted)' }}>
        {sectionMeta.description}
      </p>

      <div className="space-y-2">
        {visibleFields.map(field => (
          <ConfigField
            key={field.path}
            {...field}
            isAdmin={isAdmin}
            onChange={(val) => updateField(field.localPath, val)}
          />
        ))}
      </div>

      {hasMore && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="mt-2 text-2xs font-medium hover:opacity-80 transition-opacity"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {isExpanded ? 'Show less' : `Show ${fields.length - 3} more fields...`}
        </button>
      )}
    </div>
  );
}

// ─── Individual Field Renderer ───────────────────────────────────

interface FieldRenderInfo {
  path: string;       // full dot-path (e.g., "learning.atlas.maxExperiences")
  localPath: string;  // path within section (e.g., "atlas.maxExperiences")
  label: string;
  description?: string;
  value: unknown;
  isSecret: boolean;
  isReadOnly: boolean;
  isRestartRequired: boolean;
  isEnum: boolean;
  enumOptions?: string[];
}

function ConfigField({
  path,
  label,
  description,
  value,
  isSecret,
  isReadOnly,
  isRestartRequired,
  isEnum,
  enumOptions,
  isAdmin,
  onChange,
}: FieldRenderInfo & { isAdmin: boolean; onChange: (val: unknown) => void }) {
  const disabled = !isAdmin || isReadOnly;
  const displayValue = value ?? '';

  return (
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <label className="text-2xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
            {label}
          </label>
          {isRestartRequired && (
            <span
              className="text-2xs px-1 py-0 rounded"
              style={{ backgroundColor: 'rgba(245, 158, 11, 0.1)', color: 'rgb(245, 158, 11)', fontSize: '9px' }}
              title="Requires server restart"
            >
              restart
            </span>
          )}
          {isReadOnly && (
            <span
              className="text-2xs px-1 py-0 rounded"
              style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-muted)', fontSize: '9px' }}
            >
              read-only
            </span>
          )}
          {isSecret && (
            <span
              className="text-2xs px-1 py-0 rounded"
              style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: 'rgb(239, 68, 68)', fontSize: '9px' }}
            >
              secret
            </span>
          )}
        </div>
        {description && (
          <p className="text-2xs mb-0.5" style={{ color: 'var(--color-text-muted)', fontSize: '9px' }}>
            {description}
          </p>
        )}
      </div>
      <div className="w-48 shrink-0">
        {typeof value === 'boolean' ? (
          <button
            onClick={() => !disabled && onChange(!value)}
            disabled={disabled}
            className={clsx(
              'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
              value ? 'bg-honey-500' : 'bg-gray-600',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            <span
              className={clsx(
                'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                value ? 'translate-x-4.5' : 'translate-x-0.5',
              )}
            />
          </button>
        ) : isEnum && enumOptions ? (
          <select
            value={String(displayValue)}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="input w-full text-2xs py-1 px-2"
          >
            {enumOptions.map(opt => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        ) : typeof value === 'number' ? (
          <input
            type="number"
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            disabled={disabled}
            className="input w-full text-2xs py-1 px-2"
          />
        ) : Array.isArray(value) ? (
          <input
            type="text"
            value={(value as unknown[]).join(', ')}
            onChange={(e) => onChange(e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
            disabled={disabled}
            className="input w-full text-2xs py-1 px-2"
            placeholder="Comma-separated values"
          />
        ) : isSecret && displayValue === SECRET_SENTINEL ? (
          <input
            type="password"
            value={SECRET_SENTINEL}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="input w-full text-2xs py-1 px-2"
            placeholder="Enter new value to change"
          />
        ) : (
          <input
            type="text"
            value={String(displayValue)}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="input w-full text-2xs py-1 px-2"
          />
        )}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Flatten nested config objects into a list of renderable fields */
function flattenFields(
  data: Record<string, unknown>,
  sectionKey: string,
  fieldsMeta: Record<string, FieldMetaInfo>,
  prefix = '',
): FieldRenderInfo[] {
  const result: FieldRenderInfo[] = [];

  for (const [key, value] of Object.entries(data)) {
    const localPath = prefix ? `${prefix}.${key}` : key;
    const fullPath = `${sectionKey}.${localPath}`;
    const meta = fieldsMeta[localPath];

    // Skip complex nested objects that don't have field metadata —
    // but recurse into them to find fields that do
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result.push(...flattenFields(
        value as Record<string, unknown>,
        sectionKey,
        fieldsMeta,
        localPath,
      ));
      continue;
    }

    const enumOpts = ENUM_OPTIONS[fullPath];

    result.push({
      path: fullPath,
      localPath,
      label: meta?.label || key,
      description: meta?.description,
      value,
      isSecret: meta?.secret || false,
      isReadOnly: meta?.readOnly || false,
      isRestartRequired: meta?.restartRequired || false,
      isEnum: !!enumOpts,
      enumOptions: enumOpts,
    });
  }

  return result;
}

/** Build a diff between original and modified objects */
function buildDiff(
  original: Record<string, unknown>,
  modified: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const [key, newVal] of Object.entries(modified)) {
    const oldVal = original[key];
    if (newVal && typeof newVal === 'object' && !Array.isArray(newVal) &&
        oldVal && typeof oldVal === 'object' && !Array.isArray(oldVal)) {
      const nested = buildDiff(oldVal as Record<string, unknown>, newVal as Record<string, unknown>);
      if (Object.keys(nested).length > 0) diff[key] = nested;
    } else if (JSON.stringify(newVal) !== JSON.stringify(oldVal)) {
      diff[key] = newVal;
    }
  }
  return diff;
}

/** Set a nested value using a dot-path */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const existing = current[parts[i]];
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      current[parts[i]] = { ...(existing as Record<string, unknown>) };
      current = current[parts[i]] as Record<string, unknown>;
    } else {
      current[parts[i]] = {};
      current = current[parts[i]] as Record<string, unknown>;
    }
  }
  current[parts[parts.length - 1]] = value;
  return obj;
}

function ProfileSettings({ agent }: { agent: { name: string; email?: string | null; description?: string | null } }) {
  const [description, setDescription] = useState(agent.description || '');
  const [isLoading, setIsLoading] = useState(false);

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      await api.patch(`/agents/${agent.name}`, { description });
      toast.success('Profile updated', 'Your profile has been saved.');
    } catch (err) {
      toast.error('Update failed', 'Could not update your profile.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');

    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters');
      return;
    }

    setPasswordLoading(true);

    try {
      await api.post('/auth/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      toast.success('Password changed', 'Your password has been updated.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: unknown) {
      const apiError = err as { message?: string };
      setPasswordError(apiError.message || 'Failed to change password');
    } finally {
      setPasswordLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Profile info */}
      <div className="card p-4">
        <h2 className="text-sm font-semibold mb-3">Profile</h2>

        <form onSubmit={handleSave} className="space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
              Username
            </label>
            <input
              type="text"
              value={agent.name}
              className="input w-full opacity-50 cursor-not-allowed"
              disabled
            />
            <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              Cannot be changed
            </p>
          </div>

          {agent.email && (
            <div>
              <label className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
                Email
              </label>
              <input
                type="email"
                value={agent.email}
                className="input w-full opacity-50 cursor-not-allowed"
                disabled
              />
            </div>
          )}

          <div>
            <label htmlFor="description" className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
              Bio
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input w-full min-h-[80px] resize-y"
              placeholder="Tell us about yourself..."
              maxLength={500}
            />
            <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              {description.length}/500
            </p>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="btn btn-primary flex items-center gap-1.5 text-xs"
          >
            {isLoading && <LoadingSpinner size="sm" />}
            Save Changes
          </button>
        </form>
      </div>

      {/* Change Password */}
      <div className="card p-4">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
          <Lock className="w-3.5 h-3.5" />
          Change Password
        </h2>

        <form onSubmit={handleChangePassword} className="space-y-3">
          {passwordError && (
            <div className="p-2 bg-red-500/10 border border-red-500/20 rounded-md text-red-400 text-xs">
              {passwordError}
            </div>
          )}

          <div>
            <label htmlFor="currentPassword" className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
              Current Password
            </label>
            <input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="input w-full"
              required
            />
          </div>

          <div>
            <label htmlFor="newPassword" className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
              New Password
            </label>
            <input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="input w-full"
              placeholder="At least 8 characters"
              required
              minLength={8}
            />
          </div>

          <div>
            <label htmlFor="confirmPassword" className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
              Confirm New Password
            </label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="input w-full"
              required
            />
          </div>

          <button
            type="submit"
            disabled={passwordLoading}
            className="btn btn-primary flex items-center gap-1.5 text-xs"
          >
            {passwordLoading && <LoadingSpinner size="sm" />}
            Change Password
          </button>
        </form>
      </div>

      {/* Danger Zone */}
      <div className="card p-4">
        <h2 className="text-sm font-semibold mb-2 flex items-center gap-1.5 text-red-400">
          <Trash2 className="w-3.5 h-3.5" />
          Danger Zone
        </h2>
        <p className="text-xs mb-3" style={{ color: 'var(--color-text-secondary)' }}>
          Once you delete your account, there is no going back.
        </p>
        <button className="btn text-xs bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors">
          Delete Account
        </button>
      </div>
    </div>
  );
}

function DisplaySettings() {
  const { theme, setTheme } = useThemeStore();

  const themes = [
    { value: 'light' as const, icon: Sun, label: 'Light', description: 'Light background with dark text' },
    { value: 'dark' as const, icon: Moon, label: 'Dark', description: 'Dark background with light text' },
    { value: 'system' as const, icon: Monitor, label: 'System', description: 'Follows your operating system setting' },
  ];

  return (
    <div className="card p-4">
      <h2 className="text-sm font-semibold mb-3">Theme</h2>
      <div className="space-y-1.5">
        {themes.map(({ value, icon: Icon, label, description }) => (
          <button
            key={value}
            onClick={() => setTheme(value)}
            className={clsx(
              'w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-colors cursor-pointer',
              theme === value
                ? 'bg-honey-500/10 text-honey-500'
                : 'hover:bg-workspace-hover'
            )}
            style={theme !== value ? { color: 'var(--color-text-secondary)' } : undefined}
          >
            <Icon className="w-4 h-4 shrink-0" />
            <div>
              <p className="text-sm font-medium">{label}</p>
              <p className="text-xs" style={{ color: theme === value ? 'var(--color-text-muted)' : 'var(--color-text-muted)' }}>
                {description}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// API Keys Settings
// ═══════════════════════════════════════════════════════════════

interface IngestKeyResponse {
  id: string;
  label: string;
  key: string;
  scopes: string[];
  agent_id: string;
  revoked: boolean;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
}

const SCOPE_OPTIONS = [
  { value: 'map', label: 'MAP', description: 'MAP protocol & coordination' },
  { value: 'sessions', label: 'Sessions', description: 'Session upload & trajectory' },
  { value: 'resources', label: 'Resources', description: 'Assets & memory banks' },
  { value: 'admin', label: 'Admin', description: 'Administrative operations' },
  { value: '*', label: 'All', description: 'Full access (wildcard)' },
];

function ApiKeysSettings() {
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ data: IngestKeyResponse[] }>({
    queryKey: ['ingest-keys'],
    queryFn: () => api.get('/admin/ingest-keys?include_revoked=true'),
  });

  const keys = data?.data || [];

  const handleCreated = (plaintextKey: string) => {
    setNewlyCreatedKey(plaintextKey);
    setShowCreateForm(false);
    queryClient.invalidateQueries({ queryKey: ['ingest-keys'] });
  };

  const handleMutated = () => {
    queryClient.invalidateQueries({ queryKey: ['ingest-keys'] });
  };

  if (isLoading) {
    return (
      <div className="card py-12 flex justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header with create button */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">API Keys</h2>
        {!showCreateForm && (
          <button
            onClick={() => { setShowCreateForm(true); setNewlyCreatedKey(null); }}
            className="btn btn-primary flex items-center gap-1.5 text-xs"
          >
            <Plus className="w-3.5 h-3.5" />
            Create Key
          </button>
        )}
      </div>

      {/* Newly created key banner */}
      {newlyCreatedKey && (
        <NewKeyBanner keyValue={newlyCreatedKey} onDismiss={() => setNewlyCreatedKey(null)} />
      )}

      {/* Create form */}
      {showCreateForm && (
        <CreateKeyForm
          onCreated={handleCreated}
          onClose={() => setShowCreateForm(false)}
        />
      )}

      {/* Key list */}
      {keys.length > 0 ? (
        <div className="space-y-1.5">
          {keys.map((k) => (
            <KeyCard key={k.id} keyData={k} onMutated={handleMutated} />
          ))}
        </div>
      ) : (
        <div className="card py-12 text-center">
          <Key className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--color-text-muted)' }} />
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            No API keys yet
          </p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Create a key to authenticate external agents via Bearer token.
          </p>
        </div>
      )}
    </div>
  );
}

function NewKeyBanner({ keyValue, onDismiss }: { keyValue: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(keyValue);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="p-3 rounded-lg border"
      style={{ backgroundColor: 'rgba(16, 185, 129, 0.06)', borderColor: 'rgba(16, 185, 129, 0.2)' }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <p className="text-xs font-medium text-emerald-400">Key created successfully</p>
        <button onClick={onDismiss} className="btn btn-ghost p-0.5 shrink-0">
          <X className="w-3 h-3" />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <code
          className="flex-1 text-xs px-2 py-1.5 rounded font-mono truncate"
          style={{ backgroundColor: 'var(--color-elevated)' }}
        >
          {keyValue}
        </code>
        <button
          onClick={handleCopy}
          className="btn btn-ghost p-1.5 shrink-0"
          title="Copy to clipboard"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
      <p className="text-2xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
        Store this key securely. Use it as a Bearer token in the Authorization header.
      </p>
    </div>
  );
}

function CreateKeyForm({
  onCreated,
  onClose,
}: {
  onCreated: (key: string) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<string[]>(['map']);
  const [expiresInHours, setExpiresInHours] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const toggleScope = (scope: string) => {
    if (scope === '*') {
      setScopes(scopes.includes('*') ? ['map'] : ['*']);
      return;
    }
    // Remove wildcard when selecting specific scopes
    const without = scopes.filter((s) => s !== '*');
    if (without.includes(scope)) {
      const next = without.filter((s) => s !== scope);
      setScopes(next.length > 0 ? next : ['map']);
    } else {
      setScopes([...without, scope]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!label.trim()) {
      setError('Label is required');
      return;
    }

    setIsLoading(true);
    try {
      const body: Record<string, unknown> = {
        label: label.trim(),
        scopes,
      };
      if (expiresInHours && Number(expiresInHours) > 0) {
        body.expires_in_hours = Number(expiresInHours);
      }

      const res = await api.post<{ key: string }>('/admin/ingest-keys', body);
      toast.success('Key created', `API key "${label.trim()}" has been created.`);
      onCreated(res.key);
    } catch (err: unknown) {
      const apiErr = err as { message?: string };
      setError(apiErr.message || 'Failed to create key');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Create API Key</h3>
        <button onClick={onClose} className="btn btn-ghost p-1">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {error && (
          <div className="p-2 bg-red-500/10 border border-red-500/20 rounded-md text-red-400 text-xs">
            {error}
          </div>
        )}

        {/* Label */}
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
            Label <span className="text-red-400">*</span>
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="input w-full"
            placeholder="e.g. claude-code-agent, ci-pipeline"
            required
            autoFocus
          />
        </div>

        {/* Scopes */}
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
            Scopes
          </label>
          <div className="flex flex-wrap gap-1.5">
            {SCOPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => toggleScope(opt.value)}
                className={clsx(
                  'px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer border',
                  scopes.includes(opt.value)
                    ? 'bg-honey-500/15 text-honey-500 border-honey-500/30'
                    : 'border-transparent hover:bg-workspace-hover'
                )}
                style={!scopes.includes(opt.value) ? {
                  color: 'var(--color-text-secondary)',
                  backgroundColor: 'var(--color-elevated)',
                } : undefined}
                title={opt.description}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            {scopes.includes('*')
              ? 'Full access to all endpoints'
              : `Access: ${scopes.join(', ')}`}
          </p>
        </div>

        {/* Expiry */}
        <div>
          <label className="block text-xs font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>
            Expires in (hours)
          </label>
          <input
            type="number"
            value={expiresInHours}
            onChange={(e) => setExpiresInHours(e.target.value)}
            className="input w-32"
            placeholder="Never"
            min={1}
          />
          <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Leave empty for no expiration.
          </p>
        </div>

        {/* Submit */}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="submit"
            disabled={isLoading}
            className="btn btn-primary flex items-center gap-1.5 text-xs"
          >
            {isLoading && <LoadingSpinner size="sm" />}
            Create Key
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost text-xs"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function KeyCard({
  keyData,
  onMutated,
}: {
  keyData: IngestKeyResponse;
  onMutated: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isExpired = keyData.expires_at && new Date(keyData.expires_at) < new Date();
  const status = keyData.revoked ? 'revoked' : isExpired ? 'expired' : 'active';

  const maskedKey = keyData.key
    ? `${keyData.key.slice(0, 8)}${'*'.repeat(20)}`
    : 'ohk_********************';

  const handleCopy = async () => {
    if (!keyData.key) return;
    await navigator.clipboard.writeText(keyData.key);
    setCopied(true);
    toast.info('Copied', 'API key copied to clipboard.');
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRevoke = async () => {
    setRevoking(true);
    try {
      await api.post(`/admin/ingest-keys/${keyData.id}/revoke`);
      toast.success('Key revoked', `"${keyData.label}" has been revoked.`);
      onMutated();
    } catch {
      toast.error('Revoke failed', 'Could not revoke the key.');
    } finally {
      setRevoking(false);
      setConfirmRevoke(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.delete(`/admin/ingest-keys/${keyData.id}`);
      toast.success('Key deleted', `"${keyData.label}" has been permanently deleted.`);
      onMutated();
    } catch {
      toast.error('Delete failed', 'Could not delete the key.');
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div
      className={clsx('card px-4 py-3', status === 'revoked' && 'opacity-60')}
    >
      {/* Header row */}
      <div className="flex items-center gap-2 mb-1.5">
        <Key className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
        <span className="text-sm font-medium truncate">{keyData.label}</span>
        <span
          className={clsx(
            'text-2xs px-1.5 py-0.5 rounded font-medium shrink-0',
            status === 'active' && 'bg-emerald-500/10 text-emerald-400',
            status === 'revoked' && 'bg-red-500/10 text-red-400',
            status === 'expired' && 'bg-yellow-500/10 text-yellow-400',
          )}
        >
          {status}
        </span>
      </div>

      {/* Meta row */}
      <div className="flex items-center gap-1.5 text-2xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
        <span>{keyData.scopes?.includes('*') ? 'all scopes' : keyData.scopes?.join(', ')}</span>
        <span className="opacity-30">&middot;</span>
        <span>Created <TimeAgo date={keyData.created_at} /></span>
        {keyData.expires_at && (
          <>
            <span className="opacity-30">&middot;</span>
            <Clock className="w-2.5 h-2.5" />
            <span>
              {isExpired ? 'Expired' : <>Expires <TimeAgo date={keyData.expires_at} /></>}
            </span>
          </>
        )}
        {keyData.last_used_at && (
          <>
            <span className="opacity-30">&middot;</span>
            <span>Used <TimeAgo date={keyData.last_used_at} /></span>
          </>
        )}
      </div>

      {/* Key value row */}
      <div className="flex items-center gap-1.5 mb-2">
        <code
          className="flex-1 text-xs px-2 py-1 rounded font-mono truncate"
          style={{ backgroundColor: 'var(--color-elevated)' }}
        >
          {showKey ? keyData.key : maskedKey}
        </code>
        <button
          onClick={() => setShowKey(!showKey)}
          className="btn btn-ghost p-1.5"
          title={showKey ? 'Hide key' : 'Show key'}
        >
          {showKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
        </button>
        <button
          onClick={handleCopy}
          className="btn btn-ghost p-1.5"
          title="Copy to clipboard"
        >
          {copied ? (
            <Check className="w-3 h-3 text-emerald-400" />
          ) : (
            <Copy className="w-3 h-3" />
          )}
        </button>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        {status === 'active' && (
          <>
            {confirmRevoke ? (
              <div className="flex items-center gap-1.5">
                <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>Revoke this key?</span>
                <button
                  onClick={handleRevoke}
                  disabled={revoking}
                  className="btn text-2xs px-2 py-0.5 bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 hover:bg-yellow-500/20"
                >
                  {revoking ? <LoadingSpinner size="sm" /> : 'Yes, revoke'}
                </button>
                <button
                  onClick={() => setConfirmRevoke(false)}
                  className="btn btn-ghost text-2xs px-2 py-0.5"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmRevoke(true)}
                className="btn btn-ghost text-2xs px-2 py-0.5 flex items-center gap-1"
                style={{ color: 'var(--color-text-muted)' }}
              >
                <ShieldOff className="w-2.5 h-2.5" />
                Revoke
              </button>
            )}
          </>
        )}

        {confirmDelete ? (
          <div className="flex items-center gap-1.5">
            <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>Delete permanently?</span>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="btn text-2xs px-2 py-0.5 bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20"
            >
              {deleting ? <LoadingSpinner size="sm" /> : 'Yes, delete'}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="btn btn-ghost text-2xs px-2 py-0.5"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="btn btn-ghost text-2xs px-2 py-0.5 flex items-center gap-1"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Trash2 className="w-2.5 h-2.5" />
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Git Sync Settings
// ═══════════════════════════════════════════════════════════════

interface GitSyncResource {
  id: string;
  name: string;
  resource_type: string;
  local_path: string | null;
  autoPull: boolean;
  sync_status: {
    hasUncommittedChanges: boolean;
    unpushedCommits: number;
    unpulledCommits: number;
    localHead: string | null;
    remoteHead: string | null;
    uncommittedDetails?: {
      added: number;
      modified: number;
      deleted: number;
      linesAdded: number;
      linesDeleted: number;
    };
  } | null;
  error?: string;
}

const RESOURCE_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  task: { label: 'Tasks', color: '#f59e0b' },
  memory_bank: { label: 'Memory', color: '#3b82f6' },
  skill: { label: 'Skill', color: '#8b5cf6' },
  playbook: { label: 'Playbook', color: '#10b981' },
};

function GitSyncSettings() {
  const { data, isLoading, refetch } = useQuery<{ resources: GitSyncResource[] }>({
    queryKey: ['admin-git-sync-status'],
    queryFn: () => api.get('/admin/git-sync-status'),
    staleTime: 30_000,
  });

  const resources = data?.resources || [];
  const hasResources = resources.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Git Sync</h2>
          <p className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            Git-backed resources with pull/push status. Auto-pull interval is configurable in Server &gt; Auto-Pull.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="btn-ghost p-1.5 rounded"
          title="Refresh status"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} style={{ color: 'var(--color-text-muted)' }} />
        </button>
      </div>

      {isLoading && !data && (
        <div className="flex items-center gap-2 py-4">
          <div className="w-3 h-3 rounded-full bg-gray-500/30 animate-pulse" />
          <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading git status...</span>
        </div>
      )}

      {!isLoading && !hasResources && (
        <div className="text-center py-6">
          <GitBranch className="w-6 h-6 mx-auto mb-2" style={{ color: 'var(--color-text-muted)' }} />
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No git-backed resources found</p>
        </div>
      )}

      {hasResources && (
        <div className="space-y-2">
          {resources.map((r) => (
            <GitSyncResourceRow key={r.id} resource={r} />
          ))}
        </div>
      )}

      {/* Summary */}
      {hasResources && (
        <div className="pt-3 border-t flex items-center gap-4 text-2xs" style={{ borderColor: 'var(--color-border-subtle)', color: 'var(--color-text-muted)' }}>
          <span>{resources.length} git-backed resource{resources.length !== 1 ? 's' : ''}</span>
          <span>{resources.filter((r) => r.autoPull).length} with auto-pull</span>
          <span>{resources.filter((r) => r.sync_status && r.sync_status.unpulledCommits > 0).length} with updates available</span>
        </div>
      )}
    </div>
  );
}

function GitSyncResourceRow({ resource }: { resource: GitSyncResource }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  const pullMutation = useMutation({
    mutationFn: () => api.post(`/resources/${resource.id}/content/opentasks/git-pull`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-git-sync-status'] });
      toast.success('Pulled', `Pulled updates for "${resource.name}"`);
    },
    onError: () => {
      toast.error('Pull failed', `Could not pull "${resource.name}"`);
    },
  });

  const typeInfo = RESOURCE_TYPE_LABELS[resource.resource_type] || { label: resource.resource_type, color: '#6b7280' };
  const status = resource.sync_status;
  const hasError = !!resource.error;
  const unpulled = status?.unpulledCommits ?? 0;
  const unpushed = status?.unpushedCommits ?? 0;
  const uncommitted = status?.hasUncommittedChanges ?? false;
  const isSynced = !hasError && status && unpulled === 0 && unpushed === 0 && !uncommitted;

  return (
    <>
      <div
        className="flex items-center gap-3 p-3 rounded-lg cursor-pointer hover:ring-1 hover:ring-white/10 transition-all"
        style={{ backgroundColor: 'var(--color-elevated)' }}
        onClick={() => setDialogOpen(true)}
      >
        {/* Status dot */}
        <div
          className={clsx('w-2 h-2 rounded-full shrink-0', {
            'bg-emerald-400': isSynced,
            'bg-blue-400': unpulled > 0,
            'bg-amber-400': unpushed > 0 || uncommitted,
            'bg-red-400': hasError,
          })}
        />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium truncate">{resource.name}</span>
            <span
              className="text-2xs px-1.5 py-0.5 rounded-full"
              style={{ backgroundColor: `${typeInfo.color}15`, color: typeInfo.color }}
            >
              {typeInfo.label}
            </span>
            {resource.autoPull && (
              <span className="text-2xs px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400">
                Auto-pull
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            {hasError && <span className="text-red-400">{resource.error}</span>}
            {isSynced && <span>Up to date</span>}
            {unpulled > 0 && <span className="text-blue-400">{unpulled} to pull</span>}
            {unpushed > 0 && <span className="text-amber-400">{unpushed} to push</span>}
            {uncommitted && (
              <span className="text-amber-400">
                {status?.uncommittedDetails
                  ? `${status.uncommittedDetails.added + status.uncommittedDetails.modified + status.uncommittedDetails.deleted} file${(status.uncommittedDetails.added + status.uncommittedDetails.modified + status.uncommittedDetails.deleted) !== 1 ? 's' : ''} changed`
                  : 'Uncommitted changes'}
                {status?.uncommittedDetails && (status.uncommittedDetails.linesAdded > 0 || status.uncommittedDetails.linesDeleted > 0) && (
                  <span className="ml-1">
                    {status.uncommittedDetails.linesAdded > 0 && <span className="text-emerald-400">+{status.uncommittedDetails.linesAdded}</span>}
                    {status.uncommittedDetails.linesAdded > 0 && status.uncommittedDetails.linesDeleted > 0 && ' '}
                    {status.uncommittedDetails.linesDeleted > 0 && <span className="text-red-400">-{status.uncommittedDetails.linesDeleted}</span>}
                  </span>
                )}
              </span>
            )}
            {status?.localHead && (
              <span className="font-mono">{status.localHead.slice(0, 7)}</span>
            )}
          </div>
          {resource.local_path && (
            <div className="mt-0.5 text-2xs font-mono truncate" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
              {resource.local_path}
            </div>
          )}
        </div>

        {/* Quick pull */}
        {unpulled > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); pullMutation.mutate(); }}
            disabled={pullMutation.isPending}
            className="text-2xs px-2.5 py-1 rounded-md font-medium transition-colors hover:bg-blue-500/15"
            style={{ color: '#60a5fa', backgroundColor: 'rgba(59, 130, 246, 0.08)' }}
          >
            {pullMutation.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : 'Pull'}
          </button>
        )}

        <ChevronRight className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
      </div>

      {dialogOpen && (
        <GitSyncManageDialog resource={resource} onClose={() => setDialogOpen(false)} />
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// Git Sync Management Dialog
// ═══════════════════════════════════════════════════════════════

function GitSyncManageDialog({ resource, onClose }: { resource: GitSyncResource; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'config' | 'log'>('config');
  const [confirmForce, setConfirmForce] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  const status = resource.sync_status;
  const unpulled = status?.unpulledCommits ?? 0;
  const unpushed = status?.unpushedCommits ?? 0;
  const uncommitted = status?.hasUncommittedChanges ?? false;

  const gitPull = useGitPullHook(resource.id);
  const gitPush = useGitPushHook(resource.id);
  const forceFetch = useGitForceFetch(resource.id);
  const updateResource = useUpdateResource(resource.id);
  const { data: logData, isLoading: logLoading } = useGitLog(resource.id, tab === 'log');

  // Extract current sync config from resource metadata
  const meta = resource as any;
  const otConfig = meta?.opentasks_config || meta?.metadata?.opentasks_config;
  const syncGit = otConfig?.sync?.git || meta?.metadata?.sync?.git || {};
  const [autoCommit, setAutoCommit] = useState<boolean>(!!syncGit.autoCommit);
  const [autoPush, setAutoPush] = useState<boolean>(!!syncGit.autoPush);
  const [autoPullLocal, setAutoPullLocal] = useState<boolean>(resource.autoPull);

  const saveConfig = () => {
    // Build updated metadata with new sync config
    const currentMeta = (meta?.metadata || {}) as Record<string, unknown>;
    const currentOtConfig = (currentMeta.opentasks_config || {}) as Record<string, unknown>;
    const currentSync = (currentOtConfig.sync || {}) as Record<string, unknown>;
    const currentGit = (currentSync.git || {}) as Record<string, unknown>;

    const updatedMeta = {
      ...currentMeta,
      opentasks_config: {
        ...currentOtConfig,
        sync: {
          ...currentSync,
          git: { ...currentGit, autoCommit, autoPush, autoPull: autoPullLocal },
        },
      },
    };

    updateResource.mutate({ metadata: updatedMeta }, {
      onSuccess: () => {
        toast.success('Saved', 'Sync config updated');
        queryClient.invalidateQueries({ queryKey: ['admin-git-sync-status'] });
      },
    });
  };

  const handleForceFetch = () => {
    forceFetch.mutate(undefined, {
      onSuccess: (data) => {
        toast.success('Force fetched', data.changed ? `Reset to ${data.newHead?.slice(0, 7)}` : 'Already at latest');
        setConfirmForce(false);
      },
      onError: () => toast.error('Failed', 'Force fetch failed'),
    });
  };

  const handleUnlink = () => {
    updateResource.mutate({ local_path: null, sync_strategy: 'metadata' }, {
      onSuccess: () => {
        toast.success('Unlinked', 'Git backing removed');
        queryClient.invalidateQueries({ queryKey: ['admin-git-sync-status'] });
        onClose();
      },
    });
  };

  const typeInfo = RESOURCE_TYPE_LABELS[resource.resource_type] || { label: resource.resource_type, color: '#6b7280' };

  return (
    <Dialog open onClose={onClose} maxWidth="max-w-lg">
      <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--color-border-subtle)' }}>
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
          <span className="text-sm font-semibold">{resource.name}</span>
          <span className="text-2xs px-1.5 py-0.5 rounded-full" style={{ backgroundColor: `${typeInfo.color}15`, color: typeInfo.color }}>
            {typeInfo.label}
          </span>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-white/5">
          <X className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b px-4" style={{ borderColor: 'var(--color-border-subtle)' }}>
        {(['config', 'log'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx('px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px', {
              'border-honey-500 text-honey-500': tab === t,
              'border-transparent': tab !== t,
            })}
            style={tab !== t ? { color: 'var(--color-text-muted)' } : undefined}
          >
            {t === 'config' ? 'Config & Actions' : 'Commit Log'}
          </button>
        ))}
      </div>

      <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
        {tab === 'config' && (
          <>
            {/* Status overview */}
            <div className="space-y-1">
              <div className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Status</div>
              <div className="flex flex-wrap gap-2 text-2xs">
                {status && unpulled === 0 && unpushed === 0 && !uncommitted && (
                  <span className="flex items-center gap-1 text-emerald-400"><div className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Up to date</span>
                )}
                {unpulled > 0 && <span className="text-blue-400">{unpulled} commit{unpulled > 1 ? 's' : ''} to pull</span>}
                {unpushed > 0 && <span className="text-amber-400">{unpushed} commit{unpushed > 1 ? 's' : ''} to push</span>}
                {uncommitted && <span className="text-amber-400">Uncommitted changes</span>}
                {resource.error && <span className="text-red-400">{resource.error}</span>}
              </div>
              {status?.uncommittedDetails && (
                <div className="flex items-center gap-3 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                  {status.uncommittedDetails.added > 0 && <span className="text-emerald-400">{status.uncommittedDetails.added} added</span>}
                  {status.uncommittedDetails.modified > 0 && <span className="text-blue-400">{status.uncommittedDetails.modified} modified</span>}
                  {status.uncommittedDetails.deleted > 0 && <span className="text-red-400">{status.uncommittedDetails.deleted} deleted</span>}
                  {(status.uncommittedDetails.linesAdded > 0 || status.uncommittedDetails.linesDeleted > 0) && (
                    <span>
                      {status.uncommittedDetails.linesAdded > 0 && <span className="text-emerald-400">+{status.uncommittedDetails.linesAdded}</span>}
                      {status.uncommittedDetails.linesAdded > 0 && status.uncommittedDetails.linesDeleted > 0 && ' / '}
                      {status.uncommittedDetails.linesDeleted > 0 && <span className="text-red-400">-{status.uncommittedDetails.linesDeleted}</span>}
                      <span> lines</span>
                    </span>
                  )}
                </div>
              )}
              {status?.localHead && (
                <div className="text-2xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
                  Local: {status.localHead.slice(0, 7)}{status.remoteHead ? ` · Remote: ${status.remoteHead.slice(0, 7)}` : ''}
                </div>
              )}
              {resource.local_path && (
                <div className="text-2xs font-mono" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
                  {resource.local_path}
                </div>
              )}
            </div>

            {/* Sync config toggles */}
            <div className="space-y-2">
              <div className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Sync Configuration</div>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs">Auto-commit on save</span>
                <input type="checkbox" checked={autoCommit} onChange={(e) => setAutoCommit(e.target.checked)} className="accent-honey-500" />
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs">Auto-push to remote</span>
                <input type="checkbox" checked={autoPush} onChange={(e) => setAutoPush(e.target.checked)} className="accent-honey-500" />
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <span className="text-xs">Auto-pull from remote</span>
                <input type="checkbox" checked={autoPullLocal} onChange={(e) => setAutoPullLocal(e.target.checked)} className="accent-honey-500" />
              </label>
              <button
                onClick={saveConfig}
                disabled={updateResource.isPending}
                className="btn btn-primary text-2xs px-3 py-1"
              >
                {updateResource.isPending ? 'Saving...' : 'Save Config'}
              </button>
            </div>

            {/* Actions */}
            <div className="space-y-2">
              <div className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Actions</div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => { gitPull.mutate(); }}
                  disabled={gitPull.isPending || unpulled === 0}
                  className="flex items-center gap-1.5 text-2xs px-3 py-1.5 rounded-md font-medium transition-colors hover:bg-blue-500/15 disabled:opacity-40"
                  style={{ color: '#60a5fa', backgroundColor: 'rgba(59, 130, 246, 0.08)' }}
                >
                  {gitPull.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <ArrowDownToLine className="w-3 h-3" />}
                  Pull
                </button>
                <button
                  onClick={() => { gitPush.mutate(); }}
                  disabled={gitPush.isPending || (unpushed === 0 && !uncommitted)}
                  className="flex items-center gap-1.5 text-2xs px-3 py-1.5 rounded-md font-medium transition-colors hover:bg-amber-500/15 disabled:opacity-40"
                  style={{ color: '#fbbf24', backgroundColor: 'rgba(245, 158, 11, 0.08)' }}
                >
                  {gitPush.isPending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <ArrowUpFromLine className="w-3 h-3" />}
                  Push
                </button>
                {resource.resource_type === 'task' && (
                  <button
                    onClick={() => { navigate(`/tasks?g=${resource.id}`); onClose(); }}
                    className="flex items-center gap-1.5 text-2xs px-3 py-1.5 rounded-md font-medium transition-colors hover:bg-white/5"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    <ExternalLink className="w-3 h-3" />
                    Open Graph
                  </button>
                )}
              </div>
            </div>

            {/* Danger zone */}
            <div className="pt-3 border-t space-y-2" style={{ borderColor: 'var(--color-border-subtle)' }}>
              <div className="text-2xs font-medium" style={{ color: 'var(--color-text-muted)' }}>Danger Zone</div>
              {!confirmForce ? (
                <button
                  onClick={() => setConfirmForce(true)}
                  className="flex items-center gap-1.5 text-2xs px-3 py-1.5 rounded-md font-medium text-red-400/70 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <RotateCcw className="w-3 h-3" />
                  Force Fetch (reset to remote)
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-2xs text-red-400">This will discard all local changes. Continue?</span>
                  <button onClick={handleForceFetch} disabled={forceFetch.isPending} className="text-2xs px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30">
                    {forceFetch.isPending ? '...' : 'Confirm'}
                  </button>
                  <button onClick={() => setConfirmForce(false)} className="text-2xs px-2 py-0.5 rounded hover:bg-white/10" style={{ color: 'var(--color-text-muted)' }}>Cancel</button>
                </div>
              )}
              {!confirmUnlink ? (
                <button
                  onClick={() => setConfirmUnlink(true)}
                  className="flex items-center gap-1.5 text-2xs px-3 py-1.5 rounded-md font-medium text-red-400/70 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <Unlink className="w-3 h-3" />
                  Unlink Git Backing
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-2xs text-red-400">Remove git backing? Resource becomes metadata-only.</span>
                  <button onClick={handleUnlink} disabled={updateResource.isPending} className="text-2xs px-2 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30">
                    {updateResource.isPending ? '...' : 'Unlink'}
                  </button>
                  <button onClick={() => setConfirmUnlink(false)} className="text-2xs px-2 py-0.5 rounded hover:bg-white/10" style={{ color: 'var(--color-text-muted)' }}>Cancel</button>
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'log' && (
          <div className="space-y-1">
            {logLoading && (
              <div className="flex items-center gap-2 py-4">
                <div className="w-3 h-3 rounded-full bg-gray-500/30 animate-pulse" />
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Loading commits...</span>
              </div>
            )}
            {logData?.commits?.length === 0 && (
              <p className="text-xs py-4 text-center" style={{ color: 'var(--color-text-muted)' }}>No commits found</p>
            )}
            {logData?.commits?.map((commit) => (
              <div key={commit.hash} className="flex gap-3 py-2 border-b last:border-0" style={{ borderColor: 'var(--color-border-subtle)' }}>
                <span className="text-2xs font-mono shrink-0 pt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  {commit.hash.slice(0, 7)}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs truncate">{commit.message}</p>
                  <div className="flex items-center gap-2 text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                    <span>{commit.author}</span>
                    <span>{new Date(commit.date).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
