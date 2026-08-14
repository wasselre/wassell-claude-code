#!/usr/bin/env bash
# ============================================================================
# Phase 2 authorization-equivalence check.
#
# Phase 2 must change WHO CAN SEE OR DO WHAT: not at all. It adds convergence,
# not access. This snapshots the complete authorization surface of a database
# carrying Phase 1, applies Phase 2, snapshots again, and diffs.
#
# The only permitted difference is the arrival of Phase 2's OWN objects. Any
# change to a pre-existing policy, grant, RLS flag or security-definer function
# is a failure, and the diff is printed so it can be read rather than trusted.
#
# Usage: PGURL=... bash supabase/tests/ci/authz_equivalence_file_link_sync.sh
# ============================================================================
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PGURL="${PGURL:-}"; ADMIN_DB="${ADMIN_DB:-postgres}"; DB=authz_fl

psql_admin(){ if [ -n "$PGURL" ]; then psql "${PGURL%/*}/$ADMIN_DB" "$@"; else psql -d "$ADMIN_DB" "$@"; fi; }
q(){ if [ -n "$PGURL" ]; then psql "${PGURL%/*}/$DB" "$@"; else psql -d "$DB" "$@"; fi; }

SNAPSHOT="
SELECT 'POLICY   '||schemaname||'.'||tablename||' '||policyname||' '||coalesce(cmd,'')||' '||
       coalesce(array_to_string(roles,','),'')||' USING('||coalesce(qual,'')||') CHECK('||coalesce(with_check,'')||')'
  FROM pg_policies WHERE schemaname='public'
UNION ALL
SELECT 'GRANT    '||table_schema||'.'||table_name||' '||grantee||' '||privilege_type
  FROM information_schema.role_table_grants WHERE table_schema='public'
UNION ALL
SELECT 'RLS      '||n.nspname||'.'||c.relname||' rowsecurity='||c.relrowsecurity||' forced='||c.relforcerowsecurity
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind='r'
UNION ALL
SELECT 'FUNCACL  '||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') secdef='||p.prosecdef||
       ' acl='||coalesce(array_to_string(p.proacl::text[],','),'<default>')
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
UNION ALL
SELECT 'TRIGGER  '||n.nspname||'.'||c.relname||' '||t.tgname
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE NOT t.tgisinternal AND n.nspname='public'
ORDER BY 1;"

psql_admin -q -c "DROP DATABASE IF EXISTS $DB (FORCE);" >/dev/null 2>&1
psql_admin -q -c "CREATE DATABASE $DB;" >/dev/null
q -q -v ON_ERROR_STOP=1 -f "$REPO/supabase/tests/ci/fixture_file_links.sql" >/dev/null
q -q -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/2026-08-10_file_links_projection.sql" >/dev/null 2>&1
q -Atc "$SNAPSHOT" > "$TMP/before.txt"

q -q -v ON_ERROR_STOP=1 -f "$REPO/supabase/migrations/2026-08-12_file_link_sync.sql" >/dev/null 2>&1
q -Atc "$SNAPSHOT" > "$TMP/after.txt"

echo "=================================================================="
echo "Phase 2 authorization equivalence"
echo "=================================================================="
echo "authorization surface entries: before=$(wc -l < "$TMP/before.txt")  after=$(wc -l < "$TMP/after.txt")"
echo

REMOVED=$(comm -23 "$TMP/before.txt" "$TMP/after.txt")
ADDED=$(comm -13 "$TMP/before.txt" "$TMP/after.txt")

FAIL=0
if [ -n "$REMOVED" ]; then
  echo "REMOVED / CHANGED (must be empty):"; echo "$REMOVED" | sed 's/^/  /'; FAIL=1
else
  echo "PASS  nothing removed or altered — every pre-existing policy, grant, RLS"
  echo "      flag, function ACL and trigger is byte-identical after Phase 2."
fi
echo
echo "ADDED (Phase 2's own objects only):"
echo "$ADDED" | sed 's/^/  /'

# Every added line must name a Phase 2 object.
STRAY=$(echo "$ADDED" | grep -v -E 'file_link_dirty_targets|file_links_converge_target|file_links_mark_dirty|file_links_drain_dirty|file_links_sync_target|file_links_resync_all|file_link_target_lock_key|file_link_global_lock_key|file_link_bulk_target_threshold|file_link_field_occurrences_scoped|file_link_live_sources_scoped|file_link_field_occurrences|file_link_live_sources|tg_records_sync_file_links|tg_files_sync_file_links|tg_document_links_sync_file_links|tg_mos_assets_sync_file_links|tg_file_links_drain|_sync_file_links|file_link_dirty_drain' || true)
if [ -n "$STRAY" ]; then
  echo; echo "STRAY ADDITIONS (not Phase 2 objects — must be empty):"; echo "$STRAY" | sed 's/^/  /'; FAIL=1
fi

echo
echo "---- anon / authenticated reach into anything Phase 2 created ----"
q -X -c "SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
 WHERE table_schema='public' AND table_name IN ('file_link_dirty_targets','file_links','file_link_sources')
   AND grantee IN ('anon','authenticated') ORDER BY 1,2,3;"

psql_admin -q -c "DROP DATABASE IF EXISTS $DB (FORCE);" >/dev/null 2>&1
echo "=================================================================="
[ "$FAIL" = "0" ] && echo "AUTHORIZATION UNCHANGED" || echo "AUTHORIZATION SURFACE CHANGED — see above"
exit $FAIL
