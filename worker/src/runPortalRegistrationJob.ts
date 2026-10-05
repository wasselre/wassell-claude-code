/**
 * runPortalRegistrationJob — register an interested customer in a developer's /
 * marketer's broker portal by replaying the portal's RECIPE in a Browserbase
 * browser. Same queue posture as runRegaLookupJob (claim → run with no
 * wall-clock ceiling → patch the row → the SPA follows via Realtime).
 *
 * The OTP handshake (the reason this is a worker job, not a request):
 *   1. The recipe reaches a `request_input` step → the worker flips the job to
 *      `awaiting_input` with a bilingual prompt and KEEPS the browser open.
 *   2. The rep sees the prompt in the modal (Realtime), reads the code off their
 *      phone, types it → POST /api/portal-registration {action:'input'} writes
 *      `input_value` onto the row (owner-gated RPC).
 *   3. The worker, polling its own row every ~1.5 s (heart-beating so the
 *      watchdog knows it is alive and waiting), sees the value, clears it,
 *      flips back to `running` and continues the recipe.
 *
 * WhatsApp code relay (auto runs of a portal with `otp_whatsapp_relay` on):
 *   nobody is watching the modal, so on `request_input` the operations number
 *   WhatsApps the portal's relay phone asking for the code; the reply comes
 *   back through /api/webhook/waha → portal_otp_relay_inbound → input_value,
 *   the same row the modal would write. If no code arrives within the step's
 *   wait the run is PARKED (browser closed, job queued with parked_at) instead
 *   of failed, and the next WhatsApp from that phone restarts it with a fresh
 *   code. See supabase/migrations/2026-09-24_01_portal_otp_whatsapp_relay.sql.
 *
 * Automatic email OTP (Binghatti Gmail): when the portal's code lands in a
 *   fixed Gmail mailbox instead of on a phone, the recipe runs
 *   `prepare_email_otp` BEFORE the click that sends the code (mailbox profile
 *   check + recent-message baseline — baselining after the send could pick up
 *   an older mail). The input wait then polls the mailbox ~every 5 s alongside
 *   the manual row; a found code is accepted only via the atomic
 *   portal_email_otp_claim RPC (job + key + mailbox fingerprint + message id +
 *   request nonce — no code argument), so SQL stays the final arbiter and a
 *   code is never taken twice or for another step's request. The WhatsApp
 *   relay ask is delayed ~20 s to give the mailbox first chance. The reader
 *   lives in portals/gmailOtp.ts; the shared wait loop in portals/inputWait.ts.
 *
 * Evidence trail: a JPEG screenshot per `screenshot` step plus one on success
 * and one on failure, uploaded to the PRIVATE `portal-registrations` bucket
 * under <job id>/…; the API signs them for the modal. The Browserbase live-view
 * URL is written onto the row so the rep can WATCH (and, if a portal does
 * something unexpected, take over in the embedded view).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { WorkerEnv } from './env.js';
import { browserbaseSessionOptions, ensurePortalContext } from './portals/browserbase.js';
import { assertSnapshotIsNewer } from './portals/jsonInventory.js';
import {
  parseRecipe,
  runSteps,
  RecipeCancelledError,
  RecipeError,
  RecipeInterrupt,
  countTopLevelPhases,
  type RecipeRuntime,
  type RecipeStep,
} from './portals/recipe.js';
import { createBinghattiGmailOtp, assertBinghattiOtpDestination } from './portals/gmailOtp.js';
import { waitForPortalInput, PortalInputTimeoutError } from './portals/inputWait.js';

/** The Binghatti Gmail OTP reader's own API, inferred from its factory so this
 *  file tracks the reader (portals/gmailOtp.ts) without duplicating its types. */
type GmailOtpReader = NonNullable<ReturnType<typeof createBinghattiGmailOtp>>;
/** Prepared read window ({ key, nonce, requestedAt, mailboxFingerprint,
 *  baselineIds }) — the baseline is taken BEFORE the portal sends the code. */
type PreparedEmailOtp = Awaited<ReturnType<GmailOtpReader['prepare']>>;

/** Shape of a claimed portal_registration_jobs row (the columns we use). */
export interface PortalRegistrationJob {
  id: string;
  /** 'register' (one client into a portal) or 'status_check' (read the
   *  portal's client list and refresh every registration's portal status). */
  kind: 'register' | 'status_check';
  portalRecordId: string;
  /** NULL on a status check — it covers the whole portal. */
  clientRecordId: string | null;
  projectRecordId: string | null;
  /** NULL on a status check — nobody owns it; its code goes through the relay. */
  userId: string | null;
  leadData: Record<string, unknown>;
  loginPhone: string | null;
  attempts: number;
  /** 'manual' (a rep pressed the button) or 'auto' (the ad-lead sweep). */
  origin: string;
}

interface RunArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: PortalRegistrationJob;
  /** True once the worker got SIGTERM (a deploy / scale-down). A run that has
   *  not reached its submit step then hands itself back to the queue. */
  isShuttingDown?: () => boolean;
}

const BUCKET = 'portal-registrations';
const DEFAULT_INPUT_TIMEOUT_S = 300;
/** The code wait ran out on a WhatsApp-relay run → park it, don't fail it. */
class OtpRelayTimeoutError extends RecipeInterrupt {
  constructor() {
    super('otp relay wait timed out');
  }
}

type Rec = { id: string; data: Record<string, unknown> } | null;

async function loadRecord(supabase: SupabaseClient, id: string | null): Promise<Rec> {
  if (!id) return null;
  const { data, error } = await supabase.from('unified_records').select('id, data').eq('id', id).maybeSingle();
  if (error) throw new Error(`record load failed (${id}): ${error.message}`);
  return (data as Rec) ?? null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/** Create a Browserbase session (residential KSA egress — the portals are Saudi
 *  sites, some geo-fence) and return its id + CDP connect URL + live view URL. */
async function createSession(
  env: WorkerEnv,
  contextId?: string | null,
): Promise<{ id: string; connectUrl: string; liveViewUrl: string | null }> {
  const headers = { 'X-BB-API-Key': env.BROWSERBASE_API_KEY!, 'Content-Type': 'application/json' };
  const res = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify(browserbaseSessionOptions(env.BROWSERBASE_PROJECT_ID!, contextId)),
    signal: AbortSignal.timeout(30_000),
  });
  const session = (await res.json()) as { id?: string; connectUrl?: string; message?: string };
  if (!res.ok || !session.id || !session.connectUrl) {
    throw new Error(`Browserbase session create failed: ${session.message ?? JSON.stringify(session).slice(0, 200)}`);
  }
  let liveViewUrl: string | null = null;
  try {
    const dbg = await fetch(`https://api.browserbase.com/v1/sessions/${session.id}/debug`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!dbg.ok) throw new Error(`Browserbase debug HTTP ${dbg.status}`);
    const j = (await dbg.json()) as { debuggerFullscreenUrl?: string; debuggerUrl?: string };
    liveViewUrl = j.debuggerFullscreenUrl ?? j.debuggerUrl ?? null;
  } catch (err) {
    // Live view is a convenience, not a requirement — the run proceeds blind.
    console.warn(`[portal] live view URL unavailable: ${(err as Error).message}`);
  }
  return { id: session.id, connectUrl: session.connectUrl, liveViewUrl };
}

/** Ask Browserbase to release the session now rather than at its timeout. */
async function releaseSession(env: WorkerEnv, id: string): Promise<void> {
  try {
    const response = await fetch(`https://api.browserbase.com/v1/sessions/${id}`, {
      method: 'POST',
      headers: { 'X-BB-API-Key': env.BROWSERBASE_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: env.BROWSERBASE_PROJECT_ID, status: 'REQUEST_RELEASE' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) console.error(`[portal] session release failed (will expire on its own): HTTP ${response.status}`);
  } catch (err) {
    console.warn(`[portal] session release failed (will expire on its own): ${(err as Error).message}`);
  }
}

export async function runPortalRegistrationJob({ supabase, env, job, isShuttingDown }: RunArgs): Promise<Record<string, unknown>> {
  if (!env.BROWSERBASE_API_KEY || !env.BROWSERBASE_PROJECT_ID) {
    throw new Error('BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set on the worker');
  }
  const tag = `[portal ${job.id.slice(0, 8)}]`;
  const log = (m: string) => console.log(`${tag} ${m}`);

  // Never register a client we have already registered in this portal. The
  // job may have waited (queued / parked for a code) while the status check
  // found the client in the portal, or a rep recorded the registration by
  // hand — so look again now, before a browser is paid for. The RPC closes
  // the job as 'cancelled' with result.skip_reason='already_registered_by_us'.
  if (job.kind === 'register') {
    const { data: skipped, error: skipErr } = await supabase.rpc('portal_registration_job_skip_if_registered', { p_job_id: job.id });
    if (skipErr) throw new Error(`portal_registration_job_skip_if_registered failed: ${skipErr.message}`);
    if (skipped === true) {
      log('client is already registered by us in this portal → skipped, no browser opened');
      return { outcome: 'skipped_registered' };
    }
  }

  // ── Inputs: the portal recipe + the three records the templates read ──────
  const [portal, client, project] = await Promise.all([
    loadRecord(supabase, job.portalRecordId),
    loadRecord(supabase, job.clientRecordId),
    loadRecord(supabase, job.projectRecordId),
  ]);
  if (!portal) throw new RecipeError('بطاقة البوابة غير موجودة', 'Portal record not found');
  const isCheck = job.kind === 'status_check';
  if (!client && !isCheck) throw new RecipeError('بطاقة العميل غير موجودة', 'Client record not found');
  const pd = portal.data ?? {};
  if (pd.is_active === false) throw new RecipeError('هذه البوابة غير نشطة', 'This portal is inactive');
  if (isCheck && (pd.status_recipe == null || str(pd.status_recipe).trim() === '')) {
    throw new RecipeError('لا توجد خطوات لفحص الحالات في هذه البوابة', 'This portal has no status-check recipe');
  }
  // Both throw a RecipeError BEFORE we pay for a browser.
  const steps: RecipeStep[] = parseRecipe(isCheck ? pd.status_recipe : pd.recipe);

  // Worker restarts (2026-10-05): a registration's LAST top-level phase is its
  // submit. Entering it marks the run 'committing' on the row; from then on a
  // restart must not start it again (the portal may already hold the client).
  // Before that, a SIGTERM hands the run back to the queue instead of letting
  // it die and be failed by the watchdog. A status check only reads, so it is
  // never committing.
  const totalPhases = countTopLevelPhases(steps);
  let phaseNo = 0;
  let committing = false;
  let handingBack = false;

  const portalScope = {
    name: str(pd.name),
    login_url: str(pd.login_url),
    login_id: str(pd.login_id) || str(pd.login_email) || (job.loginPhone ?? str(pd.login_phone)),
    login_phone: job.loginPhone ?? str(pd.login_phone),
    login_email: str(pd.login_email),
    login_password: str(pd.login_password),
    otp_channel: str(pd.otp_channel),
  };
  // Codes for this run are asked for on the ops WhatsApp (see header).
  const relay = job.origin === 'auto' && pd.otp_whatsapp_relay === true;
  const lead: Record<string, unknown> = { ...job.leadData };
  if (lead.project_name == null && project) lead.project_name = str(project.data?.project_name);
  if (lead.name == null && client) lead.name = str(client.data?.client_name);
  if (lead.phone == null && client) lead.phone = str(client.data?.phone_number);

  // ── Row helpers (all RPCs no-op once the row is no longer live) ──────────
  const rpc = async (fn: string, args: Record<string, unknown>): Promise<boolean> => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw new Error(`${fn} failed: ${error.message}`);
    return data === true;
  };
  // Empty labels are sent as NULL so the RPC's COALESCE keeps the current phase
  // (a screenshot append must not blank the label the rep is reading).
  const progress = (phase: string, ar: string, en: string, shot?: Record<string, unknown>) =>
    rpc('portal_registration_job_progress', {
      p_job_id: job.id, p_phase: phase || null, p_phase_ar: ar || null, p_phase_en: en || null, p_screenshot: shot ?? null,
    });
  const readRow = async () => {
    const { data, error } = await supabase
      .from('portal_registration_jobs')
      .select('status, input_value, input_request')
      .eq('id', job.id)
      .maybeSingle();
    if (error) throw new Error(`job row read failed: ${error.message}`);
    return (data ?? null) as { status: string; input_value: string | null; input_request: Record<string, unknown> | null } | null;
  };
  // Queue a WhatsApp from the ops line to the relay phone. Never throws: a
  // missed message must not fail a registration, but it must be visible.
  const relayNotify = async (body: string): Promise<void> => {
    if (!relay) return;
    const { data, error } = await supabase.rpc('portal_otp_relay_notify', { p_job_id: job.id, p_body: body });
    if (error) console.error(`${tag} relay WhatsApp failed: ${error.message}`);
    else if (data !== true) console.error(`${tag} relay WhatsApp NOT queued — no active ops number or no relay phone on the portal`);
  };
  const clientName = str(lead.name) || 'العميل';
  const projectLabel = str(lead.project_name) ? ` — مشروع «${str(lead.project_name)}»` : '';
  /** What this run is for, in the relay messages ("to register X" / "to check statuses"). */
  const purposeAr = isCheck ? 'لفحص حالات عملائنا' : `لتسجيل العميل «${clientName}»${projectLabel}`;
  const subjectAr = isCheck ? 'فحص حالات عملائنا' : `تسجيل العميل «${clientName}»`;

  const assertLive = async () => {
    const row = await readRow();
    if (!row || row.status === 'cancelled' || row.status === 'failed') throw new RecipeCancelledError();
  };

  // Automatic email OTP reader (Binghatti Gmail): null unless this is the fixed
  // Binghatti portal on the email channel with its OAuth secrets present — in
  // every other case the manual / WhatsApp-relay flow runs unchanged. Created
  // BEFORE the paid browser opens so a misconfiguration (e.g. a partial secret
  // set) fails loudly here; the reader itself makes no Gmail calls until the
  // recipe's prepare_email_otp step invokes prepareEmailOtp below.
  let emailOtpPage: Page | null = null;
  let gmailWaitEnded = false;
  let protectEmailOtpInput = false;
  const assertEmailDestination = () => assertBinghattiOtpDestination(emailOtpPage?.url() ?? '');
  const gmailOtp = createBinghattiGmailOtp(env, job.portalRecordId, portalScope.otp_channel, portalScope.login_id, {
    checkCancelled: async () => {
      if (handingBack || gmailWaitEnded) throw new RecipeCancelledError();
      assertEmailDestination();
      await assertLive();
    },
    heartbeat: async () => {
      if (!await rpc('portal_registration_job_heartbeat', { p_job_id: job.id })) throw new RecipeCancelledError();
    },
  });
  if (gmailOtp) assertBinghattiOtpDestination(portalScope.login_url);
  /** The single prepared email-OTP window (baseline BEFORE SendOTP). One at a
   *  time, single-use — see prepareEmailOtp / requestInput below. */
  let preparedEmailOtp: PreparedEmailOtp | null = null;

  await progress('starting', 'جارٍ فتح المتصفح…', 'Opening the browser…');

  // ── Browser ──────────────────────────────────────────────────────────────
  const contextId = await ensurePortalContext(supabase, env, job.portalRecordId, pd);
  const session = await createSession(env, contextId);
  let browser: Browser;
  try {
    await rpc('portal_registration_job_session', {
      p_job_id: job.id, p_session_id: session.id, p_live_view_url: session.liveViewUrl,
    });
    log(`browserbase session=${session.id} live=${session.liveViewUrl ? 'yes' : 'no'}`);
    browser = await chromium.connectOverCDP(session.connectUrl);
  } catch (error) {
    await releaseSession(env, session.id);
    throw error;
  }
  // On SIGTERM, close the browser: the current step throws at once, and the
  // catch below hands the run back. Polled because a Playwright step cannot be
  // interrupted any other way, and Fly kills the machine kill_timeout later.
  const shutdownWatch = setInterval(() => {
    if (handingBack || committing || !isShuttingDown?.()) return;
    handingBack = true;
    log('worker shutting down before the submit step — handing the run back to the queue');
    void browser.close().catch(() => {});
  }, 500);
  let shotIndex = 0;
  let cancelled = false;
  try {
    const ctx = browser.contexts()[0]!;
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    emailOtpPage = page;

    const screenshot = async (label: string, full = false): Promise<void> => {
      try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: full });
        const safe = label.replace(/[^a-zA-Z0-9؀-ۿ_-]+/g, '-').slice(0, 40) || 'shot';
        const path = `${job.id}/${String(++shotIndex).padStart(2, '0')}-${safe}.jpg`;
        const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: 'image/jpeg', upsert: true });
        if (error) {
          console.error(`${tag} screenshot upload failed: ${error.message}`);
          return;
        }
        await progress('', '', '', { path, label, at: new Date().toISOString() });
      } catch (err) {
        // Evidence is best-effort; never fail a registration because a picture failed.
        console.error(`${tag} screenshot failed: ${(err as Error).message}`);
      }
    };

    const requestInput = async (step: Extract<RecipeStep, { do: 'request_input' }>): Promise<string> => {
      await screenshot(`before-${step.key}`);
      // The mail reader serves OTP requests ONLY, and only when the recipe ran
      // prepare_email_otp for THIS key before clicking SendOTP — baselining now
      // (after the code was sent) could pick up an older mail, so a configured
      // reader without its prepared window fails loudly instead.
      let emailWindow: PreparedEmailOtp | null = null;
      if (gmailOtp && (step.kind ?? 'otp') === 'otp') {
        assertEmailDestination();
        if (!preparedEmailOtp || preparedEmailOtp.key !== step.key) {
          throw new RecipeError(
            'قراءة رمز البريد الإلكتروني غير مهيأة لهذه الخطوة — أضف خطوة prepare_email_otp قبل زر إرسال الرمز',
            `Email OTP reader is configured but has no prepared window for "${step.key}" — add a prepare_email_otp step before the click that sends the code`,
          );
        }
        emailWindow = preparedEmailOtp;
        // A baseline is single-use: the next SendOTP needs its own prepare step.
        preparedEmailOtp = null;
      }
      const ok = await rpc('portal_registration_job_request_input', {
        p_job_id: job.id,
        p_request: {
          key: step.key, kind: step.kind ?? 'otp', prompt_ar: step.prompt_ar, prompt_en: step.prompt_en,
          length: step.length ?? null, otp_channel: portalScope.otp_channel || null,
          // The claim RPC matches on this nonce, so it goes on the request ONLY
          // while an email window is active.
          ...(emailWindow ? { email_otp_nonce: emailWindow.nonce } : {}),
        },
      });
      if (!ok) throw new RecipeCancelledError();
      log(`awaiting input "${step.key}"`);
      const timeoutS = step.timeout_s ?? DEFAULT_INPUT_TIMEOUT_S;
      const waitMin = Math.round(timeoutS / 60);
      const ew = emailWindow;
      let value: string;
      try {
        value = await waitForPortalInput({
          key: step.key,
          timeoutMs: timeoutS * 1000,
          readRow,
          resumeManual: () => rpc('portal_registration_job_resume', { p_job_id: job.id }),
          checkCancelled: async () => {
            if (handingBack) throw new RecipeCancelledError();
            if (ew) assertEmailDestination();
            await assertLive();
          },
          heartbeat: async () => {
            if (!await rpc('portal_registration_job_heartbeat', { p_job_id: job.id })) throw new RecipeCancelledError();
          },
          notifyRelay: () => relayNotify(
            `🔐 وصلك الآن رمز تحقق من «${portalScope.name}» ${purposeAr}.\n` +
            `أرسل لي الرمز هنا${step.length ? ` (${step.length} أرقام)` : ''} خلال ${waitMin} دقائق.`,
          ),
          email: ew && gmailOtp ? {
            nonce: ew.nonce,
            findCandidate: (_remainingMs, signal) => {
              return gmailOtp.findCandidate(ew, step.length ?? 6, timeoutS * 1000, signal);
            },
            // NO code argument: SQL claims the opaque mailbox/message pair and
            // resumes ONLY this same awaiting key + nonce.
            claimCandidate: async (messageId) => {
              assertEmailDestination();
              await assertLive();
              const claimed = await rpc('portal_email_otp_claim', {
                p_job_id: job.id, p_key: step.key, p_mailbox_fingerprint: ew.mailboxFingerprint,
                p_message_id: messageId, p_request_nonce: ew.nonce,
              });
              if (claimed) protectEmailOtpInput = true;
              return claimed;
            },
            discardCandidate: (messageId) => {
              ew.baselineIds.push(messageId);
            },
          } : undefined,
        });
      } catch (err) {
        if (err instanceof PortalInputTimeoutError) {
          if (relay) throw new OtpRelayTimeoutError();
          throw new RecipeError(
            'انتهت مهلة انتظار الرمز — لم يُدخل خلال الوقت المحدد.',
            'Timed out waiting for the code — it was not entered in time.',
          );
        }
        throw err;
      } finally {
        if (ew) gmailWaitEnded = true;
      }
      if (protectEmailOtpInput) assertEmailDestination();
      // Deliberately generic: never log which channel answered or the code itself.
      log(`input "${step.key}" received`);
      return value;
    };

    const rt: RecipeRuntime = {
      page,
      scope: {
        lead,
        portal: portalScope,
        client: client?.data ?? {},
        project: project?.data ?? {},
        input: {},
        vars: {},
      },
      log,
      phase: async (ar, en) => {
        phaseNo += 1;
        if (!isCheck && totalPhases > 1 && phaseNo >= totalPhases) committing = true;
        await progress(committing ? 'committing' : 'step', ar, en);
      },
      screenshot,
      requestInput,
      // prepare_email_otp: verify the mailbox + snapshot the recent-message
      // baseline BEFORE the recipe clicks SendOTP. A new prepare ALWAYS clears
      // the previous window first, so a stale baseline can never validate a
      // later send. No reader (not Binghatti / no secrets) is a deliberate
      // no-op — the code then arrives manually or via the WhatsApp relay.
      // No mailbox/token/code logging here; the reader keeps its own opaque.
      prepareEmailOtp: async (key) => {
        preparedEmailOtp = null;
        if (!gmailOtp) return;
        assertEmailDestination();
        gmailWaitEnded = false;
        preparedEmailOtp = await gmailOtp.prepare(key);
      },
      checkCancelled: async () => {
        await assertLive();
        if (protectEmailOtpInput) assertEmailDestination();
      },
      heartbeat: async () => {
        if (!await rpc('portal_registration_job_heartbeat', { p_job_id: job.id })) throw new RecipeCancelledError();
      },
      authState: async (reused) => {
        if (!contextId) throw new RecipeError('حفظ جلسة الدخول غير مفعّل لهذه البوابة', 'Persistent context is not enabled for this portal');
        const { data, error } = await supabase.rpc('portal_browserbase_auth_state', { p_portal_record_id: job.portalRecordId, p_reused: reused });
        if (error) throw new Error(`portal_browserbase_auth_state failed: ${error.message}`);
        log(`authentication ${reused ? 'reused' : 'renewed'}: ${JSON.stringify(data ?? {})}`);
      },
      collected: isCheck ? [] : undefined,
      // `save_items` (the portal's unit cards) — read by the project-update
      // lane. One file per portal + key, overwritten each run; the private
      // bucket because broker pages carry commission terms.
      saveItems: async (key, payload) => {
        const safeKey = key.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'items';
        const path = `inventory/${job.portalRecordId}/${safeKey}.json`;
        await assertLive();
        if (payload.complete === true) {
          // save_json cannot upload a partial list, and an older capture must
          // not replace a newer snapshot if a delayed old run resumed.
          if (!Array.isArray(payload.items) || payload.items.length !== payload.totalCount) throw new Error('Incomplete JSON inventory rejected');
          const { data: previous, error: readError } = await supabase.storage.from(BUCKET).download(path);
          if (readError) {
            const status = 'statusCode' in readError ? String(readError.statusCode) : '';
            if (status !== '404' && !/^(object not found|the resource was not found)$/i.test(readError.message)) {
              throw new Error(`inventory snapshot freshness check failed: ${readError.message}`);
            }
          } else {
            if (!previous) throw new Error('Inventory freshness check returned no file');
            assertSnapshotIsNewer(payload.saved_at, JSON.parse(await previous.text()) as unknown);
          }
          await assertLive();
        }
        const body = JSON.stringify(payload);
        const { error } = await supabase.storage.from(BUCKET).upload(path, new Blob([body], { type: 'application/json' }), {
          contentType: 'application/json', upsert: true,
        });
        if (error) throw new Error(`save_items upload failed: ${error.message}`);
        log(`saved ${key} → ${path} (${body.length} bytes)`);
      },
      saveHtml: async (label: string) => {
        // Evidence for recipe authoring. NOT added to the screenshot list (the
        // chat card renders that list as images); the path is logged instead.
        const safe = label.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'page';
        const path = `${job.id}/${String(++shotIndex).padStart(2, '0')}-${safe}.html`;
        const { error } = await supabase.storage.from(BUCKET).upload(path, new Blob([await page.content()], { type: 'text/html' }), {
          contentType: 'text/html', upsert: true,
        });
        if (error) throw new Error(`save_html upload failed: ${error.message}`);
        log(`saved page HTML → ${path} (${page.url()})`);
      },
    };

    await progress('running',
      isCheck ? 'جارٍ قراءة قائمة العملاء في البوابة…' : 'جارٍ تنفيذ خطوات التسجيل…',
      isCheck ? 'Reading the portal client list…' : 'Running the registration steps…');
    await runSteps(steps, rt);

    if (isCheck) {
      if (!rt.didCollectRows) {
        const inventories = rt.savedInventories ?? [];
        if (!inventories.length) throw new RecipeError('لم تُقرأ حالات العملاء أو مخزون الوحدات', 'Status check captured neither client rows nor inventory');
        await screenshot('inventory-done');
        const total = inventories.reduce((count, item) => count + (item.totalCount ?? 0), 0);
        await relayNotify(`✅ حُفظ مخزون «${portalScope.name}»: ${total} وحدة، لاستخدامه في تحديث المشاريع.`);
        return { outcome: 'inventory_capture', portal_name: portalScope.name, inventories, final_url: page.url() };
      }
      const rows = rt.collected ?? [];
      const { data: summary, error: syncErr } = await supabase.rpc('portal_status_sync_apply', {
        p_job_id: job.id, p_rows: rows,
      });
      if (syncErr) throw new Error(`portal_status_sync_apply failed: ${syncErr.message}`);
      const sum = (summary ?? {}) as { rows?: number; matched?: number; created?: number; unmatched?: number; changed?: { client?: string; from?: string; to?: string }[] };
      const changed = sum.changed ?? [];
      log(`status check: ${rows.length} rows, ${sum.matched ?? 0} matched, ${sum.created ?? 0} new, ${changed.length} changed`);
      await relayNotify(
        `✅ فُحصت حالات عملائنا في «${portalScope.name}»: ${sum.matched ?? 0} عميلاً مطابقاً من ${rows.length}` +
        (changed.length
          ? `، تغيّر منها ${changed.length}:\n` + changed.map((c) => `• ${c.client ?? '—'}: «${c.from ?? '—'}» ← «${c.to ?? '—'}»`).join('\n')
          : '، لا تغييرات.'),
      );
      return { outcome: 'status_check', portal_name: portalScope.name, ...sum };
    }

    // Still past the submit: keep the row 'committing' so a restart now is never retried.
    await progress(isCheck ? 'finishing' : 'committing', 'جارٍ حفظ الإثبات…', 'Saving the proof…');
    await screenshot('done');
    const result = {
      outcome: 'done',
      final_url: page.url(),
      steps: steps.length,
      screenshots: shotIndex,
      portal_name: portalScope.name,
      project_name: str(lead.project_name),
    };

    // Activity trail on the client, so the /logs timeline and the client's
    // history both show "registered in portal X for project Y by Z".
    const { data: clientsModel } = await supabase.from('models').select('id').eq('name', 'clients').maybeSingle();
    const { error: logErr } = await supabase.from('activity_log').insert({
      category: 'record',
      event_type: 'portal_lead_registered',
      actor_user_id: job.userId,
      target_model_id: (clientsModel as { id: string } | null)?.id ?? null,
      target_record_id: job.clientRecordId,
      target_label: str(client?.data?.client_name) || null,
      summary_ar: `تم تسجيل العميل «${str(client?.data?.client_name)}» في بوابة «${portalScope.name}»${lead.project_name ? ` — مشروع «${str(lead.project_name)}»` : ''}`,
      summary_en: `Registered client "${str(client?.data?.client_name)}" in portal "${portalScope.name}"${lead.project_name ? ` — project "${str(lead.project_name)}"` : ''}`,
      details: { job_id: job.id, portal_record_id: job.portalRecordId, project_record_id: job.projectRecordId, final_url: page.url() },
      status: 'success',
    });
    if (logErr) console.error(`${tag} activity_log insert failed: ${logErr.message}`);
    await relayNotify(`✅ تم تسجيل العميل «${clientName}» في «${portalScope.name}»${projectLabel}.`);

    return result;
  } catch (err) {
    if (handingBack) {
      const { data: hb, error: hbErr } = await supabase.rpc('portal_registration_job_handback', { p_job_id: job.id });
      if (hbErr) throw new Error(`portal_registration_job_handback failed: ${hbErr.message}`);
      log(`handed back → ${String(hb)}`);
      // 'committing' would mean the row reached the submit after we decided —
      // then this is a real failure a person must check, not a restart.
      if (hb === 'committing') throw err;
      return { outcome: 'handed_back', handback: hb };
    }
    if (err instanceof RecipeCancelledError) {
      cancelled = true;
      log('cancelled by the rep (or swept) — closing the browser');
      return { outcome: 'cancelled' };
    }
    if (err instanceof OtpRelayTimeoutError) {
      // Nobody answered: close the browser (finally) and wait for a reply
      // instead of burning the one attempt this client gets.
      const { data: parked, error: parkErr } = await supabase.rpc('portal_registration_job_park', { p_job_id: job.id });
      if (parkErr) throw new Error(`portal_registration_job_park failed: ${parkErr.message}`);
      log(`code never arrived → ${String(parked)}`);
      if (parked === 'parked') {
        await relayNotify(
          `⏳ انتهت صلاحية الرمز ولم يكتمل ${subjectAr} في «${portalScope.name}» بعد.
` +
          'متى ما كنت متاحاً أرسل لي أي رسالة هنا، وسأطلب رمزاً جديداً فوراً.',
        );
      } else if (parked === 'failed') {
        await relayNotify(isCheck
          ? `❌ أوقفت محاولات ${subjectAr} في «${portalScope.name}» — لم يصل الرمز بعد عدة محاولات. سيُعاد الفحص في موعده القادم.`
          : `❌ أوقفت محاولات ${subjectAr} في «${portalScope.name}» — لم يصل الرمز بعد عدة محاولات. سجّله يدوياً من زر «التسجيل في البوابة».`);
      }
      return { outcome: 'parked', park_result: parked };
    }
    if (err instanceof RecipeError && err.outcome === 'already_registered') {
      // The portal ANSWERED: the client is already another broker's. Record it
      // as its own terminal status — not a failure a rep would retry forever.
      const { data: marked, error: markErr } = await supabase.rpc('portal_registration_job_already_registered', {
        p_job_id: job.id,
        p_message: `${err.ar}\n${err.en}`,
        p_result: { portal_name: portalScope.name, project_name: str(lead.project_name), step: err.stepIndex ?? null },
      });
      if (markErr) throw new Error(`portal_registration_job_already_registered failed: ${markErr.message}`);
      log(`portal says the client is already registered by another broker → ${marked ? 'recorded' : 'row no longer live'}`);
      if (marked) {
        const { data: clientsModel } = await supabase.from('models').select('id').eq('name', 'clients').maybeSingle();
        const { error: logErr } = await supabase.from('activity_log').insert({
          category: 'record',
          event_type: 'portal_lead_already_registered',
          actor_user_id: job.userId,
          target_model_id: (clientsModel as { id: string } | null)?.id ?? null,
          target_record_id: job.clientRecordId,
          target_label: str(client?.data?.client_name) || null,
          summary_ar: `بوابة «${portalScope.name}» أفادت أن العميل «${str(client?.data?.client_name)}» مسجّل مسبقاً لدى وسيط آخر${lead.project_name ? ` — مشروع «${str(lead.project_name)}»` : ''}`,
          summary_en: `Portal "${portalScope.name}" says client "${str(client?.data?.client_name)}" is already registered by another broker${lead.project_name ? ` — project "${str(lead.project_name)}"` : ''}`,
          details: { job_id: job.id, portal_record_id: job.portalRecordId, project_record_id: job.projectRecordId },
          status: 'success',
        });
        if (logErr) console.error(`${tag} activity_log insert failed: ${logErr.message}`);
        await relayNotify(`ℹ️ العميل «${clientName}» مسجّل مسبقاً لدى وسيط آخر في «${portalScope.name}»${projectLabel} — سُجّلت المعلومة في ملف العميل، ولن تُعاد المحاولة.`);
      }
      return { outcome: 'already_registered' };
    }
    if (relay) {
      const reason = err instanceof RecipeError ? err.ar : (err as Error).message;
      await relayNotify(`❌ تعذّر ${subjectAr} في «${portalScope.name}»: ${reason}`);
    }
    // Capture what the portal showed when it went wrong, then rethrow so the
    // loop marks the job failed with the bilingual message.
    try {
      const ctx = browser.contexts()[0];
      const page = ctx?.pages()[0];
      if (page) {
        const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
        const path = `${job.id}/${String(++shotIndex).padStart(2, '0')}-failure.jpg`;
        const { error } = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: 'image/jpeg', upsert: true });
        if (!error) await progress('', '', '', { path, label: 'failure', at: new Date().toISOString() });
      }
    } catch (shotErr) {
      console.error(`${tag} failure screenshot failed: ${(shotErr as Error).message}`);
    }
    throw err;
  } finally {
    clearInterval(shutdownWatch);
    await browser.close().catch(() => {});
    await releaseSession(env, session.id);
    // Browserbase documents a short synchronization delay after releasing a
    // persistent session. Hold the claimed job during that delay, preventing
    // the next job for this portal from loading a context before it is saved.
    if (contextId) await new Promise((resolve) => setTimeout(resolve, 3000));
    if (cancelled) log('browser closed after cancel');
  }
}
