import { describe, it, expect } from 'vitest';
import { normalizeGithubEvent } from '../../events/normalizers/github.js';
import { normalizeSlackEvent } from '../../events/normalizers/slack.js';
import { normalize } from '../../events/normalizers/index.js';

// ============================================================================
// GitHub Normalizer
// ============================================================================

describe('GitHub Normalizer', () => {
  it('extracts repo, branch, and sender metadata from push events', () => {
    const event = normalizeGithubEvent('push', 'del_push1', {
      ref: 'refs/heads/main',
      commits: [{ id: 'abc1234567890', message: 'Fix bug' }],
      repository: { full_name: 'org/repo' },
      sender: { login: 'alice' },
    });

    expect(event.source).toBe('github');
    expect(event.event_type).toBe('push');
    expect(event.delivery_id).toBe('del_push1');
    expect(event.metadata.repo).toBe('org/repo');
    expect(event.metadata.branch).toBe('main');
    expect(event.metadata.sender).toBe('alice');
  });

  it('qualifies event type with action on pull_request events', () => {
    const event = normalizeGithubEvent('pull_request', 'del_pr1', {
      action: 'opened',
      pull_request: {
        number: 42,
        title: 'Add new feature',
        head: { ref: 'feature-branch' },
      },
      repository: { full_name: 'org/repo' },
      sender: { login: 'alice' },
    });

    expect(event.event_type).toBe('pull_request.opened');
    expect(event.action).toBe('opened');
    expect(event.metadata.branch).toBe('feature-branch');
    expect(event.metadata.repo).toBe('org/repo');
  });

  it('preserves raw payload for unknown event types', () => {
    const event = normalizeGithubEvent('check_run', 'del_cr1', {
      action: 'completed',
      check_run: { id: 1 },
      repository: { full_name: 'org/repo' },
      sender: { login: 'alice' },
    });

    expect(event.source).toBe('github');
    expect(event.event_type).toBe('check_run.completed');
    expect(event.metadata.repo).toBe('org/repo');
    expect(event.raw_payload).toMatchObject({ action: 'completed' });
  });
});

// ============================================================================
// Slack Normalizer
// ============================================================================

describe('Slack Normalizer', () => {
  it('extracts channel_id and sender metadata', () => {
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
    expect(event.metadata.repo).toBe('org/repo');
  });

  it('dispatches to slack normalizer', () => {
    const event = normalize('slack', 'message', 'del2', {
      event: { type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1' },
    });

    expect(event.source).toBe('slack');
    expect(event.metadata.channel_id).toBe('C1');
  });

  it('falls back to passthrough for unknown sources', () => {
    const event = normalize('linear', 'issue.created', 'del3', { id: 'LIN-123' });

    expect(event.source).toBe('linear');
    expect(event.event_type).toBe('issue.created');
    expect(event.raw_payload).toEqual({ id: 'LIN-123' });
  });
});
