/**
 * Tests for useSessionChat capability resolution and mode gating logic.
 * Imports the REAL resolveCapabilities function (exported for testing).
 */
import { describe, it, expect, vi } from 'vitest';

// Mock swarmcraft to avoid sigma/WebGL dependency in test environment
vi.mock('swarmcraft/ui/embed', () => ({
  useChatChannel: () => ({ mode: 'unavailable', status: 'detecting', send: async () => {} }),
}));

import { resolveCapabilities } from '../../hooks/useSessionChat';
import type { SwarmChatCapabilities } from '../../hooks/useSessionChat';

// Test the capability → mode gating logic (matches useSessionChat internals)
function resolveMode(caps: SwarmChatCapabilities): 'acp' | 'mail' | 'inject' | 'unavailable' {
  if (!caps.connected) return 'unavailable';
  if (caps.supportsAcp) return 'acp'; // ACP tried first in cascade
  if (caps.mail) return 'mail';       // Mail adapter provided
  if (caps.messaging) return 'inject'; // MAP messaging only → inject
  return 'unavailable';
}

describe('resolveCapabilities', () => {
  it('returns all-false for undefined swarm', () => {
    const caps = resolveCapabilities(undefined);
    expect(caps).toEqual({
      mail: false, messaging: false, supportsAcp: false, connected: false, protocols: [],
    });
  });

  it('returns all-false for null capabilities', () => {
    const caps = resolveCapabilities({ status: 'online', capabilities: null });
    expect(caps.mail).toBe(false);
    expect(caps.messaging).toBe(false);
    expect(caps.supportsAcp).toBe(false);
    expect(caps.connected).toBe(true);
  });

  describe('connected status', () => {
    it('online → connected', () => {
      expect(resolveCapabilities({ status: 'online', capabilities: {} }).connected).toBe(true);
    });

    it('unreachable → connected', () => {
      expect(resolveCapabilities({ status: 'unreachable', capabilities: {} }).connected).toBe(true);
    });

    it('offline → not connected', () => {
      expect(resolveCapabilities({ status: 'offline', capabilities: {} }).connected).toBe(false);
    });
  });

  describe('mail capabilities (MAP ParticipantCapabilities.mail)', () => {
    it('detects mail.canJoin', () => {
      const caps = resolveCapabilities({
        status: 'online',
        capabilities: { mail: { canJoin: true } },
      });
      expect(caps.mail).toBe(true);
    });

    it('detects mail.canCreate', () => {
      const caps = resolveCapabilities({
        status: 'online',
        capabilities: { mail: { canCreate: true } },
      });
      expect(caps.mail).toBe(true);
    });

    it('rejects mail without canJoin or canCreate', () => {
      const caps = resolveCapabilities({
        status: 'online',
        capabilities: { mail: { canViewHistory: true } },
      });
      expect(caps.mail).toBe(false);
    });

    it('rejects absent mail capability', () => {
      const caps = resolveCapabilities({
        status: 'online',
        capabilities: { messaging: { canReceive: true } },
      });
      expect(caps.mail).toBe(false);
    });
  });

  describe('messaging capabilities (MAP ParticipantCapabilities.messaging)', () => {
    it('detects structured messaging.canReceive', () => {
      const caps = resolveCapabilities({
        status: 'online',
        capabilities: { messaging: { canSend: true, canReceive: true } },
      });
      expect(caps.messaging).toBe(true);
    });

    it('detects legacy flat messaging: true', () => {
      const caps = resolveCapabilities({
        status: 'online',
        capabilities: { messaging: true },
      });
      expect(caps.messaging).toBe(true);
    });

    it('rejects messaging without canReceive', () => {
      const caps = resolveCapabilities({
        status: 'online',
        capabilities: { messaging: { canSend: true } },
      });
      expect(caps.messaging).toBe(false);
    });

    it('rejects messaging: false', () => {
      const caps = resolveCapabilities({
        status: 'online',
        capabilities: { messaging: false },
      });
      expect(caps.messaging).toBe(false);
    });
  });

  describe('ACP protocol support', () => {
    it('detects protocols including acp', () => {
      const caps = resolveCapabilities({
        status: 'online',
        capabilities: { protocols: ['acp', 'mcp'] },
      });
      expect(caps.supportsAcp).toBe(true);
      expect(caps.protocols).toEqual(['acp', 'mcp']);
    });

    it('rejects protocols without acp', () => {
      const caps = resolveCapabilities({
        status: 'online',
        capabilities: { protocols: ['mcp'] },
      });
      expect(caps.supportsAcp).toBe(false);
    });

    it('handles missing protocols field', () => {
      const caps = resolveCapabilities({ status: 'online', capabilities: {} });
      expect(caps.supportsAcp).toBe(false);
      expect(caps.protocols).toEqual([]);
    });
  });

  describe('cc-swarm capability declaration', () => {
    it('resolves correctly for cc-swarm capabilities', () => {
      const caps = resolveCapabilities({
        status: 'online',
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          mail: { canCreate: true, canJoin: true, canViewHistory: true },
          trajectory: { canReport: true, canServeContent: true },
          tasks: { canCreate: true, canAssign: true, canUpdate: true, canList: true },
        },
      });
      expect(caps.connected).toBe(true);
      expect(caps.mail).toBe(true);
      expect(caps.messaging).toBe(true);
      expect(caps.supportsAcp).toBe(false);
    });
  });

  describe('macro-agent capability declaration', () => {
    it('resolves correctly for macro-agent capabilities', () => {
      const caps = resolveCapabilities({
        status: 'online',
        capabilities: {
          messaging: { canSend: true, canReceive: true },
          mail: { canCreate: true, canJoin: true, canViewHistory: true },
          protocols: ['acp'],
          acp: { version: '2024-10-07' },
          trajectory: { canReport: true, canServeContent: false },
          tasks: { canCreate: true, canAssign: true, canUpdate: true, canList: true },
        },
      });
      expect(caps.connected).toBe(true);
      expect(caps.mail).toBe(true);
      expect(caps.messaging).toBe(true);
      expect(caps.supportsAcp).toBe(true);
    });
  });
});

describe('capability → mode mapping', () => {
  it('offline → unavailable', () => {
    expect(resolveMode({
      mail: true, messaging: true, supportsAcp: true,
      connected: false, protocols: ['acp'],
    })).toBe('unavailable');
  });

  it('connected + acp → acp (highest priority)', () => {
    expect(resolveMode({
      mail: true, messaging: true, supportsAcp: true,
      connected: true, protocols: ['acp'],
    })).toBe('acp');
  });

  it('connected + mail (no acp) → mail', () => {
    expect(resolveMode({
      mail: true, messaging: true, supportsAcp: false,
      connected: true, protocols: [],
    })).toBe('mail');
  });

  it('connected + messaging only (no mail, no acp) → inject', () => {
    expect(resolveMode({
      mail: false, messaging: true, supportsAcp: false,
      connected: true, protocols: [],
    })).toBe('inject');
  });

  it('connected + no capabilities → unavailable', () => {
    expect(resolveMode({
      mail: false, messaging: false, supportsAcp: false,
      connected: true, protocols: [],
    })).toBe('unavailable');
  });

  it('cc-swarm profile → mail (has mail, no acp)', () => {
    expect(resolveMode({
      mail: true, messaging: true, supportsAcp: false,
      connected: true, protocols: [],
    })).toBe('mail');
  });

  it('macro-agent profile → acp (has all three)', () => {
    expect(resolveMode({
      mail: true, messaging: true, supportsAcp: true,
      connected: true, protocols: ['acp'],
    })).toBe('acp');
  });
});
