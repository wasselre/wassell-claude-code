#!/usr/bin/env node
// Register only mappings supported by captured unit identities. No credentials.
import { readFileSync } from 'node:fs';
import { query } from './binghatti-db.mjs';

const mapping = JSON.parse(readFileSync(new URL('../worker/src/projectUpdates/fixtures/binghatti-project-map.json', import.meta.url), 'utf8'));
const grouped = new Map();
for (const row of mapping.projects) {
  const ids = grouped.get(row.crm_project_id) ?? [];
  ids.push(row.portal_project_id);
  grouped.set(row.crm_project_id, ids);
}
const config = [...grouped.entries()].map(([project, ids]) => ({
  project, source_project_ids: ids, source_url: `https://partners.binghatti.com/Properties?projectIds=${ids.join(',')}`,
  source_type: 'binghatti_broker', update_frequency: 'weekly', is_active: true, auto_scope: 'full',
  binghatti_area_basis: 'net', binghatti_area_unit: 'sqft',
  mapping_verified_at: mapping.captured_at,
  mapping_provenance: { captured_at: mapping.captured_at, source: mapping.source },
  migration_instructions: 'قائمة بن غاطي الكاملة للوحدات المتاحة من بوابة الوسطاء. الربط برمز المطور ثم رقم فريد. المساحة الصافية بالقدم المربع × 0.09290304؛ السعر بالدرهم × 1.021103 مقرب للريال، مع حفظ السعر الأصلي. المراحل تجمع قبل المطابقة. لا يُعتبر الغياب بيعاً إلا من ملف كامل أحدث من 36 ساعة. إيقاف الأمان يبقى فعالاً.',
}));
const configJson = JSON.stringify(config);
const sql = `-- Register verified August mappings, one row per CRM project (phases merged).
-- A fresh capture must revalidate them before weekly scheduling is enabled.
BEGIN;
DO $migration$
DECLARE v_schema jsonb; v_si int; v_fi int; v_field jsonb;
BEGIN
  SELECT m.schema, (s.ord-1)::int, (f.ord-1)::int, f.field
    INTO v_schema, v_si, v_fi, v_field
    FROM public.models m, jsonb_array_elements(m.schema->'sections') WITH ORDINALITY s(section,ord),
      jsonb_array_elements(s.section->'fields') WITH ORDINALITY f(field,ord)
    WHERE m.name='unit_updates' AND f.field->>'name'='source_type';
  IF v_schema IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_field->'options') o WHERE o->>'value'='binghatti_broker') THEN
    UPDATE public.models SET schema=jsonb_set(v_schema, ARRAY['sections',v_si::text,'fields',v_fi::text,'options'],
      (v_field->'options') || jsonb_build_array(jsonb_build_object('value','binghatti_broker',
        'label_ar','بوابة وسطاء بن غاطي','label_en','Binghatti broker portal','color','#B8734F')))
      WHERE name='unit_updates';
  END IF;
END $migration$;
DO $register$
DECLARE v_row jsonb; v_project uuid; v_id uuid; v_run uuid; v_data jsonb; v_n int:=0;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.records WHERE model_id='220c49b9-de57-492d-9eca-c0d9f54fd40f'
    AND data->>'developer'='759fa833-e60e-4775-86ab-292005c8d517') THEN RETURN; END IF;
  INSERT INTO public.project_update_runs(run_key,source_type,trigger,dry_run,status,outcome,finished_at,params)
    VALUES('setup:binghatti:'||gen_random_uuid()::text,'binghatti_broker','manual',false,'done','no_change',now(),
      '{"setup_only":true}'::jsonb) RETURNING id INTO v_run;
  FOR v_row IN SELECT value FROM jsonb_array_elements($config$${configJson}$config$::jsonb) LOOP
    v_project := (v_row->>'project')::uuid;
    IF NOT EXISTS(SELECT 1 FROM public.records WHERE id=v_project
      AND model_id='220c49b9-de57-492d-9eca-c0d9f54fd40f'
      AND data->>'developer'='759fa833-e60e-4775-86ab-292005c8d517') THEN
      RAISE EXCEPTION 'Binghatti mapping project % is missing or has another developer',v_project USING ERRCODE='WS422';
    END IF;
    IF EXISTS(SELECT 1 FROM public.records WHERE model_id='aa10c001-2026-4824-9000-000000000001'
      AND data->>'project'=v_project::text AND data->>'source_type'='binghatti_broker') THEN CONTINUE; END IF;
    v_id:=gen_random_uuid();
    v_data:=v_row||jsonb_build_object('next_due',public.project_update_riyadh_today()::text,
      'migration_log',public.project_update_riyadh_today()::text||' — سُجّل للتحديث الآلي؛ الجدولة تنتظر التحقق من أول ملف كامل.');
    PERFORM public.record_save('aa10c001-2026-4824-9000-000000000001'::uuid,v_id,v_data,
      'a3374d65-9cee-4daa-8880-5e8ff23e7db0'::uuid,NULL);
    INSERT INTO public.project_update_changes(run_id,project_id,record_id,model,action,before,after,reason)
      VALUES(v_run,v_project,v_id,'unit_updates','create',NULL,v_data,'verified Binghatti project mapping');
    v_n:=v_n+1;
  END LOOP;
  UPDATE public.project_update_runs SET summary=jsonb_build_object('setup_only',true,'registered',v_n,
    'schedule_enabled',false) WHERE id=v_run;
END $register$;
COMMIT;
`;
if (process.argv.includes('--write')) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(new URL('../supabase/migrations/2026-10-05_11_register_binghatti_updates.sql', import.meta.url), sql);
  console.log(`Generated ${config.length} project registrations (${mapping.projects.length} portal phases)`);
} else if (process.argv.includes('--apply')) {
  console.log(JSON.stringify(await query(sql)));
} else {
  console.log(JSON.stringify({ projects: config.length, portal_phases: mapping.projects.length, schedule_enabled: false }));
}
