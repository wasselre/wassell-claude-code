// ============================================================================
// Per-frame description (role `frame_describer`, cheap vision model).
//
// One call per ≤ 8 keyframes of a shot. The output is LITERAL — what is in the
// picture, how it is framed and lit — plus controlled-vocabulary tags. Frames
// already described (analysis not null) are skipped, so a re-run is free.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CvAi, CvFrameRow, FrameAnalysis, RoleStamp } from './types.js';
import { chunk, MAX_IMAGES_PER_CALL } from './evidence.js';
import { validateTags, vocabForPrompt } from './vocab.js';
import { addCost, stampOf } from './ledger.js';

export interface AnalyzeFramesDeps { sb: SupabaseClient; ai: CvAi }
export interface AnalyzeFramesResult { described: number; skipped: number; calls: number; cost_usd: number; stamps: RoleStamp[] }

export const FRAME_DESCRIBER_SYSTEM = `You describe single frames taken from real-estate marketing videos (Saudi Arabia / GCC market). For EACH image, in input order, return a LITERAL, factual description of what is visible — no marketing language, no guessing about the video's story. Arabic on-screen text is common; read it exactly when legible.

Return JSON only, matching the schema. Use ONLY these tags (format "group:value"):
${vocabForPrompt()}`;

export const FRAME_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    frames: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', description: 'Zero-based index of the input image.' },
          description: { type: 'string', description: 'One or two literal sentences: what is shown.' },
          main_subject: { type: 'string', description: 'The main subject (e.g. "villa facade", "presenter", "floor plan").' },
          secondary_objects: { type: 'array', items: { type: 'string' } },
          people_activity: { type: ['string', 'null'], description: 'Who is in frame and what they are doing (e.g. "presenter talking to camera", "family walking in the garden"); null when nobody.' },
          room_class: { type: ['string', 'null'], description: 'Room/space class if interior (living, kitchen, bedroom, bathroom, majlis, lobby, gym, pool…), else null.' },
          shot_size: { type: 'string', description: 'wide | medium | close | extreme_close | aerial' },
          camera_angle: { type: 'string', description: 'eye_level | low | high | aerial | dutch' },
          composition: { type: 'string', description: 'Framing notes: symmetry, leading lines, negative space…' },
          subject_position: { type: 'string', description: 'center | left | right | top | bottom | thirds' },
          foreground: { type: 'string' },
          background: { type: 'string' },
          lighting: { type: 'string', description: 'day | golden | night | studio, plus a short note.' },
          palette: { type: 'array', items: { type: 'string' }, description: 'Dominant colours (words or hex), max 4.' },
          style: { type: 'string', description: 'Photographic / 3D render / motion graphic / phone footage / cinematic…' },
          text_placement: { type: ['string', 'null'], description: 'Where on-screen text sits (top, lower third, centre…), null when no text.' },
          typography: { type: ['string', 'null'], description: 'Font style / weight / colour of on-screen text, null when no text.' },
          branding: { type: 'array', items: { type: 'string' }, description: 'Visible logos or brand marks; empty when none.' },
          graphic_elements: { type: 'array', items: { type: 'string' }, description: 'Overlays, maps, animations, split screens; empty when none.' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          tags: { type: 'array', items: { type: 'string' }, description: 'Controlled vocabulary tags only.' },
        },
        required: ['index', 'description', 'main_subject', 'secondary_objects', 'people_activity', 'room_class', 'shot_size', 'camera_angle', 'composition', 'subject_position', 'foreground', 'background', 'lighting', 'palette', 'style', 'text_placement', 'typography', 'branding', 'graphic_elements', 'confidence', 'tags'],
      },
    },
  },
  required: ['frames'],
};

export type FrameDescriberEntry = Omit<FrameAnalysis, 'rejected_tags' | 'inherited_from' | 'inherited_distance'> & { index: number };
interface FrameDescriberOutput { frames: FrameDescriberEntry[] }

const strList = (v: unknown, max = Infinity): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max) : []);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Coerce one model entry into a FrameAnalysis with validated tags. */
export function toFrameAnalysis(raw: FrameDescriberEntry, ocrLabels: readonly string[]): FrameAnalysis {
  // Modal's zero-shot labels are already vocabulary tags; union them with the
  // model's so a frame is findable by either signal.
  const { valid, rejected } = validateTags([...(raw.tags ?? []), ...ocrLabels]);
  const conf = Number(raw.confidence);
  return {
    description: String(raw.description ?? ''),
    main_subject: String(raw.main_subject ?? ''),
    secondary_objects: strList(raw.secondary_objects),
    people_activity: strOrNull(raw.people_activity),
    room_class: strOrNull(raw.room_class),
    shot_size: String(raw.shot_size ?? ''),
    camera_angle: String(raw.camera_angle ?? ''),
    composition: String(raw.composition ?? ''),
    subject_position: String(raw.subject_position ?? ''),
    foreground: String(raw.foreground ?? ''),
    background: String(raw.background ?? ''),
    lighting: String(raw.lighting ?? ''),
    palette: strList(raw.palette, 4),
    style: String(raw.style ?? ''),
    text_placement: strOrNull(raw.text_placement),
    typography: strOrNull(raw.typography),
    branding: strList(raw.branding),
    graphic_elements: strList(raw.graphic_elements),
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
    tags: valid,
    ...(rejected.length ? { rejected_tags: rejected } : {}),
  };
}

function userPrompt(frames: readonly CvFrameRow[]): string {
  const lines = frames.map((f, i) => {
    const ocr = typeof f.ocr?.text === 'string' && f.ocr.text.trim() ? ` OCR: "${f.ocr.text.trim().slice(0, 300)}"` : '';
    const labels = f.labels?.length ? ` zero-shot labels: ${f.labels.join(', ')}` : '';
    return `Image ${i} — t=${(f.ts_ms / 1000).toFixed(2)}s.${ocr}${labels}`;
  });
  return `Describe each of the ${frames.length} images in order. Context per image:\n${lines.join('\n')}`;
}

/**
 * Describe every not-yet-described keyframe of a shot. Batches of ≤ 8 images;
 * each batch is one call. Writes analysis/described_at/describe_role per frame
 * and appends one ledger row per call.
 */
export async function analyzeFrames(deps: AnalyzeFramesDeps, videoId: string, frames: readonly CvFrameRow[]): Promise<AnalyzeFramesResult> {
  const { sb, ai } = deps;
  const result: AnalyzeFramesResult = { described: 0, skipped: 0, calls: 0, cost_usd: 0, stamps: [] };
  const todo = frames.filter((f) => f.analysis == null && typeof f.public_url === 'string' && f.public_url.length > 0);
  result.skipped = frames.length - todo.length;
  if (todo.length === 0) return result;

  for (const batch of chunk(todo, MAX_IMAGES_PER_CALL)) {
    const call = await ai.callRole<FrameDescriberOutput>('frame_describer', {
      system: FRAME_DESCRIBER_SYSTEM,
      user: userPrompt(batch),
      images: batch.map((f) => ({ url: f.public_url as string, mime: 'image/webp' })),
      schema: FRAME_SCHEMA,
      cache: true,
    });
    result.calls++;
    const stamp = stampOf('frame_describer', call);
    result.stamps.push(stamp);
    result.cost_usd += call.cost_usd ?? 0;
    await addCost(sb, 'frame_describe', videoId, stamp);

    const entries = Array.isArray(call.output?.frames) ? call.output.frames : [];
    if (entries.length === 0) throw new Error(`provider: frame_describer returned no frames for a batch of ${batch.length}`);
    const describedAt = new Date().toISOString();
    for (const entry of entries) {
      const frame = batch[entry.index];
      if (!frame) { console.warn(`[cv] frame_describer returned index ${entry.index} outside batch of ${batch.length} — ignored`); continue; }
      const analysis = toFrameAnalysis(entry, frame.labels ?? []);
      const { error } = await sb.from('mkt_cv_frames')
        .update({ analysis, described_at: describedAt, describe_role: stamp })
        .eq('id', frame.id);
      if (error) throw new Error(`write frame analysis ${frame.id} failed: ${error.message}`);
      frame.analysis = analysis; // keep the in-memory row current for the shot pass
      result.described++;
    }
  }
  return result;
}
