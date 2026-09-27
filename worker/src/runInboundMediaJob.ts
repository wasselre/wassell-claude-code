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
  /** The webhook's decision (isNew && !isOps && has-phone) that this inbound
   *  should drive the basic bot. For a voice note the webhook skips its own
   *  immediate basic-reply call and lets the transcript drive the answer here. */
  triggerBot: boolean;
}

interface Deps {
  supabase: SupabaseClient;
  env: {
    WAHA_URL?: string | null;
    WAHA_API_KEY?: string | null;
    WORKER_ID: string;
    APP_URL?: string | null;
    WHATSAPP_AI_SECRET?: string | null;
  };
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
    let transcriptText = '';
    if (isAudio(job.kind, job.mime)) {
      try {
        const { data: signed, error: signErr } = await supabase.storage.from(BUCKET).createSignedUrl(target, 600);
        if (signErr || !signed?.signedUrl) throw new Error(`sign: ${signErr?.message ?? 'no url'}`);
        const t = await transcribeAudioUrl(signed.signedUrl, null, {
          track: { area: 'sales', callSite: 'worker/runInboundMediaJob' },
          language: null, // fal auto-detect — inbound is Saudi Arabic, sometimes mixed/English
        });
        transcriptText = (t.text ?? '').trim();
        await supabase.from('chat_messages').update({
          transcript: transcriptText || null,
          transcript_lang: t.language ?? null,
          transcript_status: transcriptText ? 'done' : 'none',
        }).eq('id', job.messageId);
      } catch (e) {
        await supabase.from('chat_messages').update({ transcript_status: 'failed' }).eq('id', job.messageId);
        console.error(`[inbound-media] transcribe failed msg=${job.messageId}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Now that the voice note is transcribed, let it DRIVE the basic bot — the
      // webhook deliberately skipped its own immediate reply for audio (which
      // could only ever hand off). A non-empty transcript is fed as the trigger
      // message so classify() answers it like a typed message; on empty/failed we
      // still fire with a null message, reproducing the media hand-off so the
      // customer is never left without a reply. Fire-and-forget: never fails the
      // job (the bytes + transcript are already saved).
      if (job.triggerBot) {
        await driveBot({ supabase, env, job, transcript: transcriptText || null });
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

/**
 * POST the transcribed voice note to the basic bot so it answers like a typed
 * message. Fire-and-forget by contract: any failure is logged and swallowed —
 * the media + transcript are already durably saved, and a bot hiccup must not
 * fail (or requeue) the media job. basic-reply re-checks its own gate
 * (should_reply: kill switch / working hours / human-active / reply cap), so a
 * late trigger after a human has replied is correctly skipped there.
 */
async function driveBot(
  { supabase, env, job, transcript }: Deps & { transcript: string | null },
): Promise<void> {
  try {
    const chatWid = (job.chatWid ?? '').trim();
    const base = (env.APP_URL ?? '').replace(/\/+$/, '');
    const secret = env.WHATSAPP_AI_SECRET ?? '';
    if (!chatWid || !base || !secret) {
      if (!secret) console.warn('[inbound-media] WHATSAPP_AI_SECRET unset — not driving bot');
      return;
    }
    // The counterparty phone lives on the stored message; basic-reply needs it to
    // resolve the device + recipient. chat_record_id is derived by basic-reply
    // from chat_wid when omitted.
    const { data: msg } = await supabase
      .from('chat_messages')
      .select('from_phone')
      .eq('id', job.messageId)
      .maybeSingle();
    const phone = (msg as { from_phone?: string | null } | null)?.from_phone ?? null;

    const res = await fetch(`${base}/api/whatsapp/basic-reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-wassel-ai-secret': secret },
      body: JSON.stringify({
        chat_wid: chatWid,
        trigger_message: transcript, // null on empty/failed → media hand-off fallback
        device_id: job.session,
        phone,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(`[inbound-media] basic-reply ${res.status} for msg=${job.messageId}`);
    } else {
      console.log(`[inbound-media] drove bot for msg=${job.messageId} (transcript=${transcript ? 'yes' : 'none'})`);
    }
  } catch (e) {
    console.error(`[inbound-media] driveBot failed msg=${job.messageId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
