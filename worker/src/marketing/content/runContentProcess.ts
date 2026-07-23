// ============================================================================
// content_process orchestrator (Phases 4-8, per post). A content item is
// "processed" only when: every media is permanently stored OR explicitly failed,
// every video is transcribed OR failed, its images/frames have visual text OR
// failed, it is enriched, and it is attributed. processing_status rolls that up
// (processed | partial | failed). Fully idempotent — reprocessing reads bytes
// from PERMANENT storage (never the expired CDN) and every write is an upsert.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeCommonTokens, type ProjectAlias } from '../pipeline.js';
import { extractMedia } from './mediaExtract.js';
import { downloadAndStore, fetchBytes, uploadBytes } from './contentStore.js';
import { toTempFile, cleanup, probeDurationMs, extractAudio, sampleFrames } from './ffmpegMedia.js';
import { downloadYouTube, YtDownloadError } from './ytdlp.js';
import { transcribeAudioUrl } from './falTranscribe.js';
import { readFile } from 'node:fs/promises';
import { extractVisualText, MAX_IMAGES } from './vision.js';
import { narrowProjects, enrichContent, RULE_VERSION, type NarrowedCandidate } from './enrich.js';
import { sha256Hex } from '../adIntel.js';

const ALL_PROJECTS_MODEL = '220c49b9-de57-492d-9eca-c0d9f54fd40f';

export interface ContentProcessStats {
  post_id: string; media_total: number; media_stored: number; media_failed: number;
  videos: number; transcribed: number; transcribe_failed: number;
  images_analyzed: number; frames_analyzed: number; enriched: boolean;
  primary_project: string | null; attributions: number; status: string;
  cost_usd: number; errors: string[];
}

async function loadProjectIndex(sb: SupabaseClient, projectIds: string[]): Promise<ProjectAlias[]> {
  if (projectIds.length === 0) return [];
  const { data } = await sb.from('unified_records').select('id, data').eq('model_id', ALL_PROJECTS_MODEL).in('id', projectIds);
  return (data ?? []).map((r) => { const d = (r.data ?? {}) as Record<string, unknown>; return { projectId: r.id as string, nameAr: (d.project_name as string) ?? null, nameEn: (d.project_name_en as string) ?? null, tokens: [] }; }).filter((p) => p.nameAr || p.nameEn);
}
async function loadAllProjectNames(sb: SupabaseClient): Promise<ProjectAlias[]> {
  const { data } = await sb.from('unified_records').select('id, data').eq('model_id', ALL_PROJECTS_MODEL);
  return (data ?? []).map((r) => { const d = (r.data ?? {}) as Record<string, unknown>; return { projectId: r.id as string, nameAr: (d.project_name as string) ?? null, nameEn: (d.project_name_en as string) ?? null, tokens: [] }; }).filter((p) => p.nameAr || p.nameEn);
}

export async function runContentProcess(sb: SupabaseClient, contentPostId: string): Promise<ContentProcessStats> {
  const stats: ContentProcessStats = { post_id: contentPostId, media_total: 0, media_stored: 0, media_failed: 0, videos: 0, transcribed: 0, transcribe_failed: 0, images_analyzed: 0, frames_analyzed: 0, enriched: false, primary_project: null, attributions: 0, status: 'processing', cost_usd: 0, errors: [] };

  const { data: post } = await sb.from('mkt_content_posts').select('id, platform, external_id, social_account_id, organization_id, post_type, caption').eq('id', contentPostId).maybeSingle();
  if (!post) throw new Error(`content post not found: ${contentPostId}`);
  await sb.rpc('mkt_content_set_status', { p_post: contentPostId, p_status: 'processing' });

  // latest raw payload holds the media URLs (media_refs was historically empty)
  const { data: rawRow } = await sb.from('mkt_raw_ingestions').select('payload').eq('external_identity', post.external_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  const raw = (rawRow?.payload ?? {}) as Record<string, unknown>;
  const descriptors = extractMedia(post.platform as string, raw);
  stats.media_total = descriptors.length;

  // ── media: download + permanent store (idempotent, content-addressed) ──
  interface StoredRef { mediaId: string; kind: string; carouselIndex: number; bytes: Buffer | null; storedUrl: string | null; durationMs?: number; checksum: string | null }
  const storedRefs: StoredRef[] = [];
  for (const d of descriptors) {
    try {
      // reuse an already-stored asset (fetch bytes from PERMANENT url, not the CDN)
      const { data: existing } = await sb.from('mkt_content_media').select('id, download_status, stored_url, checksum_sha256, duration_ms').eq('content_post_id', contentPostId).eq('carousel_index', d.carouselIndex).eq('media_kind', d.kind).maybeSingle();
      if (existing?.download_status === 'stored' && existing.stored_url) {
        let bytes: Buffer | null = null;
        try { bytes = (await fetchBytes(existing.stored_url as string, d.kind === 'video' ? 90_000 : 45_000)).bytes; } catch { /* stored url unreadable — analysis will skip */ }
        storedRefs.push({ mediaId: existing.id as string, kind: d.kind, carouselIndex: d.carouselIndex, bytes, storedUrl: existing.stored_url as string, durationMs: (existing.duration_ms as number) ?? d.durationMs, checksum: (existing.checksum_sha256 as string) ?? null });
        stats.media_stored++;
        continue;
      }
      const s = await downloadAndStore(d.url, d.kind);
      const up = (await sb.rpc('mkt_content_media_upsert', { p_post: contentPostId, p_carousel_index: d.carouselIndex, p_kind: d.kind, p_original_url: d.url, p_bucket: s.bucket, p_path: s.path, p_url: s.storedUrl, p_mime: s.mime, p_bytes: s.bytes, p_width: d.width ?? null, p_height: d.height ?? null, p_duration_ms: d.durationMs ?? null, p_checksum: s.checksum, p_phash: null, p_status: 'stored', p_failure: null })).data as Array<{ id: string }> | null;
      const mediaId = up?.[0]?.id;
      if (mediaId) { storedRefs.push({ mediaId, kind: d.kind, carouselIndex: d.carouselIndex, bytes: s.rawBytes, storedUrl: s.storedUrl, durationMs: d.durationMs, checksum: s.checksum }); stats.media_stored++; }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      await sb.rpc('mkt_content_media_upsert', { p_post: contentPostId, p_carousel_index: d.carouselIndex, p_kind: d.kind, p_original_url: d.url, p_bucket: null, p_path: null, p_url: null, p_mime: null, p_bytes: null, p_width: null, p_height: null, p_duration_ms: d.durationMs ?? null, p_checksum: null, p_phash: null, p_status: 'failed', p_failure: reason.slice(0, 300) });
      stats.media_failed++; stats.errors.push(`media[${d.carouselIndex}/${d.kind}]: ${reason}`);
    }
  }

  // ── YouTube: no direct media url — fetch a bounded copy with yt-dlp, store it,
  //    then let the standard video path (audio→transcribe, frames→OCR) run. ──
  const isVideoPostType = ['video', 'reel', 'short'].includes((post.post_type as string) ?? '');
  if (post.platform === 'youtube' && isVideoPostType && !storedRefs.some((r) => r.kind === 'video')) {
    // reuse an already-stored YouTube video across reprocesses
    const { data: existingVid } = await sb.from('mkt_content_media').select('id, download_status, stored_url, checksum_sha256, duration_ms').eq('content_post_id', contentPostId).eq('carousel_index', 0).eq('media_kind', 'video').maybeSingle();
    if (existingVid?.download_status === 'stored' && existingVid.stored_url) {
      let bytes: Buffer | null = null;
      try { bytes = (await fetchBytes(existingVid.stored_url as string, 90_000)).bytes; } catch { /* skip */ }
      storedRefs.push({ mediaId: existingVid.id as string, kind: 'video', carouselIndex: 0, bytes, storedUrl: existingVid.stored_url as string, durationMs: (existingVid.duration_ms as number) ?? undefined, checksum: (existingVid.checksum_sha256 as string) ?? null });
      stats.media_stored++;
    } else {
      try {
        const yt = await downloadYouTube(post.external_id as string);
        try {
          const bytes = await readFile(yt.path);
          const checksum = sha256Hex(bytes);
          const stored = await uploadBytes(bytes, 'content/video', checksum, yt.ext === 'mp4' ? 'mp4' : yt.ext, 'video/mp4');
          const up = (await sb.rpc('mkt_content_media_upsert', { p_post: contentPostId, p_carousel_index: 0, p_kind: 'video', p_original_url: `https://www.youtube.com/watch?v=${post.external_id}`, p_bucket: stored.bucket, p_path: stored.path, p_url: stored.storedUrl, p_mime: 'video/mp4', p_bytes: stored.bytes, p_width: null, p_height: null, p_duration_ms: yt.durationMs, p_checksum: checksum, p_phash: null, p_status: 'stored', p_failure: null })).data as Array<{ id: string }> | null;
          const mediaId = up?.[0]?.id;
          if (mediaId) { storedRefs.push({ mediaId, kind: 'video', carouselIndex: 0, bytes, storedUrl: stored.storedUrl, durationMs: yt.durationMs ?? undefined, checksum }); stats.media_stored++; }
        } finally { await cleanup(yt.dir); }
      } catch (e) {
        const reason = e instanceof YtDownloadError ? `${e.kind}: ${e.message}` : (e instanceof Error ? e.message : String(e));
        await sb.rpc('mkt_content_media_upsert', { p_post: contentPostId, p_carousel_index: 0, p_kind: 'video', p_original_url: `https://www.youtube.com/watch?v=${post.external_id}`, p_bucket: null, p_path: null, p_url: null, p_mime: null, p_bytes: null, p_width: null, p_height: null, p_duration_ms: null, p_checksum: null, p_phash: null, p_status: 'failed', p_failure: reason.slice(0, 300) });
        stats.media_failed++; stats.errors.push(`youtube: ${reason}`);
      }
    }
  }

  // ── videos: audio → transcribe; sample frames for vision ──
  const visionInputs: Array<{ mediaId: string; source: 'image' | 'frame' | 'thumbnail'; frameTsMs: number | null; buffer: Buffer; mime: string | null }> = [];
  let transcriptText = '';
  for (const ref of storedRefs) {
    if (ref.kind === 'video' && ref.bytes) {
      stats.videos++;
      const tmp = await toTempFile(ref.bytes, 'mp4');
      try {
        const durationMs = ref.durationMs ?? (await probeDurationMs(tmp.path)) ?? null;
        // transcription (idempotent: skip if a done transcript exists for this media+model)
        const { data: existingTx } = await sb.from('mkt_transcripts').select('id, status, text').eq('content_media_id', ref.mediaId).maybeSingle();
        if (existingTx?.status === 'done') { transcriptText += ' ' + (existingTx.text ?? ''); stats.transcribed++; }
        else {
          try {
            const audio = await extractAudio(tmp.path);
            const checksum = ref.checksum ?? sha256Hex(audio);
            const audioUp = await uploadBytes(audio, 'content/audio', checksum, 'm4a', 'audio/mp4');
            const tx = await transcribeAudioUrl(audioUp.storedUrl, durationMs);
            await sb.rpc('mkt_transcript_upsert', { p_media: ref.mediaId, p_post: contentPostId, p_provider: tx.provider, p_model: tx.model, p_language: tx.language, p_text: tx.text, p_segments: tx.segments, p_duration_ms: durationMs, p_confidence: null, p_cost: tx.costUsd, p_status: 'done', p_failure: null, p_source_checksum: checksum, p_raw: tx.raw });
            transcriptText += ' ' + tx.text; stats.transcribed++; stats.cost_usd += tx.costUsd;
          } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            await sb.rpc('mkt_transcript_upsert', { p_media: ref.mediaId, p_post: contentPostId, p_provider: 'fal', p_model: process.env.FAL_TRANSCRIBE_MODEL_ID ?? 'fal-ai/wizper', p_language: null, p_text: null, p_segments: '[]', p_duration_ms: durationMs, p_confidence: null, p_cost: 0, p_status: 'failed', p_failure: reason.slice(0, 300), p_source_checksum: ref.checksum, p_raw: null });
            stats.transcribe_failed++; stats.errors.push(`transcribe: ${reason}`);
          }
        }
        // frames for vision
        if (durationMs) {
          const frames = await sampleFrames(tmp.path, durationMs, 6);
          for (const f of frames) visionInputs.push({ mediaId: ref.mediaId, source: 'frame', frameTsMs: f.tsMs, buffer: f.jpeg, mime: 'image/jpeg' });
        }
      } finally { await cleanup(tmp.dir); }
    } else if ((ref.kind === 'image' || ref.kind === 'thumbnail') && ref.bytes) {
      visionInputs.push({ mediaId: ref.mediaId, source: ref.kind === 'thumbnail' ? 'thumbnail' : 'image', frameTsMs: null, buffer: ref.bytes, mime: null });
    }
  }

  // ── visual text (one Claude call across up to MAX_IMAGES inputs) ──
  let visualTextBlob = '';
  if (visionInputs.length > 0) {
    const batch = visionInputs.slice(0, MAX_IMAGES);
    try {
      const { results, costUsd } = await extractVisualText(batch.map((v) => ({ buffer: v.buffer, mime: v.mime })));
      stats.cost_usd += costUsd;
      const perRowCost = results.length > 0 ? Math.round((costUsd / results.length) * 1e6) / 1e6 : 0; // split the single vision-call cost across its rows
      for (const r of results) {
        const inp = batch[r.index]; if (!inp) continue;
        visualTextBlob += ' ' + (r.fields.visible_text ?? '');
        if (inp.source === 'frame') stats.frames_analyzed++; else stats.images_analyzed++;
        await sb.rpc('mkt_visual_text_upsert', { p_media: inp.mediaId, p_post: contentPostId, p_source: inp.source, p_frame_ts_ms: inp.frameTsMs, p_model: process.env.MKT_VISION_MODEL ?? 'claude-sonnet-4-6', p_text: r.fields.visible_text ?? '', p_structured: r.fields, p_confidence: null, p_cost: perRowCost, p_status: 'done', p_failure: null, p_raw: null });
      }
    } catch (e) { stats.errors.push(`vision: ${e instanceof Error ? e.message : String(e)}`); }
  }

  // ── enrichment (deterministic narrowing → Claude structure/choose) ──
  const pubProjects = await publisherProjectIds(sb, post.organization_id as string | null);
  const index = await loadProjectIndex(sb, pubProjects);
  const commonTokens = computeCommonTokens(await loadAllProjectNames(sb));
  const combined = `${post.caption ?? ''}\n${transcriptText}\n${visualTextBlob}`.trim();
  let candidates: NarrowedCandidate[] = [];
  try {
    candidates = narrowProjects(combined, index, pubProjects, commonTokens);
    const acctIdentity = await accountIdentity(sb, post.social_account_id as string | null);
    const enr = await enrichContent({ accountIdentity: acctIdentity, platform: post.platform as string, caption: post.caption ?? '', transcript: transcriptText, visualText: visualTextBlob, candidates });
    stats.cost_usd += enr.costUsd; stats.enriched = true; stats.primary_project = enr.primaryProjectId;
    await sb.rpc('mkt_enrichment_upsert', { p_post: contentPostId, p_model: enr.model, p_rule_version: RULE_VERSION, p_org: post.organization_id, p_developer: null, p_marketer: null, p_primary_project: enr.primaryProjectId, p_candidates: enr.candidates, p_result: enr.result, p_cost: enr.costUsd, p_status: 'done', p_failure: null });

    // ── attribution: primary project + strong deterministic candidates ──
    if (enr.primaryProjectId) {
      await sb.rpc('mkt_attribution_upsert', { p_content_post_id: contentPostId, p_project_id: enr.primaryProjectId, p_method: 'caption', p_confidence: 0.9, p_evidence: { matched: 'enrichment', snippet: combined.slice(0, 160) }, p_matched_aliases: [], p_auto_accept: true });
      stats.attributions++;
    }
    for (const c of candidates) {
      if (c.projectId === enr.primaryProjectId) continue;
      if (c.confidence >= 0.8) { await sb.rpc('mkt_attribution_upsert', { p_content_post_id: contentPostId, p_project_id: c.projectId, p_method: 'caption', p_confidence: c.confidence, p_evidence: { matched: c.matchedAliases.join(','), snippet: combined.slice(0, 160) }, p_matched_aliases: c.matchedAliases, p_auto_accept: false }); stats.attributions++; }
    }
  } catch (e) {
    await sb.rpc('mkt_enrichment_upsert', { p_post: contentPostId, p_model: null, p_rule_version: RULE_VERSION, p_org: post.organization_id, p_developer: null, p_marketer: null, p_primary_project: null, p_candidates: '[]', p_result: '{}', p_cost: 0, p_status: 'failed', p_failure: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    stats.errors.push(`enrich: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── explicit terminal state for video posts whose video bytes were not
  //    collectable (TikTok Apify config returns empty mediaUrls; YouTube has no
  //    direct mp4). Record it so a "video" post is never silently "processed"
  //    without its video/transcript. ──
  const videoStored = storedRefs.some((r) => r.kind === 'video' && r.bytes);
  const videoUnavailable = isVideoPostType && !videoStored;
  // Only write a generic "not present" row when NO video was even attempted (no
  // descriptor). If a descriptor WAS attempted and failed, the media-download
  // loop already recorded the REAL classified reason — never overwrite it.
  const videoAttempted = descriptors.some((d) => d.kind === 'video') || (post.platform === 'youtube');
  if (videoUnavailable && !videoAttempted && post.platform !== 'youtube') {
    const reason = post.platform === 'tiktok' ? 'tiktok video bytes not present (re-collect with shouldDownloadVideos, or the no-watermark URL expired before download)' : 'no downloadable video url in payload';
    await sb.rpc('mkt_content_media_upsert', { p_post: contentPostId, p_carousel_index: 0, p_kind: 'video', p_original_url: null, p_bucket: null, p_path: null, p_url: null, p_mime: null, p_bytes: null, p_width: null, p_height: null, p_duration_ms: null, p_checksum: null, p_phash: null, p_status: 'failed', p_failure: reason });
    stats.errors.push(`video_unavailable: ${reason}`);
  }

  // ── roll-up status ──
  const anyStored = stats.media_stored > 0;
  const allMediaOk = stats.media_failed === 0 && stats.transcribe_failed === 0 && !videoUnavailable;
  stats.status = !anyStored ? 'failed' : (allMediaOk && stats.enriched) ? 'processed' : 'partial';
  await sb.rpc('mkt_content_set_status', { p_post: contentPostId, p_status: stats.status, p_media_count: stats.media_stored });
  stats.cost_usd = Math.round(stats.cost_usd * 10000) / 10000;
  return stats;
}

async function publisherProjectIds(sb: SupabaseClient, orgId: string | null): Promise<string[]> {
  if (!orgId) return [];
  const { data } = await sb.from('mkt_project_organizations').select('project_id').eq('organization_id', orgId);
  return (data ?? []).map((r) => r.project_id as string);
}
async function accountIdentity(sb: SupabaseClient, accountId: string | null): Promise<string> {
  if (!accountId) return 'unknown';
  const { data } = await sb.from('mkt_social_accounts').select('handle, platform').eq('id', accountId).maybeSingle();
  return data ? `@${data.handle} (${data.platform})` : 'unknown';
}
