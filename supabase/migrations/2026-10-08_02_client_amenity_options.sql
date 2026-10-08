-- More amenities a client can ask for (operator, 2026-10-08). Chosen from what
-- our units and projects actually record, so the project finder can find them:
--   in the unit:    بلكونة، غرفة غسيل، غرفة ملابس، مستودع، تراس، حديقة خاصة
--   in the project: حدائق ومساحات خضراء، نادي رياضي، جلسات خارجية، ألعاب أطفال،
--                   حراسة وكاميرات، ممشى، شواحن سيارات كهربائية،
--                   جاكوزي وساونا وسبا، ملعب بادل
-- Appends to clients.preferred_amenities; an option whose value already exists
-- is left as it is (re-runnable). Values follow the field's existing convention
-- (the Arabic label). The finder's synonym groups (api/_lib/matchAgent.ts and its
-- twin src/lib/matching/amenityMatch.ts) map each to the project / unit values.

DO $$
DECLARE
  v_model uuid;
  v_schema jsonb;
  v_s int;
  v_f int;
  v_opts jsonb;
  v_new jsonb := '[
    {"value":"بلكونة","label_ar":"بلكونة","label_en":"Balcony"},
    {"value":"غرفة غسيل","label_ar":"غرفة غسيل","label_en":"Laundry Room"},
    {"value":"غرفة ملابس","label_ar":"غرفة ملابس","label_en":"Walk-in Closet"},
    {"value":"مستودع","label_ar":"مستودع","label_en":"Storage Room"},
    {"value":"تراس","label_ar":"تراس","label_en":"Terrace"},
    {"value":"حديقة خاصة","label_ar":"حديقة خاصة","label_en":"Private Garden"},
    {"value":"حدائق ومساحات خضراء","label_ar":"حدائق ومساحات خضراء","label_en":"Gardens & Green Spaces"},
    {"value":"نادي رياضي","label_ar":"نادي رياضي","label_en":"Gym"},
    {"value":"جلسات خارجية","label_ar":"جلسات خارجية","label_en":"Outdoor Seating"},
    {"value":"ألعاب أطفال","label_ar":"ألعاب أطفال","label_en":"Kids Play Area"},
    {"value":"حراسة وكاميرات","label_ar":"حراسة وكاميرات","label_en":"Security & Cameras"},
    {"value":"ممشى","label_ar":"ممشى","label_en":"Walking Track"},
    {"value":"شواحن سيارات كهربائية","label_ar":"شواحن سيارات كهربائية","label_en":"EV Chargers"},
    {"value":"جاكوزي وساونا وسبا","label_ar":"جاكوزي وساونا وسبا","label_en":"Jacuzzi, Sauna & Spa"},
    {"value":"ملعب بادل","label_ar":"ملعب بادل","label_en":"Padel Court"}
  ]'::jsonb;
  o jsonb;
BEGIN
  SELECT id, schema INTO v_model, v_schema FROM public.models WHERE name = 'clients';
  IF v_model IS NULL THEN RAISE NOTICE 'no clients model'; RETURN; END IF;

  SELECT (s.ord - 1)::int, (f.ord - 1)::int INTO v_s, v_f
    FROM jsonb_array_elements(v_schema->'sections') WITH ORDINALITY s(sec, ord),
         jsonb_array_elements(s.sec->'fields') WITH ORDINALITY f(fld, ord)
   WHERE f.fld->>'name' = 'preferred_amenities';
  IF v_s IS NULL THEN RAISE EXCEPTION 'clients.preferred_amenities not found'; END IF;

  v_opts := COALESCE(v_schema->'sections'->v_s->'fields'->v_f->'options', '[]'::jsonb);
  FOR o IN SELECT * FROM jsonb_array_elements(v_new) LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_opts) e WHERE e->>'value' = o->>'value') THEN
      v_opts := v_opts || jsonb_build_array(o || jsonb_build_object('id', gen_random_uuid()::text));
    END IF;
  END LOOP;

  UPDATE public.models
     SET schema = jsonb_set(schema, ARRAY['sections', v_s::text, 'fields', v_f::text, 'options'], v_opts)
   WHERE id = v_model;
END $$;
