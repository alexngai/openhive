import { describe, it, expect } from 'vitest';
import { shouldAutoAuthLocalAgent } from '../../api/middleware/auth.js';

describe('shouldAutoAuthLocalAgent (REST-plane trust gate)', () => {
  it('auto-auths in local mode on a loopback bind', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(shouldAutoAuthLocalAgent({ auth: { mode: 'local' }, admin: {}, host }), host).toBe(true);
    }
  });

  it('requires a credential in local mode on a network bind (no trustLocalMode)', () => {
    for (const host of ['0.0.0.0', '10.0.0.5', '192.168.1.10', 'hub.example.com', undefined]) {
      expect(
        shouldAutoAuthLocalAgent({ auth: { mode: 'local' }, admin: {}, host }),
        String(host),
      ).toBe(false);
    }
  });

  it('trustLocalMode re-enables auto-auth on a network bind (explicit opt-in)', () => {
    expect(
      shouldAutoAuthLocalAgent({ auth: { mode: 'local' }, admin: { trustLocalMode: true }, host: '0.0.0.0' }),
    ).toBe(true);
  });

  it('never auto-auths outside local mode, even on loopback with trustLocalMode', () => {
    expect(
      shouldAutoAuthLocalAgent({ auth: { mode: 'swarmhub' }, admin: { trustLocalMode: true }, host: '127.0.0.1' }),
    ).toBe(false);
  });
});
