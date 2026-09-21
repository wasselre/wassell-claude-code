/**
 * GET / POST /api/cron/ai-balance-probe — ask every AI provider what is LEFT.
 *
 * This is the check that cannot be fooled by an unwired call site. `ai_usage`
 * can only report the call sites somebody remembered to meter; starting from
 * the VENDOR's balance and working back catches the ones nobody did.
 *
 * It runs here, on Vercel, rather than as a local script because this is where
 * the provider keys already live — DEEPSEEK_API_KEY, KIMI_API_KEY, FAL_KEY. A
 * laptop script would need its own copies of all three.
 *
 * Writes one `ai_provider_balance_probes` row per provider per run, including
 * the failures: a provider that has quietly stopped answering must show up as
 * an error row, not as an absence. Read the result in
 * `v_ai_balance_reconciliation`, and read `verdict` before `drift_usd`.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron) or `?secret=` for a
 * manual run. Refuses to run without CRON_SECRET — same posture as the other
 * crons in this folder.
 */
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { probeAllBalances } from '../_lib/aiBalance.js';

export const config = { runtime: 'edge' };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

  const probes = await probeAllBalances();
  const sb = getServiceSupabase();

  const written: string[] = [];
  const failed: Array<{ provider: string; error: string }> = [];

  const skipped: string[] = [];

  for (const p of probes) {
    // Do not store an `unsupported` API reading. Anthropic and Modal publish no
    // balance endpoint, and the Fly worker's BROWSER probe owns them. Storing
    // "no endpoint" here every hour made the page's probe-health column read
    // "unsupported" over a browser probe that was working fine (and, before
    // 2026-09-21, the view took the latest row of ANY status, so these rows
    // actually buried the real balance — 18 correct Anthropic readings hidden).
    // If a browser probe is not configured, the worker writes its own
    // `unsupported` row saying which cookie is missing, which is the accurate
    // message; this one carried nothing it did not.
    if (p.status === 'unsupported') {
      skipped.push(p.provider);
      continue;
    }
    const { error } = await sb.rpc('ai_balance_probe_add', {
      p_provider: p.provider,
      p_source: p.source,
      p_status: p.status,
      p_balance: p.status === 'ok' ? (p.balanceUsd ?? null) : null,
      p_currency: p.currency ?? 'USD',
      p_raw: (p.raw ?? null) as never,
      p_error: p.error ?? null,
    });
    if (error) {
      // Loud, never swallowed: if the probe cannot be STORED then the whole
      // safety net is off, and that is worse than a provider being unreachable.
      console.error(`[ai-balance-probe] could not store ${p.provider}: ${error.message}`);
      failed.push({ provider: p.provider, error: error.message });
    } else {
      written.push(p.provider);
    }
  }

  // Low-balance / over-budget alerts. Evaluated in SQL so this cron and the Fly
  // worker's browser probe share ONE implementation; the function row-locks its
  // state, so both calling it within the same minute still sends exactly one
  // WhatsApp per crossing. It sends through the existing scheduled-WhatsApp
  // lane — no second sender to monitor.
  const { data: alertResult, error: alertError } = await sb.rpc('ai_balance_alerts_evaluate');
  if (alertError) {
    // Loud: an alert that silently fails to evaluate is exactly how 2026-09-17
    // happened — the probe saw $0.18 a day early and nobody was told.
    console.error(`[ai-balance-probe] alert evaluation failed: ${alertError.message}`);
  }

  // Surface the comparison in the same response so a manual run answers the
  // question directly instead of requiring a second query.
  const { data: recon, error: reconError } = await sb
    .from('v_ai_balance_reconciliation')
    .select('provider, billing_mode, vendor_value_usd, vendor_spent_24h, metered_24h, unmetered_24h, verdict');
  if (reconError) console.error(`[ai-balance-probe] reconciliation read failed: ${reconError.message}`);

  const alarms = (recon ?? []).filter((r) => r.verdict === 'UNMETERED_SPEND');
  if (alarms.length > 0) {
    console.error(
      `[ai-balance-probe] UNMETERED SPEND on ${alarms.map((a) => `${a.provider} ($${a.unmetered_24h} in 24h)`).join(', ')} — money left an account without passing through ai_usage`,
    );
  }

  // Always 200: a provider outage must not make Vercel mark the cron failed.
  // The structured body carries what actually happened.
  return json(
    {
      ok: true,
      probed: probes.map((p) => ({ provider: p.provider, status: p.status, balance_usd: p.balanceUsd ?? null, error: p.error ?? null })),
      written,
      skipped_unsupported: skipped,
      store_failures: failed,
      alerts: alertResult ?? null,
      reconciliation: recon ?? [],
      unmetered_alarms: alarms,
      duration_ms: Date.now() - startedAt,
    },
    200,
  );
}
