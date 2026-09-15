/**
 * cutover-pause-legacy-ads.mjs — the D2 paid cutover, and its undo.
 * ----------------------------------------------------------------------------
 * WHAT THIS IS FOR
 *
 * The month model starts paid from zero: every ad running under the old rules
 * is paused, so that every ad the weekly rule will ever judge is one the new
 * lane activated and stamped with `activated_at`. That is decision D2, taken by
 * the operator on 2026-09-15 against the recommendation to let the legacy
 * campaigns end naturally, and it is what removes the last place where the
 * build would have had to invent data.
 *
 * WHEN TO RUN IT — NOT ON DEPLOY DAY.
 *
 * §3.1 is explicit: the pause is tied to the BATCH DATE, not the deploy date.
 * Deploy whenever the code is ready, confirm the month on its normal date, let
 * production run its ten working days with legacy paid still earning leads, and
 * run this from the same tick that activates the first new batch. The gap
 * between paid stopping and paid restarting is then hours, not a fortnight.
 *
 * WHY IT IS NOT JUST `mosMetaSetStatus`
 *
 * `meta_set_status` (api/marketing-os.ts) does exactly one thing —
 * `MetaMarketingClient.setStatus()` — and writes NOTHING to our tables. A
 * cutover built on it alone would stop the ads at Meta and leave
 * `mos_execution_ads.status = 'running'`, live `mos_creative_slots`, and OPEN
 * `mos_refresh_cycles` rows behind it. The refresh lane would then find those
 * open cycles, and with `auto_apply_default_decision` on it would RE-ACTIVATE
 * the ads this script had just paused. So this does per execution what
 * `applyCycle` already does per ad:
 *
 *     Meta PAUSED  →  mos_execution_ads.status='paused' + retired_at
 *                  →  mos_creative_slots.status='retired' + retired_at
 *                  →  every open mos_refresh_cycles row closed ('cancelled')
 *
 * THE MANIFEST
 *
 * Before the first Meta call, every subject it is about to touch gets a row in
 * `mos_cutover_pause_manifest` carrying what the state WAS: our status, Meta's
 * own `effective_status`, the slot's status, the cycle's status. A log file is
 * not a manifest — it cannot be queried, it is not transactional with the
 * change, and it is not what `--restore` reads.
 *
 * "Re-runnable" here means RE-PAUSE, not undo: a second `--apply` with the same
 * --run-id finds the manifest rows already written, leaves their `prior_*`
 * snapshot alone, and simply makes sure everything is paused. Undo is a
 * separate, explicit mode.
 *
 * ----------------------------------------------------------------------------
 * USAGE
 *
 *   node scripts/cutover-pause-legacy-ads.mjs
 *       Dry run over every execution with a running ad. Reports exactly what
 *       would be paused, retired and closed. Touches nothing. START HERE.
 *
 *   node scripts/cutover-pause-legacy-ads.mjs --apply --run-id cutover-2026-10-04
 *       Do it. The run id is how you undo it; pick one you will recognise.
 *
 *   node scripts/cutover-pause-legacy-ads.mjs --restore --run-id cutover-2026-10-04
 *       Dry run of the undo.
 *
 *   node scripts/cutover-pause-legacy-ads.mjs --restore --apply --run-id cutover-2026-10-04
 *       Put back exactly what that run took down — ads to the status they
 *       held, slots un-retired, cycles reopened. An ad Meta had already paused
 *       before we arrived is NOT re-activated; the manifest knows the
 *       difference and says so.
 *
 * OPTIONS
 *   --apply              Actually write. Without it every mode is a dry run.
 *   --run-id <text>      Names the run (default: cutover-<ISO minute>).
 *                        REQUIRED with --apply and with --restore.
 *   --execution <uuid>   Limit to one execution; repeatable. Default: every
 *                        execution that has at least one running ad row.
 *   --restore            Undo mode.
 *   --yes                Skip the ten-second "this stops live ads" pause.
 *
 * REQUIRED ENV (process.env, or auto-loaded from .env.local / .env):
 *   SUPABASE_URL (or VITE_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY   — the manifest table is service-role only
 *   META_SYSTEM_USER_TOKEN, META_AD_ACCOUNT_ID   — to talk to Meta at all
 *   META_APP_SECRET (optional)  — enables appsecret_proof, as everywhere else
 *
 * NOTE ON THE GRAPH CALLS. This is a plain-Node .mjs script and cannot import
 * `worker/src/marketing/metaMarketingApi.ts`. The twenty lines of Graph client
 * below are a deliberate minimal re-implementation of `setStatus` and the
 * `effective_status` read, not a second API layer — if the Graph version or the
 * appsecret_proof convention changes there, change it here too.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { makeIdentifiedClient } from './_lib/serviceClient.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Reads .env.local then .env; a real shell env always wins. CRLF-safe. */
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  let txt;
  try {
    txt = readFileSync(p, 'utf8');
  } catch {
    return; // unreadable — the env-presence check below reports the miss
  }
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnvFile(resolve(ROOT, '.env.local'));
loadEnvFile(resolve(ROOT, '.env'));

/* ── args ─────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const str = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i === argv.length - 1 ? null : argv[i + 1];
};
const all = (name) => {
  const out = [];
  argv.forEach((a, i) => { if (a === `--${name}` && argv[i + 1]) out.push(argv[i + 1]); });
  return out;
};

const APPLY = flag('apply');
const RESTORE = flag('restore');
const SKIP_PAUSE = flag('yes');
const ONLY_EXECUTIONS = all('execution');
const RUN_ID = str('run-id') ?? `cutover-${new Date().toISOString().slice(0, 16)}`;

if (APPLY && !str('run-id')) {
  console.error('FATAL: --apply requires an explicit --run-id. It is the handle you undo the run with.');
  process.exit(1);
}
if (RESTORE && !str('run-id')) {
  console.error('FATAL: --restore requires --run-id — the run you want put back.');
  process.exit(1);
}

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (the manifest table is service-role only).');
  process.exit(1);
}
const sb = makeIdentifiedClient('script:cutover-pause-legacy-ads', url, key);

/* ── the smallest possible Graph client ───────────────────────────────── */

const GRAPH_VERSION = process.env.META_GRAPH_VERSION?.trim() || 'v21.0';
const META_TOKEN = process.env.META_SYSTEM_USER_TOKEN?.trim() ?? '';
const META_SECRET = process.env.META_APP_SECRET?.trim() ?? '';
const HAS_META = !!META_TOKEN && !!process.env.META_AD_ACCOUNT_ID?.trim();

function authParams() {
  const p = new URLSearchParams({ access_token: META_TOKEN });
  if (META_SECRET) p.set('appsecret_proof', createHmac('sha256', META_SECRET).update(META_TOKEN).digest('hex'));
  return p;
}

async function graph(method, nodeId, params = {}) {
  const qs = authParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const target = `https://graph.facebook.com/${GRAPH_VERSION}/${nodeId}`;
  const res = method === 'GET'
    ? await fetch(`${target}?${qs.toString()}`)
    : await fetch(target, { method: 'POST', body: qs });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* Graph returns JSON; an empty body on success is tolerated */ }
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    throw new Error(`Graph ${method} ${nodeId} failed (${res.status}): ${e.message ?? text.slice(0, 200)}`);
  }
  return json;
}

const metaEffectiveStatus = (adId) =>
  graph('GET', adId, { fields: 'effective_status' }).then((r) => r.effective_status ?? null);
const metaSetStatus = (adId, status) => graph('POST', adId, { status });

/* ── helpers ──────────────────────────────────────────────────────────── */

const now = () => new Date().toISOString();
const say = (...a) => console.log(...a);
/** Everything that changes the world announces itself, dry run or not. */
const plan = (verb, what) => say(`  ${APPLY ? '→' : '·'} ${verb} ${what}`);

let failures = 0;
function fail(msg, err) {
  failures += 1;
  console.error(`  ✗ ${msg}${err ? `: ${err.message ?? err}` : ''}`);
}

/**
 * Record a subject's PRIOR state. Never overwrites an existing snapshot: a
 * second run of the same run id must not record the state its own first run
 * created.
 */
async function recordManifest(row) {
  if (!APPLY) return;
  const res = await sb.from('mos_cutover_pause_manifest')
    .upsert({ run_id: RUN_ID, ...row }, { onConflict: 'run_id,subject_kind,subject_id', ignoreDuplicates: true });
  if (res.error) throw new Error(`manifest write failed for ${row.subject_kind} ${row.subject_id}: ${res.error.message}`);
}

/** Fill in Meta's own prior status, once, on the row we already wrote. */
async function recordMetaStatus(subjectId, metaStatus) {
  if (!APPLY) return;
  const res = await sb.from('mos_cutover_pause_manifest')
    .update({ prior_meta_status: metaStatus })
    .eq('run_id', RUN_ID).eq('subject_kind', 'ad').eq('subject_id', subjectId)
    .is('prior_meta_status', null);
  if (res.error) console.error(`  ! could not record Meta's prior status for ${subjectId}: ${res.error.message}`);
}

/* ── pause ────────────────────────────────────────────────────────────── */

async function targetExecutions() {
  if (ONLY_EXECUTIONS.length > 0) {
    const res = await sb.from('mos_campaign_executions')
      .select('id, label, status, campaign_id').in('id', ONLY_EXECUTIONS);
    if (res.error) throw new Error(`execution read failed: ${res.error.message}`);
    return res.data ?? [];
  }
  // Default: everything with something LIVE about it — a running ad, an open
  // refresh cycle, or a slot that has not been retired.
  //
  // Deliberately NOT "executions whose own status is running": two of the live
  // executions carry spend with no ad linked to any content, and one is a
  // Meta-synced campaign whose execution status was never maintained.
  //
  // And deliberately not "executions with a running ad" either. C-042 ربوة
  // الرمز has seventeen ad rows and ZERO running, so an ad-only rule would skip
  // it entirely — and leave its refresh cycles open, which is the one piece of
  // debris that lets automatic application re-activate what this run paused.
  // The cycles ARE the reason this script exists; they decide the target set.
  const [ads, cycles, slots] = await Promise.all([
    sb.from('mos_execution_ads').select('execution_id').eq('status', 'running').is('archived_at', null),
    sb.from('mos_refresh_cycles').select('execution_id')
      .in('status', ['scheduled', 'producing', 'ready', 'deciding', 'decided', 'applying']),
    sb.from('mos_creative_slots').select('execution_id')
      .in('status', ['reserved', 'producing', 'ready', 'active']),
  ]);
  if (ads.error) throw new Error(`running-ad read failed: ${ads.error.message}`);
  if (cycles.error) throw new Error(`open-cycle read failed: ${cycles.error.message}`);
  if (slots.error) throw new Error(`live-slot read failed: ${slots.error.message}`);
  const ids = [...new Set([
    ...(ads.data ?? []).map((a) => a.execution_id),
    ...(cycles.data ?? []).map((c) => c.execution_id),
    ...(slots.data ?? []).map((s) => s.execution_id),
  ].filter(Boolean))];
  if (ids.length === 0) return [];
  const res = await sb.from('mos_campaign_executions')
    .select('id, label, status, campaign_id').in('id', ids);
  if (res.error) throw new Error(`execution read failed: ${res.error.message}`);
  return res.data ?? [];
}

async function pauseExecution(exec) {
  say(`\n■ ${exec.label ?? exec.id} (${exec.id})`);

  const adsRes = await sb.from('mos_execution_ads')
    .select('id, label, status, platform_ad_id, placement_variant, pair_id, slot_id, retired_at')
    .eq('execution_id', exec.id).is('archived_at', null);
  if (adsRes.error) { fail(`ads read`, adsRes.error); return; }
  const ads = adsRes.data ?? [];
  const live = ads.filter((a) => a.status !== 'paused' || a.retired_at === null);
  const onMeta = live.filter((a) => a.platform_ad_id);

  if (ads.length === 0) say('  (no ad rows)');

  /* 1. ads — manifest first, Meta second, our row third. */
  for (const ad of onMeta) {
    const what = `${ad.label ?? ad.id} (${ad.platform_ad_id}${ad.placement_variant ? `, ${ad.placement_variant}` : ''})`;
    try {
      await recordManifest({
        subject_kind: 'ad',
        subject_id: ad.id,
        execution_id: exec.id,
        platform_ad_id: ad.platform_ad_id,
        prior_status: ad.status,
        paused_at: APPLY ? now() : null,
      });

      let metaStatus = null;
      if (HAS_META) {
        try {
          metaStatus = await metaEffectiveStatus(ad.platform_ad_id);
          await recordMetaStatus(ad.id, metaStatus);
        } catch (e) {
          // Not fatal: we still pause. But a restore then cannot tell whether
          // Meta had already paused this ad, so it is recorded as unknown and
          // said out loud.
          fail(`could not read Meta's status for ${what}`, e);
        }
      }

      plan('pause at Meta', `${what} [was ${metaStatus ?? 'unknown'}]`);
      if (APPLY) {
        if (!HAS_META) throw new Error('Meta credentials are missing — refusing to mark an ad paused that is still live on Meta');
        await metaSetStatus(ad.platform_ad_id, 'PAUSED');
      }

      plan('write', `mos_execution_ads ${ad.id} → paused + retired_at`);
      if (APPLY) {
        const upd = await sb.from('mos_execution_ads')
          .update({ status: 'paused', retired_at: now(), updated_at: now() }).eq('id', ad.id);
        if (upd.error) throw new Error(`ad row write failed: ${upd.error.message}`);
      }
    } catch (e) {
      fail(`pausing ${what}`, e);
    }
  }

  /* 2. slots — every live slot on the execution, not only the ones an ad row
   *    points at. A `reserved` or `producing` slot is work planned for a
   *    campaign we are shutting down; left alone it would activate later. */
  {
    const slotsRes = await sb.from('mos_creative_slots')
      .select('id, status, slot_index, kind').eq('execution_id', exec.id)
      .in('status', ['reserved', 'producing', 'ready', 'active']);
    if (slotsRes.error) fail('slot read', slotsRes.error);
    for (const slot of slotsRes.data ?? []) {
      try {
        await recordManifest({
          subject_kind: 'slot', subject_id: slot.id, execution_id: exec.id,
          prior_status: slot.status, paused_at: APPLY ? now() : null,
        });
        plan('retire', `slot #${slot.slot_index ?? '?'} (${slot.kind}) ${slot.id} [was ${slot.status}]`);
        if (APPLY) {
          const upd = await sb.from('mos_creative_slots')
            .update({ status: 'retired', retired_at: now(), updated_at: now() }).eq('id', slot.id);
          if (upd.error) throw new Error(upd.error.message);
        }
      } catch (e) {
        fail(`retiring slot ${slot.id}`, e);
      }
    }
  }

  /* 3. cycles — the step that stops the lane undoing all of the above. */
  const OPEN_CYCLE_STATES = ['scheduled', 'producing', 'ready', 'deciding', 'decided', 'applying'];
  const cyclesRes = await sb.from('mos_refresh_cycles')
    .select('id, round, status, refresh_on').eq('execution_id', exec.id).in('status', OPEN_CYCLE_STATES);
  if (cyclesRes.error) { fail('refresh-cycle read', cyclesRes.error); return; }
  for (const cycle of cyclesRes.data ?? []) {
    try {
      await recordManifest({
        subject_kind: 'cycle', subject_id: cycle.id, execution_id: exec.id,
        prior_status: cycle.status, paused_at: APPLY ? now() : null,
        note: `round ${cycle.round}, refresh_on ${cycle.refresh_on ?? 'null'}`,
      });
      plan('close', `refresh cycle round ${cycle.round} ${cycle.id} [was ${cycle.status}]`);
      if (APPLY) {
        const upd = await sb.from('mos_refresh_cycles')
          .update({ status: 'cancelled', updated_at: now() }).eq('id', cycle.id);
        if (upd.error) throw new Error(upd.error.message);
      }
    } catch (e) {
      fail(`closing cycle ${cycle.id}`, e);
    }
  }

  /* 4. debris the script deliberately does NOT touch, reported instead. */
  const cycleIds = (cyclesRes.data ?? []).map((c) => c.id);
  if (cycleIds.length > 0) {
    const tasks = await sb.from('mos_manual_tasks')
      .select('id, kind, title').eq('status', 'open').eq('entity_kind', 'refresh_cycle').in('entity_id', cycleIds);
    if (tasks.error) fail('open-task read', tasks.error);
    else if ((tasks.data ?? []).length > 0) {
      say(`  ! ${tasks.data.length} open task(s) point at cycles this run closes — close them in the app:`);
      for (const t of tasks.data) say(`      ${t.kind} ${t.id} — ${t.title}`);
    }
  }
}

/**
 * Executions that carry ads on Meta but nothing this run considers live, named
 * out loud rather than silently skipped.
 *
 * C-042 ربوة الرمز is the live example: seventeen ad rows, none running. If
 * Meta disagrees with our `status` column for any of them — which is exactly
 * the drift the cutover exists to end — the operator can include it by name
 * with `--execution <id>`.
 */
async function reportUntargeted(targeted) {
  const res = await sb.from('mos_execution_ads')
    .select('execution_id, platform_ad_id').is('archived_at', null).not('platform_ad_id', 'is', null);
  if (res.error) { fail('untargeted-execution read', res.error); return; }
  const counts = new Map();
  for (const a of res.data ?? []) {
    if (targeted.includes(a.execution_id)) continue;
    counts.set(a.execution_id, (counts.get(a.execution_id) ?? 0) + 1);
  }
  if (counts.size === 0) return;
  const execs = await sb.from('mos_campaign_executions').select('id, label').in('id', [...counts.keys()]);
  if (execs.error) { fail('untargeted-execution label read', execs.error); return; }
  say('\n· Not targeted — these carry ads on Meta but nothing live in our tables.');
  say('  Add --execution <id> if Meta says otherwise:');
  for (const e of execs.data ?? []) say(`    ${e.id}  ${counts.get(e.id)} ad(s)  ${e.label ?? ''}`);
}

/* ── restore ──────────────────────────────────────────────────────────── */

/** Meta states that mean "this ad was delivering before we arrived". */
const WAS_LIVE_ON_META = new Set(['ACTIVE', 'PENDING_REVIEW', 'IN_PROCESS', 'PENDING_BILLING_INFO']);

async function restoreRun() {
  const res = await sb.from('mos_cutover_pause_manifest')
    .select('*').eq('run_id', RUN_ID).is('restored_at', null);
  if (res.error) throw new Error(`manifest read failed: ${res.error.message}`);
  const rows = res.data ?? [];
  if (rows.length === 0) {
    say(`Nothing to restore: no un-restored manifest rows for run "${RUN_ID}".`);
    return;
  }
  say(`Restoring run "${RUN_ID}" — ${rows.length} subject(s).`);

  // Reverse order of the pause: cycles reopen first, then slots, then the ads
  // go back on Meta last, so nothing is live before the state describing it is.
  const order = { cycle: 0, slot: 1, ad: 2 };
  rows.sort((a, b) => order[a.subject_kind] - order[b.subject_kind]);

  const restoreRunId = `restore-${new Date().toISOString().slice(0, 16)}`;
  for (const row of rows) {
    try {
      if (row.subject_kind === 'cycle') {
        plan('reopen', `refresh cycle ${row.subject_id} → ${row.prior_status}`);
        if (APPLY) {
          const upd = await sb.from('mos_refresh_cycles')
            .update({ status: row.prior_status, updated_at: now() }).eq('id', row.subject_id);
          if (upd.error) throw new Error(upd.error.message);
        }
      } else if (row.subject_kind === 'slot') {
        plan('un-retire', `slot ${row.subject_id} → ${row.prior_status}`);
        if (APPLY) {
          const upd = await sb.from('mos_creative_slots')
            .update({ status: row.prior_status, retired_at: null, updated_at: now() }).eq('id', row.subject_id);
          if (upd.error) throw new Error(upd.error.message);
        }
      } else {
        // An ad Meta had ALREADY paused before the cutover is not ours to
        // restart. The manifest is what makes that distinction possible; a log
        // would have made every restore a guess.
        const relight = row.prior_status === 'running' && WAS_LIVE_ON_META.has(row.prior_meta_status ?? '');
        if (relight) {
          plan('re-activate at Meta', `${row.platform_ad_id} [was ${row.prior_meta_status}]`);
          if (APPLY) {
            if (!HAS_META) throw new Error('Meta credentials are missing — cannot re-activate');
            await metaSetStatus(row.platform_ad_id, 'ACTIVE');
          }
        } else {
          say(`  · leave paused at Meta: ${row.platform_ad_id} [was ${row.prior_meta_status ?? 'unknown'} / ${row.prior_status}]`);
        }
        plan('write', `mos_execution_ads ${row.subject_id} → ${row.prior_status}`);
        if (APPLY) {
          const upd = await sb.from('mos_execution_ads')
            .update({ status: row.prior_status, retired_at: null, updated_at: now() }).eq('id', row.subject_id);
          if (upd.error) throw new Error(upd.error.message);
        }
      }

      if (APPLY) {
        const mark = await sb.from('mos_cutover_pause_manifest')
          .update({ restored_at: now(), restore_run_id: restoreRunId }).eq('id', row.id);
        if (mark.error) throw new Error(`manifest restore stamp failed: ${mark.error.message}`);
      }
    } catch (e) {
      fail(`restoring ${row.subject_kind} ${row.subject_id}`, e);
    }
  }
}

/* ── main ─────────────────────────────────────────────────────────────── */

async function main() {
  say(`${RESTORE ? 'RESTORE' : 'PAUSE'} — run id "${RUN_ID}" — ${APPLY ? 'APPLYING' : 'DRY RUN (nothing is written; add --apply)'}`);
  if (!HAS_META) {
    say('! Meta credentials are missing (META_SYSTEM_USER_TOKEN / META_AD_ACCOUNT_ID).');
    if (APPLY) {
      console.error('FATAL: refusing to apply without them — marking rows paused while the ads keep spending is the worst of both states.');
      process.exit(1);
    }
  }

  if (APPLY && !SKIP_PAUSE) {
    say(RESTORE
      ? '\nThis will put live ads back on Meta and they will start spending again. Ctrl-C within 10 seconds to stop.'
      : '\nThis will STOP live ads and paid lead flow goes to zero until the first new batch activates. Ctrl-C within 10 seconds to stop.');
    await new Promise((r) => setTimeout(r, 10_000));
  }

  if (RESTORE) {
    await restoreRun();
  } else {
    const executions = await targetExecutions();
    if (executions.length === 0) {
      say('\nNothing to pause: no execution has a running ad, an open refresh cycle or a live slot.');
    }
    for (const exec of executions) await pauseExecution(exec);
    if (ONLY_EXECUTIONS.length === 0) await reportUntargeted(executions.map((e) => e.id));
  }

  say(`\n${failures === 0 ? 'Done.' : `Done with ${failures} failure(s) — read them above.`}`);
  if (!APPLY) say('This was a DRY RUN. Re-run with --apply --run-id <name> to make it real.');
  // exitCode rather than process.exit(): the Supabase client keeps a handle
  // open and a hard exit on Windows Node trips a libuv assertion that reads
  // like a crash in an operator script that in fact succeeded.
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('FATAL:', e.message ?? e);
  process.exit(1);
});
