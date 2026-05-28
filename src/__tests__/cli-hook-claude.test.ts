/**
 * Tests for `openhive hook claude <event>` (forwardClaudeHook helper).
 *
 * The hook subcommand is what claude's `Stop` / `UserPromptSubmit` /
 * `Notification` hooks call when openhive spawns a TUI with the
 * `--settings` payload that bakes them in. The Commander action is a
 * one-liner around `forwardClaudeHook`; we drive that helper directly
 * with fake env / stdin / fetch so the contract is exercised without
 * spawning a real node process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { forwardClaudeHook } from '../cli/claude-hook.js';

function streamFrom(chunks: (string | Buffer)[]): AsyncIterable<Buffer> {
  return Readable.from(chunks.map(c => (typeof c === 'string' ? Buffer.from(c) : c)));
}

describe('forwardClaudeHook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns "skipped" when OPENHIVE_HUB_URL is absent (not running under openhive)', async () => {
    const fetchFn = vi.fn();
    const result = await forwardClaudeHook('stop', {
      env: { OPENHIVE_HOSTED_SWARM_ID: 'h1', OPENHIVE_HOOK_TOKEN: 'tok' },
      stdin: streamFrom([]),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe('skipped');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns "skipped" when OPENHIVE_HOSTED_SWARM_ID is absent', async () => {
    const fetchFn = vi.fn();
    const result = await forwardClaudeHook('stop', {
      env: { OPENHIVE_HUB_URL: 'http://localhost:7836', OPENHIVE_HOOK_TOKEN: 'tok' },
      stdin: streamFrom([]),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe('skipped');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns "skipped" when OPENHIVE_HOOK_TOKEN is absent', async () => {
    const fetchFn = vi.fn();
    const result = await forwardClaudeHook('stop', {
      env: { OPENHIVE_HUB_URL: 'http://localhost:7836', OPENHIVE_HOSTED_SWARM_ID: 'h1' },
      stdin: streamFrom([]),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe('skipped');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('POSTs to /api/v1/map/hosted/:id/hook/:event with Bearer auth and JSON body', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const payload = { session_id: 'sess-1', transcript_path: '/t.jsonl' };
    const result = await forwardClaudeHook('stop', {
      env: {
        OPENHIVE_HUB_URL: 'http://localhost:7836',
        OPENHIVE_HOSTED_SWARM_ID: 'hswarm_abc',
        OPENHIVE_HOOK_TOKEN: 'tok-123',
      },
      stdin: streamFrom([JSON.stringify(payload)]),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe('ok');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://localhost:7836/api/v1/map/hosted/hswarm_abc/hook/stop');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer tok-123');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it('strips a trailing slash on OPENHIVE_HUB_URL so the path concat stays clean', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await forwardClaudeHook('stop', {
      env: {
        OPENHIVE_HUB_URL: 'http://localhost:7836/',
        OPENHIVE_HOSTED_SWARM_ID: 'h1',
        OPENHIVE_HOOK_TOKEN: 'tok',
      },
      stdin: streamFrom([]),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:7836/api/v1/map/hosted/h1/hook/stop');
  });

  it('URL-encodes the event and hosted-swarm id so weird inputs do not break the path', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await forwardClaudeHook('weird event', {
      env: {
        OPENHIVE_HUB_URL: 'http://localhost:7836',
        OPENHIVE_HOSTED_SWARM_ID: 'hswarm/with/slash',
        OPENHIVE_HOOK_TOKEN: 'tok',
      },
      stdin: streamFrom([]),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(fetchFn.mock.calls[0][0]).toBe(
      'http://localhost:7836/api/v1/map/hosted/hswarm%2Fwith%2Fslash/hook/weird%20event',
    );
  });

  it('sends an empty object when stdin is empty (some hook variants send nothing)', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await forwardClaudeHook('prompt-submit', {
      env: {
        OPENHIVE_HUB_URL: 'http://localhost:7836',
        OPENHIVE_HOSTED_SWARM_ID: 'h1',
        OPENHIVE_HOOK_TOKEN: 'tok',
      },
      stdin: streamFrom([]),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body as string)).toEqual({});
  });

  it('falls back to { raw } when stdin is non-JSON instead of throwing', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await forwardClaudeHook('stop', {
      env: {
        OPENHIVE_HUB_URL: 'http://localhost:7836',
        OPENHIVE_HOSTED_SWARM_ID: 'h1',
        OPENHIVE_HOOK_TOKEN: 'tok',
      },
      stdin: streamFrom(['not json at all']),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(JSON.parse(fetchFn.mock.calls[0][1].body as string)).toEqual({ raw: 'not json at all' });
  });

  it('returns http_<status> on non-2xx and does not throw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const result = await forwardClaudeHook('stop', {
      env: {
        OPENHIVE_HUB_URL: 'http://localhost:7836',
        OPENHIVE_HOSTED_SWARM_ID: 'h1',
        OPENHIVE_HOOK_TOKEN: 'tok',
      },
      stdin: streamFrom(['{}']),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe('http_500');
  });

  it('returns "error" when fetch rejects (network failure / abort timeout)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await forwardClaudeHook('stop', {
      env: {
        OPENHIVE_HUB_URL: 'http://localhost:7836',
        OPENHIVE_HOSTED_SWARM_ID: 'h1',
        OPENHIVE_HOOK_TOKEN: 'tok',
      },
      stdin: streamFrom([]),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe('error');
  });

  it('caps stdin at 64 KiB so a misbehaving caller cannot pin us reading forever', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    // Feed 80 KiB across chunks of 16 KiB. After 64 KiB we should stop
    // reading. The body we POST won't parse as JSON (since we truncate
    // mid-stream), so it lands in the { raw } fallback. We just need
    // the helper to *finish* — without the cap, an infinite generator
    // would hang the test.
    const chunks: Buffer[] = Array.from({ length: 5 }, () => Buffer.alloc(16 * 1024, 'a'));
    const result = await forwardClaudeHook('stop', {
      env: {
        OPENHIVE_HUB_URL: 'http://localhost:7836',
        OPENHIVE_HOSTED_SWARM_ID: 'h1',
        OPENHIVE_HOOK_TOKEN: 'tok',
      },
      stdin: streamFrom(chunks),
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(result).toBe('ok');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
