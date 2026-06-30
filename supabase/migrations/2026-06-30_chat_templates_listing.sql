-- ============================================================================
-- 2026-06-30: Listing message templates — clean-text generation queue + link
-- ----------------------------------------------------------------------------
-- Extends the existing `chat_templates` message-templates module so a message
-- (text + AI-cleaned photos) can be generated from a Market Listing and saved
-- as a reusable, listing-linked template. Three changes, all additive:
--
--   1. chat_templates.schema gains a `listing_id` lookup (→ market_listings),
--      the listing twin of the existing `project_id` lookup (→ all_projects).
--      Surfaces the link in the Builder + v_chat_templates view + generated PRD.
--      (The `images`, `status`, and `cleaning` operational keys the generate
--      flow writes into records.data are owned by the custom ChatTemplateForm /
--      ListingMessageModal UI — NOT Builder fields — so they stay schema-less.)
--
--   2. generation_jobs.kind CHECK gains 'clean-text' so the SAME queue + Fly
--      worker that drains image-chat jobs also drains per-photo text-removal
--      jobs (one job per listing photo, fanned out in parallel). claim/complete/
--      fail already key off p_kind / status — no other RPC changes.
--
--   3. generation_jobs_watchdog() is extended ADDITIVELY to also patch a
--      records.data.cleaning[] shape (the clean-text draft), so a hard worker
--      crash mid-clean exits the per-photo spinner — exactly as it already does
--      for the data.messages[] shape. The messages branch is byte-identical to
--      before; the cleaning branch is new and guarded by `r.data ? 'cleaning'`,
--      and the two record shapes are disjoint (a record is either an image-chat
--      conversation OR a chat_templates draft), so neither double-patches.
--
-- Clean-text jobs set generation_jobs.message_id = the cleaning entry id
-- (records.data.cleaning[*].id) that the worker fills; generation_id stays null.
--
-- Idempotent: the schema append is WHERE-guarded; the CHECK is dropped/re-added;
-- the function is CREATE OR REPLACE.
-- ============================================================================

BEGIN;

-- ── 1. chat_templates.schema += listing_id (lookup → market_listings) ──────
UPDATE public.models
SET schema = jsonb_set(
      schema,
      '{sections,0,fields}',
      (schema->'sections'->0->'fields') || jsonb_build_object(
        'id', gen_random_uuid()::text,
        'name', 'listing_id',
        'label_ar', 'إعلان السوق',
        'label_en', 'Market Listing',
        'type', 'lookup',
        'required', false,
        'order', 11,
        'section_id', (schema->'sections'->0->>'id'),
        'width', 'half',
        'show_in_table', true,
        'lookup_model_id', (SELECT id::text FROM public.models WHERE name = 'market_listings'),
        'lookup_display_field', 'title'
      )
    ),
    updated_at = now()
WHERE name = 'chat_templates'
  AND NOT ((schema->'sections'->0->'fields') @> '[{"name":"listing_id"}]'::jsonb);

-- ── 2. generation_jobs.kind += 'clean-text' ───────────────────────────────
ALTER TABLE public.generation_jobs
  DROP CONSTRAINT IF EXISTS generation_jobs_kind_check;
ALTER TABLE public.generation_jobs
  ADD  CONSTRAINT generation_jobs_kind_check
  CHECK (kind IN ('image','video','audio','clean-text'));

-- ── 3. Watchdog: also exit the clean-text per-photo spinner on a crash ─────
-- Byte-identical messages branch + a new, disjoint cleaning branch.
CREATE OR REPLACE FUNCTION public.generation_jobs_watchdog()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count int  := 0;
  v_msg   text := 'watchdog: generation did not finish within 15 minutes — likely crashed mid-run. Press Retry to try again.';
BEGIN
  WITH stale AS (
    UPDATE public.generation_jobs
       SET status      = 'failed',
           finished_at = now(),
           error       = v_msg
     WHERE status = 'running'
       AND started_at < now() - interval '15 minutes'
    RETURNING id, record_id, message_id
  ),
  -- Group stale message ids per record so each record is patched once and ALL
  -- its stale items flip to failed.
  by_record AS (
    SELECT record_id, array_agg(message_id) AS msg_ids
      FROM stale
     GROUP BY record_id
  ),
  -- Image-chat conversations: patch data.messages[*] (UNCHANGED).
  recs AS (
    UPDATE public.records r
       SET data = jsonb_set(r.data, '{messages}', (
             SELECT jsonb_agg(
               CASE WHEN msg->>'id' = ANY(b.msg_ids)
                    THEN msg || jsonb_build_object('status','failed','error',v_msg)
                    ELSE msg END)
             FROM jsonb_array_elements(r.data->'messages') AS msg
           ), true),
           updated_at = now()
      FROM by_record b
     WHERE r.id = b.record_id
       AND r.data ? 'messages'
    RETURNING 1
  ),
  -- Clean-text drafts: patch data.cleaning[*] (NEW — disjoint from messages).
  recs_cleaning AS (
    UPDATE public.records r
       SET data = jsonb_set(r.data, '{cleaning}', (
             SELECT jsonb_agg(
               CASE WHEN c->>'id' = ANY(b.msg_ids)
                    THEN c || jsonb_build_object('status','failed','error',v_msg)
                    ELSE c END)
             FROM jsonb_array_elements(r.data->'cleaning') AS c
           ), true),
           updated_at = now()
      FROM by_record b
     WHERE r.id = b.record_id
       AND r.data ? 'cleaning'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_count FROM stale;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.generation_jobs_watchdog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generation_jobs_watchdog() TO service_role;

COMMIT;
