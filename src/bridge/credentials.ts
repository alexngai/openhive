/**
 * Bridge Credential Encryption
 *
 * AES-256-GCM encryption/decryption for platform credentials
 * stored in bridge_configs.credentials_encrypted.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a 32-byte key from a passphrase using SHA-256.
 */
function deriveKey(passphrase: string): Buffer {
  return createHash('sha256').update(passphrase).digest();
}

/**
 * Encrypt credentials object to a base64-encoded string.
 * Format: base64(iv + authTag + ciphertext)
 */
export function encryptCredentials(
  credentials: Record<string, string>,
  key: string,
): string {
  const derivedKey = deriveKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, derivedKey, iv, { authTagLength: AUTH_TAG_LENGTH });

  const plaintext = JSON.stringify(credentials);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: iv (12) + authTag (16) + ciphertext (variable)
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a base64-encoded encrypted string back to credentials object.
 */
export function decryptCredentials(
  encrypted: string,
  key: string,
): Record<string, string> {
  const derivedKey = deriveKey(key);
  const packed = Buffer.from(encrypted, 'base64');

  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted credentials: too short');
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8'));
}
