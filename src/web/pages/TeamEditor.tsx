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
 * The shell is intentionally given a fixed-height container — the
 * editor expects to fill its parent and itself uses `height: 100%`.
 */

import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { TeamEditorShell } from 'openteams-editor';
import 'openteams-editor/styles.css';
import { createTeamPersistence } from '../lib/team-persistence';

export default function TeamEditor() {
  const { id } = useParams<{ id: string }>();

  // Memo so the editor doesn't see a fresh adapter object on every
  // re-render (would invalidate the autosave debounce timer).
  const persistence = useMemo(() => (id ? createTeamPersistence(id) : null), [id]);

  if (!id || !persistence) {
    return (
      <div style={{ padding: '2rem' }}>
        <p>Missing team template id in URL.</p>
      </div>
    );
  }

  return (
    <div style={{ height: 'calc(100vh - var(--app-header-height, 0px))', width: '100%' }}>
      <TeamEditorShell persistence={persistence} />
    </div>
  );
}
