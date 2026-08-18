#!/usr/bin/env bash
# ============================================================================
# B2A.3 PROFILING — measurement only. Applies no migration, changes nothing.
#
# Isolates where file_links_select actually spends its time, on a
# production-shaped ephemeral database (~10k edges, 8k files), before any design
# is chosen. The instruction is explicit: do NOT assume the unified_records
# predicate needs changing until measurements prove it.
#
# Emits EXPLAIN (ANALYZE, BUFFERS) for:
#   1. file-visibility predicate alone      wassell_can_access_file(file_id,'view')
#   2. record-visibility predicate alone    EXISTS (unified_records ...)
#   3. combined                             = the live file_links_select
#   4-6. the three B2 consumers             linked_model facet, role facet, link_count
#
# Run:  PGURL=... bash supabase/tests/ci/profile_b2a3_link_authz.sh
# ============================================================================
set -euo pipefail

PGURL="${PGURL:-postgresql://postgres:ci@localhost:5432/postgres}"
DB=wassell_b2a3_profile
BASE="${PGURL%/*}"; DBURL="$BASE/$DB"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

q()   { psql "$DBURL" -v ON_ERROR_STOP=1 -tAqc "$1"; }
run() { psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$1"; }

# A representative NON-ADMIN: the expensive path, since admins short-circuit.
SUBJECT=${SUBJECT:-55555555-5555-5555-5555-555555555555}

echo "== creating $DB"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB;"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB;"

echo "== stack: Phase 1 + Phase 2 + B1 + authz + B2A + B2A.2 + scoping"
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
run "$ROOT/supabase/migrations/2026-08-17_01_scope_authz_helpers.sql"
run "$ROOT/supabase/tests/ci/fixture_b2a3_edges.sql"

EDGES=$(q "SELECT count(*) FROM public.file_links")
FILES=$(q "SELECT count(*) FROM public.files")
echo "   corpus: $FILES files, $EDGES edges (production: 7,548 / 9,856)"
[ "$EDGES" -ge 5000 ] || { echo "FAIL: only $EDGES edges — too small to profile a per-edge cost"; exit 1; }

# Materialise the edge list as postgres so each predicate can be measured in
# ISOLATION. Selecting from file_links as `authenticated` applies BOTH halves of
# the policy at once, which is precisely what we are trying to separate.
psql "$DBURL" -v ON_ERROR_STOP=1 -q <<SQL
CREATE TABLE public._prof_edges AS SELECT file_id, model_id, record_id FROM public.file_links;
CREATE INDEX ON public._prof_edges(file_id);
ANALYZE public._prof_edges;
GRANT SELECT ON public._prof_edges TO authenticated;
SQL

section() { echo; echo "──────── $1 ────────"; }

# statement_timeout keeps a pathological predicate from hanging the job: it
# fails loudly with a number instead of stalling, which is itself the finding.
prof() {  # $1 = label, $2 = SQL
  section "$1"
  psql "$DBURL" -v ON_ERROR_STOP=0 -tAq <<SQL 2>&1 | sed 's/^/  /'
BEGIN;
SET LOCAL statement_timeout = '120s';
SELECT set_config('test.uid','$SUBJECT', true);
SET LOCAL ROLE authenticated;
EXPLAIN (ANALYZE, BUFFERS, TIMING)
$2;
ROLLBACK;
SQL
}

prof "1. FILE-visibility predicate alone (per edge)" \
"SELECT count(*) FROM public._prof_edges l
  WHERE public.wassell_can_access_file(l.file_id,'view')"

prof "2. RECORD-visibility predicate alone (per edge)" \
"SELECT count(*) FROM public._prof_edges l
  WHERE EXISTS (SELECT 1 FROM public.unified_records ur
                 WHERE ur.id = l.record_id AND ur.model_id = l.model_id)"

prof "3. COMBINED — exactly the live file_links_select" \
"SELECT count(*) FROM public._prof_edges l
  WHERE public.wassell_can_access_file(l.file_id,'view')
    AND EXISTS (SELECT 1 FROM public.unified_records ur
                 WHERE ur.id = l.record_id AND ur.model_id = l.model_id)"

prof "4. B2 consumer — linked_model facet" \
"SELECT m.name, count(DISTINCT l.file_id)
   FROM public.file_links l JOIN public.models m ON m.id = l.model_id GROUP BY 1"

prof "5. B2 consumer — role facet" \
"SELECT l.role, count(DISTINCT l.file_id) FROM public.file_links l GROUP BY 1"

prof "6. B2 consumer — link_count for one page (60 rows)" \
"SELECT f.id, (SELECT count(*) FROM public.file_links l WHERE l.file_id = f.id)
   FROM public.files f ORDER BY f.created_at DESC LIMIT 60"

section "reference: how many edges are actually visible to this subject"
psql "$DBURL" -v ON_ERROR_STOP=0 -tAq <<SQL 2>&1 | sed 's/^/  /'
BEGIN;
SET LOCAL statement_timeout = '120s';
SELECT set_config('test.uid','$SUBJECT', true);
SET LOCAL ROLE authenticated;
SELECT 'visible_edges=' || count(*) FROM public.file_links;
ROLLBACK;
SQL

echo
echo "B2A.3 profiling complete — no migration applied, nothing changed."
