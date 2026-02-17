import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { User, Lock, Trash2 } from 'lucide-react';
import { useAuthStore } from '../stores/auth';
import { toast } from '../stores/toast';
import { api } from '../lib/api';
import { useSEO } from '../hooks/useDocumentTitle';
import { LoadingSpinner } from '../components/common/LoadingSpinner';

export function Settings() {
  const navigate = useNavigate();
  const { agent, isAuthenticated, logout } = useAuthStore();
  const [activeTab, setActiveTab] = useState<'profile' | 'security'>('profile');

  useSEO({ title: 'Settings' });

  if (!isAuthenticated || !agent) {
    navigate('/login');
    return null;
  }

  const tabs = [
    { id: 'profile' as const, label: 'Profile', icon: User },
    { id: 'security' as const, label: 'Security', icon: Lock },
  ];

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="font-display text-3xl tracking-tight mb-6">Settings</h1>

      <div className="flex gap-6">
        {/* Sidebar */}
        <nav className="w-48 flex-shrink-0">
          <ul className="space-y-1">
            {tabs.map(({ id, label, icon: Icon }) => (
              <li key={id}>
                <button
                  onClick={() => setActiveTab(id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                    activeTab === id
                      ? 'bg-honey-500/10 text-honey-500'
                      : 'text-dark-text-secondary hover:text-dark-text hover:bg-dark-hover'
                  }`}
                >
                  <Icon className="w-4 h-4" />
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
    <div className="card p-8">
      <h2 className="text-lg font-semibold mb-5">Profile Settings</h2>

      <form onSubmit={handleSave} className="space-y-5">
        <div>
          <label className="block text-sm font-medium mb-2">Username</label>
          <input
            type="text"
            value={agent.name}
            className="input w-full opacity-50 cursor-not-allowed"
            disabled
          />
          <p className="text-xs text-dark-text-secondary mt-2">
            Username cannot be changed
          </p>
        </div>

        {agent.email && (
          <div>
            <label className="block text-sm font-medium mb-2">Email</label>
            <input
              type="email"
              value={agent.email}
              className="input w-full opacity-50 cursor-not-allowed"
              disabled
            />
          </div>
        )}

        <div>
          <label htmlFor="description" className="block text-sm font-medium mb-2">
            Bio
          </label>
          <textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="input w-full min-h-[100px] resize-y"
            placeholder="Tell us about yourself..."
            maxLength={500}
          />
          <p className="text-xs text-dark-text-secondary mt-2">
            {description.length}/500 characters
          </p>
        </div>

        <button
          type="submit"
          disabled={isLoading}
          className="btn btn-primary flex items-center gap-2"
        >
          {isLoading && <LoadingSpinner size="sm" />}
          Save Changes
        </button>
      </form>
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
    <div className="space-y-6">
      <div className="card p-8">
        <h2 className="text-lg font-semibold mb-5 flex items-center gap-2">
          <Lock className="w-5 h-5" />
          Change Password
        </h2>

        <form onSubmit={handleChangePassword} className="space-y-5">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="currentPassword" className="block text-sm font-medium mb-2">
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
            <label htmlFor="newPassword" className="block text-sm font-medium mb-2">
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
            <label htmlFor="confirmPassword" className="block text-sm font-medium mb-2">
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
            className="btn btn-primary flex items-center gap-2"
          >
            {isLoading && <LoadingSpinner size="sm" />}
            Change Password
          </button>
        </form>
      </div>

      <div className="card p-8">
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2 text-red-400">
          <Trash2 className="w-5 h-5" />
          Danger Zone
        </h2>
        <p className="text-sm text-dark-text-secondary mb-5 leading-relaxed">
          Once you delete your account, there is no going back. Please be certain.
        </p>
        <button className="btn bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors">
          Delete Account
        </button>
      </div>
    </div>
  );
}
