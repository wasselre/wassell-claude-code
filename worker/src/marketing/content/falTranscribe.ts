// ============================================================================
// Video transcription via fal.ai (Phase 5).
//
// MODEL CHOICE — fal-ai/wizper (Whisper large-v3, faster-whisper backend):
//   • Arabic + Saudi dialect: Whisper large-v3 is the strongest widely-hosted
//     multilingual ASR for Arabic; wizper runs exactly that model.
//   • Timestamps: chunk_level='segment' returns [{timestamp:[start,end],text}].
//   • Cost: ~$0.01 / audio-minute (fal wizper pricing) — cheapest hosted v3.
//   • Latency: seconds for <3-min reels; well within the worker's job lease.
//   • Input: a fetchable audio/video URL; we feed a 16 kHz mono m4a we extract
//     with ffmpeg and host in marketing-assets (public, dedup by checksum).
//
// LANGUAGE — MEASURED 2026-09-02 (docs/eval/asr-ab/report.md):
//   fal's schema DEFAULTS `language` to "en" when the key is omitted — it does
//   NOT auto-detect. Omitting it (the v1 behaviour) makes Whisper decode Saudi
//   Arabic speech as English, which is why 390+ stored transcripts are English
//   translations. `language: null` (explicit) is auto-detect; `language: 'ar'`
//   forces Arabic. Callers that pass no options keep the v1 request shape so
//   the coordinator can switch them deliberately.
//
// CHUNK LEVEL — MEASURED 2026-09-02: wizper's schema declares
//   `chunk_level: const "segment"` and returns 422 on 'word'. Word-level
//   timestamps exist only on fal-ai/whisper (same large-v3 weights, slower).
//   Asking wizper for 'word' throws up front instead of burning a round trip.
//
// Reuses the exact fal queue submit/poll shape as imageGen.ts (POST → request_id
// + status_url + response_url; poll until COMPLETED; GET response_url).
// ============================================================================

const STUB = 'stub';
const WIZPER = 'fal-ai/wizper';
/** fal wizper list price — not returned by the API, so cost is always an estimate. */
const USD_PER_AUDIO_MINUTE = 0.01;

export interface TranscriptSegment { start_ms: number; end_ms: number; text: string }
export interface TranscriptResult {
  text: string; segments: TranscriptSegment[]; language: string | null;
  model: string; provider: string; costUsd: number; raw: unknown;
}

export interface TranscribeOptions {
  /**
   * `'ar'` / `'en'` force that language; `null` sends an explicit null = fal
   * auto-detect; `undefined` (default) OMITS the key = fal's own default,
   * which is "en" (see header). Keep undefined only for the legacy path.
   */
  language?: 'ar' | 'en' | null;
  /** `'segment'` (default, the only value wizper accepts) or `'word'` (fal-ai/whisper only). */
  chunkLevel?: 'segment' | 'word';
  /** Override the fal endpoint id (default `FAL_TRANSCRIBE_MODEL_ID` ?? fal-ai/wizper). */
  model?: string;
  /** wizper: max speech segment seconds before a split (10–29, default 29). */
  maxSegmentLen?: number;
  /** wizper: merge consecutive chunks up to maxSegmentLen (default true). */
  mergeChunks?: boolean;
}

/** Word-level chunks are re-aggregated into speech segments of roughly this length. */
export const WORD_AGG_MIN_MS = 5000;
export const WORD_AGG_MAX_MS = 8000;
/** A silence this long between words closes a segment once it is ≥ WORD_AGG_MIN_MS. */
const WORD_AGG_PAUSE_MS = 700;

interface FalChunk { timestamp?: [number | null, number | null] | null; text?: string }
interface FalResponse { text?: string; chunks?: FalChunk[]; languages?: string[] | null; inferred_languages?: string[] }

function falEnv() {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) throw new Error('FAL_KEY not set');
  return {
    apiKey,
    baseUrl: process.env.FAL_BASE_URL ?? 'https://queue.fal.run',
    model: process.env.FAL_TRANSCRIBE_MODEL_ID ?? WIZPER,
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
 * Normalize fal chunks → segments ORDERED by start_ms. A null start inherits the
 * previous end; a null end collapses to the start (fal's schema allows both).
 * Empty-text chunks are dropped. Returns whether the input was out of order so
 * the caller can decide to rebuild `text` from the sorted chunks.
 */
export function chunksToSegments(chunks: FalChunk[] | undefined): { segments: TranscriptSegment[]; reordered: boolean } {
  let prevEnd = 0;
  const raw: TranscriptSegment[] = [];
  for (const c of chunks ?? []) {
    const text = (c.text ?? '').trim();
    const startS = c.timestamp?.[0];
    const endS = c.timestamp?.[1];
    const start_ms = typeof startS === 'number' ? Math.round(startS * 1000) : prevEnd;
    const end_ms = typeof endS === 'number' ? Math.round(endS * 1000) : start_ms;
    prevEnd = Math.max(prevEnd, end_ms);
    if (text) raw.push({ start_ms, end_ms, text });
  }
  const segments = raw.map((s, i) => ({ s, i })).sort((a, b) => (a.s.start_ms - b.s.start_ms) || (a.i - b.i)).map((x) => x.s);
  const reordered = segments.some((s, i) => s !== raw[i]);
  return { segments, reordered };
}

/**
 * Aggregate ORDERED word-level segments into speech segments of ~5–8 s: a
 * segment closes when the next word would push it past WORD_AGG_MAX_MS, or —
 * once it is at least WORD_AGG_MIN_MS long — at a pause ≥ WORD_AGG_PAUSE_MS or
 * after sentence-final punctuation. Words are joined with single spaces.
 */
export function aggregateWords(words: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  let cur: TranscriptSegment | null = null;
  for (const w of words) {
    if (cur) {
      const span = w.end_ms - cur.start_ms;
      const gap = w.start_ms - cur.end_ms;
      const longEnough = cur.end_ms - cur.start_ms >= WORD_AGG_MIN_MS;
      const closes = span > WORD_AGG_MAX_MS || (longEnough && (gap >= WORD_AGG_PAUSE_MS || /[.!?؟،]$/.test(cur.text)));
      if (closes) { out.push(cur); cur = null; }
    }
    if (!cur) { cur = { start_ms: w.start_ms, end_ms: w.end_ms, text: w.text }; continue; }
    cur.text += ' ' + w.text;
    cur.end_ms = Math.max(cur.end_ms, w.end_ms);
  }
  if (cur) out.push(cur);
  return out;
}

/** Cost estimate in USD from a duration; fal's response carries no billing data. */
function estimateCost(durationMs: number): number {
  return Math.round((durationMs / 60000) * USD_PER_AUDIO_MINUTE * 10000) / 10000;
}

/**
 * Pure post-processing of a fal Whisper response into a TranscriptResult. Split
 * out so it is unit-testable without the queue round trip.
 */
export function normalizeFalResponse(
  j: FalResponse,
  durationMs: number | null,
  model: string,
  request: Record<string, unknown>,
  chunkLevel: 'segment' | 'word',
): TranscriptResult {
  const rawText = (j.text ?? '').trim();
  const inferred = j.languages ?? j.inferred_languages;
  const { segments: ordered, reordered } = chunksToSegments(j.chunks);
  const lastEndMs = ordered.reduce((m, s) => Math.max(m, s.end_ms), 0);
  let costUsd = 0;
  if (durationMs) costUsd = estimateCost(durationMs);
  else if (lastEndMs > 0) costUsd = estimateCost(lastEndMs);
  else console.warn(`[falTranscribe] no duration for ${model} and the response carries no timestamps — recording cost 0`);
  // The stored raw keeps fal's response verbatim (for word mode that IS the word
  // list) plus the exact request so a row is reproducible.
  const raw = { ...j, _request: request };
  // Music-only / silent reels → Whisper hallucinates "you"/"thanks for watching".
  // Store an explicit no-speech transcript rather than a bogus line.
  if (isMeaninglessTranscript(rawText)) {
    return { text: '', segments: [], language: 'none', model, provider: 'fal', costUsd, raw };
  }
  const segments = chunkLevel === 'word' ? aggregateWords(ordered) : ordered;
  // fal's `text` is the chunks concatenated in RESPONSE order. If that order was
  // not chronological, the text is scrambled too — rebuild it from the sorted
  // segments. When the response was already in order, `text` is left verbatim.
  const text = reordered && segments.length ? segments.map((s) => s.text).join(' ') : rawText;
  return { text, segments, language: detectLanguage(text, inferred ?? undefined), model, provider: 'fal', costUsd, raw };
}

/**
 * Transcribe an audio URL (16 kHz mono m4a hosted publicly, or a video URL —
 * fal accepts mp4). Returns normalized transcript + timestamped segments
 * ORDERED by start + detected language. Throws on terminal failure so the
 * caller records an explicit failed transcript row.
 *
 * With no `options` the request is byte-identical to v1 (task transcribe,
 * chunk_level segment, version 3, NO language key ⇒ fal default "en").
 */
export async function transcribeAudioUrl(audioUrl: string, durationMs: number | null, options: TranscribeOptions = {}): Promise<TranscriptResult> {
  const env = falEnv();
  const chunkLevel = options.chunkLevel ?? 'segment';
  const model = (options.model ?? env.model).replace(/^\//, '');
  if (env.apiKey === STUB) {
    return { text: 'وصل ريفييرا عرض خاص', segments: [{ start_ms: 0, end_ms: 2000, text: 'وصل ريفييرا عرض خاص' }], language: 'ar', model: 'stub', provider: 'fal', costUsd: 0, raw: { stub: true } };
  }
  if (chunkLevel === 'word' && model === WIZPER) {
    // Measured 2026-09-02: wizper's schema is `chunk_level: const "segment"` and
    // the queue returns 422 for 'word'. Fail before spending the round trip.
    throw new Error(`${WIZPER} only supports chunk_level 'segment' (fal returns 422 for 'word'); pass options.model='fal-ai/whisper' for word-level timestamps`);
  }
  const request: Record<string, unknown> = { audio_url: audioUrl, task: 'transcribe', chunk_level: chunkLevel, version: '3' };
  if (options.language !== undefined) request.language = options.language; // null = explicit auto-detect
  if (options.maxSegmentLen !== undefined) request.max_segment_len = options.maxSegmentLen;
  if (options.mergeChunks !== undefined) request.merge_chunks = options.mergeChunks;

  const submit = await fetch(`${env.baseUrl.replace(/\/$/, '')}/${model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Key ${env.apiKey}` },
    body: JSON.stringify(request),
  });
  if (!submit.ok) throw new Error(`${model} submit ${submit.status}: ${(await submit.text().catch(() => '')).slice(0, 300)}`);
  const s = (await submit.json()) as { status_url?: string; response_url?: string };
  if (!s.status_url || !s.response_url) throw new Error(`${model} missing status/response url: ${JSON.stringify(s).slice(0, 200)}`);

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await fetch(s.status_url, { headers: { Authorization: `Key ${env.apiKey}` } });
    if (!st.ok) throw new Error(`${model} poll ${st.status}`);
    const status = ((await st.json()) as { status?: string }).status?.toUpperCase();
    if (status === 'FAILED' || status === 'ERROR') throw new Error(`${model} failed`);
    if (status !== 'COMPLETED') continue;
    const rr = await fetch(s.response_url, { headers: { Authorization: `Key ${env.apiKey}` } });
    // fal reports validation errors (e.g. an unsupported chunk_level) as a 422 on
    // the RESPONSE url, after the submit was accepted — surface the detail.
    if (!rr.ok) throw new Error(`${model} result ${rr.status}: ${(await rr.text().catch(() => '')).slice(0, 300)}`);
    const j = (await rr.json()) as FalResponse;
    const { audio_url: _audioUrl, ...requestNoUrl } = request;
    return normalizeFalResponse(j, durationMs, model, requestNoUrl, chunkLevel);
  }
  throw new Error(`${model} poll timed out`);
}
