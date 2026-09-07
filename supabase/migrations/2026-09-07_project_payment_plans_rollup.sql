-- ============================================================================
-- 2026-09-07  Project payment-plan menu auto-derives from the units
--
-- Until now the project-level payment-plan fields on all_projects
-- (payment_plan_schedule table, payment_plan_summary text, and the headline
-- down_payment_percent / during_construction_percent / on_handover_percent)
-- were hand-entered and went stale the moment a unit gained or lost a plan
-- card. The Payment Plans TAB already rolled the structures up live from the
-- units in the browser, so the tab and the stored menu could disagree — and
-- the tab is only shown when the stored menu is non-empty, so a project whose
-- units carried plans but whose menu was never filled had no tab at all.
--
-- This migration makes the stored menu a ROLLUP maintained by Postgres, the
-- same way the thirteen unit rollups are (2026-06-15_persist_project_rollups):
--   • recalc_project_payment_plans_data(project_id) computes the distinct
--     payment STRUCTURES across the project's units' `payment_plans` cards
--     (deduped on the down / before-handover / on-handover / after-handover
--     split), the summary text, and the headline percentages from the ENTRY
--     plan (lowest down %, tie-break highest on-handover %) — the same rule
--     2026-08-07_binghatti_payment_plans_cleanup used.
--   • tg_records_fill_project_rollups (the existing BEFORE INSERT/UPDATE
--     trigger on all_projects rows) now merges that patch too, so every unit
--     change — which already "touches" the project — recomputes the menu.
--   • MANUAL FALLBACK: when NO unit of the project carries a plan card the
--     function returns '{}' and whatever was typed on the project stays. The
--     units win only when they have something to say.
--   • `_row_id`s in the generated table rows are DETERMINISTIC (md5 of the
--     project id + structure key) so a recompute that changes nothing rewrites
--     nothing — no diff churn, stable element identity.
--   • post_handover_months is NOT derived (a %-split can't express months);
--     it stays manual.
--
-- It also adds an optional `schedule` TEXT column to BOTH plan tables (the
-- unit's `payment_plans` and the project's `payment_plan_schedule`): the
-- milestone-by-milestone breakdown ("20% عند التعاقد · 10% عند إنجاز 20% …")
-- that the four-bucket split can't carry. The rollup copies the most common
-- schedule text of each structure onto the project row.
--
-- Finally it seeds the three developer plan models (نموذج 1 / 2 / 3, from the
-- developer's price list) onto EVERY unit of four Saudi projects —
-- ستون الندى · ستون الملقا · ربوة الرمز · تل الربوة — guarded so a unit that
-- already has plan cards is left alone, and touches every project that has
-- unit plans so the stored menus catch up immediately.
--
-- all_projects and units are UNFROZEN JSONB in `records`: no DDL, all JSONB.
-- Idempotent. Safe to re-run.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────
-- 1. Schema: optional `schedule` text column on both plan tables.
-- ────────────────────────────────────────────────────────────────────────
UPDATE public.models m
SET schema = jsonb_set(schema, '{sections}', (
  SELECT jsonb_agg(
    CASE WHEN s ? 'fields'
      THEN jsonb_set(s, '{fields}', (
        SELECT jsonb_agg(
          CASE WHEN f->>'name' = 'payment_plans'
                AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(f->'table_columns','[]'::jsonb)) c WHERE c->>'name' = 'schedule')
            THEN jsonb_set(f, '{table_columns}', COALESCE(f->'table_columns','[]'::jsonb) || $col$[
              {"id":"33333333-0000-4000-8000-000000000008","name":"schedule","type":"text","label_ar":"جدول الدفعات","label_en":"Schedule","required":false}
            ]$col$::jsonb)
            ELSE f END ORDER BY fo)
        FROM jsonb_array_elements(s->'fields') WITH ORDINALITY t(f, fo)))
      ELSE s END ORDER BY so)
  FROM jsonb_array_elements(schema->'sections') WITH ORDINALITY ts(s, so)))
WHERE m.name = 'units';

UPDATE public.models m
SET schema = jsonb_set(schema, '{sections}', (
  SELECT jsonb_agg(
    CASE WHEN s ? 'fields'
      THEN jsonb_set(s, '{fields}', (
        SELECT jsonb_agg(
          CASE WHEN f->>'name' = 'payment_plan_schedule'
                AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(f->'table_columns','[]'::jsonb)) c WHERE c->>'name' = 'schedule')
            THEN jsonb_set(f, '{table_columns}', COALESCE(f->'table_columns','[]'::jsonb) || $col$[
              {"id":"a1111111-0000-4000-8000-000000000006","name":"schedule","type":"text","label_ar":"جدول الدفعات","label_en":"Schedule"}
            ]$col$::jsonb)
            ELSE f END ORDER BY fo)
        FROM jsonb_array_elements(s->'fields') WITH ORDINALITY t(f, fo)))
      ELSE s END ORDER BY so)
  FROM jsonb_array_elements(schema->'sections') WITH ORDINALITY ts(s, so)))
WHERE m.name = 'all_projects';

-- ────────────────────────────────────────────────────────────────────────
-- 2. The recompute. STABLE + SECURITY DEFINER for the same reason as
--    recalc_project_rollups_data: it must see ALL units of the project
--    regardless of the writer's RLS, or a rep who can create a unit but not
--    read the others would shrink the menu.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._pp_fmt(n numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN n IS NULL THEN '0'
              WHEN n = trunc(n) THEN trunc(n)::bigint::text
              ELSE n::text END;
$$;

CREATE OR REPLACE FUNCTION public.recalc_project_payment_plans_data(p_project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_units   uuid := public._rollups_units_model_id();
  v_pid     text := p_project_id::text;
  v_sched   jsonb;
  v_summary text;
  v_n       int;
  v_down    numeric;
  v_during  numeric;
  v_on      numeric;
BEGIN
  IF v_units IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  WITH cards AS (
    SELECT u.id AS unit_id,
           COALESCE(public.try_numeric(e->>'down'), 0)            AS down,
           COALESCE(public.try_numeric(e->>'before_handover'), 0) AS during,
           COALESCE(public.try_numeric(e->>'on_handover'), 0)     AS on_h,
           COALESCE(public.try_numeric(e->>'after_handover'), 0)  AS post,
           nullif(btrim(COALESCE(e->>'plan', '')), '')            AS plan,
           nullif(btrim(COALESCE(e->>'schedule', '')), '')        AS schedule
    FROM public.records u,
         jsonb_array_elements(
           CASE WHEN jsonb_typeof(u.data->'payment_plans') = 'array'
                THEN u.data->'payment_plans' ELSE '[]'::jsonb END
         ) e
    WHERE u.model_id = v_units
      AND (
        u.data->>'project_id' = v_pid
        OR (jsonb_typeof(u.data->'project_id') = 'array' AND u.data->'project_id' ? v_pid)
      )
  ),
  valid AS (                       -- an all-zero card is not a plan
    SELECT * FROM cards WHERE down + during + on_h + post > 0
  ),
  grp AS (                         -- one row per distinct structure
    SELECT down, during, on_h, post,
           count(DISTINCT unit_id) AS n_units,
           mode() WITHIN GROUP (ORDER BY plan)     FILTER (WHERE plan IS NOT NULL)     AS plan,
           mode() WITHIN GROUP (ORDER BY schedule) FILTER (WHERE schedule IS NOT NULL) AS schedule
    FROM valid
    GROUP BY down, during, on_h, post
  ),
  ranked AS (
    SELECT g.*,
           row_number() OVER (ORDER BY down, during, on_h, post) AS pno,
           public._pp_fmt(down) || '/' || public._pp_fmt(during) || '/'
             || public._pp_fmt(on_h) || '/' || public._pp_fmt(post) AS skey
    FROM grp g
  )
  SELECT
    jsonb_agg(jsonb_build_object(
      '_row_id',             md5(v_pid || ':' || skey)::uuid,
      'plan',                COALESCE(plan, pno::text),
      'down',                down,
      'during_construction', during,
      'on_handover',         on_h,
      'post_handover',       post,
      'schedule',            schedule
    ) ORDER BY pno),
    string_agg(
      COALESCE(plan, 'خطة ' || pno) || ': ' ||
      concat_ws(' / ',
        CASE WHEN down   > 0 THEN public._pp_fmt(down)   || '% مقدم'          END,
        CASE WHEN during > 0 THEN public._pp_fmt(during) || '% أثناء الإنشاء' END,
        CASE WHEN on_h   > 0 THEN public._pp_fmt(on_h)   || '% عند التسليم'   END,
        CASE WHEN post   > 0 THEN public._pp_fmt(post)   || '% بعد التسليم'   END),
      E'\n' ORDER BY pno),
    count(*),
    -- entry plan = lowest down %, tie-break highest on-handover %
    (array_agg(down   ORDER BY down ASC, on_h DESC))[1],
    (array_agg(during ORDER BY down ASC, on_h DESC))[1],
    (array_agg(on_h   ORDER BY down ASC, on_h DESC))[1]
  INTO v_sched, v_summary, v_n, v_down, v_during, v_on
  FROM ranked;

  IF COALESCE(v_n, 0) = 0 THEN
    RETURN '{}'::jsonb;            -- no unit plans → leave the manual values alone
  END IF;

  RETURN jsonb_build_object(
    'payment_plan_schedule',       v_sched,
    'payment_plan_summary',        v_summary,
    'down_payment_percent',        v_down,
    'during_construction_percent', v_during,
    'on_handover_percent',         v_on
  );
END;
$$;

-- ────────────────────────────────────────────────────────────────────────
-- 3. Fill trigger: merge the payment-plan patch next to the unit rollups.
--    Re-emitted verbatim from the live definition with ONLY the extra call.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_records_fill_project_rollups()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.model_id = public._rollups_all_projects_model_id() THEN
    NEW.data := COALESCE(NEW.data, '{}'::jsonb)
             || public.recalc_project_rollups_data(NEW.id)
             || public.recalc_project_payment_plans_data(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────
-- 4. Seed: the developer's three plan models on every unit of the four
--    projects. Guard: a unit that already carries plan cards is untouched.
--    Plan prices are deliberately left empty — for these projects the price
--    is the unit's total_price (the UI falls back to it).
-- ────────────────────────────────────────────────────────────────────────
SET LOCAL "wassell.system_write" = 'payment_plans_seed';

UPDATE public.records u
SET data = u.data || jsonb_build_object('payment_plans', p.rows)
FROM (
  SELECT u2.id,
         jsonb_agg(jsonb_build_object(
           '_row_id',         gen_random_uuid(),
           'plan',            v.plan,
           'down',            v.down,
           'before_handover', v.before,
           'on_handover',     v.on_h,
           'after_handover',  0,
           'schedule',        v.schedule
         ) ORDER BY v.ord) AS rows
  FROM public.records u2
  CROSS JOIN (VALUES
    (1, 'نموذج 1', 20, 75, 5,
     '20% عند التعاقد · 10% عند إنجاز 20% · 20% عند إنجاز 40% · 20% عند إنجاز 60% · 20% عند إنجاز 80% · 5% عند إنجاز 95% · 5% عند الإفراغ والتسليم'),
    (2, 'نموذج 2', 5, 80, 15,
     '5% عند التعاقد · 5% عند إنجاز 10% · 10% عند إنجاز 20% · 10% عند إنجاز 30% · 10% عند إنجاز 40% · 10% عند إنجاز 50% · 10% عند إنجاز 60% · 10% عند إنجاز 70% · 15% عند إنجاز 85% · 15% عند الإفراغ والتسليم'),
    (3, 'نموذج 3 (مع خصم خاص)', 40, 40, 20,
     '40% عند التعاقد · 40% عند إنجاز 50% · 20% عند الإفراغ والتسليم')
  ) AS v(ord, plan, down, before, on_h, schedule)
  WHERE u2.model_id = public._rollups_units_model_id()
    AND public._rollup_project_id_of(u2.data) IN (
      'ff658a62-fa27-424d-9c34-e56d7a9ef350',   -- ستون الندى
      '3117ab2a-f50a-4c48-ae4b-fca6b6ed68bb',   -- ستون الملقا
      'd14c1370-0852-4c4d-8245-e61b3d8ac003',   -- ربوة الرمز
      'bd4c49b0-49c9-4157-8592-570d73efa941'    -- تل الربوة
    )
    -- NULL-safe: an ABSENT key must count as "no cards". `NOT (NULL AND …)`
    -- is NULL and silently filters every such unit out (the first apply of
    -- this migration seeded 0 rows for exactly that reason).
    AND COALESCE(
          CASE WHEN jsonb_typeof(u2.data->'payment_plans') = 'array'
               THEN jsonb_array_length(u2.data->'payment_plans') END, 0) = 0
  GROUP BY u2.id
) p
WHERE u.id = p.id;

-- ────────────────────────────────────────────────────────────────────────
-- 5. Backfill: touch every project that has at least one unit with plan
--    cards so its stored menu is recomputed now (the BEFORE trigger fills it).
-- ────────────────────────────────────────────────────────────────────────
UPDATE public.records pr
SET data = pr.data
WHERE pr.model_id = public._rollups_all_projects_model_id()
  AND EXISTS (
    SELECT 1 FROM public.records u
    WHERE u.model_id = public._rollups_units_model_id()
      AND public._rollup_project_id_of(u.data) = pr.id::text
      AND jsonb_typeof(u.data->'payment_plans') = 'array'
      AND jsonb_array_length(u.data->'payment_plans') > 0
  );
