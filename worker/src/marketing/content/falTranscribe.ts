// ============================================================================
// Video transcription via fal.ai (Phase 5).
//
// MODEL CHOICE — fal-ai/wizper (Whisper large-v3, faster-whisper backend):
//   • Arabic + Saudi dialect: Whisper large-v3 is the strongest widely-hosted
//     multilingual ASR for Arabic; wizper runs exactly that model.
//   • Mixed Arabic/English: language is LEFT UNSET so Whisper auto-detects and
//     code-switches per segment (forcing language='ar' truncates English spans).
//   • Timestamps: chunk_level='segment' returns [{timestamp:[start,end],text}].
//   • Cost: ~$0.01 / audio-minute (fal wizper pricing) — cheapest hosted v3.
//   • Latency: seconds for <3-min reels; well within the worker's job lease.
//   • Input: a fetchable audio/video URL; we feed a 16 kHz mono m4a we extract
//     with ffmpeg and host in marketing-assets (public, dedup by checksum).
// Alternatives considered: fal-ai/whisper (same v3, heavier options we don't
// need), fal-ai/elevenlabs/speech-to-text (no per-segment ts on cheap tier).
// Documented in docs/prd/... via the final report.
//
// Reuses the exact fal queue submit/poll shape as imageGen.ts (POST → request_id
// + status_url + response_url; poll until COMPLETED; GET response_url).
// ============================================================================

const STUB = 'stub';

export interface TranscriptSegment { start_ms: number; end_ms: number; text: string }
export interface TranscriptResult {
  text: string; segments: TranscriptSegment[]; language: string | null;
  model: string; provider: string; costUsd: number; raw: unknown;
}

function falEnv() {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error('FAL_KEY not set');
  return {
    apiKey,
    baseUrl: process.env.FAL_BASE_URL ?? 'https://queue.fal.run',
    model: process.env.FAL_TRANSCRIBE_MODEL_ID ?? 'fal-ai/wizper',
  };
}

// Whisper emits these on silent / music-only audio (no real speech). Treated as
// "no meaningful speech" so a music reel isn't stored as a bogus English line.
const HALLUCINATIONS = new Set(['you', 'thank you', 'thank you.', 'thanks for watching', 'thanks for watching!', 'bye', 'bye.', '.', '..', '...', 'subscribe', 'the end']);
export function isMeaninglessTranscript(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!.?،]/g, '').trim();
  return t.length < 3 || HALLUCINATIONS.has(t) || HALLUCINATIONS.has(text.trim().toLowerCase());
}

/** Detect ar / en / mixed from the transcript text (Whisper doesn't always label). */
export function detectLanguage(text: string, inferred?: string[]): string | null {
  if (inferred && inferred.length > 1) return 'mixed';
  const ar = (text.match(/[؀-ۿ]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  if (ar === 0 && en === 0) return inferred?.[0] ?? null;
  if (ar > 0 && en > 0 && Math.min(ar, en) / Math.max(ar, en) > 0.12) return 'mixed';
  return ar >= en ? 'ar' : 'en';
}

/**
 * Transcribe an audio URL (16 kHz mono m4a hosted publicly). Returns normalized
 * transcript + timestamped segments + detected language. Throws on terminal
 * failure so the caller records an explicit failed transcript row.
 */
export async function transcribeAudioUrl(audioUrl: string, durationMs: number | null): Promise<TranscriptResult> {
  const env = falEnv();
  if (env.apiKey === STUB) {
    return { text: 'وصل ريفييرا عرض خاص', segments: [{ start_ms: 0, end_ms: 2000, text: 'وصل ريفييرا عرض خاص' }], language: 'ar', model: 'stub', provider: 'fal', costUsd: 0, raw: { stub: true } };
  }
  const model = env.model.replace(/^\//, '');
  const submit = await fetch(`${env.baseUrl.replace(/\/$/, '')}/${model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Key ${env.apiKey}` },
    body: JSON.stringify({ audio_url: audioUrl, task: 'transcribe', chunk_level: 'segment', version: '3' }),
  });
  if (!submit.ok) throw new Error(`wizper submit ${submit.status}: ${(await submit.text().catch(() => '')).slice(0, 300)}`);
  const s = (await submit.json()) as { status_url?: string; response_url?: string };
  if (!s.status_url || !s.response_url) throw new Error(`wizper missing status/response url: ${JSON.stringify(s).slice(0, 200)}`);

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await fetch(s.status_url, { headers: { Authorization: `Key ${env.apiKey}` } });
    if (!st.ok) throw new Error(`wizper poll ${st.status}`);
    const status = ((await st.json()) as { status?: string }).status?.toUpperCase();
    if (status === 'FAILED' || status === 'ERROR') throw new Error('wizper failed');
    if (status !== 'COMPLETED') continue;
    const rr = await fetch(s.response_url, { headers: { Authorization: `Key ${env.apiKey}` } });
    if (!rr.ok) throw new Error(`wizper result ${rr.status}`);
    const j = (await rr.json()) as { text?: string; chunks?: Array<{ timestamp?: [number, number]; text?: string }>; inferred_languages?: string[] };
    const rawText = (j.text ?? '').trim();
    const costUsd = durationMs ? Math.round((durationMs / 60000) * 0.01 * 10000) / 10000 : 0;
    // Music-only / silent reels → Whisper hallucinates "you"/"thanks for watching".
    // Store an explicit no-speech transcript rather than a bogus line.
    if (isMeaninglessTranscript(rawText)) {
      return { text: '', segments: [], language: 'none', model: env.model, provider: 'fal', costUsd, raw: j };
    }
    const segments: TranscriptSegment[] = (j.chunks ?? []).map((c) => ({
      start_ms: Math.round((c.timestamp?.[0] ?? 0) * 1000),
      end_ms: Math.round((c.timestamp?.[1] ?? 0) * 1000),
      text: (c.text ?? '').trim(),
    })).filter((sg) => sg.text);
    return { text: rawText, segments, language: detectLanguage(rawText, j.inferred_languages), model: env.model, provider: 'fal', costUsd, raw: j };
  }
  throw new Error('wizper poll timed out');
}
