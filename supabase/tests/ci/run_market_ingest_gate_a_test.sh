#!/usr/bin/env bash
# =============================================================================
# CI runner: Gate A market-ingest migrations (2026-09-05_01..04).
#
# Requires PGURL — a libpq connection string to a Postgres SUPERUSER
# maintenance database (e.g. postgres://postgres:pw@localhost:5432/postgres).
# Each test gets a fresh database created via that connection; the per-test
# URL is PGURL with the database name replaced (DBURL helper below).
#
# WHAT THIS PROVES: the four additive 2026-09-05_* Gate A migrations apply
# cleanly, idempotently, and with the designed constraints/RLS/grants, against
# the SUPPORTED PREDECESSOR FIXTURE.
#
# WHAT IT DOES NOT PROVE: whole-repository fresh-database parity. Complete
# bootstrap parity remains BLOCKED because supabase/branch-bootstrap-*.sql was
# generated 2026-08-01, before the ad-hoc 2026-08-06 production freeze, and
# therefore does not create public.market_listings. Until the deferred freeze
# baseline (2026-09-05_05) lands, no CI job in this repository can assert
# fresh-vs-production schema parity for the market-listings surface. Do not
# add a fixture stub to make such a claim possible — that would be a false
# green.
#
# Tests:
#   1 (t_nodeps)        — blank DB, no fixture: _01 MUST FAIL naming the
#                         missing wassell_is_admin preflight, atomically.
#   2 (t_order)         — fixture, _02 applied FIRST: MUST FAIL naming the
#                         missing listing_sources preflight, atomically.
#   3 (t_missing_aqar)  — fixture with aqar_listing_evidence DROPPED: _01
#                         succeeds, then _02 MUST FAIL naming the missing
#                         aqar_listing_evidence preflight, atomically. This is
#                         drift coverage for the one genuine external
#                         predecessor.
#   4 (t_apply)         — fixture + all four migrations in order: all SUCCEED,
#                         then the assertion file MUST SUCCEED.
#   5 (t_idem)          — reuses the t_apply database: object-count
#                         fingerprint BEFORE, apply all four AGAIN (all MUST
#                         SUCCEED), fingerprint AFTER must be IDENTICAL and the
#                         seed must not have doubled; the assertion file MUST
#                         still succeed.
#   6 (t_no_storage_ddl)— SOURCE-LEVEL guard: with `--` comments stripped, the
#                         four migrations contain no market-raw bucket, no
#                         market_raw_uploader role, no storage.objects /
#                         storage.buckets DDL. _02 legitimately MENTIONS all of
#                         these inside its required "STORAGE ENFORCEMENT IS
#                         DEFERRED TO GATE B" comment, which is exactly why
#                         the comments are stripped before grepping — if the
#                         stripping is wrong this test fails immediately, and
#                         the fix belongs in the stripping, never the migration.
#   7 (t_no_market_listings)
#                       — SOURCE-LEVEL guard, same comment-stripping: no
#                         migration contains market_listings as executable
#                         SQL, and none contains listing_field_provenance or
#                         mirror_outbox outside comments. This is the guard
#                         that stops a future contributor quietly re-merging
#                         the deferred _06 content into _04.
# =============================================================================
set -euo pipefail

MIG1=supabase/migrations/2026-09-05_01_listing_sources_registry.sql
MIG2=supabase/migrations/2026-09-05_02_raw_capture.sql
MIG3=supabase/migrations/2026-09-05_03_field_catalog_and_gaps.sql
MIG4=supabase/migrations/2026-09-05_04_ingestion_audit.sql
FIX=supabase/tests/ci/fixture_market_ingest.sql
ASSERTS=supabase/tests/ci/assert_market_ingest_gate_a.sql

: "${PGURL:?PGURL must point at a Postgres superuser maintenance database}"

for f in "$MIG1" "$MIG2" "$MIG3" "$MIG4" "$FIX" "$ASSERTS"; do
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
  dropdb_quiet t_nodeps
  dropdb_quiet t_order
  dropdb_quiet t_missing_aqar
  dropdb_quiet t_apply
}
trap cleanup EXIT

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

# Object-count fingerprint of the public schema: tables / views / indexes /
# policies / triggers / functions. Re-applying the idempotent migrations must
# leave every count unchanged.
FINGERPRINT_SQL="SELECT (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r') || '/' || (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='v') || '/' || (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='i') || '/' || (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='public'::regnamespace) || '/' || (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal) || '/' || (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')"

# =============================================================================
echo '== TEST 1: t_nodeps — blank database, _01 must refuse atomically'
# =============================================================================
createdb_fresh t_nodeps
LOG1=$(mktemp)
if psql -w "$(DBURL t_nodeps)" -v ON_ERROR_STOP=1 -f "$MIG1" >"$LOG1" 2>&1; then
  echo "FAIL: _01 unexpectedly succeeded on an empty database" >&2
  exit 1
fi
grep -q 'PREFLIGHT' "$LOG1" \
  || { echo "FAIL: expected a PREFLIGHT failure in:" >&2; cat "$LOG1" >&2; exit 1; }
grep -q 'wassell_is_admin' "$LOG1" \
  || { echo "FAIL: expected the wassell_is_admin preflight failure in:" >&2; cat "$LOG1" >&2; exit 1; }
rm -f "$LOG1"
# Atomicity: the refused migration left no trace.
assert_t t_nodeps "SELECT to_regclass('public.listing_sources') IS NULL" \
  "public.listing_sources exists after the refused _01 run (not atomic)"

# =============================================================================
echo '== TEST 2: t_order — _02 applied FIRST must refuse atomically'
# =============================================================================
createdb_fresh t_order
psql -w "$(DBURL t_order)" -v ON_ERROR_STOP=1 -q -f "$FIX"
LOG2=$(mktemp)
if psql -w "$(DBURL t_order)" -v ON_ERROR_STOP=1 -f "$MIG2" >"$LOG2" 2>&1; then
  echo "FAIL: _02 unexpectedly succeeded before _01" >&2
  exit 1
fi
grep -q 'PREFLIGHT' "$LOG2" \
  || { echo "FAIL: expected a PREFLIGHT failure in:" >&2; cat "$LOG2" >&2; exit 1; }
grep -q 'listing_sources' "$LOG2" \
  || { echo "FAIL: expected the listing_sources preflight failure in:" >&2; cat "$LOG2" >&2; exit 1; }
rm -f "$LOG2"
assert_t t_order "SELECT to_regclass('public.raw_blobs') IS NULL" \
  "public.raw_blobs exists after the refused _02 run (not atomic)"

# =============================================================================
echo '== TEST 3: t_missing_aqar — _02 must refuse when aqar_listing_evidence is gone'
# =============================================================================
createdb_fresh t_missing_aqar
psql -w "$(DBURL t_missing_aqar)" -v ON_ERROR_STOP=1 -q -f "$FIX"
q t_missing_aqar "DROP TABLE public.aqar_listing_evidence" >/dev/null
psql -w "$(DBURL t_missing_aqar)" -v ON_ERROR_STOP=1 -q -f "$MIG1"
LOG3=$(mktemp)
if psql -w "$(DBURL t_missing_aqar)" -v ON_ERROR_STOP=1 -f "$MIG2" >"$LOG3" 2>&1; then
  echo "FAIL: _02 unexpectedly succeeded with aqar_listing_evidence absent" >&2
  exit 1
fi
grep -q 'PREFLIGHT' "$LOG3" \
  || { echo "FAIL: expected a PREFLIGHT failure in:" >&2; cat "$LOG3" >&2; exit 1; }
grep -q 'aqar_listing_evidence' "$LOG3" \
  || { echo "FAIL: expected the aqar_listing_evidence preflight failure in:" >&2; cat "$LOG3" >&2; exit 1; }
rm -f "$LOG3"
assert_t t_missing_aqar "SELECT to_regclass('public.raw_blobs') IS NULL" \
  "public.raw_blobs exists after the refused _02 run (not atomic)"

# =============================================================================
echo '== TEST 4: t_apply — fixture + all four migrations in order, then asserts'
# =============================================================================
createdb_fresh t_apply
psql -w "$(DBURL t_apply)" -v ON_ERROR_STOP=1 -q -f "$FIX"
psql -w "$(DBURL t_apply)" -v ON_ERROR_STOP=1 -q -f "$MIG1"
psql -w "$(DBURL t_apply)" -v ON_ERROR_STOP=1 -q -f "$MIG2"
psql -w "$(DBURL t_apply)" -v ON_ERROR_STOP=1 -q -f "$MIG3"
psql -w "$(DBURL t_apply)" -v ON_ERROR_STOP=1 -q -f "$MIG4"
psql -w "$(DBURL t_apply)" -v ON_ERROR_STOP=1 -q -f "$ASSERTS"

# =============================================================================
echo '== TEST 5: t_idem — re-applying all four changes nothing'
# =============================================================================
FP_BEFORE=$(q t_apply "$FINGERPRINT_SQL")
psql -w "$(DBURL t_apply)" -v ON_ERROR_STOP=1 -q -f "$MIG1"
psql -w "$(DBURL t_apply)" -v ON_ERROR_STOP=1 -q -f "$MIG2"
psql -w "$(DBURL t_apply)" -v ON_ERROR_STOP=1 -q -f "$MIG3"
psql -w "$(DBURL t_apply)" -v ON_ERROR_STOP=1 -q -f "$MIG4"
FP_AFTER=$(q t_apply "$FINGERPRINT_SQL")
if [ "$FP_BEFORE" != "$FP_AFTER" ]; then
  echo "FAIL: public-schema fingerprint changed on re-apply" >&2
  echo "  before: $FP_BEFORE" >&2
  echo "  after:  $FP_AFTER" >&2
  exit 1
fi
assert_t t_apply "SELECT (SELECT count(*) FROM public.listing_sources) = 4" \
  "listing_sources seed doubled on re-apply (expected exactly 4 rows)"
psql -w "$(DBURL t_apply)" -v ON_ERROR_STOP=1 -q -f "$ASSERTS"

# =============================================================================
echo '== TEST 6: t_no_storage_ddl — no Storage DDL outside comments'
# =============================================================================
# Strip `--` comments BEFORE grepping: _02 legitimately MENTIONS the bucket,
# the uploader role and storage.objects inside its required "STORAGE
# ENFORCEMENT IS DEFERRED TO GATE B" comment. If this test fails, fix the
# stripping — never the migration.
STRIP_DIR=$(mktemp -d)
for f in "$MIG1" "$MIG2" "$MIG3" "$MIG4"; do
  sed 's/--.*$//' "$f" > "$STRIP_DIR/$(basename "$f")"
done
for pat in 'market-raw' 'market_raw_uploader' 'storage.objects' 'storage.buckets'; do
  if grep -rFq "$pat" "$STRIP_DIR"; then
    echo "FAIL: '$pat' appears as executable SQL (outside comments) in a Gate A migration:" >&2
    grep -rFn "$pat" "$STRIP_DIR" >&2
    exit 1
  fi
done

# =============================================================================
echo '== TEST 7: t_no_market_listings — no market_listings / deferred-_06 objects outside comments'
# =============================================================================
# Same comment-stripped copies. This is the guard that stops a future
# contributor quietly re-merging the deferred _06 content into _04.
for pat in 'market_listings' 'listing_field_provenance' 'mirror_outbox'; do
  if grep -rFq "$pat" "$STRIP_DIR"; then
    echo "FAIL: '$pat' appears outside comments in a Gate A migration:" >&2
    grep -rFn "$pat" "$STRIP_DIR" >&2
    exit 1
  fi
done
rm -rf "$STRIP_DIR"

echo 'All Gate A tests passed'
