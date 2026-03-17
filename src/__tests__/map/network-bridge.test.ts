/**
 * Tests for Network Bridge — L3/L4 ↔ L7 coordination
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  initNetworkBridge,
  stopNetworkBridge,
  isNetworkAvailable,
  provisionSwarmNetwork,
  revokeSwarmNetwork,
  refreshSwarmNetworkInfo,
  getSwarmNetworkInfo,
  NetworkBridgeError,
} from '../../map/network-bridge.js';
import type { NetworkProvider, AuthKeyResult, DeviceInfo } from '../../network/types.js';

// Mock the DAL
vi.mock('../../db/dal/map.js', () => ({
  findSwarmById: vi.fn(),
  updateSwarm: vi.fn(),
  getSwarmHiveNames: vi.fn(() => ['test-hive']),
}));

import * as mapDal from '../../db/dal/map.js';

function createMockProvider(overrides?: Partial<NetworkProvider>): NetworkProvider {
  return {
    type: 'headscale-sidecar',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn(() => true),
    ensureNamespace: vi.fn().mockResolvedValue('ns'),
    createAuthKey: vi.fn().mockResolvedValue({
      keyId: 'key-123',
      key: 'authkey-abc',
      reusable: false,
      expiration: '2026-04-16T00:00:00Z',
      joinCommand: 'tailscale up --authkey authkey-abc',
      instructions: 'Run the join command',
    } satisfies AuthKeyResult),
    revokeAuthKey: vi.fn().mockResolvedValue(undefined),
    getDeviceInfo: vi.fn().mockResolvedValue({
      id: 'node-456',
      name: 'test-swarm',
      ips: ['100.64.0.1'],
      online: true,
      dnsName: 'test-swarm.hive.internal',
      lastSeen: '2026-03-16T12:00:00Z',
      tags: [],
    } satisfies DeviceInfo),
    listDevices: vi.fn().mockResolvedValue([]),
    syncPolicy: vi.fn().mockResolvedValue(undefined),
    checkConnectivity: vi.fn().mockResolvedValue({ reachable: true }),
    getServerUrl: vi.fn(() => 'https://headscale.example.com'),
    getJoinInstructions: vi.fn(() => 'instructions'),
    ...overrides,
  } as unknown as NetworkProvider;
}

function mockSwarm(overrides?: Record<string, unknown>) {
  return {
    id: 'swarm-1',
    name: 'test-swarm',
    headscale_node_id: null,
    tailscale_ips: null,
    tailscale_dns_name: null,
    mesh_peer_id: null,
    owner_agent_id: 'agent-1',
    ...overrides,
  };
}

describe('Network Bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopNetworkBridge();
  });

  afterEach(() => {
    stopNetworkBridge();
  });

  // ── isNetworkAvailable ────────────────────────────────────────────────

  describe('isNetworkAvailable', () => {
    it('should return false when no provider initialized', () => {
      expect(isNetworkAvailable()).toBe(false);
    });

    it('should return false when provider type is none', () => {
      const provider = createMockProvider({ type: 'none' as any });
      initNetworkBridge(provider);
      expect(isNetworkAvailable()).toBe(false);
    });

    it('should return false when provider is not ready', () => {
      const provider = createMockProvider({ isReady: vi.fn(() => false) });
      initNetworkBridge(provider);
      expect(isNetworkAvailable()).toBe(false);
    });

    it('should return true when provider is ready', () => {
      const provider = createMockProvider();
      initNetworkBridge(provider);
      expect(isNetworkAvailable()).toBe(true);
    });

    it('should return false after stopNetworkBridge', () => {
      const provider = createMockProvider();
      initNetworkBridge(provider);
      expect(isNetworkAvailable()).toBe(true);
      stopNetworkBridge();
      expect(isNetworkAvailable()).toBe(false);
    });
  });

  // ── provisionSwarmNetwork ─────────────────────────────────────────────

  describe('provisionSwarmNetwork', () => {
    it('should throw when provider not available', async () => {
      await expect(
        provisionSwarmNetwork('swarm-1', { hive_name: 'test-hive' }),
      ).rejects.toThrow(NetworkBridgeError);
    });

    it('should throw when swarm not found', async () => {
      const provider = createMockProvider();
      initNetworkBridge(provider);
      vi.mocked(mapDal.findSwarmById).mockReturnValue(null as any);

      await expect(
        provisionSwarmNetwork('swarm-1', { hive_name: 'test-hive' }),
      ).rejects.toThrow('Swarm not found');
    });

    it('should call provider.createAuthKey with correct params', async () => {
      const provider = createMockProvider();
      initNetworkBridge(provider);
      vi.mocked(mapDal.findSwarmById).mockReturnValue(mockSwarm() as any);

      const result = await provisionSwarmNetwork('swarm-1', {
        hive_name: 'my-hive',
        reusable: true,
        ephemeral: false,
        expiration_hours: 48,
      });

      expect(provider.createAuthKey).toHaveBeenCalledWith({
        hiveName: 'my-hive',
        swarmName: 'test-swarm',
        reusable: true,
        ephemeral: false,
        expirationHours: 48,
      });
      expect(result.swarm_id).toBe('swarm-1');
      expect(result.keyId).toBe('key-123');
      expect(result.key).toBe('authkey-abc');
    });

    it('should use swarmId as name when swarm has no name', async () => {
      const provider = createMockProvider();
      initNetworkBridge(provider);
      vi.mocked(mapDal.findSwarmById).mockReturnValue(mockSwarm({ name: '' }) as any);

      await provisionSwarmNetwork('swarm-1', { hive_name: 'test-hive' });

      expect(provider.createAuthKey).toHaveBeenCalledWith(
        expect.objectContaining({ swarmName: 'swarm-1' }),
      );
    });
  });

  // ── refreshSwarmNetworkInfo ───────────────────────────────────────────

  describe('refreshSwarmNetworkInfo', () => {
    it('should return null when provider not available', async () => {
      const result = await refreshSwarmNetworkInfo('swarm-1');
      expect(result).toBeNull();
    });

    it('should return null when swarm not found', async () => {
      const provider = createMockProvider();
      initNetworkBridge(provider);
      vi.mocked(mapDal.findSwarmById).mockReturnValue(null as any);

      const result = await refreshSwarmNetworkInfo('swarm-1');
      expect(result).toBeNull();
    });

    it('should query provider and update swarm record', async () => {
      const provider = createMockProvider();
      initNetworkBridge(provider);
      vi.mocked(mapDal.findSwarmById).mockReturnValue(mockSwarm() as any);

      const result = await refreshSwarmNetworkInfo('swarm-1');

      expect(provider.getDeviceInfo).toHaveBeenCalledWith('test-swarm', 'test-hive');
      expect(mapDal.updateSwarm).toHaveBeenCalledWith('swarm-1', {
        headscale_node_id: 'node-456',
        tailscale_ips: ['100.64.0.1'],
        tailscale_dns_name: 'test-swarm.hive.internal',
      });
      expect(result).toEqual({
        ips: ['100.64.0.1'],
        dnsName: 'test-swarm.hive.internal',
      });
    });

    it('should return null when provider returns no device ID', async () => {
      const provider = createMockProvider({
        getDeviceInfo: vi.fn().mockResolvedValue({ id: '', name: '', ips: [], online: false, dnsName: null, lastSeen: null, tags: [] }),
      });
      initNetworkBridge(provider);
      vi.mocked(mapDal.findSwarmById).mockReturnValue(mockSwarm() as any);

      const result = await refreshSwarmNetworkInfo('swarm-1');
      expect(result).toBeNull();
      expect(mapDal.updateSwarm).not.toHaveBeenCalled();
    });

    it('should return null and log on provider error', async () => {
      const provider = createMockProvider({
        getDeviceInfo: vi.fn().mockRejectedValue(new Error('API timeout')),
      });
      initNetworkBridge(provider);
      vi.mocked(mapDal.findSwarmById).mockReturnValue(mockSwarm() as any);

      const result = await refreshSwarmNetworkInfo('swarm-1');
      expect(result).toBeNull();
    });
  });

  // ── revokeSwarmNetwork ────────────────────────────────────────────────

  describe('revokeSwarmNetwork', () => {
    it('should be a no-op when provider not available', async () => {
      await revokeSwarmNetwork('swarm-1');
      // No error thrown
    });

    it('should be a no-op when swarm not found', async () => {
      const provider = createMockProvider();
      initNetworkBridge(provider);
      vi.mocked(mapDal.findSwarmById).mockReturnValue(null as any);

      await revokeSwarmNetwork('swarm-1');
      expect(provider.revokeAuthKey).not.toHaveBeenCalled();
    });

    it('should be a no-op when swarm has no headscale_node_id', async () => {
      const provider = createMockProvider();
      initNetworkBridge(provider);
      vi.mocked(mapDal.findSwarmById).mockReturnValue(mockSwarm() as any);

      await revokeSwarmNetwork('swarm-1');
      expect(provider.revokeAuthKey).not.toHaveBeenCalled();
    });

    it('should call revokeAuthKey when swarm has headscale_node_id', async () => {
      const provider = createMockProvider();
      initNetworkBridge(provider);
      vi.mocked(mapDal.findSwarmById).mockReturnValue(
        mockSwarm({ headscale_node_id: 'node-789' }) as any,
      );

      await revokeSwarmNetwork('swarm-1');
      expect(provider.revokeAuthKey).toHaveBeenCalledWith('node-789');
    });

    it('should not throw when revokeAuthKey fails', async () => {
      const provider = createMockProvider({
        revokeAuthKey: vi.fn().mockRejectedValue(new Error('revoke failed')),
      });
      initNetworkBridge(provider);
      vi.mocked(mapDal.findSwarmById).mockReturnValue(
        mockSwarm({ headscale_node_id: 'node-789' }) as any,
      );

      // Should not throw
      await revokeSwarmNetwork('swarm-1');
    });
  });

  // ── getSwarmNetworkInfo ───────────────────────────────────────────────

  describe('getSwarmNetworkInfo', () => {
    it('should return null when swarm not found', () => {
      vi.mocked(mapDal.findSwarmById).mockReturnValue(null as any);
      expect(getSwarmNetworkInfo('swarm-1')).toBeNull();
    });

    it('should return network fields from swarm record', () => {
      vi.mocked(mapDal.findSwarmById).mockReturnValue(
        mockSwarm({
          headscale_node_id: 'node-1',
          tailscale_ips: ['100.64.0.5'],
          tailscale_dns_name: 'my-swarm.hive.internal',
          mesh_peer_id: 'peer-abc',
        }) as any,
      );

      const info = getSwarmNetworkInfo('swarm-1');
      expect(info).toEqual({
        headscale_node_id: 'node-1',
        tailscale_ips: ['100.64.0.5'],
        tailscale_dns_name: 'my-swarm.hive.internal',
        mesh_peer_id: 'peer-abc',
      });
    });
  });
});
