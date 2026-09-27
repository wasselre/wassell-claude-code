-- ============================================================================
-- Client preference proposals from a WhatsApp chat (budget, unit type, area,
-- bedrooms, purpose, amenities).
-- ============================================================================
-- The chat auto-read (2026-09-27_05_chat_read_state.sql) runs TWO agents per
-- read: the geography pipeline (geo_pref_proposals, unchanged) and the
-- preference extractor (api/_lib/prefExtract.ts, channel 'chat'). This table
-- holds the second agent's output as a PROPOSAL. Nothing is written to the
-- client until a rep ticks the lines and presses save
-- (POST /api/client-prefs/review) — `auto_write_enabled` stays false.
--
-- One OPEN proposal per (chat, client): a newer reading supersedes the older
-- pending one (`superseded`, linked through superseded_by). The unique partial
-- index is the backstop.
--
-- `version` is bumped on every UPDATE by a trigger so the review endpoint's
-- optimistic `expectedVersion` check means something. (geo_pref_proposals has
-- the column but no bump trigger — this table does not copy that gap.)
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.client_pref_proposals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            uuid NOT NULL,
  chat_wid             text NOT NULL,
  suggestions          jsonb NOT NULL,     -- Record<slug, {slug, value, quote, confidence}>
  current_values       jsonb NOT NULL,     -- the pref slugs on the client at proposal time
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','saved','dismissed','superseded')),
  source_watermark     timestamptz NOT NULL,
  source_message_count int NOT NULL,
  extractor_version    text NOT NULL,
  model                text NOT NULL,
  is_fallback          boolean NOT NULL DEFAULT false,
  trigger              text NOT NULL CHECK (trigger IN ('cron','open','manual')),
  version              int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  decided_by           uuid,
  decided_at           timestamptz,
  saved_fields         text[],
  after_values         jsonb,
  superseded_by        uuid REFERENCES public.client_pref_proposals(id)
);

CREATE INDEX IF NOT EXISTS client_pref_proposals_chat_idx
  ON public.client_pref_proposals (chat_wid, client_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS client_pref_proposals_one_pending
  ON public.client_pref_proposals (chat_wid, client_id) WHERE status = 'pending';

-- Version bump on every update (optimistic-concurrency guard for the review).
CREATE OR REPLACE FUNCTION public.tg_client_pref_proposals_bump_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  NEW.version := coalesce(OLD.version, 0) + 1;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS client_pref_proposals_bump_version ON public.client_pref_proposals;
CREATE TRIGGER client_pref_proposals_bump_version
  BEFORE UPDATE ON public.client_pref_proposals
  FOR EACH ROW EXECUTE FUNCTION public.tg_client_pref_proposals_bump_version();

-- RLS identical to geo_pref_proposals: authenticated read, writes service-role only.
ALTER TABLE public.client_pref_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS client_pref_proposals_select ON public.client_pref_proposals;
CREATE POLICY client_pref_proposals_select ON public.client_pref_proposals
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.client_pref_proposals FROM anon;

COMMENT ON TABLE public.client_pref_proposals IS
  'Preference suggestions (budget / unit type / area / bedrooms / purpose / amenities) read from a WhatsApp chat. A proposal only — the client is written by POST /api/client-prefs/review after a rep ticks and saves.';

-- ────────────────────────────────────────────────────────────────────────────
-- Review outcomes per suggested FIELD — how often reps keep what was proposed.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_client_pref_review_outcomes
WITH (security_invoker = true) AS
WITH per_field AS (
  SELECT
    (p.created_at AT TIME ZONE 'Asia/Riyadh')::date AS day,
    s.slug,
    p.model,
    CASE
      WHEN p.status = 'saved' AND s.slug = ANY(coalesce(p.saved_fields, ARRAY[]::text[])) THEN 'accepted'
      WHEN p.status = 'saved'      THEN 'unticked'
      WHEN p.status = 'dismissed'  THEN 'dismissed'
      WHEN p.status = 'superseded' THEN 'superseded'
      ELSE 'open'
    END AS outcome,
    (p.current_values -> s.slug) IS DISTINCT FROM (s.sug -> 'value') AS was_change
  FROM public.client_pref_proposals p
  CROSS JOIN LATERAL jsonb_each(p.suggestions) AS s(slug, sug)
)
SELECT
  day,
  slug,
  model,
  count(*)                                           AS suggested,
  count(*) FILTER (WHERE was_change)                 AS suggested_changes,
  count(*) FILTER (WHERE outcome = 'accepted')       AS accepted,
  count(*) FILTER (WHERE outcome = 'unticked')       AS unticked,
  count(*) FILTER (WHERE outcome = 'dismissed')      AS dismissed,
  count(*) FILTER (WHERE outcome = 'superseded')     AS superseded,
  count(*) FILTER (WHERE outcome = 'open')           AS open,
  round(
    count(*) FILTER (WHERE outcome = 'accepted')::numeric
      / nullif(count(*) FILTER (WHERE outcome IN ('accepted', 'unticked', 'dismissed')), 0),
    3
  )                                                  AS acceptance_rate
FROM per_field
GROUP BY day, slug, model;

COMMENT ON VIEW public.v_client_pref_review_outcomes IS
  'Per Riyadh day × field × model: chat preference suggestions accepted (saved ticked) / unticked / dismissed / superseded / still open, and acceptance_rate = accepted / (accepted + unticked + dismissed). ACCEPTED IS NOT PROVEN CORRECT — it means a rep kept the line, not that the customer really wants it.';

ALTER VIEW public.v_client_pref_review_outcomes SET (security_invoker = true);
GRANT SELECT ON public.v_client_pref_review_outcomes TO authenticated, service_role;
REVOKE ALL ON public.v_client_pref_review_outcomes FROM anon;

DO $assert$
DECLARE v_opts text[];
BEGIN
  SELECT c.reloptions INTO v_opts FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_client_pref_review_outcomes';
  IF v_opts IS NULL OR NOT ('security_invoker=true' = ANY(v_opts)) THEN
    RAISE EXCEPTION 'VIEW_SECURITY_INVOKER_LOST v_client_pref_review_outcomes — options are %', v_opts;
  END IF;
END $assert$;

COMMIT;
