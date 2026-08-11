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
#   6 (t_grantor)— foreign-grantor delegation: a second role grants
#      authenticated SELECT ... WITH GRANT OPTION on the summary. The
#      delegation is created with SET ROLE inside the ONE superuser session
#      (GRANT records the grantor as current_user), so no second connection
#      is needed and the test is independent of the server's auth method.
#      The migration's REVOKE cannot remove that grant (REVOKE only removes
#      grants issued by the revoking grantor), so the pin-substituted
#      migration MUST FAIL CLOSED on the grantability-aware §4.9 assertion —
#      and the database must be left byte-for-byte unchanged.
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

# -w (never prompt for a password) on every psql invocation in this file:
# a future connection/auth mistake must become an immediate error, not an
# indefinite password prompt. Without -w, psql attached to a terminal hangs
# forever on an auth failure (CI only failed fast because it has no TTY).
createdb_fresh() {
  psql -w "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $1"
  psql -w "$PGURL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $1"
}

dropdb_quiet() {
  psql -w "$PGURL" -q -c "DROP DATABASE IF EXISTS $1" >/dev/null 2>&1 || true
}

cleanup() {
  dropdb_quiet t_absent
  dropdb_quiet t_pins
  dropdb_quiet t_happy
  dropdb_quiet t_grantor
  # The role's ACL entries live inside t_grantor, so the database must be
  # dropped first or DROP ROLE fails. The || true keeps cleanup from ever
  # masking a real test failure's exit code.
  psql -w "$PGURL" -q -c "DROP ROLE IF EXISTS ci_other_grantor" >/dev/null 2>&1 || true
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
q() { psql -w "$(DBURL "$1")" -v ON_ERROR_STOP=1 -qAt -c "$2"; }

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
# (incl. MAINTAIN, PostgreSQL 17+) and NONE of them WITH GRANT OPTION: each
# privilege is rendered as privilege_type || '*' when is_grantable, so a
# surviving grant option appears as a starred name and fails the exact match.
# Asserted via pg_class.relacl + aclexplode, NOT
# information_schema.role_table_grants, which is blind to MAINTAIN.
SQL_SUMMARY_EXACT_ALL8="SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)') = 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.market_listings_summary'::regclass AND a.grantee = 'authenticated'::regrole"

# =============================================================================
echo '== TEST 1: absent table — unmodified migration must refuse'
# =============================================================================
createdb_fresh t_absent
LOG1=$(mktemp)
if psql -w "$(DBURL t_absent)" -v ON_ERROR_STOP=1 -f "$MIG" >"$LOG1" 2>&1; then
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
psql -w "$(DBURL t_pins)" -v ON_ERROR_STOP=1 -q -f "$FIX"
LOG2=$(mktemp)
if psql -w "$(DBURL t_pins)" -v ON_ERROR_STOP=1 -f "$MIG" >"$LOG2" 2>&1; then
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
psql -w "$(DBURL t_happy)" -v ON_ERROR_STOP=1 -q -f "$FIX"

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

psql -w "$(DBURL t_happy)" -v ON_ERROR_STOP=1 -q -f "$MIG_TMP"
rm -f "$MIG_TMP"
psql -w "$(DBURL t_happy)" -v ON_ERROR_STOP=1 -q -f "$ASSERTS"

# =============================================================================
echo '== TEST 4: rollback — undoes the reconciliation exactly'
# =============================================================================
RB_TMP=$(mktemp)
cp "$RB" "$RB_TMP"
# The rollback pins the POST-migration summary viewdef; security_invoker is a
# reloption (not part of pg_get_viewdef), so the TEST 3 value is the right pin.
sub_md5 "$LIT_SUMMARY" "$NEW_SUMMARY" "$RB_TMP"
psql -w "$(DBURL t_happy)" -v ON_ERROR_STOP=1 -q -f "$RB_TMP"
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
SERVER_VERSION_NUM=$(psql -w "$PGURL" -v ON_ERROR_STOP=1 -qAt -c 'SHOW server_version_num')
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
  psql -w "$(DBURL t_happy)" -v ON_ERROR_STOP=1 -q -f "$MIG_TMP"
  rm -f "$MIG_TMP"

  # Deliberately create the problematic pre-state the break-glass must
  # survive: authenticated holds SELECT WITH GRANT OPTION on the summary.
  # A plain GRANT (what the break-glass used to do) does NOT strip an
  # existing grant option, so without the break-glass's REVOKE-then-GRANT
  # this delegation power would silently survive the "exact" restore — and a
  # privilege-name-only assertion would still pass. This pre-state proves
  # the REVOKE is load-bearing.
  echo 'TEST 5 pre-state: granting SELECT ... WITH GRANT OPTION to authenticated deliberately, to prove the break-glass revoke-then-grant strips it'
  q t_happy "GRANT SELECT ON public.market_listings_summary TO authenticated WITH GRANT OPTION" >/dev/null

  # The break-glass pins the PRE-migration summary viewdef (it restores the
  # definer view and its grants, but refuses a changed body) — same value as
  # the rollback's pin, patched exactly the way TEST 4 patches it.
  BG_TMP=$(mktemp)
  cp "$BG" "$BG_TMP"
  sub_md5 "$LIT_SUMMARY" "$NEW_SUMMARY" "$BG_TMP"
  psql -w "$(DBURL t_happy)" -v ON_ERROR_STOP=1 -q -f "$BG_TMP"
  rm -f "$BG_TMP"

  # The observed ACL set is printed BEFORE the assertions so a failure shows
  # the actual grants, not just the expectation. Grantability-aware: each
  # privilege is rendered with a trailing '*' when held WITH GRANT OPTION,
  # so the expected value is the eight names with NO '*' anywhere.
  OBSERVED_ACL=$(q t_happy "SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)') FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.market_listings_summary'::regclass AND a.grantee = 'authenticated'::regrole")
  echo "authenticated privileges on market_listings_summary after break-glass: $OBSERVED_ACL"

  assert_t t_happy "$SQL_SUMMARY_EXACT_ALL8" \
    "authenticated privileges on the summary are not exactly DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE with none grantable after the break-glass (observed: $OBSERVED_ACL)"
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

# =============================================================================
echo '== TEST 6: foreign-grantor delegation — the migration must FAIL CLOSED'
# =============================================================================
# REVOKE only removes grants issued by the REVOKING grantor (verified
# empirically on PostgreSQL 17): a GRANT SELECT ... WITH GRANT OPTION issued
# to authenticated by ANY OTHER role survives the migration's
# REVOKE ALL ... FROM authenticated. A privilege-name-only exact-set
# assertion would aggregate that surviving grant to plain 'SELECT' and PASS
# while authenticated retains the power to RE-GRANT access. The migration's
# §4.9 assertions render each grant as privilege_type || '*' when grantable,
# so this pre-state MUST make the migration fail closed — atomically.
createdb_fresh t_grantor
psql -w "$(DBURL t_grantor)" -v ON_ERROR_STOP=1 -q -f "$FIX"

# a. A second grantor holds the grant option and delegates SELECT to
#    authenticated WITH GRANT OPTION — the delegation the migration's
#    owner-issued REVOKE cannot remove.
#
#    There is deliberately NO second connection here. The grantor of a GRANT
#    is recorded as current_user, and a superuser can SET ROLE to any role —
#    so SET ROLE inside the existing superuser session produces a genuine
#    foreign-grantor ACL entry, and the test stays independent of the
#    server's authentication method. The previous form opened a second
#    connection as ci_other_grantor, which silently required trust auth: the
#    CI postgres:17 container uses scram-sha-256 for TCP, so that connection
#    always failed with fe_sendauth and TEST 6 never actually ran under CI.
psql -w "$(DBURL t_grantor)" -v ON_ERROR_STOP=1 -q <<'SQL'
DROP ROLE IF EXISTS ci_other_grantor;
CREATE ROLE ci_other_grantor;            -- NOLOGIN: never connected to
GRANT SELECT ON public.market_listings_summary TO ci_other_grantor WITH GRANT OPTION;
SET ROLE ci_other_grantor;               -- GRANT records grantor = current_user
GRANT SELECT ON public.market_listings_summary TO authenticated WITH GRANT OPTION;
RESET ROLE;
SQL

# b. Show the bad pre-state: authenticated's grantability-aware ACL includes
#    the foreign-grantor SELECT* alongside the fixture's owner-issued grants.
OBSERVED_PRE=$(q t_grantor "SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)') FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'public.market_listings_summary'::regclass AND a.grantee = 'authenticated'::regrole")
echo "pre-state authenticated ACL on market_listings_summary (grantability-aware): $OBSERVED_PRE"
case "$OBSERVED_PRE" in
  *'SELECT*'*) ;;
  *) echo "FAIL: pre-state does not show a grantable SELECT (SELECT*) for authenticated: $OBSERVED_PRE" >&2; exit 1 ;;
esac

# c. Run the pin-substituted migration exactly as TEST 3 does (the fixture is
#    deterministic, so the md5s measured on t_happy's fresh fixture apply to
#    this identical fresh fixture). It MUST fail on the §4.9 authenticated
#    ACL assertion: after the owner-side REVOKE the foreign-grantor SELECT*
#    survives, so the observed set is 'SELECT,SELECT*', not 'SELECT'.
MIG_TMP=$(mktemp)
cp "$MIG" "$MIG_TMP"
sub_md5 "$LIT_SUMMARY"     "$NEW_SUMMARY"     "$MIG_TMP"
sub_md5 "$LIT_VML"         "$NEW_VML"         "$MIG_TMP"
sub_md5 "$LIT_VMP"         "$NEW_VMP"         "$MIG_TMP"
sub_md5 "$LIT_FROZEN_VIEW" "$NEW_FROZEN_VIEW" "$MIG_TMP"
sub_md5 "$LIT_SCOPE_CLASS" "$NEW_SCOPE_CLASS" "$MIG_TMP"
sub_md5 "$LIT_CAN_VIEW"    "$NEW_CAN_VIEW"    "$MIG_TMP"
LOG6=$(mktemp)
if psql -w "$(DBURL t_grantor)" -v ON_ERROR_STOP=1 -f "$MIG_TMP" >"$LOG6" 2>&1; then
  echo "FAIL: migration unexpectedly COMMITTED with a foreign-grantor grantable SELECT (SELECT*) in place — the grantability-aware ACL assertion did not fire" >&2
  exit 1
fi
grep -q 'authenticated privileges on market_listings_summary must be exactly SELECT' "$LOG6" \
  || { echo "FAIL: expected the authenticated-ACL assertion failure in:" >&2; cat "$LOG6" >&2; exit 1; }
rm -f "$MIG_TMP" "$LOG6"

# d. Fail-closed means ATOMIC: the aborted transaction left no trace.
assert_t t_grantor "$SQL_NO_NEW_POLICIES" \
  "a reconciliation policy (market_listings_view_fast / market_listings_view_deny_none) exists after the fail-closed run"
assert_t t_grantor "$SQL_SUMMARY_DEFINER" \
  "market_listings_summary lost security_invoker=false after the fail-closed run"

# e. What this proves.
echo '   This proves a foreign-grantor delegation (SELECT WITH GRANT OPTION issued'
echo '   by ci_other_grantor) cannot slip through: the migration''s REVOKE cannot'
echo '   remove it, the grantability-aware §4.9 assertion sees SELECT,SELECT* instead'
echo '   of SELECT, and the whole transaction aborts for a human to investigate.'

echo 'ALL TESTS PASSED'
