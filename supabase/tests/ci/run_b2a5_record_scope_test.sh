#!/usr/bin/env bash
# ============================================================================
# Designated validator for
# supabase/migrations/2026-08-19_01_record_scope_fast_path.sql  (Phase 3 · B2A.5)
#
# B2A.5 rewrites `records_view`, the RLS policy that gates every authenticated
# read of every record in the product. That is the highest-blast-radius object
# in this codebase, so the bar is the B2A/B2A.2/B2A.4 bar and then some:
#
#   1. NOBODY may gain a single row — records OR file_links edges. Compared by
#      sorted-id fingerprint, never by count. (Rule 2 of the plan doc: two
#      different row sets of equal size are not equivalent.)
#   2. Nobody may lose one either. B2A.4 could narrow legitimately because it
#      was closing a side door; B2A.5 claims exact equivalence, so a loss is a
#      failure, not an explainable diff.
#   3. Every guard has a mutant that demonstrates the leak it prevents, and
#      every mutant must actually leak. A control that cannot fail is not a
#      control.
#   4. The fixture models the REAL authorization machinery — profiles,
#      model_permissions, view_scope rules, and the actual functions lifted out
#      of supabase/schema.sql — not the GUC stubs the other file_links suites
#      use. B2A.1 reached production because a CI fixture was gentler than
#      production; testing this change against a stubbed records policy would
#      repeat that exactly.
#
# ── ON THE PERFORMANCE GATE ────────────────────────────────────────────────
# Issue #32 records this harness swinging 7,569 -> 3,583 ms for identical code
# between two runners on the same day, and B2's 172.8 ms CI figure being 9-17x
# optimistic against production. So absolute milliseconds are NOT the gate here.
#
# The gate is STRUCTURAL: the hoisted set-returning function must appear in the
# plan with loops=1, i.e. evaluated once per statement rather than once per row.
# That property is what makes the change a speed-up, it is machine-independent,
# and it is the exact thing a careless rewrite (correlated EXISTS instead of
# uncorrelated IN) would silently destroy. Wall-clock numbers are printed as
# information only, clearly labelled.
# ============================================================================
set -euo pipefail

PGURL="${PGURL:-postgresql://postgres:ci@localhost:5432/postgres}"
DB=wassell_b2a5
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
66666666-6666-6666-6666-666666666666
00000000-0000-0000-0000-0000000000ff"

# ── impersonated dumps ─────────────────────────────────────────────────────
# Transaction-local: set the uid GUC, drop to `authenticated` so RLS actually
# applies, read, ROLLBACK. Same shape used against production read-only.
dump() {   # $1 = phase label, $2 = relation kind (records|links)
  local uid short sel
  for uid in $PERSONAS; do
    short="${uid:0:8}"
    case "$2" in
      records) sel="SELECT id::text FROM public.records ORDER BY 1" ;;
      links)   sel="SELECT file_id||'|'||model_id||'|'||record_id FROM public.file_links ORDER BY 1" ;;
      derived) sel="SELECT file_id::text FROM public.wassell_my_record_derived_file_ids() ORDER BY 1" ;;
      *) echo "dump: unknown kind $2" >&2; exit 1 ;;
    esac
    psql "$DBURL" -v ON_ERROR_STOP=1 -tAq > "$WORK/$2.$1.$short" <<SQL
BEGIN;
SET LOCAL statement_timeout='600s';
-- SET LOCAL, not SELECT set_config(): psql would print set_config()’s
-- returned row into the dump file, which makes every persona look
-- non-empty and every fingerprint unique, so both non-vacuity guards
-- below would pass trivially. SET emits nothing.
SET LOCAL test.uid = '$uid';
SET LOCAL ROLE authenticated;
$sel;
ROLLBACK;
SQL
  done
}

fingerprints() {   # $1 = phase label, $2 = kind -> prints "<short> <md5> n=<count>"
  local uid short
  for uid in $PERSONAS; do
    short="${uid:0:8}"
    printf '%s %s n=%s\n' "$short" \
      "$(sort "$WORK/$2.$1.$short" | md5sum | cut -d' ' -f1)" \
      "$(wc -l < "$WORK/$2.$1.$short" | tr -d ' ')"
  done
}

# Fails on ANY gain. Also fails on a loss unless $3 = allow_loss.
compare() {   # $1 before  $2 after  $3 kind  [$4 allow_loss]
  local uid short added removed ta=0 tr=0 rc=0
  for uid in $PERSONAS; do
    short="${uid:0:8}"
    added=$(comm -13 <(sort "$WORK/$3.$1.$short") <(sort "$WORK/$3.$2.$short") | wc -l | tr -d ' ')
    removed=$(comm -23 <(sort "$WORK/$3.$1.$short") <(sort "$WORK/$3.$2.$short") | wc -l | tr -d ' ')
    ta=$((ta+added)); tr=$((tr+removed))
    if [ "$added" -ne 0 ]; then
      echo "   FAIL $short GAINED $added $3 — reach EXPANSION"
      comm -13 <(sort "$WORK/$3.$1.$short") <(sort "$WORK/$3.$2.$short") | head -3 | sed 's/^/        /'
      rc=1
    fi
    if [ "$removed" -ne 0 ] && [ "${4:-}" != allow_loss ]; then
      echo "   FAIL $short LOST $removed $3 — B2A.5 claims exact equivalence"
      rc=1
    fi
  done
  echo "   $3 delta across all personas: +$ta / -$tr"
  return $rc
}

# Returns 0 if the named persona GAINED rows between two phases (mutant leaked).
leaked() {   # $1 before  $2 after  $3 kind  $4 persona-short
  local n
  n=$(comm -13 <(sort "$WORK/$3.$1.$4") <(sort "$WORK/$3.$2.$4") | wc -l | tr -d ' ')
  echo "$n"
}

# ── database + roles ───────────────────────────────────────────────────────
echo "== creating $DB"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB;"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB;"
psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN CREATE ROLE anon NOLOGIN; END IF;
END \$\$;"
q "GRANT USAGE ON SCHEMA public TO authenticated, anon;" >/dev/null

echo "== fixture: world + ~40k records + ~9.9k edges"
run "$ROOT/supabase/tests/ci/fixture_b2a5_record_scope.sql"

# ── the real authorization functions, lifted from schema.sql ───────────────
# Extracted rather than copied so this suite cannot drift from the authority it
# is testing. If schema.sql's definition changes, this suite picks it up on the
# next run instead of quietly validating a stale copy.
echo "== lifting the real authz functions out of supabase/schema.sql"
: > "$WORK/authz.sql"
for fn in wassell_user_has_action wassell_record_passes_scope wassell_can_view_record wassell_view_scope_class; do
  awk -v fn="$fn" '
    index($0, "CREATE OR REPLACE FUNCTION " fn "(") { on=1 }
    on { print }
    on && /\$\$;[[:space:]]*$/ { exit }
  ' "$ROOT/supabase/schema.sql" >> "$WORK/authz.sql"
  echo >> "$WORK/authz.sql"
  if ! grep -q "FUNCTION $fn(" "$WORK/authz.sql"; then
    echo "FAIL: could not extract $fn from supabase/schema.sql — the suite would be testing nothing"; exit 1
  fi
done
run "$WORK/authz.sql"
q "GRANT EXECUTE ON FUNCTION public.wassell_can_view_record(uuid, public.records) TO authenticated;" >/dev/null
q "GRANT EXECUTE ON FUNCTION public.wassell_view_scope_class(uuid, uuid) TO authenticated, anon;" >/dev/null
echo "   extracted $(grep -c 'CREATE OR REPLACE FUNCTION' "$WORK/authz.sql") functions"

echo "== baseline policy (pre-B2A.5) + corpus non-vacuity guards"
psql "$DBURL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/ci/fixture_b2a5_baseline_policy.sql" 2>&1 \
  | grep -E "NOTICE|ERROR" | sed 's/^/   /'
echo "   corpus: $(q "SELECT count(*) FROM public.records") records, $(q "SELECT count(*) FROM public.file_links") edges"

# ── BEFORE ─────────────────────────────────────────────────────────────────
echo
echo "== BEFORE — per-persona row sets"
dump before records; dump before links
fingerprints before records | sed 's/^/   rec  /'
fingerprints before links   | sed 's/^/   link /'

# ── NON-VACUITY ────────────────────────────────────────────────────────────
# The suite is worthless if every persona sees the same thing, and these guards
# are only meaningful if the dumps are clean. The first version of this script
# used `SELECT set_config(...)` to impersonate, whose returned row landed in
# every dump file — so all eight personas measured as non-empty (including the
# three that must see nothing) and every fingerprint was unique because it
# embedded the uid. Both guards below passed trivially. Hence `SET LOCAL` in
# dump(), and hence the explicit expected counts here rather than a threshold.
EXPECT="99999999=40000 11111111=36000 22222222=2400 33333333=500 44444444=0 55555555=0 66666666=19000 00000000=0"
for pair in $EXPECT; do
  who=${pair%%=*}; want=${pair##*=}
  got=$(fingerprints before records | awk -v w="$who" '$1==w {sub(/^n=/,"",$3); print $3}')
  if [ "$got" != "$want" ]; then
    echo "FAIL: persona $who sees $got records, expected $want — the corpus is not the one this suite reasons about"; exit 1
  fi
done

# Three personas MUST see nothing (no view permission / deactivated / no user
# row). They are where a widening shows up first and unambiguously.
ZERO=$(fingerprints before records | awk '$3=="n=0"' | wc -l | tr -d ' ')
[ "$ZERO" -eq 3 ] || { echo "FAIL: expected exactly 3 zero-reach personas, found $ZERO"; exit 1; }

# Distinct non-empty fingerprints: five different row sets, not five copies of
# one. (The three empty personas share the empty-file hash, so they are excluded
# rather than counted as diversity.)
DISTINCT_FP=$(fingerprints before records | awk '$3!="n=0" {print $2}' | sort -u | wc -l | tr -d ' ')
[ "$DISTINCT_FP" -eq 5 ] || { echo "FAIL: $DISTINCT_FP distinct non-empty fingerprints, expected 5 — corpus does not discriminate"; exit 1; }
echo "   OK: 5 distinct non-empty row sets, 3 zero-reach personas, counts as expected"

# ── APPLY ──────────────────────────────────────────────────────────────────
echo
echo "== applying B2A.5"
run "$ROOT/supabase/migrations/2026-08-19_01_record_scope_fast_path.sql"
dump after records; dump after links
echo "   -- records --"
compare before after records || { echo "B2A.5 FAILED the equivalence bar on records"; exit 1; }
echo "   -- file_links (the reader the issue was raised about) --"
compare before after links   || { echo "B2A.5 FAILED the equivalence bar on file_links"; exit 1; }
echo "   OK: every persona's row set is byte-identical, +0 / -0"

# ── STRUCTURAL PERFORMANCE GATE ────────────────────────────────────────────
# The point of the migration is that the hoisted function runs ONCE per
# statement. If a future edit turns the uncorrelated IN into a correlated
# EXISTS, the plan shows loops=<row count> and the change becomes a pessimism.
# This assertion is machine-independent, unlike the millisecond figures below.
echo
echo "== structural gate: the hoisted set is evaluated once, not per row"
psql "$DBURL" -v ON_ERROR_STOP=1 -tAq > "$WORK/plan.txt" <<'SQL'
BEGIN;
SET LOCAL statement_timeout='600s';
-- SET LOCAL, not SELECT set_config(): psql would print set_config()’s
-- returned row into the dump file, which makes every persona look
-- non-empty and every fingerprint unique, so both non-vacuity guards
-- below would pass trivially. SET emits nothing.
SET LOCAL test.uid = '11111111-1111-1111-1111-111111111111';
SET LOCAL ROLE authenticated;
EXPLAIN (ANALYZE, TIMING OFF, COSTS OFF) SELECT count(*) FROM public.file_links;
ROLLBACK;
SQL
grep -E "wassell_my_view_scope_all_models" "$WORK/plan.txt" | sed 's/^/   /' || true
LOOPS=$(grep -oE "wassell_my_view_scope_all_models[^)]*loops=[0-9]+" "$WORK/plan.txt" \
        | grep -oE "loops=[0-9]+" | cut -d= -f2 | sort -rn | head -1)
if [ -z "${LOOPS:-}" ]; then
  echo "   FAIL: the hoisted function does not appear in the plan at all —"
  echo "         either the policy is not being applied or the fast path was optimised away."
  sed 's/^/        /' "$WORK/plan.txt"; exit 1
fi
if [ "$LOOPS" -ne 1 ]; then
  echo "   FAIL: hoisted function ran loops=$LOOPS — it is being re-evaluated per row."
  echo "         The IN (SELECT ...) has become correlated; see the migration header."
  exit 1
fi
echo "   OK: loops=1 — hoisted to a single evaluation per statement"

# ── SMOKE ──────────────────────────────────────────────────────────────────
echo
echo "== smoke"
psql "$DBURL" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/ci/smoke_b2a5_record_scope.sql" 2>&1 \
  | grep -E "NOTICE|ERROR" | sed 's/^/   /'

# ── NEGATIVE CONTROLS ──────────────────────────────────────────────────────
# Each mutant breaks exactly one guard and must widen exactly the persona that
# guard protects. Restoring the real function afterwards must return to the
# post-migration baseline, which also proves the mutant was the only difference.
echo
echo "== negative controls"
mutant() {   # $1 = file, $2 = persona-short, $3 = description
  run "$ROOT/supabase/tests/ci/$1"
  dump mut records
  local gained; gained=$(leaked after mut records "$2")
  if [ "$gained" -eq 0 ]; then
    echo "   FAIL $1: persona $2 gained NOTHING — that guard is not tested"; exit 1
  fi
  echo "   OK   $1: persona $2 gained $gained record(s) — $3"
  run "$ROOT/supabase/migrations/2026-08-19_01_record_scope_fast_path.sql"
  dump restored records
  if ! diff -q <(sort "$WORK/records.after.$2") <(sort "$WORK/records.restored.$2") >/dev/null; then
    echo "   FAIL $1: restoring did not return persona $2 to baseline"; exit 1
  fi
}
mutant mutant_b2a5_filtered_as_all.sql     22222222 "a per-record filter treated as unrestricted leaks"
mutant mutant_b2a5_filtered_as_all.sql     66666666 "the data-field filter leaks too"
mutant mutant_b2a5_drop_view_permission.sql 44444444 "edit-without-view leaks when the permission check is dropped"
mutant mutant_b2a5_ignore_inactive.sql      55555555 "a deactivated account leaks when is_active is ignored"

# Full restore check across every persona, not just the four targeted above.
dump restored records; dump restored links
compare after restored records || { echo "FAIL: restore diverged on records"; exit 1; }
compare after restored links   || { echo "FAIL: restore diverged on file_links"; exit 1; }
echo "   OK: all mutants leaked, all restores returned to baseline"

# ── ROLLBACK / RE-APPLY ────────────────────────────────────────────────────
echo
echo "== rollback + re-apply"
run "$ROOT/supabase/rollback/2026-08-19_01_record_scope_fast_path_down.sql"
dump rb records; dump rb links
compare before rb records || { echo "FAIL: rollback did not restore the pre-migration state"; exit 1; }
compare before rb links   || { echo "FAIL: rollback did not restore the pre-migration state"; exit 1; }
if q "SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='wassell_my_view_scope_all_models'" | grep -q 1; then
  echo "FAIL: rollback left the helper installed"; exit 1
fi
run "$ROOT/supabase/migrations/2026-08-19_01_record_scope_fast_path.sql"
dump re records; dump re links
compare after re records || { echo "FAIL: re-apply did not return to the post-migration state"; exit 1; }
compare after re links   || { echo "FAIL: re-apply did not return to the post-migration state"; exit 1; }
echo "   OK: rollback and re-application both preserve every row set"

# ── INFORMATIONAL TIMINGS ──────────────────────────────────────────────────
# Recorded, not gated. See the header: this harness has been observed swinging
# 2x between runners for identical code, so a millisecond threshold here would
# be a coin flip, and the structural gate above is what actually protects the
# property. Production before/after belongs in the PR description.
echo
echo "== timings (INFORMATIONAL — not a gate)"
timeit() {  # $1 = uid, $2 = label
  # Timed inside plpgsql, not with a LATERAL clock_timestamp() trick: the
  # planner is free to evaluate the outer clock_timestamp() before the lateral
  # finishes, which is why the first version of this reported a flat 0.0 ms.
  psql "$DBURL" -v ON_ERROR_STOP=1 -tAq <<SQL | grep -E "^T "
CREATE TEMP TABLE IF NOT EXISTS _t(ms numeric); TRUNCATE _t;
GRANT INSERT ON _t TO authenticated;
BEGIN;
SET LOCAL statement_timeout='600s';
SET LOCAL test.uid = '$1';
SET LOCAL ROLE authenticated;
DO \$\$
DECLARE t0 timestamptz; n bigint;
BEGIN
  t0 := clock_timestamp();
  SELECT count(*) INTO n FROM public.file_links;
  INSERT INTO _t VALUES (EXTRACT(epoch FROM clock_timestamp()-t0)*1000);
END \$\$;
RESET ROLE;
SELECT 'T $2 ' || round(ms,1) || ' ms' FROM _t;
ROLLBACK;
SQL
}
for uid in 99999999-9999-9999-9999-999999999999 11111111-1111-1111-1111-111111111111 22222222-2222-2222-2222-222222222222; do
  timeit "$uid" "${uid:0:8}" | sed 's/^/   /'
done

# ═══════════════════════════════════════════════════════════════════════════
# B2A.6 — the SECOND caller of wassell_can_view_record
#
# B2A.5 hoisted the scope class into the records_view POLICY. B4's
# wassell_my_record_derived_file_ids() calls wassell_can_view_record DIRECTLY,
# so it got none of that — and both files_select and file_links_select invoke it
# once per statement. Same lemma, different call site, so it is validated here
# rather than in a suite of its own.
# ═══════════════════════════════════════════════════════════════════════════
echo
echo "== B2A.6: B4's record-derived call site"
# Not piped straight into grep: with `set -o pipefail` a grep that matches
# nothing would abort the run, and `|| true` would swallow psql's own failure.
psql "$DBURL" -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/tests/ci/fixture_b2a6_derived_access.sql" \
  > "$WORK/b2a6_fixture.log" 2>&1
grep -E "NOTICE|ERROR" "$WORK/b2a6_fixture.log" | sed 's/^/   /' || true

dump d_before derived
fingerprints d_before derived | sed 's/^/   derived /'

# Same non-vacuity bar as the record sets: the personas must differ here too,
# or B2A.6 is being validated against a corpus that cannot show a change.
D_DISTINCT=$(fingerprints d_before derived | awk '$3!="n=0" {print $2}' | sort -u | wc -l | tr -d ' ')
[ "$D_DISTINCT" -ge 3 ] || { echo "FAIL: only $D_DISTINCT distinct non-empty derived sets — call site does not discriminate"; exit 1; }

echo "   applying B2A.6"
run "$ROOT/supabase/migrations/2026-08-19_02_derived_file_ids_fast_path.sql"
dump d_after derived
compare d_before d_after derived || { echo "B2A.6 FAILED the equivalence bar"; exit 1; }
echo "   OK: derived file-id set byte-identical for every persona, +0 / -0"

# The kill switch must still kill. A B4 toggle that no longer disables the
# feature is worse than a slow one.
echo "   kill switch:"
q "UPDATE public.file_access_settings SET derived_view_enabled = false;" >/dev/null
dump d_off derived
OFFTOTAL=$(fingerprints d_off derived | awk '{sub(/^n=/,"",$3); s+=$3} END {print s+0}')
[ "$OFFTOTAL" -eq 0 ] || { echo "   FAIL: derived_view_enabled=false still yields $OFFTOTAL file ids"; exit 1; }
q "UPDATE public.file_access_settings SET derived_view_enabled = true;" >/dev/null
dump d_back derived
compare d_after d_back derived || { echo "   FAIL: re-enabling did not restore the derived sets"; exit 1; }
echo "   OK: OFF yields nothing for every persona; ON restores exactly"

# Negative controls. The first must WIDEN (orphan edges leak), the second must
# NARROW (NOT IN against a NULL-bearing set yields nothing) — so this pair
# cannot be satisfied by a mutant that simply does nothing.
echo "   negative controls:"
run "$ROOT/supabase/tests/ci/mutant_b2a6_branch1_skips_existence.sql"
dump d_mut1 derived
W=0
for uid in $PERSONAS; do
  s="${uid:0:8}"
  n=$(comm -13 <(sort "$WORK/derived.d_after.$s") <(sort "$WORK/derived.d_mut1.$s") | wc -l | tr -d ' ')
  W=$((W+n))
done
[ "$W" -gt 0 ] || { echo "   FAIL: dropping branch 1's existence join leaked nothing — orphan edges untested"; exit 1; }
echo "   OK   branch1_skips_existence: $W orphan file id(s) leaked"
run "$ROOT/supabase/migrations/2026-08-19_02_derived_file_ids_fast_path.sql"

run "$ROOT/supabase/tests/ci/mutant_b2a6_null_in_allm.sql"
dump d_mut2 derived
N=0
for uid in $PERSONAS; do
  s="${uid:0:8}"
  n=$(comm -23 <(sort "$WORK/derived.d_after.$s") <(sort "$WORK/derived.d_mut2.$s") | wc -l | tr -d ' ')
  N=$((N+n))
done
[ "$N" -gt 0 ] || { echo "   FAIL: a NULL in the hoisted set changed nothing — the IS NOT NULL guard is untested"; exit 1; }
echo "   OK   null_in_allm: $N file id(s) silently LOST — the guard is load-bearing"
run "$ROOT/supabase/migrations/2026-08-19_02_derived_file_ids_fast_path.sql"
dump d_restored derived
compare d_after d_restored derived || { echo "   FAIL: restore after mutants diverged"; exit 1; }

echo "   rollback + re-apply:"
run "$ROOT/supabase/rollback/2026-08-19_02_derived_file_ids_fast_path_down.sql"
dump d_rb derived
compare d_before d_rb derived || { echo "   FAIL: B2A.6 rollback did not restore the pre-migration derived sets"; exit 1; }
run "$ROOT/supabase/migrations/2026-08-19_02_derived_file_ids_fast_path.sql"
dump d_re derived
compare d_after d_re derived || { echo "   FAIL: B2A.6 re-apply did not return to the post-migration state"; exit 1; }
echo "   OK: rollback and re-application both preserve every derived set"

echo
echo "B2A.5 + B2A.6 record scope fast path: ALL CHECKS PASSED"
