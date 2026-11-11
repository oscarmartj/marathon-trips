import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type { AppConfig } from '../config/config';
import { sha256Hex } from '../crypto/hmac';
import { APP_CONFIG, PrismaService } from '../database/prisma.service';
import { AppError } from '../errors/safe-error';
import { FILE_STORAGE, FileStorage } from './file-storage';

/** Content types the platform accepts; a module needing more extends this list in its own task. */
export const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/csv',
]);

export interface SaveFileInput {
  content: Buffer;
  contentType: string;
  purpose: string;
  visibility?: 'private' | 'public';
  originalName?: string;
  uploadedById?: string;
}

@Injectable()
export class StoredFileService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Writes the object, then the row; if the row fails the object is removed again (no orphan content). */
  async save(input: SaveFileInput, tx?: Prisma.TransactionClient) {
    if (input.content.length === 0) throw new AppError('file_empty', 'The file is empty');
    if (input.content.length > this.config.FILE_MAX_BYTES) throw new AppError('file_too_large', 'The file is larger than the limit');
    if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) throw new AppError('file_type_not_allowed', 'This file type is not accepted');
    // The key never comes from the file name: a name can carry personal data or path tricks.
    const storageKey = `${input.purpose.replace(/[^a-z0-9_-]/g, '-')}/${randomUUID()}`;
    await this.storage.put(storageKey, input.content, { contentType: input.contentType });
    try {
      return await (tx ?? this.prisma).storedFile.create({
        data: {
          storageKey, contentType: input.contentType, sizeBytes: input.content.length, checksumSha256: sha256Hex(input.content),
          originalName: input.originalName ?? null, visibility: input.visibility ?? 'private', purpose: input.purpose, uploadedById: input.uploadedById ?? null,
        },
      });
    } catch (err) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  async read(id: string): Promise<{ content: Buffer; contentType: string }> {
    const row = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!row) throw new AppError('file_not_found', 'The file does not exist');
    const content = await this.storage.get(row.storageKey);
    if (sha256Hex(content) !== row.checksumSha256) throw new AppError('file_checksum_mismatch', 'The stored file does not match its checksum');
    return { content, contentType: row.contentType };
  }

  /** Removes content and row. The content goes first: a leftover row is harmless, a leftover object is a leak. */
  async remove(id: string): Promise<void> {
    const row = await this.prisma.storedFile.findUnique({ where: { id } });
    if (!row) return;
    await this.storage.delete(row.storageKey);
    await this.prisma.storedFile.delete({ where: { id } });
  }
}
