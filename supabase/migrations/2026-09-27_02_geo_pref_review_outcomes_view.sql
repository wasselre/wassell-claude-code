-- ============================================================================
-- How often reps accept the geography reading as-is — the real accuracy meter.
-- ============================================================================
-- The in-chat confirm card (2026-09-27) turns every reading into one of three
-- rep decisions, each already written as ONE row of the append-only
-- geo_pref_review_audit: `confirm` (saved unchanged), `edit` (saved after the
-- rep unticked at least one line), `reject` (dismissed). The share saved
-- unchanged is the accuracy measure that matters — it is judged by the person
-- who knows the customer, on live chats, not on a calibration batch.
--
-- One row per Riyadh day. `must_confirm` is counted but kept out of the rate
-- (the rep deferred; nothing was judged). Reads the audit table only.
-- security_invoker so the caller's own RLS applies to the audit rows.
-- ============================================================================
BEGIN;

CREATE OR REPLACE VIEW public.v_geo_pref_review_outcomes
WITH (security_invoker = true) AS
SELECT
  (a.at AT TIME ZONE 'Asia/Riyadh')::date                        AS day,
  count(*) FILTER (WHERE a.action = 'confirm')                   AS saved_unchanged,
  count(*) FILTER (WHERE a.action = 'edit')                      AS saved_after_edit,
  count(*) FILTER (WHERE a.action = 'reject')                    AS dismissed,
  count(*) FILTER (WHERE a.action = 'must_confirm')              AS deferred,
  round(
    count(*) FILTER (WHERE a.action = 'confirm')::numeric
      / nullif(count(*) FILTER (WHERE a.action IN ('confirm', 'edit', 'reject')), 0),
    3
  )                                                              AS unchanged_rate
FROM public.geo_pref_review_audit a
GROUP BY 1;

COMMENT ON VIEW public.v_geo_pref_review_outcomes IS
  'Per Riyadh day: geography readings saved unchanged / saved after an edit / dismissed / deferred, and the share saved unchanged (the live accuracy meter for the in-chat confirm card).';

GRANT SELECT ON public.v_geo_pref_review_outcomes TO authenticated, service_role;
REVOKE ALL ON public.v_geo_pref_review_outcomes FROM anon;

DO $assert$
DECLARE v_opts text[];
BEGIN
  SELECT c.reloptions INTO v_opts FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'v_geo_pref_review_outcomes';
  IF v_opts IS NULL OR NOT ('security_invoker=true' = ANY(v_opts)) THEN
    RAISE EXCEPTION 'VIEW_SECURITY_INVOKER_LOST v_geo_pref_review_outcomes — options are %', v_opts;
  END IF;
END $assert$;

COMMIT;
