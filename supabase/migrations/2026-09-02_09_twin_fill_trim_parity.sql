-- ════════════════════════════════════════════════════════════════════════════
-- W7 fix (bilingual): record_twin_fill source-CAS must trim like JS .trim().
--
-- BUG (found at twin go-live, 2026-08-05): the worker sends
--   p_expected_source_rev = sha256(String(data[src]).trim())      -- JS trim
-- but record_twin_fill computed the CAS hash over btrim(col) — and SQL btrim()
-- with no explicit set strips ONLY ASCII space (0x20), NOT \n \r \t \f \v. So a
-- twin whose authored side has a trailing/leading NEWLINE (common in multi-line
-- WhatsApp templates and social posts) hashes differently on the two sides →
-- CAS 1 fails → record_twin_fill returns false → the fill is silently SKIPPED
-- (worker logs skipped:1, target stays empty). Live evidence: posts_content
-- record 95e07c43 (body_ar ends in "\n") skipped across two backfill runs while
-- clean-ended siblings filled fine.
--
-- FIX: trim the leading/trailing WHITESPACE class ('^\s+' / '\s+$', which in
-- Postgres ARE covers space, tab, newline, CR, form-feed, vertical-tab) on both
-- the source and target comparisons, matching JS .trim() for all realistic
-- content. (Exotic Unicode whitespace — NBSP/BOM/line-sep — is not produced by
-- the composer surfaces that author these fields, so \s parity is sufficient;
-- if it ever appeared it would degrade to the SAME safe skip, never a bad fill.)
--
-- Re-emitted VERBATIM from 2026-09-01_03_translation_queue.sql with ONLY the two
-- trim expressions changed. CAS semantics, the system_write GUC guard, the
-- FOR UPDATE row lock, and the search_path (public, extensions, pg_temp — digest
-- lives in extensions) are all identical. records table exists in the CI
-- ephemeral DB (migration 03 created this function there already), so no
-- check_function_bodies bypass is needed.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.record_twin_fill(
  p_record_id uuid, p_source_path text, p_target_path text, p_value text,
  p_expected_source_rev text, p_expected_target_value text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE v_rec records%ROWTYPE; v_cur_src text; v_cur_tgt text;
BEGIN
  SELECT * INTO v_rec FROM records WHERE id = p_record_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  -- JS-.trim() parity: strip the full \s class at both ends, not just spaces.
  v_cur_src := regexp_replace(regexp_replace(COALESCE(v_rec.data->>p_source_path, ''), '^\s+', ''), '\s+$', '');
  v_cur_tgt := regexp_replace(regexp_replace(COALESCE(v_rec.data->>p_target_path, ''), '^\s+', ''), '\s+$', '');
  -- CAS 1: source unchanged since the translation was produced.
  IF encode(digest(v_cur_src, 'sha256'::text), 'hex') IS DISTINCT FROM p_expected_source_rev THEN
    RETURN false;
  END IF;
  -- CAS 2: target still machine-writable (empty or exactly the previous
  -- machine text). A human edit in the window wins; the fill is discarded.
  IF v_cur_tgt <> '' AND v_cur_tgt IS DISTINCT FROM regexp_replace(regexp_replace(COALESCE(p_expected_target_value,''), '^\s+', ''), '\s+$', '') THEN
    RETURN false;
  END IF;
  PERFORM set_config('wassell.system_write', 'twin_fill', true);   -- txn-local
  UPDATE records SET data = jsonb_set(data, ARRAY[p_target_path], to_jsonb(p_value), true)
  WHERE id = p_record_id;
  PERFORM set_config('wassell.system_write', '', true);
  RETURN true;
END $$;
