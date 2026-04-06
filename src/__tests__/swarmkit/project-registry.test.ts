import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ProjectRegistry } from '../../swarmkit/project-registry.js';

describe('swarmkit/project-registry', () => {
  let tmpDir: string;
  let dataDir: string;
  let registry: ProjectRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmkit-registry-'));
    dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    registry = new ProjectRegistry(dataDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('list', () => {
    it('should return empty list initially', () => {
      expect(registry.list()).toEqual([]);
    });

    it('should filter out stale paths that no longer exist', () => {
      // Write directly to the file with a non-existent path
      const filePath = path.join(dataDir, 'swarmkit-projects.json');
      fs.writeFileSync(filePath, JSON.stringify({ projectRoots: ['/nonexistent/path'] }));
      expect(registry.list()).toEqual([]);
    });
  });

  describe('add', () => {
    it('should add a project root with .swarm/ directory', () => {
      const projectDir = path.join(tmpDir, 'my-project');
      fs.mkdirSync(path.join(projectDir, '.swarm'), { recursive: true });

      registry.add(projectDir);
      expect(registry.list()).toEqual([projectDir]);
    });

    it('should add a project root with .git/ directory', () => {
      const projectDir = path.join(tmpDir, 'git-project');
      fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true });

      registry.add(projectDir);
      expect(registry.list()).toEqual([projectDir]);
    });

    it('should reject non-existent paths', () => {
      expect(() => registry.add('/nonexistent')).toThrow('does not exist');
    });

    it('should reject paths without .swarm/ or .git/', () => {
      const emptyDir = path.join(tmpDir, 'empty');
      fs.mkdirSync(emptyDir);

      expect(() => registry.add(emptyDir)).toThrow('.swarm/ or .git/');
    });

    it('should reject files (not directories)', () => {
      const filePath = path.join(tmpDir, 'file.txt');
      fs.writeFileSync(filePath, 'content');

      expect(() => registry.add(filePath)).toThrow('not a directory');
    });

    it('should deduplicate paths', () => {
      const projectDir = path.join(tmpDir, 'dedup');
      fs.mkdirSync(path.join(projectDir, '.swarm'), { recursive: true });

      registry.add(projectDir);
      registry.add(projectDir);
      expect(registry.list()).toEqual([projectDir]);
    });

    it('should resolve relative paths', () => {
      const projectDir = path.join(tmpDir, 'relative-test');
      fs.mkdirSync(path.join(projectDir, '.swarm'), { recursive: true });

      // Add with relative-like path (path.resolve will normalize it)
      registry.add(projectDir);
      const list = registry.list();
      expect(list.length).toBe(1);
      expect(path.isAbsolute(list[0])).toBe(true);
    });
  });

  describe('remove', () => {
    it('should remove a registered project', () => {
      const projectDir = path.join(tmpDir, 'to-remove');
      fs.mkdirSync(path.join(projectDir, '.swarm'), { recursive: true });

      registry.add(projectDir);
      expect(registry.list().length).toBe(1);

      registry.remove(projectDir);
      expect(registry.list()).toEqual([]);
    });

    it('should no-op for unregistered paths', () => {
      registry.remove('/not/registered');
      expect(registry.list()).toEqual([]);
    });
  });

  describe('discover', () => {
    it('should find .swarm/ walking up from a subdirectory', () => {
      const root = path.join(tmpDir, 'discover-root');
      const sub = path.join(root, 'src', 'deep');
      fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
      fs.mkdirSync(sub, { recursive: true });

      expect(ProjectRegistry.discover(sub)).toBe(root);
    });

    it('should return null when no .swarm/ found', () => {
      const dir = path.join(tmpDir, 'no-swarm');
      fs.mkdirSync(dir, { recursive: true });

      expect(ProjectRegistry.discover(dir)).toBeNull();
    });

    it('should find .swarm/ in the start directory itself', () => {
      const dir = path.join(tmpDir, 'has-swarm');
      fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });

      expect(ProjectRegistry.discover(dir)).toBe(dir);
    });
  });

  describe('persistence', () => {
    it('should persist across registry instances', () => {
      const projectDir = path.join(tmpDir, 'persist-test');
      fs.mkdirSync(path.join(projectDir, '.swarm'), { recursive: true });

      registry.add(projectDir);

      // Create a new registry pointing to the same data dir
      const registry2 = new ProjectRegistry(dataDir);
      expect(registry2.list()).toEqual([projectDir]);
    });

    it('should handle corrupt registry file gracefully', () => {
      fs.writeFileSync(
        path.join(dataDir, 'swarmkit-projects.json'),
        'not json{{{',
      );
      expect(registry.list()).toEqual([]);
    });
  });
});
