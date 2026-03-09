import { useState, useMemo } from 'react';
import { ArrowRight, HelpCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useMapStats } from '../../hooks/useApi';
import { Sparkline } from './Sparkline';

type Period = '7d' | '30d' | '90d';

// Generate mock sparkline data based on a current value + period
function generateSparkData(currentValue: number, points: number): number[] {
  const data: number[] = [];
  for (let i = 0; i < points; i++) {
    const progress = i / (points - 1);
    // Trend upward toward current value with some noise
    const base = currentValue * (0.3 + 0.7 * progress);
    const noise = (Math.random() - 0.5) * currentValue * 0.3;
    data.push(Math.max(0, Math.round(base + noise)));
  }
  // Ensure last value matches current
  data[data.length - 1] = currentValue;
  return data;
}

export function UsageCard() {
  const [period, setPeriod] = useState<Period>('7d');
  const { data } = useMapStats();

  const pointCount = period === '7d' ? 7 : period === '30d' ? 30 : 90;

  const topStats = [
    { label: 'SWARMS ONLINE', value: data?.swarms.online ?? 0, tip: 'Currently connected swarms' },
    { label: 'TOTAL AGENTS', value: data?.nodes.total ?? 0, tip: 'Registered agent nodes' },
    { label: 'ACTIVE NODES', value: data?.nodes.active ?? 0, tip: 'Nodes currently active' },
    { label: 'HIVE LINKS', value: data?.hive_memberships ?? 0, tip: 'Cross-hive memberships' },
  ];

  const sparkStats = useMemo(() => [
    {
      label: `SWARMS · ${period.toUpperCase()}`,
      value: data?.swarms.total ?? 0,
      data: generateSparkData(data?.swarms.total ?? 0, pointCount),
    },
    {
      label: `AGENTS · ${period.toUpperCase()}`,
      value: data?.nodes.total ?? 0,
      data: generateSparkData(data?.nodes.total ?? 0, pointCount),
    },
    {
      label: 'ONLINE RATIO',
      value: data?.swarms.total
        ? `${Math.round((data.swarms.online / data.swarms.total) * 100)}%`
        : '—',
      data: generateSparkData(
        data?.swarms.total ? Math.round((data.swarms.online / data.swarms.total) * 100) : 0,
        pointCount
      ),
    },
  ], [data, period, pointCount]);

  return (
    <div className="card overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <h2 className="text-sm font-semibold">Usage</h2>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--color-border)' }}>
            {(['7d', '30d', '90d'] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className="px-2.5 py-1 text-2xs font-medium transition-colors"
                style={{
                  backgroundColor: period === p ? 'var(--color-elevated)' : 'transparent',
                  color: period === p ? 'var(--color-text)' : 'var(--color-text-muted)',
                }}
              >
                {p}
              </button>
            ))}
          </div>
          <Link
            to="/swarms"
            className="w-7 h-7 rounded-md flex items-center justify-center transition-colors"
            style={{ border: '1px solid var(--color-border)' }}
          >
            <ArrowRight className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
          </Link>
        </div>
      </div>

      {/* Top stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
        {topStats.map((stat, i) => (
          <div
            key={stat.label}
            className="px-4 py-3"
            style={i > 0 ? { borderLeft: '1px solid var(--color-border-subtle)' } : undefined}
          >
            <div className="flex items-center gap-1 mb-1">
              <span className="text-2xs font-medium tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
                {stat.label}
              </span>
              <HelpCircle className="w-2.5 h-2.5" style={{ color: 'var(--color-text-muted)', opacity: 0.5 }} />
            </div>
            <span className="text-lg font-semibold">{stat.value}</span>
          </div>
        ))}
      </div>

      {/* Sparkline stats row */}
      <div className="grid grid-cols-1 md:grid-cols-3" style={{ borderTop: '1px solid var(--color-border-subtle)' }}>
        {sparkStats.map((stat, i) => (
          <div
            key={stat.label}
            className="px-4 py-3 flex items-end justify-between"
            style={i > 0 ? { borderLeft: '1px solid var(--color-border-subtle)' } : undefined}
          >
            <div>
              <div className="flex items-center gap-1 mb-1">
                <span className="text-2xs font-medium tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
                  {stat.label}
                </span>
                <HelpCircle className="w-2.5 h-2.5" style={{ color: 'var(--color-text-muted)', opacity: 0.5 }} />
              </div>
              <span className="text-lg font-semibold">{stat.value}</span>
            </div>
            <Sparkline data={stat.data} width={100} height={36} />
          </div>
        ))}
      </div>
    </div>
  );
}
