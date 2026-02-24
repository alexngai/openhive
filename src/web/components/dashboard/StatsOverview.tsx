import { Cpu, Wifi, Users, Hash } from 'lucide-react';
import { useMapStats } from '../../hooks/useApi';

const stats = [
  { key: 'swarms', label: 'Total Swarms', icon: Cpu, getValue: (d: ReturnType<typeof useMapStats>['data']) => d?.swarms.total ?? 0 },
  { key: 'online', label: 'Online', icon: Wifi, getValue: (d: ReturnType<typeof useMapStats>['data']) => d?.swarms.online ?? 0 },
  { key: 'agents', label: 'Agents', icon: Users, getValue: (d: ReturnType<typeof useMapStats>['data']) => d?.nodes.total ?? 0 },
  { key: 'hives', label: 'Hive Links', icon: Hash, getValue: (d: ReturnType<typeof useMapStats>['data']) => d?.hive_memberships ?? 0 },
] as const;

export function StatsOverview() {
  const { data, isLoading } = useMapStats();

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
      {stats.map(({ key, label, icon: Icon, getValue }) => (
        <div key={key} className="card px-3 py-2.5">
          <div className="flex items-center gap-2">
            <div
              className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
              style={{ backgroundColor: 'var(--color-accent-bg)' }}
            >
              <Icon className="w-3.5 h-3.5 text-honey-500" />
            </div>
            <div>
              <div className="text-lg font-semibold leading-tight">
                {isLoading ? (
                  <span className="inline-block w-6 h-5 rounded animate-pulse" style={{ backgroundColor: 'var(--color-elevated)' }} />
                ) : (
                  getValue(data)
                )}
              </div>
              <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
