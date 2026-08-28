/**
 * GET / POST /api/cron/perf-sweep — the marketing performance system's clock.
 *
 * Every 10 minutes (vercel.json):
 *   1. mos_perf_late_sweep() — flags open tasks past their SLA due, records
 *      late events and month-ordinal discipline actions (1-3 warning, 4+
 *      deduction — all created 'pending'; approval is always human).
 *   2. Once a day (the 04:0x Riyadh run): pulls RANGED Meta insights for the
 *      current month + the just-closed month and upserts mos_perf_paid_monthly
 *      — the audit trail monthly CPL/CTR bonuses are judged against. The live
 *      mos_campaign_executions numbers are LIFETIME totals and cannot answer
 *      "what did August cost" (spec §8.1); this snapshot can.
 *
 * Auth: same as the other crons — Bearer $CRON_SECRET or ?secret= for smoke
 * tests. Self-disabling: no Meta env → the monthly pull is skipped, the late
 * sweep still runs. Always 200 so Vercel never marks the cron failed; the
 * structured body carries the per-step outcome.
 */
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { loadMetaConfig, MetaMarketingClient, leadsFromActions } from '../_lib/marketing/metaMarketingApi.js';

export const config = { runtime: 'edge' };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Riyadh (UTC+3, no DST) wall-clock parts for "run once a day" gating. */
function riyadhNow(): { hour: number; ym: string; prevYm: string; today: string; monthStart: string; prevStart: string; prevEnd: string } {
  const now = new Date(Date.now() + 3 * 3600 * 1000);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based
  const pad = (n: number) => String(n).padStart(2, '0');
  const prev = new Date(Date.UTC(y, m - 1, 1));
  const prevEndD = new Date(Date.UTC(y, m, 0));
  return {
    hour: now.getUTCHours(),
    ym: `${y}-${pad(m + 1)}`,
    prevYm: `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}`,
    today: `${y}-${pad(m + 1)}-${pad(now.getUTCDate())}`,
    monthStart: `${y}-${pad(m + 1)}-01`,
    prevStart: `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-01`,
    prevEnd: `${prevEndD.getUTCFullYear()}-${pad(prevEndD.getUTCMonth() + 1)}-${pad(prevEndD.getUTCDate())}`,
  };
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

  // 1. Late sweep — every run.
  const sweep = await sb.rpc('mos_perf_late_sweep');
  if (sweep.error) {
    console.error('[perf-sweep] late sweep failed', sweep.error.code, sweep.error.message);
    out.sweep_error = sweep.error.message;
  } else {
    out.sweep = sweep.data;
  }

  // 2. Monthly paid snapshot — the 04:0x Riyadh run only (one run per day;
  //    the cron fires every 10 min so exactly one run has minute < 10).
  //    `?paid=1` forces it for manual smoke tests.
  const t = riyadhNow();
  const minute = new Date().getUTCMinutes();
  const daily = (t.hour === 4 && minute < 10) || url.searchParams.get('paid') === '1';
  if (daily) {
    const meta = loadMetaConfig();
    if (!meta) {
      out.paid = 'skipped: meta not configured';
    } else {
      try {
        const client = new MetaMarketingClient(meta);
        const windows: Array<{ ym: string; since: string; until: string }> = [
          { ym: t.ym, since: t.monthStart, until: t.today },
        ];
        // Finalize the just-closed month during its first week.
        if (Number(t.today.slice(8, 10)) <= 7) {
          windows.push({ ym: t.prevYm, since: t.prevStart, until: t.prevEnd });
        }
        for (const w of windows) {
          const rows = await client.getInsightsRange('campaign', w.since, w.until);
          const payload = rows
            .filter((r) => r.campaign_id)
            .map((r) => ({
              platform_campaign_id: r.campaign_id,
              spend: r.spend ?? null,
              impressions: r.impressions ?? null,
              clicks: r.clicks ?? null,
              leads: leadsFromActions(r.actions),
            }));
          const up = await sb.rpc('mos_perf_paid_monthly_upsert', {
            p_month: w.ym,
            p_rows: payload,
          });
          if (up.error) {
            console.error('[perf-sweep] paid monthly upsert failed', w.ym, up.error.message);
            out[`paid_${w.ym}`] = `error: ${up.error.message}`;
          } else {
            out[`paid_${w.ym}`] = up.data;
          }
          // Re-evaluate the month's KPI goals against the fresh snapshot.
          const ev = await sb.rpc('mos_perf_kpi_evaluate', { p_month: w.ym });
          if (ev.error) console.error('[perf-sweep] kpi evaluate failed', w.ym, ev.error.message);
        }
      } catch (e) {
        console.error('[perf-sweep] paid monthly pull failed', e);
        out.paid_error = e instanceof Error ? e.message : String(e);
      }
    }
  }

  return json({ ...out, duration_ms: Date.now() - startedAt }, 200);
}
