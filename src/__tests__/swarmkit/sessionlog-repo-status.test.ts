import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { probeSessionRepoStatus } from '../../swarmkit/sessionlog-repo-status.js';

/** Tiny wrapper — git commands in a specific cwd. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  })
    .toString()
    .trim();
}

describe('sessionlog-repo-status', () => {
  let tmpDir: string;
  let projectRoot: string;
  let sessionlogDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionlog-status-'));
    projectRoot = path.join(tmpDir, 'project');
    sessionlogDir = path.join(projectRoot, '.swarm', 'sessionlog');
    fs.mkdirSync(sessionlogDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Not configured ─────────────────────────────────────

  it('returns not-configured when sessionRepo.remote is unset', async () => {
    fs.writeFileSync(
      path.join(sessionlogDir, 'settings.json'),
      JSON.stringify({ enabled: false, strategy: 'manual-commit' }),
    );
    const status = await probeSessionRepoStatus(projectRoot, true);
    expect(status).toEqual({ state: 'not-configured' });
  });

  it('returns not-configured when sessionlog has no config files', async () => {
    const status = await probeSessionRepoStatus(projectRoot, true);
    expect(status).toEqual({ state: 'not-configured' });
  });

  it('returns not-configured when remote is empty string', async () => {
    fs.writeFileSync(
      path.join(sessionlogDir, 'settings.json'),
      JSON.stringify({ sessionRepo: { remote: '' } }),
    );
    const status = await probeSessionRepoStatus(projectRoot, true);
    expect(status).toEqual({ state: 'not-configured' });
  });

  // ─── Configured, clone missing ──────────────────────────

  it('reports cloneExists=false and null git state when clone is missing', async () => {
    fs.writeFileSync(
      path.join(sessionlogDir, 'settings.json'),
      JSON.stringify({
        sessionRepo: {
          remote: '/tmp/definitely-not-a-real-remote.git',
          directory: 'my-project',
        },
      }),
    );
    fs.writeFileSync(
      path.join(sessionlogDir, 'settings.local.json'),
      JSON.stringify({
        sessionRepo: { localPath: path.join(tmpDir, 'does-not-exist') },
      }),
    );

    const status = await probeSessionRepoStatus(projectRoot, true);
    if (status.state !== 'configured') throw new Error('expected configured');

    expect(status.cloneExists).toBe(false);
    expect(status.clonePath).toBe(path.join(tmpDir, 'does-not-exist'));
    expect(status.clonePathExplicit).toBe(true);
    expect(status.lastFetchedAt).toBeNull();
    expect(status.ahead).toBeNull();
    expect(status.behind).toBeNull();
    expect(status.checkpointsBranch).toBe('sessionlog/checkpoints/v1/my-project');
    expect(status.remoteReachable).toBe(false); // bogus remote
    expect(status.autoPush).toBe(false);
  });

  // ─── Full happy path with real bare remote + clone ──────

  it('reports ahead/behind/lastFetchedAt against a real remote', async () => {
    // Set up bare remote
    const remoteDir = path.join(tmpDir, 'remote.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remoteDir]);

    // Seed the remote with an initial commit on main + a checkpoint branch
    const seedDir = path.join(tmpDir, 'seed');
    fs.mkdirSync(seedDir);
    git(seedDir, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(seedDir, 'README.md'), '# seed\n');
    git(seedDir, 'add', '.');
    git(seedDir, 'commit', '-m', 'initial');
    git(seedDir, 'remote', 'add', 'origin', remoteDir);
    git(seedDir, 'push', 'origin', 'main');

    const branch = 'sessionlog/checkpoints/v1/my-project';
    git(seedDir, 'checkout', '--orphan', branch);
    git(seedDir, 'rm', '-rf', '.');
    fs.writeFileSync(path.join(seedDir, 'cp.txt'), 'checkpoint\n');
    git(seedDir, 'add', '.');
    git(seedDir, 'commit', '-m', 'checkpoint 1');
    git(seedDir, 'push', 'origin', branch);

    // Clone to the hub's configured path
    const clonePath = path.join(tmpDir, 'clone');
    execFileSync('git', ['clone', remoteDir, clonePath]);
    execFileSync('git', ['fetch', 'origin', `${branch}:${branch}`], { cwd: clonePath });
    execFileSync('git', ['checkout', branch], { cwd: clonePath });

    // Add one local commit (ahead by 1)
    fs.writeFileSync(path.join(clonePath, 'cp2.txt'), 'local-only\n');
    git(clonePath, 'add', '.');
    git(clonePath, 'commit', '-m', 'local checkpoint');

    // Seed sessionlog settings to point at this setup
    fs.writeFileSync(
      path.join(sessionlogDir, 'settings.json'),
      JSON.stringify({
        sessionRepo: {
          remote: remoteDir,
          directory: 'my-project',
          autoPush: true,
        },
      }),
    );
    fs.writeFileSync(
      path.join(sessionlogDir, 'settings.local.json'),
      JSON.stringify({ sessionRepo: { localPath: clonePath } }),
    );

    const status = await probeSessionRepoStatus(projectRoot, true);
    if (status.state !== 'configured') throw new Error('expected configured');

    expect(status.remote).toBe(remoteDir);
    expect(status.clonePath).toBe(clonePath);
    expect(status.clonePathExplicit).toBe(true);
    expect(status.cloneExists).toBe(true);
    expect(status.checkpointsBranch).toBe(branch);
    expect(status.remoteReachable).toBe(true); // local bare remote
    expect(status.lastFetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(0);
    expect(status.autoPush).toBe(true);
    expect(status.lastError).toBeNull();
  });

  it('returns null ahead/behind when directory is not set', async () => {
    const remoteDir = path.join(tmpDir, 'remote.git');
    execFileSync('git', ['init', '--bare', remoteDir]);
    const clonePath = path.join(tmpDir, 'clone');
    execFileSync('git', ['clone', remoteDir, clonePath]);

    fs.writeFileSync(
      path.join(sessionlogDir, 'settings.json'),
      JSON.stringify({
        sessionRepo: { remote: remoteDir },
      }),
    );
    fs.writeFileSync(
      path.join(sessionlogDir, 'settings.local.json'),
      JSON.stringify({ sessionRepo: { localPath: clonePath } }),
    );

    const status = await probeSessionRepoStatus(projectRoot, true);
    if (status.state !== 'configured') throw new Error('expected configured');

    expect(status.cloneExists).toBe(true);
    expect(status.checkpointsBranch).toBeNull();
    expect(status.ahead).toBeNull();
    expect(status.behind).toBeNull();
  });

  // ─── Explicit vs derived clone path ─────────────────────

  it('uses auto-clone path when localPath is not set', async () => {
    // Use a bogus local path as "remote" — ls-remote fails instantly, no DNS delay.
    fs.writeFileSync(
      path.join(sessionlogDir, 'settings.json'),
      JSON.stringify({ sessionRepo: { remote: '/nonexistent/repo.git' } }),
    );
    const status = await probeSessionRepoStatus(projectRoot, true);
    if (status.state !== 'configured') throw new Error('expected configured');
    expect(status.clonePathExplicit).toBe(false);
    expect(status.clonePath).toContain(path.join(os.homedir(), '.sessionlog', 'repos'));
  });

  // ─── Merge precedence ───────────────────────────────────

  it('uses local overrides over project settings for session-repo fields', async () => {
    fs.writeFileSync(
      path.join(sessionlogDir, 'settings.json'),
      JSON.stringify({
        sessionRepo: { remote: '/nonexistent/repo-a.git' },
      }),
    );
    fs.writeFileSync(
      path.join(sessionlogDir, 'settings.local.json'),
      JSON.stringify({
        sessionRepo: { localPath: '/tmp/custom-path' },
      }),
    );
    const status = await probeSessionRepoStatus(projectRoot, true);
    if (status.state !== 'configured') throw new Error('expected configured');
    expect(status.remote).toBe('/nonexistent/repo-a.git');
    expect(status.clonePath).toBe('/tmp/custom-path');
    expect(status.clonePathExplicit).toBe(true);
  });
});
