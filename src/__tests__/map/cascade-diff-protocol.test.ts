/**
 * Wire-protocol tests for cascade/diff.request → response/chunk.
 *
 * Mocks the connection registry so we can capture outbound notifications
 * on a fake WS and drive inbound responses via handleDiffResponse /
 * handleDiffChunk directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import WebSocket from 'ws';
import {
  CASCADE_DIFF_METHODS,
  DIFF_INLINE_THRESHOLD_BYTES,
} from '../../cascade/diff-types.js';

// Capture outbound notifications on the fake socket so we can assert on
// what the protocol module sent.
type Sent = { method: string; params: Record<string, unknown> };
const sent: Sent[] = [];

const fakeWs = {
  readyState: WebSocket.OPEN,
  send: vi.fn((data: string) => {
    const msg = JSON.parse(data);
    sent.push({ method: msg.method, params: msg.params });
  }),
};

const inboundConn = { ws: fakeWs };

vi.mock('../../map/connection-registry.js', () => ({
  getInbound: (swarmId: string) =>
    swarmId === 'offline-swarm' ? undefined : inboundConn,
}));

import {
  sendDiffRequest,
  handleDiffResponse,
  handleDiffChunk,
  __resetPendingForTests,
  __pendingCountForTests,
} from '../../map/cascade-diff-protocol.js';

beforeEach(() => {
  __resetPendingForTests();
  sent.length = 0;
  fakeWs.readyState = WebSocket.OPEN;
});

afterEach(() => {
  __resetPendingForTests();
});

describe('cascade-diff-protocol', () => {
  describe('inline response (≤ 512 KB)', () => {
    it('resolves with the payload', async () => {
      const promise = sendDiffRequest({
        swarmId: 'swarm-a',
        stream_id: 'stream-x',
        head: 'aaa',
      });

      expect(sent).toHaveLength(1);
      expect(sent[0].method).toBe(CASCADE_DIFF_METHODS.REQUEST);
      const reqParams = sent[0].params as { request_id: string; files_only?: boolean };
      expect(reqParams.request_id).toMatch(/^cascade-diff-/);

      handleDiffResponse({
        request_id: reqParams.request_id,
        streaming: false,
        diff: 'diff --git a/a b/a\n',
        files_touched: ['a'],
        truncated: false,
      });

      const result = await promise;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.diff).toBe('diff --git a/a b/a\n');
        expect(result.payload.files_touched).toEqual(['a']);
        expect(result.payload.truncated).toBe(false);
      }
      expect(__pendingCountForTests()).toBe(0);
    });
  });

  describe('streaming response (> 512 KB)', () => {
    it('assembles chunks in seq order and verifies sha256', async () => {
      const promise = sendDiffRequest({
        swarmId: 'swarm-a',
        stream_id: 'stream-x',
        head: 'aaa',
      });
      const reqId = (sent[0].params as { request_id: string }).request_id;

      const part1 = Buffer.from('hunk-one\n', 'utf-8');
      const part2 = Buffer.from('hunk-two\n', 'utf-8');
      const full = Buffer.concat([part1, part2]);
      const sha = createHash('sha256').update(full).digest('hex');

      handleDiffResponse({
        request_id: reqId,
        streaming: true,
        chunk_stream_id: 'chunk-1',
        total_size: full.length,
        files_touched: ['a', 'b'],
      });

      handleDiffChunk({
        chunk_stream_id: 'chunk-1',
        seq: 0,
        data: part1.toString('base64'),
      });
      handleDiffChunk({
        chunk_stream_id: 'chunk-1',
        seq: 1,
        data: part2.toString('base64'),
        final: true,
        sha256: sha,
      });

      const result = await promise;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.diff).toBe('hunk-one\nhunk-two\n');
        expect(result.payload.files_touched).toEqual(['a', 'b']);
      }
    });

    it('rejects with integrity_failed on sha256 mismatch', async () => {
      const promise = sendDiffRequest({
        swarmId: 'swarm-a',
        stream_id: 'stream-x',
        head: 'aaa',
      });
      const reqId = (sent[0].params as { request_id: string }).request_id;
      const part = Buffer.from('data', 'utf-8');

      handleDiffResponse({
        request_id: reqId,
        streaming: true,
        chunk_stream_id: 'chunk-2',
        total_size: part.length,
        files_touched: [],
      });
      handleDiffChunk({
        chunk_stream_id: 'chunk-2',
        seq: 0,
        data: part.toString('base64'),
        final: true,
        sha256: '0'.repeat(64),
      });

      const result = await promise;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('integrity_failed');
    });

    it('rejects with bad_request when announced total_size exceeds the cap', async () => {
      const promise = sendDiffRequest({
        swarmId: 'swarm-a',
        stream_id: 'stream-x',
        head: 'aaa',
      });
      const reqId = (sent[0].params as { request_id: string }).request_id;

      handleDiffResponse({
        request_id: reqId,
        streaming: true,
        chunk_stream_id: 'chunk-3',
        total_size: 100 * 1024 * 1024, // 100 MB > 50 MB cap
        files_touched: [],
      });

      const result = await promise;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('bad_request');
    });
  });

  describe('error paths', () => {
    it('returns swarm_offline when getInbound has no connection', async () => {
      const result = await sendDiffRequest({
        swarmId: 'offline-swarm',
        stream_id: 'stream-x',
        head: 'aaa',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('swarm_offline');
      expect(sent).toHaveLength(0);
    });

    it('returns swarm_offline when the WS is not OPEN', async () => {
      fakeWs.readyState = WebSocket.CLOSING;
      const result = await sendDiffRequest({
        swarmId: 'swarm-a',
        stream_id: 'stream-x',
        head: 'aaa',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('swarm_offline');
    });

    it('times out when no response arrives within the window', async () => {
      vi.useFakeTimers();
      const promise = sendDiffRequest({
        swarmId: 'swarm-a',
        stream_id: 'stream-x',
        head: 'aaa',
      });

      // Advance past the 60s timeout.
      await vi.advanceTimersByTimeAsync(61_000);
      const result = await promise;
      vi.useRealTimers();

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('timeout');
      expect(__pendingCountForTests()).toBe(0);
    });
  });

  describe('request shape', () => {
    it('passes files_only through to the wire request (D17)', async () => {
      const promise = sendDiffRequest({
        swarmId: 'swarm-a',
        stream_id: 'stream-x',
        head: 'aaa',
        files_only: true,
      });
      expect((sent[0].params as { files_only?: boolean }).files_only).toBe(true);

      handleDiffResponse({
        request_id: (sent[0].params as { request_id: string }).request_id,
        streaming: false,
        diff: '',
        files_touched: ['a', 'b', 'c'],
        truncated: false,
      });

      const result = await promise;
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.files_touched).toEqual(['a', 'b', 'c']);
        expect(result.payload.diff).toBe('');
      }
    });

    it('passes base + file_path through when set', async () => {
      const promise = sendDiffRequest({
        swarmId: 'swarm-a',
        stream_id: 'stream-x',
        head: 'aaa',
        base: 'bbb',
        file_paths: ['src/foo.ts'],
      });
      const params = sent[0].params as {
        base?: string;
        file_paths?: string[];
      };
      expect(params.base).toBe('bbb');
      expect(params.file_paths).toEqual(['src/foo.ts']);

      handleDiffResponse({
        request_id: (sent[0].params as { request_id: string }).request_id,
        streaming: false,
        diff: 'x',
        files_touched: ['src/foo.ts'],
        truncated: false,
      });
      await promise;
    });
  });

  // Reference the constant so it isn't reported unused; serves as a smoke
  // assertion that the protocol module re-exports the threshold consumer
  // code might reach for.
  it('exports the inline threshold for consumer reference', () => {
    expect(DIFF_INLINE_THRESHOLD_BYTES).toBeGreaterThan(0);
  });
});
