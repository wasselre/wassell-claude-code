// Queue a job by template id. Used in Phase 3 smoke testing where we
// author a template in the UI and want to fire it without going through
// the picker modal.
//
// Run with:  npx tsx src/queue-by-id.ts <template-id>
import { createHash, randomUUID } from 'node:crypto';
import { loadEnv } from './env.ts';
import { createWorkerSupabase } from './supabase.ts';

const tplId = process.argv[2];
if (!tplId) {
  console.error('usage: tsx src/queue-by-id.ts <template-id>');
  process.exit(1);
}

const supabase = createWorkerSupabase(loadEnv());
const { data: tpl, error: tErr } = await supabase
  .from('presentation_templates')
  .select('*')
  .eq('id', tplId)
  .single();
if (tErr || !tpl) {
  console.error('template not found:', tErr?.message ?? '404');
  process.exit(2);
}
console.log(`using template: ${tpl.slug} (steps=${(tpl.steps ?? []).length}, tools=${(tpl.tools ?? []).length})`);

const nonce = randomUUID();
const dedupKey = createHash('sha256').update(`${tpl.id}||${nonce}`).digest('hex');
const nowIso = new Date().toISOString();
const row = {
  id: randomUUID(),
  template_id: tpl.id,
  template_slug: tpl.slug,
  template_snapshot: tpl,
  record_id: null,
  record_model_id: null,
  record_snapshot: null,
  inputs: { project_brief: 'Smoke test for Phase 3 — any project in Riyadh is fine; keep slides minimal.' },
  client_dedup_key: dedupKey,
  requested_by_user_id: null,
  status: 'queued',
  progress_stage: null,
  progress_message_ar: null,
  progress_message_en: null,
  claimed_by: null,
  started_at: null,
  finished_at: null,
  duration_ms: null,
  result: null,
  drive_folder_url: null,
  drive_deck_url: null,
  step_outputs: [],
  error_code: null,
  error_message: null,
  error_detail: null,
  created_at: nowIso,
  updated_at: nowIso,
};
const { error } = await supabase.from('presentation_jobs').insert(row);
if (error) {
  console.error('insert failed:', error.message);
  process.exit(3);
}
console.log(`queued ${row.id}`);
