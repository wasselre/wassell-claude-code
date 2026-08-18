#!/usr/bin/env bash
# =============================================================================
# CI runner: Phase 2 ingestion WRITE-PATH (2026-09-06_01_ingestion_write_path.sql).
#
# Requires PGURL — a libpq connection string to a Postgres SUPERUSER maintenance
# database. Each test gets a fresh database; the per-test URL is PGURL with the
# database name replaced.
#
# WHAT THIS PROVES: the owner-run definer RPCs apply cleanly + idempotently on
# top of the Gate A chain (built against the SUPPORTED PREDECESSOR FIXTURE), that
# capture/observe/gap writes are deterministic on retry, that a captured-but-
# unmapped field raises exactly one schema gap while a mapped/excluded field
# raises none, that optional-absent sections do NOT reduce capture completeness,
# and that only `service_role` may EXECUTE the RPCs (the §12b ACL discipline).
# =============================================================================
set -euo pipefail

FIX=supabase/tests/ci/fixture_market_ingest.sql
MIG1=supabase/migrations/2026-09-05_01_listing_sources_registry.sql
MIG2=supabase/migrations/2026-09-05_02_raw_capture.sql
MIG3=supabase/migrations/2026-09-05_03_field_catalog_and_gaps.sql
MIG4=supabase/migrations/2026-09-05_04_ingestion_audit.sql
WRITE=supabase/migrations/2026-09-06_01_ingestion_write_path.sql
ASSERT=supabase/tests/ci/assert_ingestion_write_path.sql

: "${PGURL:?PGURL must point at a Postgres superuser maintenance database}"
for f in "$FIX" "$MIG1" "$MIG2" "$MIG3" "$MIG4" "$WRITE" "$ASSERT"; do
  [ -f "$f" ] || { echo "ERROR: missing $f" >&2; exit 1; }
done

DBURL() { echo "${PGURL%/*}/$1"; }
q() { psql -w "$(DBURL "$1")" -v ON_ERROR_STOP=1 -qAt -c "$2"; }
cleanup() { psql -w "$PGURL" -q -c "DROP DATABASE IF EXISTS t_write" >/dev/null 2>&1 || true; }
trap cleanup EXIT

FINGERPRINT_SQL="SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') || '/' || (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r')"

echo '== TEST 1: apply chain, then the write-path migration'
psql -w "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS t_write" -c "CREATE DATABASE t_write"
U="$(DBURL t_write)"
psql -w "$U" -v ON_ERROR_STOP=1 -q -f "$FIX"
for m in "$MIG1" "$MIG2" "$MIG3" "$MIG4" "$WRITE"; do
  psql -w "$U" -v ON_ERROR_STOP=1 -q -f "$m"
done

echo '== TEST 2: idempotency — re-applying the write-path migration changes no object'
FP_BEFORE=$(q t_write "$FINGERPRINT_SQL")
psql -w "$U" -v ON_ERROR_STOP=1 -q -f "$WRITE"
FP_AFTER=$(q t_write "$FINGERPRINT_SQL")
[ "$FP_BEFORE" = "$FP_AFTER" ] || { echo "FAIL: object fingerprint changed on re-apply ($FP_BEFORE -> $FP_AFTER)" >&2; exit 1; }

echo '== TEST 3: functional + ACL assertions'
# ON_ERROR_STOP + the RAISE EXCEPTION/1-0 guards inside make any failure fatal.
psql -w "$U" -v ON_ERROR_STOP=1 -q -f "$ASSERT" >/dev/null

echo 'Ingestion write-path tests passed'
