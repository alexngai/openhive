import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

type VersionCheck = {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  deployment: 'electron' | 'web';
  instructions: string;
};

/**
 * Banner that surfaces when a newer openhive version is available on npm.
 *
 * Polls `/api/v1/version/check` hourly (server caches the upstream lookup
 * for the same period, so this is effectively free). Renders different CTAs
 * based on deployment mode:
 *   - electron: pointer to the OS-native update-ready notification
 *   - web:      one-line copy-pasteable upgrade command
 */
export function UpdateBanner() {
  const [dismissed, setDismissed] = useState(false);
  const { data } = useQuery<VersionCheck>({
    queryKey: ['version-check'],
    queryFn: async () => {
      const r = await fetch('/api/v1/version/check');
      if (!r.ok) throw new Error('version check failed');
      return r.json() as Promise<VersionCheck>;
    },
    // Poll once an hour. Server caches npm lookup same, so most polls are
    // DB-lookup-free on the server side.
    refetchInterval: 60 * 60 * 1000,
    // Don't retry aggressively; offline or registry-flaky is a normal state
    // and a banner not-appearing is a perfectly fine failure mode.
    retry: 1,
    // Don't spam on tab focus — hourly polling is plenty.
    refetchOnWindowFocus: false,
  });

  if (!data?.updateAvailable || dismissed) return null;

  return (
    <div
      className="flex items-center gap-3 px-4 py-2 text-sm border-b"
      style={{
        backgroundColor: 'var(--color-elevated)',
        borderColor: 'var(--color-border-subtle)',
      }}
      role="status"
    >
      <span className="text-honey-500">●</span>
      <span className="flex-1 min-w-0 truncate">
        OpenHive <strong>{data.latest}</strong> is available
        {' '}(you're on {data.current}).{' '}
        {data.deployment === 'electron' ? (
          <span style={{ color: 'var(--color-text-muted)' }}>
            The app will prompt to restart when the download finishes.
          </span>
        ) : (
          <span style={{ color: 'var(--color-text-muted)' }}>
            <a
              href="https://github.com/alexngai/openhive/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >Download from GitHub</a>
            {' '}and redeploy.
          </span>
        )}
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="btn-ghost text-xs px-2 py-1"
        aria-label="Dismiss update notification"
      >
        Dismiss
      </button>
    </div>
  );
}
