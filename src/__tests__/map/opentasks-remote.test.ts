/**
 * Tests for opentasks-remote.ts — swarm matching and remote query logic.
 *
 * Focuses on findSwarmForResource:
 * - Matching by location_hash, resource_id, path
 * - owner_agent_id fallback requires defaultTaskGraph
 * - Skips closed connections
 */

import { describe, it, expect, afterEach } from 'vitest';
import { registerInbound, unregisterInbound, getAllInbound } from '../../map/connection-registry.js';
import { findSwarmForResource } from '../../map/opentasks-remote.js';
import type { SyncableResource } from '../../types.js';

// Minimal mock WebSocket
function mockWs(readyState = 1): any {
  return { readyState, close: () => {} };
}

function makeResource(overrides: Partial<SyncableResource> = {}): SyncableResource {
  return {
    id: 'res_test',
    resource_type: 'task',
    name: 'test-resource',
    description: null,
    git_remote_url: '/some/path',
    webhook_secret: null,
    visibility: 'private',
    last_commit_hash: null,
    last_push_by: null,
    last_push_at: null,
    owner_agent_id: 'agent_owner',
    scope: 'manual',
    sync_strategy: 'metadata',
    local_path: null,
    metadata: { opentasks: true },
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  };
}

describe('findSwarmForResource', () => {
  afterEach(() => {
    // Clean up all registered connections
    for (const id of [...getAllInbound().keys()]) {
      unregisterInbound(id);
    }
  });

  it('should return null when no swarms are connected', () => {
    const resource = makeResource();
    expect(findSwarmForResource(resource)).toBeNull();
  });

  it('should match by location_hash', () => {
    registerInbound('swarm-1', {
      ws: mockWs(),
      agentId: 'other_agent',
      swarmId: 'swarm-1',
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map(),
      defaultTaskGraph: { location_hash: 'hash-abc' },
    });

    const resource = makeResource({ metadata: { opentasks: true, location_hash: 'hash-abc' } });
    expect(findSwarmForResource(resource)).toBe('swarm-1');
  });

  it('should match by resource_id', () => {
    registerInbound('swarm-2', {
      ws: mockWs(),
      agentId: 'other_agent',
      swarmId: 'swarm-2',
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map(),
      defaultTaskGraph: { resource_id: 'res_target' },
    });

    const resource = makeResource({ id: 'res_target' });
    expect(findSwarmForResource(resource)).toBe('swarm-2');
  });

  it('should match by path', () => {
    registerInbound('swarm-3', {
      ws: mockWs(),
      agentId: 'other_agent',
      swarmId: 'swarm-3',
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map(),
      defaultTaskGraph: { path: '/project/.opentasks' },
    });

    const resource = makeResource({ local_path: '/project/.opentasks' });
    expect(findSwarmForResource(resource)).toBe('swarm-3');
  });

  it('should skip closed connections', () => {
    registerInbound('swarm-closed', {
      ws: mockWs(3), // readyState 3 = CLOSED
      agentId: 'agent_owner',
      swarmId: 'swarm-closed',
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map(),
      defaultTaskGraph: { location_hash: 'hash-abc' },
    });

    const resource = makeResource({ metadata: { opentasks: true, location_hash: 'hash-abc' } });
    expect(findSwarmForResource(resource)).toBeNull();
  });

  // ── owner_agent_id fallback ──

  it('should match by owner_agent_id when swarm has defaultTaskGraph', () => {
    registerInbound('swarm-owned', {
      ws: mockWs(),
      agentId: 'agent_owner',
      swarmId: 'swarm-owned',
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map(),
      defaultTaskGraph: { location_hash: 'different-hash' },
    });

    const resource = makeResource({ owner_agent_id: 'agent_owner' });
    expect(findSwarmForResource(resource)).toBe('swarm-owned');
  });

  it('should NOT match by owner_agent_id when swarm has no defaultTaskGraph', () => {
    registerInbound('swarm-no-tasks', {
      ws: mockWs(),
      agentId: 'agent_owner',
      swarmId: 'swarm-no-tasks',
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map(),
      // No defaultTaskGraph — swarm doesn't support opentasks
    });

    const resource = makeResource({ owner_agent_id: 'agent_owner' });
    expect(findSwarmForResource(resource)).toBeNull();
  });

  it('should NOT match by owner_agent_id when swarm has undefined defaultTaskGraph', () => {
    registerInbound('swarm-undef', {
      ws: mockWs(),
      agentId: 'agent_owner',
      swarmId: 'swarm-undef',
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map(),
      defaultTaskGraph: undefined,
    });

    const resource = makeResource({ owner_agent_id: 'agent_owner' });
    expect(findSwarmForResource(resource)).toBeNull();
  });

  it('should prefer specific match over owner_agent_id fallback', () => {
    // Swarm with matching location_hash
    registerInbound('swarm-specific', {
      ws: mockWs(),
      agentId: 'other_agent',
      swarmId: 'swarm-specific',
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map(),
      defaultTaskGraph: { location_hash: 'target-hash' },
    });

    // Swarm matching only by owner_agent_id
    registerInbound('swarm-fallback', {
      ws: mockWs(),
      agentId: 'agent_owner',
      swarmId: 'swarm-fallback',
      connectedAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
      registeredAgents: new Map(),
      defaultTaskGraph: { location_hash: 'unrelated-hash' },
    });

    const resource = makeResource({
      owner_agent_id: 'agent_owner',
      metadata: { opentasks: true, location_hash: 'target-hash' },
    });
    expect(findSwarmForResource(resource)).toBe('swarm-specific');
  });
});
