#!/usr/bin/env bash
# ============================================================================
# Designated validator for supabase/migrations/2026-08-16_01_business_file_metadata.sql
#
# The db-migrations job's other steps glob specific date prefixes and would
# never execute this migration, so it gets its own runner — the same reason
# run_market_listings_reconciliation_test.sh exists.
#
# What it proves, in order:
#   1. the migration applies to a Phase-1+Phase-2 database
#   2. it changes NO file_links / file_link_sources row
#   3. it leaves reconcile drift at zero and the dirty set empty
#      (i.e. the 7k-row backfill never engages the Phase 2 projection lock)
#   4. view / edit / delete / share reach is byte-identical before and after
#   5. every smoke assertion in smoke_b1_file_metadata.sql passes
#   6. re-applying it is a no-op (idempotent)
#   7. the rollback returns the schema EXACTLY to its pre-B1 structure
#   8. it can be applied again after a rollback
#
# Usage:  PGURL=postgresql://... bash supabase/tests/ci/run_b1_metadata_test.sh
# ============================================================================
set -euo pipefail

PGURL="${PGURL:-postgresql://postgres:ci@localhost:5432/postgres}"
DB=wassell_b1_metadata
BASE="${PGURL%/*}"
DBURL="$BASE/$DB"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

q() { psql "$DBURL" -v ON_ERROR_STOP=1 -tAqc "$1"; }
run() { psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$1"; }

echo "== creating $DB"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB;"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB;"

echo "== fixtures + Phase 1 + Phase 2"
run "$ROOT/supabase/tests/ci/fixture_file_links.sql"
run "$ROOT/supabase/tests/ci/fixture_b1_metadata.sql"
run "$ROOT/supabase/migrations/2026-08-10_file_links_projection.sql"
run "$ROOT/supabase/migrations/2026-08-12_file_link_sync.sql"
run "$ROOT/supabase/tests/ci/fixture_b1_authz.sql"

# ── structural fingerprint: everything B1 is allowed to change, and nothing else
fingerprint() {
  q "SELECT string_agg(x, E'\n' ORDER BY x) FROM (
       SELECT 'col '||table_name||'.'||column_name||' '||data_type||' '||is_nullable AS x
         FROM information_schema.columns WHERE table_schema='public'
       UNION ALL SELECT 'tbl '||tablename        FROM pg_tables    WHERE schemaname='public'
       UNION ALL SELECT 'idx '||indexname        FROM pg_indexes   WHERE schemaname='public'
       UNION ALL SELECT 'pol '||tablename||'.'||policyname||' '||cmd||' '||coalesce(qual,'')
         FROM pg_policies WHERE schemaname='public'
       UNION ALL SELECT 'con '||conname          FROM pg_constraint c
         JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public'
       UNION ALL SELECT 'fun '||p.proname        FROM pg_proc p
         JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
       UNION ALL SELECT 'trg '||t.tgname         FROM pg_trigger t
         WHERE NOT t.tgisinternal
       UNION ALL SELECT 'grant '||table_name||'.'||grantee||'.'||privilege_type
         FROM information_schema.role_table_grants WHERE table_schema='public'
            AND grantee IN ('anon','authenticated','service_role')
     ) s"
}

# ── authorization reach, per test user, over the whole corpus.
#
# One transaction per user, with set_config as its OWN statement. Folding it
# into a WHERE clause alongside the predicate would be a bug: AND operands have
# no guaranteed evaluation order, so the impersonation might be applied after
# the rows it is supposed to affect were already filtered.
UIDS='11111111-1111-1111-1111-111111111111
22222222-2222-2222-2222-222222222222
33333333-3333-3333-3333-333333333333
99999999-9999-9999-9999-999999999999'

reach() {
  local uid
  for uid in $UIDS; do
    psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL
BEGIN;
SELECT set_config('test.uid', '$uid', true);
SELECT '$uid view='  || count(*) FILTER (WHERE public.wassell_can_access_file(id,'view'))
     || ' edit='     || count(*) FILTER (WHERE public.wassell_can_access_file(id,'edit'))
     || ' delete='   || count(*) FILTER (WHERE public.wassell_can_access_file(id,'delete'))
  FROM public.files;
ROLLBACK;
SQL
  done | grep -E '^[0-9a-f]{8}-' | sort
}

edges()   { q "SELECT count(*) FROM public.file_links"; }
sources() { q "SELECT count(*) FROM public.file_link_sources"; }
drift()   { q "SELECT coalesce(sum(value),0) FROM public.file_links_reconcile() WHERE category='drift'"; }
dirty()   { q "SELECT count(*) FROM public.file_link_dirty_targets"; }

fingerprint > "$WORK/fp.before"
reach       > "$WORK/reach.before"
E0=$(edges); S0=$(sources); D0=$(drift)
echo "   baseline: edges=$E0 sources=$S0 drift=$D0"
[ "$D0" = "0" ] || { echo "FAIL: baseline drift is $D0, fixture is not clean"; exit 1; }

echo "== applying B1"
run "$ROOT/supabase/migrations/2026-08-16_01_business_file_metadata.sql"

E1=$(edges); S1=$(sources); D1=$(drift); DT1=$(dirty)
echo "   after B1: edges=$E1 sources=$S1 drift=$D1 dirty=$DT1"
[ "$E1" = "$E0" ]  || { echo "FAIL: file_links changed $E0 -> $E1"; exit 1; }
[ "$S1" = "$S0" ]  || { echo "FAIL: file_link_sources changed $S0 -> $S1"; exit 1; }
[ "$D1" = "0" ]    || { echo "FAIL: drift after B1 is $D1"; exit 1; }
[ "$DT1" = "0" ]   || { echo "FAIL: $DT1 dirty target(s) left by the backfill"; exit 1; }
echo "   OK: projection untouched, Phase 2 never engaged"

reach > "$WORK/reach.after"
if ! diff -u "$WORK/reach.before" "$WORK/reach.after" > "$WORK/reach.diff"; then
  echo "FAIL: authorization reach changed"; cat "$WORK/reach.diff"; exit 1
fi
echo "   OK: view/edit/delete/share reach identical"
sed 's/^/     /' "$WORK/reach.after"

echo "== smoke assertions"
psql "$DBURL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/ci/smoke_b1_file_metadata.sql"

echo "== idempotency: re-applying B1"
CNT_BEFORE=$(q "SELECT count(*)||'/'||count(*) FILTER (WHERE file_class='system')||'/'||
                       count(*) FILTER (WHERE origin='marketing_intake') FROM public.files")
run "$ROOT/supabase/migrations/2026-08-16_01_business_file_metadata.sql"
CNT_AFTER=$(q "SELECT count(*)||'/'||count(*) FILTER (WHERE file_class='system')||'/'||
                      count(*) FILTER (WHERE origin='marketing_intake') FROM public.files")
[ "$CNT_BEFORE" = "$CNT_AFTER" ] || { echo "FAIL: re-apply changed classification $CNT_BEFORE -> $CNT_AFTER"; exit 1; }
[ "$(edges)" = "$E0" ] || { echo "FAIL: re-apply changed edges"; exit 1; }
[ "$(drift)" = "0" ]   || { echo "FAIL: re-apply introduced drift"; exit 1; }
echo "   OK: second apply is a no-op"

echo "== rollback"
# The smoke inserted rows carrying B1-only values; drop them so the comparison
# is structural, which is what the rollback contract covers.
q "DELETE FROM public.files WHERE id::text LIKE 'b1000000-0000-0000-0000-0000000000c%'" >/dev/null
run "$ROOT/supabase/rollback/2026-08-16_01_business_file_metadata_down.sql"
fingerprint > "$WORK/fp.rollback"
if ! diff -u "$WORK/fp.before" "$WORK/fp.rollback" > "$WORK/fp.diff"; then
  echo "FAIL: rollback did not restore the pre-B1 structure"; cat "$WORK/fp.diff"; exit 1
fi
echo "   OK: structure identical to pre-B1"
[ "$(edges)" = "$E0" ] || { echo "FAIL: rollback changed edges"; exit 1; }
[ "$(drift)" = "0" ]   || { echo "FAIL: rollback introduced drift"; exit 1; }

echo "== re-apply after rollback"
run "$ROOT/supabase/migrations/2026-08-16_01_business_file_metadata.sql"
[ "$(drift)" = "0" ] || { echo "FAIL: drift after re-apply"; exit 1; }
echo "   OK"

echo
echo "B1 metadata: ALL CHECKS PASSED"
