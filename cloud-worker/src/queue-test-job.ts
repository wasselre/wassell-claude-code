// One-off script to queue a Phase 0 smoke-test job into presentation_jobs.
// Run with:  npx tsx src/queue-test-job.ts
//
// Picks the first available template (ping-test if it exists, otherwise
// whatever's around). The Phase 0 runner ignores the template anyway —
// it always fires the same hardcoded smoke prompt — so any template id
// satisfies the FK constraint.

import { createHash, randomUUID } from 'node:crypto';
import { loadEnv } from './env.ts';
import { createWorkerSupabase } from './supabase.ts';

async function main(): Promise<void> {
  const env = loadEnv();
  const supabase = createWorkerSupabase(env);

  const { data: templates, error: tplErr } = await supabase
    .from('presentation_templates')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(5);
  if (tplErr || !templates || templates.length === 0) {
    console.error('no templates in presentation_templates — seed at least one first');
    process.exit(1);
  }
  // Prefer ping-test if it exists; otherwise just take the first row.
  const tpl = templates.find((t) => t.slug === 'ping-test') ?? templates[0]!;
  console.log(`using template: ${tpl.slug} (${tpl.id})`);

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
    inputs: { smoke: 'phase0' },
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
  console.log(`queued cloud-worker smoke test job ${row.id}`);
}

void main().catch((err: unknown) => {
  console.error('fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
