/**
 * Unit tests for the git-sync-config helper.
 *
 * Covers the merge behavior that keeps OpenHive's `metadata.git_sync` in
 * sync with opentasks' on-disk `sync.git` config block:
 *   - Writes config.json when none exists
 *   - Merges into existing config.json preserving unrelated keys
 *   - Applies the "live-sync" defaults (autoCommit/autoPush/pullOnStartup=true)
 *   - Explicit false values are preserved through merges
 *   - readAppliedGitSyncConfig round-trips
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  applyGitSyncConfig,
  readAppliedGitSyncConfig,
  GitSyncMetadataSchema,
} from '../../swarmkit/git-sync-config.js';

describe('git-sync-config', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsync-cfg-'));
    configPath = path.join(tempDir, '.opentasks', 'config.json');
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('applyGitSyncConfig', () => {
    it('creates config.json when missing and writes sync.git block', () => {
      applyGitSyncConfig(tempDir, { enabled: true });
      const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(written.sync.git).toMatchObject({
        enabled: true,
        remote: 'origin',
        autoCommit: true,
        autoPush: true,
        pullOnStartup: true,
      });
    });

    it('applies explicit values from the metadata', () => {
      applyGitSyncConfig(tempDir, {
        enabled: true,
        remote: 'upstream',
        autoCommit: false,
        autoPush: false,
        pullOnStartup: false,
        pushDebounceMs: 5000,
      });
      const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(written.sync.git).toEqual({
        enabled: true,
        remote: 'upstream',
        autoCommit: false,
        autoPush: false,
        pullOnStartup: false,
        pushDebounceMs: 5000,
      });
    });

    it('preserves unrelated top-level keys in existing config.json', () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          version: '1.0',
          location: { hash: 'abc', name: 'test' },
          providers: { beads: { enabled: false } },
        }),
      );

      applyGitSyncConfig(tempDir, { enabled: true });
      const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(written.version).toBe('1.0');
      expect(written.location).toEqual({ hash: 'abc', name: 'test' });
      expect(written.providers.beads.enabled).toBe(false);
      expect(written.sync.git.enabled).toBe(true);
    });

    it('preserves existing sync.git fields on partial update', () => {
      applyGitSyncConfig(tempDir, {
        enabled: true,
        remote: 'origin',
        pushDebounceMs: 10000,
      });
      // Second call flips enabled false but doesn't touch pushDebounceMs —
      // the original value should survive.
      applyGitSyncConfig(tempDir, { enabled: false });
      const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(written.sync.git.enabled).toBe(false);
      expect(written.sync.git.pushDebounceMs).toBe(10000);
    });

    it('preserves sync keys other than git', () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          sync: {
            someOther: { foo: 'bar' },
            git: { enabled: false },
          },
        }),
      );
      applyGitSyncConfig(tempDir, { enabled: true });
      const written = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(written.sync.someOther).toEqual({ foo: 'bar' });
      expect(written.sync.git.enabled).toBe(true);
    });
  });

  describe('readAppliedGitSyncConfig', () => {
    it('returns null when no config.json exists', () => {
      expect(readAppliedGitSyncConfig(tempDir)).toBeNull();
    });

    it('returns null when config.json has no sync.git', () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ version: '1.0' }));
      expect(readAppliedGitSyncConfig(tempDir)).toBeNull();
    });

    it('round-trips what applyGitSyncConfig wrote', () => {
      applyGitSyncConfig(tempDir, {
        enabled: true,
        remote: 'origin',
        autoCommit: true,
      });
      const read = readAppliedGitSyncConfig(tempDir);
      expect(read).toMatchObject({
        enabled: true,
        remote: 'origin',
        autoCommit: true,
      });
    });
  });

  describe('GitSyncMetadataSchema', () => {
    it('accepts the minimal shape', () => {
      const parsed = GitSyncMetadataSchema.parse({ enabled: true });
      expect(parsed.enabled).toBe(true);
    });

    it('rejects pushDebounceMs below the opentasks minimum', () => {
      const result = GitSyncMetadataSchema.safeParse({ enabled: true, pushDebounceMs: 500 });
      expect(result.success).toBe(false);
    });

    it('accepts pullOnSignal', () => {
      const parsed = GitSyncMetadataSchema.parse({ enabled: true, pullOnSignal: false });
      expect(parsed.pullOnSignal).toBe(false);
    });
  });
});
