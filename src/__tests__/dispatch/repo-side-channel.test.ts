/**
 * Tests for the extended repo side-channel that stores full repo bindings.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerRepoForDispatch,
  getRepoForDispatch,
  getRepoBindingForDispatch,
  clearRepoForDispatch,
  _resetRepoSideChannelForTest,
} from '../../dispatch/repo-side-channel.js';

describe('repo-side-channel', () => {
  beforeEach(() => {
    _resetRepoSideChannelForTest();
  });

  it('stores and retrieves repo_id via getRepoForDispatch (backwards-compat)', () => {
    registerRepoForDispatch('disp_1', 'repo_abc');
    expect(getRepoForDispatch('disp_1')).toBe('repo_abc');
  });

  it('returns undefined for unknown taskId', () => {
    expect(getRepoForDispatch('disp_unknown')).toBeUndefined();
    expect(getRepoBindingForDispatch('disp_unknown')).toBeUndefined();
  });

  it('stores full binding with all fields', () => {
    registerRepoForDispatch('disp_2', 'repo_xyz', {
      canonicalUrl: 'https://github.com/org/repo.git',
      branch: 'feature-x',
      commitSha: 'abc123',
      clonePolicy: 'allowed',
      clonePath: '/tmp/repos/repo_xyz',
    });

    const binding = getRepoBindingForDispatch('disp_2');
    expect(binding).toEqual({
      repoId: 'repo_xyz',
      canonicalUrl: 'https://github.com/org/repo.git',
      branch: 'feature-x',
      commitSha: 'abc123',
      clonePolicy: 'allowed',
      clonePath: '/tmp/repos/repo_xyz',
    });
  });

  it('stores binding with only repoId when no extra fields provided', () => {
    registerRepoForDispatch('disp_3', 'repo_min');

    const binding = getRepoBindingForDispatch('disp_3');
    expect(binding).toEqual({ repoId: 'repo_min' });
  });

  it('clearRepoForDispatch removes the entry', () => {
    registerRepoForDispatch('disp_4', 'repo_del');
    clearRepoForDispatch('disp_4');
    expect(getRepoForDispatch('disp_4')).toBeUndefined();
    expect(getRepoBindingForDispatch('disp_4')).toBeUndefined();
  });

  it('overwrites binding on re-register', () => {
    registerRepoForDispatch('disp_5', 'repo_v1', { branch: 'main' });
    registerRepoForDispatch('disp_5', 'repo_v2', { branch: 'develop' });

    const binding = getRepoBindingForDispatch('disp_5');
    expect(binding?.repoId).toBe('repo_v2');
    expect(binding?.branch).toBe('develop');
  });
});
