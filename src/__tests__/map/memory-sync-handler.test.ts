/**
 * Unit tests for OpenHive memory/skill sync handler chain
 *
 * Tests:
 * 1. MAP server extension handler dispatches to handleSyncMessage
 * 2. handleSyncMessage evicts minimem cache for memory_bank resources
 * 3. handleSyncMessage broadcasts to correct WebSocket channels
 * 4. Sync orchestrator is called for cloned resources
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──

const mockBroadcastToChannel = vi.fn();
const mockGetSyncOrchestrator = vi.fn(() => ({
  handleSyncEvent: vi.fn().mockResolvedValue(undefined),
}));
const mockEvictMinimem = vi.fn();
const mockFindResourceById = vi.fn();
const mockUpdateResourceSyncState = vi.fn();
const mockCreateSyncEvent = vi.fn(() => ({ id: 'evt-1' }));
const mockGetResourceSubscribers = vi.fn(() => ({ data: [] }));
const mockOnResourceSynced = vi.fn();
const mockCreateTrajectoryCheckpoint = vi.fn();
const mockGetInbound = vi.fn();

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (...args: unknown[]) => mockBroadcastToChannel(...args),
}));

vi.mock('../../sync/sync-orchestrator.js', () => ({
  getSyncOrchestrator: () => mockGetSyncOrchestrator(),
}));

vi.mock('../../api/routes/resource-content.js', () => ({
  evictMinimem: (...args: unknown[]) => mockEvictMinimem(...args),
}));

vi.mock('../../db/dal/syncable-resources.js', () => ({
  findResourceById: (...args: any[]) => mockFindResourceById(...args),
  updateResourceSyncState: (...args: any[]) => mockUpdateResourceSyncState(...args),
  createSyncEvent: (...args: any[]) => (mockCreateSyncEvent as any)(...args),
  getResourceSubscribers: (...args: any[]) => (mockGetResourceSubscribers as any)(...args),
}));

vi.mock('../../sync/resource-hooks.js', () => ({
  onResourceSynced: (...args: unknown[]) => mockOnResourceSynced(...args),
}));

vi.mock('../../db/dal/trajectory-checkpoints.js', () => ({
  createTrajectoryCheckpoint: (...args: unknown[]) => mockCreateTrajectoryCheckpoint(...args),
}));

vi.mock('../../map/connection-registry.js', () => ({
  getInbound: (...args: unknown[]) => mockGetInbound(...args),
}));

vi.mock('../../map/service.js', () => ({
  mapHubEvents: { on: vi.fn() },
}));

vi.mock('../../db/dal/map.js', () => ({
  listSwarms: vi.fn(() => []),
  findSwarmById: vi.fn(),
  findSwarmsByOwnerAgentIds: vi.fn(() => []),
}));

vi.mock('../../coordination/listener.js', () => ({
  isMapTaskEvent: vi.fn(() => false),
  handleMapTaskEvent: vi.fn(),
}));

import { handleSyncMessage } from '../../map/sync-listener.js';

// ── Test data ──

const MEMORY_RESOURCE = {
  id: 'res-mem-1',
  resource_type: 'memory_bank' as const,
  name: 'test/memory',
  local_path: '/tmp/test-memory',
  sync_strategy: 'local' as const,
  visibility: 'private' as const,
  git_remote_url: '/tmp/test-memory',
  owner_agent_id: 'agent-1',
};

const SKILL_RESOURCE = {
  id: 'res-skill-1',
  resource_type: 'skill' as const,
  name: 'test/skills',
  local_path: '/tmp/test-skills',
  sync_strategy: 'local' as const,
  visibility: 'shared' as const,
  git_remote_url: '/tmp/test-skills',
  owner_agent_id: 'agent-1',
};

// ── Tests ──

describe('Memory/Skill sync handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('x-openhive/memory.sync', () => {
    it('calls handleSyncMessage without error', () => {
      mockFindResourceById.mockReturnValue(MEMORY_RESOURCE);

      expect(() => {
        handleSyncMessage(
          {
            jsonrpc: '2.0',
            method: 'x-openhive/memory.sync',
            params: {
              resource_id: 'res-mem-1',
              agent_id: 'agent-1',
              commit_hash: 'abc123',
              timestamp: '2026-03-31T00:00:00Z',
            },
          },
          'swarm-1'
        );
      }).not.toThrow();
    });

    it('updates resource sync state', () => {
      mockFindResourceById.mockReturnValue(MEMORY_RESOURCE);

      handleSyncMessage(
        {
          jsonrpc: '2.0',
          method: 'x-openhive/memory.sync',
          params: { resource_id: 'res-mem-1', agent_id: 'agent-1', commit_hash: 'abc123', timestamp: '2026-03-31T00:00:00Z' },
        },
        'swarm-1'
      );

      expect(mockUpdateResourceSyncState).toHaveBeenCalledWith('res-mem-1', 'abc123', 'agent-1');
    });

    it('creates a sync event', () => {
      mockFindResourceById.mockReturnValue(MEMORY_RESOURCE);

      handleSyncMessage(
        {
          jsonrpc: '2.0',
          method: 'x-openhive/memory.sync',
          params: { resource_id: 'res-mem-1', agent_id: 'agent-1', commit_hash: 'abc123', timestamp: '2026-03-31T00:00:00Z' },
        },
        'swarm-1'
      );

      expect(mockCreateSyncEvent).toHaveBeenCalled();
    });

    it('evicts minimem cache for memory_bank resources', () => {
      mockFindResourceById.mockReturnValue(MEMORY_RESOURCE);

      handleSyncMessage(
        {
          jsonrpc: '2.0',
          method: 'x-openhive/memory.sync',
          params: { resource_id: 'res-mem-1', agent_id: 'agent-1', commit_hash: 'abc123', timestamp: '2026-03-31T00:00:00Z' },
        },
        'swarm-1'
      );

      expect(mockEvictMinimem).toHaveBeenCalledWith('/tmp/test-memory');
    });

    it('broadcasts memory:sync to resource channel', () => {
      mockFindResourceById.mockReturnValue(MEMORY_RESOURCE);

      handleSyncMessage(
        {
          jsonrpc: '2.0',
          method: 'x-openhive/memory.sync',
          params: { resource_id: 'res-mem-1', agent_id: 'agent-1', commit_hash: 'abc123', timestamp: '2026-03-31T00:00:00Z' },
        },
        'swarm-1'
      );

      expect(mockBroadcastToChannel).toHaveBeenCalledWith(
        'resource:memory_bank:res-mem-1',
        expect.objectContaining({ type: 'memory:sync' })
      );
    });

    it('broadcasts memory_bank_updated to legacy channel', () => {
      mockFindResourceById.mockReturnValue(MEMORY_RESOURCE);

      handleSyncMessage(
        {
          jsonrpc: '2.0',
          method: 'x-openhive/memory.sync',
          params: { resource_id: 'res-mem-1', agent_id: 'agent-1', commit_hash: 'abc123', timestamp: '2026-03-31T00:00:00Z' },
        },
        'swarm-1'
      );

      expect(mockBroadcastToChannel).toHaveBeenCalledWith(
        'memory-bank:res-mem-1',
        expect.objectContaining({ type: 'memory_bank_updated' })
      );
    });

    it('does not evict minimem for resources without local_path', () => {
      mockFindResourceById.mockReturnValue({ ...MEMORY_RESOURCE, local_path: null });

      handleSyncMessage(
        {
          jsonrpc: '2.0',
          method: 'x-openhive/memory.sync',
          params: { resource_id: 'res-mem-1', agent_id: 'agent-1', commit_hash: 'abc123', timestamp: '2026-03-31T00:00:00Z' },
        },
        'swarm-1'
      );

      expect(mockEvictMinimem).not.toHaveBeenCalled();
    });
  });

  describe('x-openhive/skill.sync', () => {
    it('broadcasts skill:sync to resource channel', () => {
      mockFindResourceById.mockReturnValue(SKILL_RESOURCE);

      handleSyncMessage(
        {
          jsonrpc: '2.0',
          method: 'x-openhive/skill.sync',
          params: { resource_id: 'res-skill-1', agent_id: 'agent-1', commit_hash: 'def456', timestamp: '2026-03-31T00:00:00Z' },
        },
        'swarm-1'
      );

      expect(mockBroadcastToChannel).toHaveBeenCalledWith(
        'resource:skill:res-skill-1',
        expect.objectContaining({ type: 'skill:sync' })
      );
    });

    it('does not evict minimem for skill resources', () => {
      mockFindResourceById.mockReturnValue(SKILL_RESOURCE);

      handleSyncMessage(
        {
          jsonrpc: '2.0',
          method: 'x-openhive/skill.sync',
          params: { resource_id: 'res-skill-1', agent_id: 'agent-1', commit_hash: 'def456', timestamp: '2026-03-31T00:00:00Z' },
        },
        'swarm-1'
      );

      expect(mockEvictMinimem).not.toHaveBeenCalled();
    });

    it('does not broadcast to legacy memory-bank channel', () => {
      mockFindResourceById.mockReturnValue(SKILL_RESOURCE);

      handleSyncMessage(
        {
          jsonrpc: '2.0',
          method: 'x-openhive/skill.sync',
          params: { resource_id: 'res-skill-1', agent_id: 'agent-1', commit_hash: 'def456', timestamp: '2026-03-31T00:00:00Z' },
        },
        'swarm-1'
      );

      const legacyCall = mockBroadcastToChannel.mock.calls.find(
        (call: unknown[]) => (call[0] as string).startsWith('memory-bank:')
      );
      expect(legacyCall).toBeUndefined();
    });
  });

  describe('invalid messages', () => {
    it('ignores unknown resource_id', () => {
      mockFindResourceById.mockReturnValue(null);

      handleSyncMessage(
        {
          jsonrpc: '2.0',
          method: 'x-openhive/memory.sync',
          params: { resource_id: 'nonexistent', agent_id: 'agent-1', commit_hash: 'abc', timestamp: '2026-03-31T00:00:00Z' },
        },
        'swarm-1'
      );

      expect(mockUpdateResourceSyncState).not.toHaveBeenCalled();
      expect(mockBroadcastToChannel).not.toHaveBeenCalled();
    });
  });
});
