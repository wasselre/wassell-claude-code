#!/usr/bin/env bash
# ============================================================================
# Designated validator for supabase/migrations/2026-08-19_10_file_views.sql
# (Phase 3 · B5 — saved views + the file_document_types read grant).
#
# The db-migrations job's other steps glob specific date prefixes and would
# never execute this migration, so it gets its own runner — the same reason
# run_b1_metadata_test.sh exists.
#
# What it proves, in order:
#   1. the migration applies to a Phase-1 + Phase-2 + B1 database
#   2. it changes NO file_links / file_link_sources row and leaves reconcile
#      drift at zero (B5 adds no authorization branch and touches no file)
#   3. every assertion in smoke_b5_file_views.sql passes
#   4. re-applying it is a no-op (idempotent)
#   5. the rollback removes exactly what it added and restores
#      file_document_types to B1's deny-all posture
#   6. it can be applied again after a rollback
#
# Usage:  PGURL=postgresql://... bash supabase/tests/ci/run_b5_file_views_test.sh
# ============================================================================
set -euo pipefail

PGURL="${PGURL:-postgresql://postgres:ci@localhost:5432/postgres}"
DB=wassell_b5_file_views
BASE="${PGURL%/*}"
DBURL="$BASE/$DB"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

q()   { psql "$DBURL" -v ON_ERROR_STOP=1 -tAqc "$1"; }
run() { psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$1"; }

echo "== creating $DB"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB;"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB;"

echo "== fixtures + Phase 1 + Phase 2 + B1"
run "$ROOT/supabase/tests/ci/fixture_file_links.sql"
run "$ROOT/supabase/tests/ci/fixture_b1_metadata.sql"
run "$ROOT/supabase/migrations/2026-08-10_file_links_projection.sql"
q "SELECT * FROM public.file_links_backfill()" >/dev/null
run "$ROOT/supabase/migrations/2026-08-12_file_link_sync.sql"
run "$ROOT/supabase/tests/ci/fixture_b1_authz.sql"
run "$ROOT/supabase/migrations/2026-08-16_01_business_file_metadata.sql"

# Mirror ONE production grant the shared fixture does not carry.
#
# B5's policies call `auth.uid()` inline, evaluated by the CALLER — that is how
# every RLS policy in this database resolves identity. On production
# `authenticated` holds USAGE on schema auth and EXECUTE on auth.uid()
# (verified: has_schema_privilege = true). The fixture never granted it, because
# every earlier suite reached auth.uid() only from INSIDE a SECURITY DEFINER
# helper, where the definer's rights apply and the caller's do not.
#
# Without this the ownership assertions fail with "permission denied for schema
# auth" — a fixture that is STRICTER than production, which is its own kind of
# wrong: it would have reported a correct migration as broken. (The opposite
# error, a fixture gentler than production, is how B2A.1 shipped a security bug.)
psql "$DBURL" -v ON_ERROR_STOP=1 -q -c "
  DO \$g\$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='auth')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
      GRANT USAGE ON SCHEMA auth TO authenticated;
      EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated';
    END IF;
  END \$g\$;"

edges()   { q "SELECT count(*) FROM public.file_links"; }
sources() { q "SELECT count(*) FROM public.file_link_sources"; }
drift()   { q "SELECT coalesce(sum(value),0) FROM public.file_links_reconcile() WHERE category='drift'"; }
dirty()   { q "SELECT count(*) FROM public.file_link_dirty_targets"; }
users()   { q "SELECT count(*) FROM public.users"; }

E0=$(edges); S0=$(sources); D0=$(drift); U0=$(users)
echo "   baseline: edges=$E0 sources=$S0 drift=$D0 users=$U0"

# NON-VACUITY. Two assertions in the smoke need two DISTINCT users, and the
# "projection untouched" check needs a projection that is not empty — with
# either at zero the suite would report success while testing nothing.
[ "$D0" = "0" ] || { echo "FAIL: baseline drift is $D0, fixture is not clean"; exit 1; }
[ "$E0" -gt 0 ] || { echo "FAIL: baseline projection is empty — 'unchanged' would be vacuous"; exit 1; }
[ "$U0" -ge 2 ] || { echo "FAIL: fixture has $U0 user(s); the ownership assertions need 2"; exit 1; }

echo "== applying B5"
run "$ROOT/supabase/migrations/2026-08-19_10_file_views.sql"

E1=$(edges); S1=$(sources); D1=$(drift); DT1=$(dirty)
echo "   after B5: edges=$E1 sources=$S1 drift=$D1 dirty=$DT1"
[ "$E1" = "$E0" ] || { echo "FAIL: file_links changed $E0 -> $E1"; exit 1; }
[ "$S1" = "$S0" ] || { echo "FAIL: file_link_sources changed $S0 -> $S1"; exit 1; }
[ "$D1" = "0" ]   || { echo "FAIL: drift after B5 is $D1"; exit 1; }
[ "$DT1" = "0" ]  || { echo "FAIL: $DT1 dirty target(s) left behind"; exit 1; }
echo "   OK: projection untouched — B5 adds no authorization branch"

# B5 must not have altered the `files` authorization surface in any way. The
# policy text is compared verbatim rather than by reach, because B5 has no
# business changing it at all.
FP0=$(q "SELECT md5(string_agg(policyname||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''), ',' ORDER BY policyname))
           FROM pg_policies WHERE schemaname='public' AND tablename IN ('files','file_links')")
echo "   files/file_links policy fingerprint: ${FP0:0:12}…"

echo "== smoke assertions"
psql "$DBURL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/ci/smoke_b5_file_views.sql"

echo "== idempotency: re-applying B5"
run "$ROOT/supabase/migrations/2026-08-19_10_file_views.sql"
[ "$(edges)" = "$E0" ] || { echo "FAIL: re-apply changed edges"; exit 1; }
[ "$(drift)" = "0" ]   || { echo "FAIL: re-apply introduced drift"; exit 1; }
POL=$(q "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='file_views'")
[ "$POL" = "4" ] || { echo "FAIL: re-apply left $POL policies on file_views, expected 4"; exit 1; }
FP1=$(q "SELECT md5(string_agg(policyname||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''), ',' ORDER BY policyname))
           FROM pg_policies WHERE schemaname='public' AND tablename IN ('files','file_links')")
[ "$FP1" = "$FP0" ] || { echo "FAIL: re-apply altered the files/file_links policies"; exit 1; }
echo "   OK: second apply is a no-op"

echo "== rollback"
run "$ROOT/supabase/rollback/2026-08-19_10_file_views_down.sql"
[ "$(q "SELECT to_regclass('public.file_views') IS NULL")" = "t" ] \
  || { echo "FAIL: file_views survived the rollback"; exit 1; }
FDT=$(q "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='file_document_types'")
[ "$FDT" = "0" ] || { echo "FAIL: rollback left $FDT policy/policies on file_document_types"; exit 1; }
GR=$(q "SELECT count(*) FROM information_schema.role_table_grants
          WHERE table_schema='public' AND table_name='file_document_types'
            AND grantee IN ('anon','authenticated','service_role')")
[ "$GR" = "0" ] || { echo "FAIL: rollback left $GR grant(s) on file_document_types"; exit 1; }
[ "$(edges)" = "$E0" ] || { echo "FAIL: rollback changed edges"; exit 1; }
[ "$(drift)" = "0" ]   || { echo "FAIL: rollback introduced drift"; exit 1; }
echo "   OK: rollback restored B1's deny-all posture and touched no file"

echo "== re-apply after rollback"
run "$ROOT/supabase/migrations/2026-08-19_10_file_views.sql"
[ "$(drift)" = "0" ] || { echo "FAIL: drift after re-apply"; exit 1; }
psql "$DBURL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/ci/smoke_b5_file_views.sql" >/dev/null
echo "   OK: clean re-application"

echo
echo "B5 file_views: ALL CHECKS PASSED"
