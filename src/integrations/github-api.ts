/**
 * GitHub API Client — minimal REST client for PR management.
 *
 * Uses the token from github-auth.ts. All methods return null on auth
 * failure so callers can degrade gracefully.
 */

import { getGitHubToken, parseGitHubRepo } from './github-auth.js';

const GITHUB_API = 'https://api.github.com';

interface GitHubAPIOptions {
  method?: string;
  body?: Record<string, unknown>;
}

async function githubFetch<T>(
  path: string,
  options: GitHubAPIOptions = {},
): Promise<T | null> {
  const token = getGitHubToken();
  if (!token) return null;

  const { method = 'GET', body } = options;

  try {
    const res = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }

    // 204 No Content
    if (res.status === 204) return null;

    return (await res.json()) as T;
  } catch (err) {
    throw err;
  }
}

// ============================================================================
// PR types
// ============================================================================

export interface GitHubPR {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged: boolean;
  title: string;
  head: { ref: string };
  base: { ref: string };
  draft: boolean;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
}

export interface CreatePRParams {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;      // source branch
  base: string;      // target branch (default: main)
  draft?: boolean;
}

export interface UpdatePRParams {
  owner: string;
  repo: string;
  prNumber: number;
  title?: string;
  body?: string;
  base?: string;
  state?: 'open' | 'closed';
}

// ============================================================================
// PR operations
// ============================================================================

export async function createPullRequest(params: CreatePRParams): Promise<GitHubPR> {
  const result = await githubFetch<GitHubPR>(
    `/repos/${params.owner}/${params.repo}/pulls`,
    {
      method: 'POST',
      body: {
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
        draft: params.draft ?? false,
      },
    },
  );
  if (!result) throw new Error('GitHub API: no token configured');
  return result;
}

export async function updatePullRequest(params: UpdatePRParams): Promise<GitHubPR> {
  const body: Record<string, unknown> = {};
  if (params.title !== undefined) body.title = params.title;
  if (params.body !== undefined) body.body = params.body;
  if (params.base !== undefined) body.base = params.base;
  if (params.state !== undefined) body.state = params.state;

  const result = await githubFetch<GitHubPR>(
    `/repos/${params.owner}/${params.repo}/pulls/${params.prNumber}`,
    { method: 'PATCH', body },
  );
  if (!result) throw new Error('GitHub API: no token configured');
  return result;
}

export async function getPullRequest(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubPR | null> {
  return githubFetch<GitHubPR>(
    `/repos/${owner}/${repo}/pulls/${prNumber}`,
  );
}

export async function closePullRequest(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubPR> {
  return updatePullRequest({ owner, repo, prNumber, state: 'closed' });
}

// ============================================================================
// Utility
// ============================================================================

/**
 * Check if GitHub API is available (token exists + connectivity).
 */
export async function checkGitHubConnection(): Promise<{
  connected: boolean;
  user?: string;
  error?: string;
}> {
  const token = getGitHubToken();
  if (!token) return { connected: false, error: 'No GitHub token found' };

  try {
    const user = await githubFetch<{ login: string }>('/user');
    return { connected: true, user: user?.login };
  } catch (err) {
    return {
      connected: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

export { parseGitHubRepo };
