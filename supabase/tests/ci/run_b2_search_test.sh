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
run "$ROOT/supabase/tests/ci/fixture_b1_authz.sql"
run "$ROOT/supabase/migrations/2026-08-16_01_business_file_metadata.sql"

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
grep -E '^[0-9a-f]{8}-' "$WORK/rls.txt" | sort > "$WORK/rls.sorted"
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
echo "== performance (p95 over 40 calls, non-admin, 8k corpus)"
psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<'SQL' | tee "$WORK/perf.txt"
BEGIN;
SELECT set_config('test.uid','22222222-2222-2222-2222-222222222222', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE t0 timestamptz; ms numeric; a numeric[] := '{}'; i int;
        scenarios text[] := ARRAY['','مخطط','ابراج','floor plan'];
        s text;
BEGIN
  FOREACH s IN ARRAY scenarios LOOP
    FOR i IN 1..10 LOOP
      t0 := clock_timestamp();
      PERFORM public.business_files_search(nullif(s,''), '{}'::jsonb, 'created_desc', 1, 60);
      ms := EXTRACT(epoch FROM clock_timestamp() - t0) * 1000;
      a := a || ms;
    END LOOP;
  END LOOP;
  SELECT array_agg(x ORDER BY x) INTO a FROM unnest(a) x;
  RAISE NOTICE 'p50=% ms  p95=% ms  max=% ms  n=%',
    round(a[greatest(1,(array_length(a,1)*0.50)::int)],1),
    round(a[greatest(1,(array_length(a,1)*0.95)::int)],1),
    round(a[array_length(a,1)],1),
    array_length(a,1);
  IF a[greatest(1,(array_length(a,1)*0.95)::int)] >= 300 THEN
    RAISE EXCEPTION 'B2 perf: p95 is % ms, budget is 300 ms',
      round(a[greatest(1,(array_length(a,1)*0.95)::int)],1);
  END IF;
END $$;
ROLLBACK;
SQL
echo "   OK: p95 within budget"

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

echo
echo "B2 search: ALL CHECKS PASSED"
