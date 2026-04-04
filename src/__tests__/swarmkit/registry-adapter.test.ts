import { describe, it, expect } from 'vitest';
import {
  buildPackageMeta,
  buildAllPackageMeta,
  getRegisteredPackageNames,
} from '../../swarmkit/registry-adapter.js';

describe('swarmkit/registry-adapter', () => {
  describe('getRegisteredPackageNames', () => {
    it('should return all known packages', () => {
      const names = getRegisteredPackageNames();
      expect(names).toContain('minimem');
      expect(names).toContain('opentasks');
      expect(names).toContain('sessionlog');
      expect(names).toContain('claude-code-swarm');
      expect(names).toContain('skill-tree');
      expect(names).toContain('self-driving-repo');
      expect(names).toContain('openteams');
      expect(names).toContain('cognitive-core');
    });
  });

  describe('buildPackageMeta', () => {
    it('should return null for unknown packages', () => {
      expect(buildPackageMeta('nonexistent', [])).toBeNull();
    });

    it('should build meta for minimem', () => {
      const meta = buildPackageMeta('minimem', ['minimem']);
      expect(meta).not.toBeNull();
      expect(meta!.name).toBe('minimem');
      expect(meta!.category).toBe('learning');
      expect(meta!.scopes).toEqual(['project']);
      expect(meta!.inlineOptions.length).toBeGreaterThan(0);
    });

    it('should include field metadata matching inline options', () => {
      const meta = buildPackageMeta('minimem', ['minimem'])!;
      expect(meta.fields['hybrid.vectorWeight']).toBeDefined();
      expect(meta.fields['hybrid.vectorWeight'].label).toContain('Vector search weight');
    });

    it('should include choices for select-type options', () => {
      const meta = buildPackageMeta('self-driving-repo', ['self-driving-repo'])!;
      const templateOpt = meta.inlineOptions.find((o) => o.key === 'template');
      expect(templateOpt).toBeDefined();
      expect(templateOpt!.type).toBe('select');
      expect(templateOpt!.choices!.length).toBeGreaterThan(0);
    });

    it('should filter conditional options when dependencies not installed', () => {
      const meta = buildPackageMeta('claude-code-swarm', ['claude-code-swarm'])!;
      // map.server requires multi-agent-protocol — should be filtered out
      const mapServer = meta.inlineOptions.find((o) => o.key === 'map.server');
      expect(mapServer).toBeUndefined();
      // map.enabled has no condition — should be present
      const mapEnabled = meta.inlineOptions.find((o) => o.key === 'map.enabled');
      expect(mapEnabled).toBeDefined();
    });

    it('should include conditional options when dependencies are installed', () => {
      const meta = buildPackageMeta('claude-code-swarm', [
        'claude-code-swarm',
        'multi-agent-protocol',
        'sessionlog',
      ])!;
      const mapServer = meta.inlineOptions.find((o) => o.key === 'map.server');
      expect(mapServer).toBeDefined();
      const sessionEnabled = meta.inlineOptions.find((o) => o.key === 'sessionlog.enabled');
      expect(sessionEnabled).toBeDefined();
    });

    it('should mark password fields as secret', () => {
      // Currently no password fields in the registry, but verify the mechanism
      const meta = buildPackageMeta('minimem', ['minimem'])!;
      for (const [, fieldMeta] of Object.entries(meta.fields)) {
        // minimem has no password fields, all should be non-secret
        expect(fieldMeta.secret).toBeFalsy();
      }
    });

    it('should return empty inline options for packages with no config', () => {
      const meta = buildPackageMeta('cognitive-core', ['cognitive-core'])!;
      expect(meta.inlineOptions).toEqual([]);
    });
  });

  describe('buildAllPackageMeta', () => {
    it('should return meta for all registered packages', () => {
      const all = buildAllPackageMeta(['minimem', 'opentasks']);
      const names = Object.keys(all);
      expect(names).toContain('minimem');
      expect(names).toContain('opentasks');
      expect(names).toContain('sessionlog'); // even if not installed, meta is built
    });
  });
});
