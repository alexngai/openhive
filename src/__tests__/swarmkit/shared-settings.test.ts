import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getSharedSettingsStatus,
  propagateSharedSetting,
} from '../../swarmkit/shared-settings.js';

describe('swarmkit/shared-settings', () => {
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmkit-shared-'));
    projectRoot = path.join(tmpDir, 'project');

    // Create minimem config
    const minimemDir = path.join(projectRoot, '.swarm', 'minimem');
    fs.mkdirSync(minimemDir, { recursive: true });
    fs.writeFileSync(
      path.join(minimemDir, 'config.json'),
      JSON.stringify({
        embedding: { provider: 'openai', apiKey: 'sk-test' },
        hybrid: { vectorWeight: 0.7 },
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getSharedSettingsStatus', () => {
    it('should report in-sync when values match', () => {
      const status = getSharedSettingsStatus(
        { embeddingProvider: 'openai' },
        projectRoot,
        true,
      );

      const embedding = status.find((s) => s.key === 'embeddingProvider')!;
      expect(embedding.currentValue).toBe('openai');
      expect(embedding.targets.length).toBeGreaterThan(0);

      const minimem = embedding.targets.find((t) => t.packageName === 'minimem')!;
      expect(minimem.currentValue).toBe('openai');
      expect(minimem.inSync).toBe(true);
    });

    it('should report out-of-sync when values differ', () => {
      const status = getSharedSettingsStatus(
        { embeddingProvider: 'gemini' },
        projectRoot,
        true,
      );

      const embedding = status.find((s) => s.key === 'embeddingProvider')!;
      const minimem = embedding.targets.find((t) => t.packageName === 'minimem')!;
      expect(minimem.currentValue).toBe('openai');
      expect(minimem.inSync).toBe(false);
    });

    it('should report out-of-sync when source is undefined', () => {
      const status = getSharedSettingsStatus({}, projectRoot, true);
      const embedding = status.find((s) => s.key === 'embeddingProvider')!;
      const minimem = embedding.targets.find((t) => t.packageName === 'minimem')!;
      expect(minimem.inSync).toBe(false);
    });

    it('should include choices for select-type settings', () => {
      const status = getSharedSettingsStatus({}, projectRoot, true);
      const embedding = status.find((s) => s.key === 'embeddingProvider')!;
      expect(embedding.type).toBe('select');
      expect(embedding.choices!.length).toBeGreaterThan(0);
    });
  });

  describe('propagateSharedSetting', () => {
    it('should propagate embedding provider to minimem', () => {
      const results = propagateSharedSetting(
        'embeddingProvider',
        'gemini',
        projectRoot,
        true,
      );

      expect(results.length).toBeGreaterThan(0);
      const minimemResult = results.find((r) => r.packageName === 'minimem');
      expect(minimemResult?.success).toBe(true);

      // Verify on disk
      const config = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, '.swarm', 'minimem', 'config.json'),
          'utf-8',
        ),
      );
      expect(config.embedding.provider).toBe('gemini');
      // Should preserve other fields
      expect(config.hybrid.vectorWeight).toBe(0.7);
    });

    it('should propagate API key to minimem', () => {
      const results = propagateSharedSetting(
        'embeddingApiKey',
        'sk-new-key',
        projectRoot,
        true,
      );

      const minimemResult = results.find((r) => r.packageName === 'minimem');
      expect(minimemResult?.success).toBe(true);

      const config = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, '.swarm', 'minimem', 'config.json'),
          'utf-8',
        ),
      );
      expect(config.embedding.apiKey).toBe('sk-new-key');
    });

    it('should return error for unknown setting key', () => {
      const results = propagateSharedSetting(
        'unknownSetting',
        'value',
        projectRoot,
        true,
      );
      expect(results[0].success).toBe(false);
      expect(results[0].message).toContain('Unknown');
    });

    it('should create config file when propagating to empty directory', () => {
      // Remove minimem config file but keep the directory
      fs.rmSync(path.join(projectRoot, '.swarm', 'minimem', 'config.json'));

      const results = propagateSharedSetting(
        'embeddingProvider',
        'gemini',
        projectRoot,
        true,
      );
      const minimemResult = results.find((r) => r.packageName === 'minimem');
      expect(minimemResult?.success).toBe(true);

      // Should have created the config file with just the propagated value
      const config = JSON.parse(
        fs.readFileSync(
          path.join(projectRoot, '.swarm', 'minimem', 'config.json'),
          'utf-8',
        ),
      );
      expect(config.embedding.provider).toBe('gemini');
    });
  });
});
