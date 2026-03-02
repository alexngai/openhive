/**
 * Tests for MapSyncClient trajectory content handling.
 *
 * Covers:
 * - Content request/response with artifacts pattern
 * - Inline vs streaming responses
 * - Chunk notifications for large transcripts
 * - Checkpoint notification format
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MapSyncClient } from '../../map/sync-client.js';
import type { SessionContentProvider } from '../../map/sync-client.js';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

// =============================================================================
// Mock WebSocket
// =============================================================================

class MockWebSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  /** Parse all sent messages as JSON */
  get messages(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }

  /** Get the last sent message as parsed JSON */
  get lastMessage(): any {
    return JSON.parse(this.sent[this.sent.length - 1]);
  }
}

// =============================================================================
// Test Helpers
// =============================================================================

function createClient(): MapSyncClient {
  return new MapSyncClient({ agent_id: 'test-agent' });
}

function createContentProvider(content: {
  metadata: Record<string, unknown>;
  transcript: string;
  prompts: string;
  context: string;
}): SessionContentProvider {
  return async () => content;
}

function sendContentRequest(ws: MockWebSocket, checkpointId: string, include?: string[]): void {
  const msg = JSON.stringify({
    jsonrpc: '2.0',
    id: 'req-1',
    method: 'trajectory/content',
    params: {
      checkpoint_id: checkpointId,
      ...(include ? { include } : {}),
    },
  });
  ws.emit('message', Buffer.from(msg));
}

// =============================================================================
// Tests
// =============================================================================

describe('MapSyncClient content handling', () => {
  let client: MapSyncClient;
  let ws: MockWebSocket;

  beforeEach(() => {
    client = createClient();
    ws = new MockWebSocket();
    client.handleIncomingConnection(ws as any);
  });

  describe('inline content response', () => {
    it('should respond with artifacts bag for small content', async () => {
      const provider = createContentProvider({
        metadata: { agent: 'Claude Code', branch: 'main' },
        transcript: '{"type":"user"}\n{"type":"assistant"}\n',
        prompts: 'Fix the bug',
        context: '# Session Context\nWorking on auth module',
      });
      client.setSessionContentProvider(provider);

      sendContentRequest(ws, 'cp-123');

      // Wait for async handler
      await new Promise((r) => setTimeout(r, 50));

      expect(ws.messages).toHaveLength(1);
      const response = ws.messages[0];

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('req-1');
      expect(response.result.streaming).toBe(false);
      expect(response.result.checkpoint_id).toBe('cp-123');

      // Artifacts bag
      expect(response.result.artifacts).toBeDefined();
      expect(response.result.artifacts.metadata).toEqual({ agent: 'Claude Code', branch: 'main' });
      expect(response.result.artifacts.transcript).toContain('user');
      expect(response.result.artifacts.prompts).toBe('Fix the bug');
      expect(response.result.artifacts.context).toContain('Session Context');

      // Should NOT have old-style top-level fields
      expect(response.result.metadata).toBeUndefined();
      expect(response.result.transcript).toBeUndefined();
    });

    it('should respect include filter', async () => {
      const provider = createContentProvider({
        metadata: { foo: 'bar' },
        transcript: 'transcript data',
        prompts: 'prompt data',
        context: 'context data',
      });
      client.setSessionContentProvider(provider);

      sendContentRequest(ws, 'cp-123', ['metadata', 'prompts']);

      await new Promise((r) => setTimeout(r, 50));

      const artifacts = ws.messages[0].result.artifacts;
      expect(artifacts.metadata).toEqual({ foo: 'bar' });
      expect(artifacts.prompts).toBe('prompt data');
      expect(artifacts.transcript).toBeUndefined();
      expect(artifacts.context).toBeUndefined();
    });
  });

  describe('streaming content response', () => {
    it('should stream large transcripts via chunks', async () => {
      // Create a transcript larger than 512KB
      const largeLine = '{"type":"assistant","text":"' + 'x'.repeat(1024) + '"}\n';
      const largeTranscript = largeLine.repeat(600); // ~600KB

      const provider = createContentProvider({
        metadata: { agent: 'Claude Code' },
        transcript: largeTranscript,
        prompts: 'Do the thing',
        context: '# Context',
      });
      client.setSessionContentProvider(provider);

      sendContentRequest(ws, 'cp-large');

      await new Promise((r) => setTimeout(r, 100));

      // First message is the streaming response
      const response = ws.messages[0];
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe('req-1');
      expect(response.result.streaming).toBe(true);
      expect(response.result.stream_id).toBeDefined();
      expect(response.result.stream_artifact).toBe('transcript');
      expect(response.result.stream_info).toBeDefined();
      expect(response.result.stream_info.total_bytes).toBeGreaterThan(0);
      expect(response.result.stream_info.total_chunks).toBeGreaterThan(0);
      expect(response.result.stream_info.encoding).toBe('base64');

      // Small artifacts should be inline
      expect(response.result.artifacts.metadata).toEqual({ agent: 'Claude Code' });
      expect(response.result.artifacts.prompts).toBe('Do the thing');
      // Transcript should NOT be in artifacts (it's being streamed)
      expect(response.result.artifacts.transcript).toBeUndefined();

      // Remaining messages are content chunks
      const chunks = ws.messages.slice(1);
      expect(chunks.length).toBeGreaterThan(0);

      // All chunks should use trajectory/content.chunk method
      for (const chunk of chunks) {
        expect(chunk.jsonrpc).toBe('2.0');
        expect(chunk.method).toBe('trajectory/content.chunk');
        expect(chunk.params.stream_id).toBe(response.result.stream_id);
        expect(typeof chunk.params.index).toBe('number');
        expect(typeof chunk.params.data).toBe('string'); // base64
      }

      // Chunks should have sequential indices
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].params.index).toBe(i);
      }

      // Last chunk should be final with checksum
      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk.params.final).toBe(true);
      expect(lastChunk.params.checksum).toMatch(/^sha256:/);
    });
  });

  describe('error responses', () => {
    it('should return error when no content provider is set', async () => {
      // Don't set a content provider
      sendContentRequest(ws, 'cp-123');

      await new Promise((r) => setTimeout(r, 50));

      const response = ws.messages[0];
      expect(response.error).toBeDefined();
      expect(response.error.message).toContain('No content provider');
    });

    it('should return error when checkpoint is not found', async () => {
      client.setSessionContentProvider(async () => null);

      sendContentRequest(ws, 'nonexistent');

      await new Promise((r) => setTimeout(r, 50));

      const response = ws.messages[0];
      expect(response.error).toBeDefined();
      expect(response.error.message).toContain('not found');
    });
  });

  describe('method routing', () => {
    it('should ignore non-trajectory/content messages', async () => {
      client.setSessionContentProvider(async () => ({
        metadata: {},
        transcript: '',
        prompts: '',
        context: '',
      }));

      // Send a message with wrong method
      ws.emit(
        'message',
        Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'req-1',
            method: 'some/other/method',
            params: { checkpoint_id: 'cp-1' },
          })
        )
      );

      await new Promise((r) => setTimeout(r, 50));

      // Should not have sent any response
      expect(ws.messages).toHaveLength(0);
    });
  });
});

describe('MapSyncClient checkpoint notification', () => {
  it('should emit trajectory/checkpoint method', () => {
    const client = createClient();
    const ws = new MockWebSocket();
    client.handleIncomingConnection(ws as any);

    client.emitSessionSync({
      resource_id: 'res-1',
      commit_hash: 'abc123',
      checkpoint: {
        id: 'cp-1',
        session_id: 'sess-1',
        agent: 'Claude Code',
        files_touched: ['src/app.ts'],
        checkpoints_count: 2,
      },
    });

    expect(ws.messages).toHaveLength(1);
    const msg = ws.messages[0];
    expect(msg.jsonrpc).toBe('2.0');
    expect(msg.method).toBe('trajectory/checkpoint');
    expect(msg.params.resource_id).toBe('res-1');
    expect(msg.params.agent_id).toBe('test-agent');
    expect(msg.params.commit_hash).toBe('abc123');
    expect(msg.params.checkpoint.id).toBe('cp-1');
    expect(msg.params.checkpoint.agent).toBe('Claude Code');
  });
});
