/**
 * Unified git store (src/git-store.ts).
 *
 * Uses real git against temp directories. Verifies:
 * - ensureGitStore initializes the repo + scaffold once, idempotently
 * - remote wiring (add + set-url)
 * - commitStoreChanges is pathspec-scoped: commits the hub-owned dirs,
 *   never .opentasks (the opentasks daemon owns those commits)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { ConfigSchema, type Config } from '../config.js';
import {
  ensureGitStore,
  commitStoreChanges,
  resolveGitStorePath,
  STORE_SUBDIRS,
} from '../git-store.js';
import { testRoot, cleanTestRoot } from './helpers/test-dirs.js';

const TEST_ROOT = testRoot('git-store');
const STORE = path.join(TEST_ROOT, 'hive-store');

function storeConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    gitStore: { enabled: true, path: STORE, ...overrides },
  });
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: STORE, encoding: 'utf-8' }).trim();
}

describe('git-store', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterAll(() => {
    cleanTestRoot(TEST_ROOT);
  });

  it('returns null when disabled', async () => {
    const config = ConfigSchema.parse({ gitStore: { enabled: false } });
    expect(await ensureGitStore(config)).toBeNull();
  });

  it('initializes the store: repo, subdirs, scaffold, initial commit', async () => {
    const result = await ensureGitStore(storeConfig());
    expect(result).toBe(path.resolve(STORE));

    expect(fs.existsSync(path.join(STORE, '.git'))).toBe(true);
    for (const sub of STORE_SUBDIRS) {
      expect(fs.existsSync(path.join(STORE, sub))).toBe(true);
    }
    expect(fs.existsSync(path.join(STORE, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(STORE, '.gitignore'))).toBe(true);

    expect(git(['log', '--oneline'])).toContain('hive-store: initialize');
  });

  it('is idempotent: a second call adds no commits', async () => {
    const before = git(['rev-parse', 'HEAD']);
    await ensureGitStore(storeConfig());
    expect(git(['rev-parse', 'HEAD'])).toBe(before);
  });

  it('wires the remote (add, then set-url on change)', async () => {
    await ensureGitStore(storeConfig({ remote: 'https://example.com/store.git' }));
    expect(git(['remote', 'get-url', 'origin'])).toBe('https://example.com/store.git');

    await ensureGitStore(storeConfig({ remote: 'https://example.com/other.git' }));
    expect(git(['remote', 'get-url', 'origin'])).toBe('https://example.com/other.git');
  });

  it('resolveGitStorePath resolves the configured path', () => {
    expect(resolveGitStorePath(storeConfig())).toBe(path.resolve(STORE));
  });

  describe('commitStoreChanges', () => {
    it('skips when the hub-owned pathspec is clean', async () => {
      const before = git(['rev-parse', 'HEAD']);
      const { committed } = await commitStoreChanges(STORE, { push: false });
      expect(committed).toBe(false);
      expect(git(['rev-parse', 'HEAD'])).toBe(before);
    });

    it('commits dirty files under memory/, skills/, sessionlog-sessions/', async () => {
      fs.writeFileSync(path.join(STORE, 'memory', 'bank.md'), '# memory\n');
      fs.mkdirSync(path.join(STORE, 'skills', 'demo'), { recursive: true });
      fs.writeFileSync(path.join(STORE, 'skills', 'demo', 'SKILL.md'), '# skill\n');

      const { committed } = await commitStoreChanges(STORE, { push: false });
      expect(committed).toBe(true);

      const files = git(['show', '--name-only', '--format=', 'HEAD']).split('\n');
      expect(files).toContain('memory/bank.md');
      expect(files).toContain('skills/demo/SKILL.md');
      expect(git(['status', '--porcelain', '--', 'memory', 'skills'])).toBe('');
    });

    it('never commits .opentasks — the opentasks daemon owns it', async () => {
      fs.mkdirSync(path.join(STORE, '.opentasks'), { recursive: true });
      fs.writeFileSync(path.join(STORE, '.opentasks', 'graph.jsonl'), '{}\n');

      const before = git(['rev-parse', 'HEAD']);
      const { committed } = await commitStoreChanges(STORE, { push: false });
      expect(committed).toBe(false);
      expect(git(['rev-parse', 'HEAD'])).toBe(before);
      // Still dirty from git's perspective — deliberately left alone.
      expect(git(['status', '--porcelain', '--', '.opentasks'])).not.toBe('');
    });
  });
});
