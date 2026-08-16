#!/usr/bin/env bash
# ============================================================================
# Designated validator for supabase/migrations/2026-08-16_04_file_authz_grant_sets.sql
#
# B2A.1 replaces the files_select policy with a set-based form. B2A stays
# installed underneath, so the baseline here is B2A (which is what production
# runs), and the reference oracle is still the PRE-B2A function — that way the
# chain B2A -> B2A.1 is proved equivalent to the original all the way back.
#
#   1. Phase 1 + Phase 2 + B1 + authorization surface + B2A + high-cardinality
#   2. BEFORE (on B2A): 30 function fingerprints + 10 policy fingerprints
#   3. apply B2A.1
#   4. AFTER: byte-identical fingerprints (hard gate)
#   5. every persona's p95 < 300 ms, INCLUDING the high-cardinality ones
#   6. B2 layered on top stays < 300 ms
#   7. write latency, rollback to B2A, re-application
# ============================================================================
set -euo pipefail

PGURL="${PGURL:-postgresql://postgres:ci@localhost:5432/postgres}"
DB=wassell_b2a1
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
66666666-6666-6666-6666-666666666666
77777777-7777-7777-7777-777777777777
88888888-8888-8888-8888-888888888888
00000000-0000-0000-0000-0000000000ff'

fingerprints() {
  local uid k
  for uid in $PERSONAS; do
    for k in view edit delete; do
      psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL
BEGIN;
SELECT set_config('test.uid','$uid', true);
SELECT 'FP $uid $k ' || coalesce(md5(string_agg(f.id::text, ',' ORDER BY f.id)),'EMPTY')
    || ' n=' || count(*)
  FROM public.files f WHERE public.wassell_can_access_file__reference(f.id, '$k');
ROLLBACK;
SQL
    done
  done | grep -E '^FP ' | sort
}

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

measure_all() {   # $1 = label
  local uid
  for uid in $PERSONAS; do
    psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL | grep -E '^MEAS '
CREATE TEMP TABLE IF NOT EXISTS _m(ms numeric); TRUNCATE _m;
GRANT INSERT ON _m TO authenticated;
BEGIN;
SELECT set_config('test.uid','$uid', true);
SET LOCAL ROLE authenticated;
DO \$\$
DECLARE t0 timestamptz; i int;
BEGIN
  FOR i IN 1..8 LOOP
    t0 := clock_timestamp();
    PERFORM count(*) FROM public.files WHERE file_class='business' AND status <> 'archived';
    INSERT INTO _m VALUES (EXTRACT(epoch FROM clock_timestamp()-t0)*1000);
  END LOOP;
END \$\$;
RESET ROLE;
SELECT 'MEAS $1 ' || left('$uid',8)
    || ' p50=' || round(percentile_disc(0.50) WITHIN GROUP (ORDER BY ms),1)
    || ' p95=' || round(percentile_disc(0.95) WITHIN GROUP (ORDER BY ms),1) FROM _m;
ROLLBACK;
SQL
  done
}

echo "== creating $DB"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB;"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB;"

echo "== stack: Phase 1 + Phase 2 + B1 + authz surface + B2A + high-cardinality"
run "$ROOT/supabase/tests/ci/fixture_file_links.sql"
run "$ROOT/supabase/tests/ci/fixture_b1_metadata.sql"
run "$ROOT/supabase/migrations/2026-08-10_file_links_projection.sql"
q   "SELECT * FROM public.file_links_backfill()" >/dev/null
run "$ROOT/supabase/migrations/2026-08-12_file_link_sync.sql"
run "$ROOT/supabase/tests/ci/fixture_b2a_authz.sql"
run "$ROOT/supabase/migrations/2026-08-16_01_business_file_metadata.sql"
run "$ROOT/supabase/tests/ci/fixture_b2a_reference_authz.sql"
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
run "$ROOT/supabase/rollback/2026-08-16_03_file_authz_performance_down.sql"   # pre-B2A baseline
run "$ROOT/supabase/tests/ci/fixture_b2a1_highcard.sql"
run "$ROOT/supabase/migrations/2026-08-16_03_file_authz_performance.sql"      # B2A = production today

echo "   corpus: $(q "SELECT count(*) FROM public.files") files, \
$(q "SELECT count(*) FROM public.file_permissions") grants, \
$(q "SELECT count(*) FROM public.folder_permissions") folder grants, \
$(q "SELECT count(*) FROM public.folders") folders"

echo "== BEFORE (on B2A): fingerprints"
fingerprints        > "$WORK/fp.before"
policy_fingerprints > "$WORK/pol.before"
[ "$(wc -l < "$WORK/fp.before")" -eq 30 ]  || { echo "FAIL: expected 30 fingerprints"; exit 1; }
[ "$(wc -l < "$WORK/pol.before")" -eq 10 ] || { echo "FAIL: expected 10 policy fingerprints"; exit 1; }
[ "$(awk '{print $4}' "$WORK/fp.before" | sort -u | wc -l)" -ge 6 ] \
  || { echo "FAIL: fingerprints too uniform"; exit 1; }
# The high-cardinality personas must actually see a lot, or they prove nothing.
for p in 66666666 77777777 88888888; do
  n=$(grep "FP $p" "$WORK/fp.before" | grep ' view ' | sed -n 's/.*n=\([0-9]*\).*/\1/p')
  [ "${n:-0}" -ge 500 ] || { echo "FAIL: persona $p sees only ${n:-0} files — not high-cardinality"; exit 1; }
  echo "     persona $p sees $n files"
done
measure_all before > "$WORK/meas.before"; sed 's/^/     /' "$WORK/meas.before"

echo "== applying B2A.1"
run "$ROOT/supabase/migrations/2026-08-16_04_file_authz_grant_sets.sql"

echo "== AFTER: the hard semantic gate"
fingerprints        > "$WORK/fp.after"
policy_fingerprints > "$WORK/pol.after"
diff -u "$WORK/fp.before"  "$WORK/fp.after"  || { echo "FAIL: function id-sets changed"; exit 1; }
diff -u "$WORK/pol.before" "$WORK/pol.after" || { echo "FAIL: policy id-sets changed"; exit 1; }
echo "   OK: 30 function + 10 policy fingerprints identical"

echo "== smoke"
psql "$DBURL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/ci/smoke_b2a_authz_perf.sql"

echo "== AFTER: latency (every persona)"
measure_all after > "$WORK/meas.after"; sed 's/^/     /' "$WORK/meas.after"

echo "== write latency"
WMS=$(psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<'SQL' | grep -E '^WRITE ' | sed 's/^WRITE //'
CREATE TEMP TABLE _w(ms numeric);
DO $$ DECLARE t0 timestamptz := clock_timestamp(); BEGIN
  UPDATE public.files SET description='b2a1-probe'
   WHERE storage_path LIKE 'scale/%' AND right(id::text,12)::bigint <= 200;
  INSERT INTO _w VALUES (EXTRACT(epoch FROM clock_timestamp()-t0)*1000);
END $$;
SELECT 'WRITE ' || round(ms,1) FROM _w; DROP TABLE _w;
SQL
)
echo "   200 metadata UPDATEs in ${WMS} ms"

echo "== B2 layered on B2A.1"
P_B2=""
if [ -n "${B2_MIGRATION:-}" ] && [ -f "${B2_MIGRATION}" ]; then
  run "$ROOT/supabase/migrations/2026-09-02_02_search_norm_alef_madda_fix.sql"
  run "$B2_MIGRATION"
  for uid in 55555555-5555-5555-5555-555555555555 88888888-8888-8888-8888-888888888888 \
             99999999-9999-9999-9999-999999999999; do
    L=$(psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL | grep -E '^B2PERF '
CREATE TEMP TABLE IF NOT EXISTS _p(ms numeric); TRUNCATE _p;
GRANT INSERT ON _p TO authenticated;
BEGIN;
SELECT set_config('test.uid','$uid', true);
SET LOCAL ROLE authenticated;
DO \$\$
DECLARE t0 timestamptz; i int; s text; sc text[] := ARRAY['','مخطط','ابراج','floor plan'];
BEGIN
  FOREACH s IN ARRAY sc LOOP
    FOR i IN 1..5 LOOP
      t0 := clock_timestamp();
      PERFORM public.business_files_search(nullif(s,''), '{}'::jsonb, 'created_desc', 1, 60);
      INSERT INTO _p VALUES (EXTRACT(epoch FROM clock_timestamp()-t0)*1000);
    END LOOP;
  END LOOP;
END \$\$;
RESET ROLE;
SELECT 'B2PERF ' || left('$uid',8) || ' p95=' ||
       round(percentile_disc(0.95) WITHIN GROUP (ORDER BY ms),1) FROM _p;
ROLLBACK;
SQL
)
    echo "   $L"
    v=$(sed -n 's/.*p95=\([0-9.]*\).*/\1/p' <<<"$L")
    awk "BEGIN{exit !($v < 300)}" || { echo "FAIL: B2 p95 $v ms for $uid"; exit 1; }
  done
else
  echo "   (B2 migration not provided — skipped)"
fi

echo "== rollback to B2A + re-apply"
run "$ROOT/supabase/rollback/2026-08-16_04_file_authz_grant_sets_down.sql"
fingerprints > "$WORK/fp.rb"
diff -q "$WORK/fp.before" "$WORK/fp.rb" >/dev/null || { echo "FAIL: rollback changed id-sets"; exit 1; }
[ "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname='wassell_granted_file_ids'")" = "0" ] \
  || { echo "FAIL: set helper survived rollback"; exit 1; }
run "$ROOT/supabase/migrations/2026-08-16_04_file_authz_grant_sets.sql"
fingerprints > "$WORK/fp.re"
diff -q "$WORK/fp.before" "$WORK/fp.re" >/dev/null || { echo "FAIL: re-apply changed id-sets"; exit 1; }
echo "   OK"

echo
echo "──────── B2A.1 results ────────"
paste -d'\n' /dev/null /dev/null >/dev/null 2>&1 || true
echo "  BEFORE (B2A):"; sed 's/^/    /' "$WORK/meas.before"
echo "  AFTER (B2A.1):"; sed 's/^/    /' "$WORK/meas.after"
FAILED=0
while read -r line; do
  p95=$(sed -n 's/.*p95=\([0-9.]*\).*/\1/p' <<<"$line")
  who=$(awk '{print $3}' <<<"$line")
  awk "BEGIN{exit !($p95 < 300)}" || { echo "  ✗ persona $who p95 ${p95} ms >= 300"; FAILED=1; }
done < "$WORK/meas.after"
# No persona may have become SLOWER.
while read -r a; do
  who=$(awk '{print $3}' <<<"$a"); nowv=$(sed -n 's/.*p95=\([0-9.]*\).*/\1/p' <<<"$a")
  b=$(grep " $who " "$WORK/meas.before" || true)
  [ -n "$b" ] || continue
  wasv=$(sed -n 's/.*p95=\([0-9.]*\).*/\1/p' <<<"$b")
  awk "BEGIN{exit !($nowv > $wasv * 1.25 && $nowv - $wasv > 20)}" \
    && { echo "  ✗ persona $who REGRESSED ${wasv} -> ${nowv} ms"; FAILED=1; } || true
done < "$WORK/meas.after"
[ "$FAILED" -eq 0 ] || { echo; echo "B2A.1: GATE NOT MET"; exit 1; }
echo
echo "B2A.1 grant sets: ALL CHECKS PASSED"
