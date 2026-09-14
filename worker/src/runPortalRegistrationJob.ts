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
  type RecipeRuntime,
  type RecipeStep,
} from './portals/recipe.js';

/** Shape of a claimed portal_registration_jobs row (the columns we use). */
export interface PortalRegistrationJob {
  id: string;
  portalRecordId: string;
  clientRecordId: string;
  projectRecordId: string | null;
  userId: string;
  leadData: Record<string, unknown>;
  loginPhone: string | null;
  attempts: number;
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

  // ── Inputs: the portal recipe + the three records the templates read ──────
  const [portal, client, project] = await Promise.all([
    loadRecord(supabase, job.portalRecordId),
    loadRecord(supabase, job.clientRecordId),
    loadRecord(supabase, job.projectRecordId),
  ]);
  if (!portal) throw new RecipeError('بطاقة البوابة غير موجودة', 'Portal record not found');
  if (!client) throw new RecipeError('بطاقة العميل غير موجودة', 'Client record not found');
  const pd = portal.data ?? {};
  if (pd.is_active === false) throw new RecipeError('هذه البوابة غير نشطة', 'This portal is inactive');
  const steps: RecipeStep[] = parseRecipe(pd.recipe); // throws a RecipeError BEFORE we pay for a browser

  const portalScope = {
    name: str(pd.name),
    login_url: str(pd.login_url),
    login_phone: job.loginPhone ?? str(pd.login_phone),
    login_email: str(pd.login_email),
    login_password: str(pd.login_password),
    otp_channel: str(pd.otp_channel),
  };
  const lead: Record<string, unknown> = { ...job.leadData };
  if (lead.project_name == null && project) lead.project_name = str(project.data?.project_name);
  if (lead.name == null) lead.name = str(client.data?.client_name);
  if (lead.phone == null) lead.phone = str(client.data?.phone_number);

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
        client: client.data ?? {},
        project: project?.data ?? {},
        input: {},
        vars: {},
      },
      log,
      phase: (ar, en) => progress('step', ar, en).then(() => undefined),
      screenshot,
      requestInput,
      checkCancelled: assertLive,
    };

    await progress('running', 'جارٍ تنفيذ خطوات التسجيل…', 'Running the registration steps…');
    await runSteps(steps, rt);

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
      target_label: str(client.data?.client_name) || null,
      summary_ar: `تم تسجيل العميل «${str(client.data?.client_name)}» في بوابة «${portalScope.name}»${lead.project_name ? ` — مشروع «${str(lead.project_name)}»` : ''}`,
      summary_en: `Registered client "${str(client.data?.client_name)}" in portal "${portalScope.name}"${lead.project_name ? ` — project "${str(lead.project_name)}"` : ''}`,
      details: { job_id: job.id, portal_record_id: job.portalRecordId, project_record_id: job.projectRecordId, final_url: page.url() },
      status: 'success',
    });
    if (logErr) console.error(`${tag} activity_log insert failed: ${logErr.message}`);

    return result;
  } catch (err) {
    if (err instanceof RecipeCancelledError) {
      cancelled = true;
      log('cancelled by the rep (or swept) — closing the browser');
      return { outcome: 'cancelled' };
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
