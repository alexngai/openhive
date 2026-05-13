/**
 * Team Editor page — embeds the `openteams-editor` library inside
 * openhive's React app at `/teams/:id/editor`.
 *
 * The editor library is mounted via `<TeamEditorShell>`. A REST
 * persistence adapter (`createTeamPersistence`) routes the editor's
 * load/save through openhive's `/api/v1/teams/:id` REST surface, so
 * authored team templates live on the hub rather than in the
 * browser's localStorage.
 *
 * Hydration cascade on mount (see the `onMount` callback below):
 *
 *   1. If the row has `metadata.editor_state` (the editor's native
 *      shape with canvas positions, UI layer toggles, etc.) — restore
 *      it via `loadSavedState`. Best round-trip fidelity.
 *   2. Else if the row has `metadata.content` (manifest + roles, the
 *      shape REST consumers POST and mesh sync replicates) — convert
 *      to a canvas via `loadTemplate`. Loses canvas positions but the
 *      team structure is intact.
 *   3. Else — start with a blank canvas.
 *
 * The shell is intentionally given a fixed-height container — the
 * editor expects to fill its parent and itself uses `height: 100%`.
 */

import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import {
  TeamEditorShell,
  loadSavedState,
  loadTemplate,
  useConfigStore,
} from 'openteams-editor';
import type {
  LoadoutDefinition,
  ResolvedPrompts,
  RoleDefinition,
  TeamManifest,
} from 'openteams';
// Editor stylesheet — Tailwind utility layer + theme tokens + react-flow
// defaults. Vite's alias prefers the live source (`references/openteams/
// editor/src/index.css`) in dev; CI/production builds resolve via the
// package's `exports` map to the processed `dist/lib/openteams-editor.css`.
// Route-scoped so styles only load when the editor mounts.
import 'openteams-editor/styles.css';
import { api } from '../lib/api';
import {
  createTeamPersistence,
  type TeamPersistence,
} from '../adapters/openteams-persistence-adapter';

/**
 * Shape returned by `GET /api/v1/teams/:id`. We only read the metadata
 * fields the editor cares about; everything else is untyped here.
 */
interface FetchedTeamMetadata {
  editor_state?: unknown;
  content?: {
    manifest?: TeamManifest;
    roles?: Record<string, RoleDefinition>;
    prompts?: Record<string, ResolvedPrompts>;
    loadouts?: Record<string, LoadoutDefinition>;
  };
}

/** Hydrate the editor's Zustand stores from the row's authored content. */
async function hydrateOnMount(
  teamTemplateId: string,
  persistence: TeamPersistence,
): Promise<void> {
  let metadata: FetchedTeamMetadata | undefined;
  try {
    const res = await api.get<{ team_template: { metadata?: FetchedTeamMetadata } }>(
      `/teams/${teamTemplateId}`,
    );
    metadata = res.team_template.metadata;
  } catch (err) {
    console.warn(`[team-editor] fetch failed for ${teamTemplateId}: ${(err as Error).message}`);
    return;
  }

  // Step 1: native editor_state wins — full visual fidelity.
  if (metadata?.editor_state) {
    const restored = await loadSavedState(persistence);
    if (restored) {
      // Legacy editor_state snapshots saved before the prompts +
      // loadouts slices existed won't have those fields. Backfill from
      // `content` so the user doesn't see an empty Prompts tab or a
      // missing Loadouts list when both pieces of data are still
      // present in the row. Going forward, autosave keeps both in
      // sync with editor_state.
      const store = useConfigStore.getState();
      const content = metadata.content ?? {};

      if (content.loadouts && Object.keys(store.loadouts).length === 0) {
        store.setLoadouts(content.loadouts);
      }

      if (content.prompts) {
        for (const [roleName, resolved] of Object.entries(content.prompts)) {
          const role = store.roles.get(roleName);
          if (!role) continue;
          const hasNoPrompt =
            !role.promptContent &&
            (!role.additionalPrompts || role.additionalPrompts.length === 0);
          if (!hasNoPrompt) continue;
          store.setRole(roleName, {
            ...role,
            promptContent: resolved.primary || role.promptContent,
            additionalPrompts:
              resolved.additional && resolved.additional.length > 0
                ? resolved.additional.map((p) => ({ name: p.name, content: p.content }))
                : role.additionalPrompts,
          });
        }
      }
      return;
    }
    // Fall through — corrupted editor_state shouldn't trap us in an
    // unrecoverable blank-canvas state when `content` is also present.
  }

  // Step 2: fall back to manifest hydration.
  if (metadata?.content?.manifest) {
    const rolesMap = new Map<string, RoleDefinition>(
      Object.entries(metadata.content.roles ?? {}),
    );
    // Forward prompts + embedded loadouts so the editor's stores
    // capture them on initial load. Without this, autosave's
    // `compileToContent()` would write back content with prompts +
    // loadouts dropped (the stage-1 data-loss bug).
    loadTemplate(
      metadata.content.manifest,
      rolesMap,
      metadata.content.prompts,
      metadata.content.loadouts,
    );
  }
  // Step 3: nothing to load — leave the editor with its default
  // empty-template state.
}

export default function TeamEditor() {
  const { id } = useParams<{ id: string }>();

  // Memo so the editor doesn't see a fresh adapter object on every
  // re-render (would invalidate the autosave debounce timer).
  const persistence = useMemo(() => (id ? createTeamPersistence(id) : null), [id]);

  // Stable onMount reference so React doesn't double-fire the effect.
  const onMount = useMemo(
    () =>
      id && persistence
        ? () => hydrateOnMount(id, persistence)
        : undefined,
    [id, persistence],
  );

  if (!id || !persistence) {
    return (
      <div style={{ padding: '2rem' }}>
        <p>Missing team template id in URL.</p>
      </div>
    );
  }

  // Parent (Layout's full-width branch) gives us `h-full` inside the
  // main-area scroll container, so we just fill it. Earlier this used
  // `100vh - app-header-height` which double-counted the chrome and
  // caused the editor to overflow with weird inner scrollbars.
  return (
    <div style={{ height: '100%', width: '100%' }}>
      <TeamEditorShell persistence={persistence} onMount={onMount} />
    </div>
  );
}
