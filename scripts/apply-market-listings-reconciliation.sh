#!/usr/bin/env bash
# =============================================================================
# apply-market-listings-reconciliation.sh
#
# CONTROLLED PRODUCTION APPLY RUNNER for:
#   supabase/migrations/2026-09-04_00_market_listings_view_reconciliation.sql
#
# AUTHORIZATION GATE
#   This script refuses to apply anything unless the environment variable
#   WASSEL_APPLY_CONFIRM is set to EXACTLY:
#       I HAVE AUTHORIZATION TO APPLY
#   Without it, the script runs in --dry-run mode (snapshot only, no writes).
#   If it is set to anything else (set but wrong), the script exits 1
#   WITHOUT touching the database.
#
# EVIDENCE IS THE RECORD
#   Every run writes evidence files (before/after snapshots, apply log,
#   unified diff, verification results) into an evidence directory. These
#   files — not this terminal scrollback — are the durable record of what
#   changed. Keep them.
#
# OUTCOME CLASSIFICATION — NEVER ASSUME ROLLBACK ON psql FAILURE
#   A nonzero psql exit does NOT prove the transaction rolled back: if the
#   connection drops after PostgreSQL executes the migration's COMMIT but
#   before psql receives the acknowledgement, the change persisted. So
#   after EVERY apply attempt — whatever the psql exit code — this script
#   reconnects, captures the AFTER snapshot + diff, and classifies:
#       APPLIED AND VERIFIED        exit 0  (psql 0, all checks pass)
#       VERIFICATION FAILED         exit 2  (psql 0, a check failed)
#       ROLLED BACK (clean)         exit 1  (psql nonzero, after == before,
#                                            and BEFORE was NOT already at the
#                                            migration's target state)
#       INDETERMINATE (converged)   exit 2  (psql nonzero, after == before,
#                                            but BEFORE already matched the
#                                            target state — a clean rollback
#                                            and a commit that changed nothing
#                                            observable are indistinguishable)
#       INDETERMINATE               exit 2  (psql nonzero, after != before)
#       INDETERMINATE (unreachable) exit 2  (AFTER snapshot uncapturable)
#
# DIRECT psql ONLY — DO NOT RUN VIA MCP / TOOLING
#   This must be run by a human operator over a direct psql connection
#   (PGURL). It is deliberately NOT routed through an MCP/tooling path:
#   during preparation, one ALTER VIEW was observed to PERSIST through an
#   otherwise-rolled-back transaction on that path, so any evidence produced
#   through it (including rollback evidence) is not trusted. Direct psql is
#   the only connection whose transactional guarantees we rely on here.
#
# Usage:
#   PGURL='postgres://...' \
#   WASSEL_APPLY_CONFIRM='I HAVE AUTHORIZATION TO APPLY' \
#     bash scripts/apply-market-listings-reconciliation.sh
#
#   PGURL='postgres://...' bash scripts/apply-market-listings-reconciliation.sh --dry-run
#
# Env:
#   PGURL                (required) direct postgres connection string
#   WASSEL_APPLY_CONFIRM (required for apply) exact authorization phrase
#   OUTDIR               (optional) evidence dir; default ./.apply-evidence/<STAMP>
#   STAMP                (optional) UTC timestamp used in the default OUTDIR;
#                        default: date -u +%Y%m%dT%H%M%SZ
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
MIGRATION="${WASSEL_MIGRATION_OVERRIDE:-$REPO_ROOT/supabase/migrations/2026-09-04_00_market_listings_view_reconciliation.sql}"
ROLLBACK_REL="docs/market-ingest/reconciliation-rollback.sql"
ROLLBACK_CMD="psql \"\$PGURL\" -v ON_ERROR_STOP=1 -f $ROLLBACK_REL"

CONFIRM_PHRASE='I HAVE AUTHORIZATION TO APPLY'

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,/^# ===/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg (only --dry-run is supported)" >&2
      exit 1
      ;;
  esac
done

# --- PGURL gate --------------------------------------------------------------
if [ -z "${PGURL:-}" ]; then
  echo "ERROR: PGURL is not set." >&2
  echo "This runner requires a DIRECT postgres connection string:" >&2
  echo "  PGURL='postgres://user:pass@host:5432/dbname' ..." >&2
  exit 1
fi

# --- Authorization gate ------------------------------------------------------
if [ "${WASSEL_APPLY_CONFIRM:-}" != "$CONFIRM_PHRASE" ]; then
  if [ -z "${WASSEL_APPLY_CONFIRM:-}" ]; then
    echo "NOTE: WASSEL_APPLY_CONFIRM is unset — defaulting to --dry-run."
    echo "      To apply, set it to exactly: $CONFIRM_PHRASE"
    DRY_RUN=1
  elif [ "$DRY_RUN" -eq 1 ]; then
    echo "NOTE: WASSEL_APPLY_CONFIRM is set but does not match the required"
    echo "      phrase; --dry-run was requested, so continuing read-only."
  else
    echo "AUTHORIZATION GATE FAILED." >&2
    echo "WASSEL_APPLY_CONFIRM must be EXACTLY:" >&2
    echo "  $CONFIRM_PHRASE" >&2
    echo "Missing/incorrect confirmation — exiting WITHOUT touching the database." >&2
    exit 1
  fi
fi

# --- Preconditions -----------------------------------------------------------
if [ ! -f "$MIGRATION" ]; then
  echo "ERROR: migration file not found: $MIGRATION" >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql not found on PATH." >&2
  exit 1
fi

STAMP="${STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUTDIR="${OUTDIR:-./.apply-evidence/$STAMP}"
mkdir -p "$OUTDIR"

echo "==================================================================="
echo " market_listings view reconciliation — controlled apply runner"
echo " stamp:    $STAMP"
echo " outdir:   $OUTDIR"
echo " mode:     $([ "$DRY_RUN" -eq 1 ] && echo 'DRY RUN (read-only)' || echo 'APPLY')"
echo " migration: $MIGRATION"
echo "==================================================================="

if [ -n "${WASSEL_MIGRATION_OVERRIDE:-}" ]; then
  echo "!!! WARNING: migration path OVERRIDDEN via WASSEL_MIGRATION_OVERRIDE" >&2
  echo "!!! This is for TESTING the runner against a disposable database ONLY." >&2
  echo "!!! NEVER set this when applying to production." >&2
fi

# --- Snapshot query (BEFORE and AFTER use the identical query) ---------------
# Single -tA query; every section ordered deterministically so diffs of
# before.txt vs after.txt are meaningful.
read -r -d '' SNAPSHOT_SQL <<'SQL' || true
SELECT 'VIEW|' || c.relname || '|' || pg_get_userbyid(c.relowner) || '|'
    || coalesce(c.reloptions::text, '(null)') || '|' || md5(pg_get_viewdef(c.oid))
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'v'
  AND c.relname IN ('market_listings_summary', 'v_market_listings', 'v_market_properties')
UNION ALL
SELECT 'TABLE|' || c.relname || '|relrowsecurity=' || c.relrowsecurity::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'market_listings'
UNION ALL
SELECT 'POLICY|' || p.polname || '|cmd=' || p.polcmd::text
    || '|permissive=' || p.polpermissive::text
    || '|roles=' || p.polroles::regrole[]::text
    || '|qual=' || coalesce(md5(pg_get_expr(p.polqual, p.polrelid)), '(null)')
    || '|withcheck=' || coalesce(md5(pg_get_expr(p.polwithcheck, p.polrelid)), '(null)')
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'market_listings'
UNION ALL
-- Match by OID via to_regprocedure, NOT by comparing
-- pg_get_function_identity_arguments against a types-only string: that
-- function returns parameter NAMES too ('auth_user_id uuid, the_model_id
-- uuid'), so a types-only comparison silently matches nothing and the
-- FUNCTION evidence lines disappear with no error (they were absent from
-- every snapshot produced before this fix).
SELECT 'FUNCTION|' || p.proname || '|' || pg_get_userbyid(p.proowner)
    || '|secdef=' || p.prosecdef::text
    || '|volatile=' || p.provolatile::text
    || '|config=' || coalesce(array_to_string(p.proconfig, ','), '(null)')
    || '|' || md5(pg_get_functiondef(p.oid))
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (
    (p.proname = 'wassell_view_scope_class'
       AND p.oid = to_regprocedure('public.wassell_view_scope_class(uuid,uuid)'))
    OR
    (p.proname = 'wassell_can_view_jsonb'
       AND p.oid = to_regprocedure('public.wassell_can_view_jsonb(uuid,uuid,uuid,uuid,jsonb)'))
  )
UNION ALL
-- PUBLIC is deliberately included here (grantee oid 0): the migration
-- REVOKEs privileges from PUBLIC on the views, and the outcome
-- classifier's byte-comparison of before.txt vs after.txt must cover
-- EVERY class of state the migration mutates. information_schema
-- .role_table_grants never reports PUBLIC, so a stray PUBLIC grant (or
-- a concurrent re-grant) would be invisible to the comparison and could
-- misclassify the outcome. When relacl IS NULL, aclexplode yields no
-- rows — which correctly means no explicit grants.
-- Grantability is part of the evidence: a grant-option-only change
-- (e.g. SELECT gaining or losing WITH GRANT OPTION) is a real ACL
-- mutation the byte comparison must catch, so each privilege renders
-- with a trailing '*' when aclexplode.is_grantable is true (SELECT* vs
-- SELECT serialize to different lines).
SELECT 'ACL|' || c.relname || '|'
    || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
    || '|' || string_agg(a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END,
                         ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) AS a
WHERE n.nspname = 'public'
  AND c.relname IN ('market_listings_summary', 'v_market_listings',
                    'v_market_properties', 'market_listings')
  AND CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
      IN ('PUBLIC', 'anon', 'authenticated', 'service_role')
GROUP BY c.relname,
    CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
ORDER BY 1;
SQL

snapshot() {
  psql "$PGURL" -v ON_ERROR_STOP=1 -tA -c "$SNAPSHOT_SQL"
}

# --- Step 1: BEFORE snapshot -------------------------------------------------
echo ">>> Step 1: BEFORE snapshot -> $OUTDIR/before.txt"
snapshot > "$OUTDIR/before.txt"

# --- Step 2: print the BEFORE snapshot ---------------------------------------
echo ">>> Step 2: BEFORE snapshot"
echo "-------------------------------------------------------------------"
cat "$OUTDIR/before.txt"
echo "-------------------------------------------------------------------"

# --- Step 3: dry-run exit ----------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY RUN - nothing applied"
  echo "Evidence (BEFORE snapshot) written to: $OUTDIR"
  exit 0
fi

# --- Step 4: APPLY -----------------------------------------------------------
echo ">>> Step 4: applying migration (output -> $OUTDIR/apply.log)"
set +e
psql "$PGURL" -v ON_ERROR_STOP=1 -f "$MIGRATION" 2>&1 | tee "$OUTDIR/apply.log"
apply_rc=${PIPESTATUS[0]}
set -e

# WHY NONZERO-EXIT DOES NOT IMPLY ROLLBACK:
# A nonzero psql exit does NOT prove the transaction rolled back. If the
# connection drops after PostgreSQL has executed the migration's COMMIT but
# before psql receives the acknowledgement, psql reports failure while the
# change actually persisted. Recreating that ambiguity is exactly what this
# runner exists to prevent — so we NEVER branch to "rolled back" on the exit
# code alone. Instead, after EVERY apply attempt we reconnect, capture the
# AFTER snapshot, and let the byte-comparison of before.txt vs after.txt
# (plus the verification checks when psql exited 0) classify the outcome.
echo ">>> psql exited $apply_rc — capturing the AFTER snapshot regardless."
echo ">>> (a nonzero exit does NOT prove rollback; the snapshot decides)"

# --- Step 5: AFTER snapshot --------------------------------------------------
echo ">>> Step 5: AFTER snapshot -> $OUTDIR/after.txt"
set +e
snapshot > "$OUTDIR/after.txt"
after_rc=$?
set -e

if [ "$after_rc" -ne 0 ]; then
  echo "===================================================================" >&2
  echo "INDETERMINATE (unreachable)" >&2
  echo "psql exited $apply_rc AND the AFTER snapshot could not be captured" >&2
  echo "(snapshot exit $after_rc — the database may be unreachable)." >&2
  echo "The outcome of the apply attempt is UNKNOWN and must be established" >&2
  echo "manually IMMEDIATELY: reconnect and compare the live state against" >&2
  echo "$OUTDIR/before.txt." >&2
  echo "Evidence dir: $OUTDIR" >&2
  echo "Rollback command (only once a human confirms changes persisted):" >&2
  echo "  $ROLLBACK_CMD" >&2
  echo "===================================================================" >&2
  exit 2
fi

# --- Step 6: diff ------------------------------------------------------------
echo ">>> Step 6: diff -> $OUTDIR/diff.txt"
set +e
diff -u "$OUTDIR/before.txt" "$OUTDIR/after.txt" > "$OUTDIR/diff.txt"
diff_rc=$?
set -e
if [ "$diff_rc" -gt 1 ]; then
  echo "===================================================================" >&2
  echo "INDETERMINATE (unreachable)" >&2
  echo "diff itself failed (exit $diff_rc), so before/after cannot be" >&2
  echo "compared. The outcome of the apply attempt is UNKNOWN and must be" >&2
  echo "established manually IMMEDIATELY." >&2
  echo "Evidence dir: $OUTDIR" >&2
  echo "Rollback command (only once a human confirms changes persisted):" >&2
  echo "  $ROLLBACK_CMD" >&2
  echo "===================================================================" >&2
  exit 2
fi
echo "-------------------------------------------------------------------"
cat "$OUTDIR/diff.txt"
echo "-------------------------------------------------------------------"

# --- Was the BEFORE snapshot already at the migration's TARGET state? -----
# The migration is deliberately convergent, so a retry after an earlier
# ambiguous apply can START with before.txt already equal to the end state.
# In that case a nonzero psql exit with after == before is AMBIGUOUS: it
# fits a clean rollback AND a commit that changed nothing observable (e.g.
# the connection dropped after PostgreSQL executed COMMIT but before psql
# received the acknowledgement). Identical snapshots prove only that the
# observable state is unchanged — NOT that a rollback occurred. Convergence
# is judged from the BEFORE snapshot alone: both new policies already
# present AND all three views already carrying security_invoker=true.
before_converged=1
for pol in market_listings_view_fast market_listings_view_deny_none; do
  # `|| true`: an absent line must just mark not-converged, never abort the
  # script under set -e/pipefail (see the pipefail note in Step 7b).
  if [ -z "$(grep -F "POLICY|$pol|" "$OUTDIR/before.txt" | head -n 1 || true)" ]; then
    before_converged=0
  fi
done
for view in market_listings_summary v_market_listings v_market_properties; do
  view_line="$(grep -F "VIEW|$view|" "$OUTDIR/before.txt" | head -n 1 || true)"
  case "$view_line" in
    *security_invoker=true*) : ;;
    *) before_converged=0 ;;
  esac
done

# --- Nonzero-psql classification (skip the end-state verification: it checks
# --- the APPLIED end state, which is only meaningful when psql exited 0) ---
if [ "$apply_rc" -ne 0 ]; then
  if cmp -s "$OUTDIR/before.txt" "$OUTDIR/after.txt"; then
    if [ "$before_converged" -eq 1 ]; then
      echo "===================================================================" >&2
      echo "INDETERMINATE (converged retry) — REVIEW BY A HUMAN IMMEDIATELY" >&2
      echo "psql exited $apply_rc, and after.txt is byte-identical to" >&2
      echo "before.txt — but the BEFORE snapshot was ALREADY at the" >&2
      echo "migration's target state (both market_listings_view_fast and" >&2
      echo "market_listings_view_deny_none present, and all three views" >&2
      echo "already security_invoker=true). With a converged starting" >&2
      echo "state, identical snapshots CANNOT distinguish a clean rollback" >&2
      echo "from a COMMIT that changed nothing observable (e.g. the" >&2
      echo "connection dropped after PostgreSQL executed COMMIT but before" >&2
      echo "psql received the acknowledgement). A human must establish the" >&2
      echo "outcome from $OUTDIR/apply.log and the live database." >&2
      echo "Evidence dir: $OUTDIR" >&2
      echo "Rollback command (only once a human confirms changes persisted):" >&2
      echo "  $ROLLBACK_CMD" >&2
      echo "===================================================================" >&2
      exit 2
    fi
    echo "==================================================================="
    echo "ROLLED BACK (clean)"
    echo "psql exited $apply_rc, and after.txt is byte-identical to"
    echo "before.txt: the migration is transactional and self-aborting"
    echo "(ON_ERROR_STOP aborts on the first failing statement), so no"
    echo "change persisted. (The BEFORE snapshot was NOT already at the"
    echo "target state, so an unchanged snapshot here really does mean"
    echo "nothing committed.)"
    echo "Evidence dir: $OUTDIR"
    echo "  before.txt / after.txt / diff.txt / apply.log"
    echo "Rollback command (not needed — nothing persisted):"
    echo "  $ROLLBACK_CMD"
    echo "==================================================================="
    exit 1
  fi
  echo "===================================================================" >&2
  echo "INDETERMINATE — REVIEW BY A HUMAN IMMEDIATELY" >&2
  echo "psql exited $apply_rc, but after.txt DIFFERS from before.txt." >&2
  echo "The database may be PARTIALLY or FULLY changed (e.g. the connection" >&2
  echo "dropped after PostgreSQL executed COMMIT but before psql received" >&2
  echo "the acknowledgement). The full diff (also in $OUTDIR/diff.txt):" >&2
  echo "-------------------------------------------------------------------" >&2
  cat "$OUTDIR/diff.txt" >&2
  echo "-------------------------------------------------------------------" >&2
  echo "Evidence dir: $OUTDIR" >&2
  echo "Rollback command (run only after a human reviews the diff):" >&2
  echo "  $ROLLBACK_CMD" >&2
  echo "===================================================================" >&2
  exit 2
fi

# --- Step 7: END-STATE VERIFICATION ------------------------------------------
# (Only reached when psql exited 0 — nonzero exits are classified above.)
# Verifies the APPLIED end state: structural SQL checks, the RLS flag on the
# base table, BOTH pinned authorization functions (owner / secdef /
# volatility / search_path / full-definition md5), the two NEW policy
# predicates by EXACT normalized-expression comparison, view-body md5s, and
# ALL FOUR frozen_* policies (frozen_view, frozen_insert, frozen_update,
# frozen_delete) compared byte-identical between before.txt and after.txt on
# BOTH the USING qual AND the WITH CHECK expression (frozen_insert is a
# WITH CHECK policy whose polqual is NULL — comparing only polqual would
# never capture its real expression).
echo ">>> Step 7: end-state verification -> $OUTDIR/verify.txt"
VERIFY_FILE="$OUTDIR/verify.txt"
: > "$VERIFY_FILE"
VERIFY_ERROR_FILE="$OUTDIR/verify-error.txt"

# A verification-query failure is NOT a rollback and must never be
# reported as one: this step only runs after the apply psql exited 0, so
# the migration is KNOWN to have committed. If a verification psql call
# fails (connection drop, query error), the runner must not die with a
# bare exit 1 under set -e — exit 1 is the documented ROLLED BACK (clean)
# status, so an operator or automation reading the exit code would be
# actively misled. Every verification psql call below is wrapped in
# set +e / status capture / set -e (the same posture as the apply and
# AFTER-snapshot steps); on failure we record the psql error output in
# $VERIFY_ERROR_FILE, append a CHECK|...|FAIL row (so the Step 8 verdict
# grep also sees it), and end in an explicit VERIFICATION FAILED
# (verification query error) verdict with exit 2.
verification_query_failed() { # description of the query that failed
  local what="$1"
  echo "CHECK|verification query error: $what|FAIL|psql exited nonzero; error output in $VERIFY_ERROR_FILE" >> "$VERIFY_FILE"
  echo "-------------------------------------------------------------------" >&2
  cat "$VERIFY_FILE" >&2
  echo "-------------------------------------------------------------------" >&2
  echo "===================================================================" >&2
  echo "VERIFICATION FAILED (verification query error) — VERIFY THE END STATE MANUALLY, IMMEDIATELY" >&2
  echo "The migration COMMITTED (the apply psql exited 0), but $what" >&2
  echo "failed, so the end state could NOT be verified." >&2
  echo "This is NOT a rollback — the applied change is live in the database." >&2
  echo "A human must reconnect and verify the end state against this" >&2
  echo "runner's checks immediately." >&2
  echo "psql error output: $VERIFY_ERROR_FILE" >&2
  echo "Evidence dir: $OUTDIR" >&2
  echo "  before.txt / after.txt / diff.txt / apply.log / verify.txt / verify-error.txt" >&2
  echo "Rollback command (only once a human confirms the end state is wrong):" >&2
  echo "  $ROLLBACK_CMD" >&2
  echo "===================================================================" >&2
  exit 2
}

# Exact expected renderings of the two NEW policy predicates the migration
# creates, as PostgreSQL 16 renders pg_get_expr(polqual, polrelid) — these
# strings were measured directly from a real PostgreSQL 16 database
# (whitespace runs collapsed to single spaces), NOT assumed. Comparison
# normalizes BOTH sides: all runs of whitespace collapsed to a single space,
# then trimmed. Each policy has an ARRAY of accepted renderings because a
# different PostgreSQL major version may pretty-print the same predicate
# differently — in which case this runner fails closed, and the unmatched
# rendering must be reviewed BY A HUMAN and added here only if genuinely
# equivalent, NEVER assumed safe. (Substring/token tests are not sufficient:
# `USING (true OR wassell_view_scope_class(...) = 'all')` contains every
# required token, omits wassell_can_view_jsonb, and passes a token check
# while exposing every row.)
EXPECTED_QUAL_FAST=(
  "(( SELECT wassell_view_scope_class(( SELECT auth.uid() AS uid), '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid) AS wassell_view_scope_class) = 'all'::text)"
)
EXPECTED_QUAL_DENY_NONE=(
  "(( SELECT wassell_view_scope_class(( SELECT auth.uid() AS uid), '8f06bc39-4bee-42e9-9fab-77023fb89ede'::uuid) AS wassell_view_scope_class) <> 'none'::text)"
)

# 7a. Structural checks in SQL — each row is CHECK|name|PASS|detail or FAIL.
read -r -d '' VERIFY_SQL <<'SQL' || true
SELECT 'CHECK|policy market_listings_view_fast (permissive, SELECT, roles={authenticated})|'
    || CASE WHEN count(*) = 1 AND bool_and(ok) THEN 'PASS' ELSE 'FAIL' END
    || '|matching_rows=' || count(*)
FROM (
  SELECT (p.polpermissive AND p.polcmd = 'r'
          AND p.polroles::regrole[]::text = '{authenticated}') AS ok
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'market_listings'
    AND p.polname = 'market_listings_view_fast'
) s
UNION ALL
SELECT 'CHECK|policy market_listings_view_deny_none (RESTRICTIVE, SELECT, roles={authenticated})|'
    || CASE WHEN count(*) = 1 AND bool_and(ok) THEN 'PASS' ELSE 'FAIL' END
    || '|matching_rows=' || count(*)
FROM (
  SELECT ((NOT p.polpermissive) AND p.polcmd = 'r'
          AND p.polroles::regrole[]::text = '{authenticated}') AS ok
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'market_listings'
    AND p.polname = 'market_listings_view_deny_none'
) s
UNION ALL
-- RLS re-assertion. With psql exit 0 the diff is informational only, so a
-- post-COMMIT `ALTER TABLE public.market_listings DISABLE ROW LEVEL
-- SECURITY` would be recorded in after.txt but never enforced here — every
-- policy would still be in place while authenticated callers bypass all of
-- them. This check makes a disabled-RLS end state fail the run.
SELECT 'CHECK|table market_listings has row level security ENABLED|'
    || CASE WHEN count(*) = 1 AND bool_and(c.relrowsecurity) THEN 'PASS' ELSE 'FAIL' END
    || '|matching_rows=' || count(*)
    || ' relrowsecurity=' || coalesce(bool_and(c.relrowsecurity)::text, '(table missing)')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'market_listings'
UNION ALL
-- Pinned authorization functions. The FUNCTION snapshot lines feed only the
-- informational diff, so a post-COMMIT redefinition of either function
-- (e.g. wassell_view_scope_class redefined to return 'all' for everyone,
-- which makes the fast-branch policy pass for every authenticated user)
-- would otherwise go unenforced — the policy-expression checks only see
-- the function CALL, not its body. These checks pin owner, SECURITY
-- DEFINER, volatility, search_path config, and the md5 of the full
-- function definition against the exact pins the migration uses; the
-- observed md5 is in the detail so a failure is self-explanatory.
-- The functions are matched by OID via to_regprocedure, NOT by comparing
-- pg_get_function_identity_arguments against a types-only string: that
-- function returns parameter NAMES too ('auth_user_id uuid, the_model_id
-- uuid'), so a types-only comparison silently matched nothing and these
-- checks always reported matching_rows=0 / '(function missing)' — a
-- guaranteed FAIL that would block every legitimate apply.
SELECT 'CHECK|function wassell_view_scope_class(uuid,uuid) matches the pinned definition|'
    || CASE WHEN count(*) = 1 AND bool_and(ok) THEN 'PASS' ELSE 'FAIL' END
    || '|matching_rows=' || count(*)
    || ' observed_md5=' || coalesce(string_agg(observed_md5, ','), '(function missing)')
FROM (
  SELECT (pg_get_userbyid(p.proowner) = 'postgres'
          AND p.prosecdef
          AND p.provolatile = 's'
          AND array_to_string(p.proconfig, ',') = 'search_path=public, pg_temp'
          AND md5(pg_get_functiondef(p.oid)) = '0bcfabe9df9da91ea4d874104fec65d6') AS ok,
         md5(pg_get_functiondef(p.oid)) AS observed_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'wassell_view_scope_class'
    AND p.oid = to_regprocedure('public.wassell_view_scope_class(uuid,uuid)')
) s
UNION ALL
SELECT 'CHECK|function wassell_can_view_jsonb(uuid,uuid,uuid,uuid,jsonb) matches the pinned definition|'
    || CASE WHEN count(*) = 1 AND bool_and(ok) THEN 'PASS' ELSE 'FAIL' END
    || '|matching_rows=' || count(*)
    || ' observed_md5=' || coalesce(string_agg(observed_md5, ','), '(function missing)')
FROM (
  SELECT (pg_get_userbyid(p.proowner) = 'postgres'
          AND p.prosecdef
          AND p.provolatile = 's'
          AND array_to_string(p.proconfig, ',') = 'search_path=public, pg_temp'
          AND md5(pg_get_functiondef(p.oid)) = 'c9a781616085d3b06eec12d68238b502') AS ok,
         md5(pg_get_functiondef(p.oid)) AS observed_md5
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'wassell_can_view_jsonb'
    AND p.oid = to_regprocedure('public.wassell_can_view_jsonb(uuid,uuid,uuid,uuid,jsonb)')
) s
UNION ALL
SELECT 'CHECK|all four frozen_* policies present|'
    || CASE WHEN count(*) = 4 THEN 'PASS' ELSE 'FAIL' END
    || '|count=' || count(*)
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'market_listings'
  AND p.polname IN ('frozen_view', 'frozen_insert', 'frozen_update', 'frozen_delete')
UNION ALL
SELECT 'CHECK|view ' || c.relname || ' has security_invoker=true|'
    || CASE WHEN coalesce(c.reloptions::text, '') LIKE '%security_invoker=true%'
            THEN 'PASS' ELSE 'FAIL' END
    || '|reloptions=' || coalesce(c.reloptions::text, '(null)')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'v'
  AND c.relname IN ('market_listings_summary', 'v_market_listings', 'v_market_properties')
UNION ALL
-- Owner re-assertion. security_invoker, the view bodies and the ACLs are
-- all asserted elsewhere in this step, but none of them covers relowner:
-- a post-COMMIT `ALTER VIEW public.<v> OWNER TO some_role` would be
-- recorded in after.txt while the diff stays informational after a
-- successful apply — the run would print APPLIED AND VERIFIED with an
-- unexpected role owning (and therefore able to redefine) an
-- authorization-facing view. This pins every target view's owner to
-- postgres, matching the migration's own preflight; on failure it names
-- each offending view together with its observed owner.
SELECT 'CHECK|all three target views are owned by postgres|'
    || CASE WHEN count(*) = 3
                 AND bool_and(pg_get_userbyid(c.relowner) = 'postgres')
            THEN 'PASS' ELSE 'FAIL' END
    || '|matching_rows=' || count(*)
    || ' ' || coalesce(string_agg(c.relname || ' owner=' || pg_get_userbyid(c.relowner), ', '
                                  ORDER BY c.relname)
                       FILTER (WHERE pg_get_userbyid(c.relowner) <> 'postgres'),
                       '(no non-postgres owner observed)')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'v'
  AND c.relname IN ('market_listings_summary', 'v_market_listings', 'v_market_properties')
UNION ALL
-- ACL assertions are built on pg_class.relacl + aclexplode with the SAME
-- grantability-aware serialization the snapshot uses (privilege_type with
-- a trailing '*' when is_grantable). information_schema.role_table_grants
-- DISCARDS grant options: a post-COMMIT GRANT SELECT ... WITH GRANT OPTION
-- would still read there as exactly 'SELECT' and pass, while every
-- authenticated session could re-grant access to the view. The diff cannot
-- catch it either — with psql exit 0 the diff is informational only, so
-- this must be enforced here, independently.
SELECT 'CHECK|acl authenticated on market_listings_summary is exactly SELECT (grant option fails)|'
    || CASE WHEN coalesce(string_agg(a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END,
                                     ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END),
                          '(none)') = 'SELECT'
            THEN 'PASS' ELSE 'FAIL' END
    || '|privs=' || coalesce(string_agg(a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END,
                                        ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END),
                             '(none)')
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) AS a
WHERE n.nspname = 'public' AND c.relname = 'market_listings_summary'
  AND a.grantee = 'authenticated'::regrole
UNION ALL
SELECT 'CHECK|acl authenticated holds NO privileges on v_market_listings / v_market_properties|'
    || CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END
    || '|' || CASE WHEN count(*) = 0 THEN 'none found'
                   ELSE 'found: ' || string_agg(c.relname || ':' || a.privilege_type
                                                    || CASE WHEN a.is_grantable THEN '*' ELSE '' END,
                                                ', ' ORDER BY c.relname, a.privilege_type) END
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) AS a
WHERE n.nspname = 'public'
  AND c.relname IN ('v_market_listings', 'v_market_properties')
  AND a.grantee = 'authenticated'::regrole
UNION ALL
SELECT 'CHECK|acl anon holds NO privileges on the three views|'
    || CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END
    || '|' || CASE WHEN count(*) = 0 THEN 'none found'
                   ELSE 'found: ' || string_agg(c.relname || ':' || a.privilege_type
                                                    || CASE WHEN a.is_grantable THEN '*' ELSE '' END,
                                                ', ' ORDER BY c.relname, a.privilege_type) END
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) AS a
WHERE n.nspname = 'public' AND c.relkind = 'v'
  AND c.relname IN ('market_listings_summary', 'v_market_listings', 'v_market_properties')
  AND a.grantee = 'anon'::regrole
UNION ALL
-- PUBLIC end-state check. Built on pg_class.relacl + aclexplode because
-- information_schema.role_table_grants never surfaces PUBLIC. A PUBLIC
-- grant landing after the migration's COMMIT but before the AFTER
-- snapshot is caught by the diff, but with psql exit 0 the diff is
-- informational only — this assertion makes a publicly-exposed view fail
-- the run. Scoped to the three VIEWS only: the migration does not manage
-- base-table grants, so a pre-existing PUBLIC grant on market_listings
-- must not fail the run (it stays visible in the snapshot diff).
SELECT 'CHECK|acl PUBLIC holds NO privileges on the three views|'
    || CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END
    || '|' || CASE WHEN count(*) = 0 THEN 'none found'
                   ELSE 'found: ' || string_agg(c.relname || ':' || a.privilege_type, ', '
                                                ORDER BY c.relname, a.privilege_type) END
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) AS a
WHERE n.nspname = 'public' AND c.relkind = 'v'
  AND c.relname IN ('market_listings_summary', 'v_market_listings', 'v_market_properties')
  AND a.grantee = 0
UNION ALL
SELECT 'CHECK|acl service_role retains SELECT on ' || v.t || ' (grantable or not)|'
    || CASE WHEN EXISTS (
         SELECT 1
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) AS a
         WHERE n.nspname = 'public' AND c.relname = v.t
           AND a.grantee = 'service_role'::regrole
           AND a.privilege_type = 'SELECT')
       THEN 'PASS' ELSE 'FAIL' END
    || '|privs=' || coalesce((
         SELECT string_agg(a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END,
                           ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END)
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) AS a
         WHERE n.nspname = 'public' AND c.relname = v.t
           AND a.grantee = 'service_role'::regrole), '(none)')
FROM (VALUES ('market_listings_summary'), ('v_market_listings'), ('v_market_properties')) AS v(t)
UNION ALL
SELECT 'CHECK|acl ' || v.g || ' retains SELECT on base table market_listings|'
    || CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.role_table_grants g
         WHERE g.table_schema = 'public' AND g.table_name = 'market_listings'
           AND g.grantee = v.g AND g.privilege_type = 'SELECT')
       THEN 'PASS' ELSE 'FAIL' END
FROM (VALUES ('authenticated'), ('service_role')) AS v(g)
ORDER BY 1;
SQL

set +e
psql "$PGURL" -v ON_ERROR_STOP=1 -tA -c "$VERIFY_SQL" >> "$VERIFY_FILE" 2>> "$VERIFY_ERROR_FILE"
verify_rc=$?
set -e
if [ "$verify_rc" -ne 0 ]; then
  verification_query_failed "the Step 7 structural verification query (exit $verify_rc)"
fi

# 7b. Cross-snapshot checks (bash): md5s that must be UNCHANGED vs BEFORE.
# PIPEFAIL NOTE: every `grep ... | head/sort` lookup below carries a trailing
# `|| true`. Under `set -o pipefail`, a grep with NO match makes the whole
# pipeline exit 1 — and inside a `var="$(pipeline)"` command substitution that
# aborts the entire script under `set -e`. An ABSENT snapshot line (e.g. a
# frozen policy deleted from after.txt) must yield an EMPTY STRING so the
# comparison below can emit the policy-specific FAIL line and reach the
# VERIFICATION FAILED exit-2 verdict — not kill the runner silently.
last_field() { awk -F'|' '{print $NF}'; }
snapshot_md5() { # file, line-prefix
  grep -F "$2" "$1" | head -n 1 | last_field || true
}

for view in market_listings_summary v_market_listings v_market_properties; do
  before_md5="$(snapshot_md5 "$OUTDIR/before.txt" "VIEW|$view|")"
  after_md5="$(snapshot_md5 "$OUTDIR/after.txt" "VIEW|$view|")"
  if [ -n "$before_md5" ] && [ "$before_md5" = "$after_md5" ]; then
    echo "CHECK|view body md5 unchanged for $view|PASS|md5=$after_md5" >> "$VERIFY_FILE"
  else
    echo "CHECK|view body md5 unchanged for $view|FAIL|before=$before_md5 after=$after_md5" >> "$VERIFY_FILE"
  fi
done

# All FOUR frozen_* policies must be byte-identical between before.txt and
# after.txt, on BOTH the USING qual and the WITH CHECK expression. The SQL
# check above asserts only that all four names are present; this is the
# expression-level comparison. (frozen_insert's polqual is NULL — its real
# expression lives in polwithcheck, which the snapshot now hashes too.)
frozen_policy_lines() { # file — the POLICY| lines for the four frozen_* policies, sorted
  # `|| true`: see the pipefail note above — a file with no matching policy
  # lines must yield an empty result, not abort the script.
  grep -E '^POLICY\|frozen_(view|insert|update|delete)\|' "$1" | sort || true
}
frozen_before="$(frozen_policy_lines "$OUTDIR/before.txt")"
frozen_after="$(frozen_policy_lines "$OUTDIR/after.txt")"
if [ -n "$frozen_before" ] && [ "$frozen_before" = "$frozen_after" ]; then
  echo "CHECK|frozen_* policies (all four, qual + with-check) unchanged|PASS|4 policies byte-identical" >> "$VERIFY_FILE"
else
  echo "CHECK|frozen_* policies (all four, qual + with-check) unchanged|FAIL|before/after policy sets differ" >> "$VERIFY_FILE"
  for pol in frozen_view frozen_insert frozen_update frozen_delete; do
    # `|| true`: see the pipefail note above — a policy ABSENT from either
    # snapshot must come back as an empty string so the comparison below
    # emits 'CHECK|frozen policy differs: <name>|FAIL|before=[...] after=[]'
    # and the run still ends in VERIFICATION FAILED (exit 2).
    b="$(grep -F "POLICY|$pol|" "$OUTDIR/before.txt" | head -n 1 || true)"
    a="$(grep -F "POLICY|$pol|" "$OUTDIR/after.txt" | head -n 1 || true)"
    if [ "$b" != "$a" ]; then
      echo "CHECK|frozen policy differs: $pol|FAIL|before=[$b] after=[$a]" >> "$VERIFY_FILE"
    fi
  done
fi

# 7c. NEW-policy predicate assertions — EXACT normalized-expression
# comparison against the allowlists declared at the top of Step 7.
# Substring/token tests are NOT sufficient: `USING (true OR
# wassell_view_scope_class(...) = 'all')` contains every token such a check
# looks for, omits wassell_can_view_jsonb, and passes while exposing every
# row (the deny policy has the same weakness with `true OR ... <> 'none'`).
# The observed pg_get_expr rendering is normalized (whitespace runs
# collapsed to one space, trimmed) and must equal one of the allowlisted
# strings byte-for-byte.
normalize_expr() {
  printf '%s' "$1" | tr -s '[:space:]' ' ' | sed -e 's/^ //' -e 's/ $//'
}

check_policy_predicate() { # policy-name, then the allowlist entries for it
  local pol="$1"; shift
  local observed observed_norm expected pred_rc
  set +e
  observed="$(psql "$PGURL" -v ON_ERROR_STOP=1 -tA -c "
SELECT pg_get_expr(p.polqual, p.polrelid)
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'market_listings'
  AND p.polname = '$pol'" 2>> "$VERIFY_ERROR_FILE")"
  pred_rc=$?
  set -e
  if [ "$pred_rc" -ne 0 ]; then
    verification_query_failed "the per-policy predicate query for $pol (exit $pred_rc)"
  fi
  observed_norm="$(normalize_expr "$observed")"
  for expected in "$@"; do
    if [ "$observed_norm" = "$expected" ]; then
      echo "CHECK|policy $pol predicate exactly matches an allowed rendering|PASS|qual=$observed_norm" >> "$VERIFY_FILE"
      return 0
    fi
  done
  {
    echo "CHECK|policy $pol predicate exactly matches an allowed rendering|FAIL|observed normalized qual=[$observed_norm]"
    echo "CHECK-DETAIL|$pol: the observed predicate is NOT one of the exact allowed"
    echo "  renderings. A rendering difference (e.g. another PostgreSQL major version"
    echo "  pretty-prints the same predicate differently) must be reviewed BY A HUMAN"
    echo "  and, only if genuinely equivalent, added to the allowlist in this script."
    echo "  NEVER assume an unmatched predicate is safe — a broadened predicate such"
    echo "  as (true OR wassell_view_scope_class(...) = 'all') exposes every row."
  } >> "$VERIFY_FILE"
}

check_policy_predicate market_listings_view_fast "${EXPECTED_QUAL_FAST[@]}"
check_policy_predicate market_listings_view_deny_none "${EXPECTED_QUAL_DENY_NONE[@]}"

echo "-------------------------------------------------------------------"
cat "$VERIFY_FILE"
echo "-------------------------------------------------------------------"

# --- Step 8: verdict (psql exited 0) -----------------------------------------
if grep -q '|FAIL|' "$VERIFY_FILE"; then
  echo "===================================================================" >&2
  echo "VERIFICATION FAILED - REVIEW IMMEDIATELY" >&2
  echo "psql exited 0 (the migration committed), but at least one" >&2
  echo "verification check failed. Evidence dir: $OUTDIR" >&2
  echo "  before.txt / after.txt / diff.txt / apply.log / verify.txt" >&2
  echo "Rollback command:" >&2
  echo "  $ROLLBACK_CMD" >&2
  echo "===================================================================" >&2
  exit 2
fi

echo "==================================================================="
echo "APPLIED AND VERIFIED"
echo "Evidence dir: $OUTDIR"
echo "  before.txt / after.txt / diff.txt / apply.log / verify.txt"
echo "Rollback command (if ever needed):"
echo "  $ROLLBACK_CMD"
echo "==================================================================="
