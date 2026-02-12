/**
 * Sync Cryptography Utilities
 *
 * Ed25519 keypair generation, event signing, and signature verification.
 * Uses Node.js built-in crypto module — no new dependencies.
 */

import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from 'crypto';

export interface KeyPair {
  publicKey: string;   // base64-encoded Ed25519 public key
  privateKey: string;  // base64-encoded Ed25519 private key
}

/** Generate an Ed25519 keypair for a sync group */
export function generateSigningKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  return {
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
  };
}

/** Sign a payload string with the instance's Ed25519 private key */
export function signEvent(payload: string, privateKeyBase64: string): string {
  const privateKeyDer = Buffer.from(privateKeyBase64, 'base64');
  const keyObject = createPrivateKey({
    key: privateKeyDer,
    format: 'der',
    type: 'pkcs8',
  });

  const signature = sign(null, Buffer.from(payload, 'utf-8'), keyObject);
  return signature.toString('base64');
}

/** Verify an event's signature against the origin instance's Ed25519 public key */
export function verifyEventSignature(payload: string, signatureBase64: string, publicKeyBase64: string): boolean {
  try {
    const publicKeyDer = Buffer.from(publicKeyBase64, 'base64');
    const keyObject = createPublicKey({
      key: publicKeyDer,
      format: 'der',
      type: 'spki',
    });

    const signature = Buffer.from(signatureBase64, 'base64');
    return verify(null, Buffer.from(payload, 'utf-8'), keyObject, signature);
  } catch {
    return false;
  }
}

/** Generate a random sync token for peer authentication */
export function generateSyncToken(): string {
  const { randomBytes } = require('crypto');
  return randomBytes(32).toString('hex');
}
