/**
 * Comprehensive tests for resource content routes.
 *
 * Creates fixtures using the ACTUAL minimem and skill-tree packages:
 * - Memory files generated via minimem's serializeFrontmatter() + addFrontmatter()
 * - Skill files generated via skill-tree's FilesystemStorageAdapter.saveSkill()
 * - Cross-validates route responses against the packages' own parsers
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { initDatabase, closeDatabase } from '../../db/index.js';
import * as agentsDAL from '../../db/dal/agents.js';
import * as resourcesDAL from '../../db/dal/syncable-resources.js';
import { resourceContentRoutes } from '../../api/routes/resource-content.js';
import type { Config } from '../../config.js';
import { testRoot, testDbPath, cleanTestRoot, mkTestDir } from '../helpers/test-dirs.js';

// ---------------------------------------------------------------------------
// Imports from the ACTUAL packages (installed as file: deps)
// ---------------------------------------------------------------------------
import {
  serializeFrontmatter,
  parseFrontmatter as minimemParseFrontmatter,
} from 'minimem/session';
import type { MemoryFrontmatter, KnowledgeLink } from 'minimem/session';

import { FilesystemStorageAdapter } from 'skill-tree';
import type { Skill } from 'skill-tree';

// ============================================================================
// Fixture builders that use the actual packages
// ============================================================================

/** Build a minimem knowledge note file using the package's serializer */
function buildMemoryFile(frontmatter: MemoryFrontmatter, body: string): string {
  return serializeFrontmatter(frontmatter) + body;
}

/** Build a minimal Skill object compatible with skill-tree's types */
function buildSkill(overrides: Partial<Skill> & { id: string; name: string }): Skill {
  const now = new Date();
  return {
    version: '1.0.0',
    description: '',
    problem: '',
    triggerConditions: [],
    solution: '',
    verification: '',
    examples: [],
    author: 'test',
    tags: [],
    createdAt: now,
    updatedAt: now,
    status: 'active',
    metrics: { usageCount: 0, successRate: 0, feedbackScores: [] },
    ...overrides,
  };
}

// ============================================================================
// Fixture data (typed through the packages' own types)
// ============================================================================

const OBSERVATION_FM: MemoryFrontmatter = {
  id: 'k-prisma-migration',
  type: 'observation',
  domain: ['database', 'devops'],
  entities: ['prisma', 'postgres'],
  confidence: 0.85,
  source: {
    origin: 'extracted',
    trajectories: ['t-001', 't-002'],
    agentId: 'agent-v1',
  },
  links: [
    { target: 'k-postgres-tips', relation: 'related-to', layer: 'semantic' },
    { target: 'k-schema-design', relation: 'depends-on', layer: 'causal' },
  ],
  created: '2025-01-15T10:00:00Z',
  updated: '2025-01-15T12:00:00Z',
  supersedes: 'k-old-migration',
  tags: ['migration', 'patterns'],
};

const ENTITY_FM: MemoryFrontmatter = {
  id: 'k-postgres-tips',
  type: 'entity',
  domain: ['database'],
  entities: ['postgres'],
  confidence: 0.92,
  source: { origin: 'agent-authored', agentId: 'agent-v2' },
  created: '2025-01-16T08:00:00Z',
  tags: ['database', 'tips'],
};

const DAILY_LOG_FM: MemoryFrontmatter = {
  created: '2025-01-15',
  tags: ['daily', 'log'],
};

const TS_SKILL: Skill = buildSkill({
  id: 'typescript-strict',
  name: 'TypeScript Strict Mode Fixes',
  version: '1.2.0',
  status: 'active',
  description: 'Fix common TypeScript strict mode errors in Node.js projects',
  tags: ['typescript', 'node', 'strict-mode', 'error-fix'],
  author: 'agent-v1',
  problem: 'TypeScript strict mode enables several compiler checks that catch common errors.',
  triggerConditions: [
    { type: 'pattern', value: '"strict": true', description: 'tsconfig has strict mode' },
  ],
  solution: 'Start with strictNullChecks first. Use optional chaining and nullish coalescing.',
  verification: 'Run `npx tsc --noEmit` — zero errors.',
  examples: [
    {
      scenario: 'Optional chaining migration',
      before: 'const name = response.data.user.name;',
      after: "const name = response.data?.user?.name ?? 'Unknown';",
    },
  ],
  notes: 'This skill is especially useful during major TypeScript version upgrades.',
});

const API_SKILL: Skill = buildSkill({
  id: 'api-design',
  name: 'REST API Design Patterns',
  version: '0.1.0',
  status: 'draft',
  description: 'Best practices for designing RESTful APIs',
  tags: ['api', 'rest', 'design'],
  author: 'agent-v2',
  problem: 'Inconsistent API design leads to confusion and integration issues.',
  solution: 'Use nouns for resource URLs, not verbs. Version your API.',
  verification: 'All endpoints follow naming conventions.',
});

const GIT_SKILL: Skill = buildSkill({
  id: 'git-workflow',
  name: 'Git Rebase Workflow',
  version: '0.3.0',
  status: 'experimental',
  description: 'Rebase-based git workflow for clean history',
  tags: ['git', 'workflow', 'rebase'],
  problem: 'Merge commits clutter the git history.',
  triggerConditions: [
    { type: 'context', value: 'feature-branch', description: 'Working on feature branches' },
  ],
  solution: 'Rebase feature branch onto main before merging.',
  verification: 'git log --oneline shows linear history on main.',
});

const DEPRECATED_SKILL: Skill = buildSkill({
  id: 'jquery-dom',
  name: 'jQuery DOM Manipulation',
  version: '2.0.0',
  status: 'deprecated',
  description: 'DOM manipulation patterns using jQuery',
  tags: ['jquery', 'frontend', 'legacy'],
  author: 'agent-v0',
  problem: 'Direct DOM manipulation without a framework is verbose.',
  solution: 'Use jQuery selectors and chaining for DOM operations.',
  notes: 'This skill is kept for reference when maintaining legacy codebases.',
});

// ============================================================================
// Test setup
// ============================================================================

const TEST_ROOT = testRoot('resource-content');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'resource-content-test.db');

function createTestConfig(): Config {
  return {
    port: 3000,
    host: '0.0.0.0',
    database: TEST_DB_PATH,
    instance: { name: 'Test OpenHive', description: 'Test instance', public: true },
    admin: { createOnStartup: false },
    verification: { strategy: 'open', options: {} },
    rateLimit: { enabled: false, max: 100, timeWindow: '1 minute' },
    federation: { enabled: false, peers: [] },
    cors: { enabled: true, origin: true },
    email: { enabled: false, from: 'noreply@test.local' },
    jwt: { secret: 'test-secret-key-for-testing-only', expiresIn: '7d' },
    githubApp: { enabled: false },
  };
}

async function createTestApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('agent', null);
  await app.register(
    async (api) => {
      await api.register(resourceContentRoutes, { config });
    },
    { prefix: '/api/v1' },
  );
  return app;
}

/**
 * Create a memory bank directory using minimem's serializer.
 */
function createMemoryBankFixture(baseDir: string): void {
  fs.mkdirSync(baseDir, { recursive: true });

  const memoryDir = path.join(baseDir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  // MEMORY.md — plain file (no frontmatter)
  fs.writeFileSync(path.join(baseDir, 'MEMORY.md'), '# Project Notes\n\n## Architecture\n\nChose SQLite for simplicity.\n');

  // Knowledge note (observation) — generated by minimem's serializeFrontmatter
  fs.writeFileSync(
    path.join(memoryDir, 'prisma-migration.md'),
    buildMemoryFile(OBSERVATION_FM, '# Prisma Migration Patterns\n\nAlways use `prisma migrate deploy`.\n'),
  );

  // Knowledge note (entity) — generated by minimem's serializeFrontmatter
  fs.writeFileSync(
    path.join(memoryDir, 'postgres-tips.md'),
    buildMemoryFile(ENTITY_FM, '# PostgreSQL Tips\n\nUse PgBouncer for connection pooling.\n'),
  );

  // Daily log — generated by minimem's serializeFrontmatter
  fs.writeFileSync(
    path.join(memoryDir, '2025-01-15.md'),
    buildMemoryFile(DAILY_LOG_FM, '# 2025-01-15\n\n## Completed\n\n- Fixed auth middleware bug\n'),
  );
}

/**
 * Create a skill tree directory using skill-tree's FilesystemStorageAdapter.
 */
async function createSkillTreeFixture(baseDir: string): Promise<void> {
  const adapter = new FilesystemStorageAdapter({ basePath: baseDir });
  await adapter.initialize();
  await adapter.saveSkill(TS_SKILL);
  await adapter.saveSkill(API_SKILL);
  await adapter.saveSkill(GIT_SKILL);
  await adapter.saveSkill(DEPRECATED_SKILL);
}

// ============================================================================
// Tests
// ============================================================================

describe('Resource Content Routes', () => {
  let app: FastifyInstance;
  let config: Config;
  let testAgent: { id: string; apiKey: string };
  let otherAgent: { id: string; apiKey: string };

  let memoryResource: { id: string };
  let skillResource: { id: string };
  let remoteResource: { id: string };

  let memoryDir: string;
  let skillDir: string;

  // References to the skill-tree adapter for cross-validation
  let skillAdapter: FilesystemStorageAdapter;

  beforeAll(async () => {
    initDatabase(TEST_DB_PATH);
    config = createTestConfig();
    app = await createTestApp(config);

    // Create test agents
    const { agent: a1, apiKey: k1 } = await agentsDAL.createAgent({
      name: 'content-test-agent',
      description: 'Test agent for content routes',
    });
    testAgent = { id: a1.id, apiKey: k1 };

    const { agent: a2, apiKey: k2 } = await agentsDAL.createAgent({
      name: 'other-content-agent',
      description: 'Another agent',
    });
    otherAgent = { id: a2.id, apiKey: k2 };

    // Create memory bank fixture using minimem's serializer
    memoryDir = mkTestDir(TEST_ROOT, 'memory-bank');
    createMemoryBankFixture(memoryDir);

    // Create skill tree fixture using skill-tree's adapter
    skillDir = mkTestDir(TEST_ROOT, 'skill-tree');
    await createSkillTreeFixture(skillDir);

    // Keep adapter around for cross-validation reads
    skillAdapter = new FilesystemStorageAdapter({ basePath: skillDir });
    await skillAdapter.initialize();

    // Create syncable resources
    memoryResource = resourcesDAL.createResource({
      resource_type: 'memory_bank',
      name: 'Test Memory Bank',
      description: 'Memory bank for testing',
      git_remote_url: memoryDir,
      visibility: 'private',
      owner_agent_id: testAgent.id,
    });

    skillResource = resourcesDAL.createResource({
      resource_type: 'skill',
      name: 'Test Skill Tree',
      description: 'Skill tree for testing',
      git_remote_url: skillDir,
      visibility: 'private',
      owner_agent_id: testAgent.id,
    });

    remoteResource = resourcesDAL.createResource({
      resource_type: 'memory_bank',
      name: 'Remote Memory',
      git_remote_url: 'https://github.com/example/memories.git',
      visibility: 'public',
      owner_agent_id: testAgent.id,
    });
  });

  afterAll(async () => {
    await app.close();
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  // ========================================================================
  // Memory Bank — List Files
  // ========================================================================

  describe('GET /resources/:id/content/files', () => {
    it('should list all memory files written by minimem serializer', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/files`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.files).toBeInstanceOf(Array);

      // On case-insensitive FS (macOS), memory.md also resolves to MEMORY.md
      expect(body.files.length).toBeGreaterThanOrEqual(4);

      const paths = body.files.map((f: { path: string }) => f.path);
      expect(paths).toContain('MEMORY.md');
      expect(paths).toContain('memory/prisma-migration.md');
      expect(paths).toContain('memory/postgres-tips.md');
      expect(paths).toContain('memory/2025-01-15.md');

      for (const file of body.files) {
        expect(file.size).toBeGreaterThan(0);
        expect(new Date(file.modified).getTime()).not.toBeNaN();
      }
    });

    it('should require authentication', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/files`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for unauthorized agent', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/files`,
        headers: { Authorization: `Bearer ${otherAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('should return 404 for non-existent resource', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/resources/res_nonexistent/content/files',
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('should return 400 for remote resources', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${remoteResource.id}/content/files`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('local filesystem');
    });

    it('should return 400 for non-memory_bank type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${skillResource.id}/content/files`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ========================================================================
  // Memory Bank — Read File + Cross-validate with minimem
  // ========================================================================

  describe('GET /resources/:id/content/file', () => {
    it('should read plain MEMORY.md (no frontmatter)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/file`,
        query: { path: 'MEMORY.md' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.path).toBe('MEMORY.md');
      expect(body.frontmatter).toBeNull();
      expect(body.body).toContain('# Project Notes');
    });

    it('should match minimem parseFrontmatter for observation note', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/file`,
        query: { path: 'memory/prisma-migration.md' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const routeResult = JSON.parse(res.body);

      // Cross-validate: parse the same file with minimem's own parser
      const rawContent = fs.readFileSync(
        path.join(memoryDir, 'memory', 'prisma-migration.md'),
        'utf-8',
      );
      const minimemResult = minimemParseFrontmatter(rawContent);

      // Route should have frontmatter
      expect(routeResult.frontmatter).not.toBeNull();

      // The key knowledge fields should match minimem's parse
      const routeFm = routeResult.frontmatter;
      const mmFm = minimemResult.frontmatter!;

      expect(routeFm.id).toBe(mmFm.id);
      expect(routeFm.type).toBe(mmFm.type);
      expect(routeFm.domain).toEqual(mmFm.domain);
      expect(routeFm.entities).toEqual(mmFm.entities);
      expect(routeFm.confidence).toBe(mmFm.confidence);
      expect(routeFm.source.origin).toBe(mmFm.source!.origin);
      expect(routeFm.source.trajectories).toEqual(mmFm.source!.trajectories);
      expect(routeFm.source.agentId).toBe(mmFm.source!.agentId);
      expect(routeFm.tags).toEqual(mmFm.tags);
      expect(routeFm.supersedes).toBe(mmFm.supersedes);

      // Links structure should match
      expect(routeFm.links).toBeInstanceOf(Array);
      expect(routeFm.links.length).toBe(mmFm.links!.length);
      for (let i = 0; i < routeFm.links.length; i++) {
        expect(routeFm.links[i].target).toBe(mmFm.links![i].target);
        expect(routeFm.links[i].relation).toBe(mmFm.links![i].relation);
        expect(routeFm.links[i].layer).toBe(mmFm.links![i].layer);
      }

      // Bodies should match
      expect(routeResult.body.trim()).toBe(minimemResult.body.trim());
    });

    it('should match minimem parseFrontmatter for entity note', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/file`,
        query: { path: 'memory/postgres-tips.md' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const routeResult = JSON.parse(res.body);
      const rawContent = fs.readFileSync(
        path.join(memoryDir, 'memory', 'postgres-tips.md'),
        'utf-8',
      );
      const minimemResult = minimemParseFrontmatter(rawContent);

      expect(routeResult.frontmatter).not.toBeNull();
      expect(routeResult.frontmatter.id).toBe(minimemResult.frontmatter!.id);
      expect(routeResult.frontmatter.type).toBe(minimemResult.frontmatter!.type);
      expect(routeResult.frontmatter.confidence).toBe(minimemResult.frontmatter!.confidence);
    });

    it('should match minimem parseFrontmatter for daily log', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/file`,
        query: { path: 'memory/2025-01-15.md' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const routeResult = JSON.parse(res.body);
      const rawContent = fs.readFileSync(
        path.join(memoryDir, 'memory', '2025-01-15.md'),
        'utf-8',
      );
      const minimemResult = minimemParseFrontmatter(rawContent);

      expect(routeResult.frontmatter).not.toBeNull();
      expect(routeResult.frontmatter.tags).toEqual(minimemResult.frontmatter!.tags);
      expect(routeResult.body.trim()).toBe(minimemResult.body.trim());
    });

    it('should require path query parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/file`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject path traversal attempts', async () => {
      for (const attempt of ['../etc/passwd', '../../secret.md', '/etc/passwd.md']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/resources/${memoryResource.id}/content/file`,
          query: { path: attempt },
          headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('should reject non-.md file extensions', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/file`,
        query: { path: 'config.json' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should return 404 for non-existent file', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/file`,
        query: { path: 'memory/nonexistent.md' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ========================================================================
  // Memory Bank — Search
  // ========================================================================

  describe('GET /resources/:id/content/search', () => {
    it('should find matches across files written by minimem serializer', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/search`,
        query: { q: 'postgres' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.results.length).toBeGreaterThan(0);

      const matchPaths = body.results.map((r: { path: string }) => r.path);
      expect(matchPaths).toContain('memory/postgres-tips.md');
    });

    it('should return line numbers and context snippets', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/search`,
        query: { q: 'Prisma' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      for (const result of body.results) {
        expect(result.line).toBeGreaterThan(0);
        expect(result.snippet.length).toBeGreaterThan(0);
      }
    });

    it('should be case-insensitive', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/search`,
        query: { q: 'ARCHITECTURE' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      expect(body.results.length).toBeGreaterThan(0);
      expect(body.results.some((r: { path: string }) => r.path === 'MEMORY.md')).toBe(true);
    });

    it('should respect limit parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/search`,
        query: { q: 'the', limit: '2' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      expect(body.results.length).toBeLessThanOrEqual(2);
      expect(body.total).toBeGreaterThanOrEqual(body.results.length);
    });

    it('should return empty for no matches', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/search`,
        query: { q: 'zzz_nonexistent_zzz' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      expect(body.results).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('should require q parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/search`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject empty query', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/search`,
        query: { q: '   ' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ========================================================================
  // Skill Content — List Skills + Cross-validate with skill-tree
  // ========================================================================

  describe('GET /resources/:id/content/skills', () => {
    it('should list skills written by skill-tree adapter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${skillResource.id}/content/skills`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.skills).toBeInstanceOf(Array);
      expect(body.skills.length).toBe(4);

      const ids = body.skills.map((s: { id: string }) => s.id).sort();
      expect(ids).toEqual(['api-design', 'git-workflow', 'jquery-dom', 'typescript-strict']);
    });

    it('should match skill-tree adapter listSkills results', async () => {
      // Read via our route
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${skillResource.id}/content/skills`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      const routeSkills = JSON.parse(res.body).skills as Array<{
        id: string; name: string; version: string; status: string;
        description: string; tags: string[]; author: string;
      }>;

      // Read via skill-tree's own adapter
      const adapterSkills = await skillAdapter.listSkills();

      // Same count
      expect(routeSkills.length).toBe(adapterSkills.length);

      // For each skill, the key fields should match
      for (const adapterSkill of adapterSkills) {
        const routeSkill = routeSkills.find(s => s.id === adapterSkill.id);
        expect(routeSkill).toBeDefined();
        expect(routeSkill!.name).toBe(adapterSkill.name);
        expect(routeSkill!.version).toBe(adapterSkill.version);
        expect(routeSkill!.status).toBe(adapterSkill.status);
        expect(routeSkill!.author).toBe(adapterSkill.author);
      }
    });

    it('should handle all skill statuses', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${skillResource.id}/content/skills`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      const statuses = new Map(body.skills.map((s: { id: string; status: string }) => [s.id, s.status]));
      expect(statuses.get('typescript-strict')).toBe('active');
      expect(statuses.get('api-design')).toBe('draft');
      expect(statuses.get('git-workflow')).toBe('experimental');
      expect(statuses.get('jquery-dom')).toBe('deprecated');
    });

    it('should return 400 for non-skill resource type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/skills`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should return empty for directory with no skills', async () => {
      const emptyDir = mkTestDir(TEST_ROOT, 'empty-skill');
      const r = resourcesDAL.createResource({
        resource_type: 'skill',
        name: 'Empty',
        git_remote_url: emptyDir,
        visibility: 'private',
        owner_agent_id: testAgent.id,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${r.id}/content/skills`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).skills).toEqual([]);
    });
  });

  // ========================================================================
  // Skill Content — Detail + Cross-validate with skill-tree
  // ========================================================================

  describe('GET /resources/:id/content/skills/:skillId', () => {
    it('should return full detail and match skill-tree getSkill', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${skillResource.id}/content/skills/typescript-strict`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const routeDetail = JSON.parse(res.body);

      // Cross-validate with skill-tree's own parser
      const adapterSkill = await skillAdapter.getSkill('typescript-strict');
      expect(adapterSkill).not.toBeNull();

      // Frontmatter fields
      expect(routeDetail.id).toBe(adapterSkill!.id);
      expect(routeDetail.name).toBe(adapterSkill!.name);
      expect(routeDetail.version).toBe(adapterSkill!.version);
      expect(routeDetail.status).toBe(adapterSkill!.status);
      expect(routeDetail.author).toBe(adapterSkill!.author);

      // Section content should be present
      expect(routeDetail.problem).not.toBeNull();
      expect(routeDetail.problem).toContain('strict mode');

      expect(routeDetail.solution).not.toBeNull();
      expect(routeDetail.solution).toContain('strictNullChecks');

      expect(routeDetail.verification).not.toBeNull();
      expect(routeDetail.verification).toContain('npx tsc --noEmit');

      expect(routeDetail.notes).not.toBeNull();
      expect(routeDetail.notes).toContain('TypeScript version upgrades');

      // Raw content should be present
      expect(routeDetail.raw).toContain('---');
    });

    it('should return sections that match skill-tree parsed content', async () => {
      for (const skillId of ['typescript-strict', 'api-design', 'git-workflow', 'jquery-dom']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/resources/${skillResource.id}/content/skills/${skillId}`,
          headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        });

        const routeDetail = JSON.parse(res.body);
        const adapterSkill = await skillAdapter.getSkill(skillId);
        expect(adapterSkill).not.toBeNull();

        // Problem and solution are required in our test skills
        if (adapterSkill!.problem) {
          expect(routeDetail.problem).not.toBeNull();
          // Both should contain the same core content
          // (exact whitespace may differ between parsers)
          expect(routeDetail.problem).toContain(adapterSkill!.problem.slice(0, 20));
        }

        if (adapterSkill!.solution) {
          expect(routeDetail.solution).not.toBeNull();
          expect(routeDetail.solution).toContain(adapterSkill!.solution.slice(0, 20));
        }

        // Notes match when present
        if (adapterSkill!.notes) {
          expect(routeDetail.notes).not.toBeNull();
          expect(routeDetail.notes).toContain(adapterSkill!.notes.slice(0, 20));
        } else {
          expect(routeDetail.notes).toBeNull();
        }
      }
    });

    it('should handle skill with minimal sections', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${skillResource.id}/content/skills/api-design`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      expect(body.name).toBe('REST API Design Patterns');
      expect(body.status).toBe('draft');
      expect(body.problem).not.toBeNull();
      expect(body.solution).not.toBeNull();
      // No trigger conditions, examples, or notes sections in this skill
      // With skill-tree adapter, empty sections return [] not null
      expect(body.triggerConditions).toEqual([]);
      expect(body.examples).toEqual([]);
    });

    it('should return 404 for non-existent skill', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${skillResource.id}/content/skills/nonexistent`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('should reject path traversal in skill ID', async () => {
      for (const attempt of ['../etc', 'foo/bar', 'foo\\bar']) {
        const res = await app.inject({
          method: 'GET',
          url: `/api/v1/resources/${skillResource.id}/content/skills/${encodeURIComponent(attempt)}`,
          headers: { Authorization: `Bearer ${testAgent.apiKey}` },
        });
        expect(res.statusCode).toBe(400);
      }
    });

    it('should return 400 for non-skill resource type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/skills/any`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ========================================================================
  // Edge Cases
  // ========================================================================

  describe('Edge Cases', () => {
    it('should handle empty memory directory', async () => {
      const dir = mkTestDir(TEST_ROOT, 'empty-mem');
      const r = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'Empty',
        git_remote_url: dir,
        visibility: 'private',
        owner_agent_id: testAgent.id,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${r.id}/content/files`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).files).toEqual([]);
    });

    it('should handle malformed frontmatter gracefully', async () => {
      const dir = mkTestDir(TEST_ROOT, 'malformed');
      // Content with no closing --- delimiter — minimem's parser treats this as no frontmatter
      fs.writeFileSync(path.join(dir, 'MEMORY.md'), '---\ninvalid yaml here\n# Content\n');

      const r = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'Malformed',
        git_remote_url: dir,
        visibility: 'private',
        owner_agent_id: testAgent.id,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${r.id}/content/file`,
        query: { path: 'MEMORY.md' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).frontmatter).toBeNull();
    });

    it('should handle frontmatter-only file (empty body)', async () => {
      const dir = mkTestDir(TEST_ROOT, 'fm-only');
      // Use minimem serializer — body will be empty
      const content = serializeFrontmatter({ tags: ['test'] });
      fs.writeFileSync(path.join(dir, 'MEMORY.md'), content);

      const r = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'FM Only',
        git_remote_url: dir,
        visibility: 'private',
        owner_agent_id: testAgent.id,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${r.id}/content/file`,
        query: { path: 'MEMORY.md' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.frontmatter).not.toBeNull();
      expect(body.frontmatter.tags).toEqual(['test']);
      expect(body.body).toBe('');
    });

    it('should handle skill directory without SKILL.md', async () => {
      const dir = mkTestDir(TEST_ROOT, 'no-skillmd');
      const skillsDir = path.join(dir, '.skilltree', 'skills', 'broken');
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.writeFileSync(path.join(skillsDir, 'README.md'), '# Not a skill');

      const r = resourcesDAL.createResource({
        resource_type: 'skill',
        name: 'No SKILL.md',
        git_remote_url: dir,
        visibility: 'private',
        owner_agent_id: testAgent.id,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${r.id}/content/skills`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).skills).toEqual([]);
    });

    it('should handle skill with no frontmatter', async () => {
      const dir = mkTestDir(TEST_ROOT, 'no-fm-skill');
      // Use canonical .skilltree/skills/ location (matches skill-tree discovery)
      const sd = path.join(dir, '.skilltree', 'skills', 'raw');
      fs.mkdirSync(sd, { recursive: true });
      fs.writeFileSync(path.join(sd, 'SKILL.md'), '## Problem\n\nSome problem.\n\n## Solution\n\nSome solution.\n');

      const r = resourcesDAL.createResource({
        resource_type: 'skill',
        name: 'No FM',
        git_remote_url: dir,
        visibility: 'private',
        owner_agent_id: testAgent.id,
      });

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${r.id}/content/skills`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      const skills = JSON.parse(listRes.body).skills;
      expect(skills.length).toBe(1);
      // skill-tree adapter falls back to skill ID when name is missing
      expect(skills[0].name).toBe('raw');
      expect(skills[0].tags).toEqual([]);

      const detailRes = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${r.id}/content/skills/raw`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      const detail = JSON.parse(detailRes.body);
      expect(detail.problem).toContain('Some problem');
      expect(detail.solution).toContain('Some solution');
    });

    it('should handle deleted filesystem path', async () => {
      const dir = mkTestDir(TEST_ROOT, 'deleted');
      fs.writeFileSync(path.join(dir, 'MEMORY.md'), '# Temp');

      const r = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'Deleted',
        git_remote_url: dir,
        visibility: 'private',
        owner_agent_id: testAgent.id,
      });

      fs.rmSync(dir, { recursive: true, force: true });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${r.id}/content/files`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('should handle deeply nested memory files', async () => {
      const dir = mkTestDir(TEST_ROOT, 'nested');
      const deep = path.join(dir, 'memory', 'deep', 'nested');
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, 'note.md'), '# Deep Note\n\nVery deep.');

      const r = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'Nested',
        git_remote_url: dir,
        visibility: 'private',
        owner_agent_id: testAgent.id,
      });

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${r.id}/content/files`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      const paths = JSON.parse(listRes.body).files.map((f: { path: string }) => f.path);
      expect(paths).toContain('memory/deep/nested/note.md');

      const fileRes = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${r.id}/content/file`,
        query: { path: 'memory/deep/nested/note.md' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(fileRes.statusCode).toBe(200);
      expect(JSON.parse(fileRes.body).body).toContain('Very deep');
    });
  });

  // ========================================================================
  // Round-trip Fidelity — Data created by packages, read by routes
  // ========================================================================

  describe('Round-trip Fidelity', () => {
    it('minimem: serializeFrontmatter → route parse → matches original fields', async () => {
      // We wrote the observation note using minimem's serializer (in beforeAll).
      // Read it via the route and verify each field matches the original MemoryFrontmatter.
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${memoryResource.id}/content/file`,
        query: { path: 'memory/prisma-migration.md' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const fm = JSON.parse(res.body).frontmatter;

      expect(fm.id).toBe(OBSERVATION_FM.id);
      expect(fm.type).toBe(OBSERVATION_FM.type);
      expect(fm.domain).toEqual(OBSERVATION_FM.domain);
      expect(fm.entities).toEqual(OBSERVATION_FM.entities);
      expect(fm.confidence).toBe(OBSERVATION_FM.confidence);
      expect(fm.source.origin).toBe(OBSERVATION_FM.source!.origin);
      expect(fm.source.trajectories).toEqual(OBSERVATION_FM.source!.trajectories);
      expect(fm.source.agentId).toBe(OBSERVATION_FM.source!.agentId);
      expect(fm.tags).toEqual(OBSERVATION_FM.tags);
      expect(fm.supersedes).toBe(OBSERVATION_FM.supersedes);

      // Links round-trip
      expect(fm.links.length).toBe(OBSERVATION_FM.links!.length);
      for (let i = 0; i < fm.links.length; i++) {
        expect(fm.links[i].target).toBe(OBSERVATION_FM.links![i].target);
        expect(fm.links[i].relation).toBe(OBSERVATION_FM.links![i].relation);
        expect(fm.links[i].layer).toBe(OBSERVATION_FM.links![i].layer);
      }
    });

    it('skill-tree: saveSkill → route parse → matches original Skill object', async () => {
      // We wrote TS_SKILL using skill-tree's adapter (in beforeAll).
      // Read it via the route and verify key fields match the original Skill object.
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${skillResource.id}/content/skills/typescript-strict`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const detail = JSON.parse(res.body);

      expect(detail.name).toBe(TS_SKILL.name);
      expect(detail.version).toBe(TS_SKILL.version);
      expect(detail.status).toBe(TS_SKILL.status);
      expect(detail.author).toBe(TS_SKILL.author);

      // Route now uses skill-tree's adapter for parsing — fields match the Skill object
      expect(detail.problem).toContain(TS_SKILL.problem.slice(0, 30));
      expect(detail.solution).toContain(TS_SKILL.solution.slice(0, 30));
      expect(detail.verification).toContain(TS_SKILL.verification.slice(0, 30));
      expect(detail.notes).toContain(TS_SKILL.notes!.slice(0, 30));
    });

    it('skill-tree: route list matches adapter list for all skills', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${skillResource.id}/content/skills`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      const routeSkills = JSON.parse(res.body).skills;
      const adapterSkills = await skillAdapter.listSkills();

      // Same IDs
      const routeIds = routeSkills.map((s: { id: string }) => s.id).sort();
      const adapterIds = adapterSkills.map(s => s.id).sort();
      expect(routeIds).toEqual(adapterIds);

      // Each skill's core fields match
      for (const original of [TS_SKILL, API_SKILL, GIT_SKILL, DEPRECATED_SKILL]) {
        const fromRoute = routeSkills.find((s: { id: string }) => s.id === original.id);
        expect(fromRoute).toBeDefined();
        expect(fromRoute.name).toBe(original.name);
        expect(fromRoute.version).toBe(original.version);
        expect(fromRoute.status).toBe(original.status);
      }
    });
  });

  // ========================================================================
  // Cognitive-Core Knowledge Structure
  // ========================================================================

  describe('Cognitive-Core Knowledge Directory Structure', () => {
    let knowledgeResource: { id: string };
    let knowledgeDir: string;

    // Fixture frontmatter for cognitive-core notes
    const OBS_1_FM: MemoryFrontmatter = {
      id: 'k-ts-strict-001',
      type: 'observation',
      domain: ['typescript', 'tooling'],
      entities: ['tsc', 'tsconfig'],
      confidence: 0.65,
      source: {
        origin: 'extracted',
        trajectories: ['traj-100'],
        agentId: 'atlas-v1',
      },
      links: [
        { target: 'k-ts-strict-002', relation: 'related-to', layer: 'semantic' },
        { target: 'typescript', relation: 'depends-on', layer: 'entity' },
      ],
      created: '2025-06-01T10:00:00Z',
      updated: '2025-06-01T10:00:00Z',
      tags: ['error-pattern'],
    };

    const OBS_2_FM: MemoryFrontmatter = {
      id: 'k-ts-strict-002',
      type: 'observation',
      domain: ['typescript'],
      entities: ['tsc'],
      confidence: 0.45,
      source: { origin: 'extracted', trajectories: ['traj-101'] },
      links: [
        { target: 'k-ts-strict-001', relation: 'related-to', layer: 'semantic' },
      ],
      created: '2025-06-02T10:00:00Z',
      tags: ['config'],
    };

    const ENTITY_TS_FM: MemoryFrontmatter = {
      id: 'typescript',
      type: 'entity',
      domain: ['typescript', 'tooling'],
      entities: ['typescript'],
      confidence: 0.92,
      source: { origin: 'agent-authored', agentId: 'atlas-v1' },
      links: [],
      created: '2025-06-01T08:00:00Z',
      tags: ['language'],
    };

    const DOMAIN_FM: MemoryFrontmatter = {
      id: 'domain-typescript',
      type: 'domain-summary',
      domain: ['typescript'],
      confidence: 1.0,
      source: { origin: 'agent-authored', agentId: 'atlas-v1' },
      created: '2025-06-01T12:00:00Z',
      tags: ['summary'],
    };

    const STALE_OBS_FM: MemoryFrontmatter = {
      id: 'k-stale-001',
      type: 'observation',
      domain: ['database'],
      entities: ['mysql'],
      confidence: 0.15,
      source: { origin: 'extracted' },
      created: '2024-01-01T00:00:00Z',
      tags: ['stale'],
    };

    beforeAll(async () => {
      // Create the cognitive-core directory structure:
      // memory/knowledge/observations/
      // memory/knowledge/entities/
      // memory/knowledge/domains/
      knowledgeDir = mkTestDir(TEST_ROOT, 'cognitive-core-bank');

      const obsDir = path.join(knowledgeDir, 'memory', 'knowledge', 'observations');
      const entDir = path.join(knowledgeDir, 'memory', 'knowledge', 'entities');
      const domDir = path.join(knowledgeDir, 'memory', 'knowledge', 'domains');
      fs.mkdirSync(obsDir, { recursive: true });
      fs.mkdirSync(entDir, { recursive: true });
      fs.mkdirSync(domDir, { recursive: true });

      // Write knowledge notes using minimem serializer
      fs.writeFileSync(
        path.join(obsDir, 'k-ts-strict-001.md'),
        buildMemoryFile(OBS_1_FM, '# Strict Mode Null Check Issue\n\nWhen strict mode is enabled, tsc requires explicit null checks.\n'),
      );

      fs.writeFileSync(
        path.join(obsDir, 'k-ts-strict-002.md'),
        buildMemoryFile(OBS_2_FM, '# TSConfig Strict Flags\n\nEnable strictNullChecks and noImplicitAny separately.\n'),
      );

      fs.writeFileSync(
        path.join(obsDir, 'k-stale-001.md'),
        buildMemoryFile(STALE_OBS_FM, '# MySQL Timeout Config\n\nOld observation about MySQL wait_timeout.\n'),
      );

      fs.writeFileSync(
        path.join(entDir, 'typescript.md'),
        buildMemoryFile(ENTITY_TS_FM, '# TypeScript\n\nA strongly-typed superset of JavaScript.\n\n## Known Patterns\n\n- Use strict mode.\n'),
      );

      fs.writeFileSync(
        path.join(domDir, 'typescript.md'),
        buildMemoryFile(DOMAIN_FM, '# TypeScript Domain Summary\n\n3 observations, 1 entity.\n'),
      );

      // Also put a regular MEMORY.md at root
      fs.writeFileSync(path.join(knowledgeDir, 'MEMORY.md'), '# Project Memory\n\nNon-knowledge note.\n');

      knowledgeResource = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'Cognitive Core Bank',
        description: 'Memory bank with cognitive-core knowledge structure',
        git_remote_url: knowledgeDir,
        visibility: 'private',
        owner_agent_id: testAgent.id,
      });
    });

    it('should discover all files in cognitive-core directory structure', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/files`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const paths = JSON.parse(res.body).files.map((f: { path: string }) => f.path);

      expect(paths).toContain('MEMORY.md');
      expect(paths).toContain('memory/knowledge/observations/k-ts-strict-001.md');
      expect(paths).toContain('memory/knowledge/observations/k-ts-strict-002.md');
      expect(paths).toContain('memory/knowledge/observations/k-stale-001.md');
      expect(paths).toContain('memory/knowledge/entities/typescript.md');
      expect(paths).toContain('memory/knowledge/domains/typescript.md');
    });

    it('should read deeply nested observation with full knowledge frontmatter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/file`,
        query: { path: 'memory/knowledge/observations/k-ts-strict-001.md' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // Full knowledge frontmatter preserved
      expect(body.frontmatter.id).toBe('k-ts-strict-001');
      expect(body.frontmatter.type).toBe('observation');
      expect(body.frontmatter.domain).toEqual(['typescript', 'tooling']);
      expect(body.frontmatter.entities).toEqual(['tsc', 'tsconfig']);
      expect(body.frontmatter.confidence).toBe(0.65);
      expect(body.frontmatter.source.origin).toBe('extracted');
      expect(body.frontmatter.source.trajectories).toEqual(['traj-100']);
      expect(body.frontmatter.source.agentId).toBe('atlas-v1');
      expect(body.frontmatter.links).toHaveLength(2);
      expect(body.frontmatter.links[0].target).toBe('k-ts-strict-002');
      expect(body.frontmatter.links[0].relation).toBe('related-to');
      expect(body.frontmatter.links[0].layer).toBe('semantic');
      expect(body.body).toContain('tsc requires explicit null checks');
    });

    it('should read entity note from entities/ subdirectory', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/file`,
        query: { path: 'memory/knowledge/entities/typescript.md' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      expect(body.frontmatter.id).toBe('typescript');
      expect(body.frontmatter.type).toBe('entity');
      expect(body.frontmatter.confidence).toBe(0.92);
      expect(body.body).toContain('strongly-typed superset');
    });

    it('should read domain-summary from domains/ subdirectory', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/file`,
        query: { path: 'memory/knowledge/domains/typescript.md' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      expect(body.frontmatter.id).toBe('domain-typescript');
      expect(body.frontmatter.type).toBe('domain-summary');
      expect(body.frontmatter.confidence).toBe(1.0);
    });

    it('should search across knowledge notes in nested directories', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/search`,
        query: { q: 'strict' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      const matchPaths = body.results.map((r: { path: string }) => r.path);
      expect(matchPaths).toContain('memory/knowledge/observations/k-ts-strict-001.md');
    });
  });

  // ========================================================================
  // Knowledge Search Endpoint
  // ========================================================================

  describe('GET /resources/:id/content/knowledge', () => {
    let knowledgeResource: { id: string };
    let knowledgeDir: string;

    beforeAll(async () => {
      // Reuse a knowledge bank structure
      knowledgeDir = mkTestDir(TEST_ROOT, 'knowledge-search-bank');
      const obsDir = path.join(knowledgeDir, 'memory', 'knowledge', 'observations');
      const entDir = path.join(knowledgeDir, 'memory', 'knowledge', 'entities');
      fs.mkdirSync(obsDir, { recursive: true });
      fs.mkdirSync(entDir, { recursive: true });

      // Observations
      fs.writeFileSync(
        path.join(obsDir, 'obs-db-001.md'),
        buildMemoryFile({
          id: 'k-db-001', type: 'observation',
          domain: ['database'], entities: ['prisma', 'postgres'],
          confidence: 0.8, source: { origin: 'extracted' },
          links: [{ target: 'k-db-002', relation: 'related-to' }],
        }, '# Prisma Migration Tip\n\nUse prisma migrate deploy in production.\n'),
      );

      fs.writeFileSync(
        path.join(obsDir, 'obs-db-002.md'),
        buildMemoryFile({
          id: 'k-db-002', type: 'observation',
          domain: ['database'], entities: ['postgres'],
          confidence: 0.6, source: { origin: 'extracted' },
          links: [{ target: 'k-db-001', relation: 'related-to' }],
        }, '# Postgres Connection Pooling\n\nUse PgBouncer for connection pooling.\n'),
      );

      fs.writeFileSync(
        path.join(obsDir, 'obs-ts-001.md'),
        buildMemoryFile({
          id: 'k-ts-001', type: 'observation',
          domain: ['typescript'], entities: ['tsc'],
          confidence: 0.9, source: { origin: 'extracted' },
        }, '# TS Strict Mode\n\nEnable strict mode in tsconfig.\n'),
      );

      // Entity
      fs.writeFileSync(
        path.join(entDir, 'postgres.md'),
        buildMemoryFile({
          id: 'postgres-entity', type: 'entity',
          domain: ['database'], entities: ['postgres'],
          confidence: 0.95, source: { origin: 'agent-authored' },
        }, '# PostgreSQL\n\nA powerful relational database.\n'),
      );

      // Non-knowledge file
      fs.writeFileSync(path.join(knowledgeDir, 'MEMORY.md'), '# Notes\n\nPlain memory note.\n');

      knowledgeResource = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'Knowledge Search Bank',
        git_remote_url: knowledgeDir,
        visibility: 'private',
        owner_agent_id: testAgent.id,
      });
    });

    it('should return all knowledge notes without filters', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Should include all files (knowledge notes + MEMORY.md)
      expect(body.total).toBeGreaterThanOrEqual(5);
    });

    it('should filter by knowledge type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge`,
        query: { type: 'observation' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      expect(body.total).toBe(3);
      for (const result of body.results) {
        expect(result.knowledge_type).toBe('observation');
      }
    });

    it('should filter by entity type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge`,
        query: { type: 'entity' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      expect(body.total).toBe(1);
      expect(body.results[0].knowledge_type).toBe('entity');
    });

    it('should filter by domain', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge`,
        query: { domain: 'typescript' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      expect(body.total).toBe(1);
      expect(body.results[0].frontmatter.id).toBe('k-ts-001');
    });

    it('should filter by entity', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge`,
        query: { entity: 'prisma' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      expect(body.total).toBe(1);
      expect(body.results[0].frontmatter.id).toBe('k-db-001');
    });

    it('should filter by minimum confidence', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge`,
        query: { min_confidence: '0.85' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      // Should include obs-ts-001 (0.9) and postgres entity (0.95)
      expect(body.total).toBe(2);
      for (const result of body.results) {
        expect(result.frontmatter.confidence).toBeGreaterThanOrEqual(0.85);
      }
    });

    it('should combine knowledge filters with text query', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge`,
        query: { domain: 'database', q: 'pooling' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      expect(body.total).toBe(1);
      expect(body.results[0].frontmatter.id).toBe('k-db-002');
    });

    it('should sort results by confidence descending', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge`,
        query: { domain: 'database' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      expect(body.total).toBeGreaterThanOrEqual(2);
      // Check descending order
      for (let i = 1; i < body.results.length; i++) {
        const prevConf = body.results[i - 1].frontmatter?.confidence ?? -1;
        const currConf = body.results[i].frontmatter?.confidence ?? -1;
        expect(prevConf).toBeGreaterThanOrEqual(currConf);
      }
    });

    it('should include frontmatter and snippet in results', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge`,
        query: { type: 'entity' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      expect(body.results[0].frontmatter).not.toBeNull();
      expect(body.results[0].frontmatter.id).toBeDefined();
      expect(body.results[0].snippet.length).toBeGreaterThan(0);
      expect(body.results[0].path).toBeDefined();
    });

    it('should return 400 for non-memory_bank resource', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${skillResource.id}/content/knowledge`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ========================================================================
  // Knowledge Graph Endpoint
  // ========================================================================

  describe('GET /resources/:id/content/knowledge/graph', () => {
    let knowledgeResource: { id: string };
    let knowledgeDir: string;

    beforeAll(async () => {
      knowledgeDir = mkTestDir(TEST_ROOT, 'knowledge-graph-bank');
      const obsDir = path.join(knowledgeDir, 'memory', 'knowledge', 'observations');
      const entDir = path.join(knowledgeDir, 'memory', 'knowledge', 'entities');
      fs.mkdirSync(obsDir, { recursive: true });
      fs.mkdirSync(entDir, { recursive: true });

      // A -> B (related-to), A -> C (depends-on), B -> C (supports)
      fs.writeFileSync(
        path.join(obsDir, 'node-a.md'),
        buildMemoryFile({
          id: 'node-a', type: 'observation',
          domain: ['test'], confidence: 0.8,
          links: [
            { target: 'node-b', relation: 'related-to', layer: 'semantic' },
            { target: 'node-c', relation: 'depends-on', layer: 'causal' },
          ],
        }, '# Node A\n\nRoot observation.\n'),
      );

      fs.writeFileSync(
        path.join(obsDir, 'node-b.md'),
        buildMemoryFile({
          id: 'node-b', type: 'observation',
          domain: ['test'], confidence: 0.6,
          links: [
            { target: 'node-c', relation: 'supports', layer: 'semantic' },
          ],
        }, '# Node B\n\nRelated to A.\n'),
      );

      fs.writeFileSync(
        path.join(entDir, 'node-c.md'),
        buildMemoryFile({
          id: 'node-c', type: 'entity',
          domain: ['test'], confidence: 0.9,
          links: [],
        }, '# Node C\n\nTarget entity.\n'),
      );

      knowledgeResource = resourcesDAL.createResource({
        resource_type: 'memory_bank',
        name: 'Knowledge Graph Bank',
        git_remote_url: knowledgeDir,
        visibility: 'private',
        owner_agent_id: testAgent.id,
      });
    });

    it('should traverse outgoing links from a node', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge/graph`,
        query: { note_id: 'node-a', direction: 'outgoing' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.root).toBe('node-a');
      expect(body.edges.length).toBe(2);
      expect(body.edges.some((e: { to: string }) => e.to === 'node-b')).toBe(true);
      expect(body.edges.some((e: { to: string }) => e.to === 'node-c')).toBe(true);

      // Nodes include root + targets
      const nodeIds = body.nodes.map((n: { id: string }) => n.id);
      expect(nodeIds).toContain('node-a');
      expect(nodeIds).toContain('node-b');
      expect(nodeIds).toContain('node-c');
    });

    it('should traverse incoming links to a node', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge/graph`,
        query: { note_id: 'node-c', direction: 'incoming' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      // node-c has incoming from node-a (depends-on) and node-b (supports)
      expect(body.edges.length).toBe(2);
      expect(body.edges.every((e: { to: string }) => e.to === 'node-c')).toBe(true);
    });

    it('should filter edges by relation type', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge/graph`,
        query: { note_id: 'node-a', relation: 'depends-on' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      expect(body.edges.length).toBe(1);
      expect(body.edges[0].to).toBe('node-c');
      expect(body.edges[0].relation).toBe('depends-on');
    });

    it('should traverse multiple hops with depth parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge/graph`,
        query: { note_id: 'node-a', depth: '2', direction: 'outgoing' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      // Depth 1: A->B, A->C. Depth 2: B->C (already visited but edge still emitted)
      expect(body.edges.length).toBe(3);
    });

    it('should include node metadata', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge/graph`,
        query: { note_id: 'node-a' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      const body = JSON.parse(res.body);
      const nodeA = body.nodes.find((n: { id: string }) => n.id === 'node-a');
      expect(nodeA).toBeDefined();
      expect(nodeA.path).toContain('observations/node-a.md');
      expect(nodeA.type).toBe('observation');
      expect(nodeA.confidence).toBe(0.8);
    });

    it('should require note_id parameter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge/graph`,
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should handle unknown note_id gracefully', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${knowledgeResource.id}/content/knowledge/graph`,
        query: { note_id: 'nonexistent-node' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.edges).toEqual([]);
      expect(body.nodes.length).toBe(1); // Just the root (no file found)
    });

    it('should return 400 for non-memory_bank resource', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/resources/${skillResource.id}/content/knowledge/graph`,
        query: { note_id: 'any' },
        headers: { Authorization: `Bearer ${testAgent.apiKey}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
