#!/usr/bin/env bash
# ============================================================================
# B2A.3 stage 2 - test the COST-hint hypothesis. Measurement only.
#
# Stage 1 showed file_links_select costs 7.4s through the policy but 6ms when
# the two conjuncts are written explicitly, because the planner runs the cheap
# record-visibility EXISTS first and the expensive function never fires. The
# hypothesis: declaring wassell_can_access_file's true cost makes the planner
# order the policy's conjuncts the same way.
#
# THE HYPOTHESIS HAS AN OBVIOUS FAILURE MODE AND THIS SCRIPT HUNTS FOR IT.
# Reordering only helps when the cheap predicate actually eliminates rows. For a
# caller who CAN see most records, record-visibility passes almost everywhere,
# the expensive function still runs per edge, and cost hints change nothing.
# Stage 1 measured a persona seeing ZERO edges - the most favourable case there
# is. So this measures personas across the whole spectrum and reports the WORST.
# ============================================================================
set -euo pipefail

PGURL="${PGURL:-postgresql://postgres:ci@localhost:5432/postgres}"
DB=wassell_b2a3_cost
BASE="${PGURL%/*}"; DBURL="$BASE/$DB"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

q()   { psql "$DBURL" -v ON_ERROR_STOP=1 -tAqc "$1"; }
run() { psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$1"; }

PERSONAS="99999999-9999-9999-9999-999999999999
11111111-1111-1111-1111-111111111111
22222222-2222-2222-2222-222222222222
33333333-3333-3333-3333-333333333333
44444444-4444-4444-4444-444444444444
55555555-5555-5555-5555-555555555555
88888888-8888-8888-8888-888888888888"

echo "== creating $DB"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB;"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB;"

echo "== stack + production-shaped edges"
run "$ROOT/supabase/tests/ci/fixture_file_links.sql"
run "$ROOT/supabase/tests/ci/fixture_b1_metadata.sql"
run "$ROOT/supabase/migrations/2026-08-10_file_links_projection.sql"
q   "SELECT * FROM public.file_links_backfill()" >/dev/null
run "$ROOT/supabase/migrations/2026-08-12_file_link_sync.sql"
run "$ROOT/supabase/tests/ci/fixture_b2a_authz.sql"
run "$ROOT/supabase/migrations/2026-08-16_01_business_file_metadata.sql"
psql "$DBURL" -v ON_ERROR_STOP=1 -q -c "ALTER TABLE public.files ENABLE ROW LEVEL SECURITY; GRANT SELECT ON public.files TO authenticated;"
run "$ROOT/supabase/rollback/2026-08-16_03_file_authz_performance_down.sql"
run "$ROOT/supabase/tests/ci/fixture_b2a1_highcard.sql"
run "$ROOT/supabase/migrations/2026-08-16_03_file_authz_performance.sql"
run "$ROOT/supabase/migrations/2026-08-16_06_file_authz_grant_sets_v2.sql"
run "$ROOT/supabase/migrations/2026-08-17_01_scope_authz_helpers.sql"
run "$ROOT/supabase/tests/ci/fixture_b2a3_edges.sql"

COSTQ="SELECT procost FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='wassell_can_access_file'"
echo "   corpus: $(q "SELECT count(*) FROM public.files") files, $(q "SELECT count(*) FROM public.file_links") edges"
echo "   wassell_can_access_file declared COST = $(q "$COSTQ")"

measure() {
  local uid
  for uid in $PERSONAS; do
    psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL | grep -E "^M "
CREATE TEMP TABLE IF NOT EXISTS _r(k text, v text); TRUNCATE _r;
GRANT INSERT ON _r TO authenticated;
BEGIN;
SET LOCAL statement_timeout = '180s';
SELECT set_config('test.uid','$uid', true);
SET LOCAL ROLE authenticated;
DO \$\$
DECLARE t0 timestamptz; n bigint; fp text; ms1 numeric; ms2 numeric;
BEGIN
  SELECT count(*), coalesce(md5(string_agg(l.file_id::text||':'||l.model_id::text||':'||l.record_id::text,
         ',' ORDER BY l.file_id, l.model_id, l.record_id)),'EMPTY')
    INTO n, fp FROM public.file_links l;
  t0 := clock_timestamp();
  PERFORM m.name, count(DISTINCT l.file_id)
     FROM public.file_links l JOIN public.models m ON m.id = l.model_id GROUP BY m.name;
  ms1 := EXTRACT(epoch FROM clock_timestamp()-t0)*1000;
  t0 := clock_timestamp();
  PERFORM l.role, count(DISTINCT l.file_id) FROM public.file_links l GROUP BY l.role;
  ms2 := EXTRACT(epoch FROM clock_timestamp()-t0)*1000;
  INSERT INTO _r VALUES ('out', 'M $1 ' || left('$uid',8)
    || ' edges=' || n || ' fp=' || left(fp,10)
    || ' lm=' || round(ms1,1) || ' role=' || round(ms2,1));
END \$\$;
RESET ROLE;
SELECT v FROM _r WHERE k='out';
ROLLBACK;
SQL
  done
}

plan_shape() {
  psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL | sed 's/^/   /'
BEGIN;
SET LOCAL statement_timeout='180s';
SELECT set_config('test.uid','55555555-5555-5555-5555-555555555555', true);
SET LOCAL ROLE authenticated;
EXPLAIN (COSTS) SELECT count(*) FROM public.file_links;
ROLLBACK;
SQL
}

echo
echo "-------- BEFORE: default COST --------"
measure before | tee "$WORK/before.txt" | sed 's/^/   /'
echo
echo "-------- plan shape BEFORE --------"
plan_shape

echo
echo "== declaring the function's true cost (the ONLY change under test)"
q "ALTER FUNCTION public.wassell_can_access_file(uuid, text) COST 10000" >/dev/null
echo "   wassell_can_access_file declared COST = $(q "$COSTQ")"

echo
echo "-------- AFTER: COST 10000 --------"
measure after | tee "$WORK/after.txt" | sed 's/^/   /'
echo
echo "-------- plan shape AFTER --------"
plan_shape

echo
echo "-------- verdict --------"
FAILED=0
while read -r line; do
  who=$(awk '{print $3}' <<<"$line")
  b=$(grep " $who " "$WORK/before.txt")
  bfp=$(grep -o "fp=[^ ]*" <<<"$b");     afp=$(grep -o "fp=[^ ]*" <<<"$line")
  bed=$(grep -o "edges=[0-9]*" <<<"$b"); aed=$(grep -o "edges=[0-9]*" <<<"$line")
  if [ "$bfp" != "$afp" ] || [ "$bed" != "$aed" ]; then
    echo "  REACH CHANGED for $who: $bed/$bfp -> $aed/$afp"; FAILED=1; continue
  fi
  bw=$(grep -oE "(lm|role)=[0-9.]+" <<<"$b"    | cut -d= -f2 | sort -g | tail -1)
  aw=$(grep -oE "(lm|role)=[0-9.]+" <<<"$line" | cut -d= -f2 | sort -g | tail -1)
  printf "  %s  %-12s worst facet %10s ms -> %10s ms\n" "$who" "$bed" "$bw" "$aw"
done < "$WORK/after.txt"
[ "$FAILED" -eq 0 ] || { echo "  REACH MOVED - cost hint is not semantics-free here"; exit 1; }

WORST=$(grep -oE "(lm|role)=[0-9.]+" "$WORK/after.txt" | cut -d= -f2 | sort -g | tail -1)
echo
echo "  WORST facet across all personas after the hint: ${WORST} ms  (budget 300)"
if awk "BEGIN{exit !($WORST < 300)}"; then
  echo "  => cost hint is SUFFICIENT on this corpus"
else
  echo "  => cost hint is NOT sufficient; a set-based rewrite is required"
fi
