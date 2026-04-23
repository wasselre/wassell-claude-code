/**
 * Smoke test — verifies the daemon's plumbing end-to-end WITHOUT spawning
 * Claude. Run with `npm run smoke` (in daemon/).
 *
 * Checks:
 *   1. loadEnv() reads .env and returns a sane config.
 *   2. createDaemonSupabase() can reach the Supabase project.
 *   3. syncTemplateManifests() reads the user's template manifests.
 *   4. startHeartbeat() writes a single heartbeat row and stops cleanly.
 *   5. claim_next_presentation_job RPC is callable (returns zero rows when
 *      the queue is empty, not an error).
 *
 * Fail-loud: any step that errors aborts with a non-zero exit code so you
 * know your setup is broken before queuing a real job.
 */

import { loadEnv } from './env.ts';
import { createDaemonSupabase } from './supabase.ts';
import { syncTemplateManifests } from './templates.ts';
import { startHeartbeat } from './heartbeat.ts';
import { DAEMON_VERSION } from './version.ts';

async function main(): Promise<void> {
  console.log(`[smoke] wassell-presentations-daemon v${DAEMON_VERSION}`);

  console.log('[smoke] 1/5 loading env...');
  const env = loadEnv();
  console.log(
    `       ✓ SUPABASE_URL=${env.supabaseUrl.slice(0, 32)}... templates=${env.templatesDir}`,
  );

  console.log('[smoke] 2/5 connecting to Supabase...');
  const supabase = createDaemonSupabase(env);
  const pingStart = Date.now();
  const { error: pingErr } = await supabase.from('daemon_status').select('id').limit(1);
  if (pingErr) {
    console.error(`       ✗ Supabase read failed: ${pingErr.message}`);
    process.exit(2);
  }
  console.log(`       ✓ connected (${Date.now() - pingStart}ms)`);

  console.log(`[smoke] 3/5 syncing templates from ${env.templatesDir} ...`);
  const result = await syncTemplateManifests(supabase, env);
  console.log(
    `       ✓ synced=[${result.synced.join(', ')}] invalid=${result.invalid.length} disabled=[${result.disabled.join(', ')}]`,
  );
  if (result.invalid.length > 0) {
    for (const bad of result.invalid) {
      console.warn(`       ! ${bad.path}: ${bad.error}`);
    }
  }
  if (result.synced.length === 0) {
    console.warn(
      `       ! no templates synced — make sure ${env.templatesDir}/<slug>/template.json exists`,
    );
  }

  console.log('[smoke] 4/5 writing one heartbeat...');
  const hb = startHeartbeat({ supabase, intervalMs: 60_000 });
  await hb.beatNow();
  await hb.stop();
  console.log('       ✓ heartbeat written');

  console.log('[smoke] 5/5 calling claim_next_presentation_job RPC (no-op when queue empty)...');
  const { error: rpcErr, data } = await supabase.rpc('claim_next_presentation_job', {
    p_worker: 'smoke-test',
  });
  if (rpcErr) {
    console.error(`       ✗ RPC failed: ${rpcErr.message}`);
    process.exit(3);
  }
  const claimed = Array.isArray(data) ? data.length : data ? 1 : 0;
  console.log(`       ✓ RPC returned ${claimed} row(s) (expected 0 on empty queue)`);
  if (claimed > 0) {
    console.warn(
      '       ! The smoke test accidentally claimed a real queued job. This is unusual. ' +
        "You probably want to manually flip it back to 'queued' via SQL so a real daemon picks it up.",
    );
  }

  console.log('[smoke] all checks passed — daemon plumbing is healthy');
  process.exit(0);
}

void main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[smoke] fatal: ${msg}`);
  process.exit(1);
});
