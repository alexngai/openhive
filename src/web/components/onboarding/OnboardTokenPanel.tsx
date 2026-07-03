/**
 * OnboardTokenPanel — "run this in your agent's environment" copy-paste
 * onboarding (north-star P2.3). Mints a 24h onboard token via
 * POST /admin/onboard-token and renders the connect recipe.
 *
 * Minting requires admin authority. It works out of the box in local /
 * trusted-admin mode (the browser's auto-agent is admin); on a remote
 * non-admin hub the mint fails and we point the operator at the CLI.
 *
 * Used by the Connect dialog (Swarms) and settings' ConnectivityCard.
 */

import { useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { api } from '../../lib/api';
import { LoadingSpinner } from '../common/LoadingSpinner';

export function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied */
    }
  };
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          {label}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="btn btn-ghost p-1"
          aria-label={copied ? 'Copied' : `Copy ${label}`}
        >
          {copied ? (
            <Check className="w-3 h-3" style={{ color: 'rgb(34, 197, 94)' }} />
          ) : (
            <Copy className="w-3 h-3" />
          )}
        </button>
      </div>
      <pre
        className="text-2xs font-mono px-2 py-1.5 rounded overflow-x-auto whitespace-pre-wrap break-all"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        {value}
      </pre>
    </div>
  );
}

interface OnboardTokenResponse {
  agent_id: string;
  token: string;
  env: Record<string, string>;
  scopes: string[];
  ttl_hours: number;
  expires_at: string;
}

export function OnboardTokenPanel({ showNameField = true }: { showNameField?: boolean }) {
  const [agentName, setAgentName] = useState('');
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<OnboardTokenResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const wsOrigin = origin.replace(/^http/, 'ws');

  const handleMint = async () => {
    setMinting(true);
    setError(null);
    try {
      const res = await api.post<OnboardTokenResponse>('/admin/onboard-token', {
        scopes: ['map:agents:spawn'],
        ttl_hours: 24,
        ...(agentName.trim() ? { agent_name: agentName.trim() } : {}),
      });
      setMinted(res);
    } catch (err) {
      setError(
        `Could not mint a token: ${(err as Error).message}. ` +
          'Minting requires admin authority — on a remote hub, run ' +
          '`openhive admin onboard-token create` on the hub host instead.',
      );
    } finally {
      setMinting(false);
    }
  };

  const envLines = minted
    ? Object.entries(
        Object.keys(minted.env ?? {}).length > 0
          ? minted.env
          : { MAP_CREDENTIAL: minted.token },
      )
        .map(([k, v]) => `export ${k}="${v}"`)
        .join('\n')
    : '';

  return (
    <div className="space-y-3">
      <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
        Mint a 24h token, then run the export in your agent&apos;s environment.
        Any MAP-capable agent (Claude Code with cc-swarm, macro-agent, …) picks
        it up and registers with this hub.
      </p>

      {!minted ? (
        <>
          {showNameField && (
            <div>
              <label
                className="block text-2xs font-medium mb-1"
                style={{ color: 'var(--color-text-secondary)' }}
              >
                Agent name (optional)
              </label>
              <input
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                className="input w-full"
                placeholder="my-laptop-claude"
                maxLength={200}
              />
            </div>
          )}
          <button
            type="button"
            onClick={() => void handleMint()}
            disabled={minting}
            className="btn btn-primary flex items-center gap-1.5 text-xs"
          >
            {minting ? <LoadingSpinner size="sm" /> : <KeyRound className="w-3 h-3" />}
            Generate onboard token
          </button>
          {error && (
            <p className="text-2xs text-red-400" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <>
          <CopyBlock label="1. Set the credential" value={envLines} />
          <CopyBlock
            label="2. Connect (WebSocket MAP endpoint)"
            value={`${wsOrigin}/ws/map?swarm_id=<your-swarm-id>&token=$MAP_CREDENTIAL`}
          />
          <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            Token expires {new Date(minted.expires_at).toLocaleString()} · agent{' '}
            <code className="font-mono">{minted.agent_id}</code> · full protocol
            docs at{' '}
            <a
              href="/skill.md"
              target="_blank"
              rel="noreferrer"
              className="text-honey-500 hover:text-honey-400"
            >
              /skill.md
            </a>
          </p>
          <button
            type="button"
            onClick={() => setMinted(null)}
            className="btn btn-ghost text-xs"
          >
            Mint another
          </button>
        </>
      )}
    </div>
  );
}
