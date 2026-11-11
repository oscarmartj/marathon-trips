import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { AppError } from '../errors/safe-error';
import { hmacHex, safeEqualHex } from '../crypto/hmac';
import { FileStorage, assertValidKey } from './file-storage';

export interface FilesystemStorageOptions {
  rootDir: string;
  signingKey: string;
  /** Public base URL of the API, such as http://localhost:4000. */
  baseUrl: string;
  /** Path the owning module serves files under. */
  pathPrefix?: string;
}

export class FilesystemFileStorage implements FileStorage {
  private readonly root: string;

  constructor(private readonly opts: FilesystemStorageOptions) {
    this.root = resolve(opts.rootDir);
  }

  private pathFor(key: string): string {
    assertValidKey(key);
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new AppError('file_key_invalid', 'The storage key is not valid');
    return full;
  }

  async put(key: string, data: Buffer, _meta: { contentType: string }): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    // Write beside the target and rename, so a reader never sees half a file.
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('file_not_found', 'The file does not exist');
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.pathFor(key));
      return true;
    } catch (err) {
      if (err instanceof AppError) throw err;
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  private sign(key: string, expires: number): string {
    return hmacHex(this.opts.signingKey, `file:${key}:${expires}`);
  }

  signedUrl(key: string, expiresInSeconds: number, now: Date = new Date()): string {
    assertValidKey(key);
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 24 * 3600) {
      throw new AppError('file_url_ttl_invalid', 'Signed URLs last between 1 second and 24 hours');
    }
    const expires = Math.floor(now.getTime() / 1000) + expiresInSeconds;
    const prefix = (this.opts.pathPrefix ?? '/files').replace(/\/$/, '');
    return `${this.opts.baseUrl.replace(/\/$/, '')}${prefix}/${key}?expires=${expires}&sig=${this.sign(key, expires)}`;
  }

  verifySignature(key: string, expiresAtEpochSeconds: number, signature: string, now: Date = new Date()): boolean {
    assertValidKey(key);
    if (!Number.isInteger(expiresAtEpochSeconds) || expiresAtEpochSeconds < Math.floor(now.getTime() / 1000)) return false;
    return safeEqualHex(this.sign(key, expiresAtEpochSeconds), signature);
  }
}
