/**
 * Loadout Editor — form-based authoring for a single `loadout` syncable
 * resource. Loadouts are simple YAML docs (capabilities, permission
 * rules, prompt addenda, MCP server refs) so a flat form gives clearer
 * UX than the team-template canvas. The shape we edit mirrors
 * `LoadoutContent` in `src/api/schemas/loadouts.ts`.
 *
 * Persistence: PATCH `/api/v1/loadouts/:id` with `{ content: ... }`.
 * The server preserves sibling `metadata` keys (tags, etc.) per the
 * DAL's metadata-merge contract.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ChevronLeft, Plus, X, Loader2 } from 'lucide-react';
import { api, type SyncableResource } from '../lib/api';
import { PageLoader } from '../components/common/LoadingSpinner';

/** Mirrors the server's `LoadoutContent` Zod schema; UI-aligned shape. */
interface LoadoutContent {
  name: string;
  description?: string;
  capabilities?: string[];
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  prompt_addendum?: string;
  mcp_servers?: Array<string | Record<string, unknown>>;
  [key: string]: unknown; // passthrough for extension fields we don't expose
}

const SAVE_DEBOUNCE_MS = 800;

export default function LoadoutEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [resource, setResource] = useState<SyncableResource | null>(null);
  const [content, setContent] = useState<LoadoutContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Date | null>(null);

  // Load
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.get<{ loadout: SyncableResource }>(`/loadouts/${id}`);
        if (cancelled) return;
        setResource(res.loadout);
        const inline = (res.loadout.metadata as { content?: LoadoutContent } | null)?.content;
        setContent(inline ?? { name: res.loadout.name });
      } catch (err) {
        if (cancelled) return;
        setLoadError((err as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // Debounced autosave
  useEffect(() => {
    if (!id || !content) return;
    const timer = setTimeout(async () => {
      setSaving(true);
      try {
        await api.patch(`/loadouts/${id}`, { content });
        setSaved(new Date());
      } catch (err) {
        console.warn('[loadout-editor] save failed', err);
      } finally {
        setSaving(false);
      }
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [id, content]);

  const update = useMemo(
    () => (patch: Partial<LoadoutContent>) => {
      setContent((prev) => (prev ? { ...prev, ...patch } : prev));
    },
    [],
  );

  if (loadError) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6">
        <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
          Failed to load loadout: {loadError}
        </p>
        <Link to="/teams?tab=loadouts" className="text-xs text-honey-500 mt-2 inline-block">← Back to loadouts</Link>
      </div>
    );
  }

  if (!resource || !content) return <PageLoader />;

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <button
          onClick={() => navigate('/teams?tab=loadouts')}
          className="btn btn-ghost flex items-center gap-1.5"
        >
          <ChevronLeft className="w-4 h-4" />
          <span className="text-xs">Loadouts</span>
        </button>
        <div className="text-2xs flex items-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
          {saving ? (
            <><Loader2 className="w-3 h-3 animate-spin" /> Saving…</>
          ) : saved ? (
            <>Saved {saved.toLocaleTimeString()}</>
          ) : null}
        </div>
      </div>

      <div>
        <h1 className="text-lg font-bold">{resource.name}</h1>
        <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
          {resource.id} · {resource.visibility}
        </p>
      </div>

      {/* Identity */}
      <Section title="Identity">
        <Field label="Name">
          <input
            type="text"
            className="input w-full"
            value={content.name}
            onChange={(e) => update({ name: e.target.value })}
          />
          <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Slug used by openteams; lowercase letters, digits, hyphens, underscores.
          </p>
        </Field>
        <Field label="Description">
          <textarea
            className="input w-full"
            rows={2}
            value={content.description ?? ''}
            onChange={(e) => update({ description: e.target.value || undefined })}
          />
        </Field>
      </Section>

      {/* Capabilities */}
      <Section
        title="Capabilities"
        description="Symbolic capabilities granted by this loadout. Consumed by claude-code-swarm / macro-agent to derive runtime access."
      >
        <ChipListField
          values={content.capabilities ?? []}
          onChange={(next) => update({ capabilities: next.length ? next : undefined })}
          placeholder="e.g. file.read, exec.test"
        />
      </Section>

      {/* Permissions */}
      <Section
        title="Permissions"
        description="Allow / deny / ask rules. Deny wins at hydrate time."
      >
        <Field label="Allow">
          <ChipListField
            values={content.permissions?.allow ?? []}
            onChange={(next) =>
              update({
                permissions: {
                  ...content.permissions,
                  allow: next.length ? next : undefined,
                },
              })
            }
            placeholder="e.g. Read(*)"
          />
        </Field>
        <Field label="Deny">
          <ChipListField
            values={content.permissions?.deny ?? []}
            onChange={(next) =>
              update({
                permissions: {
                  ...content.permissions,
                  deny: next.length ? next : undefined,
                },
              })
            }
            placeholder="e.g. Bash(rm:*)"
          />
        </Field>
        <Field label="Ask">
          <ChipListField
            values={content.permissions?.ask ?? []}
            onChange={(next) =>
              update({
                permissions: {
                  ...content.permissions,
                  ask: next.length ? next : undefined,
                },
              })
            }
            placeholder="e.g. WebFetch(*)"
          />
        </Field>
      </Section>

      {/* MCP servers */}
      <Section
        title="MCP servers"
        description="Symbolic refs (e.g. @org/server-name) or inline install specs. Refs resolve at materialization time."
      >
        <ChipListField
          values={(content.mcp_servers ?? []).map((m) =>
            typeof m === 'string' ? m : JSON.stringify(m),
          )}
          onChange={(next) =>
            update({
              mcp_servers: next.length
                ? next.map((s) => {
                    if (s.trim().startsWith('{')) {
                      try {
                        return JSON.parse(s) as Record<string, unknown>;
                      } catch {
                        return s;
                      }
                    }
                    return s;
                  })
                : undefined,
            })
          }
          placeholder="@org/server-name"
        />
      </Section>

      {/* Prompt addendum */}
      <Section
        title="Prompt addendum"
        description="Appended to the agent's system prompt. Concatenated when loadouts extend."
      >
        <textarea
          className="input w-full font-mono text-xs"
          rows={6}
          value={content.prompt_addendum ?? ''}
          onChange={(e) => update({ prompt_addendum: e.target.value || undefined })}
        />
      </Section>
    </div>
  );
}

// ── Tiny presentational helpers ───────────────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && (
          <p className="text-2xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-2xs block mb-1" style={{ color: 'var(--color-text-secondary)' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function ChipListField({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');

  function commit() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (values.includes(trimmed)) {
      setDraft('');
      return;
    }
    onChange([...values, trimmed]);
    setDraft('');
  }

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-2xs"
            style={{ backgroundColor: 'var(--color-elevated)' }}
          >
            <span className="font-mono">{v}</span>
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              className="opacity-60 hover:opacity-100"
              aria-label={`Remove ${v}`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <input
          type="text"
          className="input flex-1 font-mono text-xs"
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
        <button type="button" onClick={commit} className="btn btn-ghost px-2" aria-label="Add">
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
