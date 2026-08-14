#!/usr/bin/env bash
# ============================================================================
# Phase 2 concurrency evidence — TWO REAL CONCURRENT POSTGRES SESSIONS.
#
# Single-session simulation cannot test any of this. Every hazard below is a
# property of two transactions holding two different snapshots at the same
# instant, so each test drives two independent psql backends through a
# controlled interleaving and asserts on the committed result.
#
# Convergence runs from a DEFERRED constraint trigger, so the contended work
# happens during COMMIT, not during the UPDATE. Every test therefore issues both
# COMMITs without waiting in between, so the two drains genuinely overlap.
#
# The decisive test is C2. It is run TWICE: once against the real migration and
# once against a mutant with the advisory locks removed from the drain. If the
# mutant does not corrupt the projection, the test is not exercising the hazard
# and the "safe" result means nothing.
#
# C4b is the regression test for the defect that killed the first design: an
# IMMEDIATE per-target advisory lock deadlocked 11 runs out of 12 here, because
# transaction-scoped locks accumulate across statements in data-dependent order.
#
# Usage:  PGURL=postgresql://... bash supabase/tests/ci/concurrency_file_link_sync.sh
#         (or set PGHOST/PGPORT/PGUSER for a local socket)
# ============================================================================
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PGURL="${PGURL:-}"
ADMIN_DB="${ADMIN_DB:-postgres}"
DBNAME="flsync_conc"

psql_admin() { if [ -n "$PGURL" ]; then psql "${PGURL%/*}/$ADMIN_DB" "$@"; else psql -d "$ADMIN_DB" "$@"; fi; }
dburl()      { if [ -n "$PGURL" ]; then echo "${PGURL%/*}/$DBNAME"; else echo "$DBNAME"; fi; }
psql_db()    { if [ -n "$PGURL" ]; then psql "$(dburl)" "$@"; else psql -d "$DBNAME" "$@"; fi; }

FAILURES=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES+1)); }
info() { printf '        %s\n' "$1"; }

# --- rebuild a pristine database -------------------------------------------
# $1 (optional) = extra SQL applied after Phase 2, used to install a mutant.
rebuild() {
  psql_admin -q -c "DROP DATABASE IF EXISTS $DBNAME (FORCE);" >/dev/null 2>&1
  psql_admin -q -c "CREATE DATABASE $DBNAME;" >/dev/null
  psql_db -q -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/ci/fixture_file_links.sql" >/dev/null
  psql_db -q -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/2026-08-10_file_links_projection.sql" >/dev/null 2>&1
  psql_db -q -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/2026-08-12_file_link_sync.sql" >/dev/null 2>&1
  if [ -n "${1:-}" ]; then psql_db -q -v ON_ERROR_STOP=1 -f "$1" >/dev/null; fi
  psql_db -q -c "SELECT public.file_links_resync_all();" >/dev/null
}

# --- two long-lived interactive sessions over FIFOs -------------------------
open_sessions() {
  rm -f "$TMP/s1.in" "$TMP/s2.in"; mkfifo "$TMP/s1.in" "$TMP/s2.in"
  : > "$TMP/s1.out"; : > "$TMP/s2.out"
  if [ -n "$PGURL" ]; then
    psql "$(dburl)" -X -q -At < "$TMP/s1.in" >> "$TMP/s1.out" 2>&1 & S1PID=$!
    psql "$(dburl)" -X -q -At < "$TMP/s2.in" >> "$TMP/s2.out" 2>&1 & S2PID=$!
  else
    psql -d "$DBNAME" -X -q -At < "$TMP/s1.in" >> "$TMP/s1.out" 2>&1 & S1PID=$!
    psql -d "$DBNAME" -X -q -At < "$TMP/s2.in" >> "$TMP/s2.out" 2>&1 & S2PID=$!
  fi
  exec 3>"$TMP/s1.in"; exec 4>"$TMP/s2.in"
  MARK=0
  send 1 "SELECT 'BE1='||pg_backend_pid();"; sync_on 1
  send 2 "SELECT 'BE2='||pg_backend_pid();"; sync_on 2
  BE1=$(grep -o 'BE1=[0-9]*' "$TMP/s1.out" | tail -1 | cut -d= -f2)
  BE2=$(grep -o 'BE2=[0-9]*' "$TMP/s2.out" | tail -1 | cut -d= -f2)
}
close_sessions() {
  send 1 '\q' ; send 2 '\q'
  exec 3>&- ; exec 4>&-
  wait "$S1PID" 2>/dev/null; wait "$S2PID" 2>/dev/null
}

send()    { local n=$1; shift; if [ "$n" = 1 ]; then printf '%s\n' "$*" >&3; else printf '%s\n' "$*" >&4; fi; }
# Commit BOTH sessions without waiting in between, so the two deferred drains
# overlap. Waiting for session 1 first would serialise them and test nothing.
commit_both() { send 1 "COMMIT;"; send 2 "COMMIT;"; sync_on 1; sync_on 2; }
# fire a statement and block until that session has finished it
sync_on() {
  local n=$1; MARK=$((MARK+1)); local m="@@M$MARK"
  send "$n" "SELECT '$m';"
  local i=0
  while ! grep -qx "$m" "$TMP/s$n.out"; do
    sleep 0.02; i=$((i+1))
    if [ $i -gt 1500 ]; then echo "TIMEOUT waiting for session $n"; return 1; fi
  done
}
# is a backend currently waiting on a lock?
is_blocked() {
  local be=$1
  [ "$(psql_db -Atc "SELECT count(*) FROM pg_stat_activity WHERE pid=$be AND wait_event_type='Lock';")" = "1" ]
}
wait_until_blocked() {
  local be=$1 i=0
  while ! is_blocked "$be"; do sleep 0.02; i=$((i+1)); [ $i -gt 400 ] && return 1; done
}
drift() { psql_db -Atc "SELECT coalesce(sum(value),0) FROM public.file_links_reconcile() WHERE category IN ('missing_source','stale_source','missing_edge','orphan_edge','drift');"; }

# Shared scenario helper: file A on unit f11 is proven by BOTH a field
# (unit_plan → floor_plan) and the legacy attachment pair. One edge, two
# sources, two different tables — the shape the read-then-delete race needs.
FILE_A=f0000000-0000-0000-0000-00000000000a
UNIT_M=11111111-0000-0000-0000-000000000001
REC_11=a0000000-0000-0000-0000-000000000f11
REC_12=a0000000-0000-0000-0000-000000000f12
REC_13=a0000000-0000-0000-0000-000000000f13

echo "=============================================================="
echo "Phase 2 concurrency — two real concurrent PostgreSQL sessions"
echo "=============================================================="

# ── C1 ── two concurrent writers on the SAME target ────────────────────────
echo
echo "C1  concurrent field edits on the same record"
rebuild; open_sessions
send 1 "BEGIN;"; sync_on 1
send 2 "BEGIN;"; sync_on 2
send 1 "UPDATE public.records SET data='{\"unit_plan\":\"f0000000-0000-0000-0000-00000000000d\"}' WHERE id='$REC_12';"; sync_on 1
# S2 targets the same ROW, so it must block on the row lock, not corrupt anything
send 2 "UPDATE public.records SET data='{\"unit_plan\":\"f0000000-0000-0000-0000-00000000000e\"}' WHERE id='$REC_12';"
if wait_until_blocked "$BE2"; then pass "session 2 blocked instead of racing"; else fail "session 2 never blocked"; fi
send 1 "COMMIT;"; sync_on 1
sync_on 2
send 2 "COMMIT;"; sync_on 2
close_sessions
D=$(drift)
[ "$D" = "0" ] && pass "converged after both committed (drift=0)" || fail "drift=$D after concurrent same-target edits"
N=$(psql_db -Atc "SELECT count(*) FROM public.file_links WHERE record_id='$REC_12';")
W=$(psql_db -Atc "SELECT file_id FROM public.file_links WHERE record_id='$REC_12';")
{ [ "$N" = "1" ] && [ "$W" = "f0000000-0000-0000-0000-00000000000e" ]; } \
  && pass "projection matches the winning write, not the losing one" \
  || fail "expected 1 edge to ...00e, got $N edge(s) -> $W"

# ── C2 ── THE RACE: two sessions each remove a DIFFERENT source of the SAME edge
# Each sees the other's source still alive in its own snapshot. Both drains then
# race on the same projection rows.
#
# Measured failure mode WITHOUT the locks (captured on PG 16.13): the two drains
# deadlock on row locks inside file_link_sources —
#     ERROR: deadlock detected
#     CONTEXT: while deleting tuple (0,1) in relation "file_link_sources"
#              ... file_links_converge_target ... file_links_drain_dirty
# and one session's ENTIRE transaction aborts, losing a legitimate user edit.
# That is the cost the advisory lock removes: with it, the second drain simply
# queues behind the first instead of colliding in an arbitrary order.
run_c2() {   # $1 = label, $2 = optional mutant file
  rebuild "${2:-}"
  open_sessions
  send 1 "BEGIN;"; sync_on 1
  send 2 "BEGIN;"; sync_on 2
  # S1 removes the FIELD source
  send 1 "UPDATE public.records SET data='{}' WHERE id='$REC_11';"; sync_on 1
  # S2 removes the ATTACHMENT source (a different table, a different row)
  send 2 "UPDATE public.files SET model_id=NULL, record_id=NULL WHERE id='$FILE_A';"
  sync_on 2
  commit_both          # both drains run at the same time — the real race window
  close_sessions
  ORPH=$(psql_db -Atc "SELECT count(*) FROM public.file_links l WHERE NOT EXISTS (SELECT 1 FROM public.file_link_sources s WHERE s.link_id=l.id);")
  SURV=$(psql_db -Atc "SELECT count(*) FROM public.file_links WHERE file_id='$FILE_A' AND record_id='$REC_11';")
  D=$(drift)
  ERRS=$(cat "$TMP/s1.out" "$TMP/s2.out" | grep -ci 'ERROR')
  # did BOTH writers' intent actually survive?
  LOST=$(psql_db -Atc "SELECT count(*) FROM public.records WHERE id='$REC_11' AND data ? 'unit_plan';")
  LOST2=$(psql_db -Atc "SELECT count(*) FROM public.files WHERE id='$FILE_A' AND record_id IS NOT NULL;")
  echo "      $1: aborted_txns=$ERRS lost_writes=$((LOST+LOST2)) unproven_edges=$ORPH surviving_edge=$SURV drift=$D"
}

echo
echo "C2  concurrent removal of two different sources of ONE edge"
run_c2 "with the advisory lock"
{ [ "$ERRS" = "0" ] && [ "$((LOST+LOST2))" = "0" ] && [ "$ORPH" = "0" ] && [ "$SURV" = "0" ] && [ "$D" = "0" ]; } \
  && pass "both writes committed, the edge was removed exactly once, drift=0" \
  || fail "race not handled (errors=$ERRS lost=$((LOST+LOST2)) orphans=$ORPH surviving=$SURV drift=$D)"

# The same interleaving with the locks removed from the drain. If this does NOT
# fail, the test is not reaching the hazard and C2's pass above proves nothing.
cat > "$TMP/nolock.sql" <<'SQL'
-- MUTANT: the drain still converges every dirty target, but takes no locks.
CREATE OR REPLACE FUNCTION public.file_links_drain_dirty()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_xid xid8 := pg_current_xact_id(); v_n int; r record;
BEGIN
  SELECT count(*) INTO v_n FROM public.file_link_dirty_targets WHERE xid = v_xid;
  IF v_n = 0 THEN RETURN 0; END IF;
  FOR r IN SELECT d.model_id, d.record_id FROM public.file_link_dirty_targets d WHERE d.xid = v_xid
  LOOP PERFORM public.file_links_converge_target(r.model_id, r.record_id); END LOOP;
  DELETE FROM public.file_link_dirty_targets WHERE xid = v_xid;
  RETURN v_n;
END; $$;
SQL
run_c2 "WITHOUT the advisory lock (mutant)" "$TMP/nolock.sql"
{ [ "$ERRS" != "0" ] || [ "$((LOST+LOST2))" != "0" ] || [ "$ORPH" != "0" ] || [ "$D" != "0" ]; } \
  && pass "the unlocked mutant DOES fail here — C2 exercises the real hazard" \
  || fail "the unlocked mutant survived; C2 is not reaching the race"

# ── C3 ── different targets must not serialise ─────────────────────────────
echo
echo "C3  concurrent writes to two DIFFERENT targets"
rebuild; open_sessions
send 1 "BEGIN;"; sync_on 1
send 2 "BEGIN;"; sync_on 2
send 1 "UPDATE public.records SET data='{\"unit_plan\":\"f0000000-0000-0000-0000-00000000000d\"}' WHERE id='$REC_12';"; sync_on 1
send 2 "UPDATE public.records SET data='{\"unit_plan\":\"f0000000-0000-0000-0000-00000000000e\"}' WHERE id='$REC_13';"; sync_on 2
# session 1 stays open holding its own uncommitted target; session 2 must be
# able to COMMIT — and therefore run its whole drain — without waiting for it.
START=$(date +%s%N)
send 2 "COMMIT;"
if sync_on 2; then
  MS=$(( ($(date +%s%N) - START) / 1000000 ))
  pass "session 2 committed and drained in ${MS}ms while session 1 held an unrelated target open"
else
  fail "session 2 blocked behind an unrelated target"
fi
send 1 "COMMIT;"; sync_on 1
close_sessions
D=$(drift); [ "$D" = "0" ] && pass "both targets converged (drift=0)" || fail "drift=$D"

# ── C4 ── opposing multi-target operations must not deadlock ───────────────
echo
echo "C4  opposing multi-target moves (deterministic)"
rebuild; open_sessions
psql_db -q -c "UPDATE public.files SET model_id='$UNIT_M', record_id='$REC_12' WHERE id='f0000000-0000-0000-0000-000000000013';"
psql_db -q -c "UPDATE public.files SET model_id='$UNIT_M', record_id='$REC_13' WHERE id='f0000000-0000-0000-0000-000000000014';"
send 1 "BEGIN;"; sync_on 1
send 2 "BEGIN;"; sync_on 2
# S1 moves 13: f12 -> f13   (locks {f12,f13})
send 1 "UPDATE public.files SET record_id='$REC_13' WHERE id='f0000000-0000-0000-0000-000000000013';"; sync_on 1
# S2 moves 14: f13 -> f12   (locks {f13,f12}) — the opposite pair
send 2 "UPDATE public.files SET record_id='$REC_12' WHERE id='f0000000-0000-0000-0000-000000000014';"; sync_on 2
commit_both
close_sessions
DL=$(grep -ci deadlock "$TMP/s1.out" "$TMP/s2.out" | awk -F: '{s+=$2} END {print s}')
[ "$DL" = "0" ] && pass "no deadlock reported by either session" || fail "$DL deadlock error(s)"
D=$(drift); [ "$D" = "0" ] && pass "both moved files converged (drift=0)" || fail "drift=$D"

# ── C4b ── the same, under sustained opposing load ─────────────────────────
echo
echo "C4b opposing multi-target moves under sustained load (2x60 iterations)"
rebuild
cat > "$TMP/loopA.sql" <<SQL
\\set ON_ERROR_STOP 0
SELECT 'A_START';
DO \$\$ BEGIN
  FOR i IN 1..60 LOOP
    UPDATE public.files SET model_id='$UNIT_M',
      record_id = CASE WHEN i % 2 = 0 THEN '$REC_12'::uuid ELSE '$REC_13'::uuid END
     WHERE id='f0000000-0000-0000-0000-000000000013';
  END LOOP;
END \$\$;
SELECT 'A_DONE';
SQL
cat > "$TMP/loopB.sql" <<SQL
\\set ON_ERROR_STOP 0
SELECT 'B_START';
DO \$\$ BEGIN
  FOR i IN 1..60 LOOP
    UPDATE public.files SET model_id='$UNIT_M',
      record_id = CASE WHEN i % 2 = 0 THEN '$REC_13'::uuid ELSE '$REC_12'::uuid END
     WHERE id='f0000000-0000-0000-0000-000000000014';
  END LOOP;
END \$\$;
SELECT 'B_DONE';
SQL
if [ -n "$PGURL" ]; then
  psql "$(dburl)" -X -At -f "$TMP/loopA.sql" > "$TMP/la.out" 2>&1 & LA=$!
  psql "$(dburl)" -X -At -f "$TMP/loopB.sql" > "$TMP/lb.out" 2>&1 & LB=$!
else
  psql -d "$DBNAME" -X -At -f "$TMP/loopA.sql" > "$TMP/la.out" 2>&1 & LA=$!
  psql -d "$DBNAME" -X -At -f "$TMP/loopB.sql" > "$TMP/lb.out" 2>&1 & LB=$!
fi
wait $LA; wait $LB
DL=$(cat "$TMP/la.out" "$TMP/lb.out" | grep -ci deadlock)
[ "$DL" = "0" ] && pass "120 opposing multi-target syncs, 0 deadlocks" || fail "$DL deadlock(s) under load"
D=$(drift); [ "$D" = "0" ] && pass "converged under sustained opposing load (drift=0)" || fail "drift=$D"

# ── C5 ── concurrent removal of the last source from two different tables ──
echo
echo "C5  record DELETE racing a manual-link DELETE on the same target"
rebuild
psql_db -q -c "INSERT INTO public.records (id, model_id, data) VALUES ('a0000000-0000-0000-0000-0000000000e1','$UNIT_M','{\"unit_plan\":\"f0000000-0000-0000-0000-00000000000d\"}');"
psql_db -q -c "INSERT INTO public.document_links (file_id, model_id, record_id) VALUES ('f0000000-0000-0000-0000-00000000000d','$UNIT_M','a0000000-0000-0000-0000-0000000000e1');"
open_sessions
send 1 "BEGIN;"; sync_on 1
send 2 "BEGIN;"; sync_on 2
send 1 "DELETE FROM public.records WHERE id='a0000000-0000-0000-0000-0000000000e1';"; sync_on 1
send 2 "DELETE FROM public.document_links WHERE record_id='a0000000-0000-0000-0000-0000000000e1';"; sync_on 2
commit_both
close_sessions
ERR=$(grep -ci 'ERROR' "$TMP/s1.out" "$TMP/s2.out" | awk -F: '{s+=$2} END {print s}')
N=$(psql_db -Atc "SELECT count(*) FROM public.file_links WHERE record_id='a0000000-0000-0000-0000-0000000000e1';")
D=$(drift)
[ "$ERR" = "0" ] && pass "neither session errored" || fail "$ERR error(s) — see output"
[ "$N" = "0" ]   && pass "the last source's edge is gone" || fail "$N edge(s) survived with no source"
[ "$D" = "0" ]   && pass "converged (drift=0)" || fail "drift=$D"

# ── C6 ── concurrent creation of two sources that COLLAPSE into one edge ───
# S1 attaches the file legacy-style (0 field roles → role-neutral 'attachment').
# S2 adds a field reference (1 field role → the attachment must CORROBORATE it).
# The correct converged answer is ONE edge with role floor_plan and 2 sources —
# which is only reachable if the second writer re-derives the whole target.
echo
echo "C6  concurrent attachment + field write that re-evaluates the role"
rebuild
psql_db -q -c "UPDATE public.records SET data='{}' WHERE id='$REC_13';"
open_sessions
send 1 "BEGIN;"; sync_on 1
send 2 "BEGIN;"; sync_on 2
send 1 "UPDATE public.files SET model_id='$UNIT_M', record_id='$REC_13' WHERE id='f0000000-0000-0000-0000-00000000000c';"; sync_on 1
send 2 "UPDATE public.records SET data='{\"unit_plan\":\"f0000000-0000-0000-0000-00000000000c\"}' WHERE id='$REC_13';"; sync_on 2
commit_both
close_sessions
ROLES=$(psql_db -Atc "SELECT string_agg(role,',' ORDER BY role) FROM public.file_links WHERE file_id='f0000000-0000-0000-0000-00000000000c' AND record_id='$REC_13';")
SRC=$(psql_db -Atc "SELECT count(*) FROM public.file_link_sources s JOIN public.file_links l ON l.id=s.link_id WHERE l.file_id='f0000000-0000-0000-0000-00000000000c' AND l.record_id='$REC_13';")
D=$(drift)
[ "$ROLES" = "floor_plan" ] && pass "role re-evaluated to floor_plan (no stale 'attachment' edge)" \
                            || fail "roles are '$ROLES', expected exactly 'floor_plan'"
[ "$SRC" = "2" ] && pass "both sources landed on the one edge" || fail "$SRC source(s), expected 2"
[ "$D" = "0" ]   && pass "converged (drift=0)" || fail "drift=$D"

# ── C7 ── high-contention hammer on a SINGLE shared target ─────────────────
# Four writers touching four different authoritative tables, all resolving to
# the same target, repeatedly. Nothing may error and the end state must be
# exactly what an independent re-derivation says.
echo
echo "C7  four concurrent writers hammering one shared target"
rebuild
PROJ=a0000000-0000-0000-0000-000000000f01
AP=11111111-0000-0000-0000-000000000002
for k in 1 2 3 4; do
  case $k in
    1) BODY="UPDATE public.records SET data = jsonb_set(data,'{main_image}', to_jsonb('f0000000-0000-0000-0000-00000000000'||(CASE WHEN i%2=0 THEN 'd' ELSE 'e' END))) WHERE id='$PROJ';" ;;
    2) BODY="UPDATE public.files SET model_id='$AP', record_id='$PROJ' WHERE id='f0000000-0000-0000-0000-00000000000f'; UPDATE public.files SET model_id=NULL, record_id=NULL WHERE id='f0000000-0000-0000-0000-00000000000f';" ;;
    3) BODY="INSERT INTO public.document_links (file_id, model_id, record_id) VALUES ('f0000000-0000-0000-0000-000000000012','$AP','$PROJ') ON CONFLICT DO NOTHING; DELETE FROM public.document_links WHERE file_id='f0000000-0000-0000-0000-000000000012' AND record_id='$PROJ';" ;;
    4) BODY="UPDATE public.mos_assets SET project_id = CASE WHEN i%2=0 THEN '$PROJ'::uuid ELSE NULL END;" ;;
  esac
  cat > "$TMP/ham$k.sql" <<SQL
\\set ON_ERROR_STOP 0
DO \$\$ BEGIN FOR i IN 1..40 LOOP
$BODY
END LOOP; END \$\$;
SELECT 'HAM${k}_DONE';
SQL
done
PIDS=()
for k in 1 2 3 4; do
  if [ -n "$PGURL" ]; then psql "$(dburl)" -X -At -f "$TMP/ham$k.sql" > "$TMP/ham$k.out" 2>&1 &
  else psql -d "$DBNAME" -X -At -f "$TMP/ham$k.sql" > "$TMP/ham$k.out" 2>&1 & fi
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
DONE=$(cat "$TMP"/ham*.out | grep -c '_DONE')
ERRS=$(cat "$TMP"/ham*.out | grep -ci 'ERROR')
DL=$(cat "$TMP"/ham*.out | grep -ci 'deadlock')
D=$(drift)
ORPH=$(psql_db -Atc "SELECT count(*) FROM public.file_links l WHERE NOT EXISTS (SELECT 1 FROM public.file_link_sources s WHERE s.link_id=l.id);")
info "160 mutations across 4 tables: completed=$DONE errors=$ERRS deadlocks=$DL"
[ "$DONE" = "4" ] && pass "all four writers completed" || fail "only $DONE/4 writers completed"
[ "$ERRS" = "0" ] && pass "no unique-violation or FK error under contention" || { fail "$ERRS error(s)"; cat "$TMP"/ham*.out | grep -i ERROR | head -5; }
[ "$DL" = "0" ]   && pass "no deadlocks" || fail "$DL deadlock(s)"
[ "$ORPH" = "0" ] && pass "no unproven edges" || fail "$ORPH unproven edge(s)"
[ "$D" = "0" ]    && pass "final state matches an independent re-derivation (drift=0)" || fail "drift=$D"

echo
echo "=============================================================="
if [ "$FAILURES" = "0" ]; then echo "ALL CONCURRENCY TESTS PASSED"; else echo "$FAILURES CONCURRENCY ASSERTION(S) FAILED"; fi
echo "=============================================================="
psql_admin -q -c "DROP DATABASE IF EXISTS $DBNAME (FORCE);" >/dev/null 2>&1
exit $([ "$FAILURES" = "0" ] && echo 0 || echo 1)
