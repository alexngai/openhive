import { describe, it, expect } from 'vitest';
import { normalizeGithubEvent } from '../../events/normalizers/github.js';
import { normalizeSlackEvent } from '../../events/normalizers/slack.js';
import { normalize } from '../../events/normalizers/index.js';

// ============================================================================
// GitHub Normalizer
// ============================================================================

describe('GitHub Normalizer', () => {
  describe('push events', () => {
    it('creates post data for push events with commits', () => {
      const event = normalizeGithubEvent('push', 'del_push1', {
        ref: 'refs/heads/main',
        commits: [
          { id: 'abc1234567890', message: 'Fix bug' },
          { id: 'def1234567890', message: 'Add feature' },
        ],
        compare: 'https://github.com/org/repo/compare/abc...def',
        repository: { full_name: 'org/repo' },
        sender: { login: 'alice' },
      });

      expect(event.source).toBe('github');
      expect(event.event_type).toBe('push');
      expect(event.delivery_id).toBe('del_push1');
      expect(event.metadata.repo).toBe('org/repo');
      expect(event.metadata.branch).toBe('main');
      expect(event.metadata.sender).toBe('alice');
      expect(event.post).toBeDefined();
      expect(event.post!.title).toBe('[org/repo] 2 commit(s) pushed to main');
      expect(event.post!.content).toContain('abc1234');
      expect(event.post!.content).toContain('Fix bug');
      expect(event.post!.url).toBe('https://github.com/org/repo/compare/abc...def');
    });

    it('does not create post for push with no commits', () => {
      const event = normalizeGithubEvent('push', 'del_push2', {
        ref: 'refs/heads/main',
        commits: [],
        repository: { full_name: 'org/repo' },
        sender: { login: 'alice' },
      });

      expect(event.post).toBeUndefined();
    });

    it('truncates long commit lists to 5', () => {
      const commits = Array.from({ length: 8 }, (_, i) => ({
        id: `commit${i}1234567890`,
        message: `Commit ${i}`,
      }));

      const event = normalizeGithubEvent('push', 'del_push3', {
        ref: 'refs/heads/feature',
        commits,
        repository: { full_name: 'org/repo' },
        sender: { login: 'bob' },
      });

      expect(event.post!.content).toContain('... and 3 more');
      expect(event.post!.title).toBe('[org/repo] 8 commit(s) pushed to feature');
    });
  });

  describe('pull_request events', () => {
    it('creates post for PR opened', () => {
      const event = normalizeGithubEvent('pull_request', 'del_pr1', {
        action: 'opened',
        pull_request: {
          number: 42,
          title: 'Add new feature',
          body: 'This PR adds a cool feature',
          html_url: 'https://github.com/org/repo/pull/42',
          merged: false,
          head: { ref: 'feature-branch' },
        },
        repository: { full_name: 'org/repo' },
        sender: { login: 'alice' },
      });

      expect(event.event_type).toBe('pull_request.opened');
      expect(event.action).toBe('opened');
      expect(event.metadata.branch).toBe('feature-branch');
      expect(event.post!.title).toBe('[org/repo] PR #42 opened: Add new feature');
      expect(event.post!.content).toBe('This PR adds a cool feature');
      expect(event.post!.url).toBe('https://github.com/org/repo/pull/42');
    });

    it('shows merged for closed+merged PRs', () => {
      const event = normalizeGithubEvent('pull_request', 'del_pr2', {
        action: 'closed',
        pull_request: {
          number: 43,
          title: 'Merged PR',
          body: 'Done',
          html_url: 'https://github.com/org/repo/pull/43',
          merged: true,
          head: { ref: 'merged-branch' },
        },
        repository: { full_name: 'org/repo' },
        sender: { login: 'bob' },
      });

      expect(event.post!.title).toBe('[org/repo] PR #43 merged: Merged PR');
    });

    it('skips post for non-actionable PR actions (edited, labeled, etc.)', () => {
      const event = normalizeGithubEvent('pull_request', 'del_pr3', {
        action: 'labeled',
        pull_request: {
          number: 44,
          title: 'Labeled PR',
          head: { ref: 'branch' },
        },
        repository: { full_name: 'org/repo' },
        sender: { login: 'alice' },
      });

      expect(event.event_type).toBe('pull_request.labeled');
      expect(event.post).toBeUndefined();
    });
  });

  describe('issues events', () => {
    it('creates post for issue opened', () => {
      const event = normalizeGithubEvent('issues', 'del_iss1', {
        action: 'opened',
        issue: {
          number: 7,
          title: 'Bug: something broken',
          body: 'Steps to reproduce...',
          html_url: 'https://github.com/org/repo/issues/7',
        },
        repository: { full_name: 'org/repo' },
        sender: { login: 'carol' },
      });

      expect(event.event_type).toBe('issues.opened');
      expect(event.post!.title).toBe('[org/repo] Issue #7 opened: Bug: something broken');
      expect(event.post!.content).toBe('Steps to reproduce...');
    });

    it('skips post for non-actionable issue actions', () => {
      const event = normalizeGithubEvent('issues', 'del_iss2', {
        action: 'labeled',
        issue: { number: 8, title: 'Labeled', html_url: 'url' },
        repository: { full_name: 'org/repo' },
        sender: { login: 'alice' },
      });

      expect(event.post).toBeUndefined();
    });
  });

  describe('passthrough events', () => {
    it('does not create post for unhandled event types', () => {
      const event = normalizeGithubEvent('check_run', 'del_cr1', {
        action: 'completed',
        check_run: { id: 1 },
        repository: { full_name: 'org/repo' },
        sender: { login: 'alice' },
      });

      expect(event.source).toBe('github');
      expect(event.event_type).toBe('check_run.completed');
      expect(event.post).toBeUndefined();
      expect(event.metadata.repo).toBe('org/repo');
    });
  });
});

// ============================================================================
// Slack Normalizer
// ============================================================================

describe('Slack Normalizer', () => {
  it('creates post for message events', () => {
    const event = normalizeSlackEvent('message', 'del_sl1', {
      team_id: 'T_TEST',
      event_type: 'message',
      event: {
        type: 'message',
        channel: 'C_GENERAL',
        user: 'U_ALICE',
        text: 'Hello from Slack!',
        ts: '1708900000.000100',
      },
    });

    expect(event.source).toBe('slack');
    expect(event.event_type).toBe('message');
    expect(event.metadata.channel_id).toBe('C_GENERAL');
    expect(event.metadata.sender).toBe('U_ALICE');
    expect(event.post).toBeDefined();
    expect(event.post!.title).toContain('[Slack #C_GENERAL]');
    expect(event.post!.content).toBe('Hello from Slack!');
  });

  it('skips post for bot messages', () => {
    const event = normalizeSlackEvent('message', 'del_sl2', {
      event: {
        type: 'message',
        channel: 'C1',
        user: 'U1',
        text: 'bot says hi',
        bot_id: 'B_BOT',
        ts: '123',
      },
    });

    expect(event.post).toBeUndefined();
  });

  it('skips post for non-message events', () => {
    const event = normalizeSlackEvent('app_mention', 'del_sl3', {
      event: {
        type: 'app_mention',
        channel: 'C1',
        user: 'U1',
        text: 'hey',
        ts: '123',
      },
    });

    expect(event.post).toBeUndefined();
  });
});

// ============================================================================
// Normalizer Registry
// ============================================================================

describe('Normalizer Registry', () => {
  it('dispatches to github normalizer', () => {
    const event = normalize('github', 'push', 'del1', {
      ref: 'refs/heads/main',
      commits: [{ id: 'abc1234567890', message: 'test' }],
      repository: { full_name: 'org/repo' },
      sender: { login: 'alice' },
    });

    expect(event.source).toBe('github');
    expect(event.post).toBeDefined();
  });

  it('dispatches to slack normalizer', () => {
    const event = normalize('slack', 'message', 'del2', {
      event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1' },
    });

    expect(event.source).toBe('slack');
  });

  it('falls back to passthrough for unknown sources', () => {
    const event = normalize('linear', 'issue.created', 'del3', { id: 'LIN-123' });

    expect(event.source).toBe('linear');
    expect(event.event_type).toBe('issue.created');
    expect(event.post).toBeUndefined();
    expect(event.raw_payload).toEqual({ id: 'LIN-123' });
  });
});
