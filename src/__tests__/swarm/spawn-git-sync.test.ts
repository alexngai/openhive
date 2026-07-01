/**
 * Regression test: SwarmManager.spawn() calls `applyGitSyncConfig` into
 * the hosted swarm's dataDir when `input.git_sync.enabled` is true.
 *
 * Standing up a full SwarmManager in isolation requires the entire hub
 * ceremony (token service secrets, MAP DAL, ports, delegation, etc.), so
 * rather than run a real spawn this test inspects the module's source
 * directly. It's a narrow lock-in for the wire point — any refactor that
 * drops the call or its ordering around `provider.provision()` will
 * make this fail immediately.
 *
 * The behavior itself is covered end-to-end by the existing swarm e2e
 * suite (no crashes on spawn with/without git_sync) and unit-wise by
 * `src/__tests__/swarmkit/git-sync-config.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MANAGER_PATH = path.resolve(__dirname, '../../swarm/manager.ts');

describe('SwarmManager.spawn git_sync wire', () => {
  const source = fs.readFileSync(MANAGER_PATH, 'utf-8');
  // git_sync only applies to the swarm-runner spawn path (claude-code skips
  // it for v1 — see HOSTED_SWARM_KINDS_DESIGN.md). Anchor every assertion
  // on the spawnSwarmRunner function so adding new spawn paths doesn't
  // perturb these checks.
  const swarmRunnerStart = source.indexOf('private async spawnSwarmRunner(agentId');
  const swarmRunnerSource = swarmRunnerStart >= 0 ? source.slice(swarmRunnerStart) : '';

  it('has a spawnSwarmRunner function (dispatcher seam)', () => {
    expect(swarmRunnerStart).toBeGreaterThan(-1);
  });

  it('imports applyGitSyncConfig from the swarmkit helper', () => {
    expect(source).toMatch(
      /import\s+\{\s*applyGitSyncConfig\s*\}\s+from\s+['"]\.\.\/swarmkit\/git-sync-config\.js['"]/,
    );
  });

  it('calls applyGitSyncConfig(dataDir, input.git_sync) inside spawnSwarmRunner()', () => {
    expect(swarmRunnerSource).toMatch(/applyGitSyncConfig\(dataDir,\s*input\.git_sync\)/);
  });

  it('gates the call on input.git_sync.enabled', () => {
    const applyIdx = swarmRunnerSource.indexOf('applyGitSyncConfig(dataDir');
    expect(applyIdx).toBeGreaterThan(-1);
    const prelude = swarmRunnerSource.slice(0, applyIdx);
    expect(prelude).toMatch(/input\.git_sync\?\.enabled/);
  });

  it('runs before provider.provision() so the config lands before the subprocess boots', () => {
    const applyIdx = swarmRunnerSource.indexOf('applyGitSyncConfig(dataDir');
    const provisionIdx = swarmRunnerSource.indexOf('provider.provision(provisionConfig');
    expect(applyIdx).toBeGreaterThan(-1);
    expect(provisionIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeLessThan(provisionIdx);
  });
});
