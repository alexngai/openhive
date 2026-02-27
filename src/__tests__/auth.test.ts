import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, closeDatabase } from '../db/index.js';
import * as agentsDAL from '../db/dal/agents.js';
import { testRoot, testDbPath, cleanTestRoot } from './helpers/test-dirs.js';

const TEST_ROOT = testRoot('auth');
const TEST_DB_PATH = testDbPath(TEST_ROOT, 'auth-test.db');

describe('Authentication & Verification', () => {
  beforeAll(() => {
    initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDatabase();
    cleanTestRoot(TEST_ROOT);
  });

  describe('API Key Authentication', () => {
    let testAgentId: string;
    let testApiKey: string;

    it('should create agent with API key', async () => {
      const { agent, apiKey } = await agentsDAL.createAgent({
        name: 'api-test-agent',
        description: 'Test agent with API key',
      });

      testAgentId = agent.id;
      testApiKey = apiKey;

      expect(agent).toBeDefined();
      expect(apiKey).toBeDefined();
      expect(apiKey.length).toBeGreaterThan(10);
    });

    it('should find agent by API key', async () => {
      const foundAgent = await agentsDAL.findAgentByApiKey(testApiKey);

      expect(foundAgent).toBeDefined();
      expect(foundAgent?.id).toBe(testAgentId);
    });

    it('should not find agent with invalid API key', async () => {
      const notFound = await agentsDAL.findAgentByApiKey('invalid_key_123');
      expect(notFound).toBeNull();
    });
  });

  describe('Human Account Authentication', () => {
    it('should create human account with email and password', async () => {
      const human = await agentsDAL.createHumanAccount({
        name: 'test-human',
        email: 'test@example.com',
        password: 'SecurePass123!',
      });

      expect(human).toBeDefined();
      expect(human.name).toBe('test-human');
      expect(human.email).toBe('test@example.com');
      expect(human.account_type).toBe('human');
      expect(human.password_hash).toBeDefined();
      // Password should be hashed, not stored in plain text
      expect(human.password_hash).not.toBe('SecurePass123!');
    });

    it('should find human by email', () => {
      const human = agentsDAL.findAgentByEmail('test@example.com');

      expect(human).toBeDefined();
      expect(human?.email).toBe('test@example.com');
    });

    it('should verify correct password', async () => {
      const human = agentsDAL.findAgentByEmail('test@example.com');
      const isValid = await agentsDAL.verifyPassword(human!, 'SecurePass123!');

      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const human = agentsDAL.findAgentByEmail('test@example.com');
      const isValid = await agentsDAL.verifyPassword(human!, 'WrongPassword');

      expect(isValid).toBe(false);
    });

    it('should not allow duplicate emails', async () => {
      await expect(
        agentsDAL.createHumanAccount({
          name: 'another-human',
          email: 'test@example.com', // Same email
          password: 'AnotherPass123!',
        })
      ).rejects.toThrow();
    });

    it('should change password', async () => {
      const human = agentsDAL.findAgentByEmail('test@example.com');
      await agentsDAL.setNewPassword(human!.id, 'NewPassword456!');

      // Re-fetch to get updated password hash from database
      const updatedHuman = agentsDAL.findAgentByEmail('test@example.com');

      // Old password should no longer work
      const oldValid = await agentsDAL.verifyPassword(updatedHuman!, 'SecurePass123!');
      expect(oldValid).toBe(false);

      // New password should work
      const newValid = await agentsDAL.verifyPassword(updatedHuman!, 'NewPassword456!');
      expect(newValid).toBe(true);
    });
  });

  describe('SwarmHub Agent Lookup', () => {
    it('should create and find agent by SwarmHub user ID', async () => {
      const agent = await agentsDAL.findOrCreateSwarmHubAgent({
        swarmhubUserId: 'swarmhub-user-123',
        name: 'swarmhub-test-user',
        email: 'swarmhub@example.com',
        avatarUrl: 'https://example.com/avatar.png',
      });

      expect(agent).toBeDefined();
      expect(agent.name).toBe('swarmhub-test-user');
      expect(agent.account_type).toBe('swarmhub');
      expect(agent.is_verified).toBe(true);

      // Should find existing agent on second call
      const sameAgent = await agentsDAL.findOrCreateSwarmHubAgent({
        swarmhubUserId: 'swarmhub-user-123',
        name: 'swarmhub-test-user',
      });
      expect(sameAgent.id).toBe(agent.id);
    });

    it('should find agent by SwarmHub user ID', () => {
      const agent = agentsDAL.findAgentBySwarmHubUserId('swarmhub-user-123');
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('swarmhub-test-user');
    });

    it('should return null for unknown SwarmHub user ID', () => {
      const agent = agentsDAL.findAgentBySwarmHubUserId('nonexistent');
      expect(agent).toBeNull();
    });
  });
});
