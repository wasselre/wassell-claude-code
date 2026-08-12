#!/usr/bin/env bash
# ============================================================================
# Phase 2 performance measurement.
#
# Reports p50 / p95 / worst per scenario, for a database WITHOUT the sync
# triggers and the SAME database WITH them, at production-like scale.
# Averages are deliberately NOT the headline: a save path that is usually fast
# and occasionally terrible is still a bad save path, so the worst case is
# printed for every scenario.
#
# Each measured statement runs in its OWN transaction (psql autocommit), so the
# deferred drain is INSIDE the measurement. Timing comes from psql's own
# \timing, one connection per run, so process spawn cost is excluded.
#
# Usage: PGURL=postgresql://... bash supabase/tests/ci/bench_file_link_sync.sh
#        (or PGHOST/PGPORT/PGUSER for a local socket)
# ============================================================================
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PGURL="${PGURL:-}"; ADMIN_DB="${ADMIN_DB:-postgres}"
UNITS=${UNITS:-8000}          # unit records, one scalar file reference each
PROJECTS=${PROJECTS:-1200}    # project records, 5-element image arrays
FILES=${FILES:-600}
ITERS=${ITERS:-200}

psql_admin(){ if [ -n "$PGURL" ]; then psql "${PGURL%/*}/$ADMIN_DB" "$@"; else psql -d "$ADMIN_DB" "$@"; fi; }
psql_on(){ local db=$1; shift; if [ -n "$PGURL" ]; then psql "${PGURL%/*}/$db" "$@"; else psql -d "$db" "$@"; fi; }

# Build the two templates ONCE. Cloning from a template is a file copy, so each
# scenario still starts from an identical pristine database without paying for
# the seed (and, more importantly, without re-running resync_all 22 times).
clone() {  # $1 = template, $2 = target
  psql_admin -q -c "DROP DATABASE IF EXISTS $2 (FORCE);" >/dev/null 2>&1
  psql_admin -q -c "CREATE DATABASE $2 TEMPLATE $1;" >/dev/null
}

seed() {  # $1 = dbname, $2 = "sync" | "baseline"
  local db=$1
  psql_admin -q -c "DROP DATABASE IF EXISTS $db (FORCE);" >/dev/null 2>&1
  psql_admin -q -c "CREATE DATABASE $db;" >/dev/null
  psql_on "$db" -q -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/ci/fixture_file_links.sql" >/dev/null
  psql_on "$db" -q -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/2026-08-10_file_links_projection.sql" >/dev/null 2>&1
  psql_on "$db" -q -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/2026-08-12_file_link_sync.sql" >/dev/null 2>&1

  # Seed BEFORE deciding on triggers, and always with them off, so both
  # databases are seeded identically and the seed cost is not measured.
  psql_on "$db" -q -c "ALTER TABLE public.records DISABLE TRIGGER records_sync_file_links;" >/dev/null
  psql_on "$db" -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
INSERT INTO public.files (id, original_name)
SELECT ('f1000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid, 'seed'||i||'.jpg'
  FROM generate_series(1,$FILES) i;

INSERT INTO public.records (id, model_id, data)
SELECT ('a1000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,
       '11111111-0000-0000-0000-000000000001',
       jsonb_build_object('unit_plan', 'f1000000-0000-0000-0000-'||lpad(((i % $FILES)+1)::text,12,'0'),
                          'note', 'row '||i)
  FROM generate_series(1,$UNITS) i;

INSERT INTO public.records (id, model_id, data)
SELECT ('a2000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,
       '11111111-0000-0000-0000-000000000002',
       jsonb_build_object(
         'project_images', (SELECT jsonb_agg('f1000000-0000-0000-0000-'||lpad((((i+k) % $FILES)+1)::text,12,'0'))
                              FROM generate_series(0,4) k),
         'main_image', 'f1000000-0000-0000-0000-'||lpad(((i % $FILES)+1)::text,12,'0'),
         'note', 'project '||i)
  FROM generate_series(1,$PROJECTS) i;
SQL
  psql_on "$db" -q -c "ALTER TABLE public.records ENABLE TRIGGER records_sync_file_links;" >/dev/null
  psql_on "$db" -q -c "SELECT public.file_links_resync_all();" >/dev/null
  psql_on "$db" -q -c "VACUUM ANALYZE;" >/dev/null

  if [ "$2" = "baseline" ]; then
    psql_on "$db" -q >/dev/null <<'SQL'
DROP TRIGGER IF EXISTS records_sync_file_links        ON public.records;
DROP TRIGGER IF EXISTS files_sync_file_links          ON public.files;
DROP TRIGGER IF EXISTS document_links_sync_file_links ON public.document_links;
DROP TRIGGER IF EXISTS mos_assets_sync_file_links     ON public.mos_assets;
SQL
  fi
}

# Build one scenario's statement list. $1 = scenario key, prints SQL to stdout.
gen() {
  local k=$1 i
  echo '\timing on'
  case $k in
    noop_rewrite) # rewriting IDENTICAL data must cost nothing (the cheapest exit)
      for i in $(seq 1 $ITERS); do
        echo "UPDATE public.records SET data = data WHERE id='a1000000-0000-0000-0000-$(printf %012d $i)';"
      done ;;
    irrelevant)   # a NON file-bearing field changes; the trigger must exit cheap
      for i in $(seq 1 $ITERS); do
        echo "UPDATE public.records SET data = jsonb_set(data,'{note}','\"n$i\"') WHERE id='a1000000-0000-0000-0000-$(printf %012d $i)';"
      done ;;
    scalar_repoint)  # the seed set unit_plan=(i%600)+1; offset so the value REALLY changes
      for i in $(seq 1 $ITERS); do
        echo "UPDATE public.records SET data = jsonb_set(data,'{unit_plan}','\"f1000000-0000-0000-0000-$(printf %012d $(( ((i + 300) % 600) + 1 )))\"') WHERE id='a1000000-0000-0000-0000-$(printf %012d $i)';"
      done ;;
    scalar_remove)
      for i in $(seq 1 $ITERS); do
        echo "UPDATE public.records SET data = data - 'unit_plan' WHERE id='a1000000-0000-0000-0000-$(printf %012d $i)';"
      done ;;
    scalar_add)   # remove first, so the measured statement really ADDS a reference
      for i in $(seq 1 $ITERS); do
        echo "UPDATE public.records SET data = data - 'unit_plan' WHERE id='a1000000-0000-0000-0000-$(printf %012d $i)';"
        echo "\\timing off"
        echo "\\timing on"
        echo "UPDATE public.records SET data = jsonb_set(data,'{unit_plan}','\"f1000000-0000-0000-0000-$(printf %012d $(( (i % 500) + 1 )))\"') WHERE id='a1000000-0000-0000-0000-$(printf %012d $i)';"
      done ;;
    array_small)  # reorder a 5-element array
      for i in $(seq 1 $ITERS); do
        echo "UPDATE public.records SET data = jsonb_set(data,'{project_images}', (SELECT jsonb_agg(v ORDER BY ord DESC) FROM jsonb_array_elements(data->'project_images') WITH ORDINALITY t(v,ord))) WHERE id='a2000000-0000-0000-0000-$(printf %012d $i)';"
      done ;;
    array_large)  # swap a 5-element array for a 60-element one
      for i in $(seq 1 $ITERS); do
        echo "UPDATE public.records SET data = jsonb_set(data,'{project_images}', (SELECT jsonb_agg('f1000000-0000-0000-0000-'||lpad((((k+$i) % 500)+1)::text,12,'0')) FROM generate_series(1,60) k)) WHERE id='a2000000-0000-0000-0000-$(printf %012d $i)';"
      done ;;
    files_attach)
      for i in $(seq 1 $ITERS); do
        echo "UPDATE public.files SET model_id='11111111-0000-0000-0000-000000000001', record_id='a1000000-0000-0000-0000-$(printf %012d $i)' WHERE id='f1000000-0000-0000-0000-$(printf %012d $(( (i % 500) + 1 )))';"
      done ;;
    doclinks)
      for i in $(seq 1 $ITERS); do
        echo "INSERT INTO public.document_links (file_id, model_id, record_id) VALUES ('f1000000-0000-0000-0000-$(printf %012d $(( (i % 500) + 1 )))','11111111-0000-0000-0000-000000000001','a1000000-0000-0000-0000-$(printf %012d $i)') ON CONFLICT DO NOTHING;"
      done ;;
    mosassets)
      for i in $(seq 1 $ITERS); do
        echo "INSERT INTO public.mos_assets (id, title, file_id, project_id) VALUES ('b1000000-0000-0000-0000-$(printf %012d $i)','a','f1000000-0000-0000-0000-$(printf %012d $(( (i % 500) + 1 )))','a2000000-0000-0000-0000-$(printf %012d $(( (i % 1200) + 1 )))');"
      done ;;
    bulk_insert) # ONE statement inserting 2000 rows, repeated 5 times
      for i in 1 2 3 4 5; do
        echo "INSERT INTO public.records (id, model_id, data) SELECT ('a3$(printf %d $i)00000-0000-0000-0000-'||lpad(k::text,12,'0'))::uuid,'11111111-0000-0000-0000-000000000001', jsonb_build_object('unit_plan','f1000000-0000-0000-0000-'||lpad(((k % 500)+1)::text,12,'0')) FROM generate_series(1,2000) k;"
      done ;;
    bulk_update) # ONE statement updating 2000 rows, repeated 5 times
      for i in 1 2 3 4 5; do
        echo "UPDATE public.records SET data = jsonb_set(data,'{unit_plan}','\"f1000000-0000-0000-0000-$(printf %012d $i)\"') WHERE id IN (SELECT id FROM public.records WHERE model_id='11111111-0000-0000-0000-000000000001' ORDER BY id LIMIT 2000);"
      done ;;
  esac
}

# Run one scenario against one database, print "p50 p95 max n"
run() {
  local db=$1 k=$2
  gen "$k" > "$TMP/$k.sql"
  psql_on "$db" -X -q -f "$TMP/$k.sql" 2>/dev/null \
    | grep -oP '^Time: \K[0-9.]+' \
    | sort -g \
    | awk '{a[NR]=$1} END {
        if (NR==0) { print "NA NA NA 0"; exit }
        p50=a[int(NR*0.50)+((NR*0.50)==int(NR*0.50)?0:1)];
        p95=a[int(NR*0.95)+((NR*0.95)==int(NR*0.95)?0:1)];
        printf "%.3f %.3f %.3f %d\n", p50, p95, a[NR], NR }'
}

SCENARIOS="noop_rewrite irrelevant scalar_add scalar_repoint scalar_remove array_small array_large files_attach doclinks mosassets bulk_insert bulk_update"

echo "=================================================================================="
echo "Phase 2 performance — $UNITS unit records, $PROJECTS project records, $FILES files"
echo "=================================================================================="
seed bench_base baseline
seed bench_sync sync
EDGES=$(psql_on bench_sync -Atc "SELECT count(*) FROM public.file_links;")
SRCS=$(psql_on bench_sync -Atc "SELECT count(*) FROM public.file_link_sources;")
echo "projection under test: $EDGES edges / $SRCS sources"
echo
printf '%-16s %26s %26s %10s\n' "scenario" "baseline p50/p95/worst ms" "with sync p50/p95/worst ms" "p50 delta"
printf '%-16s %26s %26s %10s\n' "----------------" "--------------------------" "--------------------------" "----------"

for k in $SCENARIOS; do
  # fresh clones per scenario so mutations do not bleed between them
  clone bench_base bench_base_run
  clone bench_sync bench_sync_run
  read -r B50 B95 BMAX BN <<<"$(run bench_base_run "$k")"
  read -r S50 S95 SMAX SN <<<"$(run bench_sync_run "$k")"
  DELTA=$(awk -v b="$B50" -v s="$S50" 'BEGIN{ if (b+0==0) printf "n/a"; else printf "%+.0f%%", (s-b)/b*100 }')
  ABS=$(awk -v b="$B50" -v s="$S50" 'BEGIN{ printf "%+.3fms", s-b }')
  printf '%-16s %26s %26s %10s  (%s, n=%s)\n' \
    "$k" "$B50/$B95/$BMAX" "$S50/$S95/$SMAX" "$DELTA" "$ABS" "$SN"
done

echo
echo "---- whole-graph convergence (the rollout's first step) --------------------------"
psql_on bench_sync_run -X -c "\\timing on" -c "SELECT * FROM public.file_links_resync_all();" 2>&1 | grep -E "targets_converged|semantic_edges|source_occ|Time:"

echo
echo "---- lock contention during the hot path -----------------------------------------"
psql_on bench_sync_run -X -c "SELECT locktype, mode, count(*) FROM pg_locks WHERE locktype='advisory' GROUP BY 1,2;"
echo "(advisory locks are transaction-scoped; a steady-state count of 0 means none leak)"

echo
echo "---- query plan: the records trigger's relevance test -----------------------------"
psql_on bench_sync_run -X -c "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT EXISTS (
  SELECT 1 FROM public.models m,
       LATERAL jsonb_array_elements(m.schema->'sections') sec,
       LATERAL jsonb_array_elements(sec->'fields') fld
   WHERE m.id = '11111111-0000-0000-0000-000000000001'
     AND m.is_hardcoded IS NOT TRUE
     AND fld->>'type' = ANY (public.file_link_candidate_types()));"

echo "---- query plan: convergence step 3 (the stale-source prune) ----------------------"
psql_on bench_sync_run -X -c "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
DELETE FROM public.file_link_sources s USING public.file_links l
 WHERE s.link_id = l.id
   AND l.model_id='11111111-0000-0000-0000-000000000001'
   AND l.record_id='a1000000-0000-0000-0000-000000000001'
   AND NOT EXISTS (SELECT 1 FROM public.file_link_live_sources_scoped(
         '11111111-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001') d
        WHERE d.source_key = s.source_key);"

for d in bench_base bench_sync bench_base_run bench_sync_run; do
  psql_admin -q -c "DROP DATABASE IF EXISTS $d (FORCE);" >/dev/null 2>&1
done
