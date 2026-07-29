-- Aqar listing extraction — a fifth Claude Code lane.
--
-- WHY THIS EXISTS
-- The Aqar scraper (aqar-sync-rayan) called the Anthropic API once per listing
-- to turn a scraped page into structured fields. On 2026-07-24T20:56Z the API
-- key ran out of credit and every call returned
--   400 invalid_request_error "Your credit balance is too low"
-- for five days. Discovery kept working, so the run printed "SYNC DONE" while
-- pushing nothing — market_listings gained no rows after 2026-07-23 and nobody
-- noticed. Moving extraction onto the paid subscription removes the metered
-- dependency AND the silent-failure mode: a lane with no capacity stops
-- visibly instead of 400-ing two thousand times.
--
-- SHAPE — identical to the OCR lane, deliberately (a second bespoke pattern
-- would be a second thing to operate):
--   scraper persists bundle -> enqueue job (pointer only) -> runner fetches
--   evidence -> Skill session -> strict result.json -> pure validator ->
--   scoped upsert RPC. Claude never writes to the database.

BEGIN;

-- ── 1. Evidence + results ────────────────────────────────────────────────
-- The job payload carries only listing ids; the page bundle lives here so the
-- queue row stays small and the runner fetches evidence through a scoped RPC
-- (same posture as mkt_intelligence_evidence).

CREATE TABLE IF NOT EXISTS public.aqar_listing_evidence (
  listing_id  text PRIMARY KEY,
  url         text NOT NULL,
  bundle      text NOT NULL,
  scraped_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.aqar_listing_extractions (
  listing_id    text PRIMARY KEY,
  data          jsonb NOT NULL,
  job_id        uuid,
  extracted_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aqar_listing_extractions_extracted_at_idx
  ON public.aqar_listing_extractions (extracted_at DESC);

-- Service-role only, like every other queue table. No anon/authenticated path:
-- this is scraper<->runner plumbing, never touched by the browser.
ALTER TABLE public.aqar_listing_evidence    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aqar_listing_extractions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.aqar_listing_evidence    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.aqar_listing_extractions FROM PUBLIC, anon, authenticated;

-- ── 2. Scoped RPCs ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.aqar_evidence_fetch(p_listing_ids text[])
RETURNS TABLE(listing_id text, url text, bundle text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT e.listing_id, e.url, e.bundle
  FROM public.aqar_listing_evidence e
  WHERE e.listing_id = ANY (p_listing_ids)
  ORDER BY e.listing_id;
$$;

-- p_rows: [{"listing_id":"6789992","data":{...}}, ...]
-- Returns the number of rows written so the runner can assert the Skill
-- produced an entry for every listing it was given (a short result is a
-- silently dropped listing otherwise).
CREATE OR REPLACE FUNCTION public.aqar_extractions_upsert(p_rows jsonb, p_job_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_count integer;
BEGIN
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'aqar_extractions_upsert: p_rows must be a JSON array, got %', jsonb_typeof(p_rows);
  END IF;

  INSERT INTO public.aqar_listing_extractions AS t (listing_id, data, job_id, extracted_at)
  SELECT r->>'listing_id', r->'data', p_job_id, now()
  FROM jsonb_array_elements(p_rows) r
  WHERE r->>'listing_id' IS NOT NULL
  ON CONFLICT (listing_id) DO UPDATE
    SET data = EXCLUDED.data, job_id = EXCLUDED.job_id, extracted_at = now();

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.aqar_evidence_fetch(text[])          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.aqar_extractions_upsert(jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aqar_evidence_fetch(text[])          TO service_role;
GRANT EXECUTE ON FUNCTION public.aqar_extractions_upsert(jsonb, uuid) TO service_role;

-- ── 3. Widen the job-kind CHECK ──────────────────────────────────────────
-- DROP and ADD in ONE transaction. claude_jobs is shared with wassel-wa-agent,
-- so there must never be a window where the constraint is absent — a split
-- transaction would let a malformed kind land during the gap.
ALTER TABLE public.claude_jobs DROP CONSTRAINT IF EXISTS claude_jobs_kind_check;
ALTER TABLE public.claude_jobs ADD CONSTRAINT claude_jobs_kind_check
  CHECK (kind = ANY (ARRAY[
    'ping','client_study','mkt_content_enrichment','mkt_campaign_summary',
    'whatsapp_reply','mkt_visual_ocr','aqar_listing_extract'
  ]));

-- ── 4. Teach the claimer about the aqar lane ─────────────────────────────
-- Verbatim copy of the live function plus one lane. Slot pattern ('aqar#<id>')
-- is included from the start so `fly scale count N` gives N concurrent
-- sessions without another migration — the mistake called out in
-- runner/fly.marketing-pool.toml, where a slot acquires a lease the claimer
-- does not recognise and then politely claims nothing forever.
CREATE OR REPLACE FUNCTION public.claude_job_claim_next(p_worker text)
 RETURNS SETOF public.claude_jobs
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_interactive_kinds constant text[] := ARRAY['ping','client_study'];
  v_batch_kinds       constant text[] := ARRAY['mkt_content_enrichment','mkt_campaign_summary'];
  v_ocr_kinds         constant text[] := ARRAY['mkt_visual_ocr'];
  v_aqar_kinds        constant text[] := ARRAY['aqar_listing_extract'];
  v_lease_kinds       constant text[] := ARRAY['ping','client_study','mkt_content_enrichment',
                                               'mkt_campaign_summary','mkt_visual_ocr',
                                               'aqar_listing_extract'];
  v_holds_interactive boolean; v_holds_marketing boolean; v_holds_ocr boolean; v_holds_aqar boolean;
  v_interactive_orphan boolean; v_marketing_orphan boolean; v_ocr_orphan boolean; v_aqar_orphan boolean;
  v_holds_any boolean; v_no_leases boolean;
  v_may_interactive boolean; v_may_batch boolean; v_may_ocr boolean; v_may_aqar boolean;
BEGIN
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease) INTO v_no_leases;

  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='interactive'
      AND l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker) INTO v_holds_interactive;
  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l
      WHERE (l.lease_name = 'marketing_intelligence' OR starts_with(l.lease_name, 'marketing_intelligence#'))
      AND l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker) INTO v_holds_marketing;
  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='ocr'
      AND l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker) INTO v_holds_ocr;
  SELECT EXISTS (SELECT 1 FROM public.claude_runner_lease l
      WHERE (l.lease_name = 'aqar' OR starts_with(l.lease_name, 'aqar#'))
      AND l.released_at IS NULL AND l.expires_at > now() AND l.owner_id = p_worker) INTO v_holds_aqar;

  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='interactive'
      AND l.released_at IS NULL AND l.expires_at > now()) INTO v_interactive_orphan;
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l
      WHERE (l.lease_name = 'marketing_intelligence' OR starts_with(l.lease_name, 'marketing_intelligence#'))
      AND l.released_at IS NULL AND l.expires_at > now()) INTO v_marketing_orphan;
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l WHERE l.lease_name='ocr'
      AND l.released_at IS NULL AND l.expires_at > now()) INTO v_ocr_orphan;
  SELECT NOT EXISTS (SELECT 1 FROM public.claude_runner_lease l
      WHERE (l.lease_name = 'aqar' OR starts_with(l.lease_name, 'aqar#'))
      AND l.released_at IS NULL AND l.expires_at > now()) INTO v_aqar_orphan;

  v_holds_any := v_holds_interactive OR v_holds_marketing OR v_holds_ocr OR v_holds_aqar;

  v_may_interactive := v_no_leases OR v_holds_interactive OR (v_interactive_orphan AND v_holds_any);
  v_may_batch       := v_no_leases OR v_holds_marketing   OR (v_marketing_orphan   AND v_holds_any);
  v_may_ocr         := v_no_leases OR v_holds_ocr         OR (v_ocr_orphan         AND v_holds_any);
  v_may_aqar        := v_no_leases OR v_holds_aqar        OR (v_aqar_orphan        AND v_holds_any);

  SELECT id INTO v_id FROM public.claude_jobs
  WHERE status = 'pending'
    AND (
      kind <> ALL (v_lease_kinds)
      OR (kind = ANY (v_interactive_kinds) AND v_may_interactive)
      OR (kind = ANY (v_batch_kinds)       AND v_may_batch)
      OR (kind = ANY (v_ocr_kinds)         AND v_may_ocr)
      OR (kind = ANY (v_aqar_kinds)        AND v_may_aqar)
    )
  ORDER BY
    CASE
      -- People wait on these; a scrape backlog of any depth must never delay them.
      WHEN kind = ANY (v_interactive_kinds) AND v_may_interactive THEN 0
      WHEN kind <> ALL (v_lease_kinds) THEN 1
      ELSE 2
    END,
    created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1;
  IF v_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  UPDATE public.claude_jobs
  SET status='running', claimed_by=p_worker, started_at=now(), attempts=attempts+1
  WHERE id = v_id
  RETURNING *;
END;
$function$;

COMMIT;
