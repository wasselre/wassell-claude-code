#!/usr/bin/env bash
# ============================================================================
# Designated validator for supabase/migrations/2026-08-17_01_scope_authz_helpers.sql
#
# Two things must both hold:
#   * the direct-RPC bypass is CLOSED  (smoke_helper_scoping.sql)
#   * no user's files_select reach moves one row (policy fingerprints)
#
# It also proves the bypass was REAL before the fix, by measuring it, and again
# after rolling the fix back. A security migration whose test cannot demonstrate
# the vulnerability it removes is not evidence of anything.
# ============================================================================
set -euo pipefail

PGURL="${PGURL:-postgresql://postgres:ci@localhost:5432/postgres}"
DB=wassell_helper_scoping
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
00000000-0000-0000-0000-0000000000ff
00000000-0000-0000-0000-0000000000fe'

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

# How much a caller can extract by calling the helpers DIRECTLY. Tolerates the
# functions being absent (after the fix the old names are gone), so the same
# probe works either side of the migration.
bypass_reach() {   # $1 = uid
  psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL | grep -E '^BYPASS '
BEGIN;
SELECT set_config('test.uid','$1', true);
SET LOCAL ROLE authenticated;
DO \$\$
DECLARE g bigint := -1; m bigint := -1; victim uuid;
BEGIN
  SELECT public.wassell_app_user_id('33333333-3333-3333-3333-333333333333'::uuid) INTO victim;
  BEGIN
    EXECUTE 'SELECT count(*) FROM public.wassell_granted_file_ids(\$1,''view'')'
      INTO g USING victim;
  EXCEPTION WHEN others THEN g := -1; END;
  BEGIN
    EXECUTE 'SELECT count(*) FROM public.wassell_marketing_file_ids()' INTO m;
  EXCEPTION WHEN others THEN m := -1; END;
  RAISE NOTICE 'BYPASS victim_grants=% marketing=%', g, m;
END \$\$;
ROLLBACK;
SQL
}

echo "== creating $DB"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB;"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB;"

echo "== stack: Phase 1 + Phase 2 + B1 + authz surface + B2A + B2A.2"
run "$ROOT/supabase/tests/ci/fixture_file_links.sql"
run "$ROOT/supabase/tests/ci/fixture_b1_metadata.sql"
run "$ROOT/supabase/migrations/2026-08-10_file_links_projection.sql"
q   "SELECT * FROM public.file_links_backfill()" >/dev/null
run "$ROOT/supabase/migrations/2026-08-12_file_link_sync.sql"
run "$ROOT/supabase/tests/ci/fixture_b2a_authz.sql"
run "$ROOT/supabase/migrations/2026-08-16_01_business_file_metadata.sql"
psql "$DBURL" -v ON_ERROR_STOP=1 -q <<'SQL'
ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.files TO authenticated;
SQL
run "$ROOT/supabase/rollback/2026-08-16_03_file_authz_performance_down.sql"
run "$ROOT/supabase/tests/ci/fixture_b2a1_highcard.sql"
run "$ROOT/supabase/migrations/2026-08-16_03_file_authz_performance.sql"
run "$ROOT/supabase/migrations/2026-08-16_06_file_authz_grant_sets_v2.sql"

echo "== BEFORE: the bypass must be demonstrably REAL"
policy_fingerprints > "$WORK/pol.before"
[ "$(wc -l < "$WORK/pol.before")" -eq 11 ] || { echo "FAIL: expected 11 policy fingerprints"; exit 1; }
B_NOACCESS=$(bypass_reach 55555555-5555-5555-5555-555555555555)
B_NOBODY=$(bypass_reach   00000000-0000-0000-0000-0000000000ff)
echo "   no-access caller      $B_NOACCESS"
echo "   identity-less caller  $B_NOBODY"
# If the vulnerability cannot be reproduced here, the test proves nothing.
grep -q 'victim_grants=[1-9]' <<<"$B_NOACCESS" \
  || { echo "FAIL: cannot reproduce the grant-enumeration bypass — test is vacuous"; exit 1; }
grep -q 'marketing=[1-9]'     <<<"$B_NOBODY" \
  || { echo "FAIL: cannot reproduce the identity-less marketing leak — test is vacuous"; exit 1; }
echo "   OK: bypass reproduced, so the fix has something to prove"

echo "== applying the correction"
run "$ROOT/supabase/migrations/2026-08-17_01_scope_authz_helpers.sql"

echo "== AFTER: reach unchanged, bypass closed"
policy_fingerprints > "$WORK/pol.after"
diff -u "$WORK/pol.before" "$WORK/pol.after" || { echo "FAIL: files_select reach changed"; exit 1; }
echo "   OK: all 11 policy fingerprints identical"

A_NOACCESS=$(bypass_reach 55555555-5555-5555-5555-555555555555)
A_NOBODY=$(bypass_reach   00000000-0000-0000-0000-0000000000ff)
echo "   no-access caller      $A_NOACCESS"
echo "   identity-less caller  $A_NOBODY"
grep -q 'victim_grants=-1' <<<"$A_NOACCESS" \
  || { echo "FAIL: the forgeable grant helper is still callable"; exit 1; }
grep -q 'marketing=-1'     <<<"$A_NOBODY" \
  || { echo "FAIL: the unguarded marketing helper is still callable"; exit 1; }
echo "   OK: both bypass paths are gone"

echo "== abuse smoke"
psql "$DBURL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/ci/smoke_helper_scoping.sql"

echo "== performance must not regress"
for uid in 55555555-5555-5555-5555-555555555555 88888888-8888-8888-8888-888888888888 \
           99999999-9999-9999-9999-999999999999; do
  psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL | grep -E '^PERF '
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
SELECT 'PERF ' || left('$uid',8) || ' p95=' ||
       round(percentile_disc(0.95) WITHIN GROUP (ORDER BY ms),1) FROM _m;
ROLLBACK;
SQL
done | tee "$WORK/perf.txt" | sed 's/^/   /'
WORST=$(grep -o 'p95=[0-9.]*' "$WORK/perf.txt" | cut -d= -f2 | sort -g | tail -1)
awk "BEGIN{exit !($WORST < 300)}" || { echo "FAIL: worst p95 ${WORST} ms >= 300"; exit 1; }
echo "   OK: worst p95 ${WORST} ms"

echo "== rollback restores the (vulnerable) prior state, then re-apply"
run "$ROOT/supabase/rollback/2026-08-17_01_scope_authz_helpers_down.sql"
policy_fingerprints > "$WORK/pol.rb"
diff -q "$WORK/pol.before" "$WORK/pol.rb" >/dev/null || { echo "FAIL: rollback changed reach"; exit 1; }
grep -q 'victim_grants=[1-9]' <<<"$(bypass_reach 55555555-5555-5555-5555-555555555555)" \
  || { echo "FAIL: rollback did not restore the prior behaviour"; exit 1; }
run "$ROOT/supabase/migrations/2026-08-17_01_scope_authz_helpers.sql"
policy_fingerprints > "$WORK/pol.re"
diff -q "$WORK/pol.before" "$WORK/pol.re" >/dev/null || { echo "FAIL: re-apply changed reach"; exit 1; }
echo "   OK"

echo
echo "helper scoping: ALL CHECKS PASSED"
