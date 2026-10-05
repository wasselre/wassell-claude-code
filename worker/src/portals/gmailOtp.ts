/**
 * Binghatti Gmail OTP reader — bounded, READ-ONLY access to the mailbox that
 * receives the broker portal's one-time passcodes, so a portal-registration
 * run can relay a fresh code itself instead of asking a rep to read mail.
 *
 * Posture (deliberate — do not loosen without re-reading the threat model):
 *
 * - READ-ONLY BY CONSTRUCTION. The only endpoints called are the OAuth token
 *   endpoint, Gmail `profile`, `messages.list` and `messages.get?format=full`.
 *   There is no code path to modify/send/delete/mark-read/attachment APIs, and
 *   an OAuth token is only accepted when its sole scope is EXACTLY
 *   `gmail.readonly` — a wider-scoped token is rejected, not used.
 * - BOUNDED. Every request has a <=10 s timeout AND the caller's remaining
 *   freshness deadline; a request whose deadline has already elapsed is never
 *   made. Listing follows at most 10 pages / 1000 ids, and a listing that
 *   cannot be proven COMPLETE (page token at the ceiling, duplicate or
 *   malformed ids) is an error, never a truncated success. MIME traversal is
 *   capped (depth / parts / total text).
 * - TRUST NOTHING IN THE MESSAGE. A candidate code must come from a message
 *   that is fresh by Gmail's own `internalDate` (the sender-controlled,
 *   second-precision `Date:` header is never consulted — flooring the poll's
 *   `after:` bound is what keeps same-second mail eligible), from a
 *   binghatti.com or boundary-subdomain addr-spec (display names are never
 *   inspected), addressed to the expected mailbox with no conflicting
 *   Delivered-To, and whose FIRST Authentication-Results header is from
 *   mx.google.com with dmarc=pass aligned to the actual From domain — a
 *   forged lower "pass" can never override the first result.
 * - FAIL CLEAN. Ambiguity (two matching messages, two different codes, a code
 *   with no OTP context) returns null — the caller re-polls on its own
 *   cadence or falls back to asking the rep. Provider/config/auth failures
 *   throw SANITIZED errors carrying only the operation name and an HTTP
 *   status — never a URL, body, token, mailbox or code. Codes and message
 *   content are held in worker memory only and are never logged or persisted.
 */

import { createHash, randomUUID } from 'node:crypto';
import { RecipeCancelledError } from './recipe.js';

export const BINGHATTI_PORTAL_ID = '0f828ff1-c3b9-482c-8b1d-215bef4b4d43';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const REQUIRED_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SENDER_DOMAIN = 'binghatti.com';
const AUTHSERV_ID = 'mx.google.com';

const PER_REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_REFRESH_MARGIN_MS = 30_000;
const BASELINE_INTERVAL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 5_000;
const MAX_LIST_PAGES = 10;
const MAX_LIST_IDS = 1_000;
const LIST_PAGE_SIZE = '100';
const MAX_MIME_DEPTH = 10;
const MAX_MIME_PARTS = 100;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const OTP_CONTEXT_WINDOW = 80;
const MIN_OTP_LENGTH = 1;
const MAX_OTP_LENGTH = 10;

const MAILBOX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_CONTEXT_RE = /\b(?:otp|passcode|(?:verification|login|sign[-\s]?in|security|authentication|one[-\s]?time)\s+(?:code|password))\b|رمز\s+(?:التحقق|الدخول)/i;

/** The three env values this reader needs. Kept local (no WorkerEnv edit yet);
 *  the integration step widens the worker env type to include them. */
export interface BinghattiGmailOtpEnv {
  BINGHATTI_GMAIL_CLIENT_ID?: string | null;
  BINGHATTI_GMAIL_CLIENT_SECRET?: string | null;
  BINGHATTI_GMAIL_REFRESH_TOKEN?: string | null;
}

export type GmailOtpFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface GmailOtpHooks {
  /** Throws a cancellation error when the run has been cancelled. Called
   *  before AND after every bounded network request; its error is always
   *  propagated unchanged (never sanitized into a provider failure). */
  checkCancelled?: () => Promise<void>;
  /** Keeps the job row alive while we wait on Google. Same call cadence as
   *  checkCancelled. */
  heartbeat?: () => Promise<void>;
  /** Injected fetch (tests). Defaults to global fetch. */
  fetch?: GmailOtpFetch;
  /** Injected clock in ms (tests). Defaults to Date.now. */
  now?: () => number;
}

export interface PreparedOtpRequest {
  key: string;
  nonce: string;
  /** ms timestamp stamped AFTER the baseline completes and BEFORE the portal
   *  is asked to send the OTP — the freshness interval starts here. */
  requestedAt: number;
  /** SHA-256 (hex) of the normalized, verified mailbox. */
  mailboxFingerprint: string;
  /** COMPLETE ids of recent sender-domain mail at prepare time. */
  baselineIds: string[];
}

export interface GmailOtpCandidate {
  code: string;
  messageId: string;
}

export interface BinghattiGmailOtpReader {
  prepare(key: string): Promise<PreparedOtpRequest>;
  /** One bounded poll. Returns the unique acceptable code, or null on zero /
   *  ambiguous / untrusted / stale results. Caller owns the 5 s cadence, the
   *  atomic claim and the relay back to the run. */
  findCandidate(prepared: PreparedOtpRequest, expectedLength: number, timeoutMs: number, signal?: AbortSignal): Promise<GmailOtpCandidate | null>;
}

/** Sanitized by construction: messages are built from constants only. */
export class GmailOtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailOtpError';
  }
}

/** Bind approved mailbox access and automatic input to the broker destination. */
export function assertBinghattiOtpDestination(value: string): void {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new GmailOtpError('gmail otp destination mismatch'); }
  if (url.origin !== 'https://partners.binghatti.com' || url.username !== '' || url.password !== '') {
    throw new GmailOtpError('gmail otp destination mismatch');
  }
}

/** Internal sentinel: the freshness window elapsed before a request could be
 *  made. findCandidate converts this to a clean null; it is never a provider
 *  failure. */
class OtpWindowElapsed extends Error {}

const malformed = (operation: string) => new GmailOtpError(`gmail otp ${operation} malformed response`);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isBoundaryDomain(domain: string, root: string): boolean {
  return domain === root || domain.endsWith(`.${root}`);
}

/** DMARC relaxed-style alignment: equal, or one a boundary subdomain of the
 *  other (in either direction). */
function domainsAlign(a: string, b: string): boolean {
  return isBoundaryDomain(a, b) || isBoundaryDomain(b, a);
}

/** Split an address header on top-level commas only (commas inside quotes or
 *  angle brackets are part of a display name). */
function splitAddresses(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inQuote = false;
  let cur = '';
  for (const ch of value) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote && ch === '<') depth += 1;
    else if (!inQuote && ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0 && !inQuote) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Extract the addr-spec from one address piece. Display names are NEVER
 *  inspected — identity comes from the address only. */
function addrSpec(piece: string): string | null {
  const trimmed = piece.trim();
  const angled = /^(?:[^<>]*\s)?<([^<>\s]+@[^<>\s]+)>$/.exec(trimmed);
  if ((trimmed.includes('<') || trimmed.includes('>')) && !angled) return null;
  const candidate = (angled ? angled[1] : trimmed).toLowerCase();
  if (/[<>;,"()]/.test(candidate)) return null;
  return MAILBOX_RE.test(candidate) ? candidate : null;
}

function collectAddrs(values: string[]): string[] | null {
  const out: string[] = [];
  for (const value of values) {
    for (const piece of splitAddresses(value)) {
      const addr = addrSpec(piece);
      if (!addr) return null;
      out.push(addr);
    }
  }
  return out;
}

function headerMap(raw: unknown): Map<string, string[]> {
  if (!Array.isArray(raw)) throw malformed('get message');
  const map = new Map<string, string[]>();
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (!rec || typeof rec.name !== 'string' || typeof rec.value !== 'string') throw malformed('get message');
    const key = rec.name.toLowerCase();
    map.set(key, [...(map.get(key) ?? []), rec.value]);
  }
  return map;
}

/** Per-part header lookup. Returns the value, null when absent, and undefined
 *  when the part's header block is malformed (caller treats the whole part as
 *  untrusted). */
function partHeader(node: Record<string, unknown>, name: string): string | null | undefined {
  if (node.headers === undefined || node.headers === null) return null;
  if (!Array.isArray(node.headers)) return undefined;
  for (const entry of node.headers) {
    const rec = asRecord(entry);
    if (!rec || typeof rec.name !== 'string' || typeof rec.value !== 'string') return undefined;
    if (rec.name.toLowerCase() === name) return rec.value;
  }
  return null;
}

function decodeBase64Url(data: string): string | null {
  if (data.length > Math.ceil(MAX_TEXT_BYTES / 3) * 4) return null;
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(data)) return null;
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function entityCodePoint(digits: string, radix: number): string {
  const cp = parseInt(digits, radix);
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ' ';
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_m, hex: string) => entityCodePoint(hex, 16))
    .replace(/&#([0-9]{1,7});/g, (_m, dec: string) => entityCodePoint(dec, 10))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

/** Inert text from HTML: comments, script/style blocks and all tags are
 *  removed, then common and numeric entities are decoded. No active HTML of
 *  any kind survives. */
function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?(<\/\s*\1\s*>|$)/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  );
}

interface MimeState {
  parts: number;
  chars: number;
  plain: string[];
  html: string[];
}

/** Walk a MIME tree collecting inline text/plain and text/html bodies.
 *  Attachments (filename, attachmentId, attachment disposition) are skipped,
 *  never decoded. Returns false when the structure exceeds a bound or is
 *  untrusted — the caller then refuses the message rather than trusting a
 *  truncated read. */
function walkMime(node: Record<string, unknown>, depth: number, state: MimeState): boolean {
  if (depth > MAX_MIME_DEPTH) return false;
  state.parts += 1;
  if (state.parts > MAX_MIME_PARTS) return false;
  const disposition = partHeader(node, 'content-disposition');
  if (disposition === undefined) return false;
  if (node.filename !== undefined && typeof node.filename !== 'string') return false;
  if (typeof node.filename === 'string' && node.filename.trim() !== '') return true; // attachment — skipped
  const body = asRecord(node.body);
  if (body && typeof body.attachmentId === 'string' && body.attachmentId !== '') return true; // attachment — skipped
  if (disposition && disposition.toLowerCase().includes('attachment')) return true;
  const mime = typeof node.mimeType === 'string' ? node.mimeType.toLowerCase() : '';
  if (mime.startsWith('multipart/')) {
    if (!Array.isArray(node.parts)) return false;
    for (const child of node.parts) {
      const rec = asRecord(child);
      if (!rec || !walkMime(rec, depth + 1, state)) return false;
    }
    return true;
  }
  if (mime === 'text/plain' || mime === 'text/html') {
    const data = body?.data;
    if (data === undefined || data === null || data === '') return true;
    if (typeof data !== 'string') return false;
    const text = decodeBase64Url(data);
    if (text === null) return false;
    state.chars += Buffer.byteLength(text, 'utf8');
    if (state.chars > MAX_TEXT_BYTES) return false;
    (mime === 'text/plain' ? state.plain : state.html).push(text);
  }
  return true;
}

/** Collect expected-length numeric codes that appear near OTP/verification
 *  context. A number with no context (a reference, an invoice id) is ignored. */
function collectCodes(text: string, expectedLength: number, out: Set<string>): void {
  const re = new RegExp(`(?<![0-9A-Za-z])([0-9]{${expectedLength}})(?![0-9A-Za-z])`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - OTP_CONTEXT_WINDOW);
    const end = Math.min(text.length, m.index + expectedLength + OTP_CONTEXT_WINDOW);
    if (OTP_CONTEXT_RE.test(text.slice(start, end))) out.add(m[1]);
  }
}

class BinghattiGmailOtp implements BinghattiGmailOtpReader {
  private tokenCache: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly creds: { clientId: string; clientSecret: string; refreshToken: string },
    private readonly mailbox: string,
    private readonly hooks: GmailOtpHooks,
  ) {}

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  private fetchImpl(): GmailOtpFetch {
    return this.hooks.fetch ?? ((url, init) => fetch(url, init));
  }

  private async checkCancelled(signal?: AbortSignal): Promise<void> {
    await this.hooks.checkCancelled?.();
    if (signal?.aborted) throw new RecipeCancelledError();
  }

  /** Bound JSON before parsing; even unauthenticated sender content has a cap. */
  private async readJson(res: Response, operation: string, signal: AbortSignal): Promise<unknown> {
    if (!res.body) throw malformed(operation);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = '';
    const cancelBody = () => {
      // Cancelling a body is best effort after a bounded request has ended.
      void reader.cancel().catch(() => console.warn('gmail otp response cancellation failed'));
    };
    signal.addEventListener('abort', cancelBody, { once: true });
    try {
      while (true) {
        if (signal.aborted) throw new GmailOtpError(`gmail otp ${operation} aborted`);
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new GmailOtpError(`gmail otp ${operation} response too large`);
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
      try { return JSON.parse(text) as unknown; }
      catch { throw malformed(operation); }
    } finally {
      signal.removeEventListener('abort', cancelBody);
      cancelBody();
      reader.releaseLock();
    }
  }

  /** One bounded request with cancellation/heartbeat hooks on BOTH sides.
   *  Hook errors propagate unchanged; transport/HTTP/parse failures become
   *  sanitized GmailOtpErrors that can never echo the URL (the list URL
   *  embeds the query) or a response body (it can carry mailbox content). */
  private async request(operation: string, url: string, init: RequestInit, deadline: number | null, requestSignal?: AbortSignal): Promise<unknown> {
    if (deadline !== null && this.now() >= deadline) throw new OtpWindowElapsed();
    await this.checkCancelled(requestSignal);
    await this.hooks.heartbeat?.();
    if (requestSignal?.aborted) throw new RecipeCancelledError();
    const remaining = deadline === null ? PER_REQUEST_TIMEOUT_MS : deadline - this.now();
    if (remaining <= 0) throw new OtpWindowElapsed();
    const timeoutMs = Math.min(PER_REQUEST_TIMEOUT_MS, remaining);
    const controller = new AbortController();
    const signal = requestSignal ? AbortSignal.any([controller.signal, requestSignal]) : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: unknown;
    let failure: Error | null = null;
    try {
      const work = async (): Promise<unknown> => {
        const res = await this.fetchImpl()(url, { ...init, redirect: 'error', signal });
        if (!res.ok) throw new GmailOtpError(`gmail otp ${operation} failed (HTTP ${res.status})`);
        return this.readJson(res, operation, signal);
      };
      result = await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new GmailOtpError(`gmail otp ${operation} timed out`));
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      failure = err instanceof GmailOtpError ? err : new GmailOtpError(`gmail otp ${operation} network error`);
    } finally {
      clearTimeout(timer);
    }
    // Cancellation also wins over failed fetches and completed body reads.
    await this.checkCancelled(requestSignal);
    await this.hooks.heartbeat?.();
    if (requestSignal?.aborted) throw new RecipeCancelledError();
    if (deadline !== null && this.now() >= deadline) throw new OtpWindowElapsed();
    if (failure) throw failure;
    return result;
  }

  private async accessToken(deadline: number | null, signal?: AbortSignal): Promise<string> {
    const cached = this.tokenCache;
    if (cached && this.now() < cached.expiresAt - TOKEN_REFRESH_MARGIN_MS) return cached.token;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.creds.clientId,
      client_secret: this.creds.clientSecret,
      refresh_token: this.creds.refreshToken,
    });
    const json = await this.request(
      'token refresh',
      TOKEN_URL,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      deadline,
      signal,
    );
    const obj = asRecord(json);
    if (!obj) throw malformed('token refresh');
    // Scope is enforced EXACTLY: a token able to do more than read is a
    // misconfiguration we refuse, not one we use.
    const scopes = typeof obj.scope === 'string' ? obj.scope.trim().split(/\s+/).filter(Boolean) : [];
    if (scopes.length !== 1 || scopes[0] !== REQUIRED_SCOPE) throw new GmailOtpError('gmail otp token refresh rejected: scope');
    if (typeof obj.access_token !== 'string' || obj.access_token === '' || obj.token_type !== 'Bearer') {
      throw new GmailOtpError('gmail otp token refresh rejected: token');
    }
    if (typeof obj.expires_in !== 'number' || !Number.isFinite(obj.expires_in) || obj.expires_in <= 0) {
      throw new GmailOtpError('gmail otp token refresh rejected: expires_in');
    }
    this.tokenCache = { token: obj.access_token, expiresAt: this.now() + obj.expires_in * 1000 };
    return obj.access_token;
  }

  private async gmailGet(operation: string, path: string, params: Record<string, string>, deadline: number | null, signal?: AbortSignal): Promise<unknown> {
    const token = await this.accessToken(deadline, signal);
    const qs = new URLSearchParams(params).toString();
    const url = qs ? `${GMAIL_BASE}${path}?${qs}` : `${GMAIL_BASE}${path}`;
    return this.request(operation, url, { method: 'GET', headers: { authorization: `Bearer ${token}` } }, deadline, signal);
  }

  /** COMPLETE id listing for a sender-domain/recent query — follows pages
   *  sequentially and refuses anything it cannot prove complete. */
  private async listAllIds(operation: string, afterSec: number, beforeSec: number, deadline: number | null, signal?: AbortSignal): Promise<string[]> {
    const ids: string[] = [];
    const seen = new Set<string>();
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const params: Record<string, string> = {
        q: `from:(${SENDER_DOMAIN}) after:${afterSec} before:${beforeSec}`,
        maxResults: LIST_PAGE_SIZE,
      };
      if (pageToken) params.pageToken = pageToken;
      const json = await this.gmailGet(operation, '/messages', params, deadline, signal);
      const obj = asRecord(json);
      if (!obj) throw malformed(operation);
      if (obj.messages !== undefined) {
        if (!Array.isArray(obj.messages)) throw malformed(operation);
        for (const entry of obj.messages) {
          const id = asRecord(entry)?.id;
          if (typeof id !== 'string' || !/^[0-9a-f]{1,128}$/.test(id)) throw new GmailOtpError(`gmail otp ${operation} rejected: message id`);
          if (seen.has(id)) throw new GmailOtpError(`gmail otp ${operation} rejected: duplicate id`);
          seen.add(id);
          ids.push(id);
          if (ids.length > MAX_LIST_IDS) throw new GmailOtpError(`gmail otp ${operation} incomplete: id limit`);
        }
      }
      const next = obj.nextPageToken;
      if (next === undefined) return ids;
      if (typeof next !== 'string' || next.trim() === '' || next.length > 2048) throw new GmailOtpError(`gmail otp ${operation} rejected: page token`);
      if (seenTokens.has(next)) throw new GmailOtpError(`gmail otp ${operation} rejected: duplicate page token`);
      seenTokens.add(next);
      pageToken = next;
    }
    throw new GmailOtpError(`gmail otp ${operation} incomplete: page limit`);
  }

  async prepare(key: string): Promise<PreparedOtpRequest> {
    const profile = asRecord(await this.gmailGet('profile', '/profile', {}, null));
    const email = typeof profile?.emailAddress === 'string' ? profile.emailAddress.trim().toLowerCase() : null;
    if (email === null) throw malformed('profile');
    if (email !== this.mailbox) throw new GmailOtpError('gmail otp prepare failed: mailbox mismatch');
    // Baseline first, stamp after: the freshness interval begins once every
    // pre-existing recent id is known, before the portal is asked to send.
    const nowMs = this.now();
    const baselineIds = await this.listAllIds(
      'baseline list',
      Math.floor((nowMs - BASELINE_INTERVAL_MS) / 1000),
      Math.ceil(nowMs / 1000),
      null,
    );
    const requestedAt = this.now();
    return {
      key,
      nonce: randomUUID(),
      requestedAt,
      mailboxFingerprint: createHash('sha256').update(this.mailbox).digest('hex'),
      baselineIds,
    };
  }

  async findCandidate(prepared: PreparedOtpRequest, expectedLength: number, timeoutMs: number, signal?: AbortSignal): Promise<GmailOtpCandidate | null> {
    await this.checkCancelled(signal);
    if (!Number.isInteger(expectedLength) || expectedLength < MIN_OTP_LENGTH || expectedLength > MAX_OTP_LENGTH) {
      throw new GmailOtpError('gmail otp invalid expected code length');
    }
    if (!Number.isFinite(timeoutMs) || !Number.isSafeInteger(prepared.requestedAt)) throw new GmailOtpError('gmail otp invalid request window');
    const deadline = prepared.requestedAt + timeoutMs;
    if (timeoutMs <= 0 || this.now() >= deadline) return null;
    const baseline = new Set(prepared.baselineIds);
    // `after:` is floored so mail received in the SAME second as requestedAt
    // stays eligible; the precise ms filter happens per message below.
    const afterSec = Math.floor(prepared.requestedAt / 1000);
    const beforeSec = Math.ceil((this.now() + CLOCK_SKEW_MS) / 1000);
    let ids: string[];
    try {
      ids = await this.listAllIds('candidate list', afterSec, beforeSec, deadline, signal);
    } catch (err) {
      if (err instanceof OtpWindowElapsed) return null;
      throw err;
    }
    const matches: GmailOtpCandidate[] = [];
    for (const id of ids) {
      if (baseline.has(id)) continue; // pre-existing mail — not a candidate, not even fetched
      let raw: unknown;
      try {
        raw = await this.gmailGet('get message', `/messages/${encodeURIComponent(id)}`, { format: 'full' }, deadline, signal);
      } catch (err) {
        if (err instanceof OtpWindowElapsed) return null;
        throw err;
      }
      const code = this.evaluateMessage(raw, id, prepared.requestedAt, deadline, expectedLength);
      if (code !== null) {
        matches.push({ code, messageId: id });
        if (matches.length > 1) return null; // ambiguous — never pick the newest
      }
    }
    await this.checkCancelled(signal);
    return this.now() < deadline && matches.length === 1 ? matches[0] : null;
  }

  /** Provider-contract violations throw (malformed). Anything merely
   *  untrustworthy about the message itself returns null. */
  private evaluateMessage(raw: unknown, expectedId: string, requestedAt: number, deadline: number, expectedLength: number): string | null {
    const obj = asRecord(raw);
    if (!obj || obj.id !== expectedId) throw malformed('get message');
    const internalDateRaw = obj.internalDate;
    if (typeof internalDateRaw !== 'string' || !/^\d+$/.test(internalDateRaw)) throw malformed('get message');
    const internalDate = Number(internalDateRaw);
    if (!Number.isSafeInteger(internalDate)) throw malformed('get message');
    if (internalDate < requestedAt) return null; // predates the OTP request
    if (internalDate > deadline) return null;
    if (internalDate > this.now() + CLOCK_SKEW_MS) return null; // beyond the defined skew allowance
    const payload = asRecord(obj.payload);
    if (!payload) throw malformed('get message');
    const headers = headerMap(payload.headers);

    // Sender identity: exactly one addr-spec across all From headers
    // (conflicting duplicates are refused), at the sender domain or a
    // boundary subdomain of it.
    const fromValues = headers.get('from') ?? [];
    if (fromValues.length === 0) return null;
    const fromAddrs = new Set<string>();
    for (const value of fromValues) {
      for (const piece of splitAddresses(value)) {
        const addr = addrSpec(piece);
        if (!addr) return null; // unparseable identity — untrusted
        fromAddrs.add(addr);
      }
    }
    if (fromAddrs.size !== 1) return null;
    const fromAddr = [...fromAddrs][0];
    const fromDomain = fromAddr.slice(fromAddr.indexOf('@') + 1);
    if (!isBoundaryDomain(fromDomain, SENDER_DOMAIN)) return null;

    // FIRST Authentication-Results only: it is the one the receiving MX
    // added. A forged lower "pass" further down the chain can never override
    // a first fail.
    const first = (headers.get('authentication-results') ?? [])[0];
    if (first === undefined) return null;
    const semi = first.indexOf(';');
    const authserv = (semi === -1 ? first : first.slice(0, semi)).trim().toLowerCase();
    if (authserv !== AUTHSERV_ID) return null;
    const clauses = first.slice(semi + 1).split(';').map((clause) => clause.trim());
    const dmarcClauses = clauses.filter((clause) => /^dmarc\s*=/i.test(clause));
    if (dmarcClauses.length !== 1 || !/^dmarc\s*=\s*pass\b/i.test(dmarcClauses[0])) return null;
    const fromMatches = [...first.matchAll(/\bheader\.from\s*=\s*("[^"]+"|[^\s;]+)/gi)];
    if (fromMatches.length !== 1) return null;
    const headerFrom = /\bheader\.from\s*=\s*("[^"]+"|[^\s;]+)/i.exec(dmarcClauses[0]);
    if (!headerFrom) return null;
    const arDomain = headerFrom[1].replace(/^"|"$/g, '').trim().toLowerCase();
    if (!isBoundaryDomain(arDomain, SENDER_DOMAIN) || !domainsAlign(arDomain, fromDomain)) return null;

    // Recipient: the expected mailbox must be an actual recipient, and any
    // Delivered-To for a DIFFERENT mailbox is a conflicting delivery.
    const toAddrs = collectAddrs(headers.get('to') ?? []);
    const deliveredTo = collectAddrs(headers.get('delivered-to') ?? []);
    if (!toAddrs || !deliveredTo) return null;
    if (deliveredTo.some((d) => d !== this.mailbox)) return null;
    if (!toAddrs.includes(this.mailbox) && !deliveredTo.includes(this.mailbox)) return null;

    // Body: bounded inline text only, attachments skipped.
    const state: MimeState = { parts: 0, chars: 0, plain: [], html: [] };
    if (!walkMime(payload, 0, state)) return null;
    const codes = new Set<string>();
    for (const text of state.plain) collectCodes(text, expectedLength, codes);
    for (const text of state.html) collectCodes(htmlToText(text), expectedLength, codes);
    return codes.size === 1 ? [...codes][0] : null;
  }
}

/** Factory for the next integration step. Returns null when this portal /
 *  channel is not ours or when none of the three secrets are configured;
 *  throws a sanitized error on PARTIAL configuration (a set-up mistake that
 *  must be loud) or an invalid login mailbox. */
export function createBinghattiGmailOtp(
  env: BinghattiGmailOtpEnv,
  portalId: string,
  otpChannel: string,
  loginId: string,
  hooks: GmailOtpHooks = {},
): BinghattiGmailOtpReader | null {
  if (portalId !== BINGHATTI_PORTAL_ID) return null;
  if (otpChannel.trim().toLowerCase() !== 'email') return null;
  const clientId = env.BINGHATTI_GMAIL_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.BINGHATTI_GMAIL_CLIENT_SECRET?.trim() ?? '';
  const refreshToken = env.BINGHATTI_GMAIL_REFRESH_TOKEN?.trim() ?? '';
  const present = [clientId, clientSecret, refreshToken].filter((v) => v !== '').length;
  if (present === 0) return null;
  if (present !== 3) {
    throw new GmailOtpError(
      'gmail otp config incomplete: BINGHATTI_GMAIL_CLIENT_ID, BINGHATTI_GMAIL_CLIENT_SECRET and BINGHATTI_GMAIL_REFRESH_TOKEN must all be set',
    );
  }
  const mailbox = loginId.trim().toLowerCase();
  if (!MAILBOX_RE.test(mailbox)) throw new GmailOtpError('gmail otp config invalid: login id is not a mailbox');
  return new BinghattiGmailOtp({ clientId, clientSecret, refreshToken }, mailbox, hooks);
}
