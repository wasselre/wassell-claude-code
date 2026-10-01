/**
 * GET / POST /api/cron/release-sweep — the publishing clock.
 *
 * Publishing a finished creative is its own job now, separate from making it
 * (2026-09-14). This endpoint is that job's clock, and it does two things every
 * five minutes:
 *
 *   1. Every due release whose destination CAN publish by itself is handed to
 *      bundle.social, which then posts it at the scheduled moment. Nobody is
 *      asked to do anything. This is the half that makes the split an
 *      improvement rather than a bigger pile of tasks: without it, splitting
 *      publishing out would just mean more work items for a person.
 *
 *   2. Everything else goes to a person, through `mos_release_sweep()` — the
 *      switch is off, the account is not connected, the platform has no
 *      integration, the operator keeps it manual, or (below) the automatic
 *      handoff failed or was refused.
 *
 * A release that could not go out is NEVER left silent. Publishing tasks are
 * off (2026-09-27, operator rule), so `mos_release_open_task` records the reason
 * on the release instead (`mos_publications.hold_reason`, 2026-09-29) and the
 * month page's «يحتاج قرارك» lists it with «انشر الآن / أعد الجدولة / ألغِ».
 * Before that, the function returned NULL and 12 releases missed their dates
 * with nobody told — the same lesson as every other silent-failure bug here.
 *
 * Idempotence is inherited, not re-invented: `publishPublication` refuses a
 * publication that already has a live bundle post unless the prior attempt is
 * dead, so a double tick cannot create a second live post.
 *
 * Runs on Node with a real time budget (2026-09-30). It was an edge function,
 * which Vercel stops 25 seconds after it starts — and ONE handoff (bundle
 * fetching the file, then creating the post) takes 8–20 s. Every tick with more
 * than one release to send returned 504, and a stop landing between "post
 * created" and "post recorded" leaves a live post this database does not know,
 * which the next tick would create again. No handoff STARTS after
 * TIME_BUDGET_MS, so the one in flight always has room to finish.
 *
 * A handoff that failed is retried a few times and then left for a person — the
 * count and the stop live in `mos_release_open_task` / `mos_release_due`
 * (2026-09-30). Before that a failed release was re-sent every tick for as long
 * as it stayed due, re-uploading its file each time: one night of that used up
 * the month's upload quota on bundle.social.
 *
 * An Instagram feed post goes out with its ROW (2026-10-01, `instagramGrid.ts`):
 * the publisher hands all three of the row's feed posts off in one call, or
 * none. The answer names the row's posts, and the sweep skips them for the rest
 * of the tick — otherwise it would re-check (or, after a failure, re-send) the
 * same row once per member. A row that fails is counted on every post that was
 * to go, so the whole row stops after the same few attempts as a single release.
 *
 * Time: one row handoff is three uploads + three posts, up to ~60 s. No handoff
 * starts after TIME_BUDGET_MS (200 s), so the last row begun still ends inside
 * the 300 s limit.
 *
 * Auth: Bearer $CRON_SECRET or ?secret= for smoke tests. Always 200 so Vercel
 * never marks the cron failed; the structured body carries every outcome and
 * failures are ALSO console.error-ed.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { loadBundleConfig } from '../_lib/marketing/bundleSocial.js';
import { publishPublication } from '../_lib/marketing/publishRelease.js';

export const config = { runtime: 'nodejs', maxDuration: 300 };

/** Never hand off more than this in one tick — a backlog drains over ticks
 *  instead of hammering bundle.social. */
const MAX_PER_TICK = 10;

/** No handoff starts after this. One handoff takes up to ~20 s, so the last
 *  one begun still ends well inside the 300 s limit and before the next tick. */
const TIME_BUDGET_MS = 200_000;

/**
 * A release this far past its moment is NOT posted automatically.
 *
 * Publishing is outward-facing and irreversible. A row dated last month —
 * imported, restored, or left behind by a campaign nobody finished — must not
 * suddenly appear on the company's real Instagram because a sweep noticed it.
 * Past this window the release becomes a task instead, and a person decides
 * whether it is still worth posting. Overridable via
 * `mos_settings.planning.release_stale_hours`.
 */
const DEFAULT_STALE_HOURS = 24;

interface DueRow {
  release_id: string;
  content_id: string;
  platform: string;
  account_id: string | null;
  due_at: string | null;
  automatable: boolean;
  reason: string | null;
  open_task_id: string | null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function nodeToWebRequest(nodeReq: IncomingMessage): Request {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  // The cron takes no body — GET and POST are read the same way.
  return new Request(url.toString(), { method: 'GET', headers });
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const res = await run(nodeToWebRequest(nodeReq));
  nodeRes.statusCode = res.status;
  nodeRes.setHeader('content-type', 'application/json');
  nodeRes.end(await res.text());
}

async function run(req: Request): Promise<Response> {
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

  // 1 — raise a task for everything a PERSON has to do.
  const swept = await sb.rpc('mos_release_sweep');
  if (swept.error) {
    console.error('[release-sweep] mos_release_sweep failed', swept.error.code, swept.error.message);
    out.manual = { error: swept.error.message };
  } else {
    out.manual = swept.data;
  }

  // 2 — hand the automatic ones to bundle.social.
  const cfg = loadBundleConfig();
  if (!cfg) {
    // Not an error: a tenant without organic posting configured simply has no
    // automatic half. Said out loud rather than silently skipped.
    out.automatic = { skipped: 'bundle.social is not configured' };
    out.ms = Date.now() - startedAt;
    return json(out, 200);
  }

  const due = await sb.rpc('mos_release_due', { p_horizon_minutes: null });
  if (due.error) {
    console.error('[release-sweep] mos_release_due failed', due.error.code, due.error.message);
    out.automatic = { error: due.error.message };
    out.ms = Date.now() - startedAt;
    return json(out, 200);
  }

  // How stale is too stale, from settings.
  const settings = await sb.from('mos_settings').select('value').eq('key', 'planning').maybeSingle();
  const rawHours = (settings.data as { value?: Record<string, unknown> } | null)?.value?.release_stale_hours;
  const staleHours = Number.isFinite(Number(rawHours)) && Number(rawHours) > 0
    ? Number(rawHours) : DEFAULT_STALE_HOURS;
  const staleBefore = Date.now() - staleHours * 3600_000;

  const candidates = ((due.data as DueRow[] | null) ?? [])
    .filter((r) => r.automatable === true)
    // Something already went wrong on this one and a person has been asked;
    // do not race them. (Only ever set while publishing TASKS are on. With
    // them off — the live setting — the stop is `mos_release_due` no longer
    // offering a release whose handoff has failed too many times.)
    .filter((r) => r.open_task_id === null);

  const stale = candidates.filter(
    (r) => r.due_at !== null && Date.parse(r.due_at) < staleBefore,
  );
  const rows = candidates
    .filter((r) => !stale.includes(r))
    .slice(0, MAX_PER_TICK);

  // Too old to post on its own — hand it to a person with the reason, rather
  // than publishing something whose moment passed or leaving it silent. With
  // publishing tasks off (2026-09-27) this records a HOLD on the release, which
  // the month page lists with «انشر الآن / أعد الجدولة / ألغِ».
  for (const r of stale) {
    const opened = await sb.rpc('mos_release_open_task', {
      p_publication_id: r.release_id,
      p_reason: 'stale',
      p_detail: `تجاوز موعده بأكثر من ${staleHours} ساعة فلم يُنشر آليًا — انشره الآن أو أعد جدولته أو ألغِه.`,
    });
    if (opened.error) {
      console.error('[release-sweep] could not open the stale task', r.release_id, opened.error.message);
    }
  }

  let published = 0;
  let refused = 0;
  let notStarted = 0;
  let withTheirRow = 0;
  const failures: Array<{ release_id: string; platform: string; error: string }> = [];
  // Releases already dealt with this tick as part of an Instagram row — sent,
  // refused or failed together with the member that came up first.
  const handledWithRow = new Set<string>();

  for (const [i, r] of rows.entries()) {
    if (handledWithRow.has(r.release_id)) {
      withTheirRow += 1;
      continue;
    }
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      // Out of time: the rest stay due and the next tick takes them. Said out
      // loud — a quiet short tick would read as "nothing left to send".
      notStarted = rows.length - i;
      console.error('[release-sweep] time budget reached —', notStarted, 'release(s) left for the next tick');
      break;
    }
    let ok = false;
    let wasRefused = false;
    let message = '';
    // The row's posts, when this release went (or failed) with its row.
    let rowAll: string[] = [];
    let rowToSend: string[] = [];
    let rowHandedOff: string[] = [];
    try {
      const res = await publishPublication(sb, cfg, r.release_id);
      ok = res.status >= 200 && res.status < 300;
      wasRefused = res.status === 422;
      const parsed = await res.clone().json().catch(() => null) as {
        error?: unknown;
        row?: { release_ids?: unknown; to_send?: unknown; handed_off?: unknown };
      } | null;
      const ids = (v: unknown): string[] =>
        (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
      rowAll = ids(parsed?.row?.release_ids);
      rowToSend = ids(parsed?.row?.to_send);
      rowHandedOff = ids(parsed?.row?.handed_off);
      if (!ok) message = typeof parsed?.error === 'string' ? parsed.error : `HTTP ${res.status}`;
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    for (const id of rowAll) handledWithRow.add(id);

    if (ok) {
      published += Math.max(1, rowHandedOff.length);
      continue;
    }

    if (wasRefused) {
      // The material rule or the platform rulebook said no, and has ALREADY
      // recorded why on the release (still in production, not approved, the
      // approved files changed, …). That is not a failed handoff: nothing was
      // uploaded, asking again costs nothing, and it clears itself the moment
      // the content is approved. So it is not relabelled `publish_failed` —
      // that reason is counted and stops the retries after a few attempts,
      // which would strand a post that was merely approved late.
      refused += 1;
      continue;
    }

    // Loud, and turned into visible work. A release that could not be handed
    // off must never sit silently in `planned`. Each call is counted by the
    // database; after `planning.release_max_attempts` the release stops being
    // offered and waits for «انشر الآن» or a new time. A row that failed is
    // recorded on every post that was to go with it, so the row stops whole.
    console.error('[release-sweep] automatic publish failed', r.release_id, r.platform, message);
    failures.push({ release_id: r.release_id, platform: r.platform, error: message });
    const failedIds = rowToSend.length > 0 ? rowToSend : [r.release_id];
    for (const id of failedIds) {
      const opened = await sb.rpc('mos_release_open_task', {
        p_publication_id: id,
        p_reason: 'publish_failed',
        p_detail: `فشل النشر الآلي على ${r.platform}: ${message.slice(0, 400)}`,
      });
      if (opened.error) {
        console.error('[release-sweep] could not open the failure task', id, opened.error.message);
      }
    }
  }

  out.automatic = {
    considered: ((due.data as DueRow[] | null) ?? []).length,
    handed_off: published,
    failed: failures.length,
    failures,
    refused_not_ready: refused,
    went_with_their_row: withTheirRow,
    too_stale_to_post: stale.length,
    stale_hours: staleHours,
    capped: rows.length === MAX_PER_TICK,
    left_for_next_tick: notStarted,
  };
  out.ms = Date.now() - startedAt;
  return json(out, 200);
}
