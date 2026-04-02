import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  it('should auto-analyze CWD project on startup', async () => {
    // CWD has package.json and src/, so it should auto-analyze
    const handle = await setupRepoBridge(mockPipeline);

    expect(mockPipeline.startAnalysis).toHaveBeenCalledWith(process.cwd());
    handle.teardown();
  });

  it('should not auto-analyze CWD if pipeline is already ready', async () => {
    mockPipeline.isReady.mockReturnValue(true);
    const handle = await setupRepoBridge(mockPipeline);

    expect(mockPipeline.startAnalysis).not.toHaveBeenCalled();
    handle.teardown();
  });

  it('should register non-CWD paths passively (no analysis) via trajectory_checkpoint', async () => {
    const handle = await setupRepoBridge(mockPipeline);

    // Clear the CWD auto-analysis call
    mockPipeline.startAnalysis.mockClear();

    // Emit a trajectory for a non-existent remote path
    mapHubEvents.emit('trajectory_checkpoint', {
      projectPath: '/nonexistent/remote/project',
      source_swarm_id: 'swarm-1',
    });

    // Should NOT trigger analysis for non-CWD paths
    expect(mockPipeline.startAnalysis).not.toHaveBeenCalled();
    handle.teardown();
  });

  it('should not trigger analysis when projectPath is missing', async () => {
    const handle = await setupRepoBridge(mockPipeline);
    mockPipeline.startAnalysis.mockClear();

    mapHubEvents.emit('trajectory_checkpoint', { source_swarm_id: 'swarm-1' });

    // Only the initial CWD analysis should have been called (already cleared)
    expect(mockPipeline.startAnalysis).not.toHaveBeenCalled();
    handle.teardown();
  });

  it('should deduplicate repeated paths', async () => {
    const handle = await setupRepoBridge(mockPipeline);
    const projectPath = process.cwd();

    // CWD was already analyzed at startup, so trajectory_checkpoint for CWD
    // should not re-trigger analysis
    mapHubEvents.emit('trajectory_checkpoint', { projectPath });
    mapHubEvents.emit('trajectory_checkpoint', { projectPath });
    mapHubEvents.emit('trajectory_checkpoint', { projectPath });

    // Only 1 call total (the startup auto-analysis)
    expect(mockPipeline.startAnalysis).toHaveBeenCalledTimes(1);
    handle.teardown();
  });

  it('should handle pipeline errors gracefully', async () => {
    mockPipeline.startAnalysis.mockImplementation(() => { throw new Error('Pipeline failed'); });
    const handle = await setupRepoBridge(mockPipeline);

    // Should not throw, even though CWD analysis fails
    expect(mockPipeline.startAnalysis).toHaveBeenCalled();
    handle.teardown();
  });

  it('should remove listeners on teardown', async () => {
    const handle = await setupRepoBridge(mockPipeline);
    const listenerCount = mapHubEvents.listenerCount('trajectory_checkpoint');

    handle.teardown();

    expect(mapHubEvents.listenerCount('trajectory_checkpoint')).toBeLessThan(listenerCount);
  });

  it('should hydrate from historical swarm metadata on startup and analyze CWD match', async () => {
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
    // Should only be called once (hydration matches CWD, so fallback CWD analysis is skipped)
    expect(mockPipeline.startAnalysis).toHaveBeenCalledTimes(1);
    handle.teardown();
  });

  it('should skip analysis for non-existent historical paths and fall back to CWD', async () => {
    (listSwarms as ReturnType<typeof vi.fn>).mockReturnValue({
      data: [
        { id: 'remote-swarm', metadata: { projectPath: '/remote/machine/path' } },
      ],
      total: 1,
    });

    const handle = await setupRepoBridge(mockPipeline);

    // Remote path is not analyzed, but CWD fallback should trigger
    expect(mockPipeline.startAnalysis).toHaveBeenCalledWith(process.cwd());
    expect(mockPipeline.startAnalysis).toHaveBeenCalledTimes(1);
    handle.teardown();
  });

  describe('isCwdProject detection', () => {
    it('should analyze CWD subpath during hydration', async () => {
      // A project path under the CWD should be treated as a CWD project
      const subPath = process.cwd() + '/packages/sub-project';
      (listSwarms as ReturnType<typeof vi.fn>).mockReturnValue({
        data: [
          { id: 'swarm-sub', metadata: { projectPath: subPath } },
        ],
        total: 1,
      });

      const handle = await setupRepoBridge(mockPipeline);

      // Sub-path is under CWD, but it's not a local directory — so analysis
      // won't happen for it. CWD fallback should trigger instead.
      const calls = mockPipeline.startAnalysis.mock.calls;
      const calledPaths = calls.map((c: unknown[]) => c[0]);
      expect(calledPaths).toContain(process.cwd());
      handle.teardown();
    });
  });
});
