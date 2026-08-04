-- Marketing OS — a campaign's success criterion becomes MULTIPLE measures.
--
-- Before: a campaign had exactly ONE success measure — the scalar pair
-- `success_metric` (a fixed enum: cpl_qualified / cpl / leads / reach) plus
-- `success_threshold` (one number). The UI now lets you add as many measures as
-- you want, each with its own target number, and DEFINE NEW measure types
-- (both inline on the campaign and in a managed Settings list).
--
-- Storage:
--   * `mos_measure_types` — the managed registry of measure types (the four
--     presets are seeded; more can be added in Settings or inline on a campaign).
--   * `mos_campaigns.success_measures` — a jsonb array, one object per measure:
--       { type_key, label_ar, label_en, direction, unit, threshold }
--     The label/direction/unit are SNAPSHOTTED onto the campaign at save time
--     (same "freeze what was chosen" posture as workflow-version pinning), so a
--     later rename/archive of a type never rewrites history and every read
--     surface renders without a join.
--
-- Back-compat: the scalar `success_metric` / `success_threshold` are KEPT and
-- kept in sync with success_measures[0] on every save, so the list/overview/
-- detail judgment logic that reads them keeps working unchanged. No view change:
-- `readCampaignMerged` already merges the base mos_campaigns row into the detail
-- read, so `success_measures` reaches the UI without touching mos_campaign_v
-- (deliberately left alone — it is another workstream's surface).
--
-- Additive, backfilled, idempotent (safe to re-run).

BEGIN;

/* ------------------------------------------------------------------ */
/* 1. The managed measure-type registry.                              */
/* ------------------------------------------------------------------ */

CREATE TABLE IF NOT EXISTS public."mos_measure_types" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "key" text NOT NULL,
  "label_ar" text NOT NULL,
  "label_en" text NOT NULL,
  -- 'higher' = more is better (renders "أو أكثر" / "or more");
  -- 'lower'  = less is better (renders "أو أقل" / "or less").
  "direction" text NOT NULL DEFAULT 'higher',
  -- 'currency' prefixes the riyal unit ("ريال أو أقل" / "SAR or less");
  -- 'count' is a bare number.
  "unit" text NOT NULL DEFAULT 'count',
  -- Presets ship with the system and cannot be deleted (only deactivated).
  "is_preset" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "archived_at" timestamp with time zone,
  CONSTRAINT "mos_measure_types_pkey" PRIMARY KEY (id),
  CONSTRAINT "mos_measure_types_key_key" UNIQUE (key),
  CONSTRAINT "mos_measure_types_direction_chk" CHECK (direction IN ('higher', 'lower')),
  CONSTRAINT "mos_measure_types_unit_chk" CHECK (unit IN ('count', 'currency'))
);

-- Seed the four presets that were previously the hardcoded SUCCESS_METRIC_LABELS.
-- Idempotent: ON CONFLICT keeps any label the operator has since edited.
INSERT INTO public."mos_measure_types"
  (key, label_ar, label_en, direction, unit, is_preset, sort_order)
VALUES
  ('cpl_qualified', 'تكلفة العميل المؤهل', 'Cost per qualified lead', 'lower',  'currency', true, 0),
  ('cpl',           'تكلفة العميل',        'Cost per lead',           'lower',  'currency', true, 1),
  ('leads',         'عدد العملاء المؤهلين', 'Qualified leads',         'higher', 'count',    true, 2),
  ('reach',         'الوصول',              'Reach',                   'higher', 'count',    true, 3)
ON CONFLICT (key) DO NOTHING;

-- RLS mirrors mos_content_types exactly: anyone who can READ the workspace sees
-- the list; only manage_settings can create/edit/deactivate.
ALTER TABLE public."mos_measure_types" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "mos_measure_types_read" ON public."mos_measure_types";
CREATE POLICY "mos_measure_types_read" ON public."mos_measure_types" AS PERMISSIVE FOR SELECT TO "authenticated"
  USING (wassell_mos_can('read'::text));
DROP POLICY IF EXISTS "mos_measure_types_ins" ON public."mos_measure_types";
CREATE POLICY "mos_measure_types_ins" ON public."mos_measure_types" AS PERMISSIVE FOR INSERT TO "authenticated"
  WITH CHECK (wassell_mos_can('manage_settings'::text));
DROP POLICY IF EXISTS "mos_measure_types_upd" ON public."mos_measure_types";
CREATE POLICY "mos_measure_types_upd" ON public."mos_measure_types" AS PERMISSIVE FOR UPDATE TO "authenticated"
  USING (wassell_mos_can('manage_settings'::text))
  WITH CHECK (wassell_mos_can('manage_settings'::text));
DROP POLICY IF EXISTS "mos_measure_types_del" ON public."mos_measure_types";
CREATE POLICY "mos_measure_types_del" ON public."mos_measure_types" AS PERMISSIVE FOR DELETE TO "authenticated"
  USING (wassell_mos_can('manage_settings'::text));

GRANT SELECT, INSERT, UPDATE, DELETE ON public."mos_measure_types" TO "authenticated";
GRANT SELECT ON public."mos_measure_types" TO "anon";
GRANT ALL ON public."mos_measure_types" TO "service_role";

/* ------------------------------------------------------------------ */
/* 2. The campaign's multi-measure column.                            */
/* ------------------------------------------------------------------ */

ALTER TABLE public.mos_campaigns
  ADD COLUMN IF NOT EXISTS success_measures jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Backfill the array from the existing scalar pair, snapshotting the preset's
-- label/direction/unit. Idempotent: only fills rows whose array is still empty.
UPDATE public.mos_campaigns c
   SET success_measures = jsonb_build_array(jsonb_build_object(
         'type_key',  c.success_metric,
         'label_ar',  mt.label_ar,
         'label_en',  mt.label_en,
         'direction', mt.direction,
         'unit',      mt.unit,
         'threshold', c.success_threshold
       ))
  FROM public.mos_measure_types mt
 WHERE mt.key = c.success_metric
   AND c.success_metric IS NOT NULL
   AND c.success_measures = '[]'::jsonb;

-- Fallback: a campaign whose legacy success_metric is NOT one of the seeded
-- presets (e.g. an old/imported value the UI never offered) still gets a
-- measure so its target number is never lost. The metric key doubles as the
-- label; direction/unit default to higher/count. A no-op on a clean install
-- where every metric is a preset.
UPDATE public.mos_campaigns c
   SET success_measures = jsonb_build_array(jsonb_build_object(
         'type_key',  c.success_metric,
         'label_ar',  c.success_metric,
         'label_en',  c.success_metric,
         'direction', 'higher',
         'unit',      'count',
         'threshold', c.success_threshold
       ))
 WHERE c.success_metric IS NOT NULL
   AND c.success_measures = '[]'::jsonb;

COMMIT;
