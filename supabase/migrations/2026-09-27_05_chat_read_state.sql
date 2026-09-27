-- ============================================================================
-- Chat auto-read: per-(chat, client) read state + lease.
-- ============================================================================
-- The in-chat card now reads a client's WhatsApp conversation ON ITS OWN — a
-- per-minute cron (api/cron/chat-auto-read.ts) and the rep opening the chat
-- both trigger it. Two agents read each batch: the geography pipeline
-- (geo_pref_proposals) and the preference extractor (client_pref_proposals).
-- This table is what stops a message being read twice or never:
--
--   geo_read_through / pref_read_through
--       The `date` of the newest INBOUND text-ish message (body, or a voice
--       note's transcript) that agent's last successful read covered. Each
--       agent has its own watermark so a partial failure advances only the
--       agent that succeeded. "Unread" = inbound text-ish after the LOWER of
--       the two (NULL ⇒ -infinity).
--   lease_owner / lease_until
--       Exactly one reader at a time per (chat, client). A crashed reader's
--       lease simply expires.
--
-- A read that found nothing still advances. A batch the free keyword gate
-- skipped ("تمام", "👍") also advances both (last_outcome='gate_skipped'). A
-- failed read never advances.
--
-- Every function here is SECURITY DEFINER + service_role only, and NONE of them
-- may raise SQLSTATE 40001/40P01 (see CLAUDE.md) — plain INSERT … ON CONFLICT /
-- UPDATE under READ COMMITTED, which never raises either.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.chat_read_state (
  chat_wid             text        NOT NULL,
  client_id            uuid        NOT NULL,
  geo_read_through     timestamptz,
  pref_read_through    timestamptz,
  last_read_at         timestamptz,
  last_trigger         text CHECK (last_trigger IN ('cron','open','manual')),
  last_outcome         text CHECK (last_outcome IN ('read','gate_skipped','partial','failed')),
  last_error           text,
  consecutive_failures int         NOT NULL DEFAULT 0,
  lease_owner          text,
  lease_until          timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_wid, client_id)
);

CREATE INDEX IF NOT EXISTS chat_read_state_lease_idx
  ON public.chat_read_state (lease_until) WHERE lease_until IS NOT NULL;

-- The candidate scan walks recent INBOUND messages by date.
CREATE INDEX IF NOT EXISTS idx_chat_messages_in_date
  ON public.chat_messages (date) WHERE flow = 'in';

-- RLS: authenticated read (like geo_pref_*); writes only through the RPCs below.
ALTER TABLE public.chat_read_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_read_state_select ON public.chat_read_state;
CREATE POLICY chat_read_state_select ON public.chat_read_state
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.chat_read_state FROM anon;

COMMENT ON TABLE public.chat_read_state IS
  'Chat auto-read: per (chat_wid, client_id) the two read watermarks (geo / prefs), the last outcome and a lease. Written only by the chat_read_* RPCs (service role).';

-- ────────────────────────────────────────────────────────────────────────────
-- Candidates: which linked chats have something unread?
-- ────────────────────────────────────────────────────────────────────────────
-- Returns one row per (chat_wid, client_id) with ≥1 unread text-ish inbound
-- message OR ≥1 voice note still being transcribed. The TIMING decision
-- (settle 90 s / cap 10 min / transcription hold / keyword gate / failure
-- backoff) is NOT made here — it is a pure TS function
-- (api/_lib/clientPrefs/dueSelection.ts) so it can be unit-tested.
--
-- chat → client: the `chats` model record whose data->>'wid' = chat_wid (the
-- same mapping chatCard.ts / backfillPorts.ts use); client_link may be a
-- scalar or an array, and only uuid-shaped values are cast. The client record
-- must exist.
--
-- A voice note counts as "pending" only while it is < 10 minutes old: a lost
-- media file never flips its transcript_status off 'pending' (the worker's
-- terminal failure path does not touch chat_messages), and the reader must not
-- wait on it forever — the 10-minute cap would release it anyway.
CREATE OR REPLACE FUNCTION public.chat_read_candidates(
  p_now    timestamptz DEFAULT now(),
  p_window interval    DEFAULT '7 days',
  p_limit  int         DEFAULT 50
)
RETURNS TABLE (
  chat_wid                   text,
  client_id                  uuid,
  newest_in_at               timestamptz,
  oldest_unread_at           timestamptz,
  unread_count               int,
  unread_bodies              text[],
  pending_transcripts        int,
  unread_voice_untranscribed int,
  lease_until                timestamptz,
  consecutive_failures       int,
  last_attempt_at            timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
  WITH recent AS (
    SELECT DISTINCT m.chat_wid
    FROM public.chat_messages m
    WHERE m.flow = 'in'
      AND m.date >  p_now - p_window
      AND m.date <= p_now
      AND m.chat_wid NOT LIKE '%@g.us'
  ),
  links AS (
    SELECT DISTINCT r.chat_wid,
           CASE WHEN cl.v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN cl.v::uuid END AS client_id
    FROM recent r
    JOIN public.records ch ON ch.data->>'wid' = r.chat_wid
    JOIN public.models  cm ON cm.id = ch.model_id AND cm.name = 'chats'
    CROSS JOIN LATERAL (
      SELECT x AS v
      FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(ch.data->'client_link') = 'array' THEN ch.data->'client_link' ELSE '[]'::jsonb END
      ) x
      UNION ALL
      SELECT ch.data->>'client_link' WHERE jsonb_typeof(ch.data->'client_link') = 'string'
    ) cl
  ),
  linked AS (
    SELECT l.chat_wid, l.client_id
    FROM links l
    WHERE l.client_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.records c
        JOIN public.models clm ON clm.id = c.model_id AND clm.name = 'clients'
        WHERE c.id = l.client_id
      )
  ),
  agg AS (
    SELECT
      l.chat_wid,
      l.client_id,
      s.lease_until,
      coalesce(s.consecutive_failures, 0) AS consecutive_failures,
      s.updated_at AS last_attempt_at,
      u.newest_in_at,
      u.oldest_unread_at,
      coalesce(u.unread_count, 0)               AS unread_count,
      coalesce(u.unread_bodies, ARRAY[]::text[]) AS unread_bodies,
      coalesce(u.pending_transcripts, 0)        AS pending_transcripts,
      coalesce(u.unread_voice_untranscribed, 0) AS unread_voice_untranscribed
    FROM linked l
    LEFT JOIN public.chat_read_state s
      ON s.chat_wid = l.chat_wid AND s.client_id = l.client_id
    CROSS JOIN LATERAL (
      SELECT
        max(m.date) FILTER (WHERE m.is_text AND m.after_wm)                     AS newest_in_at,
        min(m.date) FILTER (WHERE m.is_text AND m.after_wm)                     AS oldest_unread_at,
        (count(*) FILTER (WHERE m.is_text AND m.after_wm))::int                 AS unread_count,
        array_agg(m.text_of ORDER BY m.date) FILTER (WHERE m.is_text AND m.after_wm) AS unread_bodies,
        (count(*) FILTER (
          WHERE m.after_wm AND m.is_audio AND NOT m.is_text
            AND m.date > p_now - interval '10 minutes'
            AND (m.transcript_status = 'pending'
                 OR (m.transcript_status IS NULL AND coalesce(m.media_saved, true)))
        ))::int                                                                 AS pending_transcripts,
        (count(*) FILTER (
          WHERE m.is_audio AND NOT m.is_text
            AND m.date > coalesce(s.last_read_at, '-infinity'::timestamptz)
            AND (m.transcript_status IN ('none','failed') OR m.media_saved = false)
        ))::int                                                                 AS unread_voice_untranscribed
      FROM (
        SELECT
          mm.date,
          mm.transcript_status,
          mm.media_saved,
          mm.kind = 'audio' AS is_audio,
          (btrim(coalesce(mm.body, '')) <> '' OR btrim(coalesce(mm.transcript, '')) <> '') AS is_text,
          coalesce(nullif(btrim(coalesce(mm.body, '')), ''), btrim(mm.transcript))        AS text_of,
          mm.date > least(coalesce(s.geo_read_through,  '-infinity'::timestamptz),
                          coalesce(s.pref_read_through, '-infinity'::timestamptz))         AS after_wm
        FROM public.chat_messages mm
        WHERE mm.chat_wid = l.chat_wid
          AND mm.flow = 'in'
          AND mm.date >  p_now - p_window
          AND mm.date <= p_now
      ) m
    ) u
  )
  SELECT a.chat_wid, a.client_id, a.newest_in_at, a.oldest_unread_at, a.unread_count,
         a.unread_bodies, a.pending_transcripts, a.unread_voice_untranscribed,
         a.lease_until, a.consecutive_failures, a.last_attempt_at
  FROM agg a
  WHERE a.unread_count > 0 OR a.pending_transcripts > 0
  ORDER BY a.oldest_unread_at ASC NULLS LAST, a.chat_wid, a.client_id
  LIMIT greatest(coalesce(p_limit, 50), 1);
$fn$;

-- ────────────────────────────────────────────────────────────────────────────
-- Lease: claim / finish / release
-- ────────────────────────────────────────────────────────────────────────────

-- Claim the (chat, client) lease. Exactly one concurrent caller wins: the
-- loser's ON CONFLICT UPDATE re-checks the WHERE against the winner's committed
-- row, sees a live lease and updates nothing.
CREATE OR REPLACE FUNCTION public.chat_read_claim(
  p_chat_wid text, p_client_id uuid, p_owner text, p_lease_seconds int
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF coalesce(p_chat_wid, '') = '' OR p_client_id IS NULL OR coalesce(p_owner, '') = '' THEN
    RAISE EXCEPTION 'chat_read_claim: chat_wid, client_id and owner are required';
  END IF;
  INSERT INTO public.chat_read_state AS s (chat_wid, client_id, lease_owner, lease_until, updated_at)
  VALUES (p_chat_wid, p_client_id, p_owner,
          now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 30)), now())
  ON CONFLICT (chat_wid, client_id) DO UPDATE
     SET lease_owner = EXCLUDED.lease_owner,
         lease_until = EXCLUDED.lease_until,
         updated_at  = now()
   WHERE s.lease_until IS NULL OR s.lease_until < now();
  RETURN FOUND;
END
$fn$;

-- Record a finished read and drop the lease. Watermarks only move forward
-- (GREATEST ignores a NULL argument, so a NULL p_*_through leaves it as is).
-- Only the lease holder can finish; returns false when the lease was lost.
-- `partial` counts as a failure for the backoff (the failed agent would
-- otherwise be retried every minute) but still stamps last_read_at.
CREATE OR REPLACE FUNCTION public.chat_read_finish(
  p_chat_wid text, p_client_id uuid, p_owner text,
  p_geo_through timestamptz, p_pref_through timestamptz,
  p_trigger text, p_outcome text, p_error text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_outcome NOT IN ('read', 'partial', 'failed') THEN
    RAISE EXCEPTION 'chat_read_finish: outcome must be read|partial|failed, got %', p_outcome;
  END IF;
  UPDATE public.chat_read_state
     SET geo_read_through     = greatest(geo_read_through,  p_geo_through),
         pref_read_through    = greatest(pref_read_through, p_pref_through),
         last_read_at         = CASE WHEN p_outcome IN ('read', 'partial') THEN now() ELSE last_read_at END,
         last_trigger         = p_trigger,
         last_outcome         = p_outcome,
         last_error           = left(p_error, 2000),
         consecutive_failures = CASE WHEN p_outcome = 'read' THEN 0 ELSE consecutive_failures + 1 END,
         lease_owner          = NULL,
         lease_until          = NULL,
         updated_at           = now()
   WHERE chat_wid = p_chat_wid AND client_id = p_client_id AND lease_owner = p_owner;
  RETURN FOUND;
END
$fn$;

-- The keyword gate skipped a batch (nothing worth reading). Advances BOTH
-- watermarks to p_through; never touches a live lease (the caller holds none).
CREATE OR REPLACE FUNCTION public.chat_read_mark_gate_skipped(
  p_chat_wid text, p_client_id uuid, p_through timestamptz, p_trigger text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF p_through IS NULL THEN RETURN; END IF;
  INSERT INTO public.chat_read_state AS s
    (chat_wid, client_id, geo_read_through, pref_read_through, last_trigger, last_outcome, updated_at)
  VALUES (p_chat_wid, p_client_id, p_through, p_through, p_trigger, 'gate_skipped', now())
  ON CONFLICT (chat_wid, client_id) DO UPDATE
     SET geo_read_through  = greatest(s.geo_read_through,  EXCLUDED.geo_read_through),
         pref_read_through = greatest(s.pref_read_through, EXCLUDED.pref_read_through),
         last_trigger      = EXCLUDED.last_trigger,
         last_outcome      = 'gate_skipped',
         last_error        = NULL,
         updated_at        = now();
END
$fn$;

-- Drop the lease without recording a read (the reader bailed out early).
CREATE OR REPLACE FUNCTION public.chat_read_release(
  p_chat_wid text, p_client_id uuid, p_owner text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  UPDATE public.chat_read_state
     SET lease_owner = NULL, lease_until = NULL, updated_at = now()
   WHERE chat_wid = p_chat_wid AND client_id = p_client_id AND lease_owner = p_owner;
END
$fn$;

REVOKE ALL ON FUNCTION public.chat_read_candidates(timestamptz, interval, int)                                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_read_claim(text, uuid, text, int)                                              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_read_finish(text, uuid, text, timestamptz, timestamptz, text, text, text)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_read_mark_gate_skipped(text, uuid, timestamptz, text)                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.chat_read_release(text, uuid, text)                                                 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.chat_read_candidates(timestamptz, interval, int)                                 TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_read_claim(text, uuid, text, int)                                          TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_read_finish(text, uuid, text, timestamptz, timestamptz, text, text, text)   TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_read_mark_gate_skipped(text, uuid, timestamptz, text)                      TO service_role;
GRANT EXECUTE ON FUNCTION public.chat_read_release(text, uuid, text)                                             TO service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- Seed the GEO watermark from chats the geography card already read.
-- ────────────────────────────────────────────────────────────────────────────
-- Without this, every chat read before today looks fully unread to the geo
-- agent: the first cron tick would re-review it and put a fresh PENDING card
-- on top of one the rep already confirmed or dismissed. A model checkpoint's
-- created_at is when that conversation was read, so every message dated at or
-- before it was covered. Only WhatsApp chats (conversation ids with '@'); call
-- conversations are not read by this lane. pref_read_through stays NULL on
-- purpose — the preference agent has never read any chat, so it reads each
-- recently active one once.
INSERT INTO public.chat_read_state (chat_wid, client_id, geo_read_through, updated_at)
SELECT cp.conversation_id, cp.client_id, max(cp.created_at), now()
FROM public.geo_pref_checkpoints cp
WHERE cp.origin_tag = 'model'
  AND cp.conversation_id LIKE '%@%'
  AND cp.client_id IS NOT NULL
GROUP BY cp.conversation_id, cp.client_id
ON CONFLICT (chat_wid, client_id) DO NOTHING;

COMMIT;
