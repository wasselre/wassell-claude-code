#!/usr/bin/env bash
# =============================================================================
# CI runner: the FULL market-ingest replay sequence.
#
# Requires PGURL — libpq connection string to a Postgres 17 SUPERUSER
# maintenance database. Each test gets a fresh database.
#
# WHAT THIS PROVES: that the freeze baseline establishes exactly the predecessor
# state the UNMODIFIED 2026-09-04_00 pins, that the real 2026-09-04_00 then
# converges to the six-policy secure state, and that Gate A _01.._04 and _06
# apply on top — the whole chain, executed, not assumed.
#
# Sequence under test:
#   1. supported pre-freeze predecessor fixture (frozen geography models,
#      three-way unified_records, byte-exact wassell_* functions)
#   2. 2026-09-03_02_market_listings_freeze_baseline.sql
#   3. 2026-09-04_00_market_listings_view_reconciliation.sql   <- UNMODIFIED
#   4. 2026-09-05_01 .. _04
#   5. 2026-09-05_06_listing_provenance_outbox.sql
#   6. final assertions + idempotency + fail-closed drift
# =============================================================================
set -euo pipefail

FIX=supabase/tests/ci/fixture_freeze_predecessor.sql
BASE=supabase/migrations/2026-09-03_02_market_listings_freeze_baseline.sql
RECON=supabase/migrations/2026-09-04_00_market_listings_view_reconciliation.sql
M1=supabase/migrations/2026-09-05_01_listing_sources_registry.sql
M2=supabase/migrations/2026-09-05_02_raw_capture.sql
M3=supabase/migrations/2026-09-05_03_field_catalog_and_gaps.sql
M4=supabase/migrations/2026-09-05_04_ingestion_audit.sql
M6=supabase/migrations/2026-09-05_06_listing_provenance_outbox.sql
ASSERTS=supabase/tests/ci/assert_market_ingest_gate_a.sql

: "${PGURL:?PGURL must point at a Postgres superuser maintenance database}"
for f in "$FIX" "$BASE" "$RECON" "$M1" "$M2" "$M3" "$M4" "$M6" "$ASSERTS"; do
  [ -f "$f" ] || { echo "ERROR: missing $f" >&2; exit 1; }
done

DBURL() { echo "${PGURL%/*}/$1"; }
createdb_fresh() {
  psql -w "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $1"
  psql -w "$PGURL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $1"
}
dropdb_quiet() { psql -w "$PGURL" -q -c "DROP DATABASE IF EXISTS $1" >/dev/null 2>&1 || true; }
cleanup() { dropdb_quiet t_seq; dropdb_quiet t_prodshape; dropdb_quiet t_drift; }
trap cleanup EXIT

run() { psql -w "$(DBURL "$1")" -v ON_ERROR_STOP=1 -q -f "$2"; }
q()   { psql -w "$(DBURL "$1")" -v ON_ERROR_STOP=1 -qAt -c "$2"; }
assert_t() {
  local db="$1" sql="$2" msg="$3" got
  got=$(q "$db" "$sql")
  [ "$got" = "t" ] || { echo "ASSERT FAILED [$db]: $msg (got '$got')" >&2; exit 1; }
}

# =============================================================================
echo '== TEST 1: full fresh sequence, ending in the real unmodified 2026-09-04_00'
# =============================================================================
createdb_fresh t_seq
run t_seq "$FIX"
echo '   -- fixture applied (pinned function md5s verified inside it)'
assert_t t_seq "SELECT to_regclass('public.market_listings') IS NULL" \
  "predecessor must NOT already have market_listings"

run t_seq "$BASE"
echo '   -- freeze baseline applied'
assert_t t_seq "SELECT NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.market_listings'::regclass AND polname='market_listings_view_fast')" \
  "baseline must leave market_listings_view_fast ABSENT for 2026-09-04_00"
assert_t t_seq "SELECT count(*)=4 FROM pg_policy WHERE polrelid='public.market_listings'::regclass" \
  "baseline must leave exactly the four frozen_* policies"

run t_seq "$RECON"
echo '   -- UNMODIFIED 2026-09-04_00 converged'

# The six-policy secure end state.
assert_t t_seq "SELECT count(*)=6 FROM pg_policy WHERE polrelid='public.market_listings'::regclass" \
  "expected six policies after the reconciliation"
assert_t t_seq "SELECT polpermissive FROM pg_policy WHERE polrelid='public.market_listings'::regclass AND polname='market_listings_view_fast'" \
  "market_listings_view_fast must be PERMISSIVE"
assert_t t_seq "SELECT NOT polpermissive FROM pg_policy WHERE polrelid='public.market_listings'::regclass AND polname='market_listings_view_deny_none'" \
  "market_listings_view_deny_none must be RESTRICTIVE"
for v in market_listings_summary v_market_listings v_market_properties; do
  assert_t t_seq "SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class WHERE oid='public.$v'::regclass" \
    "$v must be security_invoker=true after the reconciliation"
done
assert_t t_seq "SELECT coalesce(string_agg(DISTINCT a.privilege_type,','),'(none)')='SELECT' FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid='public.market_listings_summary'::regclass AND a.grantee='authenticated'::regrole" \
  "authenticated must hold exactly SELECT on the summary"
assert_t t_seq "SELECT NOT EXISTS (SELECT 1 FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid IN ('public.v_market_listings'::regclass,'public.v_market_properties'::regclass) AND a.grantee IN (0,'anon'::regrole,'authenticated'::regrole))" \
  "the two full-data views must be revoked from PUBLIC/anon/authenticated"

# THE five-way union fingerprint.
assert_t t_seq "SELECT md5(pg_get_viewdef('public.unified_records'::regclass))='74602527636617c3549508a67fcc220d'" \
  "unified_records must be the pinned five-way union"

run t_seq "$M1"; run t_seq "$M2"; run t_seq "$M3"; run t_seq "$M4"
echo '   -- Gate A _01.._04 applied'
run t_seq "$M6"
echo '   -- _06 provenance/outbox applied'

assert_t t_seq "SELECT count(*)=2 FROM pg_constraint c JOIN pg_class f ON f.oid=c.confrelid WHERE c.contype='f' AND f.relname='market_listings' AND c.conrelid IN ('public.listing_field_provenance'::regclass,'public.mirror_outbox'::regclass)" \
  "_06 must keep BOTH required foreign keys to market_listings"

psql -w "$(DBURL t_seq)" -v ON_ERROR_STOP=1 -q -f "$ASSERTS"
echo '   -- Gate A assertion suite passed on the full sequence'

# =============================================================================
echo '== TEST 2: production-shaped path — baseline is assert-only, non-destructive'
# =============================================================================
BEFORE=$(q t_seq "SELECT md5(string_agg(x,'|' ORDER BY x)) FROM (
  SELECT polname||':'||md5(coalesce(pg_get_expr(polqual,polrelid),'')) AS x FROM pg_policy WHERE polrelid='public.market_listings'::regclass
  UNION ALL SELECT 'v:'||relname||':'||md5(pg_get_viewdef(oid)) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='v'
) s")
run t_seq "$BASE"
AFTER=$(q t_seq "SELECT md5(string_agg(x,'|' ORDER BY x)) FROM (
  SELECT polname||':'||md5(coalesce(pg_get_expr(polqual,polrelid),'')) AS x FROM pg_policy WHERE polrelid='public.market_listings'::regclass
  UNION ALL SELECT 'v:'||relname||':'||md5(pg_get_viewdef(oid)) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='v'
) s")
[ "$BEFORE" = "$AFTER" ] || { echo "FAIL: baseline mutated a production-shaped database ($BEFORE -> $AFTER)" >&2; exit 1; }
assert_t t_seq "SELECT count(*)=6 FROM pg_policy WHERE polrelid='public.market_listings'::regclass" \
  "re-running the baseline must not disturb the six-policy state"

# =============================================================================
echo '== TEST 3: idempotency — re-apply _01.._04 and _06, nothing changes'
# =============================================================================
FP_SQL="SELECT (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r')||':'||(SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='v')||':'||(SELECT count(*) FROM pg_policy)||':'||(SELECT count(*) FROM public.listing_sources)"
FP1=$(q t_seq "$FP_SQL")
run t_seq "$M1"; run t_seq "$M2"; run t_seq "$M3"; run t_seq "$M4"; run t_seq "$M6"
FP2=$(q t_seq "$FP_SQL")
[ "$FP1" = "$FP2" ] || { echo "FAIL: re-apply changed the fingerprint ($FP1 -> $FP2)" >&2; exit 1; }
psql -w "$(DBURL t_seq)" -v ON_ERROR_STOP=1 -q -f "$ASSERTS"

# =============================================================================
echo '== TEST 4: fail-closed drift — a drifted frozen predicate is refused'
# =============================================================================
createdb_fresh t_drift
run t_drift "$FIX"
run t_drift "$BASE"
psql -w "$(DBURL t_drift)" -v ON_ERROR_STOP=1 -q -c \
  "DROP POLICY frozen_view ON public.market_listings;
   CREATE POLICY frozen_view ON public.market_listings FOR SELECT TO authenticated USING (true);"
LOG=$(mktemp)
if psql -w "$(DBURL t_drift)" -v ON_ERROR_STOP=1 -f "$RECON" >"$LOG" 2>&1; then
  echo "FAIL: 2026-09-04_00 accepted a drifted frozen_view predicate" >&2; exit 1
fi
grep -q 'PREFLIGHT' "$LOG" || { echo "FAIL: expected a PREFLIGHT refusal:" >&2; cat "$LOG" >&2; exit 1; }
rm -f "$LOG"

# =============================================================================
echo '== TEST 5: _06 refuses without the frozen table'
# =============================================================================
createdb_fresh t_prodshape
run t_prodshape "$FIX"
run t_prodshape "$M1"
LOG=$(mktemp)
if psql -w "$(DBURL t_prodshape)" -v ON_ERROR_STOP=1 -f "$M6" >"$LOG" 2>&1; then
  echo "FAIL: _06 applied without market_listings" >&2; exit 1
fi
grep -q 'PREFLIGHT' "$LOG" && grep -q 'market_listings' "$LOG" \
  || { echo "FAIL: expected a named PREFLIGHT refusal naming market_listings:" >&2; cat "$LOG" >&2; exit 1; }
rm -f "$LOG"

echo 'All freeze-baseline sequence tests passed'
