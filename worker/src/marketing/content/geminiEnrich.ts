// ============================================================================
// The Gemini reader inside content_process (replaces the Claude runner's
// mkt_visual_ocr + mkt_content_enrichment lanes for competitor posts).
//
//   1. short list of projects from caption + transcript (narrowProjects, the
//      same deterministic rules as before)
//   2. ONE Gemini call with the post's media → on-screen text per media item +
//      the project pick with a verbatim quote + the structured fields
//   3. short list rebuilt with Gemini's on-screen text; ONLY if it changed (a
//      project named only on screen) a text-only Gemini call decides again
//   4. the proof checker (enrichmentValidate.ts, a copy of the runner's)
//   5. persisted exactly as the runner did: enrichment row, attribution,
//      stale-attribution demotion, secondary candidates, processed / partial
//
// Switch: mkt_settings `content.reader` = 'gemini' | 'runner' (missing = runner).
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { narrowProjects, type NarrowedCandidate } from './enrich.js';
import { loadAttributionContext, publisherProjects, scopedIndex } from './attributionContext.js';
import { imageToBoundedJpeg, toTempFile, cleanup } from './ffmpegMedia.js';
import { silentCopy, probeVideo } from '../cv/gemini/media.js';
import { validateEnrichmentResults, type EnrichAnswer, type EnrichCandidate, type EnrichEvidence, type ValidEnrichment } from './enrichmentValidate.js';
import { decidePostWithGemini, readPostWithGemini, GEMINI_RULE_VERSION, READER_MODEL, type PostContext, type ReadMedia } from './geminiRead.js';
import { CREDITS_DEPLETED } from '../../ai/providers/geminiHttp.js';

export type ContentReader = 'gemini' | 'runner';
/** Longest stretch of a video the reader watches (same ceiling as the shot pipeline). */
const MAX_VIDEO_MS = 15 * 60_000;

/**
 * When Gemini refuses with a per-DAY quota, every read pauses until Google's own
 * retry time (mkt_settings `content.reader_paused_until`). Without this the
 * sweep would claim post after post, download its media and be refused at the
 * model call — the same churn the shot pipeline's defer exists to stop.
 */
export async function readerPausedUntil(sb: SupabaseClient): Promise<number> {
  const { data, error } = await sb.from('mkt_settings').select('value').eq('key', 'content.reader_paused_until').maybeSingle();
  if (error) throw new Error(`content.reader_paused_until read failed: ${error.message}`);
  const v = (data as { value?: unknown } | null)?.value;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export async function pauseReader(sb: SupabaseClient, retryAfterSec: number, reason: string): Promise<void> {
  const until = new Date(Date.now() + Math.min(Math.max(retryAfterSec, 60), 48 * 3600) * 1000).toISOString();
  const { error } = await sb.from('mkt_settings').upsert({ key: 'content.reader_paused_until', value: until, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw new Error(`pausing the reader failed: ${error.message}`);
  const day = new Date().toISOString().slice(0, 10);
  const broke = reason.includes(CREDITS_DEPLETED);
  const { error: alertErr } = await sb.rpc('mkt_alert_emit', {
    p_kind: 'content_reader_quota', p_dedup_key: `content_reader_quota:${broke ? 'credits:' : ''}${day}`,
    p_title: broke ? 'Competitor post reading paused: Gemini prepaid balance is empty — top up AI Studio' : 'Competitor post reading paused: Gemini daily quota reached',
    p_severity: broke ? 'critical' : 'warning',
    p_subject_type: 'content', p_subject_id: day,
    p_body: `Gemini refused with a per-day quota; reading resumes by itself at ${until}. A *FreeTier* quota means the key's Google project has no paid balance left (top up the prepay balance). ${reason.slice(0, 300)}`,
    p_evidence: { until, reason: reason.slice(0, 1000) },
  });
  if (alertErr) console.error(`[content] mkt_alert_emit failed (reader quota alert not recorded): ${alertErr.message}`);
}

export async function contentReader(sb: SupabaseClient): Promise<ContentReader> {
  const { data, error } = await sb.from('mkt_settings').select('value').eq('key', 'content.reader').maybeSingle();
  if (error) throw new Error(`content.reader setting read failed: ${error.message}`);
  const v = (data as { value?: unknown } | null)?.value;
  return v === 'gemini' ? 'gemini' : 'runner';
}

/** Stable identity of a short list, so a re-read that finds nothing new costs no second call. */
export function candidateFingerprint(c: ReadonlyArray<{ projectId: string; strength?: string }>): string {
  return c.map((x) => `${x.projectId}:${x.strength ?? ''}`).sort().join('|');
}

interface EvidenceRow extends EnrichEvidence, PostContext {
  post_id: string;
  organization_id?: string | null;
  snippet?: string;
}

async function loadEvidence(sb: SupabaseClient, postId: string): Promise<EvidenceRow> {
  const { data, error } = await sb.rpc('mkt_intelligence_evidence', { p_post_ids: [postId] });
  if (error) throw new Error(`evidence rpc failed: ${error.message}`);
  const row = Array.isArray(data) ? (data[0] as EvidenceRow | undefined) : undefined;
  if (!row) throw new Error(`evidence rpc returned nothing for post ${postId}`);
  return row;
}

export interface PostForReader {
  id: string;
  organization_id: string | null;
  caption: string | null;
}

export interface StoredMediaForReader {
  mediaId: string;
  kind: string;
  bytes: Buffer | null;
  durationMs?: number;
}

export interface ReaderOutcome {
  primaryProjectId: string | null;
  candidates: number;
  imagesRead: number;
  videosRead: number;
  costUsd: number;
  secondCall: boolean;
  rejected: string | null;
}

/** Narrow over the given words with the live attribution context. */
async function shortList(sb: SupabaseClient, orgId: string | null, words: string): Promise<NarrowedCandidate[]> {
  const ctx = await loadAttributionContext(sb);
  const pub = await publisherProjects(sb, ctx, orgId);
  const index = scopedIndex(ctx, pub);
  return narrowProjects(words, index, { publisherProjectIds: pub, commonTokens: ctx.commonTokens, excludedTokens: ctx.excludedTokens, brandPhrases: ctx.brandPhrases, catalog: ctx.catalog });
}

/**
 * Read + decide + persist for one post. `pendingResult` is what content_process
 * already writes on the pending enrichment row (account identity, partial flag,
 * snippet) — kept on the final row. Throws on any failure: the caller fails the
 * job and the queue retries it (every write here is an idempotent upsert).
 */
export async function readAndDecide(
  sb: SupabaseClient,
  post: PostForReader,
  stored: StoredMediaForReader[],
  transcriptText: string,
  pendingResult: Record<string, unknown>,
): Promise<ReaderOutcome> {
  // 1. short list from the words we already have
  const firstWords = `${post.caption ?? ''}\n${transcriptText}`.trim();
  const first = await shortList(sb, post.organization_id, firstWords);
  // Nothing is written before Gemini answers and the checker passes: a re-read
  // that fails must leave the post's previous decision exactly as it was.
  const ev = { ...(await loadEvidence(sb, post.id)), candidates: first as EnrichCandidate[], deterministic_partial: pendingResult.deterministic_partial === true };

  // 2. the media: the video(s) when there are any (their cover thumbnail adds
  //    nothing the video does not show), otherwise every image in order.
  const videos = stored.filter((m) => m.kind === 'video' && m.bytes);
  const images = stored.filter((m) => (m.kind === 'image' || (m.kind === 'thumbnail' && videos.length === 0)) && m.bytes);
  const temps: string[] = [];
  const media: ReadMedia[] = [];
  let outcome: ReaderOutcome;
  try {
    for (const v of videos) {
      const tmp = await toTempFile(v.bytes as Buffer, 'mp4');
      temps.push(tmp.dir);
      const probe = await probeVideo(tmp.path);
      const copy = await silentCopy(tmp.path, tmp.dir, Math.min(probe.durationMs, MAX_VIDEO_MS));
      media.push({ kind: 'video', path: copy.path, bytes: copy.bytes, mediaId: v.mediaId });
    }
    for (const im of images) {
      media.push({ kind: 'image', bytes: await imageToBoundedJpeg(im.bytes as Buffer, 'img'), mime: 'image/jpeg', mediaId: im.mediaId });
    }
    if (media.length === 0) throw new Error('permanent: post has no readable media bytes');

    const read = await readPostWithGemini(ev, media);
    let cost = read.costUsd;
    const ocrText = read.mediaText.map((m) => m.lines.join('\n')).filter(Boolean).join(' | ');

    // 3. rebuild the short list now that the screen text is known
    const second = await shortList(sb, post.organization_id, `${firstWords}\n${ocrText}`.trim());
    let answer: EnrichAnswer = read.answer;
    let finalCands: NarrowedCandidate[] = first;
    let secondCall = false;
    if (candidateFingerprint(second) !== candidateFingerprint(first)) {
      finalCands = second;
      secondCall = true;
      const d = await decidePostWithGemini({ ...ev, candidates: second as EnrichCandidate[], ocr_text: ocrText });
      answer = d.answer;
      cost += d.costUsd;
    }

    // 4. the proof check against caption + transcript + the text Gemini read
    const evFinal: EnrichEvidence = { ...ev, candidates: finalCands as EnrichCandidate[], ocr_text: ocrText };
    const { valid, errors } = validateEnrichmentResults([answer], [evFinal]);
    const v = valid[0];
    if (!v) throw new Error(`provider:gemini answer failed validation: ${errors.join('; ').slice(0, 300)}`);

    // 5. the screen text replaces whatever an older reader stored for this post
    const share = media.length > 0 ? Math.round((read.costUsd / media.length) * 1e6) / 1e6 : 0;
    for (const m of read.mediaText) {
      const { error } = await sb.rpc('mkt_visual_text_upsert', {
        p_media: m.mediaId, p_post: post.id, p_source: 'gemini', p_frame_ts_ms: null, p_model: READER_MODEL,
        p_text: m.lines.join('\n'), p_structured: { lines: m.lines }, p_confidence: null, p_cost: share, p_status: 'done', p_failure: null, p_raw: null,
      });
      if (error) throw new Error(`mkt_visual_text_upsert failed for media ${m.mediaId}: ${error.message}`);
    }
    const { error: delErr } = await sb.from('mkt_visual_text').delete().eq('content_post_id', post.id).neq('model', READER_MODEL);
    if (delErr) throw new Error(`removing older screen text for post ${post.id} failed: ${delErr.message}`);

    await persistDecision(sb, post, v, { ...pendingResult, reader_cost_usd: Math.round(cost * 1e6) / 1e6, reader_second_call: secondCall });
    outcome = {
      primaryProjectId: v.primaryProjectId, candidates: finalCands.length,
      imagesRead: media.filter((m) => m.kind === 'image').length, videosRead: media.filter((m) => m.kind === 'video').length,
      costUsd: cost, secondCall, rejected: (v.result.attribution_rejected as string | undefined) ?? null,
    };
  } finally {
    for (const d of temps) await cleanup(d);
  }
  return outcome;
}

/**
 * Text-only re-decision from stored evidence (caption + transcript + the screen
 * text Gemini stored). Used by the re-check when a project is added/renamed.
 */
export async function redecideFromStored(sb: SupabaseClient, post: PostForReader, candidates: NarrowedCandidate[], pendingResult: Record<string, unknown>): Promise<ReaderOutcome> {
  const ev = { ...(await loadEvidence(sb, post.id)), candidates: candidates as EnrichCandidate[], deterministic_partial: pendingResult.deterministic_partial === true };
  const d = await decidePostWithGemini(ev);
  const { valid, errors } = validateEnrichmentResults([d.answer], [ev]);
  const v = valid[0];
  if (!v) throw new Error(`provider:gemini answer failed validation: ${errors.join('; ').slice(0, 300)}`);
  await persistDecision(sb, post, v, { ...pendingResult, reader_cost_usd: d.costUsd, reader_second_call: false });
  return { primaryProjectId: v.primaryProjectId, candidates: candidates.length, imagesRead: 0, videosRead: 0, costUsd: d.costUsd, secondCall: false, rejected: (v.result.attribution_rejected as string | undefined) ?? null };
}

async function writeEnrichment(sb: SupabaseClient, post: PostForReader, candidates: NarrowedCandidate[], primary: string | null, result: Record<string, unknown>, status: 'pending' | 'done', model: string | null): Promise<void> {
  const { error } = await sb.rpc('mkt_enrichment_upsert', {
    p_post: post.id, p_model: model, p_rule_version: GEMINI_RULE_VERSION, p_org: post.organization_id,
    p_developer: null, p_marketer: null, p_primary_project: primary, p_candidates: candidates,
    p_result: result, p_cost: 0, p_status: status, p_failure: null,
  });
  if (error) throw new Error(`mkt_enrichment_upsert (${status}) failed for post ${post.id}: ${error.message}`);
}

/** The runner's persistence (scripts/claude-study-runner.mjs handleMktContentEnrichment), for one post. */
async function persistDecision(sb: SupabaseClient, post: PostForReader, v: ValidEnrichment, extra: Record<string, unknown>): Promise<void> {
  await writeEnrichment(sb, post, v.candidates as NarrowedCandidate[], v.primaryProjectId, { ...extra, ...v.result }, 'done', READER_MODEL);
  // A human-locked post keeps its project: the upsert RPC preserved the pointer,
  // and no competing machine attribution may be added.
  if (!v.locked && v.primaryProjectId) {
    const { error } = await sb.rpc('mkt_attribution_upsert', { p_content_post_id: v.postId, p_project_id: v.primaryProjectId, p_method: 'caption', p_confidence: 0.9, p_evidence: { matched: READER_MODEL, quote: v.evidenceQuote }, p_matched_aliases: [], p_auto_accept: true });
    if (error) throw new Error(`mkt_attribution_upsert failed for post ${v.postId}: ${error.message}`);
  }
  if (!v.locked) {
    // An earlier machine auto-accept of a DIFFERENT project goes back to a
    // candidate, so the project record's Marketing tab agrees with this decision.
    const { error } = await sb.rpc('mkt_attribution_demote_stale', { p_post: v.postId, p_keep_project: v.primaryProjectId });
    if (error) throw new Error(`mkt_attribution_demote_stale failed for post ${v.postId}: ${error.message}`);
    for (const s of v.secondary) {
      const { error: e2 } = await sb.rpc('mkt_attribution_upsert', { p_content_post_id: v.postId, p_project_id: s.projectId, p_method: 'caption', p_confidence: s.confidence, p_evidence: { matched: s.matched.join(',') }, p_matched_aliases: s.matched, p_auto_accept: false });
      if (e2) throw new Error(`secondary attribution upsert failed for post ${v.postId}: ${e2.message}`);
    }
  }
  const { error: stErr } = await sb.rpc('mkt_content_set_status', { p_post: v.postId, p_status: v.deterministicPartial ? 'partial' : 'processed', p_media_count: null });
  if (stErr) throw new Error(`mkt_content_set_status failed for post ${v.postId}: ${stErr.message}`);
}

/** Exported for content_process's skip check. */
export function isGeminiRead(enr: { model?: string | null; status?: string | null } | null | undefined): boolean {
  return !!enr && enr.status === 'done' && typeof enr.model === 'string' && enr.model.startsWith('gemini');
}

