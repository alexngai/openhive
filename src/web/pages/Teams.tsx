/**
 * Teams + Loadouts page (consolidated under `/teams`).
 *
 * A single tabbed surface for the openteams authoring stack:
 *
 *   - **Templates** — `team_template` syncable resources. Multi-role
 *     compositions with topology + communication. Author visually
 *     (`/teams/:id/editor`) and dispatch specs against them or bind
 *     them to a swarm at spawn time.
 *   - **Loadouts** — standalone `loadout` syncable resources. First-
 *     class reusable bundles of capabilities, MCP scope, permissions,
 *     and prompt material. Bound to team roles by slug OR dispatched
 *     directly via `loadout_resource_id`. Authored at
 *     `/loadouts/:id/editor`; the in-team-embedded variant lives
 *     inside a team's `metadata.content.loadouts` and surfaces on the
 *     team detail page.
 *
 * The active tab is reflected in the URL as `?tab=` so deep links and
 * browser back/forward stay coherent.  `/loadouts` redirects to
 * `/teams?tab=loadouts` (wired in `App.tsx`).
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Users, Layers, ChevronRight, Plus } from 'lucide-react';
import { api, type SyncableResource } from '../lib/api';
import { useResourcesByType } from '../hooks/useApi';
import { useResourcesRealtime } from '../hooks/useRealtimeInvalidation';
import { PageLoader } from '../components/common/LoadingSpinner';
import { TimeAgo } from '../components/common/TimeAgo';
import { ListFilters, useDebouncedValue, matchesSearch } from '../components/common/ListFilters';
import { EmptyState } from '../components/common/EmptyState';

type Tab = 'templates' | 'loadouts';

export default function Teams() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: Tab = searchParams.get('tab') === 'loadouts' ? 'loadouts' : 'templates';

  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'templates') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-lg font-bold">Teams</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
          Author multi-agent team templates and the loadouts that compose them.
        </p>
      </div>

      <Tabs activeTab={tab} setTab={setTab} />

      {tab === 'templates' ? <TemplatesTab /> : <LoadoutsTab />}
    </div>
  );
}

// ── Tab strip ──────────────────────────────────────────────────────────────

function Tabs({ activeTab, setTab }: { activeTab: Tab; setTab: (t: Tab) => void }) {
  return (
    <div className="flex items-center gap-1 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
      <TabButton active={activeTab === 'templates'} onClick={() => setTab('templates')}>
        <Users className="w-3.5 h-3.5" />
        Templates
      </TabButton>
      <TabButton active={activeTab === 'loadouts'} onClick={() => setTab('loadouts')}>
        <Layers className="w-3.5 h-3.5" />
        Loadouts
      </TabButton>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-3 py-2 text-xs flex items-center gap-1.5 transition-colors"
      style={{
        color: active ? 'var(--color-text)' : 'var(--color-text-muted)',
        borderBottom: active ? '2px solid var(--color-honey-500, #f59e0b)' : '2px solid transparent',
        marginBottom: '-1px',
      }}
    >
      {children}
    </button>
  );
}

// ── Templates tab ──────────────────────────────────────────────────────────

interface TeamContent {
  manifest?: { name?: string; roles?: string[] };
  roles?: Record<string, unknown>;
}

function TeamCard({ resource }: { resource: SyncableResource }) {
  const content = ((resource.metadata as { content?: TeamContent } | null)?.content) || {};
  const roleCount = Object.keys(content.roles ?? {}).length;
  return (
    <Link
      to={`/teams/${resource.id}`}
      className="card card-hover p-4 flex items-start gap-4 group"
    >
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <Users className="w-5 h-5 text-honey-500" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm truncate group-hover:text-honey-500 transition-colors">
            {resource.name}
          </h3>
        </div>
        {resource.description && (
          <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
            {resource.description}
          </p>
        )}
        <div className="flex items-center gap-3 mt-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          <span>{roleCount} {roleCount === 1 ? 'role' : 'roles'}</span>
          <span>·</span>
          <span className="capitalize">{resource.visibility}</span>
          {resource.updated_at && (
            <>
              <span>·</span>
              <TimeAgo date={resource.updated_at} />
            </>
          )}
        </div>
      </div>
      <ChevronRight
        className="w-4 h-4 shrink-0 mt-1.5 transition-transform group-hover:translate-x-0.5"
        style={{ color: 'var(--color-text-muted)' }}
      />
    </Link>
  );
}

function TemplatesTab() {
  const navigate = useNavigate();
  const { data: resourcesData, isLoading } = useResourcesByType('team_template');
  useResourcesRealtime();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDebouncedValue(search);

  const resources = resourcesData?.data || [];
  const filtered = useMemo(
    () => resources.filter((r) => matchesSearch(q, r.name, r.description, r.scope)),
    [resources, q],
  );

  async function handleCreate() {
    setCreating(true);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const res = await api.post<{ team_template: SyncableResource }>('/teams', {
        name: `team-${stamp}`,
        visibility: 'private',
      });
      navigate(`/teams/${res.team_template.id}/editor`);
    } catch (err) {
      console.error('Create team failed', err);
      setCreating(false);
    }
  }

  if (isLoading) return <PageLoader />;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-2xs flex-1" style={{ color: 'var(--color-text-muted)' }}>
          Multi-agent team templates authored visually. Dispatch a spec against one to spawn an orchestrated team.
        </p>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="btn btn-primary flex items-center gap-1.5 shrink-0"
        >
          <Plus className="w-4 h-4" />
          New team
        </button>
      </div>

      {resources.length > 0 && (
        <ListFilters
          search={search}
          onSearchChange={setSearch}
          placeholder="Search teams…"
          count={{ visible: filtered.length, total: resources.length, noun: 'team' }}
        />
      )}

      {resources.length === 0 ? (
        <EmptyState
          icon={Users}
          title=”No team templates yet”
          description={'Click “New team” to author one visually.'}
        />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-center py-8" style={{ color: 'var(--color-text-muted)' }}>
          No teams match “{q}”.
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((resource) => (
            <TeamCard key={resource.id} resource={resource} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Loadouts tab ──────────────────────────────────────────────────────────

interface LoadoutContent {
  capabilities?: string[];
  prompt_addendum?: string;
}

function LoadoutCard({ resource }: { resource: SyncableResource }) {
  const content = ((resource.metadata as { content?: LoadoutContent } | null)?.content) || {};
  const capabilityCount = (content.capabilities ?? []).length;
  return (
    <Link
      to={`/loadouts/${resource.id}/editor`}
      className="card card-hover p-4 flex items-start gap-4 group"
    >
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
        style={{ backgroundColor: 'var(--color-elevated)' }}
      >
        <Layers className="w-5 h-5 text-honey-500" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium text-sm truncate group-hover:text-honey-500 transition-colors">
            {resource.name}
          </h3>
        </div>
        {resource.description && (
          <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'var(--color-text-secondary)' }}>
            {resource.description}
          </p>
        )}
        <div className="flex items-center gap-3 mt-2 text-2xs" style={{ color: 'var(--color-text-muted)' }}>
          <span>{capabilityCount} {capabilityCount === 1 ? 'capability' : 'capabilities'}</span>
          <span>·</span>
          <span className="capitalize">{resource.visibility}</span>
          {resource.updated_at && (
            <>
              <span>·</span>
              <TimeAgo date={resource.updated_at} />
            </>
          )}
        </div>
      </div>
      <ChevronRight
        className="w-4 h-4 shrink-0 mt-1.5 transition-transform group-hover:translate-x-0.5"
        style={{ color: 'var(--color-text-muted)' }}
      />
    </Link>
  );
}

function LoadoutsTab() {
  const navigate = useNavigate();
  const { data: resourcesData, isLoading } = useResourcesByType('loadout');
  useResourcesRealtime();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDebouncedValue(search);

  const resources = resourcesData?.data || [];
  const filtered = useMemo(
    () => resources.filter((r) => matchesSearch(q, r.name, r.description, r.scope)),
    [resources, q],
  );

  async function handleCreate() {
    setCreating(true);
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = `loadout-${stamp}`;
      const res = await api.post<{ loadout: SyncableResource }>('/loadouts', {
        name,
        visibility: 'private',
        content: { name, capabilities: [] },
      });
      navigate(`/loadouts/${res.loadout.id}/editor`);
    } catch (err) {
      console.error('Create loadout failed', err);
      setCreating(false);
    }
  }

  if (isLoading) return <PageLoader />;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-2xs flex-1" style={{ color: 'var(--color-text-muted)' }}>
          Standalone bundles of capabilities, MCP servers, permissions, and prompt material. Reusable across teams or dispatched directly.
        </p>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="btn btn-primary flex items-center gap-1.5 shrink-0"
        >
          <Plus className="w-4 h-4" />
          New loadout
        </button>
      </div>

      {resources.length > 0 && (
        <ListFilters
          search={search}
          onSearchChange={setSearch}
          placeholder="Search loadouts…"
          count={{ visible: filtered.length, total: resources.length, noun: 'loadout' }}
        />
      )}

      {resources.length === 0 ? (
        <EmptyState
          icon={Layers}
          title=”No loadouts yet”
          description={'Click “New loadout” to author one.'}
        />
      ) : filtered.length === 0 ? (
        <p className="text-xs text-center py-8" style={{ color: 'var(--color-text-muted)' }}>
          No loadouts match “{q}”.
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((resource) => (
            <LoadoutCard key={resource.id} resource={resource} />
          ))}
        </div>
      )}
    </div>
  );
}
