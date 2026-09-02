// ============================================================================
// Per-shot analysis (role `shot_analyzer`). One call per shot with the keyframe
// contact sheet (≤ 8 images, in time order), the time-aligned transcript, the
// consolidated OCR, timing/transition facts, the neighbouring shots' summaries
// and the post's enrichment context. Produces the creative reading (purpose,
// progression, production method, reproducibility…), a bilingual one-line
// summary, controlled tags, and BOTH embeddings:
//   embedding_text   = bge-m3 of summary + OCR + transcript (role embed_text)
//   embedding_visual = mean of the keyframes' SigLIP vectors (no model call)
//
// The `analysis` jsonb key names are a contract with the Competitor Watch
// drawer (see types.ts ShotAnalysis) — do not rename.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CvAi, CvFrameRow, CvShotRow, Difficulty, Pace, RoleStamp, ShotAnalysis, ShotAnalyzerOutput, TranscriptSegment } from './types.js';
import { buildContactSheet, consolidateOcr, describeTiming, segmentsForShot } from './evidence.js';
import { meanEmbedding, parseVector } from './embeddings.js';
import { validateTags, vocabForPrompt, isVocabValue } from './vocab.js';
import { addCost, stampOf } from './ledger.js';

export interface AnalyzeShotDeps { sb: SupabaseClient; ai: CvAi }

export interface ShotContext {
  /** All transcript segments of the whole video (the shot window is cut here). */
  transcriptSegments: readonly unknown[];
  transcriptLanguage: string | null;
  /** From mkt_content_enrichment.result of the post. */
  contentType: string | null;
  campaignMessage: string | null;
  /** Summaries of the previous / next shots when known. */
  prevSummary: string | null;
  nextSummary: string | null;
  videoDurationMs: number | null;
  shotCount: number;
}

export interface AnalyzeShotResult { cost_usd: number; stamps: RoleStamp[]; tags: string[]; summary: string; purpose: string | null }

export const SHOT_ANALYZER_SYSTEM = `You are a senior video-ad analyst for real-estate marketing in Saudi Arabia. You are shown the keyframes of ONE shot from a competitor's video (in time order), what was said during it, the on-screen text, its timing and transitions, the neighbouring shots, and the post's known content type / campaign message.

Explain what this shot does and how it was made, so a Saudi real-estate marketer (Wassel) can learn from it:
- visual progression across the keyframes, the camera movement (one of: static, pan, tilt, dolly, drone, handheld, zoom), the editing-pace judgement (slow / medium / fast)
- its PURPOSE in the ad (one of: hook, location, product, feature, proof, offer, cta, brand), the creative angle, the emotional effect, the mood, the audience it targets
- production: method (drone, gimbal walkthrough, 3D render, motion graphic, phone selfie…), difficulty, resources needed; and how reproducible it is for a mid-size marketing agency (easy / moderate / hard)
- suitable platforms (instagram_reel, tiktok, snapchat, youtube_short, x, facebook) and content types (project_launch, unit_tour, offer, brand, testimonial, educational…)

Then write a ONE-LINE summary in Arabic (Saudi register, no fluff) and in English. Choose tags ONLY from this controlled vocabulary (format "group:value"):
${vocabForPrompt()}

Facts only. Never invent prices, names or offers that are not in the transcript/OCR. Return JSON matching the schema.`;

const DIFF = ['easy', 'moderate', 'hard'];
const PACE = ['slow', 'medium', 'fast'];

export const SHOT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary_ar: { type: 'string', description: 'One line, Saudi Arabic.' },
    summary_en: { type: 'string', description: 'One line, English.' },
    purpose: { type: 'string', enum: ['hook', 'location', 'product', 'feature', 'proof', 'offer', 'cta', 'brand'] },
    angle: { type: 'string', description: 'The creative angle / message of this shot.' },
    camera_movement: { type: 'string', enum: ['static', 'pan', 'tilt', 'dolly', 'drone', 'handheld', 'zoom'] },
    pace: { type: 'string', enum: PACE },
    visual_progression: { type: 'string' },
    emotional_effect: { type: 'string' },
    intended_audience: { type: 'string' },
    production_method: { type: 'string' },
    production_difficulty: { type: 'string', enum: DIFF },
    production_resources: { type: 'array', items: { type: 'string' } },
    reproducibility: { type: 'string', enum: DIFF, description: 'How reproducible for Wassel.' },
    suitable_platforms: { type: 'array', items: { type: 'string' } },
    suitable_content_types: { type: 'array', items: { type: 'string' } },
    mood: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    tags: { type: 'array', items: { type: 'string' }, description: 'Controlled vocabulary tags only.' },
  },
  required: ['summary_ar', 'summary_en', 'purpose', 'angle', 'camera_movement', 'pace', 'visual_progression', 'emotional_effect', 'intended_audience', 'production_method', 'production_difficulty', 'production_resources', 'reproducibility', 'suitable_platforms', 'suitable_content_types', 'mood', 'confidence', 'tags'],
};

function fmtSegments(segs: readonly TranscriptSegment[]): string {
  if (segs.length === 0) return '(no speech during this shot)';
  return segs.map((s) => `[${(s.start_ms / 1000).toFixed(1)}–${(s.end_ms / 1000).toFixed(1)}s] ${s.text}`).join('\n');
}

export function buildShotPrompt(shot: CvShotRow, sheet: ReturnType<typeof buildContactSheet>, frames: readonly CvFrameRow[], ctx: ShotContext): string {
  const segs = segmentsForShot(ctx.transcriptSegments, shot.start_ms, shot.end_ms);
  const ocr = consolidateOcr(frames);
  const frameNotes = frames
    .filter((f) => f.analysis)
    .map((f) => `- t=${(f.ts_ms / 1000).toFixed(2)}s: ${f.analysis!.description} [${f.analysis!.shot_size}; ${f.analysis!.lighting}]`)
    .join('\n');
  const parts = [
    `Shot ${shot.shot_no + 1} of ${ctx.shotCount}${ctx.videoDurationMs ? ` (video ${(ctx.videoDurationMs / 1000).toFixed(1)}s)` : ''}.`,
    `Timing: ${describeTiming(shot)}.`,
    `Keyframes shown (${sheet.length}, in order): ${sheet.map((s) => `${(s.ts_ms / 1000).toFixed(2)}s`).join(', ')}.`,
    frameNotes ? `Frame descriptions:\n${frameNotes}` : 'Frame descriptions: (none)',
    `Transcript during the shot${ctx.transcriptLanguage ? ` (${ctx.transcriptLanguage})` : ''}:\n${fmtSegments(segs)}`,
    `On-screen text (OCR, deduped):\n${ocr || '(none)'}`,
    `Previous shot: ${ctx.prevSummary ?? '(start of video)'}`,
    `Next shot: ${ctx.nextSummary ?? '(unknown / end of video)'}`,
    `Post context: content_type=${ctx.contentType ?? 'unknown'}; campaign_message=${ctx.campaignMessage ?? 'unknown'}.`,
  ];
  return parts.join('\n\n');
}

/** Text that feeds the bge-m3 embedding: what the shot is + what it shows + what it says. */
export function embeddingText(summary: { ar: string; en: string }, ocr: string, transcript: string): string {
  return [summary.ar, summary.en, ocr, transcript].map((s) => s.trim()).filter(Boolean).join('\n').slice(0, 4000);
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Model output + DB facts → the stored ShotAnalysis, with validated tags. */
export function coerceShotAnalysis(out: ShotAnalyzerOutput, shot: Pick<CvShotRow, 'transition_in' | 'transition_out' | 'edit_pace_local'>): { analysis: ShotAnalysis; tags: string[] } {
  const purpose = isVocabValue('purpose', out.purpose) ? out.purpose : 'feature';
  const camera = isVocabValue('motion', out.camera_movement) ? out.camera_movement : 'static';
  const reproducibility = (DIFF.includes(out.reproducibility) ? out.reproducibility : 'moderate') as Difficulty;
  const difficulty = (DIFF.includes(out.production_difficulty) ? out.production_difficulty : 'moderate') as Difficulty;
  const pace = (PACE.includes(out.pace) ? out.pace : 'medium') as Pace;
  const conf = Number(out.confidence);
  // The structured fields are themselves vocabulary facts — mirror them into
  // tags so a filter on purpose/motion/reproducibility works even if the model
  // forgot to list them.
  const { valid, rejected } = validateTags([...strList(out.tags), `purpose:${purpose}`, `motion:${camera}`, `reproducibility:${reproducibility}`]);
  const analysis: ShotAnalysis = {
    summary_ar: String(out.summary_ar ?? '').trim(),
    summary_en: String(out.summary_en ?? '').trim(),
    purpose,
    angle: String(out.angle ?? ''),
    camera_movement: camera,
    pace,
    pace_cpm: shot.edit_pace_local == null ? null : Number(shot.edit_pace_local),
    transitions: { in: shot.transition_in, out: shot.transition_out },
    visual_progression: String(out.visual_progression ?? ''),
    emotional_effect: String(out.emotional_effect ?? ''),
    intended_audience: String(out.intended_audience ?? ''),
    production_method: String(out.production_method ?? ''),
    production_difficulty: difficulty,
    production_resources: strList(out.production_resources),
    reproducibility,
    suitable_platforms: strList(out.suitable_platforms),
    suitable_content_types: strList(out.suitable_content_types),
    mood: String(out.mood ?? ''),
    confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0,
    ...(rejected.length ? { rejected_tags: rejected } : {}),
  };
  return { analysis, tags: valid };
}

/** The `summary` column holds both lines (Arabic first) — the generated
 *  search_tsv uses the 'simple' config, so both languages become lexical hits. */
export function summaryColumn(summary: { ar: string; en: string }): string {
  return [summary.ar, summary.en].filter(Boolean).join('\n');
}

export async function analyzeShot(deps: AnalyzeShotDeps, shot: CvShotRow, frames: readonly CvFrameRow[], ctx: ShotContext): Promise<AnalyzeShotResult> {
  const { sb, ai } = deps;
  const sheet = buildContactSheet(frames);
  if (sheet.length === 0) throw new Error(`permanent: shot ${shot.id} has no keyframes with a public_url`);

  const call = await ai.callRole<ShotAnalyzerOutput>('shot_analyzer', {
    system: SHOT_ANALYZER_SYSTEM,
    user: buildShotPrompt(shot, sheet, frames, ctx),
    images: sheet.map((s) => ({ url: s.url, mime: 'image/webp' })),
    schema: SHOT_SCHEMA,
    cache: true,
  });
  const stamp = stampOf('shot_analyzer', call);
  await addCost(sb, 'shot_analyze', shot.video_id, stamp);
  if (!call.output || typeof call.output !== 'object' || typeof call.output.summary_en !== 'string') throw new Error('provider: shot_analyzer returned an incomplete object');
  const { analysis, tags } = coerceShotAnalysis(call.output, shot);
  const summary = { ar: analysis.summary_ar, en: analysis.summary_en };

  const segs = segmentsForShot(ctx.transcriptSegments, shot.start_ms, shot.end_ms);
  const transcriptText = segs.map((s) => s.text).join(' ');
  const ocrText = consolidateOcr(frames);

  // text embedding (Modal bge-m3 via the role adapter — no per-call price)
  const emb = await ai.embed('embed_text', { texts: [embeddingText(summary, ocrText, transcriptText)] });
  const textVec = emb.vectors[0];
  if (!textVec || textVec.length !== 1024) throw new Error(`provider: embed_text returned dim ${textVec?.length ?? 0}, expected 1024`);

  // visual embedding = mean of the shot's keyframe SigLIP vectors
  const vecs = frames.map((f) => parseVector(f.embedding)).filter((v): v is number[] => v !== null && v.length === 768);
  const visualVec = meanEmbedding(vecs);

  const roleStamp = { shot_analyzer: stamp, embed_text: { model: emb.model, version: emb.version, dim: emb.dim }, keyframes_embedded: vecs.length };
  const { error } = await sb.from('mkt_cv_shots').update({
    analysis,
    summary: summaryColumn(summary),
    tags,
    transcript_text: transcriptText || null,
    transcript_segments: segs,
    ocr_text: ocrText || null,
    embedding_text: textVec,
    embedding_visual: visualVec,
    analysis_status: 'done',
    analysis_error: null,
    analysis_cost_usd: stamp.cost_usd ?? 0,
    analysis_role: roleStamp,
    updated_at: new Date().toISOString(),
  }).eq('id', shot.id);
  if (error) throw new Error(`write shot analysis ${shot.id} failed: ${error.message}`);

  return { cost_usd: stamp.cost_usd ?? 0, stamps: [stamp], tags, summary: summaryColumn(summary), purpose: analysis.purpose };
}
