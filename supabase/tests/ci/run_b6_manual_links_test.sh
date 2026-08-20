#!/usr/bin/env bash
# ============================================================================
# Designated validator for Phase 3 · B6:
#   supabase/migrations/2026-08-19_11_manual_link_write_surface.sql
#   supabase/migrations/2026-08-19_12_manual_link_role.sql
#
# The db-migrations job globs specific date prefixes and would never execute
# either of these, so they get their own runner — same reason B1 and B5 do.
#
# What it proves, in order:
#   1. both migrations apply to a Phase-1 + Phase-2 + B1 database
#   2. the role change is a NO-OP on existing data: the whole live-source
#      derivation is byte-identical before and after, for BOTH the global
#      function and its scoped twin
#   3. the projection itself is unchanged — no edge moves, drift stays zero
#   4. every assertion in smoke_b6_manual_links.sql passes
#   5. re-applying both is a no-op (idempotent)
#   6. the rollbacks restore the pre-B6 behaviour
#
# Usage: PGURL=postgresql://... bash supabase/tests/ci/run_b6_manual_links_test.sh
# ============================================================================
set -euo pipefail

PGURL="${PGURL:-postgresql://postgres:ci@localhost:5432/postgres}"
DB=wassell_b6_manual_links
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

# Same production grant the B5 runner mirrors: `authenticated` holds USAGE on
# schema auth. The shared fixture never granted it because every earlier suite
# reached auth.uid() only from inside a SECURITY DEFINER helper. A fixture
# STRICTER than production reports a correct migration as broken.
psql "$DBURL" -v ON_ERROR_STOP=1 -q -c "
  DO \$g\$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='auth')
       AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
      GRANT USAGE ON SCHEMA auth TO authenticated;
      EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated';
    END IF;
  END \$g\$;"

# The fixture must actually contain a manual link, or every assertion about the
# manual branch of the derivation is vacuous.
MANUAL=$(q "SELECT count(*) FROM public.document_links")
if [ "$MANUAL" -lt 1 ]; then
  echo "   seeding a manual link (the shared fixture carries none)"
  q "INSERT INTO public.document_links (file_id, model_id, record_id, created_by_user_id)
     SELECT f.id, r.model_id, r.id, f.uploaded_by_user_id
       FROM public.files f, public.records r
      WHERE r.model_id IS NOT NULL
      LIMIT 1
     ON CONFLICT DO NOTHING" >/dev/null
  q "SELECT public.file_links_drain_dirty()" >/dev/null 2>&1 || true
  MANUAL=$(q "SELECT count(*) FROM public.document_links")
fi
[ "$MANUAL" -ge 1 ] || { echo "FAIL: could not seed a manual link; the suite would be vacuous"; exit 1; }
echo "   manual links in fixture: $MANUAL"

# ── baseline ────────────────────────────────────────────────────────────────
# The fingerprint is over the WHOLE derivation, keyed by source AND role — a
# count would not notice a role moving, which is precisely what this migration
# could get wrong.
fp_global() { q "SELECT coalesce(md5(string_agg(source_key||'|'||role, ',' ORDER BY source_key)),'empty')
                   FROM public.file_link_live_sources()"; }
fp_scoped() { q "SELECT coalesce(md5(string_agg(s.source_key||'|'||s.role, ',' ORDER BY s.source_key)),'empty')
                   FROM (SELECT DISTINCT model_id, record_id FROM public.file_link_live_sources()) t,
                        LATERAL public.file_link_live_sources_scoped(t.model_id, t.record_id) s"; }
edges()   { q "SELECT count(*) FROM public.file_links"; }
drift()   { q "SELECT coalesce(sum(value),0) FROM public.file_links_reconcile() WHERE category='drift'"; }

G0=$(fp_global); S0=$(fp_scoped); E0=$(edges)
echo "   baseline: edges=$E0 global=${G0:0:12}… scoped=${S0:0:12}…"
[ "$G0" != "empty" ] || { echo "FAIL: the derivation is empty; every fingerprint assertion is vacuous"; exit 1; }
[ "$G0" = "$S0" ]    || { echo "FAIL: global <> scoped BEFORE B6 — the fixture is already broken"; exit 1; }

echo "== applying B6"
run "$ROOT/supabase/migrations/2026-08-19_11_manual_link_write_surface.sql"
run "$ROOT/supabase/migrations/2026-08-19_12_manual_link_role.sql"

G1=$(fp_global); S1=$(fp_scoped); E1=$(edges)
[ "$G1" = "$G0" ] || { echo "FAIL: the global derivation MOVED — B6 is only safe because it is a no-op on links with a NULL role ($G0 -> $G1)"; exit 1; }
[ "$S1" = "$S0" ] || { echo "FAIL: the scoped twin moved ($S0 -> $S1)"; exit 1; }
[ "$E1" = "$E0" ] || { echo "FAIL: edge count changed $E0 -> $E1"; exit 1; }
echo "   OK: derivation byte-identical, both texts, no edge moved"

echo "== smoke assertions"
psql "$DBURL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/ci/smoke_b6_manual_links.sql"

echo "== idempotency: re-applying both"
run "$ROOT/supabase/migrations/2026-08-19_11_manual_link_write_surface.sql"
run "$ROOT/supabase/migrations/2026-08-19_12_manual_link_role.sql"
[ "$(fp_global)" = "$G0" ] || { echo "FAIL: re-apply moved the derivation"; exit 1; }
[ "$(edges)" = "$E0" ]     || { echo "FAIL: re-apply changed the edge count"; exit 1; }
[ "$(q "SELECT has_table_privilege('authenticated','public.document_links','TRUNCATE')")" = "f" ] \
  || { echo "FAIL: re-apply restored TRUNCATE"; exit 1; }
echo "   OK: second apply is a no-op"

echo "== rollback"
run "$ROOT/supabase/rollback/2026-08-19_12_manual_link_role_down.sql"
run "$ROOT/supabase/rollback/2026-08-19_11_manual_link_write_surface_down.sql"

# The role rollback must restore the hardcoded literal in BOTH texts, and they
# must still agree with each other.
q "UPDATE public.document_links SET role='brochure'" >/dev/null
BACK=$(q "SELECT role FROM public.file_link_live_sources() WHERE source_key LIKE 'manual:%' LIMIT 1")
[ "$BACK" = "supporting_document" ] \
  || { echo "FAIL: after rollback the derivation still reads document_links.role (got $BACK)"; exit 1; }
[ "$(fp_global)" = "$(fp_scoped)" ] \
  || { echo "FAIL: after rollback global <> scoped — the two texts were not reverted together"; exit 1; }
q "UPDATE public.document_links SET role=NULL" >/dev/null
echo "   OK: both derivations reverted together"

# The grant rollback deliberately does NOT restore TRUNCATE — reinstating a
# privilege RLS cannot mediate is not something a rollback should do. Asserted
# so nobody "fixes" that asymmetry without reading why it exists.
[ "$(q "SELECT has_table_privilege('authenticated','public.document_links','TRUNCATE')")" = "f" ] \
  || { echo "FAIL: the rollback restored TRUNCATE — see the header of the _11 rollback file"; exit 1; }
echo "   OK: rollback did not reinstate the TRUNCATE grant (by design)"

echo "== re-apply after rollback"
run "$ROOT/supabase/migrations/2026-08-19_11_manual_link_write_surface.sql"
run "$ROOT/supabase/migrations/2026-08-19_12_manual_link_role.sql"
[ "$(fp_global)" = "$G0" ] || { echo "FAIL: re-apply after rollback moved the derivation"; exit 1; }
[ "$(drift)" = "0" ]       || { echo "FAIL: drift after re-apply"; exit 1; }
echo "   OK: clean re-application"

echo
echo "B6 manual links: ALL CHECKS PASSED"
