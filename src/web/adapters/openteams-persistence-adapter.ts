/**
 * OpenHive REST adapter for the openteams editor persistence contract.
 *
 * The standalone editor persists to `localStorage`; embedded inside
 * openhive we route the same save/load calls to `/api/v1/teams/:id`.
 *
 * Editor state shape (`EditorSavedState`) is richer than the server's
 * authored `TeamTemplateContent` — it carries canvas node positions, UI
 * layer toggles, etc. v1 stashes the full snapshot under
 * `metadata.editor_state` (opaque to the server) so the editor can
 * round-trip its full state, while the actual team manifest lives in
 * `metadata.content` (the field openteams' template loader reads).
 *
 * For v1 the adapter saves only `editor_state` and leaves `content`
 * untouched — the server-authoritative manifest comes from the user's
 * explicit "publish" action (out of scope for this iteration). When the
 * git-backed Layer 6 lands, `content` becomes derived from the editor
 * state via `compileToYaml`.
 */

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
        // PATCH only the `metadata.editor_state` field. The server merges
        // metadata on update (see `team-templates.ts` DAL `updateTeamTemplate`),
        // so sibling keys (tags, publisher, content) are preserved.
        await api.patch(`/teams/${teamTemplateId}`, {
          metadata: { editor_state: state },
        });
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
