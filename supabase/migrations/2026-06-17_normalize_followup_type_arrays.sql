-- F-1 — normalize followup_type writes from scalar string to single-element array.
--
-- W3–W11 create_record actions wrote followup_type as a bare string (e.g.
-- "offer_follow_up"); the match conditions are arrays (["offer_follow_up"]). It
-- worked only via the engine's loose-equality fallback ('x' == ['x']). This
-- makes both sides arrays so the engine uses strict array-equality. SURGICAL:
-- preserves every branch/action/condition/mapping id and order, changing ONLY
-- the followup_type static_value shape, ONLY for the 9 affected workflows.
-- W1/W2 already write arrays (untouched); W12 creates no follow-up (untouched).
-- Idempotent: only wraps values where jsonb_typeof(static_value)='string'.

-- In-DB rollback snapshot (a JSON snapshot is also committed under docs/audits/).
CREATE TABLE IF NOT EXISTS public._backup_workflows_followuptype_20260617 AS
SELECT id, label_en, branches, actions, conditions
FROM public.workflows
WHERE id IN (
  '4b60ef83-5e16-4ff1-b522-b88e7ae2ab35','12da04dd-8119-4aeb-a573-ce85864ab657',
  'f7864a0d-226b-44d0-92a7-2d69b3dcc70e','3f2b8499-c2ed-42d8-960f-75722a2d3736',
  'e4e0680c-4400-4030-8013-2bb21abb2a2f','278823ff-68d4-4e3d-9395-d6b37c31477a',
  '9966776a-c722-4453-b4c9-f8bc9d8fe535','3f3e4606-e87c-4ba8-ace0-c1314cf4d895',
  'fcff0ba0-2bc7-4ed8-b6db-6b2994a1f507'
);

UPDATE public.workflows w
SET
  branches = (
    SELECT jsonb_agg(
      CASE WHEN b.elem ? 'actions' THEN jsonb_set(b.elem, '{actions}', (
        SELECT COALESCE(jsonb_agg(
          CASE WHEN a.elem->>'type'='create_record' AND a.elem ? 'field_mappings'
            THEN jsonb_set(a.elem, '{field_mappings}', (
              SELECT jsonb_agg(
                CASE WHEN m.elem->>'target_field_id'='followup_type' AND jsonb_typeof(m.elem->'static_value')='string'
                  THEN jsonb_set(m.elem, '{static_value}', jsonb_build_array(m.elem->'static_value'))
                  ELSE m.elem END ORDER BY m.ord)
              FROM jsonb_array_elements(a.elem->'field_mappings') WITH ORDINALITY AS m(elem,ord)))
            ELSE a.elem END ORDER BY a.ord), '[]'::jsonb)
        FROM jsonb_array_elements(b.elem->'actions') WITH ORDINALITY AS a(elem,ord)))
      ELSE b.elem END ORDER BY b.ord)
    FROM jsonb_array_elements(w.branches) WITH ORDINALITY AS b(elem,ord)),
  actions = CASE WHEN jsonb_array_length(COALESCE(w.actions,'[]'::jsonb)) = 0 THEN w.actions ELSE (
    SELECT jsonb_agg(
      CASE WHEN a.elem->>'type'='create_record' AND a.elem ? 'field_mappings'
        THEN jsonb_set(a.elem, '{field_mappings}', (
          SELECT jsonb_agg(
            CASE WHEN m.elem->>'target_field_id'='followup_type' AND jsonb_typeof(m.elem->'static_value')='string'
              THEN jsonb_set(m.elem, '{static_value}', jsonb_build_array(m.elem->'static_value'))
              ELSE m.elem END ORDER BY m.ord)
          FROM jsonb_array_elements(a.elem->'field_mappings') WITH ORDINALITY AS m(elem,ord)))
        ELSE a.elem END ORDER BY a.ord)
    FROM jsonb_array_elements(w.actions) WITH ORDINALITY AS a(elem,ord)) END
WHERE w.id IN (
  '4b60ef83-5e16-4ff1-b522-b88e7ae2ab35','12da04dd-8119-4aeb-a573-ce85864ab657',
  'f7864a0d-226b-44d0-92a7-2d69b3dcc70e','3f2b8499-c2ed-42d8-960f-75722a2d3736',
  'e4e0680c-4400-4030-8013-2bb21abb2a2f','278823ff-68d4-4e3d-9395-d6b37c31477a',
  '9966776a-c722-4453-b4c9-f8bc9d8fe535','3f3e4606-e87c-4ba8-ace0-c1314cf4d895',
  'fcff0ba0-2bc7-4ed8-b6db-6b2994a1f507'
);

-- Existing-records guard: normalize any scalar followup_type record to a
-- single-element array. Per the audit this affects 0 rows today; included for
-- completeness + to sweep up any scalar created before this patch deploys.
CREATE TABLE IF NOT EXISTS public._backup_followup_type_string_20260617 AS
SELECT id, data->'followup_type' AS old_value FROM public.records
WHERE model_id='764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63' AND jsonb_typeof(data->'followup_type')='string';

UPDATE public.records
SET data = jsonb_set(data, '{followup_type}', jsonb_build_array(data->'followup_type'))
WHERE model_id='764e0e67-0ad1-4e21-8ed3-8f32cb0e6e63' AND jsonb_typeof(data->'followup_type')='string';
