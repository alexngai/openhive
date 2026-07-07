/**
 * Safe URL validation for OUTBOUND requests (git remotes, sync peer endpoints,
 * fetch targets). Every place that dials or spawns against a caller-influenced
 * URL should run it through here first.
 *
 * Two distinct threats:
 *
 *  1. Argument / command injection — when a URL reaches a git subprocess. Even
 *     with `execFile` (no shell), a value beginning with `-` is mis-parsed as a
 *     flag, and shell metacharacters are dangerous the moment anything ever
 *     interpolates the string. We enforce a conservative character allowlist and
 *     reject leading dashes.
 *
 *  2. SSRF — reaching internal-only hosts (loopback, cloud metadata at
 *     169.254.169.254, RFC1918) or non-network schemes like `file://`. Callers
 *     that dial attacker-influenced URLs pass `{ blockPrivateNetworks: true }`.
 *
 * NOTE: `blockPrivateNetworks` inspects the *literal* host only. Full DNS-rebind
 * protection requires resolving the name and re-checking the resolved IP at
 * connect time — tracked as later hardening. Literal-IP + localhost blocking
 * still defeats the common metadata-endpoint and loopback SSRF payloads.
 */

/** Git transport schemes we allow for outbound git operations. */
const ALLOWED_GIT_SCHEMES = new Set(['http', 'https', 'ssh', 'git']);

/**
 * Conservative allowlist for git remote strings. Real git URLs only need
 * alphanumerics plus `. _ ~ : / @ % + -`. This rejects whitespace and every
 * shell metacharacter (`; | & $ \` ( ) { } < > ' " \\ * ? # ! newline`), which
 * kills injection payloads outright.
 */
const SAFE_URL_CHARS = /^[A-Za-z0-9._~:/@%+-]+$/;

/** scp-like git remote: `git@host:owner/repo` (no scheme). */
const SCP_LIKE = /^[A-Za-z0-9._~%+-]+@([A-Za-z0-9.-]+):/;

/**
 * Bare form: `host/owner/repo` (routed to a provider API, never a subprocess).
 * The host must be a real dotted hostname — this deliberately rejects relative
 * paths like `./x/y` or `../x/y` that would otherwise be read as a local repo.
 */
const BARE_HOST_PATH = /^([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\/[^/]+\/.+$/;

export interface SafeUrlOptions {
  /** Reject loopback / link-local / private (RFC1918) literal hosts. */
  blockPrivateNetworks?: boolean;
  /** Max accepted length (defense against pathological input). Default 512. */
  maxLength?: number;
}

/**
 * Extract the host from any accepted remote form, or `null` if it doesn't parse
 * as one we recognize.
 */
export function extractRemoteHost(raw: string): string | null {
  const value = raw.trim();
  let host: string | null = null;

  const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (schemeMatch) {
    if (!ALLOWED_GIT_SCHEMES.has(schemeMatch[1].toLowerCase())) return null;
    try {
      host = new URL(value).hostname.toLowerCase() || null;
    } catch {
      return null;
    }
  } else {
    const scp = value.match(SCP_LIKE);
    if (scp) host = scp[1].toLowerCase();
    else {
      const bare = value.match(BARE_HOST_PATH);
      if (bare) host = bare[1].toLowerCase();
    }
  }

  if (!host) return null;
  // Reject degenerate hosts that could be read as relative/local paths.
  if (host === '.' || host.includes('..') || host.startsWith('.') || host.endsWith('.')) {
    return null;
  }
  return host;
}

/**
 * Is `host` a loopback, link-local, or RFC1918 private literal (or an obvious
 * localhost name)? Used to block SSRF to internal targets.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  if (h === 'localhost' || h.endsWith('.localhost') || h === '' ) return true;

  // IPv6 loopback / link-local / unique-local
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;

  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ipv4 = mapped ? mapped[1] : h;

  const octets = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!octets) return false; // not an IPv4 literal — treat DNS names as non-private here
  const [a, b] = [Number(octets[1]), Number(octets[2])];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 0) return true; // "this" network
  return false;
}

/**
 * Non-throwing check: is `raw` a safe, supported outbound remote URL?
 */
export function isSafeRemoteUrl(raw: unknown, opts: SafeUrlOptions = {}): boolean {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  const maxLength = opts.maxLength ?? 512;

  if (value.length === 0 || value.length > maxLength) return false;
  if (value.startsWith('-')) return false; // never let a URL masquerade as a CLI flag
  if (!SAFE_URL_CHARS.test(value)) return false; // whitespace / shell metacharacters

  const host = extractRemoteHost(value);
  if (!host) return false; // unknown scheme (file://, data:, …) or unparseable

  if (opts.blockPrivateNetworks && isPrivateHost(host)) return false;

  return true;
}

export class UnsafeUrlError extends Error {
  constructor(message = 'Unsafe or unsupported remote URL') {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/**
 * Throwing variant for call sites that prefer to fail loudly.
 */
export function assertSafeRemoteUrl(raw: unknown, opts: SafeUrlOptions = {}): string {
  if (!isSafeRemoteUrl(raw, opts)) {
    throw new UnsafeUrlError();
  }
  return (raw as string).trim();
}

/**
 * Non-throwing check for an outbound HTTP(S) endpoint the server will dial
 * (sync peers, webhooks, health probes). Stricter than isSafeRemoteUrl: only
 * `http:`/`https:`, no embedded credentials, and (optionally) no private hosts.
 *
 * Use `blockPrivateNetworks: true` for endpoints supplied by untrusted callers
 * (peer handshakes, gossip) to stop SSRF to loopback / cloud metadata / RFC1918.
 */
export function isSafeHttpUrl(raw: unknown, opts: SafeUrlOptions = {}): boolean {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  const maxLength = opts.maxLength ?? 2048;
  if (value.length === 0 || value.length > maxLength) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!url.hostname) return false;
  if (url.username || url.password) return false; // no inline credentials
  if (opts.blockPrivateNetworks && isPrivateHost(url.hostname)) return false;

  return true;
}

/**
 * Throwing variant of {@link isSafeHttpUrl}.
 */
export function assertSafeHttpUrl(raw: unknown, opts: SafeUrlOptions = {}): string {
  if (!isSafeHttpUrl(raw, opts)) {
    throw new UnsafeUrlError('Unsafe or unsupported HTTP endpoint');
  }
  return (raw as string).trim();
}
