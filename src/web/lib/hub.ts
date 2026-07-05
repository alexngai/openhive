/**
 * Active hub connection — the single source of truth for *which* OpenHive hub
 * the client is currently talking to, and with what credential.
 *
 * Historically the web client assumed it was always served same-origin by the
 * one hub it talks to: REST hit `/api/v1`, WS derived from `window.location`,
 * and the token lived in a flat `openhive_token` localStorage key read from
 * several places. This module centralizes all of that so the app can be pointed
 * at a *remote* hub (Approach A1 of docs/design/remote-control.md).
 *
 * - `origin === ''` means same-origin (the default; local usage is unchanged).
 * - `origin === 'https://host:port'` targets a remote hub; REST/WS/token all
 *   derive from it.
 *
 * This module is deliberately framework-agnostic (imported by non-React adapter
 * code too). React components observe changes via `useActiveHub`
 * (src/web/hooks/useActiveHub.ts), which wraps the subscribe/snapshot pair
 * exported here in `useSyncExternalStore`.
 *
 * A1 keeps a single active connection. A2 layers a persisted multi-hub store +
 * switcher on top of these same setters.
 */

const TOKEN_KEY = 'openhive_token';
const ORIGIN_KEY = 'openhive_hub_origin';

function readLS(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // private mode / disabled storage
  }
}

function writeLS(key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* quota / disabled — non-fatal */
  }
}

/**
 * Normalize a hub origin: strip trailing slashes so `${origin}/api/v1` never
 * doubles up. `''` (same-origin) passes through untouched. Callers are expected
 * to pass a full origin including protocol (e.g. `https://mini:7836`); A2's UI
 * validates operator input.
 */
export function normalizeOrigin(origin: string): string {
  if (!origin) return '';
  return origin.replace(/\/+$/, '');
}

let activeOrigin = normalizeOrigin(readLS(ORIGIN_KEY) ?? '');
let activeToken = readLS(TOKEN_KEY);

export interface HubSnapshot {
  origin: string;
  token: string | null;
}

// A stable snapshot object, replaced only when something actually changes, so
// `useSyncExternalStore` doesn't loop (it requires reference stability between
// unchanged reads).
let snapshot: HubSnapshot = { origin: activeOrigin, token: activeToken };

type Listener = () => void;
const listeners = new Set<Listener>();

function commit(): void {
  snapshot = { origin: activeOrigin, token: activeToken };
  for (const listener of listeners) listener();
}

/** Subscribe to active-hub changes. Returns an unsubscribe fn. */
export function subscribeHub(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Current snapshot (stable reference between changes; safe for useSyncExternalStore). */
export function getHubSnapshot(): HubSnapshot {
  return snapshot;
}

export function getActiveOrigin(): string {
  return activeOrigin;
}

export function getActiveToken(): string | null {
  return activeToken;
}

/** Update the active credential. No-op (no notify) if unchanged. */
export function setActiveToken(token: string | null): void {
  if (token === activeToken) return;
  activeToken = token;
  writeLS(TOKEN_KEY, token);
  commit();
}

/** Point the client at a different hub. No-op (no notify) if unchanged. */
export function setActiveOrigin(origin: string): void {
  const normalized = normalizeOrigin(origin);
  if (normalized === activeOrigin) return;
  activeOrigin = normalized;
  writeLS(ORIGIN_KEY, normalized);
  commit();
}

// ── URL / header builders (read the current active connection) ──────────────

/** REST base for the active hub, e.g. `/api/v1` or `https://mini:7836/api/v1`. */
export function restBase(): string {
  return `${activeOrigin}/api/v1`;
}

/** SwarmCraft ACP proxy base for the active hub. */
export function acpBase(): string {
  return `${activeOrigin}/api/swarmcraft`;
}

/** `Bearer <token>` for the active credential, or null when unauthenticated. */
export function authHeader(): string | null {
  return activeToken ? `Bearer ${activeToken}` : null;
}

/** Authorization header object (empty when unauthenticated). Valid HeadersInit. */
export function authHeaders(): Record<string, string> {
  return activeToken ? { Authorization: `Bearer ${activeToken}` } : {};
}

/**
 * `ws(s)://…` base for a given hub origin. `''` derives from
 * `window.location` (same-origin default); a full origin is protocol-swapped
 * (`http`→`ws`, `https`→`wss`). Pure — takes the origin so React callers can
 * memoize on it.
 */
export function toWsOrigin(origin: string): string {
  if (origin) return origin.replace(/^http/i, 'ws');
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
  }
  return '';
}

/** `ws(s)://…` base for the active hub. */
export function wsOrigin(): string {
  return toWsOrigin(activeOrigin);
}

/**
 * Full WS URL for a path on the active hub, with the credential as a `?token=`
 * query param (how the hub authenticates WS upgrades). Pass `token` explicitly
 * to override the active credential; omit to use it.
 */
export function wsUrl(path: string, token?: string | null): string {
  const t = token === undefined ? activeToken : token;
  const query = t ? `?token=${encodeURIComponent(t)}` : '';
  return `${wsOrigin()}${path}${query}`;
}
