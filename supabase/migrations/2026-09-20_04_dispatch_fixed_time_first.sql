-- ============================================================================
-- Work with a real publish TIME is handed out before work without one.
-- 2026-09-20.
--
-- Both `mos_plan_start_due` and `mos_dispatch_sweep` order by
-- `mos_subject_publish_at(...) ASC NULLS LAST`. That function returns a ROW's
-- batch day at MIDNIGHT Riyadh, and a paid creative's need date — which, on an
-- ad batch day, is the same midnight. So on every ad batch Tuesday the organic
-- row (a hard 18:00 publish) and fifteen ad creatives (which go live whenever
-- each is approved) sort IDENTICALLY, and the tie is broken by `t.id` — a
-- random UUID.
--
-- With one designer at five units a day and eighteen units wanting that
-- Tuesday, the one item with a real deadline could be handed out sixteenth, or
-- not at all that day, while ads that could safely have waited until Thursday
-- went first. Every ad batch day in the September–October plan is also an
-- organic posting day, so this recurs weekly.
--
-- `mos_subject_publish_rank` is the tie-break: 0 for a subject that must be
-- live at a fixed moment, 1 for one that goes live when it is ready. Ordering
-- is unchanged in every other respect — publish day still comes first, and the
-- sweep still prefers the longest-waiting task within a rank.
-- ============================================================================

BEGIN;

/*
 * 0 = has a fixed publish moment · 1 = goes live when ready.
 *
 * A ROW always publishes at its scheduled time, so it always ranks 0. A paid
 * creative ranks 1 only when its own month says ads run as each is approved
 * (`month_starts.<YYYY-MM>.ads_live_when_ready`); in any other month an ad has
 * a real batch moment and keeps rank 0, so nothing changes for it.
 */
CREATE OR REPLACE FUNCTION public.mos_subject_publish_rank(p_subject_table text, p_subject_id uuid)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE
    WHEN p_subject_table = 'mos_content_rows' THEN 0
    WHEN EXISTS (
      SELECT 1
        FROM public.mos_content c
        LEFT JOIN public.mos_content_plan cp ON cp.content_id = c.id
        CROSS JOIN public.mos_month_template t
       WHERE c.id = p_subject_id
         AND c.purpose = 'paid'
         AND COALESCE(
               t.month_starts
                 -> to_char(COALESCE(c.target_publish_at, cp.need_at) AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM')
                 ->> 'ads_live_when_ready',
               'false') = 'true'
    ) THEN 1
    ELSE 0
  END
$$;
REVOKE ALL ON FUNCTION public.mos_subject_publish_rank(text, uuid) FROM PUBLIC, anon, authenticated;

DO $migrate$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  -- ── starts: which SUBJECT opens its first task ──────────────────────────
  v_def := pg_get_functiondef('public.mos_plan_start_due()'::regprocedure);
  v_old := 'ORDER BY public.mos_subject_publish_at(q.st, q.id) ASC NULLS LAST, q.id';
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'MOS:MIGRATION_ANCHOR_MISSING start_due order';
  END IF;
  v_new := 'ORDER BY public.mos_subject_publish_at(q.st, q.id) ASC NULLS LAST, '
        || 'public.mos_subject_publish_rank(q.st, q.id) ASC, q.id';
  EXECUTE replace(v_def, v_old, v_new);

  -- ── sweep: which WAITING task is assigned as capacity frees ─────────────
  v_def := pg_get_functiondef('public.mos_dispatch_sweep()'::regprocedure);
  v_old := E'ORDER BY public.mos_subject_publish_at(t.subject_table, t.subject_id) ASC NULLS LAST,\n'
        || E'              COALESCE(t.waiting_since, t.created_at), t.id';
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'MOS:MIGRATION_ANCHOR_MISSING sweep order';
  END IF;
  v_new := E'ORDER BY public.mos_subject_publish_at(t.subject_table, t.subject_id) ASC NULLS LAST,\n'
        || E'              public.mos_subject_publish_rank(t.subject_table, t.subject_id) ASC,\n'
        || E'              COALESCE(t.waiting_since, t.created_at), t.id';
  EXECUTE replace(v_def, v_old, v_new);
END $migrate$;

DO $$
BEGIN
  IF pg_get_functiondef('public.mos_plan_start_due()'::regprocedure) NOT LIKE '%mos_subject_publish_rank%'
     OR pg_get_functiondef('public.mos_dispatch_sweep()'::regprocedure) NOT LIKE '%mos_subject_publish_rank%' THEN
    RAISE EXCEPTION 'MOS:PUBLISH_RANK_REWIRE_FAILED';
  END IF;
  -- A row is always fixed-time, whatever month it belongs to.
  IF public.mos_subject_publish_rank('mos_content_rows', gen_random_uuid()) <> 0 THEN
    RAISE EXCEPTION 'MOS:PUBLISH_RANK_ROW_NOT_FIXED';
  END IF;
  -- An unknown content id has no month and no live-when-ready rule: rank 0,
  -- the conservative side — it is never DEPRIORITISED by accident.
  IF public.mos_subject_publish_rank('mos_content', gen_random_uuid()) <> 0 THEN
    RAISE EXCEPTION 'MOS:PUBLISH_RANK_DEFAULT_NOT_FIXED';
  END IF;
END $$;

COMMIT;
