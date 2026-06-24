import { describe, it, expect } from 'vitest';
import {
  readNodeBodyLimited,
  PayloadTooLargeError,
  MAX_REQUEST_BODY_BYTES,
} from '../../../api/_lib/httpBody';

// Minimal duck-typed IncomingMessage: an async-iterable of chunks + headers.
function fakeReq(chunks: Buffer[], headers: Record<string, string> = {}) {
  return {
    headers,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

describe('readNodeBodyLimited', () => {
  it('fast-rejects via Content-Length before reading the body', async () => {
    const req = fakeReq([Buffer.from('x')], {
      'content-length': String(MAX_REQUEST_BODY_BYTES + 1),
    });
    await expect(
      readNodeBodyLimited(req as never, MAX_REQUEST_BODY_BYTES),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('aborts mid-stream once accumulated bytes exceed the cap', async () => {
    const chunks = [Buffer.alloc(60), Buffer.alloc(60)]; // 120 bytes > 100 cap
    await expect(readNodeBodyLimited(fakeReq(chunks) as never, 100)).rejects.toBeInstanceOf(
      PayloadTooLargeError,
    );
  });

  it('returns the full buffer when under the cap', async () => {
    const buf = await readNodeBodyLimited(
      fakeReq([Buffer.from('hello '), Buffer.from('world')]) as never,
      1000,
    );
    expect(buf.toString()).toBe('hello world');
  });

  it('PayloadTooLargeError carries the configured limit', async () => {
    try {
      await readNodeBodyLimited(fakeReq([Buffer.alloc(200)]) as never, 100);
      throw new Error('expected a throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PayloadTooLargeError);
      expect((e as PayloadTooLargeError).limitBytes).toBe(100);
    }
  });
});
