/**
 * Spoken-word transcripts of video FILES.
 *
 * One source of truth in the database (`file_video_transcripts`): the collected
 * reel's transcript when the video came from the social collector, else our own
 * `file_transcripts` row; Arabic first. The RPC applies the file's own view
 * check per row, so a file the caller cannot see simply has no entry.
 *
 * A video with NO entry either has no speech (music-only) or was never
 * transcribed — callers show "no transcript", never an empty box.
 */
import { supabase } from '@/lib/supabase';

export interface VideoTranscript {
  text: string;
  language: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Transcripts for a batch of file ids — one request for a whole grid. Throws
 *  on a database error so the caller can say the transcripts failed to load
 *  (rather than showing every video as "no transcript"). */
export async function fetchVideoTranscripts(fileIds: string[]): Promise<Record<string, VideoTranscript>> {
  const ids = [...new Set(fileIds.filter((id) => UUID_RE.test(id)))];
  if (!supabase || ids.length === 0) return {};
  const { data, error } = await supabase.rpc('file_video_transcripts', { p_file_ids: ids });
  if (error) throw new Error(`load transcripts: ${error.message}`);
  const out: Record<string, VideoTranscript> = {};
  for (const row of (data ?? []) as Array<{ file_id: string; transcript: string; language: string | null }>) {
    out[row.file_id] = { text: row.transcript, language: row.language };
  }
  return out;
}

/** A video's length as m:ss (h:mm:ss past an hour). Null/0 → null. */
export function formatVideoDuration(seconds: number | null | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
