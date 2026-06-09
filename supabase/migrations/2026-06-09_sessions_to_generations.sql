-- ============================================================================
-- 2026-06-09: Image Chats v2 → v3 data migration (messages → generations)
-- ----------------------------------------------------------------------------
-- Reshapes each Creative Session record from the v2 chat shape
-- (record.data.messages[]) into the v3 workspace shape
-- (record.data.generations[]). Each user+assistant message PAIR becomes one
-- Generation; the assistant outputs are carried as INLINE output_urls (these
-- predate the media_assets library — new generations create first-class
-- media_assets rows, migrated ones stay viewable via output_urls). The
-- original messages are stashed under `_legacy_messages` as a one-release
-- safety net (drop in a later migration once the workspace is confirmed).
--
-- IDEMPOTENT: only processes sessions that still have `messages` and do NOT yet
-- have `generations`. Re-running is a no-op.
--
-- ⚠️  RUN AT CUTOVER (with the v3 endpoint + UI deploy). Running it while prod
-- still serves the v2 chat UI would hide existing sessions (the v2 UI reads
-- `messages`, which this moves to `_legacy_messages`).
-- ============================================================================

DO $$
DECLARE
  v_model_id uuid;
  r record;
  msgs jsonb;
  gens jsonb;
  i int;
  n int;
  um jsonb;
  am jsonb;
  gen jsonb;
  prev_gen_id text;
  has_assistant boolean;
BEGIN
  SELECT id INTO v_model_id FROM public.models WHERE name = 'image_chats';
  IF v_model_id IS NULL THEN
    RAISE NOTICE 'image_chats model not found — nothing to migrate';
    RETURN;
  END IF;

  FOR r IN
    SELECT id, data FROM public.records
     WHERE model_id = v_model_id
       AND data ? 'messages'
       AND NOT (data ? 'generations')
  LOOP
    msgs := COALESCE(r.data->'messages', '[]'::jsonb);
    gens := '[]'::jsonb;
    prev_gen_id := NULL;
    i := 0;
    n := jsonb_array_length(msgs);

    WHILE i < n LOOP
      um := msgs->i;
      IF (um->>'role') = 'user' THEN
        IF i + 1 < n AND (msgs->(i + 1)->>'role') = 'assistant' THEN
          am := msgs->(i + 1);
          has_assistant := true;
        ELSE
          am := NULL;
          has_assistant := false;
        END IF;

        gen := jsonb_strip_nulls(jsonb_build_object(
          'id', COALESCE(am->>'id', gen_random_uuid()::text),
          'prompt', COALESCE(um->>'text', ''),
          'reference_urls', COALESCE(
            (SELECT jsonb_agg(img->>'url')
               FROM jsonb_array_elements(COALESCE(um->'images', '[]'::jsonb)) img),
            '[]'::jsonb),
          'reference_asset_ids', '[]'::jsonb,
          'preset_id', NULLIF(um->>'preset_id', ''),
          'preset_name', NULLIF(um->>'preset_name', ''),
          'model_id', COALESCE(r.data->>'last_model', 'nano-banana'),
          'aspect_ratio', COALESCE(am->>'aspect_ratio', um->>'aspect_ratio', '1:1'),
          'num_variations', COALESCE((am->>'num_variations')::int, 1),
          'based_on', prev_gen_id,
          'status', CASE WHEN has_assistant THEN COALESCE(am->>'status', 'completed') ELSE 'failed' END,
          'job_id', am->>'job_id',
          'output_urls', COALESCE(
            (SELECT jsonb_agg(img->>'url')
               FROM jsonb_array_elements(COALESCE(am->'images', '[]'::jsonb)) img),
            '[]'::jsonb),
          'output_asset_ids', '[]'::jsonb,
          'created_at', COALESCE(am->>'created_at', um->>'created_at', now()::text)
        ));

        gens := gens || gen;
        prev_gen_id := gen->>'id';
        IF has_assistant THEN i := i + 2; ELSE i := i + 1; END IF;
      ELSE
        -- stray assistant with no preceding user (shouldn't happen) — skip
        i := i + 1;
      END IF;
    END LOOP;

    UPDATE public.records
       SET data = (r.data - 'messages' - 'status' - 'error_message')
                  || jsonb_build_object(
                       'generations', gens,
                       'generation_count', jsonb_array_length(gens),
                       '_legacy_messages', msgs,
                       'last_generation_at', COALESCE(r.data->>'last_message_at', now()::text),
                       -- thumbnail = the latest generation's first output url
                       'thumbnail_url', (gens->(jsonb_array_length(gens) - 1)->'output_urls'->>0)
                     )
     WHERE id = r.id;
  END LOOP;
END $$;
