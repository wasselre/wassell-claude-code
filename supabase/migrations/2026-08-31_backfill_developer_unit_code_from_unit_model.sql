-- Backfill developer_unit_code from unit_model on units where the developer's
-- code was captured during import but landed in the wrong field.
--
-- Context: 727 units (model units 7ca3014d-…) had an empty developer_unit_code
-- while their developer code was sitting in `unit_model` and echoed in `notes`
-- as "الكود: …". Affected projects: المشرقية 2 (468), أديم الفرسان (102),
-- أكنان 25 (62), لورافيو (37), ريفييرا 59 (24), نوار – حي الملك عبدالله (16),
-- ريفييرا 57 (16), ريفييرا 44 (2).
--
-- We copy unit_model -> developer_unit_code ONLY where developer_unit_code is
-- empty, unit_model is non-empty, and the row shows a code signal (an explicit
-- "الكود" label in notes OR a code-shaped unit_model like `TY01-AA-1-1`).
-- unit_model is left untouched. This never overwrites an existing value and is
-- limited to the fill-the-gap case, so it is fully reversible.
--
-- units is UNFROZEN (JSONB in the unified `records` table), so this is a direct
-- data UPDATE — no frozen-table view-chain unwind needed. The developer_unit_code
-- field is not a rollup input (price/area/status), so the units->project touch
-- trigger just re-touches the linked projects harmlessly.

UPDATE public.records r
SET data = jsonb_set(
      r.data,
      '{developer_unit_code}',
      to_jsonb(btrim(r.data->>'unit_model'))
    )
WHERE r.model_id = '7ca3014d-f658-418e-9c53-2d279c97f009'
  AND nullif(btrim(r.data->>'developer_unit_code'), '') IS NULL
  AND nullif(btrim(r.data->>'unit_model'), '') IS NOT NULL
  AND (
        r.data->>'notes' ILIKE '%الكود%'
     OR (r.data->>'unit_model') ~ '^[A-Za-z0-9]+-[A-Za-z0-9-]+'
      );
