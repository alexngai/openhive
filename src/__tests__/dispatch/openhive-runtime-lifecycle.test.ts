/**
 * Unit tests for openhive-runtime's lifecycle branch.
 *
 * Covers `readDispatchLifecycle` precedence and `toWireLoadout` shape
 * conversion. These are pure helpers extracted from the runtime adapter
 * so the precedence + wire-shape logic can be regression-tested without
 * spinning up an orchestrator.
 *
 * The runtime adapter's resolveTarget itself is exercised end-to-end by
 * the live ACP+fresh and ACP+reuse tests; these unit tests catch the
 * precedence rules earlier in CI without requiring LIVE_AGENT_E2E.
 */

import { describe, it, expect } from 'vitest';
import {
  readDispatchLifecycle,
  toWireLoadout,
} from '../../dispatch/openhive-runtime.js';
import type { Dispatch } from '../../db/dal/dispatches.js';
import type { MaterializedLoadout } from '../../openteams/types.js';

// ============================================================================
// Test fixtures
// ============================================================================

function fakeDispatch(): Dispatch {
  return {
    id: 'disp_test',
    spec_resource_id: 'res_test',
    spec_id: 'spec_test',
    spec_captured_at: null,
    target_swarm_id: 'swarm_test',
    status: 'queued',
    initiator_type: 'user',
    initiator_id: 'agent_test',
    session_ids: [],
    outcome: null,
    prompt_override: null,
    lease_token: null,
    lease_expires_at: null,
    attempt: 0,
    turn_count: 0,
    attempts_history: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
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

// ============================================================================
// readDispatchLifecycle precedence
// ============================================================================

describe('readDispatchLifecycle', () => {
  it("returns 'fresh' when no hint is provided (default)", () => {
    expect(readDispatchLifecycle(fakeDispatch(), null, null)).toBe('fresh');
    expect(readDispatchLifecycle(fakeDispatch(), emptyLoadout(), null)).toBe('fresh');
  });

  it("returns 'fresh' when hints.acpLifecycle is undefined", () => {
    expect(readDispatchLifecycle(fakeDispatch(), null, {})).toBe('fresh');
  });

  it("returns 'fresh' when hints.acpLifecycle is explicitly 'fresh'", () => {
    expect(
      readDispatchLifecycle(fakeDispatch(), null, { acpLifecycle: 'fresh' }),
    ).toBe('fresh');
  });

  it("returns 'reuse' when hints.acpLifecycle is 'reuse'", () => {
    expect(
      readDispatchLifecycle(fakeDispatch(), null, { acpLifecycle: 'reuse' }),
    ).toBe('reuse');
  });

  it("returns 'fresh' for invalid hint values (defensive default)", () => {
    // Cast through unknown to simulate runtime-bad data slipping past the
    // type system (e.g., from a corrupted spec metadata).
    expect(
      readDispatchLifecycle(fakeDispatch(), null, {
        acpLifecycle: 'invalid' as unknown as 'fresh',
      }),
    ).toBe('fresh');
    expect(
      readDispatchLifecycle(fakeDispatch(), null, {
        acpLifecycle: '' as unknown as 'fresh',
      }),
    ).toBe('fresh');
    expect(
      readDispatchLifecycle(fakeDispatch(), null, {
        acpLifecycle: null as unknown as 'fresh',
      }),
    ).toBe('fresh');
  });

  it('does not consult dispatch or loadout fields today (Step 6 deferred)', () => {
    // Documents the current shape: precedence is hint-only. When loadout-
    // level (`loadout.openhive.acp_lifecycle`) and global config defaults
    // are added in a follow-up, this test should be split + extended.
    const dispatch = fakeDispatch();
    const loadout = emptyLoadout();
    expect(readDispatchLifecycle(dispatch, loadout, null)).toBe('fresh');
    // Even with synthetic dispatch.metadata-like fields, no lookup happens.
    (dispatch as unknown as { metadata: unknown }).metadata = {
      acp_lifecycle: 'reuse',
    };
    expect(readDispatchLifecycle(dispatch, loadout, null)).toBe('fresh');
  });
});

// ============================================================================
// toWireLoadout shape
// ============================================================================

describe('toWireLoadout', () => {
  it('returns an empty object for an empty loadout', () => {
    expect(toWireLoadout(emptyLoadout())).toEqual({});
  });

  it('emits permissions only when at least one rule is present', () => {
    const loadout = emptyLoadout();
    loadout.permissions.deny = ['Bash(rm -rf:*)'];
    expect(toWireLoadout(loadout)).toEqual({
      permissions: { deny: ['Bash(rm -rf:*)'] },
    });
  });

  it('preserves all three permission lists when populated', () => {
    const loadout = emptyLoadout();
    loadout.permissions.allow = ['Read(**)'];
    loadout.permissions.deny = ['Bash(rm -rf:*)'];
    loadout.permissions.ask = ['Write(.env)'];
    expect(toWireLoadout(loadout)).toEqual({
      permissions: {
        allow: ['Read(**)'],
        deny: ['Bash(rm -rf:*)'],
        ask: ['Write(.env)'],
      },
    });
  });

  it('omits permission lists that are empty arrays', () => {
    const loadout = emptyLoadout();
    loadout.permissions.deny = ['Bash(rm -rf:*)'];
    // allow + ask remain []; should not appear in wire output
    const wire = toWireLoadout(loadout);
    expect((wire.permissions as Record<string, unknown>).allow).toBeUndefined();
    expect((wire.permissions as Record<string, unknown>).ask).toBeUndefined();
  });

  it('emits mcpProviders, mcpScope, capabilities when populated', () => {
    const loadout = emptyLoadout();
    loadout.mcpProviders = [
      { name: 'agent-inbox', command: 'node', args: ['proxy.js'] },
    ];
    loadout.mcpScope = [{ server: 'agent-inbox' }];
    loadout.capabilities = ['file.read', 'codebase.search'];
    const wire = toWireLoadout(loadout);
    expect(wire.mcpProviders).toEqual([
      { name: 'agent-inbox', command: 'node', args: ['proxy.js'] },
    ]);
    expect(wire.mcpScope).toEqual([{ server: 'agent-inbox' }]);
    expect(wire.capabilities).toEqual(['file.read', 'codebase.search']);
  });

  it('omits mcpProviders, mcpScope, capabilities when empty', () => {
    const wire = toWireLoadout(emptyLoadout());
    expect(wire.mcpProviders).toBeUndefined();
    expect(wire.mcpScope).toBeUndefined();
    expect(wire.capabilities).toBeUndefined();
  });

  it('does not include skills, promptAddendum, materializedAt — those ride in the prompt body', () => {
    // skills.rendered + promptAddendum reach the worker via the dispatch
    // prompt's text body (built by openHivePromptBuilder), not via the
    // structured wire payload. The wire shape is intentionally narrower.
    const loadout = emptyLoadout();
    loadout.skills = {
      rendered: '<skills_system>...</skills_system>',
      estimatedTokens: 1234,
      skillBankResourceId: 'res_skillbank',
      items: [{ id: 's1', name: 'security-review' }],
    };
    loadout.promptAddendum = '## Reviewer\n\nFocus on correctness.';
    loadout.materializedAt = '2026-05-04T00:00:00.000Z';
    const wire = toWireLoadout(loadout);
    expect(wire.skills).toBeUndefined();
    expect(wire.promptAddendum).toBeUndefined();
    expect(wire.materializedAt).toBeUndefined();
  });

  it('combines all populated fields into a single wire object', () => {
    const loadout = emptyLoadout();
    loadout.permissions.deny = ['Bash(rm -rf:*)'];
    loadout.mcpProviders = [{ name: 'agent-inbox', command: 'node' }];
    loadout.capabilities = ['file.read'];
    expect(toWireLoadout(loadout)).toEqual({
      permissions: { deny: ['Bash(rm -rf:*)'] },
      mcpProviders: [{ name: 'agent-inbox', command: 'node' }],
      capabilities: ['file.read'],
    });
  });
});
