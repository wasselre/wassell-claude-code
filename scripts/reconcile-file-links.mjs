#!/usr/bin/env node
/**
 * Reconciliation report for the Phase 1 file-link projection.
 *
 * TWO INDEPENDENT QUESTIONS, and the script answers both:
 *
 * 1. COMPLETENESS — did the backfill lose anything it should have kept?
 *    Acceptance is NOT "zero drift". Production contains known anomalies (field
 *    values that are raw URLs, uuids with no `files` row); pretending they do
 *    not exist would hide real loss. Acceptance is ZERO UNEXPLAINED LOSS:
 *
 *        considered = represented + external + folder_ref + anomaly
 *
 *    That is a COMPLETE PARTITION of every value seen in a candidate field:
 *      external   a real http/data URL (YouTube, Supabase storage). Correct
 *                 data that simply is not a file — NOT an anomaly, and never
 *                 turned into a file relationship.
 *      folder_ref resolves to a folder. A different resource, also not loss.
 *      anomaly    a value that SHOULD have been a file and is not (a uuid with
 *                 no files row, or something unrecognisable).
 *    'gap' rows (a (model, field) pair our role vocabulary does not name yet)
 *    are REPRESENTED — the edge exists with role='unmapped' — so they are NOT
 *    part of the partition. Anything left over is unexplained and FAILS the run.
 *
 *    'unscanned' is reported separately and loudly: a canonical file reference
 *    sitting in a field type we do not treat as file-bearing. It means the
 *    candidate list needs widening, and it is never silently ignored.
 *
 * 2. FRESHNESS — has the source data moved since the backfill ran?
 *    The projection is a SNAPSHOT: no trigger and no dual-write ship in Phase 1,
 *    so it starts drifting the moment the backfill finishes. missing_source /
 *    stale_source / missing_edge / orphan_edge / drift measure exactly that.
 *    Non-zero here is NOT a bug — it is the expected consequence of a snapshot
 *    architecture, and it is precisely why the "Used in" panel must stay
 *    disabled in production until Phase 2 ships synchronisation.
 *
 * Read-only: it runs `file_links_reconcile()` and prints. It never repairs, and
 * the SQL side never prunes — deleting projected rows is destructive automation
 * against a graph that becomes security-relevant, and needs its own approval.
 *
 *   node scripts/reconcile-file-links.mjs [--json] [--strict-freshness]
 *
 * --strict-freshness additionally fails the run on ANY drift. Use it in the
 * minutes after a backfill, where the projection genuinely should be current.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

// Load .env.local / .env without adding a dotenv dependency (repo convention).
for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('reconcile-file-links: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  console.error('The reconciliation reads the whole projection, so it must bypass RLS.');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });
const { data, error } = await sb.rpc('file_links_reconcile');
if (error) {
  console.error('reconcile-file-links: RPC failed:', error.message);
  process.exit(1);
}

const rows = data ?? [];
const asJson = process.argv.includes('--json');
const strictFreshness = process.argv.includes('--strict-freshness');
const by = (c) => rows.filter((r) => r.category === c);
const sum = (c) => by(c).reduce((a, r) => a + Number(r.value), 0);

const considered = sum('considered');
const anomalies  = sum('anomaly');    // a value that SHOULD be a file and is not
const externals  = sum('external');   // real external resources (YouTube, …)
const folderRefs = sum('folder_ref'); // resolves to a folder, not a file
const gaps       = sum('gap');        // represented as role='unmapped' — NOT loss
const unscanned  = sum('unscanned');  // file reference in a field type we do not scan
const edges      = Number(by('represented').find((r) => r.detail === 'semantic edges')?.value ?? 0);
const sources    = Number(by('represented').find((r) => r.detail === 'source occurrences')?.value ?? 0);

// `considered` counts FIELD occurrences only, so the balance is against
// field-derived sources, not every source row.
const fieldSources = Number(
  rows.find((r) => r.category === 'source' && r.detail === 'origin=field')?.value ?? 0,
);
const unexplained = considered - fieldSources - externals - folderRefs - anomalies;

const staleness = {
  missing_source: sum('missing_source'),
  stale_source:   sum('stale_source'),
  missing_edge:   sum('missing_edge'),
  orphan_edge:    sum('orphan_edge'),
  drift:          sum('drift'),
};
const totalDrift = Object.values(staleness).reduce((a, b) => a + b, 0);

const completenessOk = unexplained === 0;
const freshnessOk = totalDrift === 0;
const ok = completenessOk && (!strictFreshness || freshnessOk);

if (asJson) {
  console.log(JSON.stringify({
    rows, considered, fieldSources, externals, folderRefs, anomalies, gaps,
    unscanned, unexplained, edges, sources, staleness, totalDrift,
    completenessOk, freshnessOk,
  }, null, 2));
} else {
  const section = (title, cat) => {
    const list = by(cat).filter((r) => Number(r.value) !== 0);
    if (list.length === 0) return;
    console.log(`\n${title}`);
    for (const r of list) console.log(`  ${String(r.value).padStart(7)}  ${r.detail}`);
  };
  console.log('═══ file-link projection — reconciliation ═══');
  section('CONSIDERED (field value occurrences)', 'considered');
  section('REPRESENTED', 'represented');
  section('BY SOURCE ORIGIN', 'source');
  section('BY ROLE', 'role');
  section('SHAPE', 'shape');
  section('NAMED ANOMALIES (should have been a file, is not)', 'anomaly');
  section('EXTERNAL RESOURCES (real URLs — NOT loss, NOT anomalies)', 'external');
  section('FOLDER REFERENCES (a different resource — NOT loss)', 'folder_ref');
  section('VOCABULARY GAPS (represented as role=unmapped — NOT loss)', 'gap');
  section('⚠ UNSCANNED (file reference in a NON-candidate field type)', 'unscanned');

  console.log('\n─── 1. completeness ───');
  console.log(`  considered field occurrences : ${considered}`);
  console.log(`  represented as field sources : ${fieldSources}`);
  console.log(`  external resources           : ${externals}`);
  console.log(`  folder references            : ${folderRefs}`);
  console.log(`  named anomalies              : ${anomalies}`);
  console.log(`  ── partition must be exact ──`);
  console.log(`  UNEXPLAINED                  : ${unexplained}`);
  console.log(`  vocabulary gaps (represented): ${gaps}   [not part of the partition]`);
  if (unscanned > 0) {
    console.log(`  ⚠ UNSCANNED file references  : ${unscanned}  — a file-bearing field type`);
    console.log(`    we do not project. Add it to file_link_candidate_types() and re-run.`);
  }
  console.log(completenessOk ? '  ✓ zero unexplained loss' : '  ✗ UNEXPLAINED LOSS — do not accept this run');

  console.log('\n─── 2. freshness (this projection is a SNAPSHOT) ───');
  section('  live sources not yet projected', 'missing_source');
  section('  projected sources no longer live', 'stale_source');
  section('  edges implied but not projected', 'missing_edge');
  section('  projected edges with no live source', 'orphan_edge');
  section('  drift', 'drift');
  if (freshnessOk) {
    console.log('  ✓ projection is current with the source data');
  } else {
    console.log(`  ⚠ projection has DRIFTED — ${totalDrift} discrepancy/ies.`);
    console.log('    Expected for a snapshot: no trigger or dual-write ships in Phase 1.');
    console.log('    Re-run file_links_backfill() to converge the missing_* categories.');
    console.log('    Stale rows are REPORTED, never pruned — pruning needs its own approval.');
    if (strictFreshness) console.log('    --strict-freshness was set, so this fails the run.');
  }

  console.log('\n─── verdict ───');
  console.log(ok ? '  PASS' : '  FAIL');
}

process.exit(ok ? 0 : 1);
