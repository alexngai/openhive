import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { fetchRepo, pushRepo, cloneRepo } from '../../swarmkit/sessionlog-repo-actions.js';

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

describe('sessionlog-repo-actions', () => {
  let tmpDir: string;
  let projectRoot: string;
  let sessionlogDir: string;
  let remoteDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessionlog-actions-'));
    projectRoot = path.join(tmpDir, 'project');
    sessionlogDir = path.join(projectRoot, '.swarm', 'sessionlog');
    fs.mkdirSync(sessionlogDir, { recursive: true });

    // Bare remote with initial main commit + checkpoints branch
    remoteDir = path.join(tmpDir, 'remote.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remoteDir]);
    const seed = path.join(tmpDir, 'seed');
    fs.mkdirSync(seed);
    git(seed, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(seed, 'README.md'), '# seed\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'initial');
    git(seed, 'remote', 'add', 'origin', remoteDir);
    git(seed, 'push', 'origin', 'main');
    git(seed, 'checkout', '--orphan', 'sessionlog/checkpoints/v1/my-project');
    git(seed, 'rm', '-rf', '.');
    fs.writeFileSync(path.join(seed, 'cp.txt'), 'checkpoint\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-m', 'checkpoint 1');
    git(seed, 'push', 'origin', 'sessionlog/checkpoints/v1/my-project');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(cloneLocalPath: string | null, directory: string | null = 'my-project') {
    fs.writeFileSync(
      path.join(sessionlogDir, 'settings.json'),
      JSON.stringify({
        sessionRepo: {
          remote: remoteDir,
          ...(directory ? { directory } : {}),
        },
      }),
    );
    if (cloneLocalPath) {
      fs.writeFileSync(
        path.join(sessionlogDir, 'settings.local.json'),
        JSON.stringify({ sessionRepo: { localPath: cloneLocalPath } }),
      );
    }
  }

  // ─── cloneRepo ──────────────────────────────────────────

  it('cloneRepo clones when local clone is missing', async () => {
    const clonePath = path.join(tmpDir, 'clone');
    writeConfig(clonePath);

    const result = await cloneRepo(projectRoot, true);

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(fs.existsSync(path.join(clonePath, '.git'))).toBe(true);
    if (result.status.state !== 'configured') throw new Error();
    expect(result.status.cloneExists).toBe(true);
  });

  it('cloneRepo refuses when clone already exists', async () => {
    const clonePath = path.join(tmpDir, 'clone');
    writeConfig(clonePath);
    execFileSync('git', ['clone', remoteDir, clonePath]);

    const result = await cloneRepo(projectRoot, true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('already exists');
  });

  it('cloneRepo fails when remote is not configured', async () => {
    const result = await cloneRepo(projectRoot, true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not configured');
  });

  // ─── fetchRepo ──────────────────────────────────────────

  it('fetchRepo runs git fetch when clone exists', async () => {
    const clonePath = path.join(tmpDir, 'clone');
    writeConfig(clonePath);
    execFileSync('git', ['clone', remoteDir, clonePath]);

    const result = await fetchRepo(projectRoot, true);
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    if (result.status.state !== 'configured') throw new Error();
    expect(result.status.lastFetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('fetchRepo fails when clone is missing', async () => {
    const clonePath = path.join(tmpDir, 'definitely-missing');
    writeConfig(clonePath);

    const result = await fetchRepo(projectRoot, true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Clone does not exist');
  });

  // ─── pushRepo ───────────────────────────────────────────

  it('pushRepo pushes checkpoints branch when clone + directory present', async () => {
    const clonePath = path.join(tmpDir, 'clone');
    writeConfig(clonePath);
    execFileSync('git', ['clone', remoteDir, clonePath]);
    // Check out the checkpoint branch from the remote and add a commit
    execFileSync('git', ['fetch', 'origin', 'sessionlog/checkpoints/v1/my-project:sessionlog/checkpoints/v1/my-project'], { cwd: clonePath });
    execFileSync('git', ['checkout', 'sessionlog/checkpoints/v1/my-project'], { cwd: clonePath });
    fs.writeFileSync(path.join(clonePath, 'cp2.txt'), 'new checkpoint\n');
    git(clonePath, 'add', '.');
    git(clonePath, 'commit', '-m', 'push me');

    const result = await pushRepo(projectRoot, true);
    expect(result.ok).toBe(true);
    if (result.status.state !== 'configured') throw new Error();
    expect(result.status.ahead).toBe(0); // after successful push
  });

  it('pushRepo fails when directory is not set', async () => {
    const clonePath = path.join(tmpDir, 'clone');
    writeConfig(clonePath, null);
    execFileSync('git', ['clone', remoteDir, clonePath]);

    const result = await pushRepo(projectRoot, true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('sessionRepo.directory');
  });

  it('pushRepo fails when clone is missing', async () => {
    const clonePath = path.join(tmpDir, 'missing');
    writeConfig(clonePath);

    const result = await pushRepo(projectRoot, true);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Clone does not exist');
  });
});
