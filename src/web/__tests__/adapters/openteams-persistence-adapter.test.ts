/**
 * Tests for the openhive REST team-persistence adapter (Layer 5).
 *
 * Verifies the adapter:
 *   - GETs `/teams/:id` on load, surfaces `metadata.editor_state` or null.
 *   - PATCHes `/teams/:id` with `{ metadata: { editor_state } }` on save.
 *   - Tolerates network failures without throwing (the editor should
 *     stay mounted even if persistence is briefly unavailable).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the api client BEFORE importing the adapter so the captured spy
// is the one the adapter uses internally.
const get = vi.fn();
const patch = vi.fn();

// The adapter imports `api` from `web/lib/api` — mock at that path so
// both old and new test paths share the same captured spies.
vi.mock('../../lib/api', () => ({
  api: {
    get: (...args: unknown[]) => get(...args),
    patch: (...args: unknown[]) => patch(...args),
  },
}));

import { createTeamPersistence } from '../../adapters/openteams-persistence-adapter';

describe('createTeamPersistence', () => {
  beforeEach(() => {
    get.mockReset();
    patch.mockReset();
  });

  it('load() returns metadata.editor_state when present', async () => {
    const editor_state = { config: { team: { name: 'fed-team' } } };
    get.mockResolvedValue({ team_template: { metadata: { editor_state } } });

    const p = createTeamPersistence('res_team_1');
    const result = await p.load();

    expect(get).toHaveBeenCalledWith('/teams/res_team_1');
    expect(result).toEqual(editor_state);
  });

  it('load() returns null when metadata.editor_state is missing', async () => {
    get.mockResolvedValue({ team_template: { metadata: { content: { manifest: { name: 'x' } } } } });
    const p = createTeamPersistence('res_team_2');
    const result = await p.load();
    expect(result).toBeNull();
  });

  it('load() returns null when the row has no metadata at all', async () => {
    get.mockResolvedValue({ team_template: {} });
    const p = createTeamPersistence('res_team_3');
    const result = await p.load();
    expect(result).toBeNull();
  });

  it('load() degrades gracefully on a network failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    get.mockRejectedValue(new Error('network down'));

    const p = createTeamPersistence('res_team_err');
    const result = await p.load();
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('save() PATCHes metadata.editor_state', async () => {
    patch.mockResolvedValue({});
    const p = createTeamPersistence('res_team_save');
    const state = { config: { team: { name: 'updated' } } };
    await p.save(state);
    // The adapter writes both editor_state (the full visual snapshot) and
    // content (compileToContent's manifest+roles projection so downstream
    // bundle/mesh-sync layers stay current). We assert on editor_state
    // specifically and tolerate the content sibling — its shape comes
    // from the editor's live store state, which is global to the test
    // process.
    expect(patch).toHaveBeenCalledWith(
      '/teams/res_team_save',
      expect.objectContaining({
        metadata: expect.objectContaining({ editor_state: state }),
      }),
    );
  });

  it('save() degrades gracefully on a network failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    patch.mockRejectedValue(new Error('500'));
    const p = createTeamPersistence('res_team_save_err');
    await expect(p.save({ x: 1 })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('clear() PATCHes metadata.editor_state to null', async () => {
    patch.mockResolvedValue({});
    const p = createTeamPersistence('res_team_clear');
    await p.clear();
    expect(patch).toHaveBeenCalledWith('/teams/res_team_clear', {
      metadata: { editor_state: null },
    });
  });

  it('clear() swallows errors silently', async () => {
    patch.mockRejectedValue(new Error('boom'));
    const p = createTeamPersistence('res_team_clear_err');
    await expect(p.clear()).resolves.toBeUndefined();
  });
});
