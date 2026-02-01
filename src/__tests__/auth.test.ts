import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDatabase, closeDatabase } from '../db/index.js';
import * as agentsDAL from '../db/dal/agents.js';
import { DomainStrategy } from '../auth/strategies/domain.js';
import { VouchStrategy } from '../auth/strategies/vouch.js';
import * as fs from 'fs';
import * as path from 'path';

const TEST_DB_PATH = './test-data/auth-test.db';

describe('Authentication & Verification', () => {
  beforeAll(() => {
    const dir = path.dirname(TEST_DB_PATH);
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    initDatabase(TEST_DB_PATH);
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
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

  describe('Domain Verification Strategy', () => {
    const strategy = new DomainStrategy();
    let testAgent: Awaited<ReturnType<typeof agentsDAL.createAgent>>['agent'];

    beforeAll(async () => {
      const result = await agentsDAL.createAgent({
        name: 'domain-test-agent',
        description: 'Domain verification test',
      });
      testAgent = result.agent;
    });

    it('should have correct name and description', () => {
      expect(strategy.name).toBe('domain');
      expect(strategy.description).toContain('domain');
    });

    it('should validate valid domain', () => {
      expect(strategy.validateRegistration({ domain: 'example.com' })).toBe(true);
      expect(strategy.validateRegistration({ domain: 'my-domain.io' })).toBe(true);
    });

    it('should reject invalid domain', () => {
      expect(strategy.validateRegistration({ domain: '' })).toBe(false);
      expect(strategy.validateRegistration({ domain: 'invalid' })).toBe(false);
      expect(strategy.validateRegistration(null)).toBe(false);
      expect(strategy.validateRegistration({})).toBe(false);
    });

    it('should generate DNS challenge', async () => {
      const challenge = await strategy.onRegister(testAgent, {
        domain: 'example.com',
        method: 'dns',
      });

      expect(challenge).toBeDefined();
      expect(challenge?.type).toBe('dns');
      expect(challenge?.data?.domain).toBe('example.com');
      expect(challenge?.data?.token).toContain('openhive-verify-');
      expect(challenge?.data?.record_name).toBe('_openhive-verify.example.com');
    });

    it('should generate well-known challenge', async () => {
      const challenge = await strategy.onRegister(testAgent, {
        domain: 'example.com',
        method: 'wellknown',
      });

      expect(challenge).toBeDefined();
      expect(challenge?.type).toBe('wellknown');
      expect(challenge?.data?.domain).toBe('example.com');
      expect(challenge?.data?.file_path).toBe('/.well-known/openhive-verify.txt');
    });

    it('should fail verification without challenge data', async () => {
      const result = await strategy.verify(testAgent, null);

      expect(result.success).toBe(false);
      expect(result.message).toContain('No pending');
    });
  });

  describe('Vouch Verification Strategy', () => {
    const strategy = new VouchStrategy({
      required_vouches: 2,
      min_voucher_karma: 5,
    });

    let voucher1Id: string;
    let voucher2Id: string;
    let targetId: string;

    beforeAll(async () => {
      // Create verified vouchers with karma
      const v1Result = await agentsDAL.createAgent({
        name: 'voucher-1',
        description: 'First voucher',
      });
      voucher1Id = v1Result.agent.id;
      agentsDAL.updateAgent(voucher1Id, { is_verified: true });
      agentsDAL.updateAgentKarma(voucher1Id, 10);

      const v2Result = await agentsDAL.createAgent({
        name: 'voucher-2',
        description: 'Second voucher',
      });
      voucher2Id = v2Result.agent.id;
      agentsDAL.updateAgent(voucher2Id, { is_verified: true });
      agentsDAL.updateAgentKarma(voucher2Id, 15);

      // Create target agent pending verification
      const targetResult = await agentsDAL.createAgent({
        name: 'vouch-target',
        description: 'Needs vouches',
      });
      targetId = targetResult.agent.id;
      agentsDAL.updateAgent(targetId, { verification_status: 'pending' });
    });

    it('should have correct name and description', () => {
      expect(strategy.name).toBe('vouch');
      expect(strategy.description).toContain('vouch');
    });

    it('should generate vouch challenge', async () => {
      const target = agentsDAL.findAgentById(targetId)!;
      const challenge = await strategy.onRegister(target);

      expect(challenge).toBeDefined();
      expect(challenge?.type).toBe('vouch');
      expect(challenge?.data?.required_vouches).toBe(2);
    });

    it('should prevent self-vouching', async () => {
      const result = await strategy.addVouch(targetId, targetId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('yourself');
    });

    it('should reject vouch from unverified agent', async () => {
      const unverifiedResult = await agentsDAL.createAgent({
        name: 'unverified-voucher',
        description: 'Not verified',
      });

      const result = await strategy.addVouch(unverifiedResult.agent.id, targetId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('verified');
    });

    it('should reject vouch from low karma agent', async () => {
      const lowKarmaResult = await agentsDAL.createAgent({
        name: 'low-karma-voucher',
        description: 'Low karma',
      });
      agentsDAL.updateAgent(lowKarmaResult.agent.id, { is_verified: true });
      agentsDAL.updateAgentKarma(lowKarmaResult.agent.id, 2);

      const result = await strategy.addVouch(lowKarmaResult.agent.id, targetId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('karma');
    });

    it('should add valid vouch', async () => {
      const result = await strategy.addVouch(voucher1Id, targetId);

      expect(result.success).toBe(true);
      expect(result.vouches_count).toBe(1);
      expect(result.required_vouches).toBe(2);
    });

    it('should prevent duplicate vouch', async () => {
      const result = await strategy.addVouch(voucher1Id, targetId);

      expect(result.success).toBe(false);
      expect(result.message).toContain('already vouched');
    });

    it('should auto-verify when enough vouches', async () => {
      const result = await strategy.addVouch(voucher2Id, targetId);

      expect(result.success).toBe(true);
      expect(result.vouches_count).toBe(2);
      expect(result.message).toContain('verified');

      // Check target is now verified
      const updatedTarget = agentsDAL.findAgentById(targetId);
      expect(updatedTarget?.is_verified).toBe(true);
    });

    it('should get vouch status', () => {
      const vouches = strategy.getVouches(targetId);

      expect(vouches).toBeDefined();
      expect(vouches?.has).toBe(2);
      expect(vouches?.required).toBe(2);
      expect(vouches?.vouchers).toHaveLength(2);
    });
  });
});
