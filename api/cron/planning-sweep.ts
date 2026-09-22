/**
 * GET / POST /api/cron/planning-sweep — the campaign-planning clock.
 *
 * Every 10 minutes (vercel.json):
 *   1. `mos_plan_start_due()` — opens the FIRST workflow task for planned
 *      content whose `production_start` has arrived. This is why the commit
 *      does not open tasks: a campaign approved three weeks early should not
 *      dump twenty tasks into the queue today. Paid replacement slots get their
 *      content shells created here too, at each cycle's `production_start_on`.
 *   2. `mos_plan_repair()` — marks reservations whose window has passed but
 *      whose step never opened as `stale` (it no longer re-dates anything —
 *      plan-driven assignment, 2026-09-22: a wrong plan is re-planned, not
 *      nudged), moves production plans to `at_risk` / `late`, lets each
 *      publishing batch take the rollup view's verdict, and runs the
 *      publication-risk sweep over open tasks.
 *
 *   2b. Completion side effects a crashed API response left `pending` on a
 *      completion event (the approved asset's promote, the Meta ad hand-off)
 *      are re-run (`mos_completion_pending_effects`, ≥ 2 minutes old). Every
 *      element is idempotent — the Meta job id is derived from the event —
 *      so a re-run can never enqueue a second ad.
 *
 *      **It raises no task.** This header said until 2026-09-15 that "a batch
 *      at risk raises ONE `plan_conflict` task for the manager with the
 *      options". Checked against the live `pg_get_functiondef`: the function
 *      ends at `jsonb_build_object('staled',…,'batches',…)` and writes nothing
 *      to `mos_manual_tasks`. The only writer of a `plan_conflict` task in the
 *      repo is `worker/src/runRefreshCycleJob.ts` (the partial-refresh and
 *      slate-cap branches). A reader who believed this comment would have gone
 *      looking for a manager task that never arrives.
 *
 *   3. The next-month reminder (build plan F7). «اختيار مشاريع نوفمبر مطلوب
 *      خلال ٥ أيام» — the one date on the operator's calendar the month model
 *      depends on, because production for the first week starts about ten
 *      working days before it publishes. It rides THIS cron on purpose:
 *      `vercel.json` already declares ten crons, which is the plan's limit, so
 *      an eleventh schedule cannot be claimed. `npm run build` does not
 *      validate `vercel.json`, so that ceiling is only ever discovered at
 *      deploy time.
 *
 * The refresh-cycle clock lives in the Fly worker (it has to talk to Meta);
 * this endpoint is the database-only half.
 *
 * Auth: Bearer $CRON_SECRET or ?secret= for smoke tests. Always 200 so Vercel
 * never marks the cron failed; the structured body carries each step's outcome
 * and any error is ALSO console.error-ed (repo rule: fail loudly, never
 * silently).
 */
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { monthGeometry, parseMonthTemplate } from '../_lib/marketing/planning/monthCompiler.js';
import { ensureMonthMetaCampaigns } from '../_lib/marketing/planning/monthMeta.js';
import {
  loadPlanningSettings, loadWorkCalendar, riyadhToday,
} from '../_lib/marketing/planning/snapshot.js';
import { recoverPendingEffects } from '../_lib/marketing/completionEffects.js';

export const config = { runtime: 'edge' };

/** Fire-and-forget /wake ping to the Fly worker so a recovered Meta job skips
 *  the poll latency (same posture as /api/marketing-os). */
function wakeWorker(): void {
  const base = process.env.WASSEL_DECK_WORKER_URL;
  if (!base) return;
  void fetch(`${base.replace(/\/$/, '')}/wake`, { method: 'POST' }).catch(() => {
    /* best-effort by design */
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/* ------------------------------------------------------------------ */
/* the next-month reminder                                             */
/* ------------------------------------------------------------------ */

/**
 * Gregorian month names as Wassel writes them («أكتوبر», «نوفمبر»), spelled out
 * rather than resolved through `Intl`: this handler runs on the Edge runtime,
 * whose ICU data is not guaranteed to carry Arabic month names, and a reminder
 * that reads «October» to an Arabic operator is a small daily insult.
 */
const MONTH_AR = [
  'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
  'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
] as const;
const MONTH_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

/** `١٢` — Arabic-Indic digits, the house numeral set. */
const arDigits = (v: number | string): string =>
  String(v).replace(/[0-9]/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d);

/** `2026-11` → `نوفمبر ٢٠٢٦` / `November 2026`. */
function monthName(key: string, isAr: boolean): string {
  const m = Number(key.slice(5, 7)) - 1;
  const y = key.slice(0, 4);
  return isAr
    ? `${MONTH_AR[m] ?? key} ${arDigits(y)}`
    : `${MONTH_EN[m] ?? key} ${y}`;
}

/** `2026-10-20` → `٢٠ أكتوبر` / `20 October`. */
function dayName(day: string, isAr: boolean): string {
  const m = Number(day.slice(5, 7)) - 1;
  const d = String(Number(day.slice(8, 10)));
  return isAr ? `${arDigits(d)} ${MONTH_AR[m] ?? ''}`.trim() : `${d} ${MONTH_EN[m] ?? ''}`.trim();
}

/** «يوم واحد» / «يومين» / «٣ أيام» / «١٢ يومًا» — a day count that reads. */
function arDuration(n: number): string {
  if (n === 1) return 'يوم واحد';
  if (n === 2) return 'يومين';
  if (n <= 10) return `${arDigits(n)} أيام`;
  return `${arDigits(n)} يومًا`;
}

/** `2026-10` + 1 → `2026-11`. Pure arithmetic; no Date, no timezone. */
function addMonthKey(key: string, n: number): string {
  const total = Number(key.slice(0, 4)) * 12 + (Number(key.slice(5, 7)) - 1) + n;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Whole calendar days from `from` to `to`. Both are `YYYY-MM-DD`. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * Raise «اختيار مشاريع {الشهر} مطلوب» when a month that still needs choosing has
 * reached its reminder date, and stop the moment that month is compiled.
 *
 * "Compiled" is read off `mos_content_rows`: the commit creates the month's
 * rows with their `batch_day`, so a month with a row inside its posting window
 * has been confirmed. That is a fact about the work, not a flag someone has to
 * remember to set.
 *
 * Bounded three ways, so this can never become a daily drone:
 *   • `mos_month_template.enabled = false` (the §6 rollback lever) silences it;
 *   • a month that has already STARTED publishing is skipped — choosing it is
 *     no longer a planning act, and what is actually wrong with a running month
 *     is the exceptions list's job, not a reminder's. This is also what stops
 *     the first tick after the switch is flipped from nagging about the month
 *     already half over;
 *   • one notification per month per ~day, deduped on the notification row.
 */
async function nextMonthReminder(
  sb: ReturnType<typeof getServiceSupabase>,
): Promise<Record<string, unknown>> {
  const tplRes = await sb.from('mos_month_template').select('*').limit(1).maybeSingle();
  if (tplRes.error) {
    console.error('[planning-sweep] mos_month_template read failed',
      tplRes.error.code, tplRes.error.message);
    return { error: tplRes.error.message };
  }
  const row = (tplRes.data ?? null) as Record<string, unknown> | null;
  if (!row) return { skipped: 'no month template row' };
  if (row.enabled !== true) return { skipped: 'month model disabled' };

  const template = parseMonthTemplate(row);
  const settings = await loadPlanningSettings(sb);
  const calendar = await loadWorkCalendar(sb, settings);
  const today = riyadhToday();

  // This month, then the next two. Reminder dates rise with the month, so the
  // first candidate that is not yet due ends the search.
  const thisMonth = today.slice(0, 7);
  for (let i = 0; i < 3; i += 1) {
    const month = addMonthKey(thisMonth, i);
    const geo = monthGeometry(month, template, calendar);

    // A month that is already publishing is past choosing. The reminder runs
    // from its own date up to the day before the month's first row goes out,
    // and the overdue tail («تجاوز الموعد») is the loud part of that window.
    if (geo.firstPostingDay <= today) continue;

    const rows = await sb.from('mos_content_rows').select('id')
      .gte('batch_day', geo.firstPostingDay).lte('batch_day', geo.lastPostingDay).limit(1);
    if (rows.error) {
      console.error('[planning-sweep] mos_content_rows read failed',
        rows.error.code, rows.error.message);
      return { error: rows.error.message };
    }
    if ((rows.data ?? []).length > 0) continue; // already compiled

    if (today < geo.nextMonthReminderOn) {
      return { due: false, next_month: month, reminder_on: geo.nextMonthReminderOn };
    }

    // Dedupe on the notification the last run wrote. 20 hours rather than 24 so
    // the reminder keeps landing at roughly the same hour instead of creeping
    // ten minutes later every day until it falls out of the working day.
    const url = `/m/month?m=${month}`;
    const since = new Date(Date.now() - 20 * 3_600_000).toISOString();
    const seen = await sb.from('notifications').select('id')
      .eq('kind', 'month_selection_due').eq('url', url).gte('created_at', since).limit(1);
    if (seen.error) {
      console.error('[planning-sweep] notifications read failed', seen.error.code, seen.error.message);
      return { error: seen.error.message };
    }
    if ((seen.data ?? []).length > 0) {
      return { due: true, month, already_sent: true, deadline: geo.productionStart };
    }

    const left = daysBetween(today, geo.productionStart);
    const whenAr = left > 0
      ? `خلال ${arDuration(left)}`
      : left === 0 ? 'اليوم' : `متأخر ${arDuration(-left)}`;
    const whenEn = left > 0 ? `in ${left} day${left === 1 ? '' : 's'}`
      : left === 0 ? 'today' : `${-left} day${left === -1 ? '' : 's'} overdue`;

    const emit = await sb.rpc('notify_emit', {
      p_workspace: 'marketing',
      p_event: 'month_selection_due',
      p_role_keys: ['mos_marketing_manager', 'mos_ceo'],
      p_user_ids: [],
      p_title_ar: `اختيار مشاريع ${monthName(month, true)} مطلوب ${whenAr}`,
      p_title_en: `${monthName(month, false)}’s projects are due ${whenEn}`,
      p_body_ar: `الموعد ${dayName(geo.productionStart, true)} — الإنتاج يبدأ في اليوم نفسه، وهو `
        + `${arDigits(template.leadTimeWorkingDays)} يوم عمل قبل أول صف عضوي في `
        + `${dayName(geo.firstPostingDay, true)}. افتح صفحة الشهر وأبقِ المشاريع أو غيّرها ثم اعتمد.`,
      p_body_en: `The deadline is ${dayName(geo.productionStart, false)} — production starts that same `
        + `day, ${template.leadTimeWorkingDays} working days before the first organic row on `
        + `${dayName(geo.firstPostingDay, false)}. Open the month page, keep or swap the projects, and confirm.`,
      p_url: url,
    });
    if (emit.error) {
      console.error('[planning-sweep] notify_emit failed', emit.error.code, emit.error.message);
      return { error: emit.error.message, month };
    }
    return {
      due: true, month, sent: true, recipients: emit.data,
      deadline: geo.productionStart, days_left: left,
    };
  }

  return { due: false, reason: 'every candidate month is already compiled' };
}

/* ------------------------------------------------------------------ */
/* handler                                                             */
/* ------------------------------------------------------------------ */

export default async function handler(req: Request): Promise<Response> {
  const startedAt = Date.now();

  const expected = process.env.CRON_SECRET;
  if (!expected) return json({ error: 'CRON_SECRET is not set; refusing to run' }, 500);
  const url = new URL(req.url);
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const sent = bearer || url.searchParams.get('secret') || '';
  if (sent !== expected) return json({ error: 'unauthorized' }, 401);

  const sb = getServiceSupabase();
  const out: Record<string, unknown> = {};

  // 1 — open what is due to start.
  const started = await sb.rpc('mos_plan_start_due');
  if (started.error) {
    console.error('[planning-sweep] mos_plan_start_due failed', started.error.code, started.error.message);
    out.start_due = { error: started.error.message };
  } else {
    out.start_due = started.data;
  }

  // 2 — repair drift and re-rate the batches.
  const repaired = await sb.rpc('mos_plan_repair', { p_campaign_id: null });
  if (repaired.error) {
    console.error('[planning-sweep] mos_plan_repair failed', repaired.error.code, repaired.error.message);
    out.repair = { error: repaired.error.message };
  } else {
    out.repair = repaired.data;
  }

  // 2b — completion side effects left pending (asset promote, Meta ad). A
  //      failure here is reported and does not stop the sweep.
  try {
    out.pending_effects = await recoverPendingEffects(sb, { wake: wakeWorker });
  } catch (e) {
    console.error('[planning-sweep] pending completion effects threw', e);
    out.pending_effects = { error: e instanceof Error ? e.message : String(e) };
  }

  // 3 — the next-month reminder. A failure here is reported and does not stop
  //     the sweep: the two steps above are the ones work depends on.
  try {
    out.next_month_reminder = await nextMonthReminder(sb);
  } catch (e) {
    console.error('[planning-sweep] next-month reminder threw', e);
    out.next_month_reminder = { error: e instanceof Error ? e.message : String(e) };
  }

  // 4 — E6: the month's paid campaigns in Meta (campaign + feed/story pair).
  //     Normally built at confirm; this is the retry for a Meta refusal
  //     (hourly per execution at most) and the backfill for a month confirmed
  //     before E6 existed.
  try {
    const meta = await ensureMonthMetaCampaigns(sb);
    out.month_meta = meta.error ? { error: meta.error } : meta.results.filter((r) => r.outcome !== 'already_linked');
  } catch (e) {
    console.error('[planning-sweep] month Meta build threw', e);
    out.month_meta = { error: e instanceof Error ? e.message : String(e) };
  }

  out.ms = Date.now() - startedAt;
  return json(out, 200);
}
