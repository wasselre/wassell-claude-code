-- Lead portals: «إشعار المسؤول تلقائياً بعد التسجيل» (operator, 2026-10-07:
-- "once a client is registered in the Al Ramz portal, a message should go to
-- the officer — automatically, without approval").
--
-- Adds the `notify_officer_on_register` checkbox to the lead_portals model's
-- "Sign-in & automation" section. When ticked, /api/cron/ai-sales-automation
-- (step 3c, api/_lib/officerRegistrationNotice.ts) tells the project's officer
-- about every successful registration in that portal, from the operations line.
-- The record's hidden `notify_officer_since` key (ISO time) bounds how far back
-- it looks, so ticking it never announces an old backlog.
--
-- Idempotent: the field is appended only when the section does not have it.

UPDATE public.models m
SET schema = jsonb_set(
      m.schema,
      '{sections,1,fields}',
      (m.schema->'sections'->1->'fields') || jsonb_build_object(
        'id', gen_random_uuid()::text,
        'name', 'notify_officer_on_register',
        'label_ar', 'إشعار المسؤول تلقائياً بعد التسجيل',
        'label_en', 'Tell the officer automatically after registering',
        'type', 'checkbox',
        'required', false,
        'order', jsonb_array_length(m.schema->'sections'->1->'fields'),
        'section_id', m.schema->'sections'->1->>'id',
        'width', 'half',
        'show_in_table', false
      )
    )
WHERE m.id = '1ead0000-0000-4000-8000-000000000001'
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(m.schema->'sections'->1->'fields') f
    WHERE f->>'name' = 'notify_officer_on_register'
  );
