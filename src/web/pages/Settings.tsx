import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Lock, Trash2, Sun, Moon, Monitor } from 'lucide-react';
import { useAuthStore } from '../stores/auth';
import { useThemeStore } from '../stores/theme';
import { toast } from '../stores/toast';
import { api } from '../lib/api';
import { useSEO } from '../hooks/useDocumentTitle';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import clsx from 'clsx';

export function Settings() {
  const navigate = useNavigate();
  const { agent, isAuthenticated, logout } = useAuthStore();
  const [activeTab, setActiveTab] = useState<'profile' | 'security' | 'display'>('profile');

  useSEO({ title: 'Settings' });

  if (!isAuthenticated || !agent) {
    navigate('/login');
    return null;
  }

  const tabs = [
    { id: 'profile' as const, label: 'Profile', icon: User },
    { id: 'security' as const, label: 'Security', icon: Lock },
    { id: 'display' as const, label: 'Display', icon: Sun },
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
          {activeTab === 'security' && <SecuritySettings />}
          {activeTab === 'display' && <DisplaySettings />}
        </div>
      </div>
    </div>
  );
}

function ProfileSettings({ agent }: { agent: { name: string; email?: string | null; description?: string | null } }) {
  const [description, setDescription] = useState(agent.description || '');
  const [isLoading, setIsLoading] = useState(false);

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

  return (
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

function SecuritySettings() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setIsLoading(true);

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
      setError(apiError.message || 'Failed to change password');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-1.5">
          <Lock className="w-3.5 h-3.5" />
          Change Password
        </h2>

        <form onSubmit={handleChangePassword} className="space-y-3">
          {error && (
            <div className="p-2 bg-red-500/10 border border-red-500/20 rounded-md text-red-400 text-xs">
              {error}
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
            disabled={isLoading}
            className="btn btn-primary flex items-center gap-1.5 text-xs"
          >
            {isLoading && <LoadingSpinner size="sm" />}
            Change Password
          </button>
        </form>
      </div>

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
