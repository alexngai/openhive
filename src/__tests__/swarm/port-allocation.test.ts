import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as net from 'net';
import { SwarmManager } from '../../swarm/manager.js';
import { LocalProvider } from '../../swarm/providers/local.js';
import type { SwarmHostingConfig } from '../../swarm/types.js';

const HOST = '127.0.0.1';

function makeConfig(portRange: [number, number]): SwarmHostingConfig {
  return {
    enabled: true,
    default_provider: 'local',
    // Any string other than the literal 'npx openswarm serve' is returned
    // as-is by resolveOpenswarmCommand, so this avoids bin-resolution.
    openswarm_command: 'node --version',
    data_dir: '/tmp/openhive-test-swarms',
    port_range: portRange,
    max_swarms: 10,
    health_check_interval: 30000,
    max_health_failures: 3,
    auto_restart: true,
    max_restart_attempts: 3,
  };
}

interface ManagerInternals {
  getPortStride(adapter: string | undefined): number;
  isPortFree(port: number, host: string): Promise<boolean>;
  allocatePorts(adapter: string | undefined): Promise<number | null>;
  releasePorts(basePort: number, adapter: string | undefined): void;
  usedPorts: Set<number>;
  providers: Map<string, unknown>;
}

function internals(mgr: SwarmManager): ManagerInternals {
  return mgr as unknown as ManagerInternals;
}

function listen(port: number, host = HOST): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Find N consecutive free ports at the OS level. */
async function findFreeRange(count: number): Promise<[number, number]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    // Random base inside the upper half of the ephemeral range.
    const base = 55000 + Math.floor(Math.random() * 8000);
    const probes: net.Server[] = [];
    let ok = true;
    for (let i = 0; i < count; i++) {
      try {
        probes.push(await listen(base + i));
      } catch {
        ok = false;
        break;
      }
    }
    for (const s of probes) await close(s);
    if (ok) return [base, base + count - 1];
  }
  throw new Error(`Could not find ${count} consecutive free ports`);
}

describe('SwarmManager port allocation', () => {
  // Each SwarmManager constructs a LocalProvider that registers a
  // process.once('exit') listener. Tests instantiate several — bump the limit
  // so we don't trip Node's MaxListenersExceededWarning.
  beforeAll(() => {
    process.setMaxListeners(64);
  });

  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const c = cleanups.pop()!;
      await c();
    }
  });

  function makeManager(range: [number, number]): SwarmManager {
    const mgr = new SwarmManager(makeConfig(range), 'http://localhost:3000');
    cleanups.push(() => {
      const local = internals(mgr).providers.get('local');
      if (local instanceof LocalProvider) local.removeExitHandler();
    });
    return mgr;
  }

  it('getPortStride returns 3 for macro-agent, 1 otherwise', () => {
    const m = internals(makeManager([9000, 9100]));
    expect(m.getPortStride('macro-agent')).toBe(3);
    expect(m.getPortStride('some-other-adapter')).toBe(1);
    expect(m.getPortStride(undefined)).toBe(1);
  });

  it('isPortFree reflects OS-level availability', async () => {
    const [free] = await findFreeRange(1);
    const m = internals(makeManager([9000, 9100]));

    expect(await m.isPortFree(free, HOST)).toBe(true);

    const server = await listen(free);
    cleanups.push(() => close(server));
    expect(await m.isPortFree(free, HOST)).toBe(false);
  });

  it('allocates non-overlapping stride-3 triples for macro-agent', async () => {
    const [rangeStart, rangeEnd] = await findFreeRange(9); // room for three triples
    const m = internals(makeManager([rangeStart, rangeEnd]));

    const p1 = await m.allocatePorts('macro-agent');
    const p2 = await m.allocatePorts('macro-agent');

    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    expect(p1).not.toBe(p2);
    expect(Math.abs((p2 as number) - (p1 as number))).toBeGreaterThanOrEqual(3);

    for (const base of [p1!, p2!]) {
      expect(m.usedPorts.has(base)).toBe(true);
      expect(m.usedPorts.has(base + 1)).toBe(true);
      expect(m.usedPorts.has(base + 2)).toBe(true);
    }
  });

  it('allocates stride-1 for non-macro-agent adapters', async () => {
    const [rangeStart, rangeEnd] = await findFreeRange(6);
    const m = internals(makeManager([rangeStart, rangeEnd]));

    const p1 = await m.allocatePorts('other');
    const p2 = await m.allocatePorts('other');

    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    expect(m.usedPorts.has(p1!)).toBe(true);
    expect(m.usedPorts.has(p2!)).toBe(true);
    // For stride 1 we reserve only the base — p1 + 1 shouldn't appear in
    // usedPorts unless it happens to equal p2.
    const neighborReserved = m.usedPorts.has(p1! + 1) && p1! + 1 !== p2;
    expect(neighborReserved).toBe(false);
  });

  it('returns a triple that does not include an OS-occupied port', async () => {
    // Need enough room for at least one triple that avoids the blocker.
    const [rangeStart, rangeEnd] = await findFreeRange(6);
    // Occupy rangeStart + 1 — simulates swarm #1's gateway HTTP listener
    // still bound when we try to allocate a second swarm.
    const blocker = await listen(rangeStart + 1);
    cleanups.push(() => close(blocker));

    const m = internals(makeManager([rangeStart, rangeEnd]));
    const p = await m.allocatePorts('macro-agent');

    expect(p).not.toBeNull();
    const triple = [p!, p! + 1, p! + 2];
    expect(triple).not.toContain(rangeStart + 1);
    // Every port in the returned triple must fall within the configured range.
    for (const port of triple) {
      expect(port).toBeGreaterThanOrEqual(rangeStart);
      expect(port).toBeLessThanOrEqual(rangeEnd);
    }
  });

  it('returns null when the range is too small to fit the stride', async () => {
    const [free] = await findFreeRange(2);
    const m = internals(makeManager([free, free + 1])); // only 2 ports
    expect(await m.allocatePorts('macro-agent')).toBeNull();
  });

  it('releasePorts frees the full stride for reuse', async () => {
    const [rangeStart, rangeEnd] = await findFreeRange(3);
    const m = internals(makeManager([rangeStart, rangeEnd])); // exactly one triple

    const p1 = await m.allocatePorts('macro-agent');
    expect(p1).toBe(rangeStart);

    // No more triples available until we release the first one.
    expect(await m.allocatePorts('macro-agent')).toBeNull();

    m.releasePorts(rangeStart, 'macro-agent');
    expect(m.usedPorts.has(rangeStart)).toBe(false);
    expect(m.usedPorts.has(rangeStart + 1)).toBe(false);
    expect(m.usedPorts.has(rangeStart + 2)).toBe(false);

    const p2 = await m.allocatePorts('macro-agent');
    expect(p2).toBe(rangeStart);
  });

  it('successive allocations fill the range with distinct, non-overlapping triples', async () => {
    // Space for exactly three macro-agent triples (9 consecutive ports).
    const [rangeStart, rangeEnd] = await findFreeRange(9);
    const m = internals(makeManager([rangeStart, rangeEnd]));

    const a = await m.allocatePorts('macro-agent');
    const b = await m.allocatePorts('macro-agent');
    const c = await m.allocatePorts('macro-agent');

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).not.toBeNull();

    const bases = [a!, b!, c!].sort((x, y) => x - y);
    for (let i = 1; i < bases.length; i++) {
      expect(bases[i] - bases[i - 1]).toBeGreaterThanOrEqual(3);
    }

    // Range is now exhausted.
    expect(await m.allocatePorts('macro-agent')).toBeNull();
  });
});
