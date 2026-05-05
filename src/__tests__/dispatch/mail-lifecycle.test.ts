/**
 * Unit tests for the mail port's `mail_lifecycle: 'fresh'` override.
 *
 * The override re-routes a dispatch to the connection's sidecar regardless
 * of which agent prefer-route picked. Mirrors the V47 acp_lifecycle shape
 * but with target-rewrite semantics instead of reject-and-fall-through.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import {
  createOpenHiveMailPort,
  readMailLifecycle,
  type MailTransport,
} from '../../dispatch/openhive-mail-port.js';
import {
  registerInbound,
  type MapInboundConnection,
  type RegisteredAgent,
} from '../../map/connection-registry.js';
import {
  registerLoadoutForDispatch,
  _resetLoadoutSideChannelForTest,
} from '../../dispatch/loadout-side-channel.js';
import type { MaterializedLoadout } from '../../openteams/types.js';

// Per-test swarm IDs avoid cross-test bleed via the registry's stale-grace
// carryover (registerInbound seeds a new conn's agents from the prior conn
// for the 30s grace window, which would mask a "no sidecar" assertion).
const SIDECAR_AGENT = 'a-sidecar';
const WORKER_AGENT = 'a-worker';
let testCounter = 0;
function nextSwarm(): string {
  return `swarm_mail_lifecycle_${++testCounter}`;
}

function fakeWs(): WebSocket {
  const ee = new EventEmitter() as unknown as WebSocket;
  (ee as unknown as Record<string, unknown>).readyState = 1;
  (ee as unknown as Record<string, unknown>).send = () => {};
  (ee as unknown as Record<string, unknown>).close = () => {};
  (ee as unknown as Record<string, unknown>).terminate = () => {};
  return ee;
}

function makeAgent(id: string, role: string): RegisteredAgent {
  return { id, name: `agent-${id}`, role, state: 'idle', scopes: [] };
}

function registerSwarmWith(swarmId: string, agents: RegisteredAgent[]): void {
  const conn: MapInboundConnection = {
    ws: fakeWs(),
    agentId: agents[0]?.id ?? 'placeholder',
    swarmId,
    connectedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    registeredAgents: new Map(agents.map((a) => [a.id, a])),
  };
  registerInbound(swarmId, conn);
}

function emptyLoadout(): MaterializedLoadout {
  return {
    capabilities: [],
    mcpScope: [],
    mcpProviders: [],
    permissions: { allow: [], deny: [], ask: [] },
    promptAddendum: '',
    skills: null,
    unresolvedRefs: [],
    materializedAt: new Date().toISOString(),
  };
}

function fakeTransport(): {
  transport: MailTransport;
  sendCalls: Array<{ swarmId: string; agentId: string; envelope: unknown }>;
} {
  const sendCalls: Array<{ swarmId: string; agentId: string; envelope: unknown }> = [];
  const transport: MailTransport = {
    sendToAgent: vi.fn(async (swarmId, agentId, envelope) => {
      sendCalls.push({ swarmId, agentId, envelope });
      return { delivered: true };
    }),
    onMessage: vi.fn(() => () => {}),
  };
  return { transport, sendCalls };
}

describe('createOpenHiveMailPort — mail_lifecycle override', () => {
  beforeEach(() => {
    _resetLoadoutSideChannelForTest();
  });

  it("re-routes 'fresh' to the sidecar when prefer-route picked a non-sidecar", async () => {
    const swarm = nextSwarm();
    registerSwarmWith(swarm, [
      makeAgent(SIDECAR_AGENT, 'sidecar'),
      makeAgent(WORKER_AGENT, 'worker'),
    ]);
    registerLoadoutForDispatch('disp_fresh', emptyLoadout(), {
      mailLifecycle: 'fresh',
    });

    const { transport, sendCalls } = fakeTransport();
    const port = createOpenHiveMailPort(transport);

    const result = await port.deliver(
      { system: swarm, agentId: WORKER_AGENT },
      { prompt: 'do the thing', taskId: 'disp_fresh', role: 'worker' },
    );

    expect(result.delivered).toBe(true);
    expect(sendCalls).toHaveLength(1);
    // The override flipped the recipient from worker → sidecar.
    expect(sendCalls[0]!.agentId).toBe(SIDECAR_AGENT);
    expect(sendCalls[0]!.swarmId).toBe(swarm);
  });

  it("does not override when 'fresh' but the picked agent IS the sidecar", async () => {
    const swarm = nextSwarm();
    registerSwarmWith(swarm, [makeAgent(SIDECAR_AGENT, 'sidecar')]);
    registerLoadoutForDispatch('disp_already_sidecar', emptyLoadout(), {
      mailLifecycle: 'fresh',
    });

    const { transport, sendCalls } = fakeTransport();
    const port = createOpenHiveMailPort(transport);

    await port.deliver(
      { system: swarm, agentId: SIDECAR_AGENT },
      { prompt: 'p', taskId: 'disp_already_sidecar', role: 'worker' },
    );

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.agentId).toBe(SIDECAR_AGENT);
  });

  it("falls through silently to the picked agent when 'fresh' but no sidecar is registered", async () => {
    const swarm = nextSwarm();
    registerSwarmWith(swarm, [makeAgent(WORKER_AGENT, 'worker')]);
    registerLoadoutForDispatch('disp_no_sidecar', emptyLoadout(), {
      mailLifecycle: 'fresh',
    });

    const { transport, sendCalls } = fakeTransport();
    const port = createOpenHiveMailPort(transport);

    await port.deliver(
      { system: swarm, agentId: WORKER_AGENT },
      { prompt: 'p', taskId: 'disp_no_sidecar', role: 'worker' },
    );

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.agentId).toBe(WORKER_AGENT);
  });

  it("'reuse' (or omitted) passes through to the picked agent", async () => {
    const swarm = nextSwarm();
    registerSwarmWith(swarm, [
      makeAgent(SIDECAR_AGENT, 'sidecar'),
      makeAgent(WORKER_AGENT, 'worker'),
    ]);
    registerLoadoutForDispatch('disp_reuse', emptyLoadout(), {
      mailLifecycle: 'reuse',
    });

    const { transport, sendCalls } = fakeTransport();
    const port = createOpenHiveMailPort(transport);

    await port.deliver(
      { system: swarm, agentId: WORKER_AGENT },
      { prompt: 'p', taskId: 'disp_reuse', role: 'worker' },
    );

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.agentId).toBe(WORKER_AGENT);
  });

  it("config default 'fresh' applies when per-dispatch hint is absent", async () => {
    const swarm = nextSwarm();
    registerSwarmWith(swarm, [
      makeAgent(SIDECAR_AGENT, 'sidecar'),
      makeAgent(WORKER_AGENT, 'worker'),
    ]);
    // No per-dispatch lifecycle hint registered — should fall through to
    // the cluster default supplied via the factory option.
    registerLoadoutForDispatch('disp_default_fresh', emptyLoadout(), {});

    const { transport, sendCalls } = fakeTransport();
    const port = createOpenHiveMailPort(transport, {
      mailLifecycleDefault: 'fresh',
    });

    await port.deliver(
      { system: swarm, agentId: WORKER_AGENT },
      { prompt: 'p', taskId: 'disp_default_fresh', role: 'worker' },
    );

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.agentId).toBe(SIDECAR_AGENT);
  });

  it("per-dispatch hint overrides cluster default ('reuse' beats default 'fresh')", async () => {
    const swarm = nextSwarm();
    registerSwarmWith(swarm, [
      makeAgent(SIDECAR_AGENT, 'sidecar'),
      makeAgent(WORKER_AGENT, 'worker'),
    ]);
    registerLoadoutForDispatch('disp_override_reuse', emptyLoadout(), {
      mailLifecycle: 'reuse',
    });

    const { transport, sendCalls } = fakeTransport();
    const port = createOpenHiveMailPort(transport, {
      mailLifecycleDefault: 'fresh',
    });

    await port.deliver(
      { system: swarm, agentId: WORKER_AGENT },
      { prompt: 'p', taskId: 'disp_override_reuse', role: 'worker' },
    );

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]!.agentId).toBe(WORKER_AGENT);
  });

  it("'acp_lifecycle: fresh' takes precedence — returns delivered:false (existing behavior)", async () => {
    const swarm = nextSwarm();
    registerSwarmWith(swarm, [
      makeAgent(SIDECAR_AGENT, 'sidecar'),
      makeAgent(WORKER_AGENT, 'worker'),
    ]);
    // Both hints set — ACP fresh checked first, mail-fresh is irrelevant.
    registerLoadoutForDispatch('disp_acp_fresh', emptyLoadout(), {
      acpLifecycle: 'fresh',
      mailLifecycle: 'fresh',
    });

    const { transport, sendCalls } = fakeTransport();
    const port = createOpenHiveMailPort(transport);

    const result = await port.deliver(
      { system: swarm, agentId: WORKER_AGENT },
      { prompt: 'p', taskId: 'disp_acp_fresh', role: 'worker' },
    );

    expect(result.delivered).toBe(false);
    expect(sendCalls).toHaveLength(0);
  });
});

// ============================================================================
// readMailLifecycle precedence — pure unit tests
// ============================================================================

describe('readMailLifecycle', () => {
  it("returns 'reuse' when no hint and no config default", () => {
    expect(readMailLifecycle(null)).toBe('reuse');
    expect(readMailLifecycle({})).toBe('reuse');
  });

  it("returns 'fresh' when hint is 'fresh'", () => {
    expect(readMailLifecycle({ mailLifecycle: 'fresh' })).toBe('fresh');
  });

  it("returns 'reuse' when hint is 'reuse'", () => {
    expect(readMailLifecycle({ mailLifecycle: 'reuse' })).toBe('reuse');
  });

  it("falls back to config default when hint is absent", () => {
    expect(readMailLifecycle(null, 'fresh')).toBe('fresh');
    expect(readMailLifecycle({}, 'fresh')).toBe('fresh');
    expect(readMailLifecycle(null, 'reuse')).toBe('reuse');
  });

  it("hint beats config default", () => {
    expect(readMailLifecycle({ mailLifecycle: 'reuse' }, 'fresh')).toBe('reuse');
    expect(readMailLifecycle({ mailLifecycle: 'fresh' }, 'reuse')).toBe('fresh');
  });

  it("invalid hint values fall through to default", () => {
    expect(
      readMailLifecycle({
        mailLifecycle: 'invalid' as unknown as 'fresh',
      }),
    ).toBe('reuse');
    expect(
      readMailLifecycle({
        mailLifecycle: '' as unknown as 'fresh',
      }),
    ).toBe('reuse');
  });
});
