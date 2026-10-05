import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProjectUpdateRun } from '../runProjectUpdateJob.js';
import { loadBinghattiSnapshot, type BinghattiSnapshot } from './binghatti.js';

/** A scheduled run refreshes its inventory before applying. Dry runs only read
 *  the stored capture. Requeues reuse ONE capture job; no repeated OTP requests. */
export async function ensureBinghattiCapture(
  supabase: SupabaseClient,
  run: ProjectUpdateRun,
  portalId: string,
): Promise<BinghattiSnapshot | null> {
  const snapshot = await loadBinghattiSnapshot(supabase, portalId);
  if (snapshot?.fresh) return snapshot;
  if (run.dry_run) throw new Error('Binghatti dry run needs a complete inventory less than 36 hours old; capture it first');

  let jobId = typeof run.params.binghatti_capture_job_id === 'string' ? run.params.binghatti_capture_job_id : null;
  if (!jobId) {
    const { data, error } = await supabase.rpc('portal_status_check_enqueue', { p_portal_record_id: portalId, p_user_id: null });
    if (error || typeof data !== 'string') throw new Error(`Binghatti capture enqueue: ${error?.message ?? 'no job id'}`);
    jobId = data;
    const params = { ...run.params, binghatti_capture_job_id: jobId, binghatti_capture_requested_at: new Date(Date.now()).toISOString() };
    const saved = await supabase.from('project_update_runs').update({ params }).eq('id', run.id).eq('status', 'running');
    if (saved.error) throw new Error(`Binghatti capture state: ${saved.error.message}`);
    run.params = params;
  }
  const { data: job, error } = await supabase.from('portal_registration_jobs')
    .select('status, parked_at, error_message, portal_record_id').eq('id', jobId).single();
  if (error || !job) throw new Error(`Binghatti capture job: ${error?.message ?? 'missing'}`);
  if (job.portal_record_id !== portalId) throw new Error('Binghatti capture job belongs to another portal');
  if (job.parked_at) throw new Error('Binghatti capture is waiting for the operator OTP; no inventory was applied');
  if (!['queued', 'running', 'awaiting_input'].includes(job.status)) {
    throw new Error(`Binghatti capture ${job.status}: ${job.error_message ?? 'no fresh complete inventory saved'}`);
  }
  const requestedAt = Date.parse(String(run.params.binghatti_capture_requested_at ?? ''));
  if (!Number.isFinite(requestedAt) || requestedAt > Date.now() || Date.now() - requestedAt > 30 * 60_000) {
    throw new Error('Binghatti capture did not complete within 30 minutes; no inventory was applied');
  }
  const deferred = await supabase.rpc('project_update_defer', {
    p_id: run.id, p_seconds: 60, p_note: `Waiting for Binghatti inventory capture ${jobId}`,
  });
  if (deferred.error || deferred.data !== true) throw new Error(`Binghatti capture defer: ${deferred.error?.message ?? 'run is no longer running'}`);
  return null;
}
