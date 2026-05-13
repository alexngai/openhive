/**
 * MCP ref registry — gap F.
 *
 * Two scopes:
 *   1. The registry module itself (resolve / register / list / reset).
 *   2. Integration with the loadout materializer — `{ ref: '@org/name' }`
 *      entries now resolve to install specs when the registry has them,
 *      and only fall through to `unresolvedRefs` when they don't.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  bundleLoadout,
  resolveStandaloneLoadout,
} from 'openteams';
import type { LoadoutDefinition, MAPResource } from 'openteams';
import {
  _resetMcpRegistry,
  listMcpRefs,
  registerMcpRef,
  resolveMcpRef,
} from '../../openteams/mcp-registry.js';
import {
  _resetOpenteamsMapHandlers,
  getOpenteamsBundleStore,
} from '../../openteams/map-handlers.js';
import { materializeLoadoutById } from '../../openteams/loadout-materializer.js';

describe('mcp-registry', () => {
  beforeEach(() => {
    _resetMcpRegistry();
    _resetOpenteamsMapHandlers();
  });

  describe('registry module', () => {
    it('returns null for unknown refs', () => {
      expect(resolveMcpRef('@nobody/missing')).toBeNull();
    });

    it('serves the default-shipped @openhive/example-mcp entry', () => {
      const entry = resolveMcpRef('@openhive/example-mcp');
      expect(entry).not.toBeNull();
      expect(entry!.name).toBe('example-mcp');
      expect(entry!.command).toBe('npx');
    });

    it('registerMcpRef adds a new entry, retrievable via resolveMcpRef', () => {
      registerMcpRef('@test/added', { name: 'added', command: 'node', args: ['./x.js'] });
      const entry = resolveMcpRef('@test/added');
      expect(entry).toEqual({ name: 'added', command: 'node', args: ['./x.js'] });
    });

    it('defensive copy: callers cannot mutate the stored entry', () => {
      registerMcpRef('@test/copy', { name: 'copy', command: 'node' });
      const entry = resolveMcpRef('@test/copy');
      entry!.command = 'CHANGED';
      const again = resolveMcpRef('@test/copy');
      expect(again!.command).toBe('node');
    });

    it('listMcpRefs snapshots all registered entries', () => {
      const list = listMcpRefs();
      expect(list.some((e) => e.ref === '@openhive/example-mcp')).toBe(true);
    });

    it('_resetMcpRegistry returns to the default-shipped set', () => {
      registerMcpRef('@test/transient', { name: 'transient' });
      _resetMcpRegistry();
      expect(resolveMcpRef('@test/transient')).toBeNull();
      expect(resolveMcpRef('@openhive/example-mcp')).not.toBeNull();
    });
  });

  describe('materializer integration', () => {
    it('resolves a registered ref into mcpServers (not unresolvedRefs)', async () => {
      registerMcpRef('@test/resolved', {
        name: 'resolved-server',
        command: 'node',
        args: ['./r.js'],
      });
      const def: LoadoutDefinition = {
        name: 'lo',
        mcp_servers: [{ ref: '@test/resolved' }],
      };
      const bundle = bundleLoadout(resolveStandaloneLoadout(def), {
        version: '0.0.0',
        name: 'lo',
      });
      await getOpenteamsBundleStore().put(bundle as unknown as MAPResource);

      const m = await materializeLoadoutById(bundle.id);
      expect(m.unresolvedRefs).toEqual([]);
      expect(m.mcpServers).toEqual([
        { name: 'resolved-server', command: 'node', args: ['./r.js'] },
      ]);
    });

    it('leaves unknown refs in unresolvedRefs', async () => {
      const def: LoadoutDefinition = {
        name: 'lo',
        mcp_servers: [{ ref: '@nobody/unknown' }],
      };
      const bundle = bundleLoadout(resolveStandaloneLoadout(def), {
        version: '0.0.0',
        name: 'lo',
      });
      await getOpenteamsBundleStore().put(bundle as unknown as MAPResource);

      const m = await materializeLoadoutById(bundle.id);
      expect(m.unresolvedRefs).toEqual(['@nobody/unknown']);
      expect(m.mcpServers).toEqual([]);
    });

    it('handles a mixed batch: install spec + resolvable ref + unknown ref', async () => {
      registerMcpRef('@test/yes', { name: 'yes', command: 'node' });
      const def: LoadoutDefinition = {
        name: 'lo',
        mcp_servers: [
          { name: 'inline', command: 'node', args: ['./inline.js'] },
          { ref: '@test/yes' },
          { ref: '@nobody/no' },
        ],
      };
      const bundle = bundleLoadout(resolveStandaloneLoadout(def), {
        version: '0.0.0',
        name: 'lo',
      });
      await getOpenteamsBundleStore().put(bundle as unknown as MAPResource);

      const m = await materializeLoadoutById(bundle.id);
      expect(m.mcpServers.map((s) => s.name).sort()).toEqual(['inline', 'yes']);
      expect(m.unresolvedRefs).toEqual(['@nobody/no']);
    });
  });
});
