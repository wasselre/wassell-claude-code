import { loadEnv } from './env.ts';
import { createWorkerSupabase } from './supabase.ts';

const jobId = process.argv[2];
if (!jobId) {
  console.error('usage: tsx src/check-job.ts <job-id>');
  process.exit(1);
}

const supabase = createWorkerSupabase(loadEnv());
const { data, error } = await supabase
  .from('presentation_jobs')
  .select('id, status, duration_ms, result, claimed_by, finished_at, progress_message_en')
  .eq('id', jobId)
  .single();
if (error) {
  console.error('query error:', error.message);
  process.exit(1);
}
console.log(JSON.stringify(data, null, 2));
