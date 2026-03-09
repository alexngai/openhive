import { Link } from 'react-router-dom';
import { Zap, Link2, Globe, Settings, ArrowRight, ExternalLink } from 'lucide-react';

export function StartSwarmCard() {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        <Zap className="w-4 h-4 text-honey-500" />
        <h3 className="text-sm font-semibold">Start a swarm</h3>
      </div>

      <p className="text-xs mb-4" style={{ color: 'var(--color-text-secondary)' }}>
        Spawn a new hosted swarm or connect an existing one to start coordinating agents.
      </p>

      <div className="flex items-center gap-2">
        <Link
          to="/swarms?action=spawn"
          className="btn btn-primary flex items-center gap-1.5 text-xs"
        >
          <Zap className="w-3 h-3" />
          Spawn swarm
        </Link>
        <Link
          to="/swarms?action=connect"
          className="btn btn-secondary flex items-center gap-1.5 text-xs"
        >
          <Link2 className="w-3 h-3" />
          Connect
        </Link>
      </div>
    </div>
  );
}

export function SetupCard() {
  const steps = [
    { label: 'Configure MAP', icon: Globe, to: '/settings', done: false },
    { label: 'Connect services', icon: Link2, to: '/settings', done: false },
    { label: 'Set up sync', icon: Settings, to: '/settings', done: false },
  ];

  return (
    <div
      className="card overflow-hidden"
      style={{ borderColor: 'var(--color-border)' }}
    >
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-honey-500" />
          <h3 className="text-sm font-semibold">Get connected</h3>
        </div>
        <span
          className="text-2xs px-1.5 py-0.5 rounded-md font-medium"
          style={{ backgroundColor: 'var(--color-accent-bg)', color: 'var(--color-accent)' }}
        >
          0/{steps.length}
        </span>
      </div>

      <div className="px-4 pb-3">
        <p className="text-xs mb-3" style={{ color: 'var(--color-text-secondary)' }}>
          Set up federation and connect your tools.
        </p>

        <div className="space-y-1.5">
          {steps.map((step) => (
            <Link
              key={step.label}
              to={step.to}
              className="flex items-center gap-2 px-2.5 py-2 rounded-md transition-colors"
              style={{ backgroundColor: 'var(--color-elevated)' }}
            >
              <step.icon className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
              <span className="text-xs flex-1">{step.label}</span>
              <ArrowRight className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
            </Link>
          ))}
        </div>
      </div>

      <div
        className="px-4 py-3 flex items-center gap-3"
        style={{ borderTop: '1px solid var(--color-border-subtle)' }}
      >
        <Link
          to="/settings"
          className="btn btn-secondary flex items-center gap-1.5 text-xs"
        >
          Settings
        </Link>
        <a
          href="https://github.com/openhive"
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-ghost flex items-center gap-1.5 text-xs"
        >
          View docs <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  );
}

export function SwarmsSidePanel() {
  return null; // Placeholder — SwarmStatusSummary handles this
}
