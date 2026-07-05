/**
 * Active-hub URL/credential resolution. These builders are the load-bearing
 * seam of the remote-control refactor (docs/design/remote-control.md §10, A1):
 * every REST call, WS connection, and auth header derives from here, so the
 * same-origin default and the remote-origin path are locked in below.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeOrigin,
  toWsOrigin,
  restBase,
  acpBase,
  wsUrl,
  authHeader,
  authHeaders,
  setActiveOrigin,
  setActiveToken,
  getActiveOrigin,
  getActiveToken,
  getHubSnapshot,
  subscribeHub,
} from '../../lib/hub';

// Reset the module-level active connection between tests.
beforeEach(() => {
  setActiveOrigin('');
  setActiveToken(null);
  localStorage.clear();
});

describe('normalizeOrigin', () => {
  it('leaves same-origin ("") untouched', () => {
    expect(normalizeOrigin('')).toBe('');
  });
  it('strips trailing slashes so `${origin}/api/v1` never doubles up', () => {
    expect(normalizeOrigin('https://mini:7836/')).toBe('https://mini:7836');
    expect(normalizeOrigin('https://mini:7836///')).toBe('https://mini:7836');
    expect(normalizeOrigin('https://mini:7836')).toBe('https://mini:7836');
  });
});

describe('toWsOrigin', () => {
  it('protocol-swaps a remote origin (http→ws, https→wss)', () => {
    expect(toWsOrigin('https://mini:7836')).toBe('wss://mini:7836');
    expect(toWsOrigin('http://192.168.1.42:7836')).toBe('ws://192.168.1.42:7836');
  });
  it('derives from window.location for the same-origin default', () => {
    expect(toWsOrigin('')).toMatch(/^wss?:\/\//);
  });
});

describe('same-origin default', () => {
  it('builds relative REST/ACP bases', () => {
    expect(restBase()).toBe('/api/v1');
    expect(acpBase()).toBe('/api/swarmcraft');
  });
  it('builds a same-origin WS url', () => {
    expect(wsUrl('/ws')).toMatch(/^wss?:\/\/[^/]+\/ws$/);
  });
});

describe('remote origin', () => {
  beforeEach(() => setActiveOrigin('https://mini:7836'));

  it('reflects on getActiveOrigin + snapshot', () => {
    expect(getActiveOrigin()).toBe('https://mini:7836');
    expect(getHubSnapshot().origin).toBe('https://mini:7836');
  });
  it('prefixes REST/ACP bases with the hub origin', () => {
    expect(restBase()).toBe('https://mini:7836/api/v1');
    expect(acpBase()).toBe('https://mini:7836/api/swarmcraft');
  });
  it('builds a wss WS url against the hub', () => {
    expect(wsUrl('/ws')).toBe('wss://mini:7836/ws');
  });
  it('normalizes a trailing slash from setActiveOrigin', () => {
    setActiveOrigin('https://mini:7836/');
    expect(restBase()).toBe('https://mini:7836/api/v1');
  });
});

describe('credential', () => {
  it('is absent when unauthenticated', () => {
    expect(authHeader()).toBeNull();
    expect(authHeaders()).toEqual({});
    expect(wsUrl('/ws')).not.toContain('token=');
  });
  it('carries the active token as header + url-encoded ?token=', () => {
    setActiveToken('ohk_a b/c'); // spaces + slash exercise encoding
    expect(getActiveToken()).toBe('ohk_a b/c');
    expect(authHeader()).toBe('Bearer ohk_a b/c');
    expect(authHeaders()).toEqual({ Authorization: 'Bearer ohk_a b/c' });
    expect(wsUrl('/ws')).toContain(`?token=${encodeURIComponent('ohk_a b/c')}`);
  });
  it('persists the token to localStorage under openhive_token', () => {
    setActiveToken('ohk_persist');
    expect(localStorage.getItem('openhive_token')).toBe('ohk_persist');
    setActiveToken(null);
    expect(localStorage.getItem('openhive_token')).toBeNull();
  });
  it('lets an explicit wsUrl token override the active credential', () => {
    setActiveToken('active');
    expect(wsUrl('/ws', 'override')).toContain('?token=override');
    expect(wsUrl('/ws', null)).not.toContain('token=');
  });
});

describe('subscribeHub', () => {
  it('notifies on change and stops after unsubscribe', () => {
    let calls = 0;
    const unsub = subscribeHub(() => { calls += 1; });

    setActiveOrigin('https://a:1');
    expect(calls).toBe(1);
    expect(getHubSnapshot().origin).toBe('https://a:1');

    setActiveToken('t');
    expect(calls).toBe(2);

    // No-op change does not notify.
    setActiveToken('t');
    expect(calls).toBe(2);

    unsub();
    setActiveOrigin('https://b:2');
    expect(calls).toBe(2);
  });
});
