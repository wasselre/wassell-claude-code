-- First-touch resolution belongs on the IMMUTABLE chat_messages.meta, not the
-- chats record.
-- ============================================================================
-- The chats conversation record's `data` blob is fully rewritten by the SPA
-- store on ordinary actions (list sync, mark-read, relink), which silently drops
-- any server-only key — verified live 2026-08-16: a first_touch stamped on 5
-- conversations was wiped within minutes by an active sales session. chat_messages
-- is never rewritten by the browser, so meta.ad is the durable home. This
-- redefines the self-heal to back-fill meta.ad.resolved on the opening message.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.mos_reresolve_first_touch(p_platform_ad_id text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_resolved jsonb;
  v_count    integer := 0;
BEGIN
  IF p_platform_ad_id IS NULL OR p_platform_ad_id = '' THEN RETURN 0; END IF;

  SELECT to_jsonb(r) - 'project_ids' || jsonb_build_object('resolved_at', now())
    INTO v_resolved
  FROM public.mos_resolve_ad(p_platform_ad_id) r
  LIMIT 1;
  IF v_resolved IS NULL THEN RETURN 0; END IF;

  -- Fill resolved on every opening message that captured this ad id and has not
  -- been resolved yet (key absent OR explicit JSON null).
  UPDATE public.chat_messages
     SET meta = jsonb_set(meta, '{ad,resolved}', v_resolved, true)
   WHERE meta->'ad'->>'ad_id' = p_platform_ad_id
     AND (meta->'ad'->'resolved' IS NULL
          OR jsonb_typeof(meta->'ad'->'resolved') = 'null');
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;
GRANT EXECUTE ON FUNCTION public.mos_reresolve_first_touch(text) TO authenticated, service_role;

COMMIT;
