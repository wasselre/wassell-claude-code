#!/usr/bin/env bash
# =============================================================================
# CI runner: market_listings view reconciliation migration.
#
# Requires PGURL — a libpq connection string to a Postgres SUPERUSER
# maintenance database (e.g. postgres://postgres:pw@localhost:5432/postgres).
# Each test gets a fresh database created via that connection; the per-test
# URL is PGURL with the database name replaced (DBURL helper below).
#
# WHY THE SHAPE OF THIS TEST:
#   The migration is a one-shot PRODUCTION reconciliation whose preflight pins
#   six production objects by the md5 of their pg_get_viewdef / pg_get_expr /
#   pg_get_functiondef bytes. A CI fixture cannot reproduce those exact bytes —
#   whitespace, OIDs baked into expressions, and function bodies differ — so
#   the fixture-computed md5s will never equal the hardcoded production pins.
#   That is not a weakness; it is the point, and it drives the test design:
#
#     TEST 2 (t_pins) runs the migration UNMODIFIED against the fixture. It
#     MUST fail with an md5 mismatch — proving the pins are LOAD-BEARING (a
#     drifted body/view/policy is refused) and that the failure is ATOMIC
#     (nothing in the database changed).
#
#     TEST 3 (t_happy) computes the six md5s FROM the fixture database,
#     substitutes them into a TEMP COPY of the migration, and applies that —
#     exercising the full migration logic (policies, security_invoker flips,
#     grant tightening, post-checks) and the assertion suite. The production
#     literals in the committed migration file itself are never touched.
#
#   Substituted literals can legitimately appear MORE THAN ONCE in a file
#   (preflight message + post-check + comment). We verify AT LEAST ONE
#   occurrence exists before substituting (never exactly one) and print
#   'old -> new (N)' for audit.
#
# Tests:
#   1 (t_absent) — empty DB, unmodified migration: must fail with
#      'PREFLIGHT: public.market_listings is absent'.
#   2 (t_pins)   — fixture + unmodified migration: must fail with 'PREFLIGHT:'
#      AND 'md5'; database must be byte-for-byte unchanged (no new policies,
#      summary still security_invoker=false, authenticated still has MORE than
#      SELECT on the summary).
#   3 (t_happy)  — fixture + md5-substituted migration: must succeed, then the
#      assertion file must succeed.
#   4 (t_happy)  — rollback (with the summary viewdef pin substituted): both
#      reconciliation policies gone, the four frozen_* policies remain, summary
#      back to security_invoker=false, authenticated back to exactly SELECT.
#   5 (t_happy)  — break-glass forensic restore: the migration is re-applied,
#      then docs/market-ingest/reconciliation-breakglass-restore-exact.sql
#      (summary viewdef pin substituted) runs against that post-migration state
#      and MUST succeed, restoring the exact vulnerable pre-migration grants
#      (eight privileges incl. MAINTAIN — PostgreSQL 17+ only; skipped cleanly
#      on older servers). Asserts the restored state via pg_class.relacl +
#      aclexplode. This is the only place the break-glass script is ever
#      executed, inside a disposable CI database — proving it works BEFORE a
#      real incident would be its first run.
# =============================================================================
set -euo pipefail

MIG=supabase/migrations/2026-09-04_00_market_listings_view_reconciliation.sql
FIX=supabase/tests/ci/fixture_market_listings.sql
ASSERTS=supabase/tests/ci/assert_market_listings_reconciliation.sql
RB=docs/market-ingest/reconciliation-rollback.sql
BG=docs/market-ingest/reconciliation-breakglass-restore-exact.sql

# The six production md5 literals pinned inside the migration (summary viewdef
# also pinned inside the rollback).
LIT_SUMMARY=0ddd7ab480fcf167ca9d684d9c1f2db6
LIT_VML=3675d4c9bab1019312eae01035ab18ba
LIT_VMP=416a3eaac713f2eaf27d46f8867c5d4a
LIT_FROZEN_VIEW=6087e8fdcfcb9f3df3da7898c1163c18
LIT_SCOPE_CLASS=0bcfabe9df9da91ea4d874104fec65d6
LIT_CAN_VIEW=c9a781616085d3b06eec12d68238b502

: "${PGURL:?PGURL must point at a Postgres superuser maintenance database}"

for f in "$MIG" "$FIX" "$ASSERTS" "$RB" "$BG"; do
  [ -f "$f" ] || { echo "ERROR: missing $f" >&2; exit 1; }
done

DBURL() { echo "${PGURL%/*}/$1"; }

createdb_fresh() {
  psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $1"
  psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $1"
}

dropdb_quiet() {
  psql "$PGURL" -q -c "DROP DATABASE IF EXISTS $1" >/dev/null 2>&1 || true
}

cleanup() {
  dropdb_quiet t_absent
  dropdb_quiet t_pins
  dropdb_quiet t_happy
}
trap cleanup EXIT

# Replace every occurrence of literal $1 with value $2 in file $3, requiring
# at least one occurrence (never exactly one — duplicates are legitimate).
sub_md5() {
  local old="$1" new="$2" file="$3" n
  n=$(grep -c "$old" "$file")
  if [ "$n" -lt 1 ]; then
    echo "ERROR: literal $old not found in $file" >&2
    exit 1
  fi
  sed -i "s|$old|$new|g" "$file"
  echo "$old -> $new ($n)"
}

# Run a query on a test database, single unaligned tuple out.
q() { psql "$(DBURL "$1")" -v ON_ERROR_STOP=1 -qAt -c "$2"; }

# Assert a boolean query on a test database returns 't'.
assert_t() {
  local db="$1" sql="$2" msg="$3" got
  got=$(q "$db" "$sql")
  if [ "$got" != "t" ]; then
    echo "ASSERT FAILED [$db]: $msg" >&2
    exit 1
  fi
}

SQL_NO_NEW_POLICIES="SELECT NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass AND polname IN ('market_listings_view_fast','market_listings_view_deny_none'))"
SQL_SUMMARY_DEFINER="SELECT reloptions @> ARRAY['security_invoker=false'] FROM pg_class WHERE oid = 'public.market_listings_summary'::regclass"
# authenticated holds MORE THAN just SELECT on the summary (fixture GRANT ALL):
# at least one SELECT grant AND at least one non-SELECT privilege.
SQL_SUMMARY_MORE_THAN_SELECT="SELECT bool_or(a.privilege_type = 'SELECT') AND bool_or(a.privilege_type <> 'SELECT') FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.market_listings_summary'::regclass AND a.grantee = 'authenticated'::regrole"
# authenticated holds EXACTLY SELECT on the summary: at least one grant and
# every grant is SELECT.
SQL_SUMMARY_EXACTLY_SELECT="SELECT bool_or(a.privilege_type = 'SELECT') AND NOT bool_or(a.privilege_type <> 'SELECT') FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.market_listings_summary'::regclass AND a.grantee = 'authenticated'::regrole"
SQL_FOUR_FROZEN_REMAIN="SELECT (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass AND polname IN ('frozen_view','frozen_insert','frozen_update','frozen_delete')) = 4"
# authenticated holds EXACTLY the eight pre-migration privileges on the summary
# (incl. MAINTAIN, PostgreSQL 17+): asserted via pg_class.relacl + aclexplode,
# NOT information_schema.role_table_grants, which is blind to MAINTAIN.
SQL_SUMMARY_EXACT_ALL8="SELECT coalesce(string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type), '(none)') = 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.market_listings_summary'::regclass AND a.grantee = 'authenticated'::regrole"

# =============================================================================
echo '== TEST 1: absent table — unmodified migration must refuse'
# =============================================================================
createdb_fresh t_absent
LOG1=$(mktemp)
if psql "$(DBURL t_absent)" -v ON_ERROR_STOP=1 -f "$MIG" >"$LOG1" 2>&1; then
  echo "FAIL: migration unexpectedly succeeded on an empty database" >&2
  exit 1
fi
grep -q 'PREFLIGHT: public\.market_listings is absent' "$LOG1" \
  || { echo "FAIL: expected 'PREFLIGHT: public.market_listings is absent' in:" >&2; cat "$LOG1" >&2; exit 1; }
rm -f "$LOG1"

# =============================================================================
echo '== TEST 2: pins — fixture shapes with production pins must refuse atomically'
# =============================================================================
createdb_fresh t_pins
psql "$(DBURL t_pins)" -v ON_ERROR_STOP=1 -q -f "$FIX"
LOG2=$(mktemp)
if psql "$(DBURL t_pins)" -v ON_ERROR_STOP=1 -f "$MIG" >"$LOG2" 2>&1; then
  echo "FAIL: migration unexpectedly succeeded against un-pinned fixture shapes" >&2
  exit 1
fi
grep -q 'PREFLIGHT:' "$LOG2" \
  || { echo "FAIL: expected a PREFLIGHT failure in:" >&2; cat "$LOG2" >&2; exit 1; }
grep -q 'md5' "$LOG2" \
  || { echo "FAIL: expected an md5 pin failure in:" >&2; cat "$LOG2" >&2; exit 1; }
rm -f "$LOG2"
# Atomicity: the refused migration left the database byte-for-byte unchanged.
assert_t t_pins "$SQL_NO_NEW_POLICIES" \
  "a reconciliation policy (market_listings_view_fast / market_listings_view_deny_none) exists after the refused run"
assert_t t_pins "$SQL_SUMMARY_DEFINER" \
  "market_listings_summary lost security_invoker=false after the refused run"
assert_t t_pins "$SQL_SUMMARY_MORE_THAN_SELECT" \
  "authenticated no longer holds MORE than SELECT on the summary after the refused run"

# =============================================================================
echo '== TEST 3: happy path — fixture-measured pins, full migration + asserts'
# =============================================================================
createdb_fresh t_happy
psql "$(DBURL t_happy)" -v ON_ERROR_STOP=1 -q -f "$FIX"

NEW_SUMMARY=$(q t_happy "SELECT md5(pg_get_viewdef('public.market_listings_summary'::regclass))")
NEW_VML=$(q t_happy "SELECT md5(pg_get_viewdef('public.v_market_listings'::regclass))")
NEW_VMP=$(q t_happy "SELECT md5(pg_get_viewdef('public.v_market_properties'::regclass))")
NEW_FROZEN_VIEW=$(q t_happy "SELECT md5(pg_get_expr(polqual, polrelid)) FROM pg_policy WHERE polrelid = 'public.market_listings'::regclass AND polname = 'frozen_view'")
NEW_SCOPE_CLASS=$(q t_happy "SELECT md5(pg_get_functiondef(to_regprocedure('public.wassell_view_scope_class(uuid,uuid)')))")
NEW_CAN_VIEW=$(q t_happy "SELECT md5(pg_get_functiondef(to_regprocedure('public.wassell_can_view_jsonb(uuid,uuid,uuid,uuid,jsonb)')))")

MIG_TMP=$(mktemp)
cp "$MIG" "$MIG_TMP"
sub_md5 "$LIT_SUMMARY"     "$NEW_SUMMARY"     "$MIG_TMP"
sub_md5 "$LIT_VML"         "$NEW_VML"         "$MIG_TMP"
sub_md5 "$LIT_VMP"         "$NEW_VMP"         "$MIG_TMP"
sub_md5 "$LIT_FROZEN_VIEW" "$NEW_FROZEN_VIEW" "$MIG_TMP"
sub_md5 "$LIT_SCOPE_CLASS" "$NEW_SCOPE_CLASS" "$MIG_TMP"
sub_md5 "$LIT_CAN_VIEW"    "$NEW_CAN_VIEW"    "$MIG_TMP"

psql "$(DBURL t_happy)" -v ON_ERROR_STOP=1 -q -f "$MIG_TMP"
rm -f "$MIG_TMP"
psql "$(DBURL t_happy)" -v ON_ERROR_STOP=1 -q -f "$ASSERTS"

# =============================================================================
echo '== TEST 4: rollback — undoes the reconciliation exactly'
# =============================================================================
RB_TMP=$(mktemp)
cp "$RB" "$RB_TMP"
# The rollback pins the POST-migration summary viewdef; security_invoker is a
# reloption (not part of pg_get_viewdef), so the TEST 3 value is the right pin.
sub_md5 "$LIT_SUMMARY" "$NEW_SUMMARY" "$RB_TMP"
psql "$(DBURL t_happy)" -v ON_ERROR_STOP=1 -q -f "$RB_TMP"
rm -f "$RB_TMP"

assert_t t_happy "$SQL_NO_NEW_POLICIES" \
  "a reconciliation policy survived the rollback"
assert_t t_happy "$SQL_FOUR_FROZEN_REMAIN" \
  "fewer than the four frozen_* policies remain after the rollback"
assert_t t_happy "$SQL_SUMMARY_DEFINER" \
  "market_listings_summary is not security_invoker=false after the rollback"
assert_t t_happy "$SQL_SUMMARY_EXACTLY_SELECT" \
  "authenticated privileges on the summary are not exactly SELECT after the rollback"

# =============================================================================
# TEST 5: break-glass — the forensic exact-restore actually works.
#
# docs/market-ingest/reconciliation-breakglass-restore-exact.sql grants
# MAINTAIN, which only exists on PostgreSQL 17+. Nothing ever executes that
# script in production, so a syntax or logic error would otherwise surface
# during a real incident — the worst possible moment. CI runs postgres:17,
# so this is the one place it is proven to work.
# =============================================================================
SERVER_VERSION_NUM=$(psql "$PGURL" -v ON_ERROR_STOP=1 -qAt -c 'SHOW server_version_num')
if [ "$SERVER_VERSION_NUM" -lt 170000 ]; then
  echo "== TEST 5: SKIPPED — break-glass grants MAINTAIN, which requires PostgreSQL 17+ (server is $SERVER_VERSION_NUM)"
else
  echo '== TEST 5: break-glass — forensic exact-restore of the vulnerable pre-migration state'

  # TEST 4 rolled t_happy back; the break-glass is designed to run against a
  # POST-migration state, so re-apply the migration first (same mechanism as
  # TEST 3 — fixture-measured pins substituted into a temp copy).
  MIG_TMP=$(mktemp)
  cp "$MIG" "$MIG_TMP"
  sub_md5 "$LIT_SUMMARY"     "$NEW_SUMMARY"     "$MIG_TMP"
  sub_md5 "$LIT_VML"         "$NEW_VML"         "$MIG_TMP"
  sub_md5 "$LIT_VMP"         "$NEW_VMP"         "$MIG_TMP"
  sub_md5 "$LIT_FROZEN_VIEW" "$NEW_FROZEN_VIEW" "$MIG_TMP"
  sub_md5 "$LIT_SCOPE_CLASS" "$NEW_SCOPE_CLASS" "$MIG_TMP"
  sub_md5 "$LIT_CAN_VIEW"    "$NEW_CAN_VIEW"    "$MIG_TMP"
  psql "$(DBURL t_happy)" -v ON_ERROR_STOP=1 -q -f "$MIG_TMP"
  rm -f "$MIG_TMP"

  # The break-glass pins the PRE-migration summary viewdef (it restores the
  # definer view and its grants, but refuses a changed body) — same value as
  # the rollback's pin, patched exactly the way TEST 4 patches it.
  BG_TMP=$(mktemp)
  cp "$BG" "$BG_TMP"
  sub_md5 "$LIT_SUMMARY" "$NEW_SUMMARY" "$BG_TMP"
  psql "$(DBURL t_happy)" -v ON_ERROR_STOP=1 -q -f "$BG_TMP"
  rm -f "$BG_TMP"

  # The observed ACL set is printed BEFORE the assertions so a failure shows
  # the actual grants, not just the expectation.
  OBSERVED_ACL=$(q t_happy "SELECT coalesce(string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type), '(none)') FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.market_listings_summary'::regclass AND a.grantee = 'authenticated'::regrole")
  echo "authenticated privileges on market_listings_summary after break-glass: $OBSERVED_ACL"

  assert_t t_happy "$SQL_SUMMARY_EXACT_ALL8" \
    "authenticated privileges on the summary are not exactly DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE after the break-glass (observed: $OBSERVED_ACL)"
  assert_t t_happy "$SQL_NO_NEW_POLICIES" \
    "a reconciliation policy survived the break-glass restore"
  assert_t t_happy "$SQL_FOUR_FROZEN_REMAIN" \
    "fewer than the four frozen_* policies remain after the break-glass restore"
  assert_t t_happy "$SQL_SUMMARY_DEFINER" \
    "market_listings_summary is not security_invoker=false after the break-glass restore"

  echo '== TEST 5: NOTE — this test deliberately restored a KNOWN-VULNERABLE state'
  echo '   (authenticated write path bypassing frozen_* RLS) inside a disposable CI'
  echo '   database. That is exactly why the break-glass script is FORENSIC-ONLY and'
  echo '   must never be used as an operational rollback.'
fi

echo 'ALL TESTS PASSED'
