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
 * Evidence trail: a JPEG screenshot per `screenshot` step plus one on success
 * and one on failure, uploaded to the PRIVATE `portal-registrations` bucket
 * under <job id>/…; the API signs them for the modal. The Browserbase live-view
 * URL is written onto the row so the rep can WATCH (and, if a portal does
 * something unexpected, take over in the embedded view).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { chromium } from 'playwright-core';
import type { WorkerEnv } from './env.js';
import {
  parseRecipe,
  runSteps,
  RecipeCancelledError,
  RecipeError,
  RecipeInterrupt,
  type RecipeRuntime,
  type RecipeStep,
} from './portals/recipe.js';

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
}

const BUCKET = 'portal-registrations';
const INPUT_POLL_MS = 1_500;
const HEARTBEAT_EVERY_POLLS = 4; // ≈ every 6 s while waiting
const DEFAULT_INPUT_TIMEOUT_S = 300;
/** The code wait ran out on a WhatsApp-relay run → park it, don't fail it. */
class OtpRelayTimeoutError extends RecipeInterrupt {
  constructor() {
    super('otp relay wait timed out');
  }
}

/** Browserbase session lifetime (seconds). Generous: sign-in + OTP wait + form. */
const SESSION_TIMEOUT_S = 20 * 60;

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
): Promise<{ id: string; connectUrl: string; liveViewUrl: string | null }> {
  const headers = { 'X-BB-API-Key': env.BROWSERBASE_API_KEY!, 'Content-Type': 'application/json' };
  const res = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      projectId: env.BROWSERBASE_PROJECT_ID,
      timeout: SESSION_TIMEOUT_S,
      proxies: [{ type: 'browserbase', geolocation: { country: 'SA', city: 'RIYADH' } }],
      browserSettings: { viewport: { width: 1280, height: 900 } },
    }),
  });
  const session = (await res.json()) as { id?: string; connectUrl?: string; message?: string };
  if (!session.id || !session.connectUrl) {
    throw new Error(`Browserbase session create failed: ${session.message ?? JSON.stringify(session).slice(0, 200)}`);
  }
  let liveViewUrl: string | null = null;
  try {
    const dbg = await fetch(`https://api.browserbase.com/v1/sessions/${session.id}/debug`, { headers });
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
    await fetch(`https://api.browserbase.com/v1/sessions/${id}`, {
      method: 'POST',
      headers: { 'X-BB-API-Key': env.BROWSERBASE_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: env.BROWSERBASE_PROJECT_ID, status: 'REQUEST_RELEASE' }),
    });
  } catch (err) {
    console.warn(`[portal] session release failed (will expire on its own): ${(err as Error).message}`);
  }
}

export async function runPortalRegistrationJob({ supabase, env, job }: RunArgs): Promise<Record<string, unknown>> {
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

  const portalScope = {
    name: str(pd.name),
    login_url: str(pd.login_url),
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

  await progress('starting', 'جارٍ فتح المتصفح…', 'Opening the browser…');

  // ── Browser ──────────────────────────────────────────────────────────────
  const session = await createSession(env);
  await rpc('portal_registration_job_session', {
    p_job_id: job.id, p_session_id: session.id, p_live_view_url: session.liveViewUrl,
  });
  log(`browserbase session=${session.id} live=${session.liveViewUrl ? 'yes' : 'no'}`);

  const browser = await chromium.connectOverCDP(session.connectUrl);
  let shotIndex = 0;
  let cancelled = false;
  try {
    const ctx = browser.contexts()[0]!;
    const page = ctx.pages()[0] ?? (await ctx.newPage());

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
      const ok = await rpc('portal_registration_job_request_input', {
        p_job_id: job.id,
        p_request: {
          key: step.key, kind: step.kind ?? 'otp', prompt_ar: step.prompt_ar, prompt_en: step.prompt_en,
          length: step.length ?? null, otp_channel: portalScope.otp_channel || null,
        },
      });
      if (!ok) throw new RecipeCancelledError();
      log(`awaiting input "${step.key}"`);
      const waitMin = Math.round((step.timeout_s ?? DEFAULT_INPUT_TIMEOUT_S) / 60);
      await relayNotify(
        `🔐 وصلك الآن رمز تحقق من «${portalScope.name}» ${purposeAr}.
` +
        `أرسل لي الرمز هنا${step.length ? ` (${step.length} أرقام)` : ''} خلال ${waitMin} دقائق.`,
      );
      const deadline = Date.now() + (step.timeout_s ?? DEFAULT_INPUT_TIMEOUT_S) * 1000;
      let polls = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, INPUT_POLL_MS));
        const row = await readRow();
        if (!row || row.status === 'cancelled' || row.status === 'failed') throw new RecipeCancelledError();
        if (row.status === 'awaiting_input' && row.input_value != null && row.input_value !== '') {
          const value = row.input_value.trim();
          await rpc('portal_registration_job_resume', { p_job_id: job.id });
          log(`input "${step.key}" received`);
          return value;
        }
        if (++polls % HEARTBEAT_EVERY_POLLS === 0) {
          await rpc('portal_registration_job_heartbeat', { p_job_id: job.id });
        }
      }
      if (relay) throw new OtpRelayTimeoutError();
      throw new RecipeError(
        'انتهت مهلة انتظار الرمز — لم يُدخل خلال الوقت المحدد.',
        'Timed out waiting for the code — it was not entered in time.',
      );
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
      phase: (ar, en) => progress('step', ar, en).then(() => undefined),
      screenshot,
      requestInput,
      checkCancelled: assertLive,
      collected: isCheck ? [] : undefined,
      // `save_items` (the portal's unit cards) — read by the project-update
      // lane. One file per portal + key, overwritten each run; the private
      // bucket because broker pages carry commission terms.
      saveItems: async (key, payload) => {
        const safeKey = key.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'items';
        const path = `inventory/${job.portalRecordId}/${safeKey}.json`;
        const body = JSON.stringify(payload);
        const { error } = await supabase.storage.from(BUCKET).upload(path, new Blob([body], { type: 'application/json' }), {
          contentType: 'application/json', upsert: true,
        });
        if (error) throw new Error(`save_items upload failed: ${error.message}`);
        log(`saved ${Object.values(payload.pages).reduce((a, p) => a + p.reduce((b, x) => b + x.length, 0), 0)} items → ${path} (${body.length} bytes)`);
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

    await progress('finishing', 'جارٍ حفظ الإثبات…', 'Saving the proof…');
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
    await browser.close().catch(() => {});
    await releaseSession(env, session.id);
    if (cancelled) log('browser closed after cancel');
  }
}
