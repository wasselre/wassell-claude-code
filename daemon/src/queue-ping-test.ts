// Queue a /ping-test job to verify the sentinel parser end-to-end in ~20s.
// The /ping-test slash command just prints a progress sentinel and a fake
// result sentinel, no external I/O. Run with:
//   npx tsx src/queue-ping-test.ts

import { createHash, randomUUID } from 'node:crypto';
import { loadEnv } from './env.ts';
import { createDaemonSupabase } from './supabase.ts';

async function main(): Promise<void> {
  const env = loadEnv();
  const supabase = createDaemonSupabase(env);

  const { data: templates, error: tplErr } = await supabase
    .from('presentation_templates')
    .select('*')
    .eq('slug', 'ping-test')
    .limit(1);
  if (tplErr || !templates || templates.length === 0) {
    console.error(
      'ping-test template not found — make sure daemon has synced ~/.claude/ppt/templates/ping-test/template.json',
    );
    process.exit(1);
  }
  const tpl = templates[0]!;

  const inputs = { any_input: 'pong' };
  const nonce = randomUUID(); // ensure a fresh dedup key per run
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
  console.log(`queued ping-test job ${row.id}`);
}

void main().catch((err: unknown) => {
  console.error('fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
