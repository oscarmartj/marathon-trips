import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FilesystemFileStorage } from '../../src/platform/storage/filesystem-storage';
import { StoredFileService } from '../../src/platform/storage/stored-file.service';
import { PrismaService } from '../../src/platform/database/prisma.service';
import { sha256Hex } from '../../src/platform/crypto/hmac';
import { runFileStorageContract } from '../support/file-storage.contract';
import { testConfig } from '../support/platform';

const config = testConfig({ FILE_MAX_BYTES: '1000' });
const make = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mt-files-'));
  return {
    dir,
    storage: new FilesystemFileStorage({ rootDir: dir, signingKey: config.FILE_SIGNING_KEY, baseUrl: 'http://localhost:4000' }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
};

runFileStorageContract('filesystem', make);

describe('filesystem adapter specifics', () => {
  it('builds URLs under /files and cannot be pointed outside its root', async () => {
    const { storage, cleanup } = await make();
    expect(storage.signedUrl('docs/a', 60)).toMatch(/^http:\/\/localhost:4000\/files\/docs\/a\?expires=\d+&sig=[0-9a-f]{64}$/);
    await expect(storage.put('../../etc/passwd', Buffer.from('x'), { contentType: 'text/plain' })).rejects.toMatchObject({ code: 'file_key_invalid' });
    await cleanup();
  });

  it('leaves no temporary file behind after a write', async () => {
    const { storage, dir, cleanup } = await make();
    await storage.put('docs/x', Buffer.from('abc'), { contentType: 'text/plain' });
    expect(await readdir(join(dir, 'docs'))).toEqual(['x']);
    await cleanup();
  });
});

describe('StoredFileService', () => {
  let prisma: PrismaService;
  let ctx: Awaited<ReturnType<typeof make>>;
  let svc: StoredFileService;
  beforeAll(async () => {
    prisma = new PrismaService(config);
    ctx = await make();
    svc = new StoredFileService(prisma, ctx.storage, config);
  });
  afterAll(async () => {
    await prisma.storedFile.deleteMany({ where: { purpose: { startsWith: 'test' } } });
    await prisma.$disconnect();
    await ctx.cleanup();
  });

  it('stores the content and a row with size and SHA-256, with a key that never comes from the file name', async () => {
    const content = Buffer.from('hello file');
    const row = await svc.save({ content, contentType: 'text/plain', purpose: 'test-docs', originalName: '../../jane-doe-passport.txt' });
    expect(row).toMatchObject({ sizeBytes: content.length, checksumSha256: sha256Hex(content), visibility: 'private' });
    expect(row.storageKey).toMatch(/^test-docs\/[0-9a-f-]{36}$/);
    expect(row.storageKey).not.toContain('jane');
    expect((await svc.read(row.id)).content.equals(content)).toBe(true);
  });

  it('rejects empty, oversized and unaccepted files', async () => {
    await expect(svc.save({ content: Buffer.alloc(0), contentType: 'text/plain', purpose: 'test-docs' })).rejects.toMatchObject({ code: 'file_empty' });
    await expect(svc.save({ content: Buffer.alloc(1001), contentType: 'text/plain', purpose: 'test-docs' })).rejects.toMatchObject({ code: 'file_too_large' });
    await expect(svc.save({ content: Buffer.from('x'), contentType: 'application/x-msdownload', purpose: 'test-docs' })).rejects.toMatchObject({ code: 'file_type_not_allowed' });
  });

  it('removes the stored object when the row cannot be written (no orphan content)', async () => {
    const before = await readdir(ctx.dir).catch(() => [] as string[]);
    const dirBefore = before.includes('test-orphan') ? await readdir(join(ctx.dir, 'test-orphan')) : [];
    await expect(svc.save({ content: Buffer.from('x'), contentType: 'text/plain', purpose: 'test-orphan', uploadedById: 'not-a-uuid' })).rejects.toThrow();
    const after = (await readdir(ctx.dir)).includes('test-orphan') ? await readdir(join(ctx.dir, 'test-orphan')) : [];
    expect(after).toEqual(dirBefore);
  });

  it('detects content that no longer matches its checksum, and remove deletes both', async () => {
    const row = await svc.save({ content: Buffer.from('original'), contentType: 'text/plain', purpose: 'test-docs' });
    await ctx.storage.put(row.storageKey, Buffer.from('tampered'), { contentType: 'text/plain' });
    await expect(svc.read(row.id)).rejects.toMatchObject({ code: 'file_checksum_mismatch' });
    await svc.remove(row.id);
    expect(await ctx.storage.exists(row.storageKey)).toBe(false);
    expect(await prisma.storedFile.count({ where: { id: row.id } })).toBe(0);
    await expect(svc.remove(row.id)).resolves.toBeUndefined();
  });
});
