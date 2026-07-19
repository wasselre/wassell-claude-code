-- clean_text_entry_patch: targeted single-entry patch for the clean-text worker's
-- terminal writes — replaces the whole-data read-modify-write (record_save with
-- p_expected_version + retry) those writes used until 2026-07-19.
--
-- INCIDENT (2026-07-18, listing e4106640 / draft d0602087): a 22-photo clean-text
-- batch finished in one burst (FLUX.2 klein is ~3 s/photo, so all terminal writes
-- land within seconds of each other). Every writer did read-row → rebuild whole
-- data → record_save(p_expected_version) → retry on 40001; under the burst every
-- writer conflicted with every other (a convoy), and combined with Kong 504
-- client retries the storm saturated the Supabase PostgREST pool (42+ active
-- connections) and starved every worker queue's claim RPCs for minutes. Two
-- structural fixes already landed (record_save FOR UPDATE row lock; widened
-- CLEAN_RETRY_OPTS) — this removes the contention at the source.
--
-- KEY INSIGHT: each clean-text job only ever changes ONE element of
-- records.data.cleaning[] (matched by entry id). It never needs the rest of
-- data, so it never needs a version check at all. This function does the merge
-- INSIDE a single UPDATE statement:
--
--   * The row lock serializes concurrent entry patches; a waiter re-evaluates
--     both its WHERE clause and its SET expression against the winner's
--     committed row (READ COMMITTED EvalPlanQual), so no fill is ever lost and
--     no two entries can clobber each other.
--   * No version check → no 40001 → no retry loop → nothing to convoy. The
--     worker's remaining retry wrapper only rides out transient REST/pool
--     brownouts (503/504/pool-timeout), not version races.
--   * records_bump_version (BEFORE UPDATE on records) still fires naturally, so
--     `version` increments per patch and the SPA's optimistic writers (e.g. the
--     Approve save after the cleaning window) are still bounced correctly.
--   * records_block_frozen_writes also still fires — if chat_templates is ever
--     frozen this raises loudly instead of writing to the wrong table.
--
-- Service-role only (worker writes; ownership was validated by
-- api/templates/clean-listing-images.ts before enqueue). SECURITY DEFINER so the
-- worker's patch bypasses RLS the same way its record_save calls did.

CREATE OR REPLACE FUNCTION public.clean_text_entry_patch(
  p_record_id uuid,
  p_entry_id  text,
  p_patch     jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_rows int;
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'clean_text_entry_patch: p_patch must be a jsonb object';
  END IF;

  -- Single-statement read-modify-write: find the entry's array index and merge
  -- p_patch into that element, all under the row lock this UPDATE takes. The
  -- correlated subquery reads r.data as of the locked (latest committed) tuple.
  UPDATE public.records r
  SET data = (
        SELECT jsonb_set(r.data, ARRAY['cleaning', (t.idx - 1)::text], t.elem || p_patch)
        FROM jsonb_array_elements(r.data->'cleaning') WITH ORDINALITY AS t(elem, idx)
        WHERE t.elem->>'id' = p_entry_id
        LIMIT 1
      ),
      updated_at = now()
  WHERE r.id = p_record_id
    AND jsonb_typeof(r.data->'cleaning') = 'array'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(r.data->'cleaning') AS e(elem)
      WHERE e.elem->>'id' = p_entry_id
    );

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    -- Draft deleted or entry removed mid-run. Loud abort, never a silent no-op
    -- (CLAUDE.md) — mirrors the "entry not present — aborting" throw the worker's
    -- old build() callback raised.
    RAISE EXCEPTION 'clean_text_entry_patch: cleaning entry % not present on record % - draft deleted or entry removed',
      p_entry_id, p_record_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.clean_text_entry_patch(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clean_text_entry_patch(uuid, text, jsonb) TO service_role;
