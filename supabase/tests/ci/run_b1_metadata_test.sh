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
# Phase 1 shipped a migration AND a backfill; the migration alone leaves the
# projection empty. Without this call every edge count below is 0 and the
# role-derived half of B1's document_type inference is never exercised — the
# assertions would all pass vacuously. Mirrors the production sequence, where
# the backfill ran before Phase 2's triggers existed.
q "SELECT * FROM public.file_links_backfill()" >/dev/null
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

# ── updated_at fidelity.
#
# `stamps` is a fingerprint of the COMPLETE (id, updated_at) set, not a count or
# a max: a backfill that stamped now() on every row, on one row, or on a random
# subset all move this hash. `files_set_updated_at` is an unconditional
# `NEW.updated_at = now()`, so the backfill has to bypass it by name, and this is
# the evidence that it did.
stamps()   { q "SELECT md5(string_agg(id::text||'|'||updated_at::text, ',' ORDER BY id)) FROM public.files"; }
nstamps()  { q "SELECT count(DISTINCT updated_at) FROM public.files"; }
ts_state() { q "SELECT coalesce((SELECT tgenabled::text FROM pg_trigger
                                  WHERE tgrelid='public.files'::regclass
                                    AND tgname='files_set_updated_at'
                                    AND NOT tgisinternal), 'absent')"; }

edges()   { q "SELECT count(*) FROM public.file_links"; }
sources() { q "SELECT count(*) FROM public.file_link_sources"; }
drift()   { q "SELECT coalesce(sum(value),0) FROM public.file_links_reconcile() WHERE category='drift'"; }
dirty()   { q "SELECT count(*) FROM public.file_link_dirty_targets"; }

fingerprint > "$WORK/fp.before"
reach       > "$WORK/reach.before"
E0=$(edges); S0=$(sources); D0=$(drift)
ROLES0=$(q "SELECT count(DISTINCT role) FROM public.file_links")
FP0=$(q "SELECT count(*) FROM public.file_links WHERE role='floor_plan'")
echo "   baseline: edges=$E0 sources=$S0 drift=$D0 distinct_roles=$ROLES0 floor_plan_edges=$FP0"
[ "$D0" = "0" ] || { echo "FAIL: baseline drift is $D0, fixture is not clean"; exit 1; }

# NON-VACUITY. An empty projection would let every "unchanged" and every
# role-derived assertion pass without testing anything — which is exactly what
# happened on the first run of this script, before the backfill call above was
# added. Refuse to report success on a corpus that cannot exercise the rules.
[ "$E0" -gt 0 ]      || { echo "FAIL: baseline projection is empty — assertions would be vacuous"; exit 1; }
[ "$ROLES0" -ge 2 ]  || { echo "FAIL: baseline has $ROLES0 distinct role(s); type-priority is untested"; exit 1; }
[ "$FP0" -gt 0 ]     || { echo "FAIL: no floor_plan edge in the baseline; B1.5 priority rule is vacuous"; exit 1; }

UPD0=$(stamps); NUPD0=$(nstamps); TS0=$(ts_state)
echo "   baseline: updated_at fingerprint=${UPD0:0:12}… distinct=$NUPD0 timestamp_trigger=$TS0"
# Non-vacuity again: with no trigger, or with every row sharing one timestamp,
# "the fingerprint did not change" would prove nothing about the bypass.
[ "$TS0" = "O" ]     || { echo "FAIL: files_set_updated_at is '$TS0', expected 'O' — the bypass is untested"; exit 1; }
[ "$NUPD0" -ge 2 ]   || { echo "FAIL: only $NUPD0 distinct updated_at value(s); fidelity test is vacuous"; exit 1; }

echo "== applying B1"
run "$ROOT/supabase/migrations/2026-08-16_01_business_file_metadata.sql"

E1=$(edges); S1=$(sources); D1=$(drift); DT1=$(dirty)
echo "   after B1: edges=$E1 sources=$S1 drift=$D1 dirty=$DT1"
[ "$E1" = "$E0" ]  || { echo "FAIL: file_links changed $E0 -> $E1"; exit 1; }
[ "$S1" = "$S0" ]  || { echo "FAIL: file_link_sources changed $S0 -> $S1"; exit 1; }
[ "$D1" = "0" ]    || { echo "FAIL: drift after B1 is $D1"; exit 1; }
[ "$DT1" = "0" ]   || { echo "FAIL: $DT1 dirty target(s) left by the backfill"; exit 1; }
echo "   OK: projection untouched, Phase 2 never engaged"

# ── updated_at must have survived the backfill untouched ────────────────────
UPD1=$(stamps); NUPD1=$(nstamps); TS1=$(ts_state)
[ "$UPD1" = "$UPD0" ] || {
  echo "FAIL: updated_at changed — fingerprint $UPD0 -> $UPD1"
  q "SELECT id, updated_at FROM public.files ORDER BY updated_at DESC LIMIT 5"; exit 1; }
[ "$NUPD1" = "$NUPD0" ] || { echo "FAIL: distinct updated_at $NUPD0 -> $NUPD1"; exit 1; }
[ "$TS1" = "$TS0" ] || { echo "FAIL: timestamp trigger left in state '$TS1', expected '$TS0'"; exit 1; }
echo "   OK: all $NUPD0 distinct updated_at values preserved; trigger restored to '$TS1'"

# ── and it must still WORK: an ordinary metadata edit still advances it ─────
#
# Compared per row, before against after — NOT against an absolute date. Some
# fixture rows are legitimately stamped at now() already (fixture_b1_authz.sql
# assigns folders after the timestamp trigger exists), so a "must be older than
# <date>" assertion tests the fixture's construction rather than B1's behaviour.
A1_T0=$(q "SELECT updated_at FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a1'")
A2_T0=$(q "SELECT updated_at FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a2'")
# Edits `description`, not `title`: smoke B1.2 asserts a1's exact derived title,
# so mutating it here would break a later assertion from outside its own test.
q "UPDATE public.files SET description = 'touched by the updated_at fidelity check'
    WHERE id='b1000000-0000-0000-0000-0000000000a1'" >/dev/null
A1_T1=$(q "SELECT updated_at FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a1'")
A2_T1=$(q "SELECT updated_at FROM public.files WHERE id='b1000000-0000-0000-0000-0000000000a2'")
[ "$A1_T1" != "$A1_T0" ] || { echo "FAIL: post-migration edit did not advance updated_at ($A1_T0)"; exit 1; }
[ "$A2_T1"  = "$A2_T0" ] || { echo "FAIL: an unedited row's updated_at moved ($A2_T0 -> $A2_T1)"; exit 1; }
echo "   OK: post-migration edits advance updated_at, and only for the edited row"

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
UPD2=$(stamps)
run "$ROOT/supabase/migrations/2026-08-16_01_business_file_metadata.sql"
CNT_AFTER=$(q "SELECT count(*)||'/'||count(*) FILTER (WHERE file_class='system')||'/'||
                      count(*) FILTER (WHERE origin='marketing_intake') FROM public.files")
[ "$CNT_BEFORE" = "$CNT_AFTER" ] || { echo "FAIL: re-apply changed classification $CNT_BEFORE -> $CNT_AFTER"; exit 1; }
[ "$(edges)" = "$E0" ] || { echo "FAIL: re-apply changed edges"; exit 1; }
[ "$(drift)" = "0" ]   || { echo "FAIL: re-apply introduced drift"; exit 1; }
[ "$(stamps)" = "$UPD2" ]   || { echo "FAIL: re-apply moved updated_at"; exit 1; }
[ "$(ts_state)" = "$TS0" ]  || { echo "FAIL: re-apply left the timestamp trigger disabled"; exit 1; }
echo "   OK: second apply is a no-op, updated_at and trigger state intact"

echo "== rollback"
# The smoke inserted rows carrying B1-only values; drop them so the comparison
# is structural, which is what the rollback contract covers.
q "DELETE FROM public.files WHERE id::text LIKE 'b1000000-0000-0000-0000-0000000000c%'" >/dev/null
UPD3=$(stamps)
run "$ROOT/supabase/rollback/2026-08-16_01_business_file_metadata_down.sql"
fingerprint > "$WORK/fp.rollback"
if ! diff -u "$WORK/fp.before" "$WORK/fp.rollback" > "$WORK/fp.diff"; then
  echo "FAIL: rollback did not restore the pre-B1 structure"; cat "$WORK/fp.diff"; exit 1
fi
echo "   OK: structure identical to pre-B1"
[ "$(edges)" = "$E0" ] || { echo "FAIL: rollback changed edges"; exit 1; }
[ "$(drift)" = "0" ]   || { echo "FAIL: rollback introduced drift"; exit 1; }
[ "$(stamps)" = "$UPD3" ]  || { echo "FAIL: rollback moved updated_at"; exit 1; }
[ "$(ts_state)" = "$TS0" ] || { echo "FAIL: rollback left the timestamp trigger in '$(ts_state)'"; exit 1; }
echo "   OK: rollback preserved updated_at and the timestamp trigger"

echo "== re-apply after rollback"
UPD4=$(stamps)
run "$ROOT/supabase/migrations/2026-08-16_01_business_file_metadata.sql"
[ "$(drift)" = "0" ] || { echo "FAIL: drift after re-apply"; exit 1; }
[ "$(stamps)" = "$UPD4" ]  || { echo "FAIL: re-apply after rollback moved updated_at"; exit 1; }
[ "$(ts_state)" = "$TS0" ] || { echo "FAIL: re-apply after rollback left the trigger in '$(ts_state)'"; exit 1; }
echo "   OK: clean re-application, updated_at and trigger state intact"

echo
echo "B1 metadata: ALL CHECKS PASSED"
