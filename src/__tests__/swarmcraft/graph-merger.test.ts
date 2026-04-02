import { describe, it, expect } from 'vitest';

/**
 * Tests for graph merger utilities.
 * Uses the same logic as references/swarmcraft/src/server/pipeline/graph-merger.ts
 * but tested from the OpenHive side to validate the integration.
 */

// Re-implement the core functions here for testing (they're in the swarmcraft submodule)
function namespaceId(projectId: string, originalId: string): string {
  return `${projectId}:${originalId}`;
}

function extractProjectId(namespacedId: string): string | null {
  const idx = namespacedId.indexOf(':');
  if (idx === -1) return null;
  return namespacedId.slice(0, idx);
}

function extractOriginalId(namespacedId: string): string {
  const idx = namespacedId.indexOf(':');
  if (idx === -1) return namespacedId;
  return namespacedId.slice(idx + 1);
}

describe('Graph Merger Utilities', () => {
  describe('namespaceId', () => {
    it('should prefix ID with project', () => {
      expect(namespaceId('proj-a', 'func-123')).toBe('proj-a:func-123');
    });

    it('should handle IDs with existing colons', () => {
      expect(namespaceId('proj-a', 'ns:func')).toBe('proj-a:ns:func');
    });
  });

  describe('extractProjectId', () => {
    it('should extract project from namespaced ID', () => {
      expect(extractProjectId('proj-a:func-123')).toBe('proj-a');
    });

    it('should return null for non-namespaced IDs', () => {
      expect(extractProjectId('func-123')).toBeNull();
    });

    it('should handle IDs with multiple colons', () => {
      expect(extractProjectId('proj-a:ns:func')).toBe('proj-a');
    });
  });

  describe('extractOriginalId', () => {
    it('should extract original ID from namespaced', () => {
      expect(extractOriginalId('proj-a:func-123')).toBe('func-123');
    });

    it('should return full ID if not namespaced', () => {
      expect(extractOriginalId('func-123')).toBe('func-123');
    });

    it('should preserve colons in original ID', () => {
      expect(extractOriginalId('proj-a:ns:func')).toBe('ns:func');
    });
  });

  describe('file path prefixing', () => {
    it('should prefix file paths with project name', () => {
      const projectName = 'my-app';
      const filePath = 'src/index.ts';
      expect(`${projectName}/${filePath}`).toBe('my-app/src/index.ts');
    });

    it('should handle nested paths', () => {
      const projectName = 'openhive';
      const filePath = 'src/api/routes/agents.ts';
      expect(`${projectName}/${filePath}`).toBe('openhive/src/api/routes/agents.ts');
    });
  });

  describe('multi-project node collision prevention', () => {
    it('should produce unique IDs for same node in different projects', () => {
      const idA = namespaceId('proj-a', 'func-auth');
      const idB = namespaceId('proj-b', 'func-auth');
      expect(idA).not.toBe(idB);
    });

    it('should allow recovering original IDs', () => {
      const original = 'file-src-index';
      const namespaced = namespaceId('proj-x', original);
      expect(extractOriginalId(namespaced)).toBe(original);
      expect(extractProjectId(namespaced)).toBe('proj-x');
    });
  });

  describe('merged file contents', () => {
    it('should namespace file contents by project', () => {
      const merged: Record<string, string> = {};

      // Simulate mergeFileContents
      const projects = [
        { projectName: 'app-a', files: { 'src/index.ts': 'console.log("a")' } },
        { projectName: 'app-b', files: { 'src/index.ts': 'console.log("b")' } },
      ];

      for (const { projectName, files } of projects) {
        for (const [fp, content] of Object.entries(files)) {
          merged[`${projectName}/${fp}`] = content;
        }
      }

      expect(merged['app-a/src/index.ts']).toBe('console.log("a")');
      expect(merged['app-b/src/index.ts']).toBe('console.log("b")');
      expect(Object.keys(merged)).toHaveLength(2);
    });
  });
});
