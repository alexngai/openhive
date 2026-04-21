/**
 * Integration Test: Coordination Inbound Context Flow
 *
 * Tests the inbound path for swarm context events:
 *   MAP scope message → isMapContextEvent() → handleMapContextEvent()
 *   → broadcastToChannel('map:tasks', { type: 'spec.created'|'spec.updated', ... })
 *     (only for contexts with metadata.kind === 'spec')
 *
 * The opentasks MAP event bridge emits `context.created`/`context.updated`
 * for every context graph node an agent authors or edits. OpenHive treats
 * kind=spec contexts as Specs (with a first-class UI surface) and re-
 * broadcasts them as `spec.*` events; plain contexts are dropped for now.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const broadcastToChannel = vi.fn();
const getDefaultTaskGraph = vi.fn();

vi.mock('../../realtime/index.js', () => ({
  broadcastToChannel: (...args: unknown[]) => broadcastToChannel(...args),
}));

vi.mock('../../map/connection-registry.js', () => ({
  getDefaultTaskGraph: (...args: unknown[]) => getDefaultTaskGraph(...args),
}));

import { isMapContextEvent, handleMapContextEvent } from '../../coordination/listener.js';

beforeEach(() => {
  broadcastToChannel.mockReset();
  getDefaultTaskGraph.mockReset();
  getDefaultTaskGraph.mockReturnValue({ resource_id: 'res_abc' });
});

// ==========================================================================
// isMapContextEvent — Message Detection
// ==========================================================================

describe('isMapContextEvent — message detection', () => {
  it('recognizes context.created events', () => {
    expect(
      isMapContextEvent({
        payload: { type: 'context.created', context: { id: 'c1', title: 'Auth' } },
      }),
    ).toBe(true);
  });

  it('recognizes context.updated events', () => {
    expect(
      isMapContextEvent({
        payload: { type: 'context.updated', context: { id: 'c1', archived: true } },
      }),
    ).toBe(true);
  });

  it('rejects task events', () => {
    expect(isMapContextEvent({ payload: { type: 'task.created', task: { id: 't1' } } })).toBe(
      false,
    );
  });

  it('rejects unrelated types', () => {
    expect(isMapContextEvent({ payload: { type: 'trajectory.checkpoint' } })).toBe(false);
    expect(isMapContextEvent({ type: 'context.created' })).toBe(false); // no payload wrapper
    expect(isMapContextEvent(null)).toBe(false);
    expect(isMapContextEvent({})).toBe(false);
  });
});

// ==========================================================================
// handleMapContextEvent — spec-kind routing
// ==========================================================================

describe('handleMapContextEvent — spec-kind routing', () => {
  it('broadcasts spec.created with resolved resource_id when context has kind=spec', () => {
    handleMapContextEvent(
      {
        type: 'context.created',
        context: {
          id: 'ctx_1',
          title: 'Auth flow',
          metadata: { kind: 'spec' },
        },
      },
      'swarm_source',
      'agent_42',
    );

    expect(broadcastToChannel).toHaveBeenCalledWith('map:tasks', {
      type: 'spec.created',
      data: {
        spec: { id: 'ctx_1', title: 'Auth flow', metadata: { kind: 'spec' } },
        resource_id: 'res_abc',
        initiator: { type: 'agent', id: 'agent_42' },
      },
    });
  });

  it('broadcasts spec.updated when the context update carries kind=spec', () => {
    handleMapContextEvent(
      {
        type: 'context.updated',
        context: {
          id: 'ctx_1',
          title: 'New title',
          archived: true,
          metadata: { kind: 'spec' },
        },
      },
      'swarm_source',
      'agent_42',
    );

    expect(broadcastToChannel).toHaveBeenCalledWith('map:tasks', {
      type: 'spec.updated',
      data: {
        spec: {
          id: 'ctx_1',
          title: 'New title',
          archived: true,
          metadata: { kind: 'spec' },
        },
        resource_id: 'res_abc',
        initiator: { type: 'agent', id: 'agent_42' },
      },
    });
  });

  it('drops plain contexts (no kind=spec marker) — no consumer yet', () => {
    handleMapContextEvent(
      {
        type: 'context.created',
        context: {
          id: 'ctx_plain',
          title: 'Regular context',
          metadata: { tags: ['note'] },
        },
      },
      'swarm_source',
      'agent_42',
    );

    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('drops contexts lacking metadata entirely', () => {
    handleMapContextEvent(
      { type: 'context.created', context: { id: 'ctx_bare', title: 'No metadata' } },
      'swarm_source',
      'agent_42',
    );

    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('drops events lacking a context.id', () => {
    handleMapContextEvent(
      {
        type: 'context.created',
        context: { title: 'Missing id', metadata: { kind: 'spec' } },
      },
      'swarm_source',
      'agent_42',
    );

    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('drops events when the sending swarm has no default task graph', () => {
    getDefaultTaskGraph.mockReturnValue(undefined);

    handleMapContextEvent(
      {
        type: 'context.created',
        context: { id: 'ctx_1', title: 'Orphan', metadata: { kind: 'spec' } },
      },
      'swarm_unknown',
      'agent_42',
    );

    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('drops events when the default task graph lacks a resource_id', () => {
    getDefaultTaskGraph.mockReturnValue({ path: '/no/id/here' });

    handleMapContextEvent(
      {
        type: 'context.created',
        context: { id: 'ctx_1', title: 'Pathless', metadata: { kind: 'spec' } },
      },
      'swarm_1',
      'agent_42',
    );

    expect(broadcastToChannel).not.toHaveBeenCalled();
  });
});
