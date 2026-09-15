#!/usr/bin/env node
/**
 * Pull Anthropic's own cost figures into `ai_vendor_cost`, so the AI ledger's
 * estimate can be checked against the invoice.
 *
 *   node scripts/sync-anthropic-cost.mjs              # last 14 days
 *   node scripts/sync-anthropic-cost.mjs --days 31    # a month (API max)
 *   node scripts/sync-anthropic-cost.mjs --from 2026-09-01 --to 2026-09-15
 *   node scripts/sync-anthropic-cost.mjs --dry-run    # fetch + print, write nothing
 *
 * NEEDS AN ADMIN CREDENTIAL, which is NOT your normal API key:
 *   ANTHROPIC_ADMIN_KEY=sk-ant-admin01-...
 * An Admin API key, an OAuth token with `org:admin`, or a personal/service
 * account key that is not scoped to a workspace. A workspace-scoped key is
 * rejected by the endpoint. Create one in Console → Settings → Admin keys.
 *
 * Re-running is safe and expected. Each day is replaced wholesale
 * (`ai_vendor_cost_replace_day`), and Anthropic's figures keep settling for a
 * while after the calls happen — so the right habit is to re-pull the last
 * couple of weeks rather than to fetch each day once and trust it forever.
 *
 * This writes ONLY to ai_vendor_cost. It never touches ai_usage: the point of
 * the exercise is that the estimate and the invoice stay separately visible.
 */
import { readFileSync } from 'node:fs';
import {
  buildCostReportUrl, parseCostReportPage, sumDays,
} from './lib/anthropicCostReport.mjs';

// ── env ────────────────────────────────────────────────────────────────────
for (const f of ['.env', '.env.local']) {
  try {
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*([\s\S]*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* a missing .env is normal in CI / cloud; real env vars win anyway */ }
}

const ADMIN_KEY = (process.env.ANTHROPIC_ADMIN_KEY ?? '').trim();
const SUPABASE_URL = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim().replace(/\/$/, '');
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DRY_RUN = args.includes('--dry-run');
const DAYS = Number(flag('days', '14'));
const FROM = flag('from');
const TO = flag('to');

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!ADMIN_KEY) {
  fail(
    'ANTHROPIC_ADMIN_KEY is not set.\n' +
    '  This is an ADMIN credential, not your normal ANTHROPIC_API_KEY — a regular\n' +
    '  key is rejected by /v1/organizations/cost_report.\n' +
    '  Create one at Console → Settings → Admin keys (sk-ant-admin01-...),\n' +
    '  then add it to .env.local and re-run `bash scripts/secrets/seal.sh`.',
  );
}
if (!DRY_RUN && (!SUPABASE_URL || !SERVICE_KEY)) {
  fail('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required to write (or pass --dry-run).');
}

// ── window ─────────────────────────────────────────────────────────────────
// The API caps a 1d report at 31 buckets per page; we paginate, but keeping the
// requested window sane avoids a long pull for no reason.
const endISO = TO ? `${TO}T00:00:00Z` : new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) + 'T00:00:00Z';
const startISO = FROM
  ? `${FROM}T00:00:00Z`
  : new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10) + 'T00:00:00Z';

console.log(`Anthropic cost report  ${startISO.slice(0, 10)} → ${endISO.slice(0, 10)}${DRY_RUN ? '  (dry run)' : ''}`);

// ── fetch, following pagination ────────────────────────────────────────────
async function fetchAllPages() {
  const all = [];
  let page = null;
  let guard = 0;
  for (;;) {
    if (++guard > 50) throw new Error('cost_report: pagination did not terminate after 50 pages');
    const url = buildCostReportUrl({ startingAt: startISO, endingAt: endISO, limit: 31, page });
    const res = await fetch(url, {
      headers: {
        'x-api-key': ADMIN_KEY,
        'anthropic-version': '2023-06-01',
        'User-Agent': 'WassellCRM-cost-sync/1.0 (https://app.wassel.re)',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `HTTP ${res.status} from cost_report. The key was rejected — a workspace-scoped\n` +
          `  key cannot read org cost data; you need an Admin key or an org:admin token.\n  ${body.slice(0, 300)}`,
        );
      }
      throw new Error(`cost_report HTTP ${res.status}: ${body.slice(0, 400)}`);
    }
    const parsed = parseCostReportPage(await res.json());
    all.push(...parsed.days);
    if (!parsed.hasMore || !parsed.nextPage) break;
    page = parsed.nextPage;
  }
  return all;
}

// ── write ──────────────────────────────────────────────────────────────────
async function replaceDay(day, rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ai_vendor_cost_replace_day`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_provider: 'anthropic',
      p_day: day,
      p_source: 'anthropic cost_report',
      p_rows: rows,
    }),
  });
  if (!res.ok) throw new Error(`replace_day(${day}) HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Number(await res.json());
}

try {
  const days = await fetchAllPages();
  const skipped = days.reduce((n, d) => n + d.skipped, 0);
  if (skipped > 0) {
    // Loud, not swallowed: an unreadable amount means the total below is short
    // by an unknown quantity, which is exactly the kind of quiet gap this whole
    // ledger exists to prevent.
    console.error(`⚠ ${skipped} cost item(s) had an unreadable \`amount\` and were NOT recorded — the totals below are incomplete.`);
  }

  console.log(`  ${days.length} day(s), ${days.reduce((n, d) => n + d.rows.length, 0)} line item(s), $${sumDays(days).toFixed(4)} total`);

  if (DRY_RUN) {
    for (const d of days.filter((x) => x.rows.length)) {
      const t = d.rows.reduce((s, r) => s + r.amount_usd, 0);
      console.log(`  ${d.day}  $${t.toFixed(4)}  (${d.rows.length} items)`);
    }
    console.log('\nDry run — nothing written.');
    process.exit(0);
  }

  let written = 0;
  for (const d of days) written += await replaceDay(d.day, d.rows);
  console.log(`  wrote ${written} row(s) into ai_vendor_cost`);
  console.log('\nCompare with:  select * from v_ai_cost_reconciliation where provider=\'anthropic\' order by day desc;');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
