/**
 * runInboundMediaJob — durably SAVE an inbound WhatsApp media file and, for voice
 * notes, TRANSCRIBE it (fal wizper). Drains the `inbound_media_jobs` queue.
 *
 * WHY A QUEUE. The webhook's inline mirror (api/_lib/waha.mirrorWahaHostedMedia)
 * is bounded to ~10s because it runs on the webhook hot path. WAHA writes — and
 * for voice notes TRANSCODES — its /api/files copy ASYNCHRONOUSLY and evicts it
 * within minutes, so slow voice notes miss the 10s window and are lost forever
 * ("تعذّر تحميل الملف"). This lane retries the fetch across queue ticks (linear
 * backoff, capped at inbound_media_max_attempts) so it wins the race, then mirrors
 * the bytes into `whatsapp-media/<session>/<fname>` — the EXACT path downloadFile
 * reads — and transcribes audio.
 *
 * Idempotent: a file already mirrored (by the hot-path attempt or a prior run) is
 * NOT re-fetched — the job then only needs to transcribe. A transcription failure
 * is NOT a job failure: the media is saved, so the job completes and only the
 * message's transcript_status goes 'failed'. Bytes are the point; text is a bonus.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { transcribeAudioUrl } from './marketing/content/falTranscribe.js';

const BUCKET = 'wassel-files';
const MIRROR_PREFIX = 'whatsapp-media';
/** Within one run: WAHA may still be writing/transcoding — a few quick retries.
 *  The queue's own backoff (inbound_media_fail) covers the longer window. */
const FETCH_RETRY_MS = [0, 2000, 5000];

export interface InboundMediaJob {
  id: string;
  messageId: string;
  chatWid: string | null;
  session: string;
  fname: string;
  mime: string | null;
  kind: string | null;
  attempts: number;
}

interface Deps {
  supabase: SupabaseClient;
  env: { WAHA_URL?: string | null; WAHA_API_KEY?: string | null; WORKER_ID: string };
  job: InboundMediaJob;
}

function isAudio(kind: string | null, mime: string | null): boolean {
  return kind === 'audio' || (!!mime && mime.startsWith('audio/'));
}

export async function runInboundMediaJob({ supabase, env, job }: Deps): Promise<void> {
  const failJob = (msg: string, requeue: boolean) =>
    supabase.rpc('inbound_media_fail', { p_id: job.id, p_error: msg, p_requeue: requeue });

  try {
    const wahaUrl = (env.WAHA_URL ?? '').replace(/\/+$/, '');
    const apiKey = env.WAHA_API_KEY ?? '';
    if (!wahaUrl || !apiKey) { await failJob('WAHA_URL/WAHA_API_KEY not set', false); return; }

    const target = `${MIRROR_PREFIX}/${job.session}/${job.fname}`;
    const stem = job.fname.includes('.') ? job.fname.slice(0, job.fname.lastIndexOf('.')) : job.fname;

    // Already mirrored (hot-path attempt, outbound mirror, or a prior run)?
    let mirrored = false;
    const { data: existing } = await supabase.storage
      .from(BUCKET).list(`${MIRROR_PREFIX}/${job.session}`, { search: stem, limit: 10 });
    if ((existing ?? []).some((o) => o.name === job.fname || (stem && o.name.startsWith(`${stem}.`)))) {
      mirrored = true;
    }

    let contentType = job.mime || 'application/octet-stream';
    if (!mirrored) {
      let bytes: Uint8Array | null = null;
      for (let i = 0; i < FETCH_RETRY_MS.length; i++) {
        if (FETCH_RETRY_MS[i]) await new Promise((r) => setTimeout(r, FETCH_RETRY_MS[i]));
        let res: Response;
        try {
          res = await fetch(`${wahaUrl}/api/files/${job.session}/${job.fname}`, {
            headers: { 'X-Api-Key': apiKey }, signal: AbortSignal.timeout(20_000),
          });
        } catch { continue; } // network/timeout — transient, retry
        if (res.ok) {
          bytes = new Uint8Array(await res.arrayBuffer());
          contentType = job.mime || res.headers.get('content-type') || contentType;
          break;
        }
        // 400/401/403 = misconfig/bad ref — retrying won't help.
        if (res.status !== 404 && res.status < 500) { await failJob(`WAHA fetch ${res.status} (not retryable)`, false); return; }
        // else 404 (not written yet) / 5xx (transient) — loop.
      }
      if (!bytes) { await failJob('WAHA file not ready yet', true); return; } // requeue with backoff
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(target, bytes, { contentType, upsert: true });
      if (upErr && !/exists/i.test(upErr.message)) { await failJob(`upload: ${upErr.message}`, true); return; }
      mirrored = true;
    }

    // The bytes are durably saved now.
    await supabase.from('chat_messages').update({ media_saved: true }).eq('id', job.messageId);

    // Voice note → transcribe (fal wizper, auto-detect language). A failure here
    // never fails the job: the audio is saved and playable regardless.
    if (isAudio(job.kind, job.mime)) {
      try {
        const { data: signed, error: signErr } = await supabase.storage.from(BUCKET).createSignedUrl(target, 600);
        if (signErr || !signed?.signedUrl) throw new Error(`sign: ${signErr?.message ?? 'no url'}`);
        const t = await transcribeAudioUrl(signed.signedUrl, null, {
          track: { area: 'sales', callSite: 'worker/runInboundMediaJob' },
          language: null, // fal auto-detect — inbound is Saudi Arabic, sometimes mixed/English
        });
        const text = (t.text ?? '').trim();
        await supabase.from('chat_messages').update({
          transcript: text || null,
          transcript_lang: t.language ?? null,
          transcript_status: text ? 'done' : 'none',
        }).eq('id', job.messageId);
      } catch (e) {
        await supabase.from('chat_messages').update({ transcript_status: 'failed' }).eq('id', job.messageId);
        console.error(`[inbound-media] transcribe failed msg=${job.messageId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    await supabase.rpc('inbound_media_complete', { p_id: job.id });
    console.log(`[inbound-media] done job=${job.id} msg=${job.messageId} kind=${job.kind ?? '?'} attempts=${job.attempts}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[inbound-media] job=${job.id} error: ${msg}`);
    await failJob(msg, true);
    throw err;
  }
}
