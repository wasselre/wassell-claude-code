/**
 * Browser-side client for the `claude_jobs` queue — app-triggered Claude Code
 * sessions (client studies v1). Enqueue is a plain authenticated INSERT (RLS
 * allows it); status flows back via polling the row (the runner daemon updates
 * it through service-role RPCs). See scripts/claude-study-runner.mjs.
 */

import { supabase } from '@/lib/supabase';

export interface ClaudeJobResult {
  title?: string;
  pdf_signed_url?: string;
  pdf_storage_path?: string;
  /** files.id of the PDF attached to the client record (null if attach failed). */
  attached_file_id?: string | null;
  whatsapp_draft?: string;
  summary?: string;
  heads_ups?: string[];
}

export interface ClaudeJob {
  id: string;
  kind: string;
  status: 'pending' | 'running' | 'ready' | 'failed' | 'cancelled';
  result: ClaudeJobResult | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export class ClaudeJobsError extends Error {}

export async function enqueueClientStudy(
  chatRecordId: string,
  requestedByUserId: string | null,
  notes?: string,
  /** Prior job id when this is a feedback-driven regenerate — the runner tells
   *  the session it's a revision addressing the rep's feedback. */
  revisionOf?: string | null,
): Promise<string> {
  if (!supabase) throw new ClaudeJobsError('Supabase غير متصل');
  const trimmed = (notes ?? '').trim();
  const { data, error } = await supabase
    .from('claude_jobs')
    .insert({
      kind: 'client_study',
      payload: {
        chat_record_id: chatRecordId,
        ...(trimmed ? { notes: trimmed } : {}),
        ...(revisionOf ? { revision_of: revisionOf } : {}),
      },
      requested_by_user_id: requestedByUserId,
    })
    .select('id')
    .single();
  if (error) throw new ClaudeJobsError(error.message);
  return (data as { id: string }).id;
}

/** Latest job for a chat (any status), or null. */
export async function fetchLatestStudyJob(chatRecordId: string): Promise<ClaudeJob | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('claude_jobs')
    .select('id, kind, status, result, error, created_at, started_at, finished_at')
    .eq('kind', 'client_study')
    .eq('payload->>chat_record_id', chatRecordId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new ClaudeJobsError(error.message);
  return (data?.[0] as ClaudeJob | undefined) ?? null;
}
