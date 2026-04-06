import { useState, useCallback, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Package, Save, RotateCcw, FolderPlus } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import clsx from 'clsx';

const SECRET_SENTINEL = '********';

interface InlineOption {
  key: string;
  label: string;
  type: 'input' | 'select' | 'confirm' | 'password';
  default?: string | boolean | number;
  choices?: Array<{ name: string; value: string }>;
}

interface PackageData {
  packageName: string;
  scope: string;
  category: string;
  description: string;
  config: Record<string, unknown>;
  meta: {
    name: string;
    description: string;
    category: string;
    fields: Record<string, { label: string; description?: string; secret?: boolean }>;
    inlineOptions: InlineOption[];
    scopes: string[];
  };
  installed: boolean;
  configPath: string | null;
}

export function SwarmKitPackageCard({
  pkg,
  projectRoot,
  isAdmin,
}: {
  pkg: PackageData;
  projectRoot: string | null;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const [localConfig, setLocalConfig] = useState<Record<string, unknown>>(pkg.config);
  const [activeScope, setActiveScope] = useState<string>(pkg.scope);
  const [isDirty, setIsDirty] = useState(false);

  // Sync local state when props change (e.g., project selector changes, external save)
  useEffect(() => {
    setLocalConfig(pkg.config);
    setActiveScope(pkg.scope);
    setIsDirty(false);
  }, [pkg.config, pkg.scope]);

  const saveMutation = useMutation({
    mutationFn: (payload: { updates: Record<string, unknown>; scope: string }) =>
      api.patch(`/admin/swarmkit/packages/${pkg.packageName}`, {
        scope: payload.scope,
        updates: payload.updates,
        projectRoot,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['swarmkit-packages'] });
      setIsDirty(false);
      toast.success(`${pkg.packageName} config saved`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    },
  });

  const initMutation = useMutation({
    mutationFn: () =>
      api.post(`/admin/swarmkit/init/${pkg.packageName}`, {
        scope: activeScope,
        projectRoot,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['swarmkit-packages'] });
      toast.success(`${pkg.packageName} initialized`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to initialize');
    },
  });

  const hasNoConfig = !pkg.configPath || Object.keys(pkg.config).length === 0;
  const canInit = isAdmin && pkg.installed && hasNoConfig && projectRoot;

  const handleFieldChange = useCallback(
    (key: string, value: unknown) => {
      setLocalConfig((prev) => {
        const updated = { ...prev };
        setNestedValue(updated, key, value);
        return updated;
      });
      setIsDirty(true);
    },
    [],
  );

  const handleSave = () => {
    // Build diff: only include changed values
    const diff: Record<string, unknown> = {};
    for (const opt of pkg.meta.inlineOptions) {
      const current = getNestedValue(localConfig, opt.key);
      const original = getNestedValue(pkg.config, opt.key);
      if (current !== original && current !== SECRET_SENTINEL) {
        diff[opt.key] = current;
      }
    }
    if (Object.keys(diff).length > 0) {
      saveMutation.mutate({ updates: diff, scope: activeScope });
    }
  };

  const handleReset = () => {
    setLocalConfig(pkg.config);
    setIsDirty(false);
  };

  const hasMultipleScopes = pkg.meta.scopes.length > 1;
  const disabled = !isAdmin || !pkg.installed;

  return (
    <div
      className={clsx(
        'rounded-lg border p-3',
        !pkg.installed && 'opacity-50',
      )}
      style={{ borderColor: 'var(--color-border)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Package className="w-3.5 h-3.5" style={{ color: 'var(--color-text-secondary)' }} />
          <span className="text-xs font-medium">{pkg.packageName}</span>
          {!pkg.installed && (
            <span
              className="text-2xs px-1 py-0 rounded"
              style={{
                backgroundColor: 'var(--color-elevated)',
                color: 'var(--color-text-muted)',
                fontSize: '9px',
              }}
            >
              not installed
            </span>
          )}
          {pkg.meta.scopes.map((s) => (
            <span
              key={s}
              className="text-2xs px-1 py-0 rounded"
              style={{
                backgroundColor: s === 'global' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(34, 197, 94, 0.1)',
                color: s === 'global' ? 'rgb(59, 130, 246)' : 'rgb(34, 197, 94)',
                fontSize: '9px',
              }}
            >
              {s}
            </span>
          ))}
        </div>

        {isDirty && isAdmin && pkg.installed && (
          <div className="flex items-center gap-1">
            <button
              onClick={handleReset}
              className="flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded hover:bg-workspace-hover"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <RotateCcw className="w-3 h-3" />
              Reset
            </button>
            <button
              onClick={handleSave}
              disabled={saveMutation.isPending}
              className="flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded bg-honey-500/10 text-honey-500 hover:bg-honey-500/20"
            >
              <Save className="w-3 h-3" />
              Save
            </button>
          </div>
        )}
      </div>

      <p className="text-2xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
        {pkg.description}
      </p>

      {/* Scope tabs (if both global and project) */}
      {hasMultipleScopes && projectRoot && (
        <div className="flex gap-1 mb-2">
          {pkg.meta.scopes.map((s) => (
            <button
              key={s}
              onClick={() => setActiveScope(s)}
              className={clsx(
                'text-2xs px-2 py-0.5 rounded transition-colors',
                activeScope === s
                  ? 'bg-honey-500/10 text-honey-500'
                  : 'hover:bg-workspace-hover',
              )}
              style={activeScope !== s ? { color: 'var(--color-text-muted)' } : undefined}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Config fields */}
      {pkg.meta.inlineOptions.length > 0 ? (
        <div className="space-y-2">
          {pkg.meta.inlineOptions.map((opt) => (
            <PackageConfigField
              key={opt.key}
              option={opt}
              value={getNestedValue(localConfig, opt.key)}
              isSecret={pkg.meta.fields[opt.key]?.secret}
              disabled={disabled}
              onChange={(val) => handleFieldChange(opt.key, val)}
            />
          ))}
        </div>
      ) : (
        <p className="text-2xs italic" style={{ color: 'var(--color-text-muted)' }}>
          {pkg.installed ? 'No configurable settings' : 'Install this package to configure it'}
        </p>
      )}

      {/* Initialize button — shown when package is installed but has no config */}
      {canInit && (
        <button
          onClick={() => initMutation.mutate()}
          disabled={initMutation.isPending}
          className="flex items-center gap-1.5 mt-2 text-2xs px-2 py-1 rounded bg-honey-500/10 text-honey-500 hover:bg-honey-500/20"
        >
          <FolderPlus className="w-3 h-3" />
          {initMutation.isPending ? 'Initializing...' : 'Initialize'}
        </button>
      )}

      {/* Config path */}
      {pkg.configPath && (
        <p className="text-2xs mt-2" style={{ color: 'var(--color-text-muted)', fontSize: '9px' }}>
          {pkg.configPath}
        </p>
      )}
    </div>
  );
}

// ─── Field renderer ─────────────────────────────────────────────

function PackageConfigField({
  option,
  value,
  isSecret,
  disabled,
  onChange,
}: {
  option: InlineOption;
  value: unknown;
  isSecret?: boolean;
  disabled: boolean;
  onChange: (val: unknown) => void;
}) {
  const displayValue = value ?? option.default ?? '';

  return (
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <label className="text-2xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
            {option.label}
          </label>
          {isSecret && (
            <span
              className="text-2xs px-1 py-0 rounded"
              style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', color: 'rgb(239, 68, 68)', fontSize: '9px' }}
            >
              secret
            </span>
          )}
        </div>
      </div>
      <div className="w-48 shrink-0">
        {option.type === 'confirm' ? (
          <button
            onClick={() => !disabled && onChange(!displayValue)}
            disabled={disabled}
            className={clsx(
              'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
              displayValue ? 'bg-honey-500' : 'bg-gray-600',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            <span
              className={clsx(
                'inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform',
                displayValue ? 'translate-x-4.5' : 'translate-x-0.5',
              )}
            />
          </button>
        ) : option.type === 'select' && option.choices ? (
          <select
            value={String(displayValue)}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="input w-full text-2xs py-1 px-2"
          >
            {option.choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.name}
              </option>
            ))}
          </select>
        ) : option.type === 'password' ? (
          <input
            type="password"
            value={String(displayValue)}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="input w-full text-2xs py-1 px-2"
            placeholder="Enter value"
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

// ─── Helpers ────────────────────────────────────────────────────

function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const parts = keyPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): void {
  const parts = keyPath.split('.');
  let target = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof target[parts[i]] !== 'object' || target[parts[i]] === null) {
      target[parts[i]] = {};
    }
    target = target[parts[i]] as Record<string, unknown>;
  }
  target[parts[parts.length - 1]] = value;
}
