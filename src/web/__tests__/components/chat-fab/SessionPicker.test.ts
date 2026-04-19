/**
 * SessionPicker.buildPickerAgents
 *
 * The picker flattens `swarms[].registered_agents[]` into one row per
 * chat-capable agent (instead of one row per swarm, which was the old
 * behavior that hid multiple coordinators). This test guards the
 * filtering rules — sidecars are hidden, ACP is per-agent, mail is
 * swarm-level — and the stable ordering the UI depends on.
 */

import { describe, it, expect } from 'vitest';
import { buildPickerAgents } from '../../../components/chat-fab/SessionPicker';
import type { MapSwarm } from '../../../lib/api';

function makeSwarm(overrides: Partial<MapSwarm> & { registered_agents?: unknown[] } = {}): MapSwarm {
  return {
    id: overrides.id ?? 'swarm_1',
    name: overrides.name ?? 'test-swarm',
    description: null,
    map_endpoint: 'ws://localhost:9000',
    map_transport: 'websocket',
    status: (overrides.status ?? 'online') as MapSwarm['status'],
    last_seen_at: new Date().toISOString(),
    capabilities: overrides.capabilities ?? null,
    auth_method: 'none',
    agent_count: 0,
    scope_count: 0,
    metadata: null,
    hives: [],
    created_at: new Date().toISOString(),
    ...overrides,
  } as MapSwarm;
}

describe('buildPickerAgents', () => {
  it('lists one row per ACP-capable agent', () => {
    const swarm = makeSwarm({
      id: 'swarm_1',
      name: 'macro-a',
      registered_agents: [
        { id: 'a1', name: 'coord-one', role: 'coordinator', capabilities: { protocols: ['acp'] } },
        { id: 'a2', name: 'coord-two', role: 'coordinator', capabilities: { protocols: ['acp'] } },
      ],
    });
    const rows = buildPickerAgents([swarm]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.agent.name)).toEqual(['coord-one', 'coord-two']);
    expect(rows.every((r) => r.mode === 'acp')).toBe(true);
  });

  it('filters out sidecar role — they are the connection, not a participant', () => {
    const swarm = makeSwarm({
      id: 'swarm_1',
      registered_agents: [
        { id: 's1', name: 'macro-sidecar', role: 'sidecar', capabilities: { protocols: ['acp'] } },
        { id: 'a1', name: 'coord', role: 'coordinator', capabilities: { protocols: ['acp'] } },
      ],
    });
    const rows = buildPickerAgents([swarm]);
    expect(rows).toHaveLength(1);
    expect(rows[0].agent.name).toBe('coord');
  });

  it('surfaces mail mode when the swarm declares mail but the agent has no ACP', () => {
    const swarm = makeSwarm({
      id: 'swarm_1',
      capabilities: { mail: { canJoin: true } },
      registered_agents: [
        { id: 'w1', name: 'worker', role: 'worker', capabilities: {} },
      ],
    });
    const rows = buildPickerAgents([swarm]);
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('mail');
  });

  it('prefers ACP over mail when the agent carries both affordances', () => {
    const swarm = makeSwarm({
      id: 'swarm_1',
      capabilities: { mail: { canJoin: true } },
      registered_agents: [
        { id: 'a1', name: 'coord', role: 'coordinator', capabilities: { protocols: ['acp'] } },
      ],
    });
    const rows = buildPickerAgents([swarm]);
    expect(rows[0].mode).toBe('acp');
  });

  it('skips agents on swarms with no chat capability at all', () => {
    const swarm = makeSwarm({
      id: 'swarm_1',
      capabilities: { observation: true },
      registered_agents: [
        { id: 'a1', name: 'coord', role: 'coordinator', capabilities: {} },
      ],
    });
    const rows = buildPickerAgents([swarm]);
    expect(rows).toHaveLength(0);
  });

  it('flattens agents across multiple swarms in order', () => {
    const swarms = [
      makeSwarm({
        id: 'swarm_1',
        name: 'first',
        registered_agents: [
          { id: 'a', role: 'coordinator', capabilities: { protocols: ['acp'] } },
        ],
      }),
      makeSwarm({
        id: 'swarm_2',
        name: 'second',
        registered_agents: [
          { id: 'b', role: 'coordinator', capabilities: { protocols: ['acp'] } },
          { id: 'c', role: 'coordinator', capabilities: { protocols: ['acp'] } },
        ],
      }),
    ];
    const rows = buildPickerAgents(swarms);
    expect(rows.map((r) => r.swarm.name)).toEqual(['first', 'second', 'second']);
    expect(rows.map((r) => r.agent.id)).toEqual(['a', 'b', 'c']);
  });

  it('handles swarms with no registered_agents field at all (empty result)', () => {
    const swarm = makeSwarm({ id: 'swarm_1' });
    expect(buildPickerAgents([swarm])).toEqual([]);
  });

  it('does not cross-contaminate capabilities: a coord on one swarm never inherits mail from a sibling swarm', () => {
    // Regression guard: earlier iterations ran a single swarm-level check
    // to decide whether any agent was addressable; mailing capability on
    // swarm B could leak into "address agents on swarm A via mail."
    const mailSwarm = makeSwarm({
      id: 'swarm_mail',
      capabilities: { mail: { canJoin: true } },
      registered_agents: [
        { id: 'm1', name: 'mailer', role: 'worker', capabilities: {} },
      ],
    });
    const obsSwarm = makeSwarm({
      id: 'swarm_obs',
      capabilities: { observation: true },
      registered_agents: [
        { id: 'o1', name: 'watcher', role: 'worker', capabilities: {} },
      ],
    });
    const rows = buildPickerAgents([mailSwarm, obsSwarm]);
    expect(rows).toHaveLength(1);
    expect(rows[0].agent.name).toBe('mailer');
    expect(rows[0].mode).toBe('mail');
  });
});
