/**
 * SSRF wiring for outbound federation dials.
 *
 * Every federation function that dials a caller-supplied instance URL routes
 * through the module's `federatedFetch` chokepoint, which runs the shared
 * `isSafeHttpUrl` guard before touching the network. These tests assert the
 * guard actually blocks the classic SSRF payloads (cloud metadata, loopback,
 * RFC1918, non-http schemes, inline credentials) *before* any fetch, and that
 * an operator can opt into a private-network mesh via `configureFederationSsrf`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  discoverInstanceWithError,
  fetchRemoteAgentsWithError,
  configureFederationSsrf,
  FederationErrorType,
} from '../../federation/service.js';

// The default policy blocks private peers (config.sync.allowPrivatePeers=false).
// Reset after every test so a toggled case can't leak into the next.
afterEach(() => configureFederationSsrf(false));

describe('federation SSRF guard', () => {
  const privateTargets = [
    'http://169.254.169.254/latest/meta-data/', // cloud metadata endpoint
    'http://127.0.0.1:8080', // loopback
    'http://10.0.0.5/api', // RFC1918
    'http://192.168.1.1', // RFC1918
    'http://[::1]:9000', // IPv6 loopback
    'http://localhost:7836', // localhost name
  ];

  it.each(privateTargets)('refuses to dial private/metadata target %s', async (url) => {
    const r = await discoverInstanceWithError(url);
    expect(r.success).toBe(false);
    expect(r.error?.type).toBe(FederationErrorType.VALIDATION_ERROR);
  });

  const badSchemes = [
    'file:///etc/passwd',
    'ftp://example.com/x',
    'http://user:pass@example.com/', // inline credentials
  ];

  it.each(badSchemes)('refuses unsupported scheme / credentialed URL %s', async (url) => {
    const r = await discoverInstanceWithError(url);
    expect(r.success).toBe(false);
    expect(r.error?.type).toBe(FederationErrorType.VALIDATION_ERROR);
  });

  it('applies the guard to every federation dial, not just discovery', async () => {
    const r = await fetchRemoteAgentsWithError('http://169.254.169.254');
    expect(r.success).toBe(false);
    expect(r.error?.type).toBe(FederationErrorType.VALIDATION_ERROR);
  });

  it('lets an operator opt into a private-network mesh', async () => {
    configureFederationSsrf(true);
    // The guard no longer blocks, so the request reaches the transport and fails
    // fast (connection refused on localhost) — a NETWORK error, distinctly NOT
    // the pre-dial VALIDATION block above.
    const r = await discoverInstanceWithError('http://127.0.0.1:1');
    expect(r.success).toBe(false);
    expect(r.error?.type).not.toBe(FederationErrorType.VALIDATION_ERROR);
  });
});
