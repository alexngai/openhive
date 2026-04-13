/**
 * SwarmHub connection settings panel.
 *
 * Shows connection status when connected, or a "Connect to SwarmHub"
 * setup flow when not connected.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Wifi, WifiOff, ExternalLink, Copy, Check, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../stores/toast';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { TimeAgo } from '../../components/common/TimeAgo';

interface SwarmHubStatus {
  connected: boolean;
  status: string;
  identity: {
    id: string;
    slug: string;
    name: string;
    tier: string;
    endpoint_url: string | null;
  } | null;
  last_health_check: string | null;
  last_error: string | null;
  connected_at: string | null;
  tunnel_connected?: boolean;
}

interface RegisterResult {
  hive_id: string;
  slug: string;
  bridge_token: string;
  swarmhub_api_url: string;
  proxy_url: string;
}

export function SwarmHubSettings() {
  const queryClient = useQueryClient();
  const [showRegister, setShowRegister] = useState(false);
  const [registerUrl, setRegisterUrl] = useState('');
  const [registerToken, setRegisterToken] = useState('');
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const { data: status, isLoading } = useQuery<SwarmHubStatus>({
    queryKey: ['swarmhub-status'],
    queryFn: () => api.get('/swarmhub/status'),
    refetchInterval: 10_000,
    retry: false,
  });

  const disconnect = useMutation({
    mutationFn: () => api.post('/swarmhub/disconnect'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['swarmhub-status'] });
      toast.success('Disconnected from SwarmHub');
    },
  });

  const connect = useMutation({
    mutationFn: (data: { api_url: string; hive_token: string }) =>
      api.post<RegisterResult>('/swarmhub/connect', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['swarmhub-status'] });
      toast.success('Connected to SwarmHub');
      setShowRegister(false);
    },
    onError: (err) => {
      toast.error(`Connection failed: ${(err as Error).message}`);
    },
  });

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  if (isLoading) {
    return (
      <div className="card py-12 flex justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  // Connected state
  if (status?.connected && status.identity) {
    return (
      <div className="space-y-3">
        {/* Connection status */}
        <div className="card p-3">
          <div className="flex items-center gap-2 mb-2">
            <Wifi className="w-4 h-4 text-green-400" />
            <span className="text-xs font-medium" style={{ color: 'var(--color-text-primary)' }}>Connected to SwarmHub</span>
          </div>

          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt style={{ color: 'var(--color-text-tertiary)' }}>Hive</dt>
              <dd style={{ color: 'var(--color-text-secondary)' }} className="font-mono">{status.identity.slug}</dd>
            </div>
            <div>
              <dt style={{ color: 'var(--color-text-tertiary)' }}>Tier</dt>
              <dd style={{ color: 'var(--color-text-secondary)' }}>{status.identity.tier}</dd>
            </div>
            <div>
              <dt style={{ color: 'var(--color-text-tertiary)' }}>Connected since</dt>
              <dd style={{ color: 'var(--color-text-secondary)' }}>
                {status.connected_at ? <TimeAgo date={status.connected_at} /> : '—'}
              </dd>
            </div>
            <div>
              <dt style={{ color: 'var(--color-text-tertiary)' }}>Last health check</dt>
              <dd style={{ color: 'var(--color-text-secondary)' }}>
                {status.last_health_check ? <TimeAgo date={status.last_health_check} /> : '—'}
              </dd>
            </div>
          </dl>

          {status.identity.endpoint_url && (
            <a
              href={status.identity.endpoint_url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs text-honey-500 hover:text-honey-400"
            >
              {status.identity.endpoint_url} <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>

        {status.last_error && (
          <div
            className="p-2.5 rounded-lg border flex items-center gap-2 text-xs"
            style={{ backgroundColor: 'rgba(239, 68, 68, 0.06)', borderColor: 'rgba(239, 68, 68, 0.2)', color: 'rgb(239, 68, 68)' }}
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>Last error: {status.last_error}</span>
          </div>
        )}

        <button
          onClick={() => disconnect.mutate()}
          disabled={disconnect.isPending}
          className="btn btn-ghost text-xs"
          style={{ color: 'var(--color-text-tertiary)' }}
        >
          Disconnect
        </button>
      </div>
    );
  }

  // Not connected — show setup flow
  if (showRegister) {
    return (
      <div className="space-y-3">
        <div className="card p-3 space-y-3">
          <h3 className="text-xs font-medium" style={{ color: 'var(--color-text-primary)' }}>Connect to SwarmHub</h3>
          <p className="text-xs" style={{ color: 'var(--color-text-tertiary)' }}>
            Enter the credentials from your SwarmHub hive registration.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              connect.mutate({ api_url: registerUrl, hive_token: registerToken });
            }}
            className="space-y-2"
          >
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--color-text-secondary)' }}>SwarmHub API URL</label>
              <input
                type="url"
                value={registerUrl}
                onChange={(e) => setRegisterUrl(e.target.value)}
                placeholder="https://api.swarmkit.ai"
                required
                className="input w-full text-xs"
              />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--color-text-secondary)' }}>Bridge Token</label>
              <input
                type="password"
                value={registerToken}
                onChange={(e) => setRegisterToken(e.target.value)}
                placeholder="Paste your bridge token"
                required
                className="input w-full text-xs font-mono"
              />
            </div>

            {connect.isError && (
              <p className="text-xs text-red-400">{(connect.error as Error).message}</p>
            )}

            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={connect.isPending} className="btn btn-primary text-xs">
                {connect.isPending ? 'Connecting...' : 'Connect'}
              </button>
              <button type="button" onClick={() => { setShowRegister(false); setRegisterUrl(''); setRegisterToken(''); }} className="btn btn-ghost text-xs">
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="card p-3">
        <div className="flex items-center gap-2 mb-2">
          <WifiOff className="w-4 h-4" style={{ color: 'var(--color-text-tertiary)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>Not connected to SwarmHub</span>
        </div>
        <p className="text-xs mb-3" style={{ color: 'var(--color-text-tertiary)' }}>
          Connect this OpenHive instance to SwarmHub to enable remote access, webhook routing, and credential proxying.
        </p>
        <button onClick={() => setShowRegister(true)} className="btn btn-primary text-xs">
          Connect to SwarmHub
        </button>
      </div>
    </div>
  );
}
