import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { mapHubEvents } from '../../map/service.js';

// Mock listSwarms for startup hydration
vi.mock('../../db/dal/map.js', () => ({
  listSwarms: vi.fn(() => ({ data: [], total: 0 })),
}));

import { setupRepoBridge } from '../../swarmcraft/repo-bridge.js';
import { listSwarms } from '../../db/dal/map.js';

describe('Repo Bridge', () => {
  let mockPipeline: { startAnalysis: ReturnType<typeof vi.fn>; isReady: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockPipeline = {
      startAnalysis: vi.fn(() => 'job-123'),
      isReady: vi.fn(() => false),
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    mapHubEvents.removeAllListeners('trajectory_checkpoint');
  });

  it('should trigger analysis when trajectory_checkpoint has a valid local projectPath', async () => {
    const handle = await setupRepoBridge(mockPipeline);

    // Use a path that exists on disk (the project root)
    const projectPath = process.cwd();
    mapHubEvents.emit('trajectory_checkpoint', { projectPath, source_swarm_id: 'swarm-1' });

    expect(mockPipeline.startAnalysis).toHaveBeenCalledWith(projectPath);
    handle.teardown();
  });

  it('should not trigger analysis for non-existent paths', async () => {
    const handle = await setupRepoBridge(mockPipeline);

    mapHubEvents.emit('trajectory_checkpoint', { projectPath: '/nonexistent/path/xyz', source_swarm_id: 'swarm-1' });

    expect(mockPipeline.startAnalysis).not.toHaveBeenCalled();
    handle.teardown();
  });

  it('should not trigger analysis when projectPath is missing', async () => {
    const handle = await setupRepoBridge(mockPipeline);

    mapHubEvents.emit('trajectory_checkpoint', { source_swarm_id: 'swarm-1' });

    expect(mockPipeline.startAnalysis).not.toHaveBeenCalled();
    handle.teardown();
  });

  it('should deduplicate repeated paths', async () => {
    const handle = await setupRepoBridge(mockPipeline);
    const projectPath = process.cwd();

    mapHubEvents.emit('trajectory_checkpoint', { projectPath });
    mapHubEvents.emit('trajectory_checkpoint', { projectPath });
    mapHubEvents.emit('trajectory_checkpoint', { projectPath });

    expect(mockPipeline.startAnalysis).toHaveBeenCalledTimes(1);
    handle.teardown();
  });

  it('should skip analysis if pipeline already has a graph', async () => {
    mockPipeline.isReady.mockReturnValue(true);
    const handle = await setupRepoBridge(mockPipeline);

    mapHubEvents.emit('trajectory_checkpoint', { projectPath: process.cwd() });

    expect(mockPipeline.startAnalysis).not.toHaveBeenCalled();
    handle.teardown();
  });

  it('should handle pipeline errors gracefully', async () => {
    mockPipeline.startAnalysis.mockImplementation(() => { throw new Error('Pipeline failed'); });
    const handle = await setupRepoBridge(mockPipeline);

    // Should not throw
    mapHubEvents.emit('trajectory_checkpoint', { projectPath: process.cwd() });

    expect(mockPipeline.startAnalysis).toHaveBeenCalled();
    handle.teardown();
  });

  it('should remove listeners on teardown', async () => {
    const handle = await setupRepoBridge(mockPipeline);
    const listenerCount = mapHubEvents.listenerCount('trajectory_checkpoint');

    handle.teardown();

    expect(mapHubEvents.listenerCount('trajectory_checkpoint')).toBeLessThan(listenerCount);
  });

  it('should hydrate from historical swarm metadata on startup', async () => {
    const projectPath = process.cwd();
    (listSwarms as ReturnType<typeof vi.fn>).mockReturnValue({
      data: [
        { id: 'swarm-old', metadata: { projectPath } },
        { id: 'swarm-other', metadata: { project: 'foo' } }, // no projectPath
      ],
      total: 2,
    });

    const handle = await setupRepoBridge(mockPipeline);

    expect(mockPipeline.startAnalysis).toHaveBeenCalledWith(projectPath);
    handle.teardown();
  });

  it('should skip hydration for non-existent historical paths', async () => {
    (listSwarms as ReturnType<typeof vi.fn>).mockReturnValue({
      data: [
        { id: 'remote-swarm', metadata: { projectPath: '/remote/machine/path' } },
      ],
      total: 1,
    });

    const handle = await setupRepoBridge(mockPipeline);

    expect(mockPipeline.startAnalysis).not.toHaveBeenCalled();
    handle.teardown();
  });

  it('should not re-analyze file paths (only directories)', async () => {
    const handle = await setupRepoBridge(mockPipeline);

    // package.json is a file, not a directory
    mapHubEvents.emit('trajectory_checkpoint', {
      projectPath: `${process.cwd()}/package.json`,
    });

    expect(mockPipeline.startAnalysis).not.toHaveBeenCalled();
    handle.teardown();
  });
});
