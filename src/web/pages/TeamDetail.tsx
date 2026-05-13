/**
 * Team Template Detail Page — read-only summary of an authored
 * `team_template` syncable resource. Mirrors the Skills/Memory pattern:
 * the list page (`/teams`) renders cards that link here; the
 * visual editor (`/teams/:id/editor`) is reached via the Edit button.
 *
 * Information surfaced:
 *   - Identity: name, description, visibility, scope, sync_strategy,
 *     timestamps, optional git_remote_url.
 *   - Content addressing: bundle hash (computed on-demand via
 *     `GET /teams/:id/bundle`), short + full forms with copy.
 *   - Manifest summary: version, root role, companion roles, role
 *     count, channel count.
 *   - Roles: one card per role with capabilities + (when present) an
 *     embedded-loadout pointer.
 *   - Topology: spawn-rules / signal-routing summary at a glance.
 *   - Loadouts: any team-embedded loadouts (the standalone `loadout`
 *     resources have their own list at `/loadouts`).
 *
 * Permissions / RBAC are enforced server-side by `GET /teams/:id`; this
 * page renders a friendly 404 when the agent has no access.
 */

import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Users,
  Clock,
  Tag,
  Copy,
  Check,
  Hash,
  Pencil,
  GitBranch,
} from 'lucide-react';
import { api, type SyncableResource } from '../lib/api';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';

interface TeamRole {
  name?: string;
  capabilities?: unknown;
  capabilities_add?: string[];
  capabilities_remove?: string[];
  extends?: string;
  loadout?: unknown;
}

interface TeamManifest {
  name?: string;
  description?: string;
  version?: number | string;
  roles?: string[];
  topology?: {
    root?: { role?: string };
    companions?: Array<{ role?: string }>;
    spawn_rules?: Record<string, unknown>;
  };
  communication?: {
    channels?: Record<string, unknown>;
    subscriptions?: unknown;
    emissions?: unknown;
    enforcement?: string;
  };
}

interface TeamContent {
  manifest?: TeamManifest;
  roles?: Record<string, TeamRole>;
  loadouts?: Record<string, Record<string, unknown>>;
  prompts?: Record<string, unknown>;
}

export default function TeamDetail() {
  const { id } = useParams<{ id: string }>();
  const [resource, setResource] = useState<SyncableResource | null>(null);
  const [bundleId, setBundleId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ team_template: SyncableResource }>(`/teams/${id}`);
        if (!cancelled) setResource(res.team_template);
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // Bundle hash is computed server-side via the dedicated endpoint —
  // separate request so the detail page renders even if the row has no
  // inline content yet (e.g. a git-backed row pre-first-pull).
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get<{ bundle_id: string }>(`/teams/${id}/bundle`);
        if (!cancelled) setBundleId(r.bundle_id);
      } catch {
        // Non-fatal — content might be unavailable yet; leave bundleId null.
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  if (loadError) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6">
        <BackLink />
        <div className="card p-8 text-center">
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Team template not found
          </p>
          <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            {loadError}
          </p>
        </div>
      </div>
    );
  }

  if (!resource) return <PageLoader />;

  const content =
    ((resource.metadata as { content?: TeamContent } | null)?.content) || {};
  const manifest = content.manifest || {};
  const roleNames = manifest.roles ?? [];
  const roleMap = content.roles || {};
  const loadoutMap = content.loadouts || {};
  const topology = manifest.topology || {};
  const rootRole = topology.root?.role;
  const companions = (topology.companions ?? []).map((c) => c.role).filter(Boolean) as string[];
  const channels = manifest.communication?.channels || {};
  const channelCount = Object.keys(channels).length;
  const loadoutCount = Object.keys(loadoutMap).length;

  const shortHash = bundleId ? bundleId.replace(/^sha256:/, '').slice(0, 12) : null;

  const copyBundle = async () => {
    if (!bundleId) return;
    try {
      await navigator.clipboard.writeText(bundleId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      {/* Header */}
      <div>
        <BackLink />
        <div className="flex items-start justify-between gap-4 mt-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: 'var(--color-elevated)' }}
            >
              <Users className="w-5 h-5 text-honey-500" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold truncate">{resource.name}</h1>
              {resource.description && (
                <p
                  className="text-xs mt-0.5"
                  style={{ color: 'var(--color-text-secondary)' }}
                >
                  {resource.description}
                </p>
              )}
            </div>
          </div>
          <Link
            to={`/teams/${resource.id}/editor`}
            className="btn btn-primary flex items-center gap-1.5 shrink-0"
          >
            <Pencil className="w-4 h-4" />
            Edit
          </Link>
        </div>

        {/* Metadata chips */}
        <div
          className="flex items-center flex-wrap gap-3 mt-3 text-2xs"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <span className="capitalize px-2 py-0.5 rounded" style={{ backgroundColor: 'var(--color-elevated)' }}>
            {resource.visibility}
          </span>
          <span className="flex items-center gap-1">
            <Tag className="w-3 h-3" />
            {resource.scope} / {resource.sync_strategy}
          </span>
          {resource.updated_at && (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              updated <TimeAgo date={resource.updated_at} />
            </span>
          )}
          {resource.git_remote_url && !resource.git_remote_url.startsWith('local://') && (
            <span className="flex items-center gap-1">
              <GitBranch className="w-3 h-3" />
              <span className="font-mono">{resource.git_remote_url}</span>
            </span>
          )}
        </div>
      </div>

      {/* Bundle identity */}
      {bundleId && shortHash && (
        <div className="card p-3 flex items-center gap-3">
          <Hash className="w-4 h-4 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
          <div className="min-w-0 flex-1">
            <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
              Content-addressed bundle id
            </div>
            <div className="font-mono text-xs truncate" title={bundleId}>
              sha256:{shortHash}…
            </div>
          </div>
          <button
            type="button"
            onClick={copyBundle}
            className="btn btn-ghost px-2"
            aria-label="Copy bundle id"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>
      )}

      {/* Quick stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Roles" value={String(roleNames.length)} />
        <Stat label="Channels" value={String(channelCount)} />
        <Stat label="Loadouts" value={String(loadoutCount)} />
        <Stat label="Version" value={String(manifest.version ?? '—')} />
      </div>

      {/* Topology */}
      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-semibold">Topology</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="text-2xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
              Root
            </div>
            <div className="text-xs font-mono">
              {rootRole ?? <span style={{ color: 'var(--color-text-muted)' }}>—</span>}
            </div>
          </div>
          <div>
            <div className="text-2xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
              Companions
            </div>
            <div className="text-xs font-mono">
              {companions.length === 0 ? (
                <span style={{ color: 'var(--color-text-muted)' }}>—</span>
              ) : (
                companions.join(', ')
              )}
            </div>
          </div>
        </div>
        {topology.spawn_rules && Object.keys(topology.spawn_rules).length > 0 && (
          <div>
            <div className="text-2xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
              Spawn rules
            </div>
            <pre
              className="text-2xs font-mono p-2 rounded overflow-x-auto"
              style={{ backgroundColor: 'var(--color-elevated)' }}
            >
              {JSON.stringify(topology.spawn_rules, null, 2)}
            </pre>
          </div>
        )}
      </section>

      {/* Roles */}
      <section className="card p-4 space-y-3">
        <h2 className="text-sm font-semibold">
          Roles <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>({roleNames.length})</span>
        </h2>
        {roleNames.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            No roles defined.
          </p>
        ) : (
          <div className="space-y-2">
            {roleNames.map((roleName) => (
              <RoleRow
                key={roleName}
                name={roleName}
                isRoot={roleName === rootRole}
                def={roleMap[roleName] || {}}
                hasEmbeddedLoadout={Boolean(loadoutMap[roleName])}
              />
            ))}
          </div>
        )}
      </section>

      {/* Embedded loadouts (if any) */}
      {loadoutCount > 0 && (
        <section className="card p-4 space-y-2">
          <h2 className="text-sm font-semibold">
            Embedded loadouts <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>({loadoutCount})</span>
          </h2>
          <p className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
            Loadouts authored inline with this team. Standalone loadouts are listed under{' '}
            <Link to="/loadouts" className="text-honey-500 hover:text-honey-400">/loadouts</Link>.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {Object.entries(loadoutMap).map(([name, lo]) => (
              <div
                key={name}
                className="p-2 rounded text-xs font-mono"
                style={{ backgroundColor: 'var(--color-elevated)' }}
              >
                <div className="font-semibold">{name}</div>
                {typeof (lo as { extends?: string }).extends === 'string' && (
                  <div className="text-2xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                    extends: {(lo as { extends: string }).extends}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Communication (only when present) */}
      {channelCount > 0 && (
        <section className="card p-4 space-y-2">
          <h2 className="text-sm font-semibold">
            Communication <span className="text-2xs font-normal" style={{ color: 'var(--color-text-muted)' }}>({channelCount} channels)</span>
          </h2>
          {manifest.communication?.enforcement && (
            <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
              Enforcement:{' '}
              <span className="font-mono">{manifest.communication.enforcement}</span>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {Object.keys(channels).map((ch) => (
              <span
                key={ch}
                className="px-2 py-0.5 rounded text-2xs font-mono"
                style={{ backgroundColor: 'var(--color-elevated)' }}
              >
                {ch}
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/teams"
      className="flex items-center gap-1 text-xs hover:text-honey-500 transition-colors"
      style={{ color: 'var(--color-text-muted)' }}
    >
      <ArrowLeft className="w-3.5 h-3.5" />
      Back to Teams
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-2">
      <div className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
        {label}
      </div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

function RoleRow({
  name,
  isRoot,
  def,
  hasEmbeddedLoadout,
}: {
  name: string;
  isRoot: boolean;
  def: TeamRole;
  hasEmbeddedLoadout: boolean;
}) {
  const caps =
    Array.isArray(def.capabilities)
      ? (def.capabilities as string[])
      : Array.isArray(def.capabilities_add)
      ? def.capabilities_add
      : [];
  return (
    <div
      className="p-3 rounded flex items-start gap-3"
      style={{ backgroundColor: 'var(--color-elevated)' }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">{name}</span>
          {isRoot && (
            <span className="text-2xs px-1.5 py-0.5 rounded bg-honey-500/10 text-honey-500">
              root
            </span>
          )}
          {def.extends && (
            <span
              className="text-2xs px-1.5 py-0.5 rounded font-mono"
              style={{ backgroundColor: 'var(--color-bg)', color: 'var(--color-text-muted)' }}
            >
              ↳ {def.extends}
            </span>
          )}
          {hasEmbeddedLoadout && (
            <span className="text-2xs px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
              has loadout
            </span>
          )}
        </div>
        {caps.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {caps.slice(0, 8).map((c) => (
              <span
                key={c}
                className="text-2xs px-1.5 py-0.5 rounded font-mono"
                style={{ backgroundColor: 'var(--color-bg)' }}
              >
                {c}
              </span>
            ))}
            {caps.length > 8 && (
              <span className="text-2xs" style={{ color: 'var(--color-text-muted)' }}>
                +{caps.length - 8} more
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
