import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Settings2, Check, AlertTriangle, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import clsx from 'clsx';

const SECRET_SENTINEL = '********';

interface SharedSettingTarget {
  packageName: string;
  configPath: string;
  currentValue?: unknown;
  inSync: boolean;
}

interface SharedSettingStatus {
  key: string;
  label: string;
  type: 'select' | 'password';
  currentValue?: unknown;
  choices?: Array<{ name: string; value: string }>;
  targets: SharedSettingTarget[];
}

export function SwarmKitSharedSettings({
  projectRoot,
  isAdmin,
}: {
  projectRoot: string | null;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();

  const { data } = useQuery<{ settings: SharedSettingStatus[] }>({
    queryKey: ['swarmkit-shared', projectRoot],
    queryFn: () =>
      api.get(
        projectRoot
          ? `/admin/swarmkit/shared?projectRoot=${encodeURIComponent(projectRoot)}`
          : '/admin/swarmkit/shared',
      ),
  });

  const propagateMutation = useMutation({
    mutationFn: (payload: { key: string; value: unknown }) =>
      api.patch('/admin/swarmkit/shared', {
        key: payload.key,
        value: payload.value,
        projectRoot,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['swarmkit-shared'] });
      queryClient.invalidateQueries({ queryKey: ['swarmkit-packages'] });
      toast.success('Setting propagated');
    },
    onError: () => {
      toast.error('Failed to propagate setting');
    },
  });

  const settings = data?.settings ?? [];
  if (settings.length === 0) return null;

  const allInSync = settings.every((s) =>
    s.targets.every((t) => t.inSync),
  );

  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--color-border)' }}>
      <div className="flex items-center gap-1.5 mb-2">
        <Settings2 className="w-3.5 h-3.5" style={{ color: 'var(--color-text-secondary)' }} />
        <span className="text-xs font-medium">Shared Settings</span>
        {allInSync ? (
          <Check className="w-3 h-3 text-green-500" />
        ) : (
          <AlertTriangle className="w-3 h-3 text-amber-500" />
        )}
      </div>
      <p className="text-2xs mb-3" style={{ color: 'var(--color-text-muted)' }}>
        Settings that apply across multiple SwarmKit packages.
      </p>

      <div className="space-y-3">
        {settings.map((setting) => (
          <SharedSettingRow
            key={setting.key}
            setting={setting}
            isAdmin={isAdmin}
            onPropagate={(value) =>
              propagateMutation.mutate({ key: setting.key, value })
            }
          />
        ))}
      </div>
    </div>
  );
}

function SharedSettingRow({
  setting,
  isAdmin,
  onPropagate,
}: {
  setting: SharedSettingStatus;
  isAdmin: boolean;
  onPropagate: (value: unknown) => void;
}) {
  const [localValue, setLocalValue] = useState<unknown>(setting.currentValue);
  const hasOutOfSync = setting.targets.some((t) => !t.inSync);

  return (
    <div>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <label className="text-2xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
            {setting.label}
          </label>
        </div>
        <div className="w-48 shrink-0 flex gap-1">
          {setting.type === 'select' && setting.choices ? (
            <select
              value={String(localValue ?? '')}
              onChange={(e) => setLocalValue(e.target.value)}
              disabled={!isAdmin}
              className="input flex-1 text-2xs py-1 px-2"
            >
              <option value="">Not set</option>
              {setting.choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="password"
              value={localValue === SECRET_SENTINEL ? SECRET_SENTINEL : String(localValue ?? '')}
              onChange={(e) => setLocalValue(e.target.value)}
              disabled={!isAdmin}
              className="input flex-1 text-2xs py-1 px-2"
              placeholder="Enter value"
            />
          )}
          {isAdmin && hasOutOfSync && (
            <button
              onClick={() => onPropagate(localValue)}
              className="flex items-center text-2xs px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 hover:bg-amber-500/20"
              title="Propagate to all packages"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Target sync indicators */}
      {setting.targets.length > 0 && (
        <div className="flex gap-2 mt-1 ml-0">
          {setting.targets.map((target) => (
            <span
              key={`${target.packageName}-${target.configPath}`}
              className="flex items-center gap-1 text-2xs"
              style={{ color: target.inSync ? 'rgb(34, 197, 94)' : 'rgb(245, 158, 11)', fontSize: '9px' }}
            >
              {target.inSync ? (
                <Check className="w-2.5 h-2.5" />
              ) : (
                <AlertTriangle className="w-2.5 h-2.5" />
              )}
              {target.packageName}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
