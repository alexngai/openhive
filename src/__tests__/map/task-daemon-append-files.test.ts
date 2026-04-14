/**
 * Tests for daemonAppendTaskFiles — the C4 regression guard. opentasks'
 * updateNode REPLACES metadata (verified by reading its source), so the
 * append helper must explicitly spread the existing metadata to avoid
 * wiping keys like priority/tags.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the external `opentasks` package — daemonAppendTaskFiles imports it dynamically.
const mockGetNode = vi.fn();
const mockUpdateNode = vi.fn();

vi.mock('opentasks', () => ({
  createClient: () => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getNode: (...args: unknown[]) => mockGetNode(...args),
    updateNode: (...args: unknown[]) => mockUpdateNode(...args),
  }),
}));

// The daemon auto-start path reads task-daemon-lifecycle; stub it so
// withDaemon never tries to launch a real daemon.
vi.mock('../../map/task-daemon-lifecycle.js', () => ({
  ensureDaemon: vi.fn().mockResolvedValue(true),
}));

import { daemonAppendTaskFiles, TaskDaemonError } from '../../map/task-daemon-client.js';

beforeEach(() => {
  mockGetNode.mockReset();
  mockUpdateNode.mockReset();
});

describe('daemonAppendTaskFiles', () => {
  it('appends new files to an empty metadata.files', async () => {
    mockGetNode.mockResolvedValue({ id: 't1', metadata: {} });
    mockUpdateNode.mockResolvedValue({ id: 't1' });

    const result = await daemonAppendTaskFiles('/tmp/sock', 't1', ['src/a.ts', 'src/b.ts']);

    expect(result).toEqual({ added: ['src/a.ts', 'src/b.ts'], total: 2 });
    expect(mockUpdateNode).toHaveBeenCalledWith('t1', {
      metadata: { files: ['src/a.ts', 'src/b.ts'] },
    });
  });

  it('PRESERVES existing metadata keys when adding files (C4 regression)', async () => {
    mockGetNode.mockResolvedValue({
      id: 't1',
      metadata: {
        files: ['src/existing.ts'],
        priority_reason: 'blocks deploy',
        external_id: 'JIRA-123',
      },
    });
    mockUpdateNode.mockResolvedValue({ id: 't1' });

    await daemonAppendTaskFiles('/tmp/sock', 't1', ['src/new.ts']);

    expect(mockUpdateNode).toHaveBeenCalledTimes(1);
    const [, updates] = mockUpdateNode.mock.calls[0];
    // The other keys must survive.
    expect(updates.metadata.priority_reason).toBe('blocks deploy');
    expect(updates.metadata.external_id).toBe('JIRA-123');
    // And files is the union.
    expect(updates.metadata.files).toEqual(['src/existing.ts', 'src/new.ts']);
  });

  it('dedupes files via set union', async () => {
    mockGetNode.mockResolvedValue({ id: 't1', metadata: { files: ['src/a.ts'] } });
    mockUpdateNode.mockResolvedValue({ id: 't1' });

    const result = await daemonAppendTaskFiles('/tmp/sock', 't1', ['src/a.ts', 'src/b.ts', 'src/a.ts']);

    expect(result.added).toEqual(['src/b.ts']);
    expect(result.total).toBe(2);
    const [, updates] = mockUpdateNode.mock.calls[0];
    expect(updates.metadata.files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('no-ops when all input files are already present', async () => {
    mockGetNode.mockResolvedValue({ id: 't1', metadata: { files: ['src/a.ts', 'src/b.ts'] } });

    const result = await daemonAppendTaskFiles('/tmp/sock', 't1', ['src/a.ts']);

    expect(result).toEqual({ added: [], total: 2 });
    expect(mockUpdateNode).not.toHaveBeenCalled();
  });

  it('filters out non-string / empty entries in the input', async () => {
    mockGetNode.mockResolvedValue({ id: 't1', metadata: {} });
    mockUpdateNode.mockResolvedValue({ id: 't1' });

    await daemonAppendTaskFiles('/tmp/sock', 't1', ['src/a.ts', '', undefined as any, null as any, 42 as any]);

    const [, updates] = mockUpdateNode.mock.calls[0];
    expect(updates.metadata.files).toEqual(['src/a.ts']);
  });

  it('throws NOT_FOUND when the node does not exist', async () => {
    mockGetNode.mockResolvedValue(null);

    await expect(
      daemonAppendTaskFiles('/tmp/sock', 'missing', ['x.ts']),
    ).rejects.toBeInstanceOf(TaskDaemonError);
  });

  it('handles a node with no metadata key at all', async () => {
    mockGetNode.mockResolvedValue({ id: 't1' });
    mockUpdateNode.mockResolvedValue({ id: 't1' });

    const result = await daemonAppendTaskFiles('/tmp/sock', 't1', ['src/a.ts']);

    expect(result.added).toEqual(['src/a.ts']);
    expect(mockUpdateNode).toHaveBeenCalledWith('t1', {
      metadata: { files: ['src/a.ts'] },
    });
  });
});
