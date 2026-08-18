#!/usr/bin/env bash
# =============================================================================
# CI runner: Phase 3 canonical publisher (2026-09-06_02_market_listings_publisher).
#
# Requires PGURL — a Postgres SUPERUSER maintenance database. Applies the full
# chain on a fresh DB (Gate A fixture + _01..04 + write-path _06_01 + a MINIMAL
# market_listings publisher fixture + provenance/outbox _06 + the publisher _02),
# proves idempotent re-apply, then exercises the publisher contract.
#
# The publisher fixture stands up a minimal market_listings ONLY to test the
# publisher; it makes no fresh-vs-prod parity claim (that stays out of scope).
# =============================================================================
set -euo pipefail

FIX=supabase/tests/ci/fixture_market_ingest.sql
PUBFIX=supabase/tests/ci/fixture_market_publisher.sql
M1=supabase/migrations/2026-09-05_01_listing_sources_registry.sql
M2=supabase/migrations/2026-09-05_02_raw_capture.sql
M3=supabase/migrations/2026-09-05_03_field_catalog_and_gaps.sql
M4=supabase/migrations/2026-09-05_04_ingestion_audit.sql
WRITE=supabase/migrations/2026-09-06_01_ingestion_write_path.sql
M6=supabase/migrations/2026-09-05_06_listing_provenance_outbox.sql
PUB=supabase/migrations/2026-09-06_02_market_listings_publisher.sql
ASSERT=supabase/tests/ci/assert_market_publisher.sql

: "${PGURL:?PGURL must point at a Postgres superuser maintenance database}"
for f in "$FIX" "$PUBFIX" "$M1" "$M2" "$M3" "$M4" "$WRITE" "$M6" "$PUB" "$ASSERT"; do
  [ -f "$f" ] || { echo "ERROR: missing $f" >&2; exit 1; }
done

DBURL() { echo "${PGURL%/*}/$1"; }
q() { psql -w "$(DBURL "$1")" -v ON_ERROR_STOP=1 -qAt -c "$2"; }
cleanup() { psql -w "$PGURL" -q -c "DROP DATABASE IF EXISTS t_pub" >/dev/null 2>&1 || true; }
trap cleanup EXIT

FP="SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') || '/' || (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r')"

echo '== apply full chain'
psql -w "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS t_pub" -c "CREATE DATABASE t_pub"
U="$(DBURL t_pub)"
psql -w "$U" -v ON_ERROR_STOP=1 -q -f "$FIX"
for m in "$M1" "$M2" "$M3" "$M4" "$WRITE"; do psql -w "$U" -v ON_ERROR_STOP=1 -q -f "$m"; done
psql -w "$U" -v ON_ERROR_STOP=1 -q -f "$PUBFIX"
psql -w "$U" -v ON_ERROR_STOP=1 -q -f "$M6"
psql -w "$U" -v ON_ERROR_STOP=1 -q -f "$PUB"

echo '== idempotency — re-apply publisher changes no object'
B=$(q t_pub "$FP"); psql -w "$U" -v ON_ERROR_STOP=1 -q -f "$PUB"; A=$(q t_pub "$FP")
[ "$B" = "$A" ] || { echo "FAIL: publisher re-apply changed object fingerprint ($B -> $A)" >&2; exit 1; }

echo '== publisher contract assertions'
psql -w "$U" -v ON_ERROR_STOP=1 -q -f "$ASSERT" >/dev/null

echo 'Market publisher tests passed'
