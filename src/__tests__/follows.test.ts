import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '../db/index.js';
import * as agentsDAL from '../db/dal/agents.js';
import * as followsDAL from '../db/dal/follows.js';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB_PATH = './test-data/follows-test.db';

describe('Follows DAL', () => {
  let agent1Id: string;
  let agent2Id: string;
  let agent3Id: string;

  beforeAll(async () => {
    // Clean up any existing test database
    const dir = path.dirname(TEST_DB_PATH);
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    initDatabase(TEST_DB_PATH);

    // Create test agents
    const { agent: agent1 } = await agentsDAL.createAgent({
      name: 'follow-test-agent-1',
      description: 'Test agent 1 for follows',
    });
    agent1Id = agent1.id;

    const { agent: agent2 } = await agentsDAL.createAgent({
      name: 'follow-test-agent-2',
      description: 'Test agent 2 for follows',
    });
    agent2Id = agent2.id;

    const { agent: agent3 } = await agentsDAL.createAgent({
      name: 'follow-test-agent-3',
      description: 'Test agent 3 for follows',
    });
    agent3Id = agent3.id;
  });

  afterAll(() => {
    closeDatabase();
    // Clean up test database
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  describe('followAgent', () => {
    beforeEach(() => {
      // Clean up follows before each test
      const db = getDatabase();
      db.prepare('DELETE FROM follows').run();
    });

    it('should create a follow relationship', () => {
      const follow = followsDAL.followAgent(agent1Id, agent2Id);

      expect(follow).not.toBeNull();
      expect(follow?.follower_id).toBe(agent1Id);
      expect(follow?.following_id).toBe(agent2Id);
      expect(follow?.created_at).toBeDefined();
    });

    it('should return null when trying to follow yourself', () => {
      const follow = followsDAL.followAgent(agent1Id, agent1Id);

      expect(follow).toBeNull();
    });

    it('should return null when already following (duplicate)', () => {
      // First follow should succeed
      const follow1 = followsDAL.followAgent(agent1Id, agent2Id);
      expect(follow1).not.toBeNull();

      // Second follow should return null (already following)
      const follow2 = followsDAL.followAgent(agent1Id, agent2Id);
      expect(follow2).toBeNull();
    });

    it('should allow mutual follows (A follows B and B follows A)', () => {
      const follow1 = followsDAL.followAgent(agent1Id, agent2Id);
      const follow2 = followsDAL.followAgent(agent2Id, agent1Id);

      expect(follow1).not.toBeNull();
      expect(follow2).not.toBeNull();
    });
  });

  describe('unfollowAgent', () => {
    beforeEach(() => {
      // Clean up follows and set up initial state
      const db = getDatabase();
      db.prepare('DELETE FROM follows').run();
    });

    it('should remove a follow relationship', () => {
      // Set up: create follow
      followsDAL.followAgent(agent1Id, agent2Id);
      expect(followsDAL.isFollowing(agent1Id, agent2Id)).toBe(true);

      // Act: unfollow
      const result = followsDAL.unfollowAgent(agent1Id, agent2Id);

      // Assert
      expect(result).toBe(true);
      expect(followsDAL.isFollowing(agent1Id, agent2Id)).toBe(false);
    });

    it('should return false when not following', () => {
      const result = followsDAL.unfollowAgent(agent1Id, agent2Id);

      expect(result).toBe(false);
    });

    it('should not affect other follow relationships', () => {
      // Set up: agent1 follows both agent2 and agent3
      followsDAL.followAgent(agent1Id, agent2Id);
      followsDAL.followAgent(agent1Id, agent3Id);

      // Act: unfollow only agent2
      followsDAL.unfollowAgent(agent1Id, agent2Id);

      // Assert: agent1 should still follow agent3
      expect(followsDAL.isFollowing(agent1Id, agent2Id)).toBe(false);
      expect(followsDAL.isFollowing(agent1Id, agent3Id)).toBe(true);
    });
  });

  describe('isFollowing', () => {
    beforeEach(() => {
      const db = getDatabase();
      db.prepare('DELETE FROM follows').run();
    });

    it('should return true when following', () => {
      followsDAL.followAgent(agent1Id, agent2Id);

      expect(followsDAL.isFollowing(agent1Id, agent2Id)).toBe(true);
    });

    it('should return false when not following', () => {
      expect(followsDAL.isFollowing(agent1Id, agent2Id)).toBe(false);
    });

    it('should correctly distinguish direction (A follows B is not B follows A)', () => {
      followsDAL.followAgent(agent1Id, agent2Id);

      expect(followsDAL.isFollowing(agent1Id, agent2Id)).toBe(true);
      expect(followsDAL.isFollowing(agent2Id, agent1Id)).toBe(false);
    });
  });

  describe('getFollowers', () => {
    beforeEach(() => {
      const db = getDatabase();
      db.prepare('DELETE FROM follows').run();
    });

    it('should return list of followers', () => {
      // Set up: agent2 and agent3 follow agent1
      followsDAL.followAgent(agent2Id, agent1Id);
      followsDAL.followAgent(agent3Id, agent1Id);

      const followers = followsDAL.getFollowers(agent1Id);

      expect(followers.length).toBe(2);
      const followerIds = followers.map((f) => f.id);
      expect(followerIds).toContain(agent2Id);
      expect(followerIds).toContain(agent3Id);
    });

    it('should return empty array when no followers', () => {
      const followers = followsDAL.getFollowers(agent1Id);

      expect(followers).toEqual([]);
    });

    it('should respect pagination limit', () => {
      // Set up: multiple followers
      followsDAL.followAgent(agent2Id, agent1Id);
      followsDAL.followAgent(agent3Id, agent1Id);

      const followers = followsDAL.getFollowers(agent1Id, 1);

      expect(followers.length).toBe(1);
    });

    it('should respect pagination offset', () => {
      // Set up: multiple followers
      followsDAL.followAgent(agent2Id, agent1Id);
      followsDAL.followAgent(agent3Id, agent1Id);

      const allFollowers = followsDAL.getFollowers(agent1Id);
      const offsetFollowers = followsDAL.getFollowers(agent1Id, 50, 1);

      expect(offsetFollowers.length).toBe(1);
      expect(offsetFollowers[0].id).toBe(allFollowers[1].id);
    });
  });

  describe('getFollowing', () => {
    beforeEach(() => {
      const db = getDatabase();
      db.prepare('DELETE FROM follows').run();
    });

    it('should return list of agents being followed', () => {
      // Set up: agent1 follows agent2 and agent3
      followsDAL.followAgent(agent1Id, agent2Id);
      followsDAL.followAgent(agent1Id, agent3Id);

      const following = followsDAL.getFollowing(agent1Id);

      expect(following.length).toBe(2);
      const followingIds = following.map((f) => f.id);
      expect(followingIds).toContain(agent2Id);
      expect(followingIds).toContain(agent3Id);
    });

    it('should return empty array when not following anyone', () => {
      const following = followsDAL.getFollowing(agent1Id);

      expect(following).toEqual([]);
    });

    it('should respect pagination limit', () => {
      followsDAL.followAgent(agent1Id, agent2Id);
      followsDAL.followAgent(agent1Id, agent3Id);

      const following = followsDAL.getFollowing(agent1Id, 1);

      expect(following.length).toBe(1);
    });
  });

  describe('getFollowerCount', () => {
    beforeEach(() => {
      const db = getDatabase();
      db.prepare('DELETE FROM follows').run();
    });

    it('should return correct follower count', () => {
      followsDAL.followAgent(agent2Id, agent1Id);
      followsDAL.followAgent(agent3Id, agent1Id);

      const count = followsDAL.getFollowerCount(agent1Id);

      expect(count).toBe(2);
    });

    it('should return 0 when no followers', () => {
      const count = followsDAL.getFollowerCount(agent1Id);

      expect(count).toBe(0);
    });

    it('should update correctly after unfollow', () => {
      followsDAL.followAgent(agent2Id, agent1Id);
      followsDAL.followAgent(agent3Id, agent1Id);
      expect(followsDAL.getFollowerCount(agent1Id)).toBe(2);

      followsDAL.unfollowAgent(agent2Id, agent1Id);
      expect(followsDAL.getFollowerCount(agent1Id)).toBe(1);
    });
  });

  describe('getFollowingCount', () => {
    beforeEach(() => {
      const db = getDatabase();
      db.prepare('DELETE FROM follows').run();
    });

    it('should return correct following count', () => {
      followsDAL.followAgent(agent1Id, agent2Id);
      followsDAL.followAgent(agent1Id, agent3Id);

      const count = followsDAL.getFollowingCount(agent1Id);

      expect(count).toBe(2);
    });

    it('should return 0 when not following anyone', () => {
      const count = followsDAL.getFollowingCount(agent1Id);

      expect(count).toBe(0);
    });

    it('should update correctly after unfollow', () => {
      followsDAL.followAgent(agent1Id, agent2Id);
      followsDAL.followAgent(agent1Id, agent3Id);
      expect(followsDAL.getFollowingCount(agent1Id)).toBe(2);

      followsDAL.unfollowAgent(agent1Id, agent2Id);
      expect(followsDAL.getFollowingCount(agent1Id)).toBe(1);
    });
  });

  describe('Integration: Social Graph', () => {
    beforeEach(() => {
      const db = getDatabase();
      db.prepare('DELETE FROM follows').run();
    });

    it('should correctly model a small social network', () => {
      // Create a social graph:
      // agent1 -> follows -> agent2, agent3
      // agent2 -> follows -> agent3
      // agent3 -> follows -> agent1

      followsDAL.followAgent(agent1Id, agent2Id);
      followsDAL.followAgent(agent1Id, agent3Id);
      followsDAL.followAgent(agent2Id, agent3Id);
      followsDAL.followAgent(agent3Id, agent1Id);

      // Agent1: follows 2, followed by 1 (agent3)
      expect(followsDAL.getFollowingCount(agent1Id)).toBe(2);
      expect(followsDAL.getFollowerCount(agent1Id)).toBe(1);

      // Agent2: follows 1, followed by 1 (agent1)
      expect(followsDAL.getFollowingCount(agent2Id)).toBe(1);
      expect(followsDAL.getFollowerCount(agent2Id)).toBe(1);

      // Agent3: follows 1, followed by 2 (agent1, agent2)
      expect(followsDAL.getFollowingCount(agent3Id)).toBe(1);
      expect(followsDAL.getFollowerCount(agent3Id)).toBe(2);

      // Check specific relationships
      expect(followsDAL.isFollowing(agent1Id, agent2Id)).toBe(true);
      expect(followsDAL.isFollowing(agent2Id, agent1Id)).toBe(false);
      expect(followsDAL.isFollowing(agent3Id, agent1Id)).toBe(true);
    });
  });
});
