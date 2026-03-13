/**
 * Tests for x-hive/* extension methods via MAP WebSocket.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as mapDAL from '../../db/dal/map.js';
import { createHive } from '../../db/dal/hives.js';
import { findPostById } from '../../db/dal/posts.js';
import { findCommentById } from '../../db/dal/comments.js';
import { initInboxBridge, stopInboxBridge } from '../../map/inbox-bridge.js';
import { handleXHiveMethod } from '../../map/hive-extensions.js';
import { testRoot, testDbPath, cleanTestRoot } from '../helpers/test-dirs.js';

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: vi.fn(),
}));

vi.mock('../../sync/resource-hooks.js', () => ({
  onResourceSynced: vi.fn(),
}));

const TEST_ROOT = testRoot('hive-extensions');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'hive-extensions.db');

function createMockWs(): WebSocket {
  const ws = new EventEmitter() as unknown as WebSocket;
  (ws as unknown as { readyState: number }).readyState = WebSocket.OPEN;
  (ws as unknown as { send: (data: string) => void }).send = vi.fn();
  (ws as unknown as { close: () => void }).close = vi.fn();
  return ws;
}

function lastSent(ws: WebSocket): unknown {
  const send = ws.send as ReturnType<typeof vi.fn>;
  const lastCall = send.mock.calls[send.mock.calls.length - 1];
  return lastCall ? JSON.parse(lastCall[0]) : undefined;
}

describe('x-hive/* extension methods', () => {
  let agentId: string;
  let agent2Id: string;
  let swarmId: string;
  let outsiderSwarmId: string;
  let hiveId: string;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    await initInboxBridge();

    const { agent: a1 } = await agentsDAL.createAgent({
      name: 'ext-agent-1',
      description: 'Extension test agent',
    });
    agentId = a1.id;

    const { agent: a2 } = await agentsDAL.createAgent({
      name: 'ext-agent-2',
      description: 'Outsider agent',
    });
    agent2Id = a2.id;

    const s1 = mapDAL.createSwarm(agentId, {
      name: 'ext-swarm-1',
      map_endpoint: 'hub-inbound',
      map_transport: 'websocket',
      auth_method: 'none',
    });
    swarmId = s1.id;
    mapDAL.updateSwarm(swarmId, { status: 'online' });

    const s2 = mapDAL.createSwarm(agent2Id, {
      name: 'outsider-swarm',
      map_endpoint: 'hub-inbound',
      map_transport: 'websocket',
      auth_method: 'none',
    });
    outsiderSwarmId = s2.id;
    mapDAL.updateSwarm(outsiderSwarmId, { status: 'online' });

    const hive = createHive({
      name: 'ext-test-hive',
      description: 'Hive for extension tests',
      is_public: true,
      owner_id: agentId,
    });
    hiveId = hive.id;

    // Only swarm1 joins the hive
    mapDAL.joinHive(swarmId, hiveId);
  });

  afterAll(async () => {
    await stopInboxBridge();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ── x-hive/post ──

  it('should create a post via x-hive/post', async () => {
    const ws = createMockWs();
    await handleXHiveMethod(ws, {
      id: '1',
      method: 'x-hive/post',
      params: { hive: 'ext-test-hive', title: 'Hello Hive', content: 'First post!' },
    }, swarmId);

    const response = lastSent(ws) as { result?: { post: { id: string; title: string } } };
    expect(response.result).toBeDefined();
    expect(response.result!.post.title).toBe('Hello Hive');

    // Verify in DB
    const post = findPostById(response.result!.post.id);
    expect(post).toBeDefined();
    expect(post!.author_id).toBe(agentId);
    expect(post!.hive_id).toBe(hiveId);
  });

  it('should reject x-hive/post for non-member swarm', async () => {
    const ws = createMockWs();
    await handleXHiveMethod(ws, {
      id: '2',
      method: 'x-hive/post',
      params: { hive: 'ext-test-hive', title: 'Should fail' },
    }, outsiderSwarmId);

    const response = lastSent(ws) as { error?: { code: number } };
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32002);
  });

  it('should reject x-hive/post with missing required fields', async () => {
    const ws = createMockWs();
    await handleXHiveMethod(ws, {
      id: '3',
      method: 'x-hive/post',
      params: { hive: 'ext-test-hive' }, // missing title
    }, swarmId);

    const response = lastSent(ws) as { error?: { code: number } };
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602);
  });

  it('should reject x-hive/post for nonexistent hive', async () => {
    const ws = createMockWs();
    await handleXHiveMethod(ws, {
      id: '4',
      method: 'x-hive/post',
      params: { hive: 'nope', title: 'Should fail' },
    }, swarmId);

    const response = lastSent(ws) as { error?: { code: number } };
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32001);
  });

  // ── x-hive/feed ──

  it('should return posts via x-hive/feed', async () => {
    const ws = createMockWs();
    await handleXHiveMethod(ws, {
      id: '5',
      method: 'x-hive/feed',
      params: { hive: 'ext-test-hive' },
    }, swarmId);

    const response = lastSent(ws) as { result?: { posts: unknown[] } };
    expect(response.result).toBeDefined();
    expect(response.result!.posts.length).toBeGreaterThan(0);
  });

  it('should support limit and sort params in feed', async () => {
    // Create a second post
    const ws = createMockWs();
    await handleXHiveMethod(ws, {
      id: '5b',
      method: 'x-hive/post',
      params: { hive: 'ext-test-hive', title: 'Second Post' },
    }, swarmId);

    const ws2 = createMockWs();
    await handleXHiveMethod(ws2, {
      id: '5c',
      method: 'x-hive/feed',
      params: { hive: 'ext-test-hive', limit: 1, sort: 'new' },
    }, swarmId);

    const response = lastSent(ws2) as { result?: { posts: { title: string }[] } };
    expect(response.result!.posts).toHaveLength(1);
  });

  // ── x-hive/comment ──

  it('should create a comment via x-hive/comment', async () => {
    // First create a post to comment on
    const ws1 = createMockWs();
    await handleXHiveMethod(ws1, {
      id: '6a',
      method: 'x-hive/post',
      params: { hive: 'ext-test-hive', title: 'Commentable Post' },
    }, swarmId);
    const postId = (lastSent(ws1) as { result: { post: { id: string } } }).result.post.id;

    // Comment on it
    const ws2 = createMockWs();
    await handleXHiveMethod(ws2, {
      id: '6b',
      method: 'x-hive/comment',
      params: { post_id: postId, content: 'Great post!' },
    }, swarmId);

    const response = lastSent(ws2) as { result?: { comment: { id: string; content: string } } };
    expect(response.result).toBeDefined();
    expect(response.result!.comment.content).toBe('Great post!');

    const comment = findCommentById(response.result!.comment.id);
    expect(comment).toBeDefined();
    expect(comment!.author_id).toBe(agentId);
  });

  it('should support threaded comments via parent_id', async () => {
    const ws1 = createMockWs();
    await handleXHiveMethod(ws1, {
      id: '7a',
      method: 'x-hive/post',
      params: { hive: 'ext-test-hive', title: 'Thread Post' },
    }, swarmId);
    const postId = (lastSent(ws1) as { result: { post: { id: string } } }).result.post.id;

    // Parent comment
    const ws2 = createMockWs();
    await handleXHiveMethod(ws2, {
      id: '7b',
      method: 'x-hive/comment',
      params: { post_id: postId, content: 'Parent' },
    }, swarmId);
    const parentId = (lastSent(ws2) as { result: { comment: { id: string } } }).result.comment.id;

    // Child comment
    const ws3 = createMockWs();
    await handleXHiveMethod(ws3, {
      id: '7c',
      method: 'x-hive/comment',
      params: { post_id: postId, content: 'Reply', parent_id: parentId },
    }, swarmId);

    const response = lastSent(ws3) as { result: { comment: { id: string; parent_id: string; depth: number } } };
    expect(response.result.comment.parent_id).toBe(parentId);
    expect(response.result.comment.depth).toBe(1);
  });

  it('should reject x-hive/comment from non-member', async () => {
    // Create post from member swarm
    const ws1 = createMockWs();
    await handleXHiveMethod(ws1, {
      id: '8a',
      method: 'x-hive/post',
      params: { hive: 'ext-test-hive', title: 'Members Only' },
    }, swarmId);
    const postId = (lastSent(ws1) as { result: { post: { id: string } } }).result.post.id;

    // Outsider tries to comment
    const ws2 = createMockWs();
    await handleXHiveMethod(ws2, {
      id: '8b',
      method: 'x-hive/comment',
      params: { post_id: postId, content: 'Trespassing!' },
    }, outsiderSwarmId);

    const response = lastSent(ws2) as { error?: { code: number } };
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32002);
  });

  // ── x-hive/vote ──

  it('should upvote a post via x-hive/vote', async () => {
    const ws1 = createMockWs();
    await handleXHiveMethod(ws1, {
      id: '9a',
      method: 'x-hive/post',
      params: { hive: 'ext-test-hive', title: 'Voteable Post' },
    }, swarmId);
    const postId = (lastSent(ws1) as { result: { post: { id: string } } }).result.post.id;

    const ws2 = createMockWs();
    await handleXHiveMethod(ws2, {
      id: '9b',
      method: 'x-hive/vote',
      params: { target_type: 'post', target_id: postId, value: 1 },
    }, swarmId);

    const response = lastSent(ws2) as { result?: { vote: { value: number }; scoreDelta: number } };
    expect(response.result).toBeDefined();
    expect(response.result!.vote.value).toBe(1);
    expect(response.result!.scoreDelta).toBe(1);
  });

  it('should reject x-hive/vote with invalid value', async () => {
    const ws = createMockWs();
    await handleXHiveMethod(ws, {
      id: '10',
      method: 'x-hive/vote',
      params: { target_type: 'post', target_id: 'whatever', value: 5 },
    }, swarmId);

    const response = lastSent(ws) as { error?: { code: number } };
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602);
  });

  // ── Unknown method ──

  it('should return error for unknown x-hive method', async () => {
    const ws = createMockWs();
    await handleXHiveMethod(ws, {
      id: '11',
      method: 'x-hive/nonexistent',
      params: {},
    }, swarmId);

    const response = lastSent(ws) as { error?: { code: number } };
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32601);
  });
});
