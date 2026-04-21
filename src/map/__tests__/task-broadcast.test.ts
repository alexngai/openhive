import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const broadcastToChannel = vi.fn();
const emitHubEvent = vi.fn();
const getCommitRangeForTask = vi.fn();

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (...args: unknown[]) => broadcastToChannel(...args),
}));
vi.mock('../../map/service.js', () => ({
  mapHubEvents: {
    emit: (...args: unknown[]) => emitHubEvent(...args),
  },
}));
vi.mock('../../db/dal/cascade-streams.js', () => ({
  getCommitRangeForTask: (...args: unknown[]) => getCommitRangeForTask(...args),
}));

const { broadcastTaskStatus } = await import('../task-broadcast.js');

const MOCK_RANGE = {
  stream_row_id: 'sid-1',
  stream_id: 'stream-A',
  source_swarm_id: 'swarm-1',
  source_agent_id: 'agent-1',
  first_commit: 'aaa',
  last_commit: 'bbb',
  change_ids: ['c1'],
  commits: [
    { commit_hash: 'aaa', change_id: 'c1', message_summary: 'first', author_agent_id: 'a', files_touched: ['x'], synced_at: 't1' },
    { commit_hash: 'bbb', change_id: 'c2', message_summary: 'second', author_agent_id: 'a', files_touched: ['y'], synced_at: 't2' },
  ],
  files_union: ['x', 'y'],
  merge_commit: 'mmm',
  merge_target: 'main',
};

beforeEach(() => {
  broadcastToChannel.mockReset();
  emitHubEvent.mockReset();
  getCommitRangeForTask.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('broadcastTaskStatus', () => {
  it('emits hub event and map:tasks broadcast for basic status change', () => {
    broadcastTaskStatus({ taskId: 't1', status: 'in_progress' });

    expect(emitHubEvent).toHaveBeenCalledTimes(1);
    expect(emitHubEvent).toHaveBeenCalledWith(
      'task_status_changed',
      expect.objectContaining({ task_id: 't1', status: 'in_progress' }),
    );
    expect(broadcastToChannel).toHaveBeenCalledWith('map:tasks', {
      type: 'task.status',
      data: expect.objectContaining({ taskId: 't1', current: 'in_progress' }),
    });
    expect(getCommitRangeForTask).not.toHaveBeenCalled();
  });

  it('broadcasts to resource:task:<id> when resourceId provided', () => {
    broadcastTaskStatus({ taskId: 't1', status: 'in_progress', resourceId: 'r1' });

    expect(broadcastToChannel).toHaveBeenCalledWith('map:tasks', expect.any(Object));
    expect(broadcastToChannel).toHaveBeenCalledWith('resource:task:r1', expect.any(Object));
  });

  it('attaches cascade block on terminal status with cascade data', () => {
    getCommitRangeForTask.mockReturnValue([MOCK_RANGE]);
    broadcastTaskStatus({ taskId: 't1', status: 'completed', resourceId: 'r1' });

    expect(getCommitRangeForTask).toHaveBeenCalledWith('r1', 't1');

    const hubEventPayload = emitHubEvent.mock.calls[0][1];
    expect(hubEventPayload.cascade).toEqual({
      commit_ranges: [MOCK_RANGE],
      total_commits: 2,
      total_streams: 1,
    });

    const wsPayload = broadcastToChannel.mock.calls[0][1];
    expect(wsPayload.data.cascade).toBeDefined();
  });

  it('omits cascade block on terminal status when no cascade data exists', () => {
    getCommitRangeForTask.mockReturnValue([]);
    broadcastTaskStatus({ taskId: 't1', status: 'completed', resourceId: 'r1' });

    const hubEventPayload = emitHubEvent.mock.calls[0][1];
    expect(hubEventPayload.cascade).toBeUndefined();

    const wsPayload = broadcastToChannel.mock.calls[0][1];
    expect(wsPayload.data.cascade).toBeUndefined();
  });

  it('omits cascade block on non-terminal status regardless of cascade data', () => {
    broadcastTaskStatus({ taskId: 't1', status: 'in_progress', resourceId: 'r1' });
    expect(getCommitRangeForTask).not.toHaveBeenCalled();
  });

  it('omits cascade block when resourceId is missing even on terminal status', () => {
    broadcastTaskStatus({ taskId: 't1', status: 'completed' });
    expect(getCommitRangeForTask).not.toHaveBeenCalled();
    const hubEventPayload = emitHubEvent.mock.calls[0][1];
    expect(hubEventPayload.cascade).toBeUndefined();
  });

  it('tolerates DAL errors without throwing (cascade block omitted)', () => {
    getCommitRangeForTask.mockImplementation(() => {
      throw new Error('db down');
    });

    expect(() =>
      broadcastTaskStatus({ taskId: 't1', status: 'completed', resourceId: 'r1' }),
    ).not.toThrow();

    const hubEventPayload = emitHubEvent.mock.calls[0][1];
    expect(hubEventPayload.cascade).toBeUndefined();
  });

  it('defaults nodeId to taskId when not specified', () => {
    getCommitRangeForTask.mockReturnValue([]);
    broadcastTaskStatus({ taskId: 'task-42', status: 'completed', resourceId: 'r1' });
    expect(getCommitRangeForTask).toHaveBeenCalledWith('r1', 'task-42');
  });

  it('uses explicit nodeId when provided', () => {
    getCommitRangeForTask.mockReturnValue([]);
    broadcastTaskStatus({ taskId: 'task-42', status: 'completed', resourceId: 'r1', nodeId: 'node-abc' });
    expect(getCommitRangeForTask).toHaveBeenCalledWith('r1', 'node-abc');
  });

  it('recognizes all terminal statuses including cancelled', () => {
    getCommitRangeForTask.mockReturnValue([]);
    for (const status of ['completed', 'closed', 'done', 'failed', 'cancelled']) {
      broadcastTaskStatus({ taskId: 't1', status, resourceId: 'r1' });
    }
    expect(getCommitRangeForTask).toHaveBeenCalledTimes(5);
  });
});
