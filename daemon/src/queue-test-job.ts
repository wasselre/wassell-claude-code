// One-off tool: queue a test presentation job directly against Supabase so
// we can watch the daemon pick it up end-to-end. Run from daemon/ with:
//   npx tsx src/queue-test-job.ts
//
// Safe to delete after first verification.

import { createHash, randomUUID } from 'node:crypto';
import { loadEnv } from './env.ts';
import { createDaemonSupabase } from './supabase.ts';

const TEST_BRIEF =
  'اختبار تشغيل الخط الإنتاج للعروض — حي النرجس، الرياض، مشروع سكني تجريبي بـ 12 وحدة.';

async function main(): Promise<void> {
  const env = loadEnv();
  const supabase = createDaemonSupabase(env);

  const { data: templates, error: tplErr } = await supabase
    .from('presentation_templates')
    .select('*')
    .eq('slug', 'wassel')
    .limit(1);
  if (tplErr || !templates || templates.length === 0) {
    console.error('could not find wassel template:', tplErr?.message ?? 'empty');
    process.exit(1);
  }
  const tpl = templates[0]!;

  const inputs = { project_brief: TEST_BRIEF };
  const normalizedInputs = JSON.stringify(inputs, Object.keys(inputs).sort());
  const dedupKey = createHash('sha256')
    .update(`${tpl.id}||${normalizedInputs}`)
    .digest('hex');

  const nowIso = new Date().toISOString();
  const row = {
    id: randomUUID(),
    template_id: tpl.id,
    template_slug: tpl.slug,
    template_snapshot: tpl,
    record_id: null,
    record_model_id: null,
    record_snapshot: null,
    inputs,
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
    error_code: null,
    error_message: null,
    error_detail: null,
    created_at: nowIso,
    updated_at: nowIso,
  };

  const { error } = await supabase.from('presentation_jobs').insert(row);
  if (error) {
    console.error('insert failed:', error.message);
    process.exit(2);
  }
  console.log(`queued ${row.id}`);
  console.log(`watch: https://zhqqsxwealdwqzrbpwyv.supabase.co (or /presentations/${row.id} in the app)`);
}

void main().catch((err: unknown) => {
  console.error('fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
