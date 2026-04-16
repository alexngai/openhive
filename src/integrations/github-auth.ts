/**
 * GitHub Auth — resolves a GitHub API token from the local environment.
 *
 * Fallback chain (first wins):
 *   1. GITHUB_TOKEN env var (CI / explicit override)
 *   2. gh CLI hosts file (~/.config/gh/hosts.yml)
 *   3. OpenHive config git_hosting.token
 *   4. null → PR features disabled
 *
 * Zero-config for operators who have `gh auth login` done.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

let cachedToken: string | null | undefined;

/**
 * Resolve a GitHub API token. Result is cached for the process lifetime.
 * Call `resetGitHubToken()` to clear (tests).
 */
export function getGitHubToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;

  // 1. Env var
  const envToken = process.env.GITHUB_TOKEN;
  if (envToken) {
    cachedToken = envToken;
    return cachedToken;
  }

  // 2. gh CLI hosts file (older format with inline oauth_token)
  const ghToken = readGhCliToken();
  if (ghToken) {
    cachedToken = ghToken;
    return cachedToken;
  }

  // 3. gh auth token command (newer format — token in system keychain)
  const ghCmdToken = readGhAuthTokenCommand();
  if (ghCmdToken) {
    cachedToken = ghCmdToken;
    return cachedToken;
  }

  // 4. Not found
  cachedToken = null;
  return null;
}

export function resetGitHubToken(): void {
  cachedToken = undefined;
}

/**
 * Read the oauth_token from ~/.config/gh/hosts.yml for github.com.
 * Parses the YAML minimally to avoid a js-yaml dependency in the hub.
 */
function readGhCliToken(): string | null {
  const configDir =
    process.env.GH_CONFIG_DIR ??
    path.join(os.homedir(), '.config', 'gh');
  const hostsPath = path.join(configDir, 'hosts.yml');

  try {
    if (!fs.existsSync(hostsPath)) return null;
    const content = fs.readFileSync(hostsPath, 'utf-8');

    // Minimal YAML parse: find github.com block, then oauth_token line
    const lines = content.split('\n');
    let inGitHub = false;
    for (const line of lines) {
      const trimmed = line.trimStart();
      // Top-level key (no indentation or less indentation)
      if (!line.startsWith(' ') && !line.startsWith('\t') && line.includes(':')) {
        inGitHub = trimmed.startsWith('github.com:');
        continue;
      }
      if (inGitHub && trimmed.startsWith('oauth_token:')) {
        const token = trimmed.slice('oauth_token:'.length).trim();
        // Remove quotes if present
        if ((token.startsWith('"') && token.endsWith('"')) ||
            (token.startsWith("'") && token.endsWith("'"))) {
          return token.slice(1, -1);
        }
        return token || null;
      }
    }
  } catch {
    // Can't read gh config — not fatal
  }
  return null;
}

/**
 * Run `gh auth token` to get the token from the system keychain.
 * Newer gh CLI versions (2.40+) store tokens in the OS keychain
 * rather than in hosts.yml.
 */
function readGhAuthTokenCommand(): string | null {
  try {
    const result = execSync('gh auth token', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 3000,
    }).trim();
    return result || null;
  } catch {
    // gh not installed or not authenticated
    return null;
  }
}

/**
 * Parse repo owner and name from a git remote URL.
 *
 * Supports:
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *   github.com/owner/repo
 */
export function parseGitHubRepo(gitUrl: string): { owner: string; repo: string } | null {
  // HTTPS style
  let match = gitUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (match) return { owner: match[1], repo: match[2] };

  // SSH style
  match = gitUrl.match(/github\.com:([^/]+)\/([^/.]+)/);
  if (match) return { owner: match[1], repo: match[2] };

  return null;
}
