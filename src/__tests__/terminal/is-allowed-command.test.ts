/**
 * Security regression tests for `isAllowedCommand` in src/terminal/terminal-ws.ts.
 *
 * The pre-fix implementation accepted any command path that contained the
 * substring `@openswarm/cli-`, so a forged path like
 *   /tmp/evil/@openswarm/cli-x/openswarm
 * passed the allowlist. The current implementation requires an exact match
 * against the path returned by `resolveOpenSwarmTuiBinary()`. These tests
 * pin that contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const RESOLVED_TUI_PATH = '/safe/path/@openswarm/cli-darwin-arm64/openswarm';

vi.mock('../../terminal/resolve-tui.js', () => ({
  resolveOpenSwarmTuiBinary: vi.fn(() => RESOLVED_TUI_PATH),
}));

import { isAllowedCommand } from '../../terminal/terminal-ws.js';
import { resolveOpenSwarmTuiBinary } from '../../terminal/resolve-tui.js';

describe('isAllowedCommand', () => {
  beforeEach(() => {
    vi.mocked(resolveOpenSwarmTuiBinary).mockReturnValue(RESOLVED_TUI_PATH);
  });

  describe('standard shells (exact match)', () => {
    it.each(['/bin/bash', '/bin/zsh', '/bin/sh', 'bash', 'zsh', 'sh'])(
      'accepts %s',
      (cmd) => {
        expect(isAllowedCommand(cmd)).toBe(true);
      },
    );

    it('rejects shells smuggled inside a path', () => {
      expect(isAllowedCommand('/tmp/evil/bash')).toBe(false);
      expect(isAllowedCommand('/usr/local/bin/bash')).toBe(false);
    });
  });

  describe('user $SHELL', () => {
    const ORIGINAL_SHELL = process.env.SHELL;

    afterEach(() => {
      process.env.SHELL = ORIGINAL_SHELL;
    });

    it('accepts the user $SHELL value when set', () => {
      process.env.SHELL = '/opt/homebrew/bin/fish';
      expect(isAllowedCommand('/opt/homebrew/bin/fish')).toBe(true);
    });

    it('does not accept arbitrary commands when $SHELL is unset', () => {
      delete process.env.SHELL;
      expect(isAllowedCommand('')).toBe(false);
    });
  });

  describe('OpenSwarm TUI binary', () => {
    it('accepts the resolved TUI binary path', () => {
      expect(isAllowedCommand(RESOLVED_TUI_PATH)).toBe(true);
    });

    it('rejects forged paths that contain the @openswarm/cli- substring', () => {
      // Regression: pre-fix code used `command.includes('@openswarm/cli-')`,
      // so an attacker-controlled path with that substring passed.
      expect(isAllowedCommand('/tmp/evil/@openswarm/cli-x/openswarm')).toBe(false);
      expect(isAllowedCommand('/tmp/@openswarm/cli-darwin-arm64/openswarm')).toBe(false);
      expect(isAllowedCommand('@openswarm/cli-darwin-arm64/openswarm')).toBe(false);
    });

    it('rejects paths that share a prefix but do not match exactly', () => {
      expect(isAllowedCommand(`${RESOLVED_TUI_PATH}.evil`)).toBe(false);
      expect(isAllowedCommand(`${RESOLVED_TUI_PATH} --rm -rf /`)).toBe(false);
    });

    it('rejects when no TUI binary is resolved', () => {
      vi.mocked(resolveOpenSwarmTuiBinary).mockReturnValueOnce(null);
      expect(isAllowedCommand(RESOLVED_TUI_PATH)).toBe(false);
    });
  });

  describe('catch-all rejection', () => {
    it.each([
      'rm',
      '/bin/rm',
      'curl http://evil.example.com',
      'node -e "require(\'child_process\').exec(\'pwd\')"',
      '../../bin/bash',
      '',
    ])('rejects %s', (cmd) => {
      expect(isAllowedCommand(cmd)).toBe(false);
    });
  });
});
