import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link2, ChevronDown, ChevronRight, Save } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import clsx from 'clsx';

interface IntegrationConfigOption {
  key: string;
  label: string;
  type: 'confirm' | 'input' | 'select';
  default?: string | boolean;
  choices?: Array<{ name: string; value: string }>;
  targetPackage: string;
  configPath: string;
  currentValue?: unknown;
}

interface IntegrationResponse {
  id: string;
  packages: [string, string];
  description: string;
  requiresWiring: boolean;
  active: boolean;
  configOptions: IntegrationConfigOption[];
}

export function SwarmKitIntegrations({
  projectRoot,
  isAdmin,
}: {
  projectRoot: string | null;
  isAdmin: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const { data } = useQuery<{ integrations: IntegrationResponse[] }>({
    queryKey: ['swarmkit-integrations', projectRoot],
    queryFn: () =>
      api.get(
        projectRoot
          ? `/admin/swarmkit/integrations?projectRoot=${encodeURIComponent(projectRoot)}`
          : '/admin/swarmkit/integrations',
      ),
  });

  const integrations = data?.integrations ?? [];
  const activeIntegrations = integrations.filter((i) => i.active);

  if (integrations.length === 0) return null;

  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)' }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
        ) : (
          <ChevronRight className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
        )}
        <Link2 className="w-3.5 h-3.5" style={{ color: 'var(--color-text-secondary)' }} />
        <span className="text-xs font-medium">Integrations</span>
        <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          ({activeIntegrations.length} active)
        </span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          {integrations.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              projectRoot={projectRoot}
              isAdmin={isAdmin}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function IntegrationCard({
  integration,
  projectRoot,
  isAdmin,
}: {
  integration: IntegrationResponse;
  projectRoot: string | null;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const buildValues = () => {
    const values: Record<string, unknown> = {};
    for (const opt of integration.configOptions) {
      values[opt.key] = opt.currentValue ?? opt.default;
    }
    return values;
  };

  const [localValues, setLocalValues] = useState<Record<string, unknown>>(buildValues);
  const [isDirty, setIsDirty] = useState(false);

  // Sync local state when integration data changes
  useEffect(() => {
    setLocalValues(buildValues());
    setIsDirty(false);
  }, [integration]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch(`/admin/swarmkit/integrations/${integration.id}`, {
        updates: localValues,
        projectRoot,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['swarmkit-integrations'] });
      queryClient.invalidateQueries({ queryKey: ['swarmkit-packages'] });
      setIsDirty(false);
      toast.success('Integration updated');
    },
    onError: () => {
      toast.error('Failed to update integration');
    },
  });

  const [a, b] = integration.packages;
  const disabled = !isAdmin || !integration.active;

  return (
    <div
      className={clsx(
        'rounded border p-2',
        !integration.active && 'opacity-50',
      )}
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <span className="text-2xs font-medium">{a}</span>
          <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>↔</span>
          <span className="text-2xs font-medium">{b}</span>
          {!integration.requiresWiring && (
            <span
              className="text-2xs px-1 py-0 rounded"
              style={{
                backgroundColor: 'rgba(34, 197, 94, 0.1)',
                color: 'rgb(34, 197, 94)',
                fontSize: '9px',
              }}
            >
              auto-detected
            </span>
          )}
          {!integration.active && (
            <span
              className="text-2xs px-1 py-0 rounded"
              style={{
                backgroundColor: 'var(--color-elevated)',
                color: 'var(--color-text-muted)',
                fontSize: '9px',
              }}
            >
              inactive
            </span>
          )}
        </div>

        {isDirty && isAdmin && integration.active && (
          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded bg-honey-500/10 text-honey-500 hover:bg-honey-500/20"
          >
            <Save className="w-3 h-3" />
            Save
          </button>
        )}
      </div>

      <p className="text-2xs mb-2" style={{ color: 'var(--color-text-muted)', fontSize: '9px' }}>
        {integration.description}
      </p>

      {integration.configOptions.length > 0 && integration.active && (
        <div className="space-y-1.5">
          {integration.configOptions.map((opt) => (
            <IntegrationField
              key={opt.key}
              option={opt}
              value={localValues[opt.key]}
              disabled={disabled}
              onChange={(val) => {
                setLocalValues((prev) => ({ ...prev, [opt.key]: val }));
                setIsDirty(true);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function IntegrationField({
  option,
  value,
  disabled,
  onChange,
}: {
  option: IntegrationConfigOption;
  value: unknown;
  disabled: boolean;
  onChange: (val: unknown) => void;
}) {
  const displayValue = value ?? option.default ?? '';

  return (
    <div className="flex items-center gap-3">
      <label className="flex-1 text-2xs" style={{ color: 'var(--color-text-secondary)' }}>
        {option.label}
      </label>
      <div className="w-40 shrink-0">
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
