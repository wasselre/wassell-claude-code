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
 *   2. Everything else raises a publication task, through `mos_release_sweep()`
 *      — the account is not connected, the platform has no integration, the
 *      operator keeps it manual, or (below) the automatic handoff failed.
 *
 * A failed handoff is NEVER left silent. It opens a `publish` task carrying the
 * platform's own error, so a release that could not go out is visible work
 * rather than a row quietly sitting in `planned` forever. That is the same
 * lesson as every other silent-failure bug in this repo.
 *
 * Idempotence is inherited, not re-invented: `publishPublication` refuses a
 * publication that already has a live bundle post unless the prior attempt is
 * dead, so a double tick cannot create a second live post.
 *
 * Auth: Bearer $CRON_SECRET or ?secret= for smoke tests. Always 200 so Vercel
 * never marks the cron failed; the structured body carries every outcome and
 * failures are ALSO console.error-ed.
 */
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { loadBundleConfig } from '../_lib/marketing/bundleSocial.js';
import { publishPublication } from '../_lib/marketing/publishRelease.js';

export const config = { runtime: 'edge' };

/** Never hand off more than this in one tick — a backlog drains over ticks
 *  instead of hammering bundle.social (and blowing the edge time budget). */
const MAX_PER_TICK = 10;

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
    // do not race them.
    .filter((r) => r.open_task_id === null);

  const stale = candidates.filter(
    (r) => r.due_at !== null && Date.parse(r.due_at) < staleBefore,
  );
  const rows = candidates
    .filter((r) => !stale.includes(r))
    .slice(0, MAX_PER_TICK);

  // Too old to post on its own — hand it to a person with the reason, rather
  // than publishing something whose moment passed or leaving it silent.
  for (const r of stale) {
    const opened = await sb.rpc('mos_release_open_task', {
      p_publication_id: r.release_id,
      p_reason: 'manual',
      p_detail: `تجاوز موعده بأكثر من ${staleHours} ساعة — لم يُنشر آليًا. قرّر: انشره الآن أو ألغِه.`,
    });
    if (opened.error) {
      console.error('[release-sweep] could not open the stale task', r.release_id, opened.error.message);
    }
  }

  let published = 0;
  const failures: Array<{ release_id: string; platform: string; error: string }> = [];

  for (const r of rows) {
    let ok = false;
    let message = '';
    try {
      const res = await publishPublication(sb, cfg, r.release_id);
      ok = res.status >= 200 && res.status < 300;
      if (!ok) {
        const parsed = await res.clone().json().catch(() => null) as { error?: unknown } | null;
        message = typeof parsed?.error === 'string' ? parsed.error : `HTTP ${res.status}`;
      }
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }

    if (ok) {
      published += 1;
      continue;
    }

    // Loud, and turned into visible work. A release that could not be handed
    // off must never sit silently in `planned`.
    console.error('[release-sweep] automatic publish failed', r.release_id, r.platform, message);
    failures.push({ release_id: r.release_id, platform: r.platform, error: message });
    const opened = await sb.rpc('mos_release_open_task', {
      p_publication_id: r.release_id,
      p_reason: 'publish_failed',
      p_detail: `فشل النشر الآلي على ${r.platform}: ${message.slice(0, 400)}`,
    });
    if (opened.error) {
      console.error('[release-sweep] could not open the failure task', r.release_id, opened.error.message);
    }
  }

  out.automatic = {
    considered: ((due.data as DueRow[] | null) ?? []).length,
    handed_off: published,
    failed: failures.length,
    failures,
    too_stale_to_post: stale.length,
    stale_hours: staleHours,
    capped: rows.length === MAX_PER_TICK,
  };
  out.ms = Date.now() - startedAt;
  return json(out, 200);
}
