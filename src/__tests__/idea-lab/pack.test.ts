/**
 * Idea-lab pack validation — fast, no DB. Guards the checked-in pack and the
 * schema contract so a malformed edit fails in CI, not at boot.
 */

import { describe, it, expect } from 'vitest';
import {
  parseIdeaLabPack,
  DEFAULT_IDEA_LAB_PACK,
} from '../../idea-lab/index.js';

const base = {
  version: 1,
  graph: { name: 'idea-lab/graph' },
  ledger: { name: 'idea-lab/ledger' },
  objectives: [],
  roles: [{ key: 'ideator', cron: '0 * * * *', prompt: 'do a thing' }],
};

describe('idea-lab pack schema', () => {
  it('the checked-in default pack is valid and shaped as expected', () => {
    const pack = DEFAULT_IDEA_LAB_PACK;
    expect(pack.version).toBeGreaterThanOrEqual(1);
    const roleKeys = pack.roles.map((r) => r.key);
    expect(roleKeys).toEqual([
      'ideator',
      'skeptic',
      'synthesizer',
      'judge',
      'dispatcher',
    ]);
    // Every role carries a non-trivial prompt with the shared preamble.
    for (const role of pack.roles) {
      expect(role.prompt.length).toBeGreaterThan(100);
      expect(role.prompt).toContain('autonomous idea lab');
    }
  });

  it('accepts a minimal valid pack', () => {
    expect(() => parseIdeaLabPack(base)).not.toThrow();
  });

  it('rejects duplicate role keys', () => {
    const bad = {
      ...base,
      roles: [
        { key: 'ideator', cron: '0 * * * *', prompt: 'a' },
        { key: 'ideator', cron: '0 * * * *', prompt: 'b' },
      ],
    };
    expect(() => parseIdeaLabPack(bad)).toThrow(/duplicate role key/);
  });

  it('rejects duplicate objective keys', () => {
    const bad = {
      ...base,
      objectives: [
        { key: 'obj', title: 'A' },
        { key: 'obj', title: 'B' },
      ],
    };
    expect(() => parseIdeaLabPack(bad)).toThrow(/duplicate objective key/);
  });

  it('rejects a non-kebab-case key', () => {
    const bad = {
      ...base,
      roles: [{ key: 'Not Kebab', cron: '0 * * * *', prompt: 'a' }],
    };
    expect(() => parseIdeaLabPack(bad)).toThrow();
  });

  it('requires at least one role', () => {
    expect(() => parseIdeaLabPack({ ...base, roles: [] })).toThrow();
  });

  it('rejects an out-of-range objective priority', () => {
    const bad = {
      ...base,
      objectives: [{ key: 'obj', title: 'A', priority: 9 }],
    };
    expect(() => parseIdeaLabPack(bad)).toThrow();
  });
});
