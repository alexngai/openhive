/**
 * Register-repo modal — surface for the user-defined repo creation path.
 *
 * Important: this *registers* an existing remote URL with OpenHive. It does
 * NOT create a git repository on any forge or initialize anything locally.
 * The remote must already exist; OpenHive only stores a typed pointer to it
 * so the URL becomes a first-class citizen (federatable, linkable, queryable).
 *
 * After successful registration, navigate to the new repo's detail page.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GitBranch, AlertCircle, Globe, Lock, Server } from 'lucide-react';
import { Dialog } from '../common/Dialog';
import { useCreateRepo } from '../../hooks/useApi';

type RepoVisibility = 'private' | 'hub_local' | 'federated';

interface VisibilityOption {
  value: RepoVisibility;
  label: string;
  hint: string;
  icon: typeof Globe;
}

const VISIBILITY_OPTIONS: VisibilityOption[] = [
  {
    value: 'private',
    label: 'Private',
    hint: 'Only you can see this repo on this hub.',
    icon: Lock,
  },
  {
    value: 'hub_local',
    label: 'Hub-local',
    hint: 'Visible to anyone on this hub. Does not federate to peer hubs.',
    icon: Server,
  },
  {
    value: 'federated',
    label: 'Federated',
    hint: 'Replicated to peer hubs you sync with. Reversible — downgrade emits a redaction.',
    icon: Globe,
  },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function RegisterRepoModal({ open, onClose }: Props) {
  const navigate = useNavigate();
  const createRepo = useCreateRepo();

  const [remoteUrl, setRemoteUrl] = useState('');
  const [name, setName] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<RepoVisibility>('hub_local');
  const [bindingPolicy, setBindingPolicy] = useState<'open' | 'closed'>('open');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setRemoteUrl('');
    setName('');
    setDefaultBranch('');
    setDescription('');
    setVisibility('hub_local');
    setBindingPolicy('open');
    setShowAdvanced(false);
    setError(null);
    createRepo.reset();
  }

  function close() {
    reset();
    onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!remoteUrl.trim()) {
      setError('Remote URL is required');
      return;
    }

    try {
      const res = await createRepo.mutateAsync({
        remote_url: remoteUrl.trim(),
        ...(name.trim() && { name: name.trim() }),
        ...(defaultBranch.trim() && { default_branch: defaultBranch.trim() }),
        ...(description.trim() && { description: description.trim() }),
        visibility,
        // Only send `binding_policy` when user explicitly opened Advanced
        // and chose 'closed' — server default is 'open'.
        ...(showAdvanced && bindingPolicy === 'closed' && { binding_policy: bindingPolicy }),
      });
      reset();
      onClose();
      navigate(`/repos/${res.repo.id}`);
    } catch (err) {
      setError((err as Error).message || 'Failed to register repo');
    }
  }

  return (
    <Dialog open={open} onClose={close} maxWidth="max-w-xl">
      <form onSubmit={handleSubmit}>
        <div
          className="px-5 py-4 border-b flex items-center gap-3"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: 'var(--color-elevated)' }}
          >
            <GitBranch className="w-4 h-4 text-honey-500" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">Register repo</h2>
            <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
              Track an existing repository. OpenHive will not create or clone anything —
              the remote URL must already exist.
            </p>
          </div>
        </div>

        <div className="p-5 space-y-4">
          {/* Remote URL */}
          <div>
            <label className="text-xs font-medium block mb-1">
              Remote URL <span className="text-rose-400">*</span>
            </label>
            <input
              type="text"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="https://github.com/org/repo or git@github.com:org/repo.git"
              className="input text-sm py-1.5 w-full font-mono"
              autoFocus
            />
            <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              Will be canonicalized — `https://`, `git@`, and `.git` suffix all resolve to the same identity.
            </p>
          </div>

          {/* Name */}
          <div>
            <label className="text-xs font-medium block mb-1">
              Name <span style={{ color: 'var(--color-text-muted)' }}>(optional)</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Defaults to the repo name from the URL"
              className="input text-sm py-1.5 w-full"
            />
          </div>

          {/* Default branch */}
          <div>
            <label className="text-xs font-medium block mb-1">
              Default branch <span style={{ color: 'var(--color-text-muted)' }}>(optional)</span>
            </label>
            <input
              type="text"
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              placeholder="main"
              className="input text-sm py-1.5 w-full font-mono"
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-medium block mb-1">
              Description <span style={{ color: 'var(--color-text-muted)' }}>(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="What's in this repo?"
              className="input text-sm py-1.5 w-full"
            />
          </div>

          {/* Visibility */}
          <fieldset>
            <legend className="text-xs font-medium mb-1.5">Visibility</legend>
            <div className="space-y-1.5">
              {VISIBILITY_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const checked = visibility === opt.value;
                return (
                  <label
                    key={opt.value}
                    className="flex items-start gap-3 p-2.5 rounded cursor-pointer transition-colors"
                    style={{
                      backgroundColor: checked ? 'var(--color-hover)' : 'transparent',
                      border: '1px solid',
                      borderColor: checked ? 'var(--color-honey-500)' : 'var(--color-border-subtle)',
                    }}
                  >
                    <input
                      type="radio"
                      name="visibility"
                      checked={checked}
                      onChange={() => setVisibility(opt.value)}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5 text-xs font-medium">
                        <Icon className="w-3 h-3" />
                        {opt.label}
                      </div>
                      <p
                        className="text-2xs mt-0.5"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        {opt.hint}
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* Advanced */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-2xs hover:underline"
              style={{ color: 'var(--color-text-muted)' }}
            >
              {showAdvanced ? '− Hide advanced' : '+ Advanced settings'}
            </button>
            {showAdvanced && (
              <fieldset className="mt-2">
                <legend className="text-xs font-medium mb-1.5">Binding policy</legend>
                <div className="space-y-1.5">
                  {([
                    { value: 'open' as const, label: 'Open', hint: 'Any agent that finds this canonical URL can attach a workspace binding.' },
                    { value: 'closed' as const, label: 'Closed', hint: 'New bindings are rejected. Use after migration / rename when you want to freeze the repo from new attachments.' },
                  ]).map((opt) => {
                    const checked = bindingPolicy === opt.value;
                    return (
                      <label
                        key={opt.value}
                        className="flex items-start gap-3 p-2 rounded cursor-pointer transition-colors"
                        style={{
                          backgroundColor: checked ? 'var(--color-hover)' : 'transparent',
                          border: '1px solid',
                          borderColor: checked ? 'var(--color-honey-500)' : 'var(--color-border-subtle)',
                        }}
                      >
                        <input
                          type="radio"
                          name="binding_policy"
                          checked={checked}
                          onChange={() => setBindingPolicy(opt.value)}
                          className="mt-1"
                        />
                        <div className="flex-1">
                          <div className="text-xs font-medium">{opt.label}</div>
                          <p className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                            {opt.hint}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}
          </div>

          {/* Error */}
          {error && (
            <div
              className="flex items-start gap-2 p-2.5 rounded text-xs"
              style={{ backgroundColor: 'rgba(244, 63, 94, 0.1)', color: 'var(--color-text)' }}
            >
              <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div
          className="px-5 py-3 border-t flex items-center justify-end gap-2"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          <button
            type="button"
            onClick={close}
            className="btn btn-ghost text-xs"
            disabled={createRepo.isPending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary text-xs"
            disabled={createRepo.isPending || !remoteUrl.trim()}
          >
            {createRepo.isPending ? 'Registering…' : 'Register repo'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
