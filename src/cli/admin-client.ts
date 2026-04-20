/**
 * HTTP client for `openhive admin *` CLI subcommands.
 *
 * Resolves the target hub URL and admin key from (in priority order):
 *   1. Explicit --server / --admin-key CLI flags
 *   2. Environment: OPENHIVE_ADMIN_URL / HIVE_ADMIN_KEY / OPENHIVE_ADMIN_KEY
 *   3. Loaded config file at <dataDir>/config.json (admin.key + host/port)
 *
 * All requests send `X-Admin-Key` and return parsed JSON. On non-2xx responses
 * the server's error payload is included in the thrown error message.
 */

import * as fs from 'fs';
import { resolveDataDir, dataDirPaths } from '../data-dir.js';

export interface AdminClientOptions {
  server?: string;
  adminKey?: string;
  dataDir?: string;
}

export interface AdminClient {
  baseUrl: string;
  get<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  del<T = unknown>(path: string): Promise<T>;
}

function readConfigJson(dataDir: string): Record<string, unknown> | null {
  const paths = dataDirPaths(dataDir);
  if (!fs.existsSync(paths.config)) return null;
  try {
    return JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch {
    return null;
  }
}

function resolve(opts: AdminClientOptions): { baseUrl: string; adminKey: string } {
  const dataDir = resolveDataDir(opts.dataDir);
  const config = readConfigJson(dataDir);

  const configAdmin = (config?.admin as Record<string, unknown> | undefined)?.key;
  const configPort = typeof config?.port === 'number' ? config.port : 3000;
  const configHost = typeof config?.host === 'string' ? config.host : '0.0.0.0';
  const configInstanceUrl = (config?.instance as Record<string, unknown> | undefined)?.url;

  const baseUrl =
    opts.server ||
    process.env.OPENHIVE_ADMIN_URL ||
    (typeof configInstanceUrl === 'string' && configInstanceUrl) ||
    `http://${configHost === '0.0.0.0' ? 'localhost' : configHost}:${configPort}`;

  const adminKey =
    opts.adminKey ||
    process.env.HIVE_ADMIN_KEY ||
    process.env.OPENHIVE_ADMIN_KEY ||
    (typeof configAdmin === 'string' ? configAdmin : '');

  if (!adminKey) {
    throw new Error(
      'Admin key not found. Set HIVE_ADMIN_KEY env var, pass --admin-key, or configure admin.key in openhive.config.json.',
    );
  }

  if (opts.adminKey) {
    console.warn('Warning: passing admin key via --admin-key exposes it in process args. Prefer HIVE_ADMIN_KEY env var.');
  }

  return { baseUrl: baseUrl.replace(/\/$/, ''), adminKey };
}

export function createAdminClient(opts: AdminClientOptions = {}): AdminClient {
  const { baseUrl, adminKey } = resolve(opts);

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers: Record<string, string> = {
      'X-Admin-Key': adminKey,
      'Accept': 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(`Failed to reach ${url}: ${(err as Error).message}`);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (!response.ok) {
      const errMsg =
        (parsed && typeof parsed === 'object' && 'message' in parsed && typeof (parsed as Record<string, unknown>).message === 'string'
          ? (parsed as Record<string, string>).message
          : null) ||
        (parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as Record<string, unknown>).error === 'string'
          ? (parsed as Record<string, string>).error
          : null) ||
        (typeof parsed === 'string' ? parsed : response.statusText);
      throw new Error(`${response.status} ${errMsg || 'Request failed'}`);
    }

    return parsed as T;
  }

  function buildQuery(query?: Record<string, string | number | boolean | undefined>): string {
    if (!query) return '';
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    const s = params.toString();
    return s ? `?${s}` : '';
  }

  return {
    baseUrl,
    get: <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
      request<T>('GET', `${path}${buildQuery(query)}`),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
    patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
    del: <T>(path: string) => request<T>('DELETE', path),
  };
}
