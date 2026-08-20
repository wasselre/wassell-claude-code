-- ============================================================================
-- Phase 3 · B7 — a content digest every file actually has
--
-- B1 added `files.checksum_sha256` and said plainly why it was empty:
-- "Intentionally NULL for pre-B7 rows: back-computing it would mean
-- downloading 6.3 GB of production objects." That is true, and it left
-- duplicate detection theoretical — the Library's "duplicate" filter and its
-- health facet both key off that column, so both have always answered ZERO.
--
-- ── THE DIGEST WAS ALREADY IN THE DATABASE ────────────────────────────────
-- Supabase Storage records an eTag per object in `storage.objects.metadata`,
-- and for an ordinary single-part upload that eTag IS the MD5 of the content.
-- It costs nothing to read: no downloads, no worker, no browser hashing.
--
-- Measured on production before writing this:
--
--     objects in wassel-files                8,414
--     plain 32-hex content MD5               8,298   (98.6%)
--     multipart eTags (`<hash>-<parts>`)       116   (NOT a content hash)
--
--     business files matched to a digest     7,417 of 7,542  (98.3%)
--     duplicate groups                       1,392
--     files sitting in a duplicate group     2,975
--     redundant copies                       1,583
--     storage wasted by them                 922 MB  (14% of the corpus)
--
-- ── WHY NOT SHA-256 IN THE BROWSER ────────────────────────────────────────
-- WebCrypto can do SHA-256 but deliberately omits MD5, so a browser could hash
-- a NEW upload but could never produce a key comparable to the 7,417 files
-- already here. That would give two dedup keys and a permanent seam between
-- "files from before B7" and "files after", which is exactly the kind of split
-- that later reads as a bug.
--
-- Letting the STORAGE BACKEND be the single hashing authority removes that
-- seam: old and new files get their digest from the same computation, and the
-- client never reads a 43 MB file into memory to hash it.
--
-- ── WHAT THIS IS AND IS NOT ───────────────────────────────────────────────
-- MD5 is not collision-resistant against an ADVERSARY. This is not a security
-- control — it answers "did someone upload this same file twice", and it is
-- paired with `size_bytes` everywhere it is used, so an accidental collision
-- would have to match both. `checksum_sha256` is left in place, untouched and
-- still NULL, for a future stronger check; nothing reads it after this.
--
-- The 116 multipart objects get NULL. Their eTag is a hash OF HASHES and is
-- only comparable to another upload with byte-identical part boundaries, which
-- is not a property we control. A NULL digest simply means "not dedup-able
-- yet" and is honest; inventing a key for them would produce false pairs.
--
-- Idempotent. Rollback: supabase/rollback/2026-08-19_13_file_content_etag_down.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The column.
--
--    NOT called `checksum_md5`: it is specifically the digest the STORAGE
--    backend reports for this object, and naming it after its source is what
--    tells the next reader where it comes from and why it may be absent.
-- ---------------------------------------------------------------------------
ALTER TABLE public.files ADD COLUMN IF NOT EXISTS content_etag text;

COMMENT ON COLUMN public.files.content_etag IS
  'Content digest as reported by Supabase Storage (MD5 for single-part uploads). The operative duplicate-detection key, always paired with size_bytes. NULL for multipart uploads, whose eTag is a hash of hashes and is not a content digest. Not a security control — see the B7 migration header.';

-- Partial: two thirds of the point is finding SAME-digest rows, and a NULL
-- digest can never match one.
CREATE INDEX IF NOT EXISTS idx_files_content_etag
  ON public.files (content_etag, size_bytes) WHERE content_etag IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Backfill from storage metadata.
--
--    `files.storage_path` is `storage.objects.name` — the join that produced
--    the 7,417 figure above.
--
--    SAFE UNDER PHASE 2, for the same reason B1's backfill was:
--    tg_files_sync_file_links() exits on its first test unless model_id or
--    record_id changed. This touches neither, so it marks NOTHING dirty, takes
--    no projection lock, and cannot block a concurrent writer.
--
--    UPDATED_AT IS HISTORY. `files` carries files_set_updated_at, an
--    unconditional `NEW.updated_at = now()`, so this would stamp today onto
--    7,417 rows and destroy a real three-month spread. The trigger is disabled
--    BY NAME for the backfill and restored to its exact prior state — NOT via
--    session_replication_role, which would also silence Phase 2's sync trigger
--    and turn a metadata backfill into a silent projection-divergence bug.
--    (Both lessons are B1's, paid for once already.)
-- ---------------------------------------------------------------------------
DO $ts$
DECLARE v_state "char";
BEGIN
  SELECT t.tgenabled INTO v_state
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.files'::regclass
     AND t.tgname  = 'files_set_updated_at'
     AND NOT t.tgisinternal;
  IF v_state IS NULL THEN
    PERFORM set_config('wassell.b7_updated_at_tg', 'absent', true);
  ELSE
    PERFORM set_config('wassell.b7_updated_at_tg', v_state::text, true);
    ALTER TABLE public.files DISABLE TRIGGER files_set_updated_at;
  END IF;
END $ts$;

UPDATE public.files f
   SET content_etag = e.etag
  FROM (
    SELECT o.name,
           replace(o.metadata->>'eTag', '"', '') AS etag
      FROM storage.objects o
     WHERE o.bucket_id = 'wassel-files'
       AND o.metadata ? 'eTag'
       -- Plain content MD5 only. A multipart eTag carries a `-<parts>` suffix
       -- and is not a digest of the content.
       AND replace(o.metadata->>'eTag', '"', '') ~ '^[0-9a-f]{32}$'
  ) e
 WHERE e.name = f.storage_path
   AND f.content_etag IS DISTINCT FROM e.etag;

DO $ts$
DECLARE v_state text := current_setting('wassell.b7_updated_at_tg', true);
BEGIN
  IF v_state IS NULL OR v_state = 'absent' THEN RETURN;
  ELSIF v_state = 'O' THEN ALTER TABLE public.files ENABLE TRIGGER files_set_updated_at;
  ELSIF v_state = 'R' THEN ALTER TABLE public.files ENABLE REPLICA TRIGGER files_set_updated_at;
  ELSIF v_state = 'A' THEN ALTER TABLE public.files ENABLE ALWAYS TRIGGER files_set_updated_at;
  ELSIF v_state = 'D' THEN NULL;                    -- was already disabled
  ELSE RAISE EXCEPTION 'B7: unknown prior tgenabled state % for files_set_updated_at', v_state;
  END IF;
END $ts$;

-- Self-enforcing guard: abort rather than commit a database whose timestamp
-- trigger is silently off, which is a far quieter bug than the one above.
DO $ts$
DECLARE v_state "char"; v_expected text := current_setting('wassell.b7_updated_at_tg', true);
BEGIN
  IF v_expected IS NULL OR v_expected = 'absent' THEN RETURN; END IF;
  SELECT t.tgenabled INTO v_state
    FROM pg_trigger t
   WHERE t.tgrelid='public.files'::regclass AND t.tgname='files_set_updated_at'
     AND NOT t.tgisinternal;
  IF v_state IS DISTINCT FROM v_expected::"char" THEN
    RAISE EXCEPTION 'B7: files_set_updated_at is % after the backfill, expected %',
      coalesce(v_state::text,'<missing>'), v_expected;
  END IF;
END $ts$;

-- ---------------------------------------------------------------------------
-- 3. Teach business_files_search to use it.
--
--    The `duplicate` filter and the `health.duplicate` facet both keyed off
--    checksum_sha256, which is NULL for every row in the database — so the
--    Library's duplicate toggle has always shown 0 and filtered to nothing.
--    A control that cannot ever do anything is worse than an absent one: it
--    reads as "there are no duplicates here", and there are 1,583.
--
--    Both now key off content_etag AND size_bytes. Only these two predicates
--    change; the function is otherwise re-emitted verbatim from the live
--    definition, and the smoke asserts the row set is identical for every
--    query that does NOT use the duplicate flag.
-- ---------------------------------------------------------------------------
DO $fn$
DECLARE v_src text; v_new text; v_step text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='business_files_search';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'B7: business_files_search not found -- apply B2 first';
  END IF;

  -- Idempotent re-apply.
  IF position('content_etag' in v_src) > 0 THEN
    RAISE NOTICE 'B7: business_files_search already uses content_etag';
    RETURN;
  END IF;

  -- ── WHY THESE ARE REGEX AND NOT PLAIN replace() ──────────────────────────
  -- The first version of this block used replace() with multi-line string
  -- literals copied from the B2 migration. Two of the three silently did
  -- NOTHING, and the migration reported success: this repository's .sql files
  -- are stored with CRLF line endings, so a literal spanning lines contains
  -- \r\n, while the body returned by pg_get_functiondef contains \n. The
  -- single-LINE replacement matched; both multi-line ones could not.
  --
  -- Nothing raised, because the guard only asked whether the text had changed
  -- AT ALL -- and it had, thanks to the one that worked. The Library would
  -- have shipped with a duplicate filter that still answered zero against
  -- 2,975 real duplicates.
  --
  -- So: match on \s+ rather than on literal whitespace, and guard EVERY step
  -- separately. A single end-guard cannot tell "three of three" from "one of
  -- three".

  -- 1. `base` is a CTE with an explicit column list; the facet subqueries can
  --    only read what it projects.
  v_new := replace(v_src,
    'fi.archived_at, fi.checksum_sha256,',
    'fi.archived_at, fi.checksum_sha256, fi.content_etag,');
  IF v_new = v_src THEN
    RAISE EXCEPTION 'B7: could not project content_etag from the base CTE -- business_files_search has drifted';
  END IF;

  -- 2. The `duplicate` FILTER.
  v_step := v_new;
  v_new := regexp_replace(v_new,
    'NOT v_dupe OR \(fi\.checksum_sha256 IS NOT NULL AND EXISTS \(\s*SELECT 1 FROM public\.files d\s*WHERE d\.checksum_sha256 = fi\.checksum_sha256 AND d\.id <> fi\.id\)\)',
    'NOT v_dupe OR (fi.content_etag IS NOT NULL AND EXISTS (SELECT 1 FROM public.files d WHERE d.content_etag = fi.content_etag AND d.size_bytes = fi.size_bytes AND d.id <> fi.id))',
    'g');
  IF v_new = v_step THEN
    RAISE EXCEPTION 'B7: could not rewrite the duplicate FILTER predicate -- business_files_search has drifted';
  END IF;

  -- 3. The `health.duplicate` FACET.
  v_step := v_new;
  v_new := regexp_replace(v_new,
    'WHERE b7\.checksum_sha256 IS NOT NULL\s*AND EXISTS \(SELECT 1 FROM public\.files d\s*WHERE d\.checksum_sha256 = b7\.checksum_sha256 AND d\.id <> b7\.id\)',
    'WHERE b7.content_etag IS NOT NULL AND EXISTS (SELECT 1 FROM public.files d WHERE d.content_etag = b7.content_etag AND d.size_bytes = b7.size_bytes AND d.id <> b7.id)',
    'g');
  IF v_new = v_step THEN
    RAISE EXCEPTION 'B7: could not rewrite the duplicate health FACET -- business_files_search has drifted';
  END IF;

  EXECUTE v_new;
END $fn$;

COMMIT;
