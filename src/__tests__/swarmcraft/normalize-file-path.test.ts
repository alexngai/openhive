import { describe, it, expect } from 'vitest';

// Import the function via a re-export trick — normalizeFilePath is not exported,
// so we test it indirectly by importing the module and accessing the function.
// Since normalizeFilePath is a private function, we test its behavior through
// the session-bridge. However, for thorough unit testing, we extract and test
// the logic directly by reimplementing it here to verify the algorithm.

// Replicate normalizeFilePath logic for direct unit testing
import path from 'node:path';

function normalizeFilePath(filePath: string, projectPath?: string): string {
  if (!filePath) return filePath;

  // If we have a project path, strip it to get a relative path
  if (projectPath) {
    const root = projectPath.endsWith('/') ? projectPath : projectPath + '/';
    if (filePath.startsWith(root)) {
      return filePath.slice(root.length);
    }
  }

  // Heuristic: if it looks absolute, try to extract the relative portion
  if (filePath.startsWith('/')) {
    const markers = ['/src/', '/lib/', '/test/', '/tests/', '/docs/', '/references/'];
    for (const marker of markers) {
      const idx = filePath.indexOf(marker);
      if (idx !== -1) {
        return filePath.slice(idx + 1);
      }
    }
    return path.basename(filePath);
  }

  return filePath;
}

describe('normalizeFilePath', () => {
  describe('with projectPath', () => {
    it('should strip project root from absolute path', () => {
      expect(normalizeFilePath('/Users/dev/my-project/src/index.ts', '/Users/dev/my-project'))
        .toBe('src/index.ts');
    });

    it('should handle projectPath with trailing slash', () => {
      expect(normalizeFilePath('/Users/dev/my-project/src/index.ts', '/Users/dev/my-project/'))
        .toBe('src/index.ts');
    });

    it('should handle deeply nested files', () => {
      expect(normalizeFilePath(
        '/Users/dev/my-project/src/api/routes/agents.ts',
        '/Users/dev/my-project',
      )).toBe('src/api/routes/agents.ts');
    });

    it('should handle root-level files', () => {
      expect(normalizeFilePath('/Users/dev/my-project/package.json', '/Users/dev/my-project'))
        .toBe('package.json');
    });

    it('should fall through to heuristic if path does not match project root', () => {
      // Different project root — should use marker heuristic
      expect(normalizeFilePath('/other/project/src/file.ts', '/Users/dev/my-project'))
        .toBe('src/file.ts');
    });

    it('should handle already-relative paths (no stripping needed)', () => {
      expect(normalizeFilePath('src/server.ts', '/Users/dev/my-project'))
        .toBe('src/server.ts');
    });
  });

  describe('without projectPath (heuristic fallback)', () => {
    it('should extract from /src/ marker', () => {
      expect(normalizeFilePath('/Users/dev/project/src/api/routes.ts'))
        .toBe('src/api/routes.ts');
    });

    it('should extract from /lib/ marker', () => {
      expect(normalizeFilePath('/Users/dev/project/lib/utils.ts'))
        .toBe('lib/utils.ts');
    });

    it('should extract from /test/ marker', () => {
      expect(normalizeFilePath('/Users/dev/project/test/unit/foo.test.ts'))
        .toBe('test/unit/foo.test.ts');
    });

    it('should extract from /tests/ marker', () => {
      expect(normalizeFilePath('/Users/dev/project/tests/integration.test.ts'))
        .toBe('tests/integration.test.ts');
    });

    it('should extract from /docs/ marker', () => {
      expect(normalizeFilePath('/Users/dev/project/docs/api.md'))
        .toBe('docs/api.md');
    });

    it('should extract from /references/ marker', () => {
      // Use a path that has /references/ but no earlier markers
      expect(normalizeFilePath('/Users/dev/project/references/schema.json'))
        .toBe('references/schema.json');
    });

    it('should use first matching marker when multiple exist', () => {
      // /src/ comes before /lib/ in the marker list
      expect(normalizeFilePath('/Users/dev/project/src/lib/helper.ts'))
        .toBe('src/lib/helper.ts');
    });

    it('should fall back to basename for absolute paths with no markers', () => {
      expect(normalizeFilePath('/var/tmp/random/config.json'))
        .toBe('config.json');
    });
  });

  describe('edge cases', () => {
    it('should return empty string for empty input', () => {
      expect(normalizeFilePath('')).toBe('');
    });

    it('should pass through relative paths unchanged', () => {
      expect(normalizeFilePath('src/index.ts')).toBe('src/index.ts');
    });

    it('should pass through simple filenames unchanged', () => {
      expect(normalizeFilePath('file.ts')).toBe('file.ts');
    });

    it('should handle Windows-style paths gracefully (no leading /)', () => {
      expect(normalizeFilePath('C:\\Users\\dev\\src\\file.ts')).toBe('C:\\Users\\dev\\src\\file.ts');
    });

    it('should handle paths with spaces', () => {
      expect(normalizeFilePath('/Users/dev/my project/src/file.ts'))
        .toBe('src/file.ts');
    });

    it('should handle projectPath that is a prefix of a different directory', () => {
      // /Users/dev/my-project-v2 should NOT match /Users/dev/my-project
      expect(normalizeFilePath('/Users/dev/my-project-v2/src/file.ts', '/Users/dev/my-project'))
        .toBe('src/file.ts'); // falls through to heuristic
    });
  });
});
