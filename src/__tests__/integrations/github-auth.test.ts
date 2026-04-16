/**
 * Tests for GitHub auth token resolution + repo URL parsing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseGitHubRepo, resetGitHubToken } from '../../integrations/github-auth.js';

describe('parseGitHubRepo', () => {
  it('parses HTTPS URLs', () => {
    expect(parseGitHubRepo('https://github.com/alexngai/openhive.git')).toEqual({
      owner: 'alexngai',
      repo: 'openhive',
    });
  });

  it('parses HTTPS URLs without .git', () => {
    expect(parseGitHubRepo('https://github.com/alexngai/openhive')).toEqual({
      owner: 'alexngai',
      repo: 'openhive',
    });
  });

  it('parses SSH URLs', () => {
    expect(parseGitHubRepo('git@github.com:alexngai/openhive.git')).toEqual({
      owner: 'alexngai',
      repo: 'openhive',
    });
  });

  it('parses bare github.com paths', () => {
    expect(parseGitHubRepo('github.com/owner/repo')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGitHubRepo('https://gitlab.com/owner/repo')).toBeNull();
    expect(parseGitHubRepo('local://cascade-test')).toBeNull();
    expect(parseGitHubRepo('')).toBeNull();
  });
});
