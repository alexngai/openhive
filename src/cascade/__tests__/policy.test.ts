import { describe, it, expect } from 'vitest';
import { resolveClosePolicy } from '../policy.js';

describe('resolveClosePolicy', () => {
  it('defaults to manual when all scopes absent', () => {
    expect(
      resolveClosePolicy({ hubConfig: { defaultClosePolicy: 'manual' } }),
    ).toBe('manual');
  });

  it('returns hub default when per-task and per-swarm are unset', () => {
    expect(
      resolveClosePolicy({ hubConfig: { defaultClosePolicy: 'on_merge' } }),
    ).toBe('on_merge');
  });

  describe('per-task scope', () => {
    it('manual on task wins over on_merge elsewhere', () => {
      expect(
        resolveClosePolicy({
          taskMetadata: { close_policy: 'manual' },
          swarmCapabilities: { cascade: { autoCloseOnMerge: true } },
          hubConfig: { defaultClosePolicy: 'on_merge' },
        }),
      ).toBe('manual');
    });

    it('on_merge on task wins over manual elsewhere', () => {
      expect(
        resolveClosePolicy({
          taskMetadata: { close_policy: 'on_merge' },
          swarmCapabilities: { cascade: { autoCloseOnMerge: false } },
          hubConfig: { defaultClosePolicy: 'manual' },
        }),
      ).toBe('on_merge');
    });

    it('invalid close_policy falls through to swarm scope', () => {
      expect(
        resolveClosePolicy({
          taskMetadata: { close_policy: 'weird' },
          swarmCapabilities: { cascade: { autoCloseOnMerge: true } },
          hubConfig: { defaultClosePolicy: 'manual' },
        }),
      ).toBe('on_merge');
    });
  });

  describe('per-swarm scope', () => {
    it('autoCloseOnMerge: true → on_merge', () => {
      expect(
        resolveClosePolicy({
          swarmCapabilities: { cascade: { autoCloseOnMerge: true } },
          hubConfig: { defaultClosePolicy: 'manual' },
        }),
      ).toBe('on_merge');
    });

    it('autoCloseOnMerge: false overrides hub on_merge default', () => {
      expect(
        resolveClosePolicy({
          swarmCapabilities: { cascade: { autoCloseOnMerge: false } },
          hubConfig: { defaultClosePolicy: 'on_merge' },
        }),
      ).toBe('manual');
    });

    it('missing cascade key falls through to hub default', () => {
      expect(
        resolveClosePolicy({
          swarmCapabilities: { mail: { canJoin: true } },
          hubConfig: { defaultClosePolicy: 'on_merge' },
        }),
      ).toBe('on_merge');
    });

    it('non-object cascade key is ignored', () => {
      expect(
        resolveClosePolicy({
          swarmCapabilities: { cascade: 'yes' as unknown as Record<string, unknown> },
          hubConfig: { defaultClosePolicy: 'manual' },
        }),
      ).toBe('manual');
    });
  });

  it('null inputs are tolerated', () => {
    expect(
      resolveClosePolicy({
        taskMetadata: null,
        swarmCapabilities: null,
        hubConfig: { defaultClosePolicy: 'manual' },
      }),
    ).toBe('manual');
  });
});
