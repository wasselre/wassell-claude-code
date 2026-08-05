-- Marketing OS — a success measure now knows which ACTUAL metric it tracks.
--
-- Before this, a campaign's pace/gap/funnel scraped the first number out of the
-- free-text goal and assumed it was a qualified-lead count. Now the goal is a
-- description and the NUMBERS come from the success measures — but a measure only
-- carried a target + a display unit (count/currency/percent), not what it counts.
-- `source` closes that gap: it maps a measure type to the live metric its target
-- is measured against, so «مشاهدات = 200,000» computes pace against IMPRESSIONS,
-- labeled «مشاهدة», never «مؤهل».

BEGIN;

ALTER TABLE public.mos_measure_types
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'none';

ALTER TABLE public.mos_measure_types
  DROP CONSTRAINT IF EXISTS mos_measure_types_source_check;
ALTER TABLE public.mos_measure_types
  ADD CONSTRAINT mos_measure_types_source_check
  CHECK (source IN ('impressions','clicks','leads','qualified','spend','cpl','cpl_qualified','ctr','none'));

-- Seeded presets → their real metric.
UPDATE public.mos_measure_types SET source = CASE key
  WHEN 'cpl_qualified' THEN 'cpl_qualified'
  WHEN 'cpl'           THEN 'cpl'
  WHEN 'leads'         THEN 'qualified'    -- preset labeled «عدد العملاء المؤهلين» = qualified
  WHEN 'reach'         THEN 'impressions'  -- no separate reach actual; impressions is the closest
                                           -- live count (matches the organic reach the app already
                                           -- sums from linked content impressions)
  ELSE source
END
WHERE source = 'none';

-- Best-guess for types created before this column existed (label keyword match);
-- still user-overridable in the measure editor afterwards.
UPDATE public.mos_measure_types SET source = CASE
  WHEN label_ar ~ 'مشاهد|ظهور'          OR label_en ~* 'impression|view'  THEN 'impressions'
  WHEN label_ar ~ 'وصول'                OR label_en ~* 'reach'            THEN 'impressions'
  WHEN label_ar ~ 'ضغط|نقر'             OR label_en ~* 'click'
       THEN (CASE WHEN unit = 'percent' THEN 'ctr' ELSE 'clicks' END)
  WHEN label_ar ~ 'مؤهل'                OR label_en ~* 'qualified'        THEN 'qualified'
  WHEN label_ar ~ 'عميل|عملاء|ليد'      OR label_en ~* 'lead'
       THEN (CASE WHEN unit = 'currency' THEN 'cpl' ELSE 'leads' END)
  WHEN unit = 'currency'                                                  THEN 'cpl'
  ELSE 'none'
END
WHERE source = 'none';

-- Stamp `source` onto every campaign's success_measures snapshot, from its
-- measure type (matched by type_key). Idempotent: elements that already carry a
-- source are left untouched.
UPDATE public.mos_campaigns c
SET success_measures = (
  SELECT jsonb_agg(
    CASE
      WHEN elem ? 'source' THEN elem
      ELSE elem || jsonb_build_object('source', COALESCE(
        (SELECT t.source FROM public.mos_measure_types t WHERE t.key = elem->>'type_key'),
        'none'))
    END
    ORDER BY ord
  )
  FROM jsonb_array_elements(c.success_measures) WITH ORDINALITY AS e(elem, ord)
)
WHERE jsonb_typeof(c.success_measures) = 'array'
  AND jsonb_array_length(c.success_measures) > 0;

COMMIT;
