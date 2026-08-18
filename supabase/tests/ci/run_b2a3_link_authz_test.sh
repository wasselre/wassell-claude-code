#!/usr/bin/env bash
# ============================================================================
# Designated validator for supabase/migrations/2026-08-18_01_link_authz_set_based.sql
#
# B2A.3 changes an AUTHORIZATION predicate, so the bar matches B2A/B2A.2: the
# exact EDGE set every persona may read must be provably unchanged, and the
# suite must be able to demonstrate the leaks it prevents.
# ============================================================================
set -euo pipefail

PGURL="${PGURL:-postgresql://postgres:ci@localhost:5432/postgres}"
DB=wassell_b2a3
BASE="${PGURL%/*}"; DBURL="$BASE/$DB"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

q()   { psql "$DBURL" -v ON_ERROR_STOP=1 -tAqc "$1"; }
run() { psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$1"; }

PERSONAS="99999999-9999-9999-9999-999999999999
11111111-1111-1111-1111-111111111111
22222222-2222-2222-2222-222222222222
33333333-3333-3333-3333-333333333333
44444444-4444-4444-4444-444444444444
55555555-5555-5555-5555-555555555555
88888888-8888-8888-8888-888888888888
00000000-0000-0000-0000-0000000000ff"

edge_fp() {
  local uid
  for uid in $PERSONAS; do
    psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL | grep -E "^EFP "
BEGIN;
SET LOCAL statement_timeout='300s';
SELECT set_config('test.uid','$uid', true);
SET LOCAL ROLE authenticated;
SELECT 'EFP $uid ' || coalesce(md5(string_agg(
         l.file_id::text||':'||l.model_id::text||':'||l.record_id::text,
         ',' ORDER BY l.file_id, l.model_id, l.record_id)),'EMPTY')
    || ' n=' || count(*) FROM public.file_links l;
ROLLBACK;
SQL
  done | sort
}

facet_latency() {
  local uid
  for uid in $PERSONAS; do
    psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL | grep -E "^LAT "
CREATE TEMP TABLE IF NOT EXISTS _l(v text); TRUNCATE _l;
GRANT INSERT ON _l TO authenticated;
BEGIN;
SET LOCAL statement_timeout='300s';
SELECT set_config('test.uid','$uid', true);
SET LOCAL ROLE authenticated;
DO \$\$
DECLARE t0 timestamptz; a numeric; b numeric; c numeric;
BEGIN
  t0 := clock_timestamp();
  PERFORM m.name, count(DISTINCT l.file_id) FROM public.file_links l
     JOIN public.models m ON m.id = l.model_id GROUP BY m.name;
  a := EXTRACT(epoch FROM clock_timestamp()-t0)*1000;
  t0 := clock_timestamp();
  PERFORM l.role, count(DISTINCT l.file_id) FROM public.file_links l GROUP BY l.role;
  b := EXTRACT(epoch FROM clock_timestamp()-t0)*1000;
  t0 := clock_timestamp();
  PERFORM f.id, (SELECT count(*) FROM public.file_links l WHERE l.file_id = f.id)
     FROM public.files f ORDER BY f.created_at DESC LIMIT 60;
  c := EXTRACT(epoch FROM clock_timestamp()-t0)*1000;
  INSERT INTO _l VALUES ('LAT $1 ' || left('$uid',8) || ' lm=' || round(a,1)
    || ' role=' || round(b,1) || ' lc=' || round(c,1));
END \$\$;
RESET ROLE;
SELECT v FROM _l;
ROLLBACK;
SQL
  done
}

worst_of() { grep -oE "(lm|role|lc)=[0-9.]+" "$1" | cut -d= -f2 | sort -g | tail -1; }

echo "== creating $DB"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB;"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB;"

echo "== stack through B2A.2 + helper scoping"
run "$ROOT/supabase/tests/ci/fixture_file_links.sql"
run "$ROOT/supabase/tests/ci/fixture_b1_metadata.sql"
run "$ROOT/supabase/migrations/2026-08-10_file_links_projection.sql"
q   "SELECT * FROM public.file_links_backfill()" >/dev/null
run "$ROOT/supabase/migrations/2026-08-12_file_link_sync.sql"
run "$ROOT/supabase/tests/ci/fixture_b2a_authz.sql"
run "$ROOT/supabase/migrations/2026-08-16_01_business_file_metadata.sql"
psql "$DBURL" -v ON_ERROR_STOP=1 -q -c "ALTER TABLE public.files ENABLE ROW LEVEL SECURITY; GRANT SELECT ON public.files TO authenticated;"
run "$ROOT/supabase/rollback/2026-08-16_03_file_authz_performance_down.sql"
run "$ROOT/supabase/tests/ci/fixture_b2a1_highcard.sql"
run "$ROOT/supabase/migrations/2026-08-16_03_file_authz_performance.sql"
run "$ROOT/supabase/migrations/2026-08-16_06_file_authz_grant_sets_v2.sql"
run "$ROOT/supabase/migrations/2026-08-17_01_scope_authz_helpers.sql"
run "$ROOT/supabase/tests/ci/fixture_b2a3_edges.sql"
echo "   corpus: $(q "SELECT count(*) FROM public.files") files, $(q "SELECT count(*) FROM public.file_links") edges"

echo
echo "== BEFORE (on B2A.2): edge fingerprints"
edge_fp > "$WORK/e.before"
[ "$(wc -l < "$WORK/e.before")" -eq 8 ] || { echo "FAIL: expected 8 edge fingerprints"; exit 1; }
sed 's/^/   /' "$WORK/e.before"
NZ=$(grep -c "n=[1-9]" "$WORK/e.before" || true)
[ "$NZ" -ge 3 ] || { echo "FAIL: only $NZ personas see edges - corpus does not discriminate"; exit 1; }
[ "$(awk '{print $3}' "$WORK/e.before" | sort -u | wc -l)" -ge 3 ] \
  || { echo "FAIL: edge fingerprints too uniform"; exit 1; }
facet_latency before > "$WORK/lat.before"; sed 's/^/   /' "$WORK/lat.before"
echo "   worst facet BEFORE: $(worst_of "$WORK/lat.before") ms"

echo
echo "== applying B2A.3"
run "$ROOT/supabase/migrations/2026-08-18_01_link_authz_set_based.sql"
edge_fp > "$WORK/e.after"
diff -u "$WORK/e.before" "$WORK/e.after" || { echo "FAIL: EDGE SETS CHANGED"; exit 1; }
echo "   OK: all 8 edge fingerprints identical"

echo
echo "== negative controls (each half removed separately must LEAK)"
run "$ROOT/supabase/tests/ci/mutant_b2a3_drop_file_visibility.sql"
edge_fp > "$WORK/e.mutA"
diff -q "$WORK/e.after" "$WORK/e.mutA" >/dev/null \
  && { echo "FAIL: removing FILE-visibility changed nothing - that half is untested"; exit 1; } || true
echo "   OK: dropping file-visibility diverges"
run "$ROOT/supabase/migrations/2026-08-18_01_link_authz_set_based.sql"

run "$ROOT/supabase/tests/ci/mutant_b2a3_drop_record_visibility.sql"
edge_fp > "$WORK/e.mutB"
diff -q "$WORK/e.after" "$WORK/e.mutB" >/dev/null \
  && { echo "FAIL: removing RECORD-visibility changed nothing - target privacy untested"; exit 1; } || true
echo "   OK: dropping record-visibility diverges"
run "$ROOT/supabase/migrations/2026-08-18_01_link_authz_set_based.sql"
edge_fp > "$WORK/e.restored"
diff -q "$WORK/e.after" "$WORK/e.restored" >/dev/null \
  || { echo "FAIL: restoring after the mutants did not return to baseline"; exit 1; }
echo "   OK: restored to baseline"

echo
echo "== smoke"
psql "$DBURL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/ci/smoke_b2a3_link_authz.sql"

echo
echo "== latency AFTER"
facet_latency after > "$WORK/lat.after"; sed 's/^/   /' "$WORK/lat.after"
WORST=$(worst_of "$WORK/lat.after")
echo "   worst facet: $(worst_of "$WORK/lat.before") ms -> ${WORST} ms"

echo
echo "== B2 layered on B2A.3"
P_B2=""
if [ -n "${B2_MIGRATION:-}" ] && [ -f "${B2_MIGRATION}" ]; then
  run "$ROOT/supabase/migrations/2026-09-02_02_search_norm_alef_madda_fix.sql"
  run "$B2_MIGRATION"
  for uid in 55555555-5555-5555-5555-555555555555 88888888-8888-8888-8888-888888888888 99999999-9999-9999-9999-999999999999; do
    L=$(psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL | grep -E "^B2 "
CREATE TEMP TABLE IF NOT EXISTS _p(ms numeric); TRUNCATE _p;
GRANT INSERT ON _p TO authenticated;
BEGIN;
SET LOCAL statement_timeout='300s';
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
SELECT 'B2 ' || left('$uid',8) || ' p95=' || round(percentile_disc(0.95) WITHIN GROUP (ORDER BY ms),1) FROM _p;
ROLLBACK;
SQL
)
    echo "   $L"
    P_B2="$P_B2 $(grep -o 'p95=[0-9.]*' <<<"$L" | cut -d= -f2)"
  done
else
  echo "   (B2 migration not provided - skipped)"
fi

echo
echo "== rollback + re-apply"
run "$ROOT/supabase/rollback/2026-08-18_01_link_authz_set_based_down.sql"
edge_fp > "$WORK/e.rb"
diff -u "$WORK/e.before" "$WORK/e.rb"   || { echo "FAIL: rollback changed edge sets (diff above: -=before +=after rollback)"; exit 1; }
run "$ROOT/supabase/migrations/2026-08-18_01_link_authz_set_based.sql"
edge_fp > "$WORK/e.re"
diff -u "$WORK/e.before" "$WORK/e.re"   || { echo "FAIL: re-apply changed edge sets (diff above)"; exit 1; }
echo "   OK: rollback and re-application both preserve every edge set"

echo
echo "-------- B2A.3 verdict --------"
FAILED=0
awk "BEGIN{exit !($WORST < 300)}" || { echo "  x worst facet ${WORST} ms >= 300"; FAILED=1; }
for v in $P_B2; do
  awk "BEGIN{exit !($v < 300)}" || { echo "  x B2 search p95 ${v} ms >= 300"; FAILED=1; }
done
[ "$FAILED" -eq 0 ] || { echo; echo "B2A.3: SEMANTICS OK, PERFORMANCE GATE NOT MET"; exit 1; }
echo
echo "B2A.3 link authz: ALL CHECKS PASSED"
