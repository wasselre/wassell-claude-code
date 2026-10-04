-- The Safa portal's daily status check also saves the broker unit cards
-- (2026-10-04). The portal needs an SMS code to sign in; the status check
-- already gets one a day through the WhatsApp code relay. Appending a
-- `save_items` step to its status_recipe lets the SAME sign-in store every
-- project's unit cards in portal-registrations/inventory/<portal>/units.json,
-- which the automated project-update run (source_type safa_broker) reads —
-- no second code request per day.
--
-- Project ids = the portal ids of the 12 Safa projects in the update list.
-- Idempotent: only appended when the recipe has no save_items step yet.
-- Guarded on the record existing, so it replays as a no-op elsewhere.

BEGIN;

UPDATE public.records r
SET data = jsonb_set(
  r.data,
  '{status_recipe}',
  to_jsonb((
    (r.data->>'status_recipe')::jsonb || jsonb_build_array(
      jsonb_build_object('do', 'phase', 'ar', 'حفظ وحدات المشاريع للتحديث الآلي', 'en', 'Saving the project units for the automatic update'),
      jsonb_build_object(
        'do', 'save_items',
        'key', 'units',
        'item_selector', 'div.unit_details',
        'max_pages', 80,
        -- optional: an inventory hiccup is logged, never fails the status sync
        'optional', true,
        'urls', (
          SELECT jsonb_agg('https://broker.safainv.sa/project/properties/' || pid || '?page={{page}}' ORDER BY pid)
          FROM (
            SELECT DISTINCT substring(u.data->>'source_url' FROM 'details/(\d+)') AS pid
            FROM public.records u
            WHERE u.model_id = 'aa10c001-2026-4824-9000-000000000001'
              AND u.data->>'source_type' = 'safa_broker'
              AND u.data->>'source_url' ~ 'details/\d+'
          ) ids
        )
      )
    )
  )::text)
)
WHERE r.id = 'd2c8bfd8-5f37-4979-ad25-10709218d0df'
  AND r.data->>'status_recipe' IS NOT NULL
  AND position('save_items' IN r.data->>'status_recipe') = 0;

-- Al-Ramz: capture the broker portal's projects page (an Inertia app — the
-- #app element carries the page JSON in data-page) on the daily status check,
-- to learn whether the portal carries units / price lists the update lane can
-- read. Read-only, optional, one page.
UPDATE public.records
SET data = jsonb_set(data, '{status_recipe}', to_jsonb((
  (data->>'status_recipe')::jsonb || jsonb_build_array(
    jsonb_build_object('do','save_items','key','projects','item_selector','#app','optional',true,'max_pages',3,
      'urls', jsonb_build_array('https://brokerportal.alramzre.com/user/projects?page={{page}}'))))::text))
WHERE id = 'a0702e76-8617-402b-9ac9-5d7ed3c865ec'
  AND data->>'status_recipe' IS NOT NULL
  AND position('save_items' IN data->>'status_recipe') = 0;

COMMIT;
