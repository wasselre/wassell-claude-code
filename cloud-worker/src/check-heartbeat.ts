import { loadEnv } from './env.ts';
import { createWorkerSupabase } from './supabase.ts';

const supabase = createWorkerSupabase(loadEnv());
const { data, error } = await supabase
  .from('daemon_status')
  .select('*')
  .eq('id', 'presentations')
  .single();
if (error) {
  console.error('query error:', error.message);
  process.exit(1);
}
const ageMs = Date.now() - new Date(data.last_heartbeat_at).getTime();
console.log(JSON.stringify(data, null, 2));
console.log(`heartbeat age: ${Math.round(ageMs / 1000)}s`);
