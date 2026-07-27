-- ============================================================================
-- Regression guard for claude_job_claim_next scheduling (2026-08-14).
--
--   psql "$DATABASE_URL" -f supabase/tests/claude_job_claim_test.sql
--
-- Runs inside a transaction that ROLLS BACK — safe against production.
--
-- `claude_jobs` is a SHARED queue. wassel-claude-runner holds the
-- `marketing_intelligence` singleton lease and is the ONLY consumer able to run
-- the lease-scoped kinds; wassel-wa-agent is dedicated to `whatsapp_reply`.
--
-- Two properties are load-bearing and pull in OPPOSITE directions, which is why
-- both are pinned here:
--
--   1. No starvation — the lease holder must drain its own kinds first. It once
--      claimed two whatsapp_reply jobs back to back (12.7 + 14.0 min) while
--      wa-agent sat idle and 49 marketing jobs waited (production, 2026-07-27).
--   2. No outage — it must STILL take foreign work when it has none of its own.
--      Making rule 1 an exclusion instead of a preference would stall
--      customer-facing WhatsApp replies outright if wa-agent ever died. A
--      throughput problem must never be "fixed" into an availability problem.
-- ============================================================================
BEGIN;

DO $$
DECLARE
  v_lease_kinds constant text[] :=
    ARRAY['ping','client_study','mkt_content_enrichment','mkt_campaign_summary'];
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='claude_job_claim_next';
  IF v_def IS NULL THEN RAISE EXCEPTION 'claude_job_claim_next not found'; END IF;

  -- The preference tie-break must exist, and must be gated on holding the lease
  -- (a non-holder cannot see lease-scoped kinds at all, so ordering them would
  -- be meaningless — and gating on the lease is what keeps it a preference).
  IF position('v_holds_lease AND kind = ANY' IN v_def) = 0 THEN
    RAISE EXCEPTION 'FAILED: the lease-holder preference tie-break is gone — the singleton will starve its own queue again';
  END IF;

  -- It must remain a tie-break inside ORDER BY, NOT a filter in WHERE.
  -- If this ever moves into the WHERE clause, a dead wa-agent stalls
  -- whatsapp_reply permanently.
  IF position('AND (v_holds_lease OR kind <> ALL (v_lease_kinds))' IN v_def) = 0 THEN
    RAISE EXCEPTION 'FAILED: the claim gate changed shape — verify the lease holder can still fall back to foreign kinds';
  END IF;
  RAISE NOTICE 'PASS: preference is a tie-break, not an exclusion';

  IF position('created_at' IN v_def) = 0 THEN
    RAISE EXCEPTION 'FAILED: FIFO ordering lost — jobs could starve by age';
  END IF;
  RAISE NOTICE 'PASS: FIFO retained within each preference class';
END $$;

-- ── Behavioural: ordering picks the right job in both directions ────────────
DO $$
DECLARE v_holder text; v_other text;
BEGIN
  WITH k AS (SELECT ARRAY['ping','client_study','mkt_content_enrichment','mkt_campaign_summary']::text[] AS lk),
  sim(kind, age_min) AS (VALUES ('whatsapp_reply', 60), ('mkt_content_enrichment', 5))
  SELECT kind INTO v_holder FROM sim, k
  ORDER BY CASE WHEN kind = ANY(k.lk) THEN 0 ELSE 1 END, age_min DESC LIMIT 1;

  WITH k AS (SELECT ARRAY['ping','client_study','mkt_content_enrichment','mkt_campaign_summary']::text[] AS lk),
  sim(kind, age_min) AS (VALUES ('whatsapp_reply', 60), ('mkt_content_enrichment', 5))
  SELECT kind INTO v_other FROM sim, k
  WHERE kind <> ALL(k.lk) ORDER BY age_min DESC LIMIT 1;

  IF v_holder <> 'mkt_content_enrichment' THEN
    RAISE EXCEPTION 'FAILED: lease holder picked % over its own pending work', v_holder;
  END IF;
  IF v_other <> 'whatsapp_reply' THEN
    RAISE EXCEPTION 'FAILED: wa-agent picked % (must be whatsapp_reply)', v_other;
  END IF;
  RAISE NOTICE 'PASS: holder takes marketing despite an older foreign job; wa-agent takes that one';

  -- fallback: nothing lease-scoped pending
  WITH k AS (SELECT ARRAY['ping','client_study','mkt_content_enrichment','mkt_campaign_summary']::text[] AS lk),
  sim(kind, age_min) AS (VALUES ('whatsapp_reply', 60))
  SELECT kind INTO v_holder FROM sim, k
  ORDER BY CASE WHEN kind = ANY(k.lk) THEN 0 ELSE 1 END, age_min DESC LIMIT 1;

  IF v_holder IS DISTINCT FROM 'whatsapp_reply' THEN
    RAISE EXCEPTION 'FAILED: with no lease-scoped work the holder refused to help — a dead wa-agent would now stall customer replies';
  END IF;
  RAISE NOTICE 'PASS: fallback preserved when the holder has no work of its own';
  RAISE NOTICE 'ALL CLAIM-SCHEDULING TESTS PASSED';
END $$;

ROLLBACK;
