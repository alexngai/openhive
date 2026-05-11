/**
 * Type shim for `openteams-editor`.
 *
 * The editor's library build (`build:lib`) emits JS only — the upstream
 * `tsc` declaration emit can't be cleanly scoped because the editor
 * imports types from the openteams parent package (see the editor's
 * `src/types-shim.d.ts` note). Rather than fight the build, openhive
 * declares the small surface it consumes here.
 *
 * When openteams ships a real `.d.ts` bundle, delete this file and the
 * imports below will resolve to the upstream types instead.
 */

declare module 'openteams-editor' {
  import type { ComponentType, ReactNode, Context } from 'react';

  export type EditorSavedState = unknown;

  export interface EditorPersistenceSaveResult {
    etag?: string;
  }

  export interface EditorPersistence {
    load(): EditorSavedState | null | Promise<EditorSavedState | null>;
    save(
      state: EditorSavedState,
      opts?: { etag?: string },
    ): EditorPersistenceSaveResult | void | Promise<EditorPersistenceSaveResult | void>;
    clear?(): void | Promise<void>;
  }

  export interface TeamEditorShellProps {
    persistence?: EditorPersistence;
    onMount?: () => void | Promise<void>;
    header?: ReactNode;
  }

  export const TeamEditorShell: ComponentType<TeamEditorShellProps>;
  export const EditorPersistenceProvider: Context<EditorPersistence | null>['Provider'];
  export const defaultLocalStoragePersistence: EditorPersistence;
  export function useEditorPersistence(): EditorPersistence | null;

  // Templates + saving helpers
  export function loadTemplate(manifest: unknown, roles?: unknown): void;
  export function compileToYaml(): string;
  export const BUNDLED_TEMPLATES: Record<string, { manifest: unknown; roles?: unknown }>;

  // Stores
  export const useConfigStore: unknown;
  export const useCanvasStore: unknown;
  export const useUIStore: unknown;
}
