/**
 * Request body-size limiting for the high-risk Node API routes (T8).
 *
 * The route handlers read the request body by concatenating every chunk into a
 * Buffer (the duplicated `readNodeBody`). Vercel's platform cap (~4.5 MB on
 * serverless) is the only existing backstop. This helper enforces a LOWER
 * app-level cap so an abnormally large body is rejected EARLY (before it fully
 * buffers in memory) with a clear 413 — abuse and accidental megabyte payloads
 * don't reach the handler. Legit JSON bodies on these routes are well under it.
 *
 * No auth/response-shape change: a too-large body returns 413 { error }.
 */

import type { IncomingMessage, ServerResponse } from 'http';

/** Default app-level body cap — comfortably above legit JSON, well below the
 *  ~4.5 MB platform limit. Per-route overrides may pass a different value. */
export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

export class PayloadTooLargeError extends Error {
  constructor(
    public readonly limitBytes: number,
    public readonly seenBytes: number,
  ) {
    super(`request body exceeds ${limitBytes} bytes (saw ${seenBytes})`);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * Read the Node request body into a Buffer, ABORTING with PayloadTooLargeError
 * the moment it exceeds `maxBytes` — so an oversized body never fully buffers.
 * Fast-rejects via Content-Length when the client declares one.
 */
export async function readNodeBodyLimited(
  req: IncomingMessage,
  maxBytes: number = MAX_REQUEST_BODY_BYTES,
): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PayloadTooLargeError(maxBytes, declared);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new PayloadTooLargeError(maxBytes, total);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Write a 413 JSON response to a Node ServerResponse. */
export function sendPayloadTooLarge(
  res: ServerResponse,
  limitBytes: number = MAX_REQUEST_BODY_BYTES,
): void {
  res.statusCode = 413;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: `request body too large (limit ${limitBytes} bytes)` }));
}
