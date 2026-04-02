import { describe, it, expect } from 'vitest';
import {
  CONFIG_SECTIONS,
  CONFIG_GROUP_ORDER,
  SECRET_PATHS,
  READONLY_PATHS,
  RESTART_REQUIRED_PATHS,
  SECRET_SENTINEL,
  FIELD_META,
  matchesPath,
  getSectionMeta,
  buildMetaResponse,
} from '../config-meta.js';

describe('config-meta', () => {
  describe('CONFIG_SECTIONS', () => {
    it('should have all expected sections', () => {
      const keys = CONFIG_SECTIONS.map(s => s.key);
      expect(keys).toContain('instance');
      expect(keys).toContain('mapHub');
      expect(keys).toContain('learning');
      expect(keys).toContain('swarmHosting');
      expect(keys).toContain('federation');
      expect(keys).toContain('resourceDiscovery');
    });

    it('should have valid groups for all sections', () => {
      for (const section of CONFIG_SECTIONS) {
        expect(CONFIG_GROUP_ORDER).toContain(section.group);
      }
    });

    it('should have labels and descriptions for all sections', () => {
      for (const section of CONFIG_SECTIONS) {
        expect(section.label).toBeTruthy();
        expect(section.description).toBeTruthy();
      }
    });
  });

  describe('SECRET_PATHS', () => {
    it('should include known secret fields', () => {
      expect(SECRET_PATHS.has('admin.key')).toBe(true);
      expect(SECRET_PATHS.has('mapHub.iamSecret')).toBe(true);
      expect(SECRET_PATHS.has('learning.atlas.embedding.apiKey')).toBe(true);
      expect(SECRET_PATHS.has('githubApp.privateKey')).toBe(true);
    });

    it('should not include non-secret fields', () => {
      expect(SECRET_PATHS.has('instance.name')).toBe(false);
      expect(SECRET_PATHS.has('learning.enabled')).toBe(false);
      expect(SECRET_PATHS.has('rateLimit.max')).toBe(false);
    });
  });

  describe('RESTART_REQUIRED_PATHS', () => {
    it('should include startup-only fields', () => {
      expect(RESTART_REQUIRED_PATHS.has('auth.mode')).toBe(true);
      expect(RESTART_REQUIRED_PATHS.has('learning.enabled')).toBe(true);
      expect(RESTART_REQUIRED_PATHS.has('network.provider')).toBe(true);
      expect(RESTART_REQUIRED_PATHS.has('federation.enabled')).toBe(true);
    });
  });

  describe('matchesPath', () => {
    it('should match exact paths', () => {
      expect(matchesPath('admin.key', SECRET_PATHS)).toBe(true);
    });

    it('should match child paths via prefix', () => {
      // network.tailscale is in RESTART_REQUIRED_PATHS
      expect(matchesPath('network.tailscale.apiKey', RESTART_REQUIRED_PATHS)).toBe(true);
      expect(matchesPath('network.tailscale.tailnet', RESTART_REQUIRED_PATHS)).toBe(true);
    });

    it('should not match unrelated paths', () => {
      expect(matchesPath('instance.name', SECRET_PATHS)).toBe(false);
      expect(matchesPath('rateLimit.max', RESTART_REQUIRED_PATHS)).toBe(false);
    });
  });

  describe('getSectionMeta', () => {
    it('should return metadata for known sections', () => {
      const meta = getSectionMeta('learning');
      expect(meta).toBeDefined();
      expect(meta!.label).toBe('Learning Engine');
      expect(meta!.group).toBe('integrations');
    });

    it('should return undefined for unknown sections', () => {
      expect(getSectionMeta('nonexistent')).toBeUndefined();
    });
  });

  describe('buildMetaResponse', () => {
    it('should return metadata for all config sections', () => {
      const meta = buildMetaResponse();

      for (const section of CONFIG_SECTIONS) {
        expect(meta[section.key]).toBeDefined();
        const sm = meta[section.key] as Record<string, unknown>;
        expect(sm.label).toBe(section.label);
        expect(sm.group).toBe(section.group);
        expect(sm.fields).toBeDefined();
      }
    });

    it('should include field metadata for known fields', () => {
      const meta = buildMetaResponse();
      const learning = meta.learning as Record<string, unknown>;
      const fields = learning.fields as Record<string, unknown>;

      expect(fields['enabled']).toBeDefined();
      const enabledField = fields['enabled'] as Record<string, unknown>;
      expect(enabledField.label).toBe('Enabled');
      expect(enabledField.restartRequired).toBe(true);
    });

    it('should mark secret fields', () => {
      const meta = buildMetaResponse();
      const learning = meta.learning as Record<string, unknown>;
      const fields = learning.fields as Record<string, unknown>;
      const apiKeyField = fields['atlas.embedding.apiKey'] as Record<string, unknown>;

      expect(apiKeyField.secret).toBe(true);
    });
  });

  describe('SECRET_SENTINEL', () => {
    it('should be a non-empty string', () => {
      expect(SECRET_SENTINEL).toBe('********');
    });
  });

  describe('FIELD_META coverage', () => {
    it('should have field metadata entries for secret paths', () => {
      // Every secret path should have a corresponding FIELD_META entry
      for (const secretPath of SECRET_PATHS) {
        expect(FIELD_META[secretPath]).toBeDefined();
        expect(FIELD_META[secretPath].secret).toBe(true);
      }
    });

    it('should have field metadata entries for restart-required paths (leaf paths)', () => {
      // Leaf restart-required paths should have entries
      const leafPaths = [...RESTART_REQUIRED_PATHS].filter(p => FIELD_META[p]);
      expect(leafPaths.length).toBeGreaterThan(0);

      for (const rpath of leafPaths) {
        expect(FIELD_META[rpath].restartRequired).toBe(true);
      }
    });
  });
});
