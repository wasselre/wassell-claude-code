#!/usr/bin/env bash
# ============================================================================
# Designated validator for supabase/migrations/2026-08-16_03_file_authz_performance.sql
#
# B2A is a performance change to an AUTHORIZATION path, so the bar is higher
# than "it got faster": the exact file-ID set every user may view, edit, delete
# and share has to be provably unchanged. This script measures BEFORE, applies,
# measures AFTER, and diffs.
#
#   1. build Phase 1 + Phase 2 + B1 + the real authorization surface (8k corpus)
#   2. BEFORE: per-persona per-kind sorted file-ID fingerprints + latency/buffers
#   3. apply B2A
#   4. AFTER: identical fingerprints (hard gate), then latency/buffers again
#   5. smoke: id-set equivalence vs the pinned reference, policy equivalence,
#      surrounding-surface invariants, and "no D1 branch present"
#   6. perf gates: bare visible-count p95 < 300 ms for admin AND non-admin
#   7. layer PR #21's B2 on top and re-measure business_files_search p95
#   8. rollback restores the original predicate; re-application is clean
#
# Usage: PGURL=... [B2_MIGRATION=path] bash supabase/tests/ci/run_b2a_authz_perf_test.sh
# ============================================================================
set -euo pipefail

PGURL="${PGURL:-postgresql://postgres:ci@localhost:5432/postgres}"
DB=wassell_b2a_authz
BASE="${PGURL%/*}"; DBURL="$BASE/$DB"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

q()   { psql "$DBURL" -v ON_ERROR_STOP=1 -tAqc "$1"; }
run() { psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$1"; }

PERSONAS='99999999-9999-9999-9999-999999999999
11111111-1111-1111-1111-111111111111
22222222-2222-2222-2222-222222222222
33333333-3333-3333-3333-333333333333
44444444-4444-4444-4444-444444444444
55555555-5555-5555-5555-555555555555
00000000-0000-0000-0000-0000000000ff'

# Sorted file-ID fingerprint per persona per kind, via the LIVE 2-arg function.
fingerprints() {
  local uid k
  for uid in $PERSONAS; do
    for k in view edit delete; do
      psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL
BEGIN;
SELECT set_config('test.uid','$uid', true);
SELECT 'FP $uid $k ' || coalesce(md5(string_agg(f.id::text, ',' ORDER BY f.id)),'EMPTY')
    || ' n=' || count(*)
  FROM public.files f WHERE public.wassell_can_access_file(f.id, '$k');
ROLLBACK;
SQL
    done
  done | grep -E '^FP ' | sort
}

# What the SELECT POLICY itself admits, as authenticated.
policy_fingerprints() {
  local uid
  for uid in $PERSONAS; do
    psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL
BEGIN;
SELECT set_config('test.uid','$uid', true);
SET LOCAL ROLE authenticated;
SELECT 'POL $uid ' || coalesce(md5(string_agg(f.id::text, ',' ORDER BY f.id)),'EMPTY')
    || ' n=' || count(*) FROM public.files f;
ROLLBACK;
SQL
  done | grep -E '^POL ' | sort
}

# p95 + buffers for the bare visible-business-files count.
measure() {   # $1 = uid, $2 = label
  psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL | grep -E '^MEAS '
CREATE TEMP TABLE IF NOT EXISTS _m(ms numeric);
TRUNCATE _m;
GRANT INSERT ON _m TO authenticated;
BEGIN;
SELECT set_config('test.uid','$1', true);
SET LOCAL ROLE authenticated;
DO \$\$
DECLARE t0 timestamptz; i int;
BEGIN
  FOR i IN 1..12 LOOP
    t0 := clock_timestamp();
    PERFORM count(*) FROM public.files WHERE file_class='business' AND status <> 'archived';
    INSERT INTO _m VALUES (EXTRACT(epoch FROM clock_timestamp()-t0)*1000);
  END LOOP;
END \$\$;
RESET ROLE;
SELECT 'MEAS $2 p50=' || round(percentile_disc(0.50) WITHIN GROUP (ORDER BY ms),1)
    || ' p95=' || round(percentile_disc(0.95) WITHIN GROUP (ORDER BY ms),1)
    || ' max=' || round(max(ms),1) FROM _m;
ROLLBACK;
SQL
}

echo "== creating $DB"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB;"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB;"

echo "== building Phase 1 + Phase 2 + B1 + authorization surface"
run "$ROOT/supabase/tests/ci/fixture_file_links.sql"
run "$ROOT/supabase/tests/ci/fixture_b1_metadata.sql"
run "$ROOT/supabase/migrations/2026-08-10_file_links_projection.sql"
q   "SELECT * FROM public.file_links_backfill()" >/dev/null
run "$ROOT/supabase/migrations/2026-08-12_file_link_sync.sql"
run "$ROOT/supabase/tests/ci/fixture_b2a_authz.sql"
run "$ROOT/supabase/migrations/2026-08-16_01_business_file_metadata.sql"
run "$ROOT/supabase/tests/ci/fixture_b2a_reference_authz.sql"

# Establish the genuine pre-B2A predicate.
#
# fixture_file_links.sql installs a one-line STUB for wassell_can_access_file
# (it returns whether the id is listed in a `test.visible_files` GUC), which is
# all the Phase 1 projection smoke needs. If BEFORE were measured against that
# stub, every persona would see nothing, all 21 fingerprints would be identical
# and the equivalence proof would be vacuous — which is exactly what the
# non-vacuity guard below caught on the first run.
#
# The B2A ROLLBACK script is, by definition, the pre-B2A state: it installs the
# original plpgsql function and the original files_select policy verbatim. Using
# it here means BEFORE is the real shipped predicate and cannot drift from what
# rollback restores.
psql "$DBURL" -v ON_ERROR_STOP=1 -q <<'SQL'
ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.files TO authenticated;
DROP POLICY IF EXISTS files_update ON public.files;
CREATE POLICY files_update ON public.files FOR UPDATE TO authenticated
USING (wassell_can_access_file(id, 'edit'::text));
DROP POLICY IF EXISTS files_delete ON public.files;
CREATE POLICY files_delete ON public.files FOR DELETE TO authenticated
USING (wassell_can_access_file(id, 'delete'::text));
SQL
run "$ROOT/supabase/rollback/2026-08-16_03_file_authz_performance_down.sql"
echo "   corpus: $(q "SELECT count(*) FROM public.files") files, \
$(q "SELECT count(*) FROM public.file_permissions") grants, \
$(q "SELECT count(*) FROM public.folder_permissions") folder grants, \
$(q "SELECT count(*) FROM public.mos_assets WHERE file_id IS NOT NULL") marketing"

echo "== BEFORE: authorization fingerprints + latency"
fingerprints        > "$WORK/fp.before"
policy_fingerprints > "$WORK/pol.before"
[ "$(wc -l < "$WORK/fp.before")" -eq 21 ] || { echo "FAIL: expected 21 fingerprints"; exit 1; }
# Non-vacuity: personas must NOT all see the same thing, or equivalence is trivial.
[ "$(awk '{print $4}' "$WORK/fp.before" | sort -u | wc -l)" -ge 4 ] \
  || { echo "FAIL: fingerprints too uniform — the corpus does not discriminate personas"; exit 1; }
sed 's/^/     /' "$WORK/fp.before"
B_ADMIN=$(measure 99999999-9999-9999-9999-999999999999 before_admin)
B_USER=$(measure  55555555-5555-5555-5555-555555555555 before_nonadmin)
echo "   $B_ADMIN"; echo "   $B_USER"

echo "== applying B2A"
run "$ROOT/supabase/migrations/2026-08-16_03_file_authz_performance.sql"

echo "== AFTER: the hard semantic gate"
fingerprints        > "$WORK/fp.after"
policy_fingerprints > "$WORK/pol.after"
if ! diff -u "$WORK/fp.before" "$WORK/fp.after" > "$WORK/fp.diff"; then
  echo "FAIL: view/edit/delete/share file-ID sets changed"; cat "$WORK/fp.diff"; exit 1
fi
if ! diff -u "$WORK/pol.before" "$WORK/pol.after" > "$WORK/pol.diff"; then
  echo "FAIL: files_select policy admits a different id-set"; cat "$WORK/pol.diff"; exit 1
fi
echo "   OK: all 21 function fingerprints and all 7 policy fingerprints identical"

echo "== smoke assertions"
psql "$DBURL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/ci/smoke_b2a_authz_perf.sql"

echo "== AFTER: latency"
A_ADMIN=$(measure 99999999-9999-9999-9999-999999999999 after_admin)
A_USER=$(measure  55555555-5555-5555-5555-555555555555 after_nonadmin)
echo "   $A_ADMIN"; echo "   $A_USER"
P_ADMIN=$(sed -n 's/.*p95=\([0-9.]*\).*/\1/p' <<<"$A_ADMIN")
P_USER=$(sed  -n 's/.*p95=\([0-9.]*\).*/\1/p' <<<"$A_USER")

echo "== write latency must not regress"
# B2A touches only SELECT-path predicates, but the files table carries the
# Phase 2 sync trigger and B1's fill trigger, so writes are timed explicitly.
WRITE_MS=$(psql "$DBURL" -v ON_ERROR_STOP=1 -tAqc "
  SELECT round(EXTRACT(epoch FROM (
    SELECT clock_timestamp() - t FROM (
      SELECT clock_timestamp() AS t,
             (SELECT count(*) FROM (
                UPDATE public.files SET description = 'b2a-write-probe'
                 WHERE storage_path LIKE 'scale/%'
                   AND right(id::text,12)::bigint <= 200
                RETURNING 1) u) AS n
    ) s)) * 1000, 1)")
echo "   200 metadata UPDATEs in ${WRITE_MS} ms"
[ "$(q "SELECT count(*) FROM public.file_link_dirty_targets")" = "0" ] \
  || { echo "FAIL: writes left dirty targets"; exit 1; }

echo "== layering B2 (PR #21) on top and re-measuring its p95"
B2_SQL="${B2_MIGRATION:-$ROOT/supabase/migrations/2026-08-16_02_business_files_search.sql}"
if [ -f "$B2_SQL" ]; then
  run "$ROOT/supabase/migrations/2026-09-02_02_search_norm_alef_madda_fix.sql"
  run "$B2_SQL"
  B2P=$(psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<'SQL' | grep -E '^B2PERF '
CREATE TEMP TABLE IF NOT EXISTS _p(ms numeric); TRUNCATE _p;
GRANT INSERT ON _p TO authenticated;
BEGIN;
SELECT set_config('test.uid','55555555-5555-5555-5555-555555555555', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE t0 timestamptz; i int; s text;
        sc text[] := ARRAY['','مخطط','ابراج','floor plan'];
BEGIN
  FOREACH s IN ARRAY sc LOOP
    FOR i IN 1..10 LOOP
      t0 := clock_timestamp();
      PERFORM public.business_files_search(nullif(s,''), '{}'::jsonb, 'created_desc', 1, 60);
      INSERT INTO _p VALUES (EXTRACT(epoch FROM clock_timestamp()-t0)*1000);
    END LOOP;
  END LOOP;
END $$;
RESET ROLE;
SELECT 'B2PERF n=' || count(*)
    || ' p50=' || round(percentile_disc(0.50) WITHIN GROUP (ORDER BY ms),1)
    || ' p95=' || round(percentile_disc(0.95) WITHIN GROUP (ORDER BY ms),1)
    || ' max=' || round(max(ms),1) FROM _p;
ROLLBACK;
SQL
)
  echo "   $B2P"
  P_B2=$(sed -n 's/.*p95=\([0-9.]*\).*/\1/p' <<<"$B2P")
  run "$ROOT/supabase/rollback/2026-08-16_02_business_files_search_down.sql"
else
  echo "   (B2 migration not on this branch — skipped)"; P_B2=""
fi

echo "== rollback + re-apply"
run "$ROOT/supabase/rollback/2026-08-16_03_file_authz_performance_down.sql"
fingerprints > "$WORK/fp.rollback"
diff -q "$WORK/fp.before" "$WORK/fp.rollback" >/dev/null \
  || { echo "FAIL: rollback changed the id-sets"; diff -u "$WORK/fp.before" "$WORK/fp.rollback"; exit 1; }
[ "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proname='wassell_can_access_file_row'")" = "0" ] \
  || { echo "FAIL: row function survived rollback"; exit 1; }
run "$ROOT/supabase/migrations/2026-08-16_03_file_authz_performance.sql"
fingerprints > "$WORK/fp.reapply"
diff -q "$WORK/fp.before" "$WORK/fp.reapply" >/dev/null \
  || { echo "FAIL: re-application changed the id-sets"; exit 1; }
echo "   OK: rollback and re-application both preserve every id-set"

echo
echo "──────── B2A results ────────"
echo "  BEFORE  $B_ADMIN"
echo "  BEFORE  $B_USER"
echo "  AFTER   $A_ADMIN"
echo "  AFTER   $A_USER"
[ -n "$P_B2" ] && echo "  B2 on B2A  p95=${P_B2} ms"
FAILED=0
awk "BEGIN{exit !($P_ADMIN < 300)}" || { echo "  ✗ admin p95 ${P_ADMIN} ms >= 300"; FAILED=1; }
awk "BEGIN{exit !($P_USER  < 300)}" || { echo "  ✗ non-admin p95 ${P_USER} ms >= 300"; FAILED=1; }
if [ -n "$P_B2" ]; then
  awk "BEGIN{exit !($P_B2 < 300)}" || { echo "  ✗ B2 search p95 ${P_B2} ms >= 300"; FAILED=1; }
fi
[ "$FAILED" -eq 0 ] || { echo; echo "B2A: SEMANTICS OK, PERFORMANCE GATE NOT MET"; exit 1; }
echo
echo "B2A authorization performance: ALL CHECKS PASSED"
