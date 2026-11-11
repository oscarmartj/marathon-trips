import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../errors/safe-error';

/**
 * AES-256-GCM for secrets at rest (plan 4.7). The ciphertext is `iv.tag.data` in base64url and the row keeps the key
 * version next to it, so the key can be rotated. A row encrypted with another version cannot be read until that key
 * is configured again.
 */
export class SecretBox {
  constructor(
    private readonly key: Buffer,
    readonly keyVersion: number,
  ) {
    if (key.length !== 32) throw new AppError('crypto_bad_key', 'The encryption key must be 32 bytes');
  }

  encrypt(plaintext: string, aad: string): { ciphertext: string; keyVersion: number } {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext: [iv, tag, data].map((b) => b.toString('base64url')).join('.'), keyVersion: this.keyVersion };
  }

  decrypt(ciphertext: string, keyVersion: number, aad: string): string {
    if (keyVersion !== this.keyVersion) throw new AppError('crypto_key_version_unavailable', 'This secret was encrypted with a key version that is not configured');
    const parts = ciphertext.split('.');
    if (parts.length !== 3) throw new AppError('crypto_bad_ciphertext', 'The stored secret is malformed');
    const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64url')) as [Buffer, Buffer, Buffer];
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      throw new AppError('crypto_decrypt_failed', 'The stored secret could not be decrypted');
    }
  }
}
