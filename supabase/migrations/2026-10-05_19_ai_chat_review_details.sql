-- ============================================================================
-- AI chat review — per-message notes and per-card verdicts (operator, 2026-10-05).
--
-- In the daily «مراجعة أداء المساعد في واتساب» pop-up the reviewer can now:
--   · select one or more messages and write a note on exactly those messages,
--     or write a general note (no messages) — any number per review;
--   · accept or reject each card of what the AI DID in the chat: places saved,
--     other preferences saved, portal registrations, visits booked/recorded.
--     A rejection needs a reason; the reviewer corrects the values on the same
--     page (the correction is an ordinary client / appointment / visit save) and
--     a summary of it is kept here with the verdict.
--
-- Writes go through SECURITY DEFINER RPCs that allow the review's reviewer or an
-- admin — same gate as ai_chat_review_submit.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_chat_review_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id   uuid NOT NULL REFERENCES public.ai_chat_reviews(id) ON DELETE CASCADE,
  -- chat_messages ids the note is about; empty = a general note.
  message_ids text[] NOT NULL DEFAULT '{}',
  note        text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 2000),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_chat_review_notes_review ON public.ai_chat_review_notes (review_id, created_at);

CREATE TABLE IF NOT EXISTS public.ai_chat_review_cards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id   uuid NOT NULL REFERENCES public.ai_chat_reviews(id) ON DELETE CASCADE,
  card        text NOT NULL CHECK (card IN ('places', 'preferences', 'portal', 'visits')),
  verdict     text NOT NULL CHECK (verdict IN ('accepted', 'rejected')),
  -- Required for a rejection: what the AI got wrong.
  reason      text,
  -- What the reviewer changed while correcting: { field: { before, after } }.
  corrections jsonb,
  decided_by  uuid,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (review_id, card),
  CHECK (verdict = 'accepted' OR length(btrim(COALESCE(reason, ''))) > 0)
);

ALTER TABLE public.ai_chat_review_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_chat_review_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_chat_review_notes_read ON public.ai_chat_review_notes;
CREATE POLICY ai_chat_review_notes_read ON public.ai_chat_review_notes
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.ai_chat_reviews r WHERE r.id = review_id
                  AND (public.wassell_is_admin((SELECT auth.uid()))
                       OR r.reviewer_user_id = public.wassell_app_user_id((SELECT auth.uid())))));
DROP POLICY IF EXISTS ai_chat_review_cards_read ON public.ai_chat_review_cards;
CREATE POLICY ai_chat_review_cards_read ON public.ai_chat_review_cards
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.ai_chat_reviews r WHERE r.id = review_id
                  AND (public.wassell_is_admin((SELECT auth.uid()))
                       OR r.reviewer_user_id = public.wassell_app_user_id((SELECT auth.uid())))));
REVOKE ALL ON public.ai_chat_review_notes, public.ai_chat_review_cards FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.ai_chat_review_notes, public.ai_chat_review_cards FROM authenticated;

-- The reviewer of this review, or an admin.
CREATE OR REPLACE FUNCTION public._ai_chat_review_can_edit(p_review uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.ai_chat_reviews r WHERE r.id = p_review
                  AND (public.wassell_is_admin(auth.uid())
                       OR r.reviewer_user_id = public.wassell_app_user_id(auth.uid())));
$fn$;

CREATE OR REPLACE FUNCTION public.ai_chat_review_note_add(p_review uuid, p_message_ids text[], p_note text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_id uuid;
BEGIN
  IF NOT public._ai_chat_review_can_edit(p_review) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF p_note IS NULL OR length(btrim(p_note)) = 0 THEN
    RAISE EXCEPTION 'note is required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ai_chat_review_notes (review_id, message_ids, note, created_by)
  VALUES (p_review, COALESCE(p_message_ids, '{}'), btrim(p_note), public.wassell_app_user_id(auth.uid()))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.ai_chat_review_note_delete(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_review uuid;
BEGIN
  SELECT review_id INTO v_review FROM public.ai_chat_review_notes WHERE id = p_id;
  IF v_review IS NULL THEN RETURN false; END IF;
  IF NOT public._ai_chat_review_can_edit(v_review) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.ai_chat_review_notes WHERE id = p_id;
  RETURN true;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.ai_chat_review_card_set(
  p_review uuid, p_card text, p_verdict text, p_reason text DEFAULT NULL, p_corrections jsonb DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_id uuid;
BEGIN
  IF NOT public._ai_chat_review_can_edit(p_review) THEN
    RAISE EXCEPTION 'not permitted' USING ERRCODE = '42501';
  END IF;
  IF p_verdict = 'rejected' AND length(btrim(COALESCE(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'a rejection needs a reason' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ai_chat_review_cards (review_id, card, verdict, reason, corrections, decided_by, decided_at)
  VALUES (p_review, p_card, p_verdict, NULLIF(btrim(COALESCE(p_reason, '')), ''), p_corrections,
          public.wassell_app_user_id(auth.uid()), now())
  ON CONFLICT (review_id, card) DO UPDATE
     SET verdict = EXCLUDED.verdict, reason = EXCLUDED.reason, corrections = EXCLUDED.corrections,
         decided_by = EXCLUDED.decided_by, decided_at = now()
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public._ai_chat_review_can_edit(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_chat_review_note_add(uuid, text[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_chat_review_note_delete(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ai_chat_review_card_set(uuid, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._ai_chat_review_can_edit(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_chat_review_note_add(uuid, text[], text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_chat_review_note_delete(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ai_chat_review_card_set(uuid, text, text, text, jsonb) TO authenticated, service_role;

COMMIT;
