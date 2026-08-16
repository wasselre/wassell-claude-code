#!/usr/bin/env bash
# =============================================================================
# CI: 2026-09-05_08_market_raw_storage.sql — Storage RLS proof at the DB layer.
#
# CI cannot reach the real Storage HTTP API, so this proves the half that lives
# in Postgres: the policy predicates themselves, evaluated as each identity.
# The HTTP half (upsert/move/copy/signed URL) is proven by the production canary
# scripts/market-raw-canary.mjs, which is run once after apply.
# =============================================================================
set -euo pipefail
MIG=supabase/migrations/2026-09-05_08_market_raw_storage.sql
: "${PGURL:?PGURL required}"
[ -f "$MIG" ] || { echo "missing $MIG" >&2; exit 1; }
DB=t_marketraw
UID_UP=a994dfda-1723-481f-9bc7-701843b07d45
UID_ADMIN=11111111-1111-1111-1111-111111111111
UID_OTHER=22222222-2222-2222-2222-222222222222
psql -w "$PGURL" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $DB"
psql -w "$PGURL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $DB"
U="${PGURL%/*}/$DB"

psql -w "$U" -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN NOBYPASSRLS; END IF;
END \$\$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  \$\$ SELECT nullif(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid \$\$;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id),
  name text, owner_id uuid, created_at timestamptz DEFAULT now(), UNIQUE (bucket_id, name));
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
-- Schema USAGE is REQUIRED or every negative test below would pass for the
-- wrong reason: 'permission denied for schema storage' instead of an RLS
-- refusal. Granting it makes the policy the only thing that can refuse.
GRANT USAGE ON SCHEMA storage TO anon, authenticated;
GRANT ALL ON storage.objects, storage.buckets TO anon, authenticated;
CREATE TABLE public.test_admin (user_id uuid PRIMARY KEY);
INSERT INTO public.test_admin VALUES ('$UID_ADMIN');
CREATE OR REPLACE FUNCTION public.wassell_is_admin(u uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
  AS \$\$ SELECT EXISTS (SELECT 1 FROM public.test_admin WHERE user_id=u) \$\$;
SQL

echo '== applying 2026-09-05_08'
psql -w "$U" -v ON_ERROR_STOP=1 -q -f "$MIG"
echo '== re-applying (idempotency)'
psql -w "$U" -v ON_ERROR_STOP=1 -q -f "$MIG"

psql -w "$U" -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
DECLARE n int;
BEGIN
  -- policy surface
  SELECT count(*) INTO n FROM pg_policy WHERE polrelid='storage.objects'::regclass;
  IF n <> 2 THEN RAISE EXCEPTION 'expected exactly 2 policies, found %', n; END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polcmd IN ('w','d'))
    THEN RAISE EXCEPTION 'an UPDATE/DELETE policy exists — immutability broken'; END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id='market-raw' AND NOT public)
    THEN RAISE EXCEPTION 'bucket missing or public'; END IF;
  RAISE NOTICE 'policy surface OK: 2 policies, no UPDATE/DELETE, bucket private';
END \$\$;

-- uploader CAN insert a well-formed content-addressed key
SET LOCAL request.jwt.claims = '{"sub":"$UID_UP"}';
SET LOCAL ROLE authenticated;
INSERT INTO storage.objects (bucket_id,name,owner_id) VALUES ('market-raw','canary/$(printf 'a%.0s' {1..64})','$UID_UP');
RESET ROLE;
SQL

fails=0
try_fail() { # label, sql
  if psql -w "$U" -v ON_ERROR_STOP=1 -q -c "$2" >/dev/null 2>&1; then
    echo "  FAIL  $1 (was allowed)"; fails=$((fails+1)); else echo "  PASS  $1 (refused)"; fi
}
CL="SET LOCAL request.jwt.claims"
try_fail "uploader cannot insert a non-content-addressed key" \
  "BEGIN; $CL='{\"sub\":\"$UID_UP\"}'; SET LOCAL ROLE authenticated; INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES('market-raw','not-content-addressed','$UID_UP'); COMMIT;"
try_fail "uploader cannot insert into another bucket" \
  "BEGIN; $CL='{\"sub\":\"$UID_UP\"}'; SET LOCAL ROLE authenticated; INSERT INTO storage.buckets(id,name) VALUES('other','other') ON CONFLICT DO NOTHING; INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES('other','canary/$(printf 'b%.0s' {1..64})','$UID_UP'); COMMIT;"
try_fail "a NORMAL authenticated user cannot insert" \
  "BEGIN; $CL='{\"sub\":\"$UID_OTHER\"}'; SET LOCAL ROLE authenticated; INSERT INTO storage.objects(bucket_id,name,owner_id) VALUES('market-raw','canary/$(printf 'c%.0s' {1..64})','$UID_OTHER'); COMMIT;"
# UPDATE/DELETE under RLS with NO matching policy do not ERROR — they affect
# ZERO ROWS and return success. Asserting "the statement failed" would be a
# false signal. The correct proof is that the object is still there, unmodified.
# (The Storage HTTP API turns a zero-row result into an error; that half is
# proven by scripts/market-raw-canary.mjs against production.)
OBJNAME="canary/$(printf 'a%.0s' {1..64})"
mutate() { psql -w "$U" -qAt -c "BEGIN; $CL='{\"sub\":\"$1\"}'; SET LOCAL ROLE authenticated; $2; COMMIT;" 2>&1 | tail -1; }
survives() { psql -w "$U" -qAt -c "SELECT count(*) FROM storage.objects WHERE bucket_id='market-raw' AND name='$OBJNAME'" | tail -1; }

for spec in "$UID_UP|UPDATE storage.objects SET name='TAMPERED' WHERE bucket_id='market-raw'|uploader UPDATE"             "$UID_UP|DELETE FROM storage.objects WHERE bucket_id='market-raw'|uploader DELETE"             "$UID_ADMIN|DELETE FROM storage.objects WHERE bucket_id='market-raw'|admin DELETE"             "$UID_OTHER|UPDATE storage.objects SET name='TAMPERED' WHERE bucket_id='market-raw'|normal-user UPDATE"; do
  IFS='|' read -r uid sql label <<<"$spec"
  res=$(mutate "$uid" "$sql")
  n=$(survives)
  if [ "$n" = "1" ]; then echo "  PASS  $label affected 0 rows; object intact ($res)";
  else echo "  FAIL  $label changed the object (survivors=$n)"; fails=$((fails+1)); fi
done

# And the row is byte-identical to what was inserted.
[ "$(psql -w "$U" -qAt -c "SELECT owner_id::text FROM storage.objects WHERE name='$OBJNAME'")" = "$UID_UP" ]   && echo "  PASS  owner_id equals the dedicated uploader uid"   || { echo "  FAIL  owner_id mismatch"; fails=$((fails+1)); }

row_count() { psql -w "$U" -qAt -c "BEGIN; SET LOCAL request.jwt.claims='{\"sub\":\"$1\"}'; SET LOCAL ROLE authenticated; SELECT count(*) FROM storage.objects WHERE bucket_id='market-raw'; COMMIT;" | tail -1; }
[ "$(row_count $UID_ADMIN)" = "1" ] && echo "  PASS  admin can read the object" || { echo "  FAIL  admin cannot read"; fails=$((fails+1)); }
[ "$(row_count $UID_OTHER)" = "0" ] && echo "  PASS  normal authenticated user reads 0 rows" || { echo "  FAIL  non-admin can read"; fails=$((fails+1)); }
[ "$(row_count $UID_UP)"    = "0" ] && echo "  PASS  uploader has NO read access (write-only, as designed)" || { echo "  NOTE  uploader can read — narrow SELECT policy present"; }

psql -w "$PGURL" -q -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1 || true
[ "$fails" -eq 0 ] && echo "All market-raw storage tests passed" || { echo "$fails failure(s)"; exit 1; }
