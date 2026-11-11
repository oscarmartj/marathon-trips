import { describe, expect, it } from 'vitest';
import { FileStorage } from '../../src/platform/storage/file-storage';

/**
 * The battery every FileStorage adapter must pass (plan 4.6). The filesystem adapter runs it today; an S3 adapter
 * runs the same function against an emulator when one is added.
 */
export function runFileStorageContract(name: string, make: () => Promise<{ storage: FileStorage; cleanup?: () => Promise<void> }>): void {
  describe(`FileStorage contract: ${name}`, () => {
    const withStorage = async (fn: (s: FileStorage) => Promise<void>) => {
      const { storage, cleanup } = await make();
      try {
        await fn(storage);
      } finally {
        await cleanup?.();
      }
    };

    it('stores and returns the same bytes', () =>
      withStorage(async (s) => {
        const data = Buffer.from([0, 1, 2, 250, 255]);
        await s.put('docs/a1', data, { contentType: 'application/pdf' });
        expect((await s.get('docs/a1')).equals(data)).toBe(true);
        expect(await s.exists('docs/a1')).toBe(true);
      }));

    it('replaces an object stored twice under one key', () =>
      withStorage(async (s) => {
        await s.put('docs/a2', Buffer.from('one'), { contentType: 'text/plain' });
        await s.put('docs/a2', Buffer.from('two'), { contentType: 'text/plain' });
        expect((await s.get('docs/a2')).toString()).toBe('two');
      }));

    it('reports a missing key as file_not_found and exists=false', () =>
      withStorage(async (s) => {
        await expect(s.get('docs/missing')).rejects.toMatchObject({ code: 'file_not_found' });
        expect(await s.exists('docs/missing')).toBe(false);
      }));

    it('deletes, and deleting a missing key is not an error', () =>
      withStorage(async (s) => {
        await s.put('docs/a3', Buffer.from('x'), { contentType: 'text/plain' });
        await s.delete('docs/a3');
        expect(await s.exists('docs/a3')).toBe(false);
        await expect(s.delete('docs/a3')).resolves.toBeUndefined();
      }));

    it.each(['../escape', '/abs', 'a/../../b', 'a//b', '.hidden', 'a/.b', 'UPPER', '', 'a/', 'a b'])('rejects the unsafe key %j', (key) =>
      withStorage(async (s) => {
        await expect(s.put(key, Buffer.from('x'), { contentType: 'text/plain' })).rejects.toMatchObject({ code: 'file_key_invalid' });
        await expect(s.get(key)).rejects.toMatchObject({ code: 'file_key_invalid' });
      }));

    it('signs URLs that verify until they expire and not after tampering', () =>
      withStorage(async (s) => {
        const now = new Date('2026-01-01T00:00:00Z');
        const url = new URL(s.signedUrl('docs/a4', 60, now));
        const expires = Number(url.searchParams.get('expires'));
        const sig = url.searchParams.get('sig') ?? '';
        expect(expires).toBe(Math.floor(now.getTime() / 1000) + 60);
        expect(s.verifySignature('docs/a4', expires, sig, new Date(now.getTime() + 59_000))).toBe(true);
        expect(s.verifySignature('docs/a4', expires, sig, new Date(now.getTime() + 61_000))).toBe(false);
        expect(s.verifySignature('docs/other', expires, sig, now)).toBe(false);
        expect(s.verifySignature('docs/a4', expires + 3600, sig, now)).toBe(false);
        expect(s.verifySignature('docs/a4', expires, sig.replace(/.$/, sig.endsWith('0') ? '1' : '0'), now)).toBe(false);
      }));

    it('refuses signed URLs longer than 24 hours or shorter than a second', () =>
      withStorage(async (s) => {
        expect(() => s.signedUrl('docs/a5', 0)).toThrow(/Signed URLs last/);
        expect(() => s.signedUrl('docs/a5', 24 * 3600 + 1)).toThrow(/Signed URLs last/);
      }));
  });
}
