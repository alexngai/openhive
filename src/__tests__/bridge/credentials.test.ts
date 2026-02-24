import { describe, it, expect } from 'vitest';
import { encryptCredentials, decryptCredentials } from '../../bridge/credentials.js';

describe('Bridge Credential Encryption', () => {
  const testKey = 'test-encryption-key-for-bridge';

  it('encrypts and decrypts credentials round-trip', () => {
    const credentials = {
      bot_token: 'xoxb-test-token-12345',
      app_token: 'xapp-test-token-67890',
    };

    const encrypted = encryptCredentials(credentials, testKey);
    expect(encrypted).not.toContain('xoxb');
    expect(encrypted).not.toContain('xapp');

    const decrypted = decryptCredentials(encrypted, testKey);
    expect(decrypted).toEqual(credentials);
  });

  it('produces different ciphertext each time (random IV)', () => {
    const credentials = { token: 'same-value' };

    const encrypted1 = encryptCredentials(credentials, testKey);
    const encrypted2 = encryptCredentials(credentials, testKey);

    expect(encrypted1).not.toEqual(encrypted2);

    // Both should decrypt to the same value
    expect(decryptCredentials(encrypted1, testKey)).toEqual(credentials);
    expect(decryptCredentials(encrypted2, testKey)).toEqual(credentials);
  });

  it('fails with wrong key', () => {
    const credentials = { token: 'secret' };
    const encrypted = encryptCredentials(credentials, testKey);

    expect(() => decryptCredentials(encrypted, 'wrong-key')).toThrow();
  });

  it('fails with tampered ciphertext', () => {
    const credentials = { token: 'secret' };
    const encrypted = encryptCredentials(credentials, testKey);

    // Tamper with the ciphertext
    const buf = Buffer.from(encrypted, 'base64');
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString('base64');

    expect(() => decryptCredentials(tampered, testKey)).toThrow();
  });

  it('fails with truncated ciphertext', () => {
    expect(() => decryptCredentials('dG9vc2hvcnQ=', testKey)).toThrow(
      'Invalid encrypted credentials: too short'
    );
  });

  it('handles empty credentials', () => {
    const credentials = {};
    const encrypted = encryptCredentials(credentials, testKey);
    const decrypted = decryptCredentials(encrypted, testKey);
    expect(decrypted).toEqual({});
  });
});
