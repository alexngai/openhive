/**
 * Dispatch context type — type-specific assertions beyond the generic
 * integrity suite in `context-registry.test.ts`.
 *
 * Covers §3.1 criteria for the `dispatch` type: registry presence,
 * identity non-emptiness, fenced-block regex shape, empty-attr pruning,
 * and optional `latest_attempt` rendering.
 */

import { describe, it, expect } from 'vitest';
import '../../components/chat-fab/context-types';
import { getContextType } from '../../components/chat-fab/context-registry';
import type {
  DispatchData,
} from '../../components/chat-fab/context-types/dispatch';

const FENCED_RE =
  /^<context kind="openhive:dispatch"( [a-z_]+="[^"]*")+>[\s\S]*<\/context>$/;

describe('dispatch context type', () => {
  it('is registered and retrievable via getContextType', () => {
    const spec = getContextType('dispatch');
    expect(spec).toBeDefined();
    expect(spec?.kind).toBe('openhive:dispatch');
  });

  it('identity(d).id is non-empty for a valid input', () => {
    const spec = getContextType('dispatch')!;
    const d: DispatchData = {
      id: 'd-abc123',
      spec_id: 'spec-xyz',
      target_swarm_id: 'swarm-1',
    };
    const id = spec.identity(d);
    expect(id.id).toBe('d-abc123');
    expect(id.id!.length).toBeGreaterThan(0);
  });

  it('format(d) matches the fenced-block regex', () => {
    const spec = getContextType('dispatch')!;
    const d: DispatchData = {
      id: 'd-abc123',
      spec_id: 'spec-xyz',
      target_swarm_id: 'swarm-1',
      status: 'running',
    };
    expect(spec.format(d)).toMatch(FENCED_RE);
  });

  it('format(d) omits spec_id and target_swarm_id attrs when empty', () => {
    const spec = getContextType('dispatch')!;
    const d: DispatchData = {
      id: 'd-only',
      spec_id: '',
      target_swarm_id: '',
    };
    const formatted = spec.format(d);
    expect(formatted).toContain('id="d-only"');
    expect(formatted).not.toContain('spec_id=');
    expect(formatted).not.toContain('target_swarm_id=');
    // Still matches the fenced-block regex — at least one identity attr
    // (`id`) is always emitted.
    expect(formatted).toMatch(FENCED_RE);
  });

  it('format(d) omits spec_id and target_swarm_id attrs when undefined', () => {
    const spec = getContextType('dispatch')!;
    // `undefined` values from loose callers — identity filter must drop them.
    const d = {
      id: 'd-loose',
      spec_id: undefined,
      target_swarm_id: undefined,
    } as unknown as DispatchData;
    const formatted = spec.format(d);
    expect(formatted).toContain('id="d-loose"');
    expect(formatted).not.toContain('spec_id=');
    expect(formatted).not.toContain('target_swarm_id=');
  });

  it('format(d) includes the "Latest attempt" row when latest_attempt is present', () => {
    const spec = getContextType('dispatch')!;
    const d: DispatchData = {
      id: 'd-abc123',
      spec_id: 'spec-xyz',
      target_swarm_id: 'swarm-1',
      status: 'failed',
      latest_attempt: {
        attempt: 2,
        status: 'failed',
        error: 'boom',
      },
    };
    const formatted = spec.format(d);
    expect(formatted).toContain('| Latest attempt | [`attempt-2`] failed — boom |');
  });

  it('format(d) omits the "Latest attempt" row when latest_attempt is absent', () => {
    const spec = getContextType('dispatch')!;
    const d: DispatchData = {
      id: 'd-abc123',
      spec_id: 'spec-xyz',
      target_swarm_id: 'swarm-1',
      status: 'queued',
    };
    const formatted = spec.format(d);
    expect(formatted).not.toContain('Latest attempt');
  });

  it('format(d) renders latest_attempt without error as just status', () => {
    const spec = getContextType('dispatch')!;
    const d: DispatchData = {
      id: 'd-abc123',
      spec_id: 'spec-xyz',
      target_swarm_id: 'swarm-1',
      latest_attempt: { attempt: 1, status: 'running' },
    };
    const formatted = spec.format(d);
    expect(formatted).toContain('| Latest attempt | [`attempt-1`] running |');
  });
});
