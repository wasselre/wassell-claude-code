// One-off probe: does presentation_jobs already have step_outputs?
import { loadEnv } from './env.ts';
import { createWorkerSupabase } from './supabase.ts';

const s = createWorkerSupabase(loadEnv());
const { data, error } = await s
  .from('presentation_jobs')
  .select('id, step_outputs')
  .limit(1);

if (error) {
  console.log('ERROR:', error.message);
  console.log('CODE:', error.code);
  process.exit(1);
}
console.log('column exists, sample:', JSON.stringify(data ?? []));
