import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { RecipeCancelledError } from '../recipe';
import {
  BINGHATTI_PORTAL_ID,
  GmailOtpError,
  createBinghattiGmailOtp,
  assertBinghattiOtpDestination,
  type BinghattiGmailOtpEnv,
  type BinghattiGmailOtpReader,
  type GmailOtpHooks,
  type PreparedOtpRequest,
} from '../gmailOtp';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

// ── Fixture harness (no real mailbox, credentials or message bodies) ────────

const MAILBOX = 'portal-otp@example.com';
const OTHER_PORTAL = '00000000-0000-0000-0000-000000000000';
const ENV: BinghattiGmailOtpEnv = {
  BINGHATTI_GMAIL_CLIENT_ID: 'fixture-client-id',
  BINGHATTI_GMAIL_CLIENT_SECRET: 'fixture-client-secret',
  BINGHATTI_GMAIL_REFRESH_TOKEN: 'fixture-refresh-token',
};
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_OK = {
  access_token: 'fixture-access-token',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'https://www.googleapis.com/auth/gmail.readonly',
};

interface RecordedCall {
  url: string;
  method: string;
  body?: string;
  redirect?: RequestRedirect;
}
interface FakeReply {
  status?: number;
  body?: unknown;
  jsonThrows?: boolean;
}

function recordingFetch(handler: (url: string) => FakeReply | Promise<FakeReply>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      body: typeof init.body === 'string' ? init.body : undefined,
      redirect: init.redirect,
    });
    const reply = await handler(url);
    const status = reply.status ?? 200;
    return new Response(reply.jsonThrows ? 'not JSON' : JSON.stringify(reply.body), { status });
  };
  return { fetchImpl, calls };
}

interface RouterOpts {
  token?: FakeReply;
  profile?: FakeReply;
  /** Consumed in order — baseline listing first, then candidate listings. */
  lists?: FakeReply[];
  get?: (id: string) => FakeReply;
}

function gmailRouter(opts: RouterOpts) {
  const lists = [...(opts.lists ?? [])];
  return recordingFetch((url) => {
    if (url === TOKEN_URL) return opts.token ?? { body: TOKEN_OK };
    if (url.startsWith(`${GMAIL_BASE}/profile`)) return opts.profile ?? { body: { emailAddress: MAILBOX } };
    if (url.startsWith(`${GMAIL_BASE}/messages?`)) return lists.shift() ?? { body: { messages: [] } };
    const m = /\/messages\/([^/?]+)\?/.exec(url);
    if (m && opts.get) return opts.get(decodeURIComponent(m[1]));
    throw new Error(`fixture: unexpected request ${url}`);
  });
}

function makeHooks(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, now: () => number) {
  const hooks: GmailOtpHooks = {
    checkCancelled: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    fetch: fetchImpl,
    now,
  };
  return hooks;
}

function makeReader(hooks: GmailOtpHooks, env: BinghattiGmailOtpEnv = ENV, loginId: string = MAILBOX): BinghattiGmailOtpReader {
  const reader = createBinghattiGmailOtp(env, BINGHATTI_PORTAL_ID, 'email', loginId, hooks);
  if (!reader) throw new Error('fixture: reader expected');
  return reader;
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function headerEntries(overrides: Record<string, string | string[]> = {}, drop: string[] = []) {
  const base: Record<string, string | string[]> = {
    From: 'Binghatti Portal <no-reply@mail.binghatti.com>',
    To: MAILBOX,
    'Authentication-Results': 'mx.google.com; spf=pass; dkim=pass header.i=@mail.binghatti.com; dmarc=pass header.from=binghatti.com',
    // Deliberately ancient — the reader must ignore the sender-controlled
    // second-precision Date header entirely.
    Date: 'Thu, 01 Jan 1970 00:00:00 +0000',
  };
  const merged = { ...base, ...overrides };
  return Object.entries(merged)
    .filter(([name]) => !drop.includes(name))
    .flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((v) => ({ name, value: v })));
}

function textPart(mime: string, text: string, extra: Record<string, unknown> = {}) {
  return { mimeType: mime, headers: [], body: { data: b64url(text), size: text.length }, ...extra };
}

function message(
  id: string,
  internalDate: number,
  opts: {
    headers?: Record<string, string | string[]>;
    dropHeaders?: string[];
    plain?: string;
    html?: string;
    parts?: unknown[];
  } = {},
) {
  const headers = headerEntries(opts.headers, opts.dropHeaders);
  let payload: Record<string, unknown>;
  if (opts.parts) {
    payload = { mimeType: 'multipart/mixed', headers, parts: opts.parts };
  } else if (opts.plain !== undefined && opts.html !== undefined) {
    payload = { mimeType: 'multipart/alternative', headers, parts: [textPart('text/plain', opts.plain), textPart('text/html', opts.html)] };
  } else {
    const text = opts.plain ?? '';
    payload = { mimeType: 'text/plain', headers, body: { data: b64url(text), size: text.length } };
  }
  return { id, threadId: `thread-${id}`, internalDate: String(internalDate), payload };
}

const OTP_TEXT = (code: string) => `Your Binghatti verification code is ${code}. It expires in 10 minutes.`;

function listReply(ids: string[], nextPageToken?: string): FakeReply {
  return { body: { messages: ids.map((id) => ({ id, threadId: `thread-${id}` })), ...(nextPageToken ? { nextPageToken } : {}) } };
}

const listCalls = (calls: RecordedCall[]) => calls.filter((c) => c.url.startsWith(`${GMAIL_BASE}/messages?`));
const getCalls = (calls: RecordedCall[]) => calls.filter((c) => /\/messages\/[^/?]+\?/.test(c.url));
const tokenCalls = (calls: RecordedCall[]) => calls.filter((c) => c.url === TOKEN_URL);
const queryOf = (call: RecordedCall) => new URL(call.url).searchParams.get('q') ?? '';

// Shared mutable clock for now() injection.
let clock = 1_700_000_000_123;
const now = () => clock;

async function preparedReader(opts: RouterOpts): Promise<{ reader: BinghattiGmailOtpReader; prepared: PreparedOtpRequest; router: ReturnType<typeof gmailRouter>; hooks: GmailOtpHooks }> {
  const router = gmailRouter(opts);
  const hooks = makeHooks(router.fetchImpl, now);
  const reader = makeReader(hooks);
  const prepared = await reader.prepare('otp');
  return { reader, prepared, router, hooks };
}

// ── Factory ─────────────────────────────────────────────────────────────────

describe('createBinghattiGmailOtp factory', () => {
  it('binds automatic email input to the exact HTTPS broker origin', () => {
    expect(() => assertBinghattiOtpDestination('https://partners.binghatti.com:443/Authentication/Login')).not.toThrow();
    for (const url of ['http://partners.binghatti.com', 'https://partners.binghatti.com:8443', 'https://partners.binghatti.com.other.test', 'https://other.test', 'https://fixture-user@partners.binghatti.com', 'invalid']) {
      expect(() => assertBinghattiOtpDestination(url)).toThrow('destination mismatch');
      try { assertBinghattiOtpDestination(url); }
      catch (error) { expect((error as Error).message).not.toContain(url); }
    }
  });
  it('returns null for another portal, another channel, or no secrets at all', () => {
    expect(createBinghattiGmailOtp(ENV, OTHER_PORTAL, 'email', MAILBOX)).toBeNull();
    expect(createBinghattiGmailOtp(ENV, BINGHATTI_PORTAL_ID, 'manual', MAILBOX)).toBeNull();
    expect(createBinghattiGmailOtp(ENV, BINGHATTI_PORTAL_ID, 'gmail', MAILBOX)).toBeNull();
    expect(createBinghattiGmailOtp({}, BINGHATTI_PORTAL_ID, 'email', MAILBOX)).toBeNull();
    expect(createBinghattiGmailOtp(ENV, BINGHATTI_PORTAL_ID, 'email', MAILBOX)).not.toBeNull();
  });

  it('throws a sanitized error on partial configuration', () => {
    let err: unknown;
    try {
      createBinghattiGmailOtp({ BINGHATTI_GMAIL_CLIENT_ID: 'fixture-client-id' }, BINGHATTI_PORTAL_ID, 'email', MAILBOX);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GmailOtpError);
    expect((err as Error).message).toContain('incomplete');
    expect((err as Error).message).not.toContain('fixture-client-id');
  });

  it('rejects an invalid login mailbox without echoing it', () => {
    let err: unknown;
    try {
      createBinghattiGmailOtp(ENV, BINGHATTI_PORTAL_ID, 'email', 'not-a-mailbox');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GmailOtpError);
    expect((err as Error).message).not.toContain('not-a-mailbox');
  });
});

// ── OAuth token ─────────────────────────────────────────────────────────────

describe('OAuth refresh token handling', () => {
  it('posts the three credentials in the body of the hardcoded token endpoint only', async () => {
    const { router } = await preparedReader({ lists: [listReply([])] });
    const token = tokenCalls(router.calls);
    expect(token).toHaveLength(1);
    expect(token[0].method).toBe('POST');
    expect(token[0].body).toContain('grant_type=refresh_token');
    expect(token[0].body).toContain('client_id=fixture-client-id');
    expect(token[0].body).toContain('refresh_token=fixture-refresh-token');
    expect(new URL(token[0].url).search).toBe('');
  });

  it.each([
    ['wrong token_type', { ...TOKEN_OK, token_type: 'bearer' }, /token/],
    ['an extra scope', { ...TOKEN_OK, scope: 'https://www.googleapis.com/auth/gmail.readonly https://mail.google.com/' }, /scope/],
    ['a missing scope', { access_token: 'x', token_type: 'Bearer', expires_in: 3600 }, /scope/],
    ['a string expires_in', { ...TOKEN_OK, expires_in: '3600' }, /expires_in/],
  ])('rejects %s', async (_name, tokenBody, pattern) => {
    const router = gmailRouter({ token: { body: tokenBody } });
    const reader = makeReader(makeHooks(router.fetchImpl, now));
    await expect(reader.prepare('otp')).rejects.toThrow(pattern);
  });

  it('caches the token until just before expiry, then refreshes', async () => {
    const t0 = clock;
    const router = gmailRouter({ lists: [listReply([]), listReply(['a1']), listReply([])], get: (id) => ({ body: message(id, t0 + 1_000, { plain: OTP_TEXT('482910') }) }) });
    const hooks = makeHooks(router.fetchImpl, now);
    const reader = makeReader(hooks);
    const prepared = await reader.prepare('otp');
    clock = t0 + 5_000;
    await reader.findCandidate(prepared, 6, 60_000);
    expect(tokenCalls(router.calls)).toHaveLength(1);
    clock = t0 + 3_600_000; // expires_in reached — beyond the refresh margin
    await reader.prepare('otp');
    expect(tokenCalls(router.calls)).toHaveLength(2);
  });
});

// ── Profile verification ────────────────────────────────────────────────────

describe('mailbox profile verification', () => {
  it('verifies the profile email case-insensitively and fingerprints the normalized mailbox', async () => {
    const router = gmailRouter({ profile: { body: { emailAddress: '  PORTAL-OTP@example.com' } }, lists: [listReply([])] });
    const hooks = makeHooks(router.fetchImpl, now);
    const reader = makeReader(hooks, ENV, ' Portal-Otp@Example.COM ');
    const prepared = await reader.prepare('otp');
    expect(prepared.mailboxFingerprint).toBe(createHash('sha256').update(MAILBOX).digest('hex'));
    expect(prepared.nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(prepared.key).toBe('otp');
  });

  it('throws on a mailbox mismatch without echoing either mailbox', async () => {
    const router = gmailRouter({ profile: { body: { emailAddress: 'someone-else@example.com' } } });
    const reader = makeReader(makeHooks(router.fetchImpl, now));
    let err: unknown;
    try {
      await reader.prepare('otp');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GmailOtpError);
    expect((err as Error).message).toContain('mailbox mismatch');
    expect((err as Error).message).not.toContain('someone-else@example.com');
    expect((err as Error).message).not.toContain(MAILBOX);
  });
});

// ── Transport failures are sanitized ────────────────────────────────────────

describe('sanitized auth/network failures', () => {
  it('reports only the operation and HTTP status — never the URL or body', async () => {
    const router = gmailRouter({ profile: { status: 401, body: { error: { message: 'secret-body-detail' } } } });
    const reader = makeReader(makeHooks(router.fetchImpl, now));
    let err: unknown;
    try {
      await reader.prepare('otp');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GmailOtpError);
    const text = (err as Error).message;
    expect(text).toContain('HTTP 401');
    expect(text).toContain('profile');
    expect(text).not.toContain('gmail.googleapis.com');
    expect(text).not.toContain('secret-body-detail');
  });

  it('rejects a non-JSON response as malformed and a transport failure as a network error', async () => {
    const badJson = gmailRouter({ profile: { jsonThrows: true } });
    await expect(makeReader(makeHooks(badJson.fetchImpl, now)).prepare('otp')).rejects.toThrow('malformed');
    const down = gmailRouter({ profile: { status: 200, body: undefined } });
    await expect(makeReader(makeHooks(down.fetchImpl, now)).prepare('otp')).rejects.toThrow('malformed');
  });

  it('propagates cancellation errors unchanged, never sanitized', async () => {
    const sentinel = new Error('run cancelled');
    const router = gmailRouter({ lists: [listReply([])] });
    const hooks = { ...makeHooks(router.fetchImpl, now), checkCancelled: vi.fn(async () => { throw sentinel; }) };
    await expect(makeReader(hooks).prepare('otp')).rejects.toBe(sentinel);
  });
});

// ── Readonly endpoint surface ───────────────────────────────────────────────

describe('readonly endpoint surface', () => {
  it('only ever calls the token endpoint and the three read endpoints', async () => {
    const t0 = clock;
    const { reader, prepared, router } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 1_000, { plain: OTP_TEXT('482910') }) }),
    });
    clock = t0 + 5_000;
    await reader.findCandidate(prepared, 6, 60_000);
    for (const call of router.calls) {
      if (call.url === TOKEN_URL) {
        expect(call.method).toBe('POST');
        continue;
      }
      expect(call.method).toBe('GET');
      expect(call.url.startsWith(GMAIL_BASE)).toBe(true);
      expect(call.url).not.toMatch(/modify|send|trash|import|attachments|watch|stop|delete/i);
    }
    expect(getCalls(router.calls).every((c) => c.url.includes('format=full'))).toBe(true);
    expect(router.calls.every((c) => c.redirect === 'error')).toBe(true);
  });
});

// ── Baseline capture ────────────────────────────────────────────────────────

describe('complete recent baseline', () => {
  it('accepts opaque page tokens and stamps time after the last baseline page', async () => {
    const t0 = clock;
    let pages = 0;
    const opaque = 'opaque /?=+ token';
    const router = recordingFetch((url) => {
      if (url === TOKEN_URL) return { body: TOKEN_OK };
      if (url.includes('/profile')) return { body: { emailAddress: MAILBOX } };
      pages += 1;
      clock += 1_000;
      if (pages === 1) return listReply(['a'], opaque);
      expect(new URL(url).searchParams.get('pageToken')).toBe(opaque);
      return listReply(['b']);
    });
    const prepared = await makeReader(makeHooks(router.fetchImpl, now)).prepare('otp');
    expect(prepared.baselineIds).toEqual(['a', 'b']);
    expect(prepared.requestedAt).toBe(t0 + 2_000);
  });

  it('follows pages sequentially with the sender-domain after/before query', async () => {
    const t0 = clock;
    const { prepared, router } = await preparedReader({ lists: [listReply(['a', 'b'], 'page-two'), listReply(['c'])] });
    expect(prepared.baselineIds).toEqual(['a', 'b', 'c']);
    const calls = listCalls(router.calls);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('pageToken=page-two');
    expect(queryOf(calls[0])).toBe(`from:(binghatti.com) after:${Math.floor((t0 - 600_000) / 1000)} before:${Math.ceil(t0 / 1000)}`);
  });

  it('rejects duplicates, malformed ids, malformed tokens and an unfinished ceiling', async () => {
    const dup = gmailRouter({ lists: [listReply(['a', 'b'], 'p2'), listReply(['b'])] });
    await expect(makeReader(makeHooks(dup.fetchImpl, now)).prepare('otp')).rejects.toThrow('duplicate');

    const badId = gmailRouter({ lists: [{ body: { messages: [{ threadId: 'x' }] } }] });
    await expect(makeReader(makeHooks(badId.fetchImpl, now)).prepare('otp')).rejects.toThrow('message id');
    const unsafeId = gmailRouter({ lists: [listReply(['../profile'])] });
    await expect(makeReader(makeHooks(unsafeId.fetchImpl, now)).prepare('otp')).rejects.toThrow('message id');
    const repeatedToken = gmailRouter({ lists: [listReply(['a'], 'same'), listReply(['b'], 'same')] });
    await expect(makeReader(makeHooks(repeatedToken.fetchImpl, now)).prepare('otp')).rejects.toThrow('duplicate page token');
    expect(listCalls(repeatedToken.calls)).toHaveLength(2);

    const badToken = gmailRouter({ lists: [{ body: { messages: [], nextPageToken: 7 } }] });
    await expect(makeReader(makeHooks(badToken.fetchImpl, now)).prepare('otp')).rejects.toThrow('page token');

    const endless = gmailRouter({ lists: Array.from({ length: 10 }, (_, i) => listReply([i.toString(16)], `tok-${i + 1}`)) });
    await expect(makeReader(makeHooks(endless.fetchImpl, now)).prepare('otp')).rejects.toThrow('incomplete');

    const tooMany = gmailRouter({ lists: [listReply(Array.from({ length: 1001 }, (_, i) => i.toString(16)))] });
    await expect(makeReader(makeHooks(tooMany.fetchImpl, now)).prepare('otp')).rejects.toThrow('incomplete');
  });

  it('stamps requestedAt after the baseline and polls from requestedAt\'s second', async () => {
    const t0 = clock;
    const { prepared, router } = await preparedReader({
      lists: [listReply([]), listReply([])],
    });
    expect(prepared.requestedAt).toBe(t0); // static clock: stamped after baseline, before SendOTP
    clock = t0 + 30_000;
    expect(listCalls(router.calls)).toHaveLength(1);
  });
});

// ── findCandidate ───────────────────────────────────────────────────────────

describe('findCandidate', () => {
  it('binds cancellation to the old poll even when another window is prepared', async () => {
    let listCount = 0;
    let resolveOld: (response: Response) => void = () => undefined;
    let startedOld: () => void = () => undefined;
    const oldStarted = new Promise<void>((resolve) => { startedOld = resolve; });
    const fetchImpl = async (url: string) => {
      if (url === TOKEN_URL) return Response.json(TOKEN_OK);
      if (url.includes('/profile')) return Response.json({ emailAddress: MAILBOX });
      listCount += 1;
      if (listCount === 2) { startedOld(); return new Promise<Response>((resolve) => { resolveOld = resolve; }); }
      return Response.json({ messages: [] });
    };
    const reader = makeReader({ fetch: fetchImpl, now });
    const first = await reader.prepare('otp');
    const controller = new AbortController();
    const oldResult = reader.findCandidate(first, 6, 60_000, controller.signal).catch((error: unknown) => error);
    await oldStarted;
    controller.abort();
    await reader.prepare('otp');
    resolveOld(Response.json({ messages: [], nextPageToken: 'must-not-follow' }));
    expect(await oldResult).toBeInstanceOf(RecipeCancelledError);
    expect(listCount).toBe(3);
  });

  it('rejects oversized streamed JSON before parsing content and cancels the body', async () => {
    const cancelled = vi.fn();
    const parse = vi.spyOn(JSON, 'parse');
    const reader = makeReader({ fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel: cancelled,
    })) });
    await expect(reader.prepare('otp')).rejects.toThrow('response too large');
    expect(parse).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('does not extend an expired prepared window when given a positive timeout', async () => {
    const t0 = clock;
    const { reader, prepared, router } = await preparedReader({ lists: [listReply([])] });
    const before = router.calls.length;
    clock = t0 + 60_001;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toBeNull();
    expect(router.calls).toHaveLength(before);
  });

  it('rejects internalDate outside the request timeout even inside clock skew', async () => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 60_001, { plain: OTP_TEXT('482910') }) }),
    });
    clock = t0 + 59_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toBeNull();
  });

  it('rechecks the deadline after slow hooks and starts no expired fetch', async () => {
    const t0 = clock;
    const { reader, prepared, router, hooks } = await preparedReader({ lists: [listReply([])] });
    const before = router.calls.length;
    hooks.checkCancelled = async () => { clock = t0 + 60_001; };
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toBeNull();
    expect(router.calls).toHaveLength(before);
  });

  it('bounds response-body reads and preserves cancellation after failed transport', async () => {
    vi.useFakeTimers();
    const neverBody = makeReader({ fetch: async () => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) })) });
    const bodyResult = neverBody.prepare('otp').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await bodyResult).toBeInstanceOf(GmailOtpError);
    const sentinel = new Error('cancelled during request');
    let ended = false;
    const cancelled = makeReader({
      fetch: async () => { ended = true; throw new Error('transport detail'); },
      checkCancelled: async () => { if (ended) throw sentinel; },
    });
    await expect(cancelled.prepare('otp')).rejects.toBe(sentinel);
  });

  it('preserves cancellation arriving during the final response body', async () => {
    const sentinel = new Error('cancelled during body');
    let ended = false;
    const reader = makeReader({
      fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(TOKEN_OK)));
        ended = true;
        controller.close();
      } })),
      checkCancelled: async () => { if (ended) throw sentinel; },
    });
    await expect(reader.prepare('otp')).rejects.toBe(sentinel);
  });

  it('rejects encoded MIME before decode and counts decoded bytes across parts', async () => {
    const t0 = clock;
    const oversized = message('a1', t0 + 1, { plain: OTP_TEXT('482910') });
    const body = oversized.payload.body as Record<string, unknown>;
    body.data = 'A'.repeat(400_000);
    const first = await preparedReader({ lists: [listReply([]), listReply(['a1'])], get: () => ({ body: oversized }) });
    const decode = vi.spyOn(Buffer, 'from');
    clock = t0 + 5_000;
    await expect(first.reader.findCandidate(first.prepared, 6, 60_000)).resolves.toBeNull();
    expect(decode).not.toHaveBeenCalled();
    decode.mockRestore();
    const second = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, clock, { parts: [textPart('text/plain', 'é'.repeat(80_000) + ' OTP 482910'), textPart('text/plain', 'é'.repeat(80_000) + ' OTP 482910')] }) }),
    });
    await expect(second.reader.findCandidate(second.prepared, 6, 60_000)).resolves.toBeNull();
  });

  it('returns the unique fresh code and polls from requestedAt\'s floored second', async () => {
    const t0 = clock;
    const { reader, prepared, router } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 25_000, { plain: OTP_TEXT('482910') }) }),
    });
    clock = t0 + 30_000;
    const found = await reader.findCandidate(prepared, 6, 60_000);
    expect(found).toEqual({ code: '482910', messageId: 'a1' });
    expect(queryOf(listCalls(router.calls)[1])).toContain(`after:${Math.floor(t0 / 1000)}`);
  });

  it('accepts mail received in the exact same millisecond as the request (Date header ignored)', async () => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0, { plain: OTP_TEXT('902134') }) }),
    });
    clock = t0 + 2_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toEqual({ code: '902134', messageId: 'a1' });
  });

  it.each([
    ['stale — predates the request', -1],
    ['future — beyond the 5s skew allowance', 36_001],
  ])('returns null for %s mail', async (_name, offset) => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + offset, { plain: OTP_TEXT('482910') }) }),
    });
    clock = t0 + 30_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toBeNull();
  });

  it('accepts mail inside the clock-skew allowance', async () => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 34_500, { plain: OTP_TEXT('482910') }) }),
    });
    clock = t0 + 30_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toEqual({ code: '482910', messageId: 'a1' });
  });

  it('never fetches a message that is already in the baseline', async () => {
    const t0 = clock;
    const { reader, prepared, router } = await preparedReader({
      lists: [listReply(['a1']), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 1_000, { plain: OTP_TEXT('482910') }) }),
    });
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toBeNull();
    expect(getCalls(router.calls)).toHaveLength(0);
  });

  it.each([
    ['wrong length (shorter)', 'Your Binghatti verification code is 48291.'],
    ['wrong length (longer — no partial match)', 'Your Binghatti verification code is 4829107.'],
    ['no OTP context', 'Reference 482910 was attached to your invoice.'],
    ['substring is not OTP context', 'Hotpoint invoice 482910.'],
    ['login notification is not a code', 'Your login notification reference is 482910.'],
    ['verify alone is not a code', 'Verify payment invoice 482910.'],
  ])('returns null for %s', async (_name, text) => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 1_000, { plain: text }) }),
    });
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toBeNull();
  });

  it.each([
    ['a spoofed lookalike domain', { From: 'Binghatti <no-reply@binghatti.com.evil.example>' }, []],
    ['a non-boundary domain', { From: 'Binghatti <no-reply@notbinghatti.com>' }, []],
    ['conflicting duplicate From headers', { From: ['a@binghatti.com', 'b@binghatti.com'] }, []],
    ['multiple angle identities', { From: '<a@binghatti.com> <b@outside.test>' }, []],
    ['no From header at all', {}, ['From']],
  ])('returns null for %s', async (_name, headers, dropHeaders) => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 1_000, { plain: OTP_TEXT('482910'), headers, dropHeaders }) }),
    });
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toBeNull();
  });

  it('accepts the exact sender domain as well as a boundary subdomain', async () => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 1_000, { plain: OTP_TEXT('482910'), headers: { From: 'Binghatti <no-reply@binghatti.com>' } }) }),
    });
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toEqual({ code: '482910', messageId: 'a1' });
  });

  it.each([
    ['a first dmarc=fail overruled by a forged lower pass', ['mx.google.com; dmarc=fail header.from=binghatti.com', 'mx.google.com; dmarc=pass header.from=binghatti.com']],
    ['a first result not from mx.google.com', ['attacker.example; dmarc=pass header.from=binghatti.com']],
    ['dmarc aligned to a different domain', ['mx.google.com; dmarc=pass header.from=other.example']],
    ['parent TLD is not aligned', ['mx.google.com; dmarc=pass header.from=com']],
    ['header.from from another clause', ['mx.google.com; dmarc=pass; spf=pass header.from=binghatti.com']],
    ['conflicting DMARC results', ['mx.google.com; dmarc=pass header.from=binghatti.com; dmarc=fail']],
    ['ambiguous header.from', ['mx.google.com; dmarc=pass header.from=binghatti.com header.from=other.example']],
  ])('returns null for %s', async (_name, ar) => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 1_000, { plain: OTP_TEXT('482910'), headers: { 'Authentication-Results': ar } }) }),
    });
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toBeNull();
  });

  it('returns null with no Authentication-Results header', async () => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 1_000, { plain: OTP_TEXT('482910'), dropHeaders: ['Authentication-Results'] }) }),
    });
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toBeNull();
  });

  it.each([
    ['a conflicting Delivered-To', { 'Delivered-To': 'someone-else@example.com' }],
    ['a malformed Delivered-To', { 'Delivered-To': 'not-a-mailbox' }],
    ['a recipient list without the expected mailbox', { To: 'other@example.com' }],
  ])('returns null for %s', async (_name, headers) => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 1_000, { plain: OTP_TEXT('482910'), headers }) }),
    });
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toBeNull();
  });

  it('accepts delivery proven by Delivered-To alone', async () => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 1_000, { plain: OTP_TEXT('482910'), headers: { To: 'undisclosed@example.com', 'Delivered-To': MAILBOX } }) }),
    });
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toEqual({ code: '482910', messageId: 'a1' });
  });

  it('accepts the same code across plain and html alternatives', async () => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 1_000, { plain: OTP_TEXT('482910'), html: '<p>Your Binghatti verification code is <b>482910</b>.</p>' }) }),
    });
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toEqual({ code: '482910', messageId: 'a1' });
  });

  it('returns null when MIME alternatives disagree on the code', async () => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 1_000, { plain: OTP_TEXT('482910'), html: '<p>Your Binghatti verification code is <b>111222</b>.</p>' }) }),
    });
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toBeNull();
  });

  it('skips attachment parts entirely and never fetches attachment data', async () => {
    const t0 = clock;
    const { reader, prepared, router } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({
        body: message(id, t0 + 1_000, {
          parts: [
            textPart('text/plain', 'Hello, please see the attached document for details.'),
            { mimeType: 'application/pdf', filename: 'code.pdf', headers: [], body: { attachmentId: 'att-1', size: 100 } },
            textPart('text/html', `<p>verification code ${'756423'}</p>`, { filename: 'code.html' }),
          ],
        }),
      }),
    });
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toBeNull();
    expect(router.calls.some((c) => /attachments/i.test(c.url))).toBe(false);
  });

  it('returns null when more than one message matches — never the newest', async () => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1', 'a2'])],
      get: (id) => ({ body: message(id, t0 + (id === 'a1' ? 1_000 : 2_000), { plain: OTP_TEXT('482910') }) }),
    });
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toBeNull();
  });

  it('makes no API request at all when the window has already elapsed', async () => {
    const t0 = clock;
    const { reader, prepared, router } = await preparedReader({ lists: [listReply([])] });
    const callsBefore = router.calls.length;
    clock = t0 + 120_000;
    await expect(reader.findCandidate(prepared, 6, 0)).resolves.toBeNull();
    expect(router.calls.length).toBe(callsBefore);
  });

  it('stops without further requests when the window elapses mid-poll', async () => {
    const t0 = clock;
    let listCount = 0;
    const router = recordingFetch((url) => {
      if (url === TOKEN_URL) return { body: TOKEN_OK };
      if (url.startsWith(`${GMAIL_BASE}/profile`)) return { body: { emailAddress: MAILBOX } };
      if (url.startsWith(`${GMAIL_BASE}/messages?`)) {
        listCount += 1;
        if (listCount === 1) return { body: { messages: [] } }; // baseline
        clock = t0 + 120_000; // window elapses while the candidate listing is in flight
        return { body: { messages: [{ id: 'a1', threadId: 'thread-m1' }] } };
      }
      return { body: message('a1', t0 + 1_000, { plain: OTP_TEXT('482910') }) };
    });
    const hooks = makeHooks(router.fetchImpl, now);
    const reader = makeReader(hooks);
    const prepared = await reader.prepare('otp');
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 6, 60_000)).resolves.toBeNull();
    expect(getCalls(router.calls)).toHaveLength(0);
  });

  it('rejects an invalid expected length and a malformed message response', async () => {
    const t0 = clock;
    const { reader, prepared } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: () => ({ body: { id: 'a1' } }),
    });
    clock = t0 + 5_000;
    await expect(reader.findCandidate(prepared, 0, 60_000)).rejects.toThrow('expected code length');
    await expect(reader.findCandidate(prepared, 11, 60_000)).rejects.toThrow('expected code length');
    await expect(reader.findCandidate(prepared, 6, 60_000)).rejects.toThrow('malformed');
  });

  it('heartbeats before and after every bounded request', async () => {
    const t0 = clock;
    const { reader, prepared, hooks } = await preparedReader({
      lists: [listReply([]), listReply(['a1'])],
      get: (id) => ({ body: message(id, t0 + 1_000, { plain: OTP_TEXT('482910') }) }),
    });
    // prepare: token + profile + baseline list = 3 requests → 6 heartbeats
    expect(hooks.heartbeat).toHaveBeenCalledTimes(6);
    clock = t0 + 5_000;
    await reader.findCandidate(prepared, 6, 60_000);
    // poll: list + get (token cached) = 2 requests → 4 more heartbeats
    expect(hooks.heartbeat).toHaveBeenCalledTimes(10);
  });
});
