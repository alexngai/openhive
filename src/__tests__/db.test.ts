import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../db/index.js';
import * as agentsDAL from '../db/dal/agents.js';
import * as postsDAL from '../db/dal/posts.js';
import * as hivesDAL from '../db/dal/hives.js';
import * as votesDAL from '../db/dal/votes.js';
import { testRoot, testDbPath, cleanTestRoot } from './helpers/test-dirs.js';

const TEST_ROOT = testRoot('db');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'test.db');

describe('Database', () => {
  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  describe('Agents', () => {
    let testAgentId: string;

    it('should create an agent', async () => {
      const { agent, apiKey } = await agentsDAL.createAgent({
        name: 'test-agent',
        description: 'A test agent',
      });

      testAgentId = agent.id;
      expect(agent).toBeDefined();
      expect(agent.name).toBe('test-agent');
      expect(agent.description).toBe('A test agent');
      expect(apiKey).toBeDefined();
    });

    it('should find agent by name', () => {
      const agent = agentsDAL.findAgentByName('test-agent');
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('test-agent');
    });

    it('should find agent by ID', () => {
      const agent = agentsDAL.findAgentById(testAgentId);
      expect(agent).toBeDefined();
      expect(agent?.id).toBe(testAgentId);
    });

    it('should list agents', () => {
      const agents = agentsDAL.listAgents({ limit: 10 });
      expect(agents.length).toBeGreaterThan(0);
    });

    it('should update agent', () => {
      const updated = agentsDAL.updateAgent(testAgentId, {
        description: 'Updated description',
      });
      expect(updated?.description).toBe('Updated description');
    });

    it('should update agent karma', () => {
      agentsDAL.updateAgentKarma(testAgentId, 5);
      const agent = agentsDAL.findAgentById(testAgentId);
      expect(agent?.karma).toBe(5);
    });

    it('should not allow duplicate names', async () => {
      await expect(
        agentsDAL.createAgent({
          name: 'test-agent',
          description: 'Duplicate',
        })
      ).rejects.toThrow();
    });
  });

  describe('Hives', () => {
    let testHiveId: string;
    let testAgentId: string;

    beforeAll(async () => {
      const agent = agentsDAL.findAgentByName('test-agent');
      testAgentId = agent!.id;
    });

    it('should create a hive', () => {
      const hive = hivesDAL.createHive({
        name: 'test-hive',
        description: 'A test hive',
        owner_id: testAgentId,
      });

      testHiveId = hive.id;
      expect(hive).toBeDefined();
      expect(hive.name).toBe('test-hive');
    });

    it('should find hive by name', () => {
      const hive = hivesDAL.findHiveByName('test-hive');
      expect(hive).toBeDefined();
      expect(hive?.name).toBe('test-hive');
    });

    it('should find hive by ID', () => {
      const hive = hivesDAL.findHiveById(testHiveId);
      expect(hive).toBeDefined();
      expect(hive?.id).toBe(testHiveId);
    });

    it('should list hives', () => {
      const hives = hivesDAL.listHives({ limit: 10 });
      expect(hives.length).toBeGreaterThan(0);
    });

    it('should auto-add owner as member', () => {
      const isMember = hivesDAL.isHiveMember(testHiveId, testAgentId);
      expect(isMember).toBe(true);
    });

    it('should get membership with owner role', () => {
      const membership = hivesDAL.getHiveMembership(testHiveId, testAgentId);
      expect(membership).toBeDefined();
      expect(membership?.role).toBe('owner');
    });
  });

  describe('Posts', () => {
    let testPostId: string;
    let testAgentId: string;
    let testHiveId: string;

    beforeAll(() => {
      const agent = agentsDAL.findAgentByName('test-agent');
      const hive = hivesDAL.findHiveByName('test-hive');
      testAgentId = agent!.id;
      testHiveId = hive!.id;
    });

    it('should create a post', () => {
      const post = postsDAL.createPost({
        author_id: testAgentId,
        hive_id: testHiveId,
        title: 'Test Post',
        content: 'Hello, this is a test post!',
      });

      testPostId = post.id;
      expect(post).toBeDefined();
      expect(post.title).toBe('Test Post');
      expect(post.content).toBe('Hello, this is a test post!');
    });

    it('should find post by ID', () => {
      const post = postsDAL.findPostById(testPostId);
      expect(post).toBeDefined();
      expect(post?.id).toBe(testPostId);
    });

    it('should list posts', () => {
      const posts = postsDAL.listPosts({ limit: 10 });
      expect(posts.length).toBeGreaterThan(0);
    });

    it('should list posts by hive', () => {
      const posts = postsDAL.listPosts({ hive_id: testHiveId, limit: 10 });
      expect(posts.length).toBeGreaterThan(0);
    });

    it('should list posts by author', () => {
      const posts = postsDAL.listPosts({ author_id: testAgentId, limit: 10 });
      expect(posts.length).toBeGreaterThan(0);
    });

    it('should upvote a post', () => {
      votesDAL.castVote({
        agent_id: testAgentId,
        target_type: 'post',
        target_id: testPostId,
        value: 1,
      });
      const post = postsDAL.findPostById(testPostId);
      expect(post?.score).toBe(1);
    });

    it('should remove vote by clicking same vote again', () => {
      // Clicking upvote again should toggle it off
      votesDAL.castVote({
        agent_id: testAgentId,
        target_type: 'post',
        target_id: testPostId,
        value: 1,
      });
      const post = postsDAL.findPostById(testPostId);
      expect(post?.score).toBe(0);
    });

    it('should downvote a post', () => {
      votesDAL.castVote({
        agent_id: testAgentId,
        target_type: 'post',
        target_id: testPostId,
        value: -1,
      });
      const post = postsDAL.findPostById(testPostId);
      expect(post?.score).toBe(-1);
    });
  });

  describe('Full-text Search', () => {
    beforeAll(() => {
      // Create some searchable content
      const agent = agentsDAL.findAgentByName('test-agent');
      const hive = hivesDAL.findHiveByName('test-hive');

      postsDAL.createPost({
        author_id: agent!.id,
        hive_id: hive!.id,
        title: 'AI Revolution',
        content: 'Artificial intelligence and machine learning are transforming technology',
      });

      postsDAL.createPost({
        author_id: agent!.id,
        hive_id: hive!.id,
        title: 'Deep Learning',
        content: 'Deep learning neural networks can solve complex problems',
      });
    });

    it('should search posts by content', () => {
      const db = getDatabase();
      const results = db.prepare(`
        SELECT p.id, p.content
        FROM posts_fts fts
        JOIN posts p ON fts.rowid = p.rowid
        WHERE posts_fts MATCH ?
        LIMIT 10
      `).all('artificial intelligence') as { id: string; content: string }[];

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('Artificial intelligence');
    });

    it('should search agents by name and description', () => {
      const db = getDatabase();
      const results = db.prepare(`
        SELECT a.id, a.name
        FROM agents_fts fts
        JOIN agents a ON fts.rowid = a.rowid
        WHERE agents_fts MATCH ?
        LIMIT 10
      `).all('test') as { id: string; name: string }[];

      expect(results.length).toBeGreaterThan(0);
    });
  });
});
