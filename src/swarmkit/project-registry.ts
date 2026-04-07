/**
 * Project registry — manages the set of project directories
 * whose SwarmKit configs OpenHive can read/write.
 *
 * Persisted as a simple JSON file in OpenHive's data directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProjectRegistryData } from './types.js';

export class ProjectRegistry {
  private filePath: string;
  private cachedRoots: string[] | null = null;
  private cachedMtimeMs: number = 0;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'swarmkit-projects.json');
  }

  /** List all registered project roots. */
  list(): string[] {
    return this.read().projectRoots;
  }

  /** Add a project root. Validates it exists, is a directory, and has .swarm/ or .git/. */
  add(projectRoot: string): void {
    const resolved = path.resolve(projectRoot);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Path does not exist: ${resolved}`);
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }

    // Require a .swarm/ or .git directory to prevent registering arbitrary paths
    const hasSwarm = fs.existsSync(path.join(resolved, '.swarm'));
    const hasGit = fs.existsSync(path.join(resolved, '.git'));
    if (!hasSwarm && !hasGit) {
      throw new Error(`Path must contain a .swarm/ or .git/ directory: ${resolved}`);
    }

    const data = this.read();
    const existing = new Set(data.projectRoots);
    if (existing.has(resolved)) return;

    data.projectRoots.push(resolved);
    this.write(data);
  }

  /** Remove a project root. */
  remove(projectRoot: string): void {
    const resolved = path.resolve(projectRoot);
    const data = this.read();
    data.projectRoots = data.projectRoots.filter((p) => p !== resolved);
    this.write(data);
  }

  /**
   * Walk up from startPath looking for a .swarm/ directory.
   * Returns the project root if found, null otherwise.
   */
  static discover(startPath: string): string | null {
    let current = path.resolve(startPath);
    const root = path.parse(current).root;

    while (current !== root) {
      if (fs.existsSync(path.join(current, '.swarm'))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return null;
  }

  /**
   * Auto-register the CWD if it has a .swarm/ directory.
   * Called on server startup.
   */
  autoRegisterCwd(): string | null {
    const discovered = ProjectRegistry.discover(process.cwd());
    if (discovered) {
      this.add(discovered);
    }
    return discovered;
  }

  // ─── Private ────────────────────────────────────────────────

  private invalidateCache(): void {
    this.cachedRoots = null;
  }

  private read(): ProjectRegistryData {
    try {
      if (fs.existsSync(this.filePath)) {
        const stat = fs.statSync(this.filePath);
        // Return cached result if the file hasn't changed
        if (this.cachedRoots && stat.mtimeMs === this.cachedMtimeMs) {
          return { projectRoots: this.cachedRoots };
        }

        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.projectRoots)) {
          // Filter out stale paths that no longer exist
          const validated = parsed.projectRoots.filter(
            (p: unknown) => typeof p === 'string' && fs.existsSync(p as string),
          );
          this.cachedRoots = validated;
          this.cachedMtimeMs = stat.mtimeMs;
          return { projectRoots: validated };
        }
      }
    } catch {
      // Corrupt file — reset
    }
    this.cachedRoots = [];
    this.cachedMtimeMs = 0;
    return { projectRoots: [] };
  }

  private write(data: ProjectRegistryData): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = this.filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
    this.invalidateCache();
  }
}
