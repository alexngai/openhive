import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { LocalProvider } from '../../swarm/providers/local.js';
import { testRoot, cleanTestRoot } from '../helpers/test-dirs.js';

const TEST_ROOT = testRoot('swarm-workspace');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const SLEEP_SCRIPT = path.join(FIXTURES_DIR, 'sleep-server.js');

/** Run a git command in a test workdir with signing disabled */
function git(cmd: string, cwd: string): void {
  execSync(`git -c commit.gpgsign=false ${cmd}`, { cwd });
}

/** Create a bare git repo with a single committed file. Returns the repo path. */
function createBareRepo(name: string, file = 'README.md', content = '# hello'): string {
  const repoDir = path.join(TEST_ROOT, 'repos', name);
  const workDir = path.join(TEST_ROOT, 'repos', `${name}-work`);

  fs.mkdirSync(workDir, { recursive: true });
  git('init -b main', workDir);
  git('config user.email "test@test.com"', workDir);
  git('config user.name "Test"', workDir);
  fs.writeFileSync(path.join(workDir, file), content);
  git('add .', workDir);
  git('commit -m "init"', workDir);

  // Clone as bare for use as a "remote"
  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  execSync(`git clone --bare "${workDir}" "${repoDir}"`);

  return repoDir;
}

/** Create a bare repo with a specific branch. Returns the repo path. */
function createBareRepoWithBranch(
  name: string,
  branch: string,
  file = 'feature.txt',
  content = 'feature work',
): string {
  const workDir = path.join(TEST_ROOT, 'repos', `${name}-work`);
  const repoDir = path.join(TEST_ROOT, 'repos', name);

  fs.mkdirSync(workDir, { recursive: true });
  git('init -b main', workDir);
  git('config user.email "test@test.com"', workDir);
  git('config user.name "Test"', workDir);
  fs.writeFileSync(path.join(workDir, 'init.txt'), 'init');
  git('add .', workDir);
  git('commit -m "init"', workDir);

  git(`checkout -b ${branch}`, workDir);
  fs.writeFileSync(path.join(workDir, file), content);
  git('add .', workDir);
  git(`commit -m "add ${file}"`, workDir);

  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  execSync(`git clone --bare "${workDir}" "${repoDir}"`);

  return repoDir;
}

describe('LocalProvider workspace', () => {
  let provider: LocalProvider;

  afterEach(async () => {
    if (provider) {
      await provider.stopAll();
      provider.removeExitHandler();
    }
    cleanTestRoot(TEST_ROOT);
  });

  it('should clone a repo into the data directory before spawning', async () => {
    const repoPath = createBareRepo('basic-clone');
    provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);

    const dataDir = path.join(TEST_DATA_DIR, 'ws-clone-test');

    const result = await provider.provision({
      name: 'workspace-test',
      adapter: '',
      bootstrap_token: 'dGVzdA==',
      assigned_port: 19050,
      data_dir: dataDir,
      workspace: {
        repos: [{ url: repoPath }],
      },
    });

    // The repo should be cloned into the data directory
    expect(fs.existsSync(path.join(dataDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, '.git'))).toBe(true);

    await provider.deprovision(result.instance_id);
  }, 15000);

  it('should clone a repo into a subdirectory when path is specified', async () => {
    const repoPath = createBareRepo('subdir-clone');
    provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);

    const dataDir = path.join(TEST_DATA_DIR, 'ws-subdir-test');

    const result = await provider.provision({
      name: 'workspace-subdir-test',
      adapter: '',
      bootstrap_token: 'dGVzdA==',
      assigned_port: 19051,
      data_dir: dataDir,
      workspace: {
        repos: [{ url: repoPath, path: 'myrepo' }],
      },
    });

    expect(fs.existsSync(path.join(dataDir, 'myrepo', 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'myrepo', '.git'))).toBe(true);

    await provider.deprovision(result.instance_id);
  }, 15000);

  it('should checkout a specific branch', async () => {
    const repoPath = createBareRepoWithBranch('branch-clone', 'feature-x');
    provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);

    const dataDir = path.join(TEST_DATA_DIR, 'ws-branch-test');

    const result = await provider.provision({
      name: 'workspace-branch-test',
      adapter: '',
      bootstrap_token: 'dGVzdA==',
      assigned_port: 19052,
      data_dir: dataDir,
      workspace: {
        repos: [{ url: repoPath, branch: 'feature-x', path: 'repo' }],
      },
    });

    const repoDir = path.join(dataDir, 'repo');
    expect(fs.existsSync(path.join(repoDir, 'feature.txt'))).toBe(true);

    // Verify we're on the right branch
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoDir }).toString().trim();
    expect(branch).toBe('feature-x');

    await provider.deprovision(result.instance_id);
  }, 15000);

  it('should support shallow clones with depth option', async () => {
    // Create a repo with multiple commits so shallow clone is observable
    const workDir = path.join(TEST_ROOT, 'repos', 'shallow-clone-work');
    const repoDir = path.join(TEST_ROOT, 'repos', 'shallow-clone');
    fs.mkdirSync(workDir, { recursive: true });
    git('init -b main', workDir);
    git('config user.email "test@test.com"', workDir);
    git('config user.name "Test"', workDir);
    fs.writeFileSync(path.join(workDir, 'file.txt'), 'v1');
    git('add .', workDir);
    git('commit -m "commit 1"', workDir);
    fs.writeFileSync(path.join(workDir, 'file.txt'), 'v2');
    git('add .', workDir);
    git('commit -m "commit 2"', workDir);
    fs.writeFileSync(path.join(workDir, 'file.txt'), 'v3');
    git('add .', workDir);
    git('commit -m "commit 3"', workDir);
    execSync(`git clone --bare "${workDir}" "${repoDir}"`);

    provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);
    const dataDir = path.join(TEST_DATA_DIR, 'ws-shallow-test');

    const result = await provider.provision({
      name: 'workspace-shallow-test',
      adapter: '',
      bootstrap_token: 'dGVzdA==',
      assigned_port: 19053,
      data_dir: dataDir,
      workspace: {
        // Use file:// protocol to force smart transport (local protocol doesn't support --depth)
        repos: [{ url: `file://${repoDir}`, depth: 1 }],
      },
    });

    expect(fs.existsSync(path.join(dataDir, 'file.txt'))).toBe(true);

    // Verify the clone is shallow (only 1 commit visible)
    const commitCount = execSync('git rev-list --count HEAD', { cwd: dataDir }).toString().trim();
    expect(commitCount).toBe('1');

    await provider.deprovision(result.instance_id);
  }, 15000);

  it('should clone multiple repos into different subdirectories', async () => {
    const repoA = createBareRepo('multi-a', 'a.txt', 'repo A');
    const repoB = createBareRepo('multi-b', 'b.txt', 'repo B');
    provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);

    const dataDir = path.join(TEST_DATA_DIR, 'ws-multi-test');

    const result = await provider.provision({
      name: 'workspace-multi-test',
      adapter: '',
      bootstrap_token: 'dGVzdA==',
      assigned_port: 19054,
      data_dir: dataDir,
      workspace: {
        repos: [
          { url: repoA, path: 'project-a' },
          { url: repoB, path: 'project-b' },
        ],
      },
    });

    expect(fs.existsSync(path.join(dataDir, 'project-a', 'a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'project-b', 'b.txt'))).toBe(true);

    await provider.deprovision(result.instance_id);
  }, 15000);

  it('should throw when clone fails (bad URL)', async () => {
    provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);
    const dataDir = path.join(TEST_DATA_DIR, 'ws-fail-test');

    await expect(
      provider.provision({
        name: 'workspace-fail-test',
        adapter: '',
        bootstrap_token: 'dGVzdA==',
        assigned_port: 19055,
        data_dir: dataDir,
        workspace: {
          repos: [{ url: '/nonexistent/repo.git' }],
        },
      }),
    ).rejects.toThrow(/git clone failed/);
  }, 15000);

  it('should work normally when no workspace is specified', async () => {
    provider = new LocalProvider(`node ${SLEEP_SCRIPT}`);
    const dataDir = path.join(TEST_DATA_DIR, 'ws-none-test');

    const result = await provider.provision({
      name: 'no-workspace-test',
      adapter: '',
      bootstrap_token: 'dGVzdA==',
      assigned_port: 19056,
      data_dir: dataDir,
    });

    expect(result.state).toBe('running');
    expect(fs.existsSync(dataDir)).toBe(true);

    await provider.deprovision(result.instance_id);
  }, 10000);
});
