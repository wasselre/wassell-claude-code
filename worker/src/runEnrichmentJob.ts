/**
 * File AI enrichment job (file_enrichment_jobs queue) — the image + PDF lane.
 *
 * Downloads the file from the private bucket and asks a vision model to PROPOSE
 * metadata, constrained to the live allowlists (file_document_types for
 * subjects, file_vocabularies for asset_nature). Returns a result object; the
 * DB RPC file_enrichment_complete auto-applies the safe layers with an
 * ai_suggested provenance badge and re-validates every value server-side.
 *
 * Image AND PDF both go straight to the model — Anthropic accepts a PDF as a
 * `document` block, so no page-rendering step is needed (scanned PDFs included).
 * Office docs / video / audio are NOT handled here yet (video/audio need ASR);
 * they resolve to an empty result (job marked done, nothing applied) so they
 * never hang — a later lane can re-enrich them.
 *
 * NO api/ counterpart to keep in sync: enrichment is worker-only.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';

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
/** Under Anthropic's ~32 MB request cap once base64-inflated. Bigger files
 *  no-op (a huge brochure PDF is rare; can be handled by a downsampling lane). */
const MAX_ENRICH_BYTES = 24 * 1024 * 1024;

const IMAGE_MIMES: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

export interface RunEnrichmentJobArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: EnrichmentJob;
}

/** Returns the result jsonb for file_enrichment_complete ({} = no-op). Throws
 *  on a genuine failure — index.ts routes that to file_enrichment_fail. */
export async function runEnrichmentJob(
  { supabase, env, job }: RunEnrichmentJobArgs,
): Promise<Record<string, unknown>> {
  const kind = job.kind;
  const isImage = kind === 'image';
  const isPdf = kind === 'pdf';
  if (!isImage && !isPdf) {
    console.log(`[enrich] job=${job.id} kind=${kind} not handled by this lane — no-op`);
    return {};
  }
  const imgMime = isImage ? IMAGE_MIMES[(job.mimeType || '').toLowerCase()] : undefined;
  if (isImage && !imgMime) {
    console.log(`[enrich] job=${job.id} image mime ${job.mimeType} unsupported by vision — no-op`);
    return {};
  }
  if (job.sizeBytes > MAX_ENRICH_BYTES) {
    console.log(`[enrich] job=${job.id} too large (${job.sizeBytes} bytes) — no-op`);
    return {};
  }

  // ── Allowlists (the model may ONLY choose from these) ─────────────────────
  const [subjRes, natureRes] = await Promise.all([
    supabase.from('file_document_types')
      .select('value,label_ar,label_en,applies_to_kinds').eq('active', true),
    supabase.from('file_vocabularies')
      .select('value,label_ar,label_en').eq('dimension', 'asset_nature').eq('active', true),
  ]);
  const subjectRows = (subjRes.data ?? []) as Array<{ value: string; label_ar: string; label_en: string; applies_to_kinds: string[] }>;
  const applicableSubjects = subjectRows.filter(
    (r) => !r.applies_to_kinds?.length || r.applies_to_kinds.includes(kind),
  );
  const subjectValues = applicableSubjects.map((r) => r.value);
  const natureRows = (natureRes.data ?? []) as Array<{ value: string; label_ar: string; label_en: string }>;
  const natureValues = natureRows.map((r) => r.value);
  if (subjectValues.length === 0) {
    console.log(`[enrich] job=${job.id} no applicable subjects — no-op`);
    return {};
  }

  // ── Download the bytes ────────────────────────────────────────────────────
  const { data: blob, error: dlErr } = await supabase.storage
    .from(job.storageBucket).download(job.storagePath);
  if (dlErr || !blob) throw new Error(`download failed: ${dlErr?.message ?? 'no data'}`);
  const b64 = Buffer.from(await blob.arrayBuffer()).toString('base64');

  const mediaBlock = isImage
    ? { type: 'image' as const, source: { type: 'base64' as const, media_type: imgMime!, data: b64 } }
    : { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: b64 } };

  // A readable allowlist for the prompt (bilingual labels so the model maps well).
  const subjectMenu = applicableSubjects.map((r) => `${r.value} (${r.label_ar})`).join('، ');
  const natureMenu = natureRows.map((r) => `${r.value} (${r.label_ar})`).join('، ');

  const tool = {
    name: 'propose_metadata',
    description: 'Propose metadata for a Wassel real-estate marketing file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: { type: 'string', description: 'جملة أو جملتان بالعربية تصف ما يظهر في الملف بدقة.' },
        subjects: { type: 'array', items: { type: 'string', enum: subjectValues }, description: 'التصنيفات المنطبقة — من القائمة المسموحة فقط.' },
        asset_nature: { type: 'string', enum: natureValues, description: 'طبيعة الأصل — من القائمة المسموحة فقط.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'وسوم قصيرة بالعربية للسمات الظاهرة (مثل: مسبح، مطبخ، واجهة، ليلي، مفروش، أشخاص).' },
      },
      required: ['description'],
    },
  };

  const prompt =
    `أنت تصنّف ملفاً تسويقياً عقارياً لشركة وصل العقارية. انظر إلى الملف واستدعِ الأداة propose_metadata.\n` +
    `- التصنيفات المسموحة (استخدم القيمة الإنجليزية فقط): ${subjectMenu}.\n` +
    `- طبيعة الأصل المسموحة (القيمة الإنجليزية فقط): ${natureMenu}.\n` +
    `لا تخترع أي قيمة خارج القوائم. الوصف والوسوم بالعربية.`;

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const msg = await client.messages.create({
    model: ENRICH_MODEL,
    max_tokens: 800,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'propose_metadata' },
    messages: [{ role: 'user', content: [mediaBlock, { type: 'text', text: prompt }] }],
  });

  const toolUse = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) {
    console.log(`[enrich] job=${job.id} model returned no tool call — no-op`);
    return {};
  }
  const out = (toolUse.input ?? {}) as {
    description?: unknown; subjects?: unknown; asset_nature?: unknown; tags?: unknown;
  };

  // Clean + re-validate client-side too (the RPC re-validates as well).
  const result: Record<string, unknown> = { model: ENRICH_MODEL };
  if (typeof out.description === 'string' && out.description.trim()) {
    result.description = out.description.trim();
  }
  if (Array.isArray(out.subjects)) {
    const subs = out.subjects.filter((s): s is string => typeof s === 'string' && subjectValues.includes(s));
    if (subs.length) result.subjects = [...new Set(subs)];
  }
  if (typeof out.asset_nature === 'string' && natureValues.includes(out.asset_nature)) {
    result.asset_nature = out.asset_nature;
  }
  if (Array.isArray(out.tags)) {
    const tags = out.tags
      .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim())
      .slice(0, 12);
    if (tags.length) result.tags = [...new Set(tags)];
  }

  console.log(
    `[enrich] job=${job.id} kind=${kind} → desc=${result.description ? 'y' : 'n'} subjects=${(result.subjects as string[] | undefined)?.length ?? 0} nature=${result.asset_nature ?? '-'} tags=${(result.tags as string[] | undefined)?.length ?? 0}`,
  );
  return result;
}
