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
#       ROLLED BACK (clean)         exit 1  (psql nonzero, after == before)
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
       AND pg_get_function_identity_arguments(p.oid) = 'uuid, uuid')
    OR
    (p.proname = 'wassell_can_view_jsonb'
       AND pg_get_function_identity_arguments(p.oid) = 'uuid, uuid, uuid, uuid, jsonb')
  )
UNION ALL
SELECT 'ACL|' || table_name || '|' || grantee || '|'
    || string_agg(privilege_type, ',' ORDER BY privilege_type)
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated', 'service_role')
  AND table_name IN ('market_listings_summary', 'v_market_listings',
                     'v_market_properties', 'market_listings')
GROUP BY table_name, grantee
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

# --- Nonzero-psql classification (skip the end-state verification: it checks
# --- the APPLIED end state, which is only meaningful when psql exited 0) ---
if [ "$apply_rc" -ne 0 ]; then
  if cmp -s "$OUTDIR/before.txt" "$OUTDIR/after.txt"; then
    echo "==================================================================="
    echo "ROLLED BACK (clean)"
    echo "psql exited $apply_rc, and after.txt is byte-identical to"
    echo "before.txt: the migration is transactional and self-aborting"
    echo "(ON_ERROR_STOP aborts on the first failing statement), so no"
    echo "change persisted."
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
# Verifies the APPLIED end state: structural SQL checks, view-body md5s, and
# ALL FOUR frozen_* policies (frozen_view, frozen_insert, frozen_update,
# frozen_delete) compared byte-identical between before.txt and after.txt on
# BOTH the USING qual AND the WITH CHECK expression (frozen_insert is a
# WITH CHECK policy whose polqual is NULL — comparing only polqual would
# never capture its real expression).
echo ">>> Step 7: end-state verification -> $OUTDIR/verify.txt"
VERIFY_FILE="$OUTDIR/verify.txt"
: > "$VERIFY_FILE"

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
SELECT 'CHECK|acl authenticated on market_listings_summary is exactly SELECT|'
    || CASE WHEN coalesce(string_agg(privilege_type, ',' ORDER BY privilege_type), '(none)') = 'SELECT'
            THEN 'PASS' ELSE 'FAIL' END
    || '|privs=' || coalesce(string_agg(privilege_type, ',' ORDER BY privilege_type), '(none)')
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'market_listings_summary'
  AND grantee = 'authenticated'
UNION ALL
SELECT 'CHECK|acl anon has NO privileges on the three views|'
    || CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END
    || '|grant_rows=' || count(*)
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND grantee = 'anon'
  AND table_name IN ('market_listings_summary', 'v_market_listings', 'v_market_properties')
UNION ALL
SELECT 'CHECK|acl service_role retains SELECT on ' || v.t || '|'
    || CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.role_table_grants g
         WHERE g.table_schema = 'public' AND g.table_name = v.t
           AND g.grantee = 'service_role' AND g.privilege_type = 'SELECT')
       THEN 'PASS' ELSE 'FAIL' END
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

psql "$PGURL" -v ON_ERROR_STOP=1 -tA -c "$VERIFY_SQL" >> "$VERIFY_FILE"

# 7b. Cross-snapshot checks (bash): md5s that must be UNCHANGED vs BEFORE.
last_field() { awk -F'|' '{print $NF}'; }
snapshot_md5() { # file, line-prefix
  grep -F "$2" "$1" | head -n 1 | last_field
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
  grep -E '^POLICY\|frozen_(view|insert|update|delete)\|' "$1" | sort
}
frozen_before="$(frozen_policy_lines "$OUTDIR/before.txt")"
frozen_after="$(frozen_policy_lines "$OUTDIR/after.txt")"
if [ -n "$frozen_before" ] && [ "$frozen_before" = "$frozen_after" ]; then
  echo "CHECK|frozen_* policies (all four, qual + with-check) unchanged|PASS|4 policies byte-identical" >> "$VERIFY_FILE"
else
  echo "CHECK|frozen_* policies (all four, qual + with-check) unchanged|FAIL|before/after policy sets differ" >> "$VERIFY_FILE"
  for pol in frozen_view frozen_insert frozen_update frozen_delete; do
    b="$(grep -F "POLICY|$pol|" "$OUTDIR/before.txt" | head -n 1)"
    a="$(grep -F "POLICY|$pol|" "$OUTDIR/after.txt" | head -n 1)"
    if [ "$b" != "$a" ]; then
      echo "CHECK|frozen policy differs: $pol|FAIL|before=[$b] after=[$a]" >> "$VERIFY_FILE"
    fi
  done
fi

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
