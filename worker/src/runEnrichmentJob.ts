/**
 * File AI enrichment job (file_enrichment_jobs queue) — image, PDF, video, audio.
 *
 * A vision/text model PROPOSES metadata, constrained to the live allowlists
 * (file_document_types subjects + file_vocabularies asset_nature). The DB RPC
 * file_enrichment_complete auto-applies the safe layers with an ai_suggested
 * provenance badge and re-validates every value server-side.
 *
 * Per kind:
 *   image → the image straight to the model.
 *   pdf   → the PDF as an Anthropic `document` block (scanned PDFs included).
 *   video → sampled frames (vision) + the spoken transcript (fal Whisper) via
 *           the SAME helpers the competitor-content pipeline uses (ffmpegMedia +
 *           falTranscribe) — no second transcription service.
 *   audio → the transcript only.
 *
 * A file that yields nothing usable (silent video with no frames, empty PDF)
 * resolves to {} → the job completes, nothing is applied. NO api/ counterpart:
 * enrichment is worker-only.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import {
  toTempFile, cleanup, probeDurationMs, hasAudioStream, extractAudio, sampleFrames,
} from './marketing/content/ffmpegMedia.js';
import { transcribeAudioUrl } from './marketing/content/falTranscribe.js';
import { uploadBytes } from './marketing/content/contentStore.js';
import { sha256Hex } from './marketing/adIntel.js';

export interface EnrichmentJob {
  id: string;
  fileId: string;
  attempts: number;
  storageBucket: string;
  storagePath: string;
  mimeType: string;
  kind: string;
  sizeBytes: number;
  originalName: string;
  documentType: string;
}

/** Cheap, fast, vision-capable — enrichment is high-volume. */
const ENRICH_MODEL = 'claude-haiku-4-5-20251001';
/** Under Anthropic's ~32 MB request cap once base64-inflated (image/pdf sent
 *  whole). Video is NOT sent whole — only its frames + transcript go to the
 *  model — so a bigger cap applies to video (ffmpeg reads it locally). */
const MAX_DIRECT_BYTES = 24 * 1024 * 1024;
const MAX_VIDEO_BYTES = 400 * 1024 * 1024;
const MAX_FRAMES = 6;

const IMAGE_MIMES: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
  'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png',
  'image/gif': 'image/gif', 'image/webp': 'image/webp',
};

export interface RunEnrichmentJobArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: EnrichmentJob;
}

/** Returns the result jsonb for file_enrichment_complete ({} = no-op). Throws
 *  on a genuine failure — index.ts routes that to file_enrichment_fail. */
export async function runEnrichmentJob(
  { supabase, job }: RunEnrichmentJobArgs,
): Promise<Record<string, unknown>> {
  const kind = job.kind;
  if (!['image', 'pdf', 'video', 'audio'].includes(kind)) {
    console.log(`[enrich] job=${job.id} kind=${kind} not handled — no-op`);
    return {};
  }

  // ── Allowlists (the model may ONLY choose from these) ─────────────────────
  const [subjRes, natureRes] = await Promise.all([
    supabase.from('file_document_types')
      .select('value,label_ar,label_en,applies_to_kinds').eq('active', true),
    supabase.from('file_vocabularies')
      .select('value,label_ar').eq('dimension', 'asset_nature').eq('active', true),
  ]);
  const subjectRows = (subjRes.data ?? []) as Array<{ value: string; label_ar: string; label_en: string; applies_to_kinds: string[] }>;
  const applicable = subjectRows.filter((r) => !r.applies_to_kinds?.length || r.applies_to_kinds.includes(kind));
  const subjectValues = applicable.map((r) => r.value);
  const natureRows = (natureRes.data ?? []) as Array<{ value: string; label_ar: string }>;
  const natureValues = natureRows.map((r) => r.value);
  if (subjectValues.length === 0) { console.log(`[enrich] job=${job.id} no applicable subjects — no-op`); return {}; }

  // ── Gather what the model will see (blocks) + heard (transcript) ──────────
  const blocks: Anthropic.ContentBlockParam[] = [];
  let transcript = '';

  if (kind === 'image' || kind === 'pdf') {
    if (job.sizeBytes > MAX_DIRECT_BYTES) { console.log(`[enrich] job=${job.id} too large — no-op`); return {}; }
    if (kind === 'image' && !IMAGE_MIMES[(job.mimeType || '').toLowerCase()]) {
      console.log(`[enrich] job=${job.id} image mime ${job.mimeType} unsupported — no-op`); return {};
    }
    const bytes = await download(supabase, job);
    const b64 = bytes.toString('base64');
    blocks.push(kind === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: IMAGE_MIMES[(job.mimeType || '').toLowerCase()]!, data: b64 } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
  } else {
    // video / audio — process locally with ffmpeg, transcribe with fal Whisper.
    if (job.sizeBytes > MAX_VIDEO_BYTES) { console.log(`[enrich] job=${job.id} media too large — no-op`); return {}; }
    const bytes = await download(supabase, job);
    const tmp = await toTempFile(bytes, kind === 'video' ? 'mp4' : 'm4a');
    try {
      const durationMs = await probeDurationMs(tmp.path).catch(() => 0);
      if (await hasAudioStream(tmp.path).catch(() => false)) {
        try {
          const audio = await extractAudio(tmp.path);
          const up = await uploadBytes(audio, 'content/audio', sha256Hex(audio), 'm4a', 'audio/mp4');
          const tx = await transcribeAudioUrl(up.storedUrl, durationMs || null);
          transcript = (tx.text ?? '').trim().slice(0, 6000);
        } catch (e) {
          console.log(`[enrich] job=${job.id} transcribe failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (kind === 'video' && durationMs) {
        try {
          const frames = await sampleFrames(tmp.path, durationMs, MAX_FRAMES);
          for (const f of frames) {
            blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.jpeg.toString('base64') } });
          }
        } catch (e) {
          console.log(`[enrich] job=${job.id} frames failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } finally {
      await cleanup(tmp.dir).catch(() => {});
    }
    if (blocks.length === 0 && !transcript) { console.log(`[enrich] job=${job.id} nothing to analyse — no-op`); return {}; }
  }

  // ── Ask the model ─────────────────────────────────────────────────────────
  const subjectMenu = applicable.map((r) => `${r.value} (${r.label_ar})`).join('، ');
  const natureMenu = natureRows.map((r) => `${r.value} (${r.label_ar})`).join('، ');
  const tool = {
    name: 'propose_metadata',
    description: 'Propose metadata for a Wassel real-estate marketing file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: 'جملة أو جملتان بالعربية تصف محتوى الملف بدقة.' },
        subjects: { type: 'array', items: { type: 'string', enum: subjectValues }, description: 'التصنيفات المنطبقة — من القائمة فقط.' },
        asset_nature: { type: 'string', enum: natureValues, description: 'طبيعة الأصل — من القائمة فقط.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'وسوم قصيرة بالعربية للسمات الظاهرة.' },
        detected_names: {
          type: 'array', items: { type: 'string' },
          description: 'أسماء المشاريع العقارية أو المطوّرين الظاهرة نصياً في الملف، كما هي بالضبط (مثل «مينا 52»). اتركها فارغة إن لم يظهر اسم واضح — لا تخمّن.',
        },
      },
      required: ['description'],
    },
  };
  let prompt =
    `أنت تصنّف ملفاً تسويقياً عقارياً لشركة وصل العقارية. استدعِ الأداة propose_metadata.\n` +
    `- التصنيفات المسموحة (استخدم القيمة الإنجليزية فقط): ${subjectMenu}.\n` +
    `- طبيعة الأصل المسموحة (القيمة الإنجليزية فقط): ${natureMenu}.\n` +
    `- في detected_names: ضع أسماء المشاريع العقارية أو المطوّرين الظاهرة نصياً داخل الملف كما هي بالضبط (مثل «مينا 52»)، دون تخمين أو إضافة.\n` +
    `لا تخترع أي قيمة خارج القوائم. الوصف والوسوم بالعربية.`;
  if (transcript) prompt += `\n\nنص الكلام في الملف (منسوخ آلياً):\n${transcript}`;
  if (kind === 'audio') prompt += `\n\n(هذا ملف صوتي — اعتمد على النص أعلاه.)`;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: ENRICH_MODEL,
    max_tokens: 800,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'propose_metadata' },
    messages: [{ role: 'user', content: [...blocks, { type: 'text', text: prompt }] }],
  });

  const toolUse = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) { console.log(`[enrich] job=${job.id} no tool call — no-op`); return {}; }
  const out = (toolUse.input ?? {}) as {
    description?: unknown; subjects?: unknown; asset_nature?: unknown; tags?: unknown; detected_names?: unknown;
  };

  const result: Record<string, unknown> = { model: ENRICH_MODEL };
  if (typeof out.description === 'string' && out.description.trim()) result.description = out.description.trim();
  if (Array.isArray(out.subjects)) {
    const subs = out.subjects.filter((s): s is string => typeof s === 'string' && subjectValues.includes(s));
    if (subs.length) result.subjects = [...new Set(subs)];
  }
  if (typeof out.asset_nature === 'string' && natureValues.includes(out.asset_nature)) result.asset_nature = out.asset_nature;
  if (Array.isArray(out.tags)) {
    const tags = out.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim()).slice(0, 12);
    if (tags.length) result.tags = [...new Set(tags)];
  }

  // ── Link suggestions (UNLINKED files only) ────────────────────────────────
  // The AI extracts the project/developer names it can read; matching to a real
  // record is deterministic (file_link_suggest). Skip the whole step when the
  // file is already linked — the operator rule is "linked → don't suggest". The
  // complete RPC re-checks the unlinked gate authoritatively.
  const names = Array.isArray(out.detected_names)
    ? [...new Set(out.detected_names.filter((n): n is string => typeof n === 'string' && n.trim().length >= 2).map((n) => n.trim()))]
    : [];
  let nSugg = 0;
  if (names.length > 0) {
    try {
      const { count } = await supabase
        .from('file_links').select('id', { count: 'exact', head: true }).eq('file_id', job.fileId);
      if ((count ?? 0) === 0) {
        const { data: sugg, error } = await supabase.rpc('file_link_suggest', { p_names: names });
        if (!error && Array.isArray(sugg) && sugg.length > 0) {
          result.link_suggestions = sugg;
          nSugg = sugg.length;
        }
      }
    } catch (e) {
      // A failed match is not a failed enrichment — the metadata still applies.
      console.log(`[enrich] job=${job.id} link-suggest failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`[enrich] job=${job.id} kind=${kind} frames=${blocks.filter((b) => b.type === 'image').length} tx=${transcript.length}c → desc=${result.description ? 'y' : 'n'} subjects=${(result.subjects as string[] | undefined)?.length ?? 0} names=${names.length} linkSugg=${nSugg}`);
  return result;
}

async function download(supabase: SupabaseClient, job: EnrichmentJob): Promise<Buffer> {
  const { data: blob, error } = await supabase.storage.from(job.storageBucket).download(job.storagePath);
  if (error || !blob) throw new Error(`download failed: ${error?.message ?? 'no data'}`);
  return Buffer.from(await blob.arrayBuffer());
}
