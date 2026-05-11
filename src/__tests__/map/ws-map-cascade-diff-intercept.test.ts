/**
 * Structural smoke test for the `cascade/diff.response` + `cascade/diff.chunk`
 * notification intercept added to `src/map/ws-map.ts`.
 *
 * Why a smoke and not a full integration test:
 *
 *   `setupMapWebSocket` installs its WS-message dispatch as an inner
 *   `ws.on('message', …)` closure. The closure isn't exported and would
 *   require a full server + auth handshake to exercise live, which is the
 *   province of a live-emission e2e (see `cascade-ws-delivery.test.ts`
 *   for an outbound analogue). For the inbound side, we don't yet have
 *   such a fixture.
 *
 * What this test does instead:
 *
 *   - Reads `src/map/ws-map.ts` as source and asserts both dispatch
 *     branches (`CASCADE_DIFF_METHODS.RESPONSE` and `.CHUNK`) are wired,
 *     forwarding to `handleCascadeDiffResponse` / `handleCascadeDiffChunk`.
 *   - Asserts the method-name constants the dispatcher branches on match
 *     the strings the protocol module actually sends.
 *
 * If the production wire intercept is ever rewritten to a dispatch table
 * or factored to a separate router module, this test will break loudly
 * and should be replaced with a live e2e or unit against the new shape.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { CASCADE_DIFF_METHODS } from '../../cascade/diff-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WS_MAP_PATH = resolve(__dirname, '../../map/ws-map.ts');
const wsMapSource = readFileSync(WS_MAP_PATH, 'utf-8');

describe('ws-map.ts cascade-diff intercept (structural)', () => {
  it('imports handleDiffResponse and handleDiffChunk from cascade-diff-protocol', () => {
    expect(wsMapSource).toMatch(
      /import\s+{[^}]*handleDiffResponse[^}]*}[^;]*from\s+['"]\.\/cascade-diff-protocol\.js['"]/s,
    );
    expect(wsMapSource).toMatch(
      /import\s+{[^}]*handleDiffChunk[^}]*}[^;]*from\s+['"]\.\/cascade-diff-protocol\.js['"]/s,
    );
  });

  it('imports CASCADE_DIFF_METHODS from cascade/diff-types', () => {
    expect(wsMapSource).toMatch(
      /import\s+{\s*CASCADE_DIFF_METHODS\s*}\s+from\s+['"]\.\.\/cascade\/diff-types\.js['"]/,
    );
  });

  it('dispatches CASCADE_DIFF_METHODS.RESPONSE to handleCascadeDiffResponse', () => {
    expect(wsMapSource).toMatch(
      /msg\.method\s*===\s*CASCADE_DIFF_METHODS\.RESPONSE/,
    );
    expect(wsMapSource).toMatch(/handleCascadeDiffResponse\(/);
  });

  it('dispatches CASCADE_DIFF_METHODS.CHUNK to handleCascadeDiffChunk', () => {
    expect(wsMapSource).toMatch(
      /msg\.method\s*===\s*CASCADE_DIFF_METHODS\.CHUNK/,
    );
    expect(wsMapSource).toMatch(/handleCascadeDiffChunk\(/);
  });

  it('the wire-method constants are exactly what the protocol module sends', () => {
    // These string values are part of the wire contract between hub and
    // sidecar. Test guards against accidental rename — a non-cosmetic
    // change here would break every connected sidecar.
    expect(CASCADE_DIFF_METHODS.RESPONSE).toBe('cascade/diff.response');
    expect(CASCADE_DIFF_METHODS.CHUNK).toBe('cascade/diff.chunk');
    expect(CASCADE_DIFF_METHODS.REQUEST).toBe('cascade/diff.request');
  });
});
