/**
 * Tests for dispatch thread lifecycle binder.
 *
 * Covers Phase 9 of dispatch-inbox-threads:
 * - Close linked threads on task terminal status
 * - Reopen threads when task moves from terminal → active
 * - No-op when resource has no dispatch_threads
 * - Orphaned thread sweep
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../db/dal/syncable-resources.js', () => ({
  findResourceById: vi.fn(),
}));

vi.mock('../../db/dal/dispatches.js', () => ({
  findDispatchById: vi.fn(),
}));

vi.mock('../../mail/index.js', () => ({
  getMailJsonRpc: vi.fn(),
  getMailStorage: vi.fn(),
}));

vi.mock('../../map/service.js', () => ({
  mapHubEvents: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
  },
}));

import {
  handleTaskStatusChanged,
  sweepOrphanedThreads,
} from '../../dispatch/thread-lifecycle.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import * as dispatchesDAL from '../../db/dal/dispatches.js';
import { getMailJsonRpc, getMailStorage } from '../../mail/index.js';

const mockFindResource = resourcesDAL.findResourceById as ReturnType<typeof vi.fn>;
const mockFindDispatch = dispatchesDAL.findDispatchById as ReturnType<typeof vi.fn>;
const mockGetMailJsonRpc = getMailJsonRpc as ReturnType<typeof vi.fn>;
const mockGetMailStorage = getMailStorage as ReturnType<typeof vi.fn>;

function createMockMailRpc() {
  return {
    handleRequest: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe('handleTaskStatusChanged', () => {
  let mockRpc: ReturnType<typeof createMockMailRpc>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc = createMockMailRpc();
    mockGetMailJsonRpc.mockReturnValue(mockRpc);
  });

  it('closes linked dispatch threads on task completion', async () => {
    mockFindResource.mockReturnValue({
      id: 'res-1',
      metadata: {
        dispatch_threads: [
          { dispatch_id: 'd1', conversation_id: 'conv-d1' },
          { dispatch_id: 'd2', conversation_id: 'conv-d2' },
        ],
      },
    });

    await handleTaskStatusChanged({
      task_id: 'task-1',
      status: 'completed',
      resource_id: 'res-1',
    });

    expect(mockRpc.handleRequest).toHaveBeenCalledTimes(2);

    // Verify mail/close called for each conversation
    const calls = mockRpc.handleRequest.mock.calls;
    expect(calls[0][0]).toMatchObject({
      method: 'mail/close',
      params: { id: 'conv-d1' },
    });
    expect(calls[1][0]).toMatchObject({
      method: 'mail/close',
      params: { id: 'conv-d2' },
    });
  });

  it('closes threads on failed status', async () => {
    mockFindResource.mockReturnValue({
      id: 'res-1',
      metadata: {
        dispatch_threads: [{ dispatch_id: 'd1', conversation_id: 'conv-d1' }],
      },
    });

    await handleTaskStatusChanged({
      task_id: 'task-1',
      status: 'failed',
      resource_id: 'res-1',
    });

    expect(mockRpc.handleRequest).toHaveBeenCalledOnce();
    expect(mockRpc.handleRequest.mock.calls[0][0]).toMatchObject({
      method: 'mail/close',
      params: { id: 'conv-d1' },
    });
  });

  it('closes threads on cancelled status', async () => {
    mockFindResource.mockReturnValue({
      id: 'res-1',
      metadata: {
        dispatch_threads: [{ dispatch_id: 'd1', conversation_id: 'conv-d1' }],
      },
    });

    await handleTaskStatusChanged({
      task_id: 'task-1',
      status: 'cancelled',
      resource_id: 'res-1',
    });

    expect(mockRpc.handleRequest).toHaveBeenCalledOnce();
  });

  it('reopens threads when task transitions from terminal to open', async () => {
    mockFindResource.mockReturnValue({
      id: 'res-1',
      metadata: {
        dispatch_threads: [{ dispatch_id: 'd1', conversation_id: 'conv-d1' }],
      },
    });

    await handleTaskStatusChanged({
      task_id: 'task-1',
      status: 'open',
      previous: 'completed',
      resource_id: 'res-1',
    });

    expect(mockRpc.handleRequest).toHaveBeenCalledOnce();
    expect(mockRpc.handleRequest.mock.calls[0][0]).toMatchObject({
      method: 'mail/reopen',
      params: { id: 'conv-d1' },
    });
  });

  it('reopens threads when task transitions from terminal to in_progress', async () => {
    mockFindResource.mockReturnValue({
      id: 'res-1',
      metadata: {
        dispatch_threads: [{ dispatch_id: 'd1', conversation_id: 'conv-d1' }],
      },
    });

    await handleTaskStatusChanged({
      task_id: 'task-1',
      status: 'in_progress',
      previous: 'failed',
      resource_id: 'res-1',
    });

    expect(mockRpc.handleRequest).toHaveBeenCalledOnce();
    expect(mockRpc.handleRequest.mock.calls[0][0]).toMatchObject({
      method: 'mail/reopen',
      params: { id: 'conv-d1' },
    });
  });

  it('reopens closed linked threads when previous status is missing', async () => {
    mockFindResource.mockReturnValue({
      id: 'res-1',
      metadata: {
        dispatch_threads: [{ dispatch_id: 'd1', conversation_id: 'conv-d1' }],
      },
    });
    mockGetMailStorage.mockReturnValue({
      getConversation: vi.fn().mockReturnValue({
        id: 'conv-d1',
        status: 'completed',
      }),
    });

    await handleTaskStatusChanged({
      task_id: 'task-1',
      status: 'open',
      resource_id: 'res-1',
    });

    expect(mockRpc.handleRequest).toHaveBeenCalledOnce();
    expect(mockRpc.handleRequest.mock.calls[0][0]).toMatchObject({
      method: 'mail/reopen',
      params: { id: 'conv-d1' },
    });
  });

  it('does not reopen active linked threads when previous status is missing', async () => {
    mockFindResource.mockReturnValue({
      id: 'res-1',
      metadata: {
        dispatch_threads: [{ dispatch_id: 'd1', conversation_id: 'conv-d1' }],
      },
    });
    mockGetMailStorage.mockReturnValue({
      getConversation: vi.fn().mockReturnValue({
        id: 'conv-d1',
        status: 'active',
      }),
    });

    await handleTaskStatusChanged({
      task_id: 'task-1',
      status: 'open',
      resource_id: 'res-1',
    });

    expect(mockRpc.handleRequest).not.toHaveBeenCalled();
  });

  it('no-ops when resource_id is missing', async () => {
    await handleTaskStatusChanged({
      task_id: 'task-1',
      status: 'completed',
    });

    expect(mockFindResource).not.toHaveBeenCalled();
    expect(mockRpc.handleRequest).not.toHaveBeenCalled();
  });

  it('no-ops when resource not found', async () => {
    mockFindResource.mockReturnValue(null);

    await handleTaskStatusChanged({
      task_id: 'task-1',
      status: 'completed',
      resource_id: 'res-nonexistent',
    });

    expect(mockRpc.handleRequest).not.toHaveBeenCalled();
  });

  it('no-ops when resource has no dispatch_threads', async () => {
    mockFindResource.mockReturnValue({
      id: 'res-1',
      metadata: {},
    });

    await handleTaskStatusChanged({
      task_id: 'task-1',
      status: 'completed',
      resource_id: 'res-1',
    });

    expect(mockRpc.handleRequest).not.toHaveBeenCalled();
  });

  it('no-ops for non-terminal, non-reopen statuses', async () => {
    mockFindResource.mockReturnValue({
      id: 'res-1',
      metadata: {
        dispatch_threads: [{ dispatch_id: 'd1', conversation_id: 'conv-d1' }],
      },
    });

    await handleTaskStatusChanged({
      task_id: 'task-1',
      status: 'in_progress',
      previous: 'open', // not from terminal → no reopen
      resource_id: 'res-1',
    });

    expect(mockRpc.handleRequest).not.toHaveBeenCalled();
  });

  it('does not throw when mail/close fails', async () => {
    mockFindResource.mockReturnValue({
      id: 'res-1',
      metadata: {
        dispatch_threads: [{ dispatch_id: 'd1', conversation_id: 'conv-d1' }],
      },
    });
    mockRpc.handleRequest.mockRejectedValue(new Error('conversation not found'));

    // Should not throw
    await expect(
      handleTaskStatusChanged({
        task_id: 'task-1',
        status: 'completed',
        resource_id: 'res-1',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('sweepOrphanedThreads', () => {
  let mockRpc: ReturnType<typeof createMockMailRpc>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc = createMockMailRpc();
    mockGetMailJsonRpc.mockReturnValue(mockRpc);
  });

  it('closes stale active threads with no running dispatch', async () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

    mockGetMailStorage.mockReturnValue({
      listConversations: vi.fn().mockReturnValue([
        {
          id: 'conv-old',
          status: 'active',
          updated_at: thirtyOneDaysAgo,
          metadata: { dispatch_id: 'd-old' },
        },
      ]),
    });

    mockFindDispatch.mockReturnValue({
      id: 'd-old',
      status: 'complete',
    });

    const closed = await sweepOrphanedThreads(30 * 24 * 60 * 60 * 1000);
    expect(closed).toBe(1);
    expect(mockRpc.handleRequest).toHaveBeenCalledOnce();
  });

  it('skips threads with running dispatches', async () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

    mockGetMailStorage.mockReturnValue({
      listConversations: vi.fn().mockReturnValue([
        {
          id: 'conv-running',
          status: 'active',
          updated_at: thirtyOneDaysAgo,
          metadata: { dispatch_id: 'd-running' },
        },
      ]),
    });

    mockFindDispatch.mockReturnValue({
      id: 'd-running',
      status: 'running',
    });

    const closed = await sweepOrphanedThreads(30 * 24 * 60 * 60 * 1000);
    expect(closed).toBe(0);
    expect(mockRpc.handleRequest).not.toHaveBeenCalled();
  });

  it('skips threads within TTL', async () => {
    const recentDate = new Date().toISOString();

    mockGetMailStorage.mockReturnValue({
      listConversations: vi.fn().mockReturnValue([
        {
          id: 'conv-recent',
          status: 'active',
          updated_at: recentDate,
          metadata: { dispatch_id: 'd-recent' },
        },
      ]),
    });

    const closed = await sweepOrphanedThreads(30 * 24 * 60 * 60 * 1000);
    expect(closed).toBe(0);
  });

  it('skips already-closed threads', async () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

    mockGetMailStorage.mockReturnValue({
      listConversations: vi.fn().mockReturnValue([
        {
          id: 'conv-closed',
          status: 'completed',
          updated_at: thirtyOneDaysAgo,
          metadata: { dispatch_id: 'd-old' },
        },
      ]),
    });

    const closed = await sweepOrphanedThreads(30 * 24 * 60 * 60 * 1000);
    expect(closed).toBe(0);
  });
});
