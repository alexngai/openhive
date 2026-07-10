/**
 * FirstRunPanel — day-zero guidance (north-star P2.2).
 *
 * A fresh instance's Dashboard used to greet the user with zero-stats;
 * this panel replaces that dead air with the three working entry paths:
 * spawn a hosted agent, connect an existing one, or write a spec (which
 * works out of the box now that the hub-default task graph exists, P2.4).
 *
 * Renders ONLY when both swarm queries have settled with zero rows —
 * loading states render nothing so the panel never flashes on populated
 * instances.
 */

import { Link } from 'react-router-dom';
import { FileText, Link2, Settings2, Sparkles, Zap } from 'lucide-react';
import { useHostedSwarms, useMapSwarms } from '../../hooks/useApi';

interface FirstRunPanelProps {
  /** Open the spawn dialog. Falls back to a /swarms link when omitted. */
  onSpawn?: () => void;
  /** Open the connect dialog. Falls back to a /swarms link when omitted. */
  onConnect?: () => void;
}

/**
 * True only when both queries have settled AND no swarm of either kind
 * exists. Exposed for the panel + any caller that wants to gate other UI.
 */
export function useIsFirstRun(): boolean {
  const hosted = useHostedSwarms();
  const map = useMapSwarms();
  if (!hosted.isSuccess || !map.isSuccess) return false;
  return (hosted.data?.data?.length ?? 0) + (map.data?.length ?? 0) === 0;
}

function Card({
  icon,
  title,
  body,
  badge,
  onClick,
  to,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  badge?: string;
  onClick?: () => void;
  to?: string;
}) {
  const inner = (
    <>
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          {title}
        </span>
        {badge && (
          <span
            className="text-2xs px-1.5 py-0.5 rounded-full bg-honey-500/15 text-honey-500"
          >
            {badge}
          </span>
        )}
      </div>
      <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
        {body}
      </p>
    </>
  );
  const className =
    'card p-4 text-left w-full transition-colors hover:border-honey-500/50 cursor-pointer block';

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {inner}
      </button>
    );
  }
  return (
    <Link to={to ?? '/swarms'} className={className}>
      {inner}
    </Link>
  );
}

export function FirstRunPanel({ onSpawn, onConnect }: FirstRunPanelProps) {
  const isFirstRun = useIsFirstRun();
  if (!isFirstRun) return null;

  return (
    <div className="card p-5" data-testid="first-run-panel">
      <div className="flex items-center gap-2 mb-1">
        <Sparkles className="w-4 h-4 text-honey-500" />
        <h2 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          Welcome to your hive
        </h2>
      </div>
      <p className="text-xs mb-4" style={{ color: 'var(--color-text-muted)' }}>
        No agents are connected yet. Pick a starting point:
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <Card
          icon={<Settings2 className="w-4 h-4 text-honey-500" />}
          title="Finish setting up this hub"
          body="Prerequisites, git store, swarm hosting, agent tokens — section by section, with a health check at the end."
          to="/onboarding"
        />
        <Card
          icon={<Zap className="w-4 h-4 text-honey-500" />}
          title="Spawn a hosted agent"
          body="Run Claude Code or Codex directly on this hub. Preflight checks tell you about missing binaries before you submit."
          onClick={onSpawn}
        />
        <Card
          icon={<Link2 className="w-4 h-4 text-honey-500" />}
          title="Connect an existing agent"
          body="Already running an agent elsewhere? Mint an onboard token and paste one line into its environment."
          onClick={onConnect}
        />
        <Card
          icon={<FileText className="w-4 h-4 text-honey-500" />}
          title="Create your first spec"
          body="Describe work in markdown, then dispatch agents against it later."
          badge="task graph included"
          to="/specs/new"
        />
      </div>
    </div>
  );
}
