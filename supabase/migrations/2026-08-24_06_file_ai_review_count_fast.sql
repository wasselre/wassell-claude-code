-- file_ai_review_count timed out once the backfill pushed pending files into the
-- thousands: it called wassell_can_access_file PER file (2,669 → ~7,700 rows), a
-- per-row RLS evaluation that blows past statement_timeout. The count is only a
-- header indicator (badge + "showing first N of M"), NOT an access decision — the
-- QUEUE rows stay per-row edit-gated, so nothing sensitive rides on this number.
-- Drop the per-row gate: a plain DISTINCT over the ai_suggested provenance rows is
-- an index-friendly aggregate. For an admin (who edits everything) it's exact; for
-- a scoped reviewer it's an upper bound on their gated queue — acceptable for a
-- count, and the only thing that keeps the page from timing out at scale.
CREATE OR REPLACE FUNCTION public.file_ai_review_count()
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int
    FROM (SELECT DISTINCT file_id FROM public.file_metadata_provenance WHERE state = 'ai_suggested') p;
$$;
REVOKE ALL ON FUNCTION public.file_ai_review_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.file_ai_review_count() TO authenticated;

-- Supporting index so both the count and the queue's provenance CTE stay fast as
-- the pending set grows (partial: only the ai_suggested rows we ever scan here).
CREATE INDEX IF NOT EXISTS file_metadata_provenance_ai_suggested_idx
  ON public.file_metadata_provenance (file_id)
  WHERE state = 'ai_suggested';
