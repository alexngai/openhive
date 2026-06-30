/**
 * Security regression tests for `isAllowedCommand` in src/terminal/terminal-ws.ts.
 *
 * The pre-fix implementation accepted any command path that contained the
 * substring `@swarmkit-ai/swarm-runner-cli-`, so a forged path like
 *   /tmp/evil/@swarmkit-ai/swarm-runner-cli-x/swarm-runner
 * passed the allowlist. The current implementation requires an exact match
 * against the path returned by `resolveSwarmRunnerTuiBinary()`. These tests
 * pin that contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const RESOLVED_TUI_PATH = '/safe/path/@swarmkit-ai/swarm-runner-cli-darwin-arm64/swarm-runner';

vi.mock('../../terminal/resolve-tui.js', () => ({
  resolveSwarmRunnerTuiBinary: vi.fn(() => RESOLVED_TUI_PATH),
}));

import { isAllowedCommand } from '../../terminal/terminal-ws.js';
import { resolveSwarmRunnerTuiBinary } from '../../terminal/resolve-tui.js';

describe('isAllowedCommand', () => {
  beforeEach(() => {
    vi.mocked(resolveSwarmRunnerTuiBinary).mockReturnValue(RESOLVED_TUI_PATH);
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

  describe('SwarmRunner TUI binary', () => {
    it('accepts the resolved TUI binary path', () => {
      expect(isAllowedCommand(RESOLVED_TUI_PATH)).toBe(true);
    });

    it('rejects forged paths that contain the @swarmkit-ai/swarm-runner-cli- substring', () => {
      // Regression: pre-fix code used `command.includes('@swarmkit-ai/swarm-runner-cli-')`,
      // so an attacker-controlled path with that substring passed.
      expect(isAllowedCommand('/tmp/evil/@swarmkit-ai/swarm-runner-cli-x/swarm-runner')).toBe(false);
      expect(isAllowedCommand('/tmp/@swarmkit-ai/swarm-runner-cli-darwin-arm64/swarm-runner')).toBe(false);
      expect(isAllowedCommand('@swarmkit-ai/swarm-runner-cli-darwin-arm64/swarm-runner')).toBe(false);
    });

    it('rejects paths that share a prefix but do not match exactly', () => {
      expect(isAllowedCommand(`${RESOLVED_TUI_PATH}.evil`)).toBe(false);
      expect(isAllowedCommand(`${RESOLVED_TUI_PATH} --rm -rf /`)).toBe(false);
    });

    it('rejects when no TUI binary is resolved', () => {
      vi.mocked(resolveSwarmRunnerTuiBinary).mockReturnValueOnce(null);
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
