/**
 * waitForPortalInput — the portal-registration input wait, factored out of
 * runPortalRegistrationJob so the manual-row poll, the WhatsApp-relay nudge and
 * the automatic email-OTP read share ONE loop with ONE timeout and ONE
 * cancellation posture.
 *
 * Sources of an answer, in priority order:
 *   1. MANUAL — a nonempty trimmed `input_value` on the job row (the rep's
 *      modal, or the WhatsApp relay webhook writing the same column). Always
 *      inspected FIRST; it wins over anything the mailbox produced meanwhile.
 *   2. EMAIL  — the configured mail reader's candidate, accepted only after
 *      the atomic SQL claim says so (the claim is the final arbiter of the
 *      race between runs sharing a mailbox).
 *
 * Rules baked in here (do not relax — each one is a consumed-or-lost-code bug):
 *   - The wait is cancelled, never answered, when the row is missing /
 *     cancelled / failed / no longer `awaiting_input`, when the request's key
 *     changed, or when a configured email nonce no longer matches — a waiter
 *     must NEVER consume another step's answer.
 *   - The helper checks the manual request's key/nonce before the existing
 *     resume RPC flips the awaiting row; a false resume cancels the wait.
 *   - An email candidate is returned only in memory, only after the SQL claim
 *     — there is NO generic resume on the email path (the claim RPC resumes
 *     the row itself, and only for this key + nonce).
 *   - A lost claim discards that message for the rest of the window so a
 *     reused mail cannot starve later candidates.
 *   - No provider call outlives the wait: the mailbox poll is skipped at/past
 *     the deadline and bounded by the time remaining.
 *   - Nothing is logged here and no code is persisted: codes exist only as the
 *     function's return value.
 */

import { RecipeCancelledError } from './recipe.js';

/** The wait ran out. The job runner converts this into the relay parking flow
 *  (OtpRelayTimeoutError) or the bilingual RecipeError, so it stays a plain
 *  Error here — it is not an interruption by itself. */
export class PortalInputTimeoutError extends Error {
  constructor() {
    super('timed out waiting for portal input');
    this.name = 'PortalInputTimeoutError';
  }
}

/** The slice of the job row the wait reads. */
export interface PortalInputRow {
  status: string;
  input_value: string | null;
  input_request: Record<string, unknown> | null;
}

/** The automatic email-OTP channel for one prepared window (one SendOTP). */
export interface PortalEmailOtpChannel {
  /** Opaque per-request nonce; the row's `input_request.email_otp_nonce` must
   *  still equal it or the request has moved on and this wait cancels. */
  nonce: string;
  /** ONE bounded read-only mailbox poll; null = nothing new yet. `timeoutMs`
   *  is the time LEFT in this wait. Its signal aborts whenever the waiter ends;
   *  provider requests and hooks must stop when it is aborted. */
  findCandidate: (timeoutMs: number, signal: AbortSignal) => Promise<{ code: string; messageId: string } | null>;
  /** The atomic SQL claim — authoritative for the final race. true = the code
   *  is this waiter's; false = another run claimed it or the request moved on. */
  claimCandidate: (messageId: string) => Promise<boolean>;
  /** Drop a message we lost the claim for, so it is never re-offered this window. */
  discardCandidate: (messageId: string) => void;
}

export interface WaitForPortalInputOptions {
  /** The request_input step's key — only a row still awaiting THIS key counts. */
  key: string;
  timeoutMs: number;
  /** Read the job row (status / input_value / input_request). */
  readRow: () => Promise<PortalInputRow | null>;
  /** The existing resume RPC — true if it flipped the awaiting row after the
   *  helper checked the request key/nonce; the RPC itself guards only status. */
  resumeManual: () => Promise<boolean>;
  /** Throws RecipeCancelledError on rep-cancel, watchdog-fail or worker shutdown. */
  checkCancelled: () => Promise<void>;
  /** Keep the watchdog from sweeping a legitimately waiting run. */
  heartbeat: () => Promise<void>;
  /** The relay WhatsApp ask. Called AT MOST once — when exactly is decided here. */
  notifyRelay: () => Promise<void>;
  /** Present only while a prepared email window matches this request's key. */
  email?: PortalEmailOtpChannel;
  /** Test seams (fake clock). Default Date.now / setTimeout. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Manual-row poll cadence — unchanged from the original inline loop. */
const MANUAL_POLL_MS = 1_500;
/** Automatic-mailbox poll cadence (the reader's poll is read-only and bounded). */
const EMAIL_POLL_MS = 5_000;
/** ≈ every 6 s while waiting (every 4th manual poll). */
const HEARTBEAT_EVERY_POLLS = 4;
/** How long the mailbox gets to deliver before a human is woken on WhatsApp. */
const RELAY_GRACE_MS = 20_000;

export async function waitForPortalInput(opts: WaitForPortalInputOptions): Promise<string> {
  const { key, timeoutMs, readRow, resumeManual, checkCancelled, heartbeat, notifyRelay, email } = opts;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const assertDeadline = (): void => {
    if (now() >= deadline) throw new PortalInputTimeoutError();
  };
  const controller = new AbortController();
  let ended = false;
  const poll: {
    pending: boolean;
    result: { candidate: { code: string; messageId: string } | null } | { error: unknown } | null;
  } = { pending: false, result: null };

  // The relay ask fires ONCE. With no mail reader this is exactly the old
  // behavior (ask the moment the wait starts); with one, the mailbox gets the
  // grace window first — a code that arrives on its own must not wake a human.
  let relayNotified = false;
  const notifyRelayOnce = async (): Promise<void> => {
    if (relayNotified) return;
    relayNotified = true;
    await notifyRelay();
  };

  /** Read the job row and prove it is still THIS waiter's request. Anything
   *  else — row gone, run cancelled/failed, a different status, a different
   *  key, a nonce that is not the one we stamped — cancels the wait rather
   *  than consuming (or blocking on) ANOTHER step's answer. */
  const readManualAnswer = async (): Promise<string | null> => {
    const row = await readRow();
    if (!row || row.status !== 'awaiting_input') throw new RecipeCancelledError();
    const request = row.input_request;
    if (!request || request.key !== key) throw new RecipeCancelledError();
    if (email && request.email_otp_nonce !== email.nonce) throw new RecipeCancelledError();
    const raw = row.input_value;
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
  };

  /** Take a manual answer after checking this wait's key/nonce. The existing
   *  resume RPC guards awaiting_input status; a false means the row moved on
   *  and the value must never be returned. */
  const takeManualAnswer = async (value: string): Promise<string> => {
    await checkCancelled();
    assertDeadline();
    if (!await resumeManual()) throw new RecipeCancelledError();
    await checkCancelled();
    assertDeadline();
    return value;
  };

  let polls = 0;
  let lastEmailPollAt = startedAt;
  try {
    if (!email) await notifyRelayOnce();
    while (now() < deadline) {
      await checkCancelled();
      assertDeadline();
      // Manual input is ALWAYS inspected first — a rep who typed the code must
      // not lose to a mailbox poll happening the same second.
      const manual = await readManualAnswer();
      if (manual != null) return await takeManualAnswer(manual);
      await checkCancelled();
      assertDeadline();

      polls += 1;
      if (polls % HEARTBEAT_EVERY_POLLS === 0) await heartbeat();

      // Only this loop consumes results or writes the job. A pending Gmail poll
      // must never block manual input, heartbeats or the relay grace.
      if (email && poll.result) {
        const result = poll.result;
        poll.result = null;
        const late = await readManualAnswer();
        if (late != null) return await takeManualAnswer(late);
        await checkCancelled();
        assertDeadline();
        if ('error' in result) throw result.error;
        const candidate = result.candidate;
        if (candidate) {
          // The SQL claim is authoritative for the final race (a shared mailbox,
          // a stale request). NO generic resume on this path — the claim RPC
          // resumes the row itself, and only for this key + nonce.
          const claimed = await email.claimCandidate(candidate.messageId);
          await checkCancelled();
          assertDeadline();
          if (claimed) return candidate.code;
          // Lost the race: never offer this mail again this window (a reused
          // mail must not starve later candidates), then re-read the row NOW —
          // the answer may already be sitting on it, or the request may have
          // moved on (which cancels us inside readManualAnswer).
          email.discardCandidate(candidate.messageId);
          const afterRace = await readManualAnswer();
          if (afterRace != null) return await takeManualAnswer(afterRace);
        }
      }

      assertDeadline();
      if (email && !relayNotified && now() - startedAt >= RELAY_GRACE_MS) await notifyRelayOnce();
      await checkCancelled();
      assertDeadline();
      if (email && !poll.pending && now() - lastEmailPollAt >= EMAIL_POLL_MS) {
        lastEmailPollAt = now();
        poll.pending = true;
        // The async wrapper also observes a synchronous provider throw. Both
        // handlers observe every rejection and drop results once this wait ends.
        void (async () => email.findCandidate(deadline - now(), controller.signal))().then(
          (candidate) => { poll.pending = false; if (!ended) poll.result = { candidate }; },
          (error: unknown) => { poll.pending = false; if (!ended) poll.result = { error }; },
        );
      }
      await sleep(Math.min(MANUAL_POLL_MS, deadline - now()));
      await checkCancelled();
    }
    throw new PortalInputTimeoutError();
  } finally {
    ended = true;
    controller.abort();
    poll.result = null;
  }
}
