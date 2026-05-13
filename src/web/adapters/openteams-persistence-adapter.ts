/**
 * OpenHive REST adapter for the openteams editor persistence contract.
 *
 * The standalone editor persists to `localStorage`; embedded inside
 * openhive we route the same save/load calls to `/api/v1/teams/:id`.
 *
 * Editor state shape (`EditorSavedState`) is richer than the server's
 * authored `TeamTemplateContent` — it carries canvas node positions, UI
 * layer toggles, etc. We stash the full snapshot under
 * `metadata.editor_state` (opaque to the server) so the editor can
 * round-trip its full visual state, while the actual team manifest +
 * roles live in `metadata.content` (the field openteams' template
 * loader reads, and what the bundle store + mesh sync derive their
 * content-addressed hash from).
 *
 * On every save we compile the live editor state to a `TeamTemplateContent`
 * via `compileToContent()` and PATCH both fields in a single call. The
 * server merges sibling metadata keys, so writing `{editor_state, content}`
 * doesn't clobber other metadata (tags, etc.). This keeps `metadata.content`
 * always current — important because:
 *
 *   - Layer 2 auto-bundle hooks fire on every PATCH and hash from `content`.
 *   - Layer 6 git-backed rows derive their bundle from `content` (or the
 *     cloned YAML, but content is the in-memory fallback).
 *   - Mesh sync replicates `metadata` verbatim — Layer 7 cross-instance
 *     fetch reads `content` from replicated rows.
 *
 * Loading is asymmetric: the persistence adapter only surfaces
 * `editor_state` (its native shape). The TeamEditor page detects the
 * "row has content but no editor_state" case and uses openteams's
 * `loadTemplate(manifest, rolesMap)` to hydrate the canvas before the
 * editor mounts. That keeps this adapter focused on the
 * `EditorSavedState` round-trip and pushes the manifest-driven
 * hydration into a page-level effect (see `pages/TeamEditor.tsx`).
 */

import { compileToContent } from 'openteams-editor';
import { api } from '../lib/api';

// Mirror the editor library's `EditorSavedState` shape without importing
// the library types — keeps this module dependency-free and side-steps
// the missing-d.ts gap from the library build.
export type EditorSavedState = unknown;

export interface TeamPersistenceOpts {
  /** Optional ETag header support; currently a stub for future use. */
  etag?: string;
}

export interface TeamPersistenceSaveResult {
  etag?: string;
}

/**
 * Build a persistence adapter scoped to a specific team_template id.
 * The factory shape matches what `<EditorPersistenceProvider value=...>`
 * expects from the openteams editor library.
 */
export function createTeamPersistence(teamTemplateId: string) {
  return {
    async load(): Promise<EditorSavedState | null> {
      try {
        const res = await api.get<{
          team_template: { metadata?: { editor_state?: EditorSavedState } };
        }>(`/teams/${teamTemplateId}`);
        return res.team_template.metadata?.editor_state ?? null;
      } catch (err) {
        // Surface a structured warning but don't tear down the editor.
        console.warn(`[team-persistence] load failed for ${teamTemplateId}: ${(err as Error).message}`);
        return null;
      }
    },

    async save(
      state: EditorSavedState,
      _opts?: TeamPersistenceOpts,
    ): Promise<TeamPersistenceSaveResult | void> {
      try {
        // Compile the live editor state to a manifest + roles snapshot
        // so `metadata.content` stays the authoritative authored shape
        // for the rest of the openteams pipeline (auto-bundle, mesh
        // sync, git-backed rows, cross-instance fetch). Failures here
        // shouldn't lose the editor_state — if compile throws (e.g.
        // editor in an invalid state mid-edit), we still save the
        // editor_state so the user doesn't lose work.
        let content: ReturnType<typeof compileToContent> | null = null;
        try {
          content = compileToContent();
        } catch (compileErr) {
          console.warn(
            `[team-persistence] compileToContent failed for ${teamTemplateId}; saving editor_state only: ${(compileErr as Error).message}`,
          );
        }

        const metadata: Record<string, unknown> = { editor_state: state };
        if (content) metadata.content = content;

        // The server merges metadata on update (see `team-templates.ts`
        // DAL `updateTeamTemplate`), so sibling keys (tags, publisher,
        // other metadata) are preserved.
        await api.patch(`/teams/${teamTemplateId}`, { metadata });
      } catch (err) {
        console.warn(`[team-persistence] save failed for ${teamTemplateId}: ${(err as Error).message}`);
      }
    },

    async clear(): Promise<void> {
      try {
        await api.patch(`/teams/${teamTemplateId}`, {
          metadata: { editor_state: null },
        });
      } catch {
        // best-effort
      }
    },
  };
}

export type TeamPersistence = ReturnType<typeof createTeamPersistence>;
