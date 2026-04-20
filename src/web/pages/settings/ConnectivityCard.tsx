import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, AlertTriangle } from 'lucide-react';

/**
 * Connection-info panel for the Server settings tab. Surfaces the URLs,
 * endpoints, and identity that an agent operator would need to point
 * a sidecar / swarm / federated peer at this hive.
 *
 * All endpoint values are derived from `window.location.origin` (the truth
 * — it's the URL the browser actually used to reach the hive) rather than
 * the configured `instance.url`, which can drift when the user binds to
 * port 0 or runs behind a reverse proxy. Hive identity (name, mode) comes
 * from /.well-known/openhive.json which is unauthenticated and stable.
 */

interface WellKnown {
  name?: string;
  mode?: string;
  url?: string;
  capabilities?: {
    map_hub?: { enabled?: boolean; trust_model?: string };
    sync?: { enabled?: boolean };
  };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function ConnectivityCard() {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const wsOrigin = origin.replace(/^http/, 'ws');
  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
  const isLoopback = LOOPBACK_HOSTS.has(hostname);

  // /.well-known is public — fetch directly, bypassing the /api/v1 client.
  const { data } = useQuery<WellKnown>({
    queryKey: ['well-known-openhive'],
    queryFn: async () => {
      const res = await fetch('/.well-known/openhive.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
    retry: 1,
  });

  const rows: Array<{ label: string; value: string; hint?: string }> = [
    { label: 'Hub URL',   value: origin, hint: 'Point sidecars and federated peers here' },
    { label: 'WebSocket', value: `${wsOrigin}/ws` },
    { label: 'API base',  value: `${origin}/api/v1` },
  ];
  if (data?.capabilities?.map_hub?.enabled) {
    rows.push({ label: 'MAP hub', value: `${origin}/api/v1/map`, hint: 'Agent registration + ACP routing' });
  }
  if (data?.capabilities?.sync?.enabled) {
    rows.push({ label: 'Sync',    value: `${origin}/sync/v1`, hint: 'Federated mesh peers' });
  }
  rows.push({ label: 'Discovery', value: `${origin}/.well-known/openhive.json` });

  return (
    <div className="card p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold flex items-center gap-1.5">
            Connectivity
          </h3>
          <p className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
            Endpoints for connecting agents and sidecars to this hive.
          </p>
        </div>
        {data?.mode && (
          <span
            className="text-2xs px-1.5 py-0.5 rounded font-medium"
            style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text-secondary)' }}
          >
            {data.mode} mode
          </span>
        )}
      </div>

      <div className="space-y-1">
        {rows.map((row) => <CopyRow key={row.label} {...row} />)}
      </div>

      {isLoopback && (
        <div
          className="p-2 rounded-md flex items-start gap-2 text-2xs"
          style={{
            backgroundColor: 'rgba(245, 158, 11, 0.06)',
            borderLeft: '2px solid rgb(245, 158, 11)',
            color: 'var(--color-text-secondary)',
          }}
        >
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" style={{ color: 'rgb(245, 158, 11)' }} />
          <div>
            <div className="font-medium" style={{ color: 'rgb(245, 158, 11)' }}>Bound to loopback</div>
            <div className="mt-0.5">
              Agents on other machines can't reach this URL. To accept LAN connections,
              set <code className="font-mono">host: '0.0.0.0'</code> in your config and restart.
            </div>
          </div>
        </div>
      )}

      {(data?.name || data?.url) && (
        <div className="pt-2 border-t space-y-1" style={{ borderColor: 'var(--color-border-subtle)' }}>
          {data?.name && <Field label="Instance"  value={data.name} />}
          {data?.url && data.url !== origin && (
            <Field label="Configured URL" value={data.url} />
          )}
        </div>
      )}

      <p className="text-2xs pt-1" style={{ color: 'var(--color-text-muted)' }}>
        Agents authenticate with API keys or pre-auth keys — generate them in the API Keys tab.
      </p>
    </div>
  );
}

function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied — silently fall through */
    }
  };
  return (
    <div className="flex items-center gap-2 text-2xs">
      <div className="w-24 shrink-0 truncate" style={{ color: 'var(--color-text-muted)' }} title={hint}>
        {label}
      </div>
      <code
        className="flex-1 truncate font-mono px-1.5 py-1 rounded"
        style={{ backgroundColor: 'var(--color-elevated)' }}
        title={value}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={onCopy}
        className="btn btn-ghost p-1 shrink-0"
        title={copied ? 'Copied' : 'Copy'}
        aria-label={copied ? 'Copied' : `Copy ${label}`}
      >
        {copied ? <Check className="w-3 h-3" style={{ color: 'rgb(34, 197, 94)' }} /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-2xs">
      <div className="w-24 shrink-0" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
      <span className="flex-1 truncate font-mono" title={value}>{value}</span>
    </div>
  );
}
