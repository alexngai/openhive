/**
 * Section-registry coverage. The visibility rules for SwarmDetail's
 * sections are central UX state — locking them in here so a future kind
 * doesn't accidentally inherit (or lose) sections via a stray edit.
 */

import { describe, it, expect } from 'vitest';
import { getSwarmDetailSections } from '../../lib/swarm-detail-sections';

const noAgents = { registered_agents: [] };
const oneAgent = { registered_agents: [{ id: 'sidecar' }] };

describe('getSwarmDetailSections', () => {
  describe('swarm-runner', () => {
    it('exposes the full fleet-shaped layout', () => {
      const ids = getSwarmDetailSections({ kind: 'swarm-runner' }, noAgents);
      expect(ids.has('active-work')).toBe(true);
      expect(ids.has('terminal')).toBe(true);
      expect(ids.has('logs')).toBe(true);
      expect(ids.has('nodes')).toBe(true);
      expect(ids.has('registered-agents')).toBe(true);
      expect(ids.has('spawn-agent')).toBe(true);
      expect(ids.has('resumable-sessions')).toBe(true);
      expect(ids.has('sessions')).toBe(true);
      expect(ids.has('compose-message')).toBe(true);
      expect(ids.has('messages')).toBe(true);
      expect(ids.has('events')).toBe(true);
      expect(ids.has('peers')).toBe(true);
    });

    it('treats a missing hosted record as swarm-runner (legacy MAP-only swarm)', () => {
      const ids = getSwarmDetailSections(undefined, noAgents);
      expect(ids.has('spawn-agent')).toBe(true);
    });
  });

  describe('claude-code', () => {
    it('hides spawn-agent, nodes, logs, peers, messages, events', () => {
      const ids = getSwarmDetailSections({ kind: 'claude-code' }, oneAgent);
      expect(ids.has('spawn-agent')).toBe(false);
      expect(ids.has('nodes')).toBe(false);
      expect(ids.has('logs')).toBe(false);
      expect(ids.has('peers')).toBe(false);
      expect(ids.has('messages')).toBe(false);
      expect(ids.has('events')).toBe(false);
    });

    it('keeps registered-agents (read-only) so operator sees the sidecar', () => {
      const ids = getSwarmDetailSections({ kind: 'claude-code' }, oneAgent);
      expect(ids.has('registered-agents')).toBe(true);
      expect(ids.has('spawn-agent')).toBe(false);
    });

    it('exposes ActiveWork + ComposeMessage only when the sidecar is connected', () => {
      const noSidecar = getSwarmDetailSections({ kind: 'claude-code' }, noAgents);
      const withSidecar = getSwarmDetailSections({ kind: 'claude-code' }, oneAgent);

      expect(noSidecar.has('active-work')).toBe(false);
      expect(noSidecar.has('compose-message')).toBe(false);

      expect(withSidecar.has('active-work')).toBe(true);
      expect(withSidecar.has('compose-message')).toBe(true);
    });

    it('always exposes Terminal + sessions surfaces regardless of sidecar', () => {
      const noSidecar = getSwarmDetailSections({ kind: 'claude-code' }, noAgents);
      expect(noSidecar.has('terminal')).toBe(true);
      expect(noSidecar.has('sessions')).toBe(true);
      expect(noSidecar.has('resumable-sessions')).toBe(true);
    });
  });

  describe('codex (TUI)', () => {
    it('exposes only Terminal — no MAP integration yet', () => {
      const ids = getSwarmDetailSections({ kind: 'codex', mode: 'tui' }, noAgents);
      expect([...ids].sort()).toEqual(['terminal']);
    });

    it('treats absent mode as TUI (defensive default)', () => {
      const ids = getSwarmDetailSections({ kind: 'codex' }, noAgents);
      expect(ids.has('terminal')).toBe(true);
      expect(ids.has('hosted-chat')).toBe(false);
    });
  });

  describe('codex (RPC)', () => {
    it('exposes no inline sections — chat lives on the Threads page now', () => {
      const ids = getSwarmDetailSections({ kind: 'codex', mode: 'rpc' }, noAgents);
      expect([...ids]).toEqual([]);
    });

    it('does NOT expose Terminal (no PTY to attach to)', () => {
      const ids = getSwarmDetailSections({ kind: 'codex', mode: 'rpc' }, noAgents);
      expect(ids.has('terminal')).toBe(false);
    });
  });
});
