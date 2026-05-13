/**
 * Layer 3 — LoadoutMaterializer unit tests.
 *
 * Verifies the bundle-store → ResolvedLoadout → MaterializedLoadout
 * translation chain, including:
 *   - Hash lookup miss → LoadoutBundleNotFoundError
 *   - Install-bearing MCP entries forwarded into ACP shape verbatim
 *   - Symbolic refs surfaced via `unresolvedRefs` instead of mcpServers
 *   - Prompt addendum + permissions + capabilities round-trip
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  bundleLoadout,
  resolveStandaloneLoadout,
} from 'openteams';
import type { LoadoutDefinition, MAPResource } from 'openteams';
import {
  LoadoutBundleNotFoundError,
  materializeLoadoutById,
  resolvedToMaterialized,
} from '../../openteams/loadout-materializer.js';
import {
  _resetOpenteamsMapHandlers,
  getOpenteamsBundleStore,
} from '../../openteams/map-handlers.js';

const LOADOUT: LoadoutDefinition = {
  name: 'l3-test',
  capabilities: ['file.read', 'exec.test'],
  mcp_servers: [
    // Install-bearing inline spec — should land in MaterializedLoadout.mcpServers.
    { name: 'opentasks', command: 'node', args: ['./mcp/opentasks.js'] },
    // Symbolic ref — should land in unresolvedRefs, NOT in mcpServers.
    { ref: '@openhive/secrets-scanner' },
  ],
  permissions: {
    allow: ['Read(**)'],
    deny: ['Bash(git push:*)'],
  },
  prompt_addendum: 'be careful',
};

describe('loadout-materializer', () => {
  beforeEach(() => {
    _resetOpenteamsMapHandlers();
  });

  it('throws LoadoutBundleNotFoundError when the bundle is missing', async () => {
    await expect(materializeLoadoutById('sha256:not-in-store')).rejects.toBeInstanceOf(
      LoadoutBundleNotFoundError,
    );
  });

  it('round-trips a stored bundle into a MaterializedLoadout', async () => {
    const resolved = resolveStandaloneLoadout(LOADOUT);
    const bundle = bundleLoadout(resolved, { version: '0.0.0', name: 'l3-test' });
    await getOpenteamsBundleStore().put(bundle as unknown as MAPResource);

    const m = await materializeLoadoutById(bundle.id);
    expect(m.bundleId).toBe(bundle.id);
    expect(m.name).toBe('l3-test');
    expect(m.promptAddendum).toBe('be careful');
    expect(m.capabilities).toEqual(['file.read', 'exec.test']);
    expect(m.permissions.allow).toContain('Read(**)');
    expect(m.permissions.deny).toContain('Bash(git push:*)');
  });

  it('forwards install-bearing MCP entries verbatim to the ACP shape', async () => {
    const resolved = resolveStandaloneLoadout(LOADOUT);
    const bundle = bundleLoadout(resolved, { version: '0.0.0', name: 'l3-test' });
    await getOpenteamsBundleStore().put(bundle as unknown as MAPResource);

    const m = await materializeLoadoutById(bundle.id);
    expect(m.mcpServers).toHaveLength(1);
    expect(m.mcpServers[0]).toEqual({
      name: 'opentasks',
      command: 'node',
      args: ['./mcp/opentasks.js'],
    });
  });

  it('surfaces symbolic refs via unresolvedRefs (not mcpServers)', async () => {
    const resolved = resolveStandaloneLoadout(LOADOUT);
    const bundle = bundleLoadout(resolved, { version: '0.0.0', name: 'l3-test' });
    await getOpenteamsBundleStore().put(bundle as unknown as MAPResource);

    const m = await materializeLoadoutById(bundle.id);
    expect(m.unresolvedRefs).toEqual(['@openhive/secrets-scanner']);
    expect(m.mcpServers.some((s) => 'ref' in s)).toBe(false);
  });

  it('resolvedToMaterialized works standalone (no store hit)', () => {
    const resolved = resolveStandaloneLoadout(LOADOUT);
    const m = resolvedToMaterialized('sha256:test', resolved);
    expect(m.bundleId).toBe('sha256:test');
    expect(m.mcpServers).toHaveLength(1);
    expect(m.unresolvedRefs).toHaveLength(1);
  });

  it('handles loadouts with no MCP servers gracefully', async () => {
    const lean: LoadoutDefinition = {
      name: 'lean',
      capabilities: ['file.read'],
    };
    const bundle = bundleLoadout(
      resolveStandaloneLoadout(lean),
      { version: '0.0.0', name: 'lean' },
    );
    await getOpenteamsBundleStore().put(bundle as unknown as MAPResource);

    const m = await materializeLoadoutById(bundle.id);
    expect(m.mcpServers).toEqual([]);
    expect(m.unresolvedRefs).toEqual([]);
    expect(m.promptAddendum).toBe('');
  });

  it('verifies the bundle hash before materializing', async () => {
    const resolved = resolveStandaloneLoadout(LOADOUT);
    const bundle = bundleLoadout(resolved, { version: '0.0.0', name: 'l3-test' });
    // Tamper with the bundle's `name` AFTER the hash is computed so the
    // canonical content no longer matches `bundle.id`.
    const tampered = {
      ...bundle,
      metadata: {
        ...bundle.metadata,
        resolved: { ...bundle.metadata.resolved, name: 'evil' },
      },
    };
    await getOpenteamsBundleStore().put(tampered as unknown as MAPResource);

    await expect(materializeLoadoutById(bundle.id)).rejects.toThrow();
  });
});
