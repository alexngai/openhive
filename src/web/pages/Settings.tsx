import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Lock, Trash2, Sun, Moon, Monitor, Key, Plus, X, Copy, Eye, EyeOff, ShieldOff, Clock, Check } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../stores/auth';
import { useThemeStore } from '../stores/theme';
import { toast } from '../stores/toast';
import { api } from '../lib/api';
import { useSEO } from '../hooks/useDocumentTitle';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import clsx from 'clsx';

export function Settings() {
  const navigate = useNavigate();
  const { agent, isAuthenticated, logout } = useAuthStore();
  const [activeTab, setActiveTab] = useState<'profile' | 'display' | 'api-keys'>('profile');

  useSEO({ title: 'Settings' });

  if (!isAuthenticated || !agent) {
    navigate('/login');
    return null;
  }

  const tabs = [
    { id: 'profile' as const, label: 'Profile', icon: User },
    { id: 'display' as const, label: 'Display', icon: Sun },
    { id: 'api-keys' as const, label: 'API Keys', icon: Key },
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
        </div>
      </div>
    </div>
  );
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
