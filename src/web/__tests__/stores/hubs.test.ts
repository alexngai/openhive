/**
 * Multi-hub connection store (Approach A2). Locks in the switch/seed/remove/sync
 * coordination between the hubs store, lib/hub.ts (active origin+token), and the
 * single-session auth store — the part most likely to drift.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useHubsStore, type HubConnection } from '../../stores/hubs';
import { useAuthStore } from '../../stores/auth';
import { getActiveOrigin, getActiveToken, setActiveOrigin, setActiveToken } from '../../lib/hub';
import type { Agent } from '../../lib/api';

const agent = (id: string): Agent =>
  ({ id, name: id.toUpperCase(), description: null, avatar_url: null, is_verified: true, created_at: '' } as Agent);

function remote(over: Partial<HubConnection>): HubConnection {
  return {
    id: 'r1', label: 'Remote', origin: 'https://mini:7836', token: 'ohk_x',
    agent: agent('a2'), authMode: 'swarmhub', addedAt: 1, lastUsedAt: null, ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  setActiveOrigin('');
  setActiveToken(null);
  useHubsStore.setState({ connections: [], activeHubId: null });
  useAuthStore.setState({ token: null, agent: null, authMode: null, isAuthenticated: false });
});

afterEach(() => vi.restoreAllMocks());

describe('ensureSeed', () => {
  it('creates a same-origin "This hub" connection and marks it active', () => {
    useHubsStore.getState().ensureSeed({ token: 'k', agent: agent('a1'), authMode: 'swarmhub' });
    const { connections, activeHubId } = useHubsStore.getState();
    expect(connections).toHaveLength(1);
    expect(connections[0].origin).toBe('');
    expect(connections[0].token).toBe('k');
    expect(activeHubId).toBe(connections[0].id);
  });

  it('does not duplicate the same-origin connection across boots', () => {
    const s = useHubsStore.getState();
    s.ensureSeed({ token: 'k', agent: agent('a1'), authMode: 'local' });
    s.ensureSeed({ token: 'k', agent: agent('a1'), authMode: 'local' });
    expect(useHubsStore.getState().connections.filter((c) => c.origin === '')).toHaveLength(1);
  });

  it('reconciles activeHubId to whatever lib/hub.ts is pointed at on boot', () => {
    // Simulate a reload already pointed at a remote hub (hub.ts persisted origin).
    setActiveOrigin('https://mini:7836');
    useHubsStore.setState({ connections: [remote({})], activeHubId: null });
    useHubsStore.getState().ensureSeed({ token: 'ohk_x', agent: agent('a2'), authMode: 'swarmhub' });
    const { connections, activeHubId } = useHubsStore.getState();
    // same-origin seeded (with null cached auth since we're on the remote hub) + active is the remote
    expect(connections.some((c) => c.origin === '' && c.token === null)).toBe(true);
    expect(activeHubId).toBe('r1');
  });
});

describe('switchTo', () => {
  it('re-points lib/hub.ts and drives the auth view', () => {
    const s = useHubsStore.getState();
    s.ensureSeed({ token: null, agent: null, authMode: 'local' });
    useHubsStore.setState((st) => ({ connections: [...st.connections, remote({})] }));
    s.switchTo('r1');

    expect(getActiveOrigin()).toBe('https://mini:7836');
    expect(getActiveToken()).toBe('ohk_x');
    expect(useHubsStore.getState().activeHubId).toBe('r1');
    const auth = useAuthStore.getState();
    expect(auth.token).toBe('ohk_x');
    expect(auth.agent?.id).toBe('a2');
    expect(auth.isAuthenticated).toBe(true);
  });

  it('marks a local same-origin hub authenticated with no token', () => {
    const s = useHubsStore.getState();
    s.ensureSeed({ token: null, agent: agent('a1'), authMode: 'local' });
    s.switchTo(useHubsStore.getState().activeHubId!);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(getActiveOrigin()).toBe('');
  });
});

describe('removeConnection', () => {
  it('never removes the same-origin hub; removing the active remote falls back to it', () => {
    const s = useHubsStore.getState();
    s.ensureSeed({ token: null, agent: null, authMode: 'local' });
    const defaultId = useHubsStore.getState().activeHubId!;
    useHubsStore.setState((st) => ({ connections: [...st.connections, remote({})] }));
    s.switchTo('r1');
    expect(getActiveOrigin()).toBe('https://mini:7836');

    // same-origin is protected
    s.removeConnection(defaultId);
    expect(useHubsStore.getState().connections.some((c) => c.id === defaultId)).toBe(true);

    // removing the active remote falls back to same-origin (and re-points hub.ts)
    s.removeConnection('r1');
    expect(useHubsStore.getState().connections.some((c) => c.id === 'r1')).toBe(false);
    expect(useHubsStore.getState().activeHubId).toBe(defaultId);
    expect(getActiveOrigin()).toBe('');
  });
});

describe('syncActiveFromAuth', () => {
  it('mirrors a live login into the active connection', () => {
    const s = useHubsStore.getState();
    s.ensureSeed({ token: null, agent: null, authMode: 'swarmhub' });
    const id = useHubsStore.getState().activeHubId!;
    s.syncActiveFromAuth({ token: 'fresh', agent: agent('x'), authMode: 'swarmhub' });
    const active = useHubsStore.getState().connections.find((c) => c.id === id)!;
    expect(active.token).toBe('fresh');
    expect(active.agent?.id).toBe('x');
  });
});

describe('addConnection', () => {
  const okJson = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response);

  it('validates via /agents/me, decorates from auth/mode + well-known, and saves', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.endsWith('/api/v1/agents/me')) return okJson(200, { data: agent('ag') });
      if (u.endsWith('/api/v1/auth/mode')) return okJson(200, { mode: 'swarmhub' });
      if (u.endsWith('/.well-known/openhive.json')) return okJson(200, { name: 'Mini Hub' });
      return okJson(404, {});
    });

    const conn = await useHubsStore.getState().addConnection({ origin: 'https://mini:7836/', token: 'ohk_x' });
    expect(conn.origin).toBe('https://mini:7836'); // trailing slash normalized
    expect(conn.label).toBe('Mini Hub'); // from well-known
    expect(conn.agent?.id).toBe('ag');
    expect(conn.authMode).toBe('swarmhub');
    expect(useHubsStore.getState().connections.some((c) => c.id === conn.id)).toBe(true);
  });

  it('rejects an invalid credential', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(401, {}));
    await expect(
      useHubsStore.getState().addConnection({ origin: 'https://mini:7836', token: 'bad' }),
    ).rejects.toThrow(/Authentication failed/);
  });

  it('rejects a duplicate origin', async () => {
    useHubsStore.setState({ connections: [remote({})], activeHubId: 'r1' });
    await expect(
      useHubsStore.getState().addConnection({ origin: 'https://mini:7836', token: 't' }),
    ).rejects.toThrow(/already exists/);
  });
});
