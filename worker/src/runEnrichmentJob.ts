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
  imageToBoundedJpeg,
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
/** PDFs go whole as a document block; keep the base64 comfortably under the
 *  ~32 MB request cap. Larger PDFs get a kind-based default instead. */
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 400 * 1024 * 1024;
const MAX_FRAMES = 6;

/** Blind, content-free best guess used only when a file cannot be READ at all
 *  (unsupported/oversized/undecodable). primary_category is REQUIRED, so an
 *  un-analysable file still gets a reasonable in-vocabulary value rather than
 *  NULL; a human can correct it from the AI-review queue. All values are seeded
 *  primary_category vocab rows. */
const KIND_DEFAULT_PRIMARY: Record<string, string> = {
  image: 'raw_photo', pdf: 'brochure', document: 'brochure', video: 'raw_video', audio: 'voiceover',
};
function noopDefault(kind: string): Record<string, unknown> {
  const v = KIND_DEFAULT_PRIMARY[kind];
  return v ? { model: 'kind-default', primary_category: v, primary_category_fallback: true } : {};
}

export interface RunEnrichmentJobArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: EnrichmentJob;
}

/** Deterministic best-guess primary "Document Type" from the fields the model
 *  DOES fill reliably (kind + asset_nature + production_state), used only when
 *  the model failed to return a valid one. Always returns an in-allowlist value
 *  (falls back to the first offered), so the required field is never left empty. */
function fallbackPrimary(
  kind: string, nature: string | undefined, pstate: string | undefined, allowed: string[],
): string {
  const pick = (arr: string[]) => arr.find((v) => allowed.includes(v)) ?? allowed[0]!;
  if (kind === 'audio') return pick(['voiceover', 'music']);
  if (kind === 'video') {
    if (nature === 'ai_generated' || nature === 'ai_edited') return pick(['ai_content', 'ready_video', 'raw_video']);
    return pick(pstate === 'raw' ? ['raw_video', 'ready_video'] : ['ready_video', 'raw_video']);
  }
  // image / pdf / document
  if (nature === 'ai_generated' || nature === 'ai_edited') return pick(['ai_content', 'design']);
  if (nature === 'graphic_design' || nature === 'cgi_render' || nature === 'screenshot') return pick(['design', 'raw_photo', 'brochure']);
  if (nature === 'real') return pick(kind === 'image' ? ['raw_photo', 'brochure'] : ['brochure', 'unit_plan']);
  return pick(kind === 'image' ? ['raw_photo', 'design', 'brochure'] : ['brochure', 'unit_plan']);
}

/** Returns the result jsonb for file_enrichment_complete ({} = no-op). Throws
 *  on a genuine failure — index.ts routes that to file_enrichment_fail. */
export async function runEnrichmentJob(
  { supabase, job }: RunEnrichmentJobArgs,
): Promise<Record<string, unknown>> {
  const kind = job.kind;
  if (!['image', 'pdf', 'video', 'audio'].includes(kind)) {
    // e.g. kind='document' (DOCX/PPTX) — not vision-readable here. Give it the
    // required field a kind-based default rather than leaving it NULL.
    console.log(`[enrich] job=${job.id} kind=${kind} not readable — kind-default`);
    return noopDefault(kind);
  }

  // ── Allowlists (the model may ONLY choose from these) ─────────────────────
  const VOCAB_DIMS = ['asset_nature', 'acquisition_source', 'usage_rights', 'production_state', 'primary_category'];
  const [subjRes, vocabRes] = await Promise.all([
    supabase.from('file_document_types')
      .select('value,label_ar,label_en,applies_to_kinds').eq('active', true),
    supabase.from('file_vocabularies')
      .select('dimension,value,label_ar,applies_to_kinds').in('dimension', VOCAB_DIMS).eq('active', true),
  ]);
  const subjectRows = (subjRes.data ?? []) as Array<{ value: string; label_ar: string; label_en: string; applies_to_kinds: string[] }>;
  const applicable = subjectRows.filter((r) => !r.applies_to_kinds?.length || r.applies_to_kinds.includes(kind));
  const subjectValues = applicable.map((r) => r.value);
  // Group the vocabulary rows by dimension — one allowlist per structured field.
  const vocabByDim = new Map<string, Array<{ value: string; label_ar: string }>>();
  for (const r of (vocabRes.data ?? []) as Array<{ dimension: string; value: string; label_ar: string }>) {
    const arr = vocabByDim.get(r.dimension) ?? [];
    arr.push({ value: r.value, label_ar: r.label_ar });
    vocabByDim.set(r.dimension, arr);
  }
  const dim = (d: string) => vocabByDim.get(d) ?? [];
  const natureRows = dim('asset_nature');
  const natureValues = natureRows.map((r) => r.value);
  const acqRows = dim('acquisition_source');
  const acqValues = acqRows.map((r) => r.value);
  const rightsRows = dim('usage_rights');
  const rightsValues = rightsRows.map((r) => r.value);
  const stateRows = dim('production_state');
  const stateValues = stateRows.map((r) => r.value);
  // The required primary "Document Type" — scoped to this file's kind so a PDF is
  // offered brochure/unit_plan and a video raw_video/ready_video.
  const pcatAll = vocabByDim.get('primary_category') ?? [];
  const pcatRowsRaw = (vocabRes.data ?? []) as Array<{ dimension: string; value: string; label_ar: string; applies_to_kinds?: string[] }>;
  const pcatKinds = new Map(pcatRowsRaw.filter((r) => r.dimension === 'primary_category').map((r) => [r.value, r.applies_to_kinds ?? []]));
  const pcatRows = pcatAll.filter((r) => {
    const k = pcatKinds.get(r.value) ?? [];
    return k.length === 0 || k.includes(kind);
  });
  const pcatValues = pcatRows.map((r) => r.value);
  if (subjectValues.length === 0) { console.log(`[enrich] job=${job.id} no applicable subjects — no-op`); return {}; }

  // ── Gather what the model will see (blocks) + heard (transcript) ──────────
  const blocks: Anthropic.ContentBlockParam[] = [];
  let transcript = '';

  if (kind === 'image') {
    const bytes = await download(supabase, job);
    // ALWAYS re-encode through ffmpeg to a bounded baseline JPEG. Sending the raw
    // bytes trusted the stored mime_type, which frequently disagreed with the
    // actual content — Anthropic 400'd "The image was specified using the
    // image/webp media type, but ..." on 649 files in the backfill — and also
    // left oversized dimensions and unsupported/undecodable formats to fail hard.
    // One re-encode normalizes format + dimensions + byte size AND makes the
    // declared media_type (image/jpeg) always match. ffmpeg can't decode it →
    // kind-default (never a hard failure → never a null).
    try {
      const jpeg = await imageToBoundedJpeg(bytes, (job.mimeType || '').split('/')[1] || 'img');
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } });
    } catch (e) {
      console.log(`[enrich] job=${job.id} image undecodable (${job.mimeType}, ${(bytes.length / 1048576).toFixed(1)}MB): ${e instanceof Error ? e.message : String(e)} — kind-default`);
      return noopDefault(kind);
    }
  } else if (kind === 'pdf') {
    if (job.sizeBytes > MAX_PDF_BYTES) { console.log(`[enrich] job=${job.id} pdf too large (${(job.sizeBytes / 1048576).toFixed(1)}MB) — kind-default`); return noopDefault(kind); }
    const bytes = await download(supabase, job);
    blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } });
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
    if (blocks.length === 0 && !transcript) { console.log(`[enrich] job=${job.id} nothing to analyse — kind-default`); return noopDefault(kind); }
  }

  // ── Ask the model ─────────────────────────────────────────────────────────
  const menu = (rows: Array<{ value: string; label_ar: string }>) => rows.map((r) => `${r.value} (${r.label_ar})`).join('، ');
  const subjectMenu = applicable.map((r) => `${r.value} (${r.label_ar})`).join('، ');
  const props: Record<string, unknown> = {
    description: { type: 'string', description: 'جملة أو جملتان بالعربية تصف محتوى الملف بدقة.' },
    title: { type: 'string', description: 'عنوان عربي قصير ووصفي للملف (٣–٨ كلمات) بدل اسم الملف التقني.' },
    // The ONE required primary "Document Type". Free string (so a new value can be
    // proposed), but the model is told to pick from the list unless nothing fits.
    primary_category: { type: 'string', description: 'النوع الرئيسي الوحيد للملف — اختر أنسب قيمة من القائمة. إن لم يناسب أيٌّ منها فعلاً، اكتب قيمة جديدة موجزة هنا واملأ new_primary_category.' },
    new_primary_category: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'مُعرّف إنجليزي قصير snake_case للنوع الجديد.' },
        label_ar: { type: 'string', description: 'اسم النوع بالعربية.' },
        label_en: { type: 'string', description: 'اسم النوع بالإنجليزية.' },
      },
      description: 'املأه فقط إذا كان primary_category قيمةً جديدة غير موجودة في القائمة.',
    },
    subjects: { type: 'array', items: { type: 'string', enum: subjectValues }, description: 'التصنيفات الفرعية المنطبقة — من القائمة فقط.' },
    new_subjects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label_ar: { type: 'string' }, label_en: { type: 'string' },
        },
      },
      description: 'تصنيفات فرعية جديدة غير موجودة في القائمة تريد إضافتها (اتركها فارغة عادةً).',
    },
    asset_nature: { type: 'string', enum: natureValues, description: 'طبيعة الأصل — من القائمة فقط.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'وسوم قصيرة بالعربية للسمات الظاهرة.' },
    detected_names: {
      type: 'array', items: { type: 'string' },
      description: 'أسماء المشاريع العقارية أو المطوّرين الظاهرة نصياً في الملف، كما هي بالضبط (مثل «مينا 52»). اتركها فارغة إن لم يظهر اسم واضح — لا تخمّن.',
    },
  };
  if (acqValues.length) props.acquisition_source = { type: 'string', enum: acqValues, description: 'مصدر الحصول — من القائمة فقط.' };
  if (rightsValues.length) props.usage_rights = { type: 'string', enum: rightsValues, description: 'حقوق الاستخدام — من القائمة فقط.' };
  if (stateValues.length) props.production_state = { type: 'string', enum: stateValues, description: 'حالة الإنتاج — من القائمة فقط.' };

  // The three axes are REQUIRED best-guesses — the operator wants every field
  // filled (they can override any). asset_nature/subjects/detected_names stay
  // optional (asset_nature already fills; names must never be guessed).
  const required = ['description', 'primary_category', 'asset_nature',
    ...(acqValues.length ? ['acquisition_source'] : []),
    ...(rightsValues.length ? ['usage_rights'] : []),
    ...(stateValues.length ? ['production_state'] : [])];
  const tool = {
    name: 'propose_metadata',
    description: 'Propose metadata for a Wassel real-estate marketing file.',
    input_schema: { type: 'object' as const, properties: props, required },
  };
  const pcatMenu = menu(pcatRows);
  let prompt =
    `أنت تصنّف ملفاً تسويقياً عقارياً لشركة وصل العقارية. استدعِ الأداة propose_metadata واملأ كل الحقول.\n` +
    `- النوع الرئيسي primary_category (إلزامي — قيمة واحدة فقط): ${pcatMenu}. اختر الأنسب دائماً. إن لم يناسب أيٌّ منها فعلاً فاكتب قيمة جديدة موجزة في primary_category واملأ new_primary_category (value إنجليزي snake_case + label_ar + label_en).\n` +
    `- التصنيفات الفرعية المسموحة (استخدم القيمة الإنجليزية فقط): ${subjectMenu}.\n` +
    `- طبيعة الأصل المسموحة (القيمة الإنجليزية فقط): ${menu(natureRows)}.\n` +
    (acqValues.length ? `- مصدر الحصول (إلزامي — اختر الأقرب دائماً، لا تتركه فارغاً): ${menu(acqRows)}. استدلّ: تصميم/لقطة من أنظمتنا → internal؛ علامة أو شعار منافس → competitor؛ كتيّب أو رندر أو مخطط مطوّر → developer؛ صورة من عميل → client؛ مصدر عام/سوشيال بلا مالك واضح → public؛ إن لم يتّضح فاختر internal إن بدا من إنتاجنا وإلا unknown.\n` : '') +
    (stateValues.length ? `- حالة الإنتاج (إلزامي — اختر الأقرب دائماً): ${menu(stateRows)}. لقطة شاشة أو ملف غير مصقول → raw؛ تصميم/مخطط مصقول جاهز → final؛ عليه آثار تعديل بيني → edited؛ إن لم يتّضح فاختر raw.\n` : '') +
    (rightsValues.length ? `- حقوق الاستخدام (إلزامي — اختر الأقرب دائماً): ${menu(rightsRows)}. محتوى يبدو من إنتاجنا → approved؛ محتوى منافس أو عليه علامة طرف آخر → do_not_use؛ عند أي شكّ في الملكية → needs_review.\n` : '') +
    `- في detected_names: ضع أسماء المشاريع العقارية أو المطوّرين الظاهرة نصياً داخل الملف كما هي بالضبط (مثل «مينا 52»)، دون تخمين أو إضافة.\n` +
    `لا تخترع أي قيمة خارج القوائم. الحقول الإلزامية أعلاه يجب أن تحمل دائماً أقرب قيمة (لا تتركها فارغة). الوصف والعنوان والوسوم بالعربية.`;
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
    description?: unknown; title?: unknown; subjects?: unknown; asset_nature?: unknown; tags?: unknown;
    acquisition_source?: unknown; usage_rights?: unknown; production_state?: unknown; detected_names?: unknown;
    primary_category?: unknown; new_primary_category?: unknown; new_subjects?: unknown;
  };

  const result: Record<string, unknown> = { model: ENRICH_MODEL };
  if (typeof out.description === 'string' && out.description.trim()) result.description = out.description.trim();
  if (typeof out.title === 'string' && out.title.trim()) result.title = out.title.trim().slice(0, 200);

  // ── primary "Document Type" ──────────────────────────────────────────────
  // A value already in the allowlist → apply it directly. Otherwise, if the
  // model proposed a new type, forward it for create-and-apply (the complete RPC
  // dedups + creates). A bare unknown string with no new-type payload is dropped.
  if (typeof out.primary_category === 'string' && pcatValues.includes(out.primary_category)) {
    result.primary_category = out.primary_category;
  } else if (out.new_primary_category && typeof out.new_primary_category === 'object') {
    const np = out.new_primary_category as { value?: unknown; label_ar?: unknown; label_en?: unknown };
    const labelAr = typeof np.label_ar === 'string' ? np.label_ar.trim() : '';
    const labelEn = typeof np.label_en === 'string' ? np.label_en.trim() : '';
    const val = typeof np.value === 'string' ? np.value.trim()
      : (typeof out.primary_category === 'string' ? out.primary_category.trim() : '');
    if (labelAr || labelEn || val) {
      result.new_primary_category = { value: val, label_ar: labelAr, label_en: labelEn };
    }
  }
  // New secondary types the AI wants to add (kept small; the RPC creates + dedups).
  if (Array.isArray(out.new_subjects)) {
    const ns = out.new_subjects
      .filter((x): x is { label_ar?: string; label_en?: string } => Boolean(x) && typeof x === 'object')
      .map((x) => ({
        label_ar: typeof x.label_ar === 'string' ? x.label_ar.trim() : '',
        label_en: typeof x.label_en === 'string' ? x.label_en.trim() : '',
      }))
      .filter((x) => x.label_ar || x.label_en)
      .slice(0, 4);
    if (ns.length) result.new_subjects = ns;
  }
  // The three axes — accept only a value that is in its live allowlist.
  if (typeof out.acquisition_source === 'string' && acqValues.includes(out.acquisition_source)) result.acquisition_source = out.acquisition_source;
  if (typeof out.usage_rights === 'string' && rightsValues.includes(out.usage_rights)) result.usage_rights = out.usage_rights;
  if (typeof out.production_state === 'string' && stateValues.includes(out.production_state)) result.production_state = out.production_state;
  if (Array.isArray(out.subjects)) {
    const subs = out.subjects.filter((s): s is string => typeof s === 'string' && subjectValues.includes(s));
    if (subs.length) result.subjects = [...new Set(subs)];
  }
  if (typeof out.asset_nature === 'string' && natureValues.includes(out.asset_nature)) result.asset_nature = out.asset_nature;
  if (Array.isArray(out.tags)) {
    const tags = out.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim()).slice(0, 12);
    if (tags.length) result.tags = [...new Set(tags)];
  }

  // ── primary_category SAFETY NET ───────────────────────────────────────────
  // primary_category is REQUIRED, but a model sometimes returns a word outside
  // the list (e.g. an asset_nature like "screenshot") and no new-type proposal,
  // which the guard above drops → the required field would stay NULL (measured
  // ~33% on the newest/edge files). It DOES reliably fill asset_nature/kind, so
  // derive the closest in-allowlist primary from those rather than leave it empty.
  if (!result.primary_category && !result.new_primary_category && pcatValues.length) {
    const nat = typeof result.asset_nature === 'string' ? result.asset_nature : undefined;
    const pstate = typeof result.production_state === 'string' ? result.production_state : undefined;
    result.primary_category = fallbackPrimary(kind, nat, pstate, pcatValues);
    result.primary_category_fallback = true;
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

  const pcatLog = result.primary_category ? `${String(result.primary_category)}${result.primary_category_fallback ? '(fb)' : ''}`
    : (result.new_primary_category ? `NEW:${(result.new_primary_category as { value?: string }).value ?? '?'}` : 'n');
  console.log(`[enrich] job=${job.id} kind=${kind} frames=${blocks.filter((b) => b.type === 'image').length} tx=${transcript.length}c → desc=${result.description ? 'y' : 'n'} pcat=${pcatLog} subjects=${(result.subjects as string[] | undefined)?.length ?? 0} newSubs=${(result.new_subjects as unknown[] | undefined)?.length ?? 0} axes=${[result.asset_nature, result.acquisition_source, result.usage_rights, result.production_state].filter(Boolean).length}/4 title=${result.title ? 'y' : 'n'} names=${names.length} linkSugg=${nSugg}`);
  return result;
}

async function download(supabase: SupabaseClient, job: EnrichmentJob): Promise<Buffer> {
  const { data: blob, error } = await supabase.storage.from(job.storageBucket).download(job.storagePath);
  if (error || !blob) throw new Error(`download failed: ${error?.message ?? 'no data'}`);
  return Buffer.from(await blob.arrayBuffer());
}
