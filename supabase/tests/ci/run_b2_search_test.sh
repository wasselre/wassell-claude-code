#!/usr/bin/env bash
# ============================================================================
# Designated validator for supabase/migrations/2026-08-16_02_business_files_search.sql
#
# Builds the full Phase 1 → Phase 2 → B1 → B2 stack in its own database, loads
# an 8,000-row production-shaped corpus, and proves:
#
#   1. the migration applies on top of B1
#   2. search/facet/pagination correctness (smoke_b2_search.sql)
#   3. RLS is REAL: different users get different row sets, and no user can see
#      a file through the RPC that they could not already SELECT directly
#   4. p95 < 300 ms at production scale, measured as a non-admin (the expensive
#      case, because the cheap `uploaded_by = me` disjunct does not short it)
#   5. B1's updated_at history and the projection survive B2
#   6. the rollback restores the post-B1 structure exactly
#
# Usage:  PGURL=postgresql://... bash supabase/tests/ci/run_b2_search_test.sh
# ============================================================================
set -euo pipefail

PGURL="${PGURL:-postgresql://postgres:ci@localhost:5432/postgres}"
DB=wassell_b2_search
BASE="${PGURL%/*}"
DBURL="$BASE/$DB"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

q()   { psql "$DBURL" -v ON_ERROR_STOP=1 -tAqc "$1"; }
run() { psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$1"; }

echo "== creating $DB"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB;"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB;"

echo "== Phase 1 + Phase 2 + B1"
run "$ROOT/supabase/tests/ci/fixture_file_links.sql"
# wassell_search_norm is defined by the translation migration set, which the
# db-migrations job applies to a DIFFERENT database. B2's folding MUST use the
# real function rather than a copy pasted into a fixture — a copy is exactly how
# the client/SQL folding pair drifts apart, which CLAUDE.md calls out as a
# correctness rule. 2026-09-02_02 is the CURRENT definition (the alef-madda fix)
# and is self-contained: its only other statement is a REINDEX loop guarded by
# IF EXISTS, so it applies cleanly to a database with no translation tables.
run "$ROOT/supabase/migrations/2026-09-02_02_search_norm_alef_madda_fix.sql"
run "$ROOT/supabase/tests/ci/fixture_b1_metadata.sql"
run "$ROOT/supabase/migrations/2026-08-10_file_links_projection.sql"
q   "SELECT * FROM public.file_links_backfill()" >/dev/null
run "$ROOT/supabase/migrations/2026-08-12_file_link_sync.sql"
# INTEGRATION (2026-08-17): build on the REAL authorization stack.
#
# This runner used to stop at B1 and fixture_b1_authz, a simplified predicate.
# That made its p95 meaningless once B2A and B2A.2 shipped: it was measuring
# search over an authorization path production no longer runs, and it is the
# authorization path — not the search layer — that dominated the cost. B2 was
# blocked at 617 ms against a 300 ms budget for exactly that reason.
#
# fixture_b2a_authz.sql brings the production-shaped surface (recursive folder
# cascade, faithful wassell_mos_can returning TRUE for any identity, personas
# for every branch) AND the 8,000-row corpus. fixture_b2_scale.sql then stamps
# the search-specific attributes onto it.
run "$ROOT/supabase/tests/ci/fixture_b2a_authz.sql"
run "$ROOT/supabase/migrations/2026-08-16_01_business_file_metadata.sql"
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
run "$ROOT/supabase/rollback/2026-08-16_03_file_authz_performance_down.sql"   # pre-B2A baseline predicate
run "$ROOT/supabase/migrations/2026-08-16_03_file_authz_performance.sql"      # B2A
run "$ROOT/supabase/migrations/2026-08-16_06_file_authz_grant_sets_v2.sql"    # B2A.2
run "$ROOT/supabase/migrations/2026-08-17_01_scope_authz_helpers.sql"          # caller-scoped helpers
run "$ROOT/supabase/migrations/2026-08-18_02_link_authz_denormalized.sql"      # B2A.4 = production today
# The stack above must stay equal to what production actually runs. It said
# "B2A.2 = production today" until 2026-08-18, by which point two more
# authorization migrations had shipped — so B2 was being measured against a
# database that no longer resembled the one it will run on. B2A.4 in particular
# rewrites BOTH files_select and file_links_select and adds two columns to
# file_links, which is exactly the surface business_files_search reads through.

# The pre-B2 population is "every row whose storage_path is not a scale/ row".
# coalesce() is load-bearing: the Phase 1 fixture inserts files with a NULL
# storage_path, and `NULL NOT LIKE 'scale/%'` is NULL, not true — so a bare
# NOT LIKE silently drops 11 of the 19 rows and compares two different
# populations either side of the apply.
PRE_PRED="coalesce(storage_path,'') NOT LIKE 'scale/%'"
UPD_B1=$(q "SELECT md5(string_agg(id::text||'|'||updated_at::text, ',' ORDER BY id))
              FROM public.files WHERE $PRE_PRED")
PRE_N=$(q "SELECT count(*) FROM public.files WHERE $PRE_PRED")
E0=$(q "SELECT count(*) FROM public.file_links")
echo "   pre-B2 baseline: $PRE_N rows, $E0 edges"

echo "== applying B2"
run "$ROOT/supabase/migrations/2026-08-16_02_business_files_search.sql"
# B2 is purely additive: it must not create, destroy or reclassify one edge.
# Checked HERE, before the scale corpus deliberately links files and grows the
# projection legitimately.
[ "$(q "SELECT count(*) FROM public.file_links")" = "$E0" ] \
  || { echo "FAIL: B2 itself changed the projection edge count"; exit 1; }

echo "== loading the 8,000-row production-shaped corpus"
run "$ROOT/supabase/tests/ci/fixture_b2_scale.sql"
N=$(q "SELECT count(*) FROM public.files")
echo "   corpus: $N files, $(q "SELECT count(*) FROM public.file_links") edges"
[ "$N" -ge 8000 ] || { echo "FAIL: corpus is only $N rows"; exit 1; }

# ── B1 invariants must survive B2 ───────────────────────────────────────────
# ADD COLUMN rewrites the table but fires no row trigger, so the 19 pre-existing
# rows must keep their exact updated_at.
UPD_NOW=$(q "SELECT md5(string_agg(id::text||'|'||updated_at::text, ',' ORDER BY id))
               FROM public.files WHERE $PRE_PRED")
PRE=$(q "SELECT count(*) FROM public.files WHERE $PRE_PRED")
echo "   pre-B2 rows still present: $PRE (baseline was $PRE_N)"
[ "$PRE" = "$PRE_N" ] || { echo "FAIL: pre-B2 row count changed $PRE_N -> $PRE"; exit 1; }
# B2 adds a STORED generated column, which rewrites the table. A rewrite fires
# no row trigger, so B1's preserved updated_at history must come through
# untouched — assert it rather than assume it.
[ "$UPD_NOW" = "$UPD_B1" ] \
  || { echo "FAIL: B2 changed updated_at on pre-existing rows ($UPD_B1 -> $UPD_NOW)"; exit 1; }
[ "$(q "SELECT coalesce(sum(value),0) FROM public.file_links_reconcile() WHERE category='drift'")" = "0" ] \
  || { echo "FAIL: B2 introduced projection drift"; exit 1; }
[ "$(q "SELECT count(*) FROM public.file_link_dirty_targets")" = "0" ] \
  || { echo "FAIL: dirty targets left at rest"; exit 1; }
[ "$(q "SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.files'::regclass
          AND tgname='files_set_updated_at'")" = "O" ] \
  || { echo "FAIL: B2 disturbed the timestamp trigger"; exit 1; }
echo "   OK: drift 0, dirty 0, timestamp trigger intact"

echo "== smoke assertions"
psql "$DBURL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/ci/smoke_b2_search.sql"

# ── RLS is real, and the RPC is a strict subset of direct SELECT ────────────
echo "== RLS: per-user row sets"
UIDS='11111111-1111-1111-1111-111111111111
22222222-2222-2222-2222-222222222222
33333333-3333-3333-3333-333333333333
99999999-9999-9999-9999-999999999999'
: > "$WORK/rls.txt"
for uid in $UIDS; do
  psql "$DBURL" -v ON_ERROR_STOP=1 -tAq >> "$WORK/rls.txt" <<SQL
BEGIN;
SELECT set_config('test.uid', '$uid', true);
SET LOCAL ROLE authenticated;
WITH r AS (SELECT public.business_files_search(NULL,'{}'::jsonb,'created_desc',1,200) AS j)
SELECT '$uid'
    || ' rpc_total=' || (SELECT (j->>'total')::bigint FROM r)
    || ' direct_visible=' || (SELECT count(*) FROM public.files
                               WHERE file_class='business' AND status <> 'archived')
    || ' leaked=' || (
         SELECT count(*) FROM r, jsonb_array_elements(r.j->'rows') e
          WHERE NOT EXISTS (SELECT 1 FROM public.files f WHERE f.id = (e->>'id')::uuid));
ROLLBACK;
SQL
done
# Filter on the payload marker, NOT on "looks like a uuid": `SELECT set_config()`
# echoes the uid as its own result row, so a uuid-shaped filter also picks up
# four bare uid lines that carry no measurement and fail the leaked=0 check.
grep -E 'rpc_total=' "$WORK/rls.txt" | sort > "$WORK/rls.sorted"
[ "$(wc -l < "$WORK/rls.sorted")" -eq 4 ] \
  || { echo "FAIL: expected 4 per-user measurements, got $(wc -l < "$WORK/rls.sorted")"; exit 1; }
sed 's/^/     /' "$WORK/rls.sorted"

# Every row the RPC returned must be directly SELECTable by that same user.
if grep -qv 'leaked=0' "$WORK/rls.sorted"; then
  echo "FAIL: the RPC returned rows the caller cannot SELECT directly"; exit 1
fi
# rpc_total must equal what the caller can see directly — never more.
while read -r line; do
  rpc=$(sed -n 's/.*rpc_total=\([0-9]*\).*/\1/p' <<<"$line")
  dir=$(sed -n 's/.*direct_visible=\([0-9]*\).*/\1/p' <<<"$line")
  [ "$rpc" -le "$dir" ] || { echo "FAIL: rpc_total $rpc > direct_visible $dir"; exit 1; }
done < "$WORK/rls.sorted"
# And the whole point: users must NOT all see the same thing.
DISTINCT=$(sed -n 's/.*rpc_total=\([0-9]*\).*/\1/p' "$WORK/rls.sorted" | sort -u | wc -l)
[ "$DISTINCT" -ge 2 ] || { echo "FAIL: every user saw the same total — RLS is not being applied"; exit 1; }
echo "   OK: $DISTINCT distinct row-set sizes, no leakage, RPC ⊆ direct SELECT"

# ── p95 at production scale, as a NON-ADMIN ────────────────────────────────
echo "== performance (40 calls, non-admin, 8k corpus)"
# MEASURED HERE, ASSERTED AT THE END. A perf failure that aborts the script
# hides whether rollback and re-application work, which is exactly the evidence
# needed to decide what to do about the perf failure.
# Measured for THREE personas, deliberately including the two the B2A.2 runner
# uses, so a number here can be compared directly with the 69-78 ms it reported
# for the same migration on the same authorization stack. A divergence then
# points at the persona or the corpus, not at "search is slow".
: > "$WORK/perf.txt"
for PU in 22222222-2222-2222-2222-222222222222           55555555-5555-5555-5555-555555555555           99999999-9999-9999-9999-999999999999; do
  psql "$DBURL" -v ON_ERROR_STOP=1 -tAq >> "$WORK/perf.txt" <<SQL
CREATE TEMP TABLE IF NOT EXISTS _perf(ms numeric); TRUNCATE _perf;
GRANT INSERT ON _perf TO authenticated;
BEGIN;
SELECT set_config('test.uid','$PU', true);
SET LOCAL ROLE authenticated;
DO \$\$
DECLARE t0 timestamptz; i int; s text;
        scenarios text[] := ARRAY['','مخطط','ابراج','floor plan'];
BEGIN
  FOREACH s IN ARRAY scenarios LOOP
    FOR i IN 1..10 LOOP
      t0 := clock_timestamp();
      PERFORM public.business_files_search(nullif(s,''), '{}'::jsonb, 'created_desc', 1, 60);
      INSERT INTO _perf VALUES (EXTRACT(epoch FROM clock_timestamp() - t0) * 1000);
    END LOOP;
  END LOOP;
END \$\$;
RESET ROLE;
SELECT 'PERF ' || left('$PU',8)
    || ' n='   || count(*)
    || ' p50=' || round(percentile_disc(0.50) WITHIN GROUP (ORDER BY ms), 1)
    || ' p95=' || round(percentile_disc(0.95) WITHIN GROUP (ORDER BY ms), 1)
    || ' max=' || round(max(ms), 1)
  FROM _perf;
ROLLBACK;
SQL
done
grep -E '^PERF ' "$WORK/perf.txt" > "$WORK/perf.lines" || true
[ "$(wc -l < "$WORK/perf.lines")" -eq 3 ]   || { echo "FAIL: expected 3 persona measurements, got $(wc -l < "$WORK/perf.lines")"; exit 1; }
sed 's/^/   /' "$WORK/perf.lines"
P95=$(grep -o "p95=[0-9.]*" "$WORK/perf.lines" | cut -d= -f2 | sort -g | tail -1)
echo "   worst persona p95 = ${P95} ms"

# ── rollback ────────────────────────────────────────────────────────────────
echo "== rollback"
run "$ROOT/supabase/rollback/2026-08-16_02_business_files_search_down.sql"
[ "$(q "SELECT count(*) FROM information_schema.columns
          WHERE table_schema='public' AND table_name='files' AND column_name='search_text'")" = "0" ] \
  || { echo "FAIL: search_text survived the rollback"; exit 1; }
[ "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname='business_files_search'")" = "0" ] \
  || { echo "FAIL: the function survived the rollback"; exit 1; }
# B1 must be untouched by B2's rollback.
[ "$(q "SELECT count(*) FROM information_schema.columns
          WHERE table_schema='public' AND table_name='files'
            AND column_name IN ('title','document_type','file_class','confidentiality')")" = "4" ] \
  || { echo "FAIL: B2 rollback damaged B1"; exit 1; }
[ "$(q "SELECT coalesce(sum(value),0) FROM public.file_links_reconcile() WHERE category='drift'")" = "0" ] \
  || { echo "FAIL: rollback introduced drift"; exit 1; }
echo "   OK: B2 removed, B1 intact, drift 0"

echo "== re-apply after rollback"
run "$ROOT/supabase/migrations/2026-08-16_02_business_files_search.sql"
[ "$(q "SELECT count(*) FROM public.files WHERE search_text IS NULL")" = "0" ] \
  || { echo "FAIL: search_text not regenerated"; exit 1; }
echo "   OK"

# ── the p95 budget, asserted last so everything above is on the record ──────
echo "== p95 budget"
echo "   measured: $PERF_LINE"
if awk "BEGIN{exit !($P95 >= 300)}"; then
  cat <<EOF

  ✗ p95 is ${P95} ms against a 300 ms budget.

  This is NOT the search layer. The cost is the per-row authorization filter in
  the files_select RLS policy, which B2 is simply the first feature to exercise
  over a whole corpus. Measured on PRODUCTION (7,133 rows), a bare
      SELECT count(*) FROM files WHERE file_class='business'
  costs 1,688 ms as an admin and 3,727 ms as a non-admin, with ~300k buffer
  hits — all cache hits, so it is pure CPU in
  wassell_app_user_id() + wassell_can_access_file(), both invoked per row.

  B2 cannot fix this without editing the authorization surface, which is out of
  its scope and belongs with B4 (which rewrites wassell_can_access_file anyway).
EOF
  exit 1
fi
echo "   OK: within budget"

echo
echo "B2 search: ALL CHECKS PASSED"
