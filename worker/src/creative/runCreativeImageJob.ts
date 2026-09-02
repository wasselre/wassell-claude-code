/**
 * runCreativeImageJob — executes ONE human-approved AI image recommendation
 * (generation_jobs kind='creative-image'; contracts §0.8 / §7; brief A-WORKER
 * deliverable 4).
 *
 * Pipeline:
 *   1. Flag gate — `creative_writer.ai_image_execution` re-checked HERE (the
 *      lane also gates; a job claimed while the flag flips must still refuse):
 *      off → the recommendation's execution is marked failed with
 *      `policy_blocked: execution disabled` and the job fails the same way.
 *   2. Load the package + re-check the §7 fabrication policy
 *      (`checkAiRecommendation`) on the frozen params — a prompt that names
 *      project features is refused, never executed.
 *   3. Resolve source files → fetchable URLs (public bucket → public URL,
 *      private → service-client signed URL). Competitor media and
 *      restricted/do_not_use sources are refused (`rights_blocked:`).
 *   4. Execute through the image provider registry (resolveImageProvider):
 *      cleanup/crop/color_correct/extend_background/remove_clutter → edit,
 *      combine → combine, supporting_visual → generate, remove_text →
 *      removeText. `request_photo` is never executable.
 *   5. Re-host the output to marketing-assets/creative/<content_id>/<uuid>.png.
 *   6. media_assets row (provenance: prompt/model/settings{package_id,index,
 *      source_file_ids,mode}) + a first-class `files` row
 *      (usage_rights='needs_review', asset_nature ai_edited|ai_generated,
 *      production_state='edited', acquisition_source='internal',
 *      primary_category='ai_content') + mos_assets wrapper + mos_asset_links
 *      role='reference'. NEVER role='final' — a human promotes.
 *   7. mos_creative_package_patch writes ai_recommendations[index].execution
 *      + .status (single-row jsonb_set — never a JS read-modify-write).
 *
 * On any failure after the package row was loaded, the execution is patched
 * failed FIRST (the UI spinner exits) and the error rethrown so the lane marks
 * the generation_jobs row failed — same posture as runCleanTextJob.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from '../env.js';
import { checkAiRecommendation } from './director/policy.js';
import { resolveImageProvider, type ImageProvider } from './imageProvider.js';
import type { ImageRoleKey } from './roles.js';
import type { AiMode, BasePackage } from './contracts.js';

// ── Job + params ─────────────────────────────────────────────────────────────

/** The claimed generation_jobs row (kind='creative-image'). */
export interface CreativeImageJob {
  id: string;
  /** generation_jobs.record_id — a records row the queue FK demands; carried for logs, never written. */
  recordId: string;
  /** auth.users id of the submitter (media_assets.created_by_user_id). */
  userId: string;
  params: Record<string, unknown>;
  attempts: number;
}

export interface CreativeImageParams {
  package_id: string;
  index: number;
  mode: AiMode;
  prompt: string;
  source_file_ids: string[];
  aspect: string;
  must_keep: string[];
  must_change: string[];
  /** public.users id of the approver (files.uploaded_by_user_id / mos_assets.created_by_user_id). */
  approved_by: string;
}

/** Parse + validate the frozen params. Bad params are a caller bug — plain Error (terminal). */
export function parseCreativeImageParams(raw: Record<string, unknown>): CreativeImageParams {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const p: CreativeImageParams = {
    package_id: str(raw.package_id),
    index: typeof raw.index === 'number' && Number.isInteger(raw.index) ? raw.index : -1,
    mode: str(raw.mode) as AiMode,
    prompt: str(raw.prompt),
    source_file_ids: strArr(raw.source_file_ids),
    aspect: str(raw.aspect) || '1:1',
    must_keep: strArr(raw.must_keep),
    must_change: strArr(raw.must_change),
    approved_by: str(raw.approved_by),
  };
  if (!p.package_id) throw new Error('creative-image job missing params.package_id');
  if (p.index < 0) throw new Error('creative-image job has an invalid params.index');
  if (!p.mode) throw new Error('creative-image job missing params.mode');
  if (!p.prompt.trim()) throw new Error('creative-image job missing params.prompt');
  if (!p.approved_by) throw new Error('creative-image job missing params.approved_by');
  return p;
}

// ── DB seam (default implementation below; tests inject a fake) ──────────────

export interface PackageForImage {
  id: string;
  content_id: string;
  base: BasePackage;
}

export interface SourceFileRow {
  id: string;
  original_name: string | null;
  title: string | null;
  storage_bucket: string;
  storage_path: string;
  usage_rights: string | null;
  acquisition_source: string | null;
}

export interface CreativeImageIo {
  readAiExecutionEnabled(sb: SupabaseClient): Promise<boolean>;
  loadPackage(sb: SupabaseClient, packageId: string): Promise<PackageForImage | null>;
  loadContentTitle(sb: SupabaseClient, contentId: string): Promise<string | null>;
  loadSourceFiles(sb: SupabaseClient, ids: string[]): Promise<SourceFileRow[]>;
  resolveSourceUrl(sb: SupabaseClient, bucket: string, path: string): Promise<string>;
  uploadOutput(sb: SupabaseClient, storagePath: string, bytes: Uint8Array, contentType: string): Promise<string>;
  insertMediaAsset(sb: SupabaseClient, row: Record<string, unknown>): Promise<string>;
  insertFile(sb: SupabaseClient, row: Record<string, unknown>): Promise<string>;
  findOrCreateMosAsset(sb: SupabaseClient, file: { id: string; title: string; original_name: string; mime_type: string; size_bytes: number }, approvedBy: string): Promise<string>;
  linkAsset(sb: SupabaseClient, assetId: string, contentId: string, role: string): Promise<void>;
  patchExecution(sb: SupabaseClient, packageId: string, index: number, execution: Record<string, unknown>): Promise<void>;
  patchStatus(sb: SupabaseClient, packageId: string, index: number, status: string): Promise<void>;
}

const PUBLIC_BUCKETS = new Set(['marketing-assets', 'listing-photos']);
const OUTPUT_BUCKET = 'marketing-assets';
const SIGNED_URL_TTL_SEC = 600;

export function makeCreativeImageIo(): CreativeImageIo {
  return {
    async readAiExecutionEnabled(sb) {
      const { data, error } = await sb.from('mos_settings').select('value').eq('key', 'creative_writer').maybeSingle();
      if (error) throw new Error(`provider:supabase mos_settings.creative_writer read failed: ${error.message}`);
      const v = (data as { value?: unknown } | null)?.value;
      return !!(v && typeof v === 'object' && !Array.isArray(v) && (v as Record<string, unknown>).ai_image_execution === true);
    },

    async loadPackage(sb, packageId) {
      const { data, error } = await sb
        .from('mos_creative_packages')
        .select('id, content_id, base')
        .eq('id', packageId)
        .maybeSingle();
      if (error) throw new Error(`provider:supabase mos_creative_packages read failed: ${error.message}`);
      if (!data) return null;
      const row = data as { id: string; content_id: string; base: unknown };
      if (!row.base || typeof row.base !== 'object') return null;
      return { id: row.id, content_id: row.content_id, base: row.base as BasePackage };
    },

    async loadContentTitle(sb, contentId) {
      const { data, error } = await sb.from('mos_content').select('title').eq('id', contentId).maybeSingle();
      if (error) throw new Error(`provider:supabase mos_content read failed: ${error.message}`);
      return ((data as { title?: string | null } | null)?.title) ?? null;
    },

    async loadSourceFiles(sb, ids) {
      if (ids.length === 0) return [];
      const { data, error } = await sb
        .from('files')
        .select('id, original_name, title, storage_bucket, storage_path, usage_rights, acquisition_source')
        .in('id', ids);
      if (error) throw new Error(`provider:supabase files read failed: ${error.message}`);
      return (data ?? []) as SourceFileRow[];
    },

    async resolveSourceUrl(sb, bucket, path) {
      if (PUBLIC_BUCKETS.has(bucket)) {
        const { data } = sb.storage.from(bucket).getPublicUrl(path);
        if (data?.publicUrl) return data.publicUrl;
        throw new Error(`provider:supabase public URL not resolved for ${bucket}/${path}`);
      }
      const { data, error } = await sb.storage.from(bucket).createSignedUrl(path, SIGNED_URL_TTL_SEC);
      if (error || !data?.signedUrl) {
        throw new Error(`provider:supabase createSignedUrl failed for ${bucket}/${path}: ${error?.message ?? 'no url'}`);
      }
      return data.signedUrl;
    },

    async uploadOutput(sb, storagePath, bytes, contentType) {
      const { error } = await sb.storage.from(OUTPUT_BUCKET).upload(storagePath, bytes, { contentType, upsert: false });
      if (error) throw new Error(`provider:supabase output upload failed: ${error.message}`);
      const { data } = sb.storage.from(OUTPUT_BUCKET).getPublicUrl(storagePath);
      if (!data?.publicUrl) throw new Error('provider:supabase output uploaded but public URL not resolved');
      return data.publicUrl;
    },

    async insertMediaAsset(sb, row) {
      const { data, error } = await sb.from('media_assets').insert(row).select('id').single();
      if (error) throw new Error(`provider:supabase media_assets insert failed: ${error.message}`);
      return (data as { id: string }).id;
    },

    async insertFile(sb, row) {
      const { data, error } = await sb.from('files').insert(row).select('id').single();
      if (error) throw new Error(`provider:supabase files insert failed: ${error.message}`);
      return (data as { id: string }).id;
    },

    async findOrCreateMosAsset(sb, file, approvedBy) {
      // Replicates the minimal insert `asset_link_from_file` does in api/marketing-os.ts.
      const { data: existing, error: exErr } = await sb
        .from('mos_assets')
        .select('id')
        .eq('file_id', file.id)
        .is('archived_at', null)
        .limit(1)
        .maybeSingle();
      if (exErr) throw new Error(`provider:supabase mos_assets lookup failed: ${exErr.message}`);
      if (existing) return (existing as { id: string }).id;
      const { data, error } = await sb
        .from('mos_assets')
        .insert({
          title: file.title || file.original_name || 'ملف',
          kind: 'photo',
          file_id: file.id,
          mime_type: file.mime_type,
          size_bytes: file.size_bytes,
          original_name: file.original_name,
          created_by_user_id: approvedBy,
        })
        .select('id')
        .single();
      if (error) throw new Error(`provider:supabase mos_assets insert failed: ${error.message}`);
      return (data as { id: string }).id;
    },

    async linkAsset(sb, assetId, contentId, role) {
      const { error } = await sb
        .from('mos_asset_links')
        .upsert({ asset_id: assetId, content_id: contentId, role }, { onConflict: 'asset_id,content_id' });
      if (error) throw new Error(`provider:supabase mos_asset_links upsert failed: ${error.message}`);
    },

    async patchExecution(sb, packageId, index, execution) {
      const { error } = await sb.rpc('mos_creative_package_patch', {
        p_package_id: packageId,
        p_path: ['ai_recommendations', String(index), 'execution'],
        p_value: execution,
      });
      if (error) throw new Error(`provider:supabase mos_creative_package_patch(execution) failed: ${error.message}`);
    },

    async patchStatus(sb, packageId, index, status) {
      const { error } = await sb.rpc('mos_creative_package_patch', {
        p_package_id: packageId,
        p_path: ['ai_recommendations', String(index), 'status'],
        p_value: status,
      });
      if (error) throw new Error(`provider:supabase mos_creative_package_patch(status) failed: ${error.message}`);
    },
  };
}

// ── Mode → provider role / operation ─────────────────────────────────────────

/** Which ai_roles key the mode executes on. */
export function roleForMode(mode: AiMode): ImageRoleKey {
  if (mode === 'remove_text') return 'image_remove_text';
  if (mode === 'supporting_visual') return 'image_generate';
  return 'image_edit';
}

/** Modes that only fix an existing photo — keep the source framing. */
const KEEP_FRAMING_MODES: ReadonlySet<string> = new Set(['cleanup', 'crop', 'color_correct']);

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// ── The runner ───────────────────────────────────────────────────────────────

export interface RunCreativeImageArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: CreativeImageJob;
  /** Test seam — production uses makeCreativeImageIo(). */
  io?: CreativeImageIo;
  /** Test seam — production resolves the provider from mos_settings.ai_roles. */
  providerFactory?: (role: ImageRoleKey) => Promise<ImageProvider>;
  /** Test seam — production fetches the output bytes over HTTPS. */
  fetchOutput?: (url: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
  log?: (msg: string, extra?: unknown) => void;
}

export interface CreativeImageOutcome {
  file_id: string;
  asset_id: string;
  media_asset_id: string;
  output_url: string;
}

export async function runCreativeImageJob(args: RunCreativeImageArgs): Promise<CreativeImageOutcome> {
  const { supabase: sb, job } = args;
  const io = args.io ?? makeCreativeImageIo();
  const log = args.log ?? ((msg: string, extra?: unknown) => { if (extra !== undefined) console.log(`[creative-image] ${msg}`, extra); else console.log(`[creative-image] ${msg}`); });
  const params = parseCreativeImageParams(job.params);

  /** Best-effort terminal patch so the package UI exits its spinner, then the
   *  caller rethrows to fail the job. Patch failures are logged, never fatal. */
  const markFailed = async (errorMessage: string): Promise<void> => {
    try {
      await io.patchExecution(sb, params.package_id, params.index, {
        job_id: job.id,
        output_file_id: null,
        error: errorMessage.slice(0, 500),
        approved_by: params.approved_by,
        approved_at: null,
      });
      await io.patchStatus(sb, params.package_id, params.index, 'failed');
    } catch (e) {
      console.error(`[creative-image] could not patch the execution failure onto package ${params.package_id}:`, e instanceof Error ? e.message : e);
    }
  };

  // ── 1. Flag gate ─────────────────────────────────────────────────────────
  const enabled = await io.readAiExecutionEnabled(sb);
  if (!enabled) {
    const msg = 'policy_blocked: ai image execution disabled (creative_writer.ai_image_execution is off)';
    await markFailed(msg);
    throw new Error(msg);
  }

  // ── 2. Package + §7 policy re-check ──────────────────────────────────────
  const pkg = await io.loadPackage(sb, params.package_id);
  if (!pkg) {
    throw new Error(`creative-image: package ${params.package_id} not found or has no base`);
  }
  const rec = (pkg.base.ai_recommendations ?? [])[params.index];
  if (!rec) {
    throw new Error(`creative-image: package ${params.package_id} has no ai_recommendations[${params.index}]`);
  }
  if (params.mode === 'request_photo') {
    const msg = 'policy_blocked: request_photo is a human task — it is never executed by the image lane';
    await markFailed(msg);
    throw new Error(msg);
  }
  const verdict = checkAiRecommendation({ mode: params.mode, prompt: params.prompt, must_keep: params.must_keep });
  if (!verdict.ok) {
    await markFailed(verdict.reason);
    throw new Error(verdict.reason);
  }

  // ── 3. Sources ───────────────────────────────────────────────────────────
  const sourceRows = await io.loadSourceFiles(sb, params.source_file_ids);
  const byId = new Map(sourceRows.map((r) => [r.id, r]));
  const orderedSources: SourceFileRow[] = [];
  for (const id of params.source_file_ids) {
    const row = byId.get(id);
    if (!row) throw new Error(`creative-image: source file ${id} not found`);
    if (row.acquisition_source === 'competitor') {
      const msg = `rights_blocked: source file ${id} is competitor media — reference-only, never an AI input`;
      await markFailed(msg);
      throw new Error(msg);
    }
    if (row.usage_rights === 'restricted' || row.usage_rights === 'do_not_use') {
      const msg = `rights_blocked: source file ${id} has usage_rights='${row.usage_rights}' — never usable`;
      await markFailed(msg);
      throw new Error(msg);
    }
    orderedSources.push(row);
  }
  const sourceUrls: string[] = [];
  for (const row of orderedSources) {
    sourceUrls.push(await io.resolveSourceUrl(sb, row.storage_bucket, row.storage_path));
  }

  const needsSource = params.mode !== 'supporting_visual';
  if (needsSource && sourceUrls.length === 0) {
    throw new Error(`creative-image: mode '${params.mode}' needs at least one source image but params.source_file_ids is empty`);
  }

  // ── 4. Execute ───────────────────────────────────────────────────────────
  const providerFactory = args.providerFactory ?? ((role: ImageRoleKey) => resolveImageProvider(role, sb));
  const provider = await providerFactory(roleForMode(params.mode));
  log(`executing mode=${params.mode} via ${provider.kind}/${provider.model} (package=${params.package_id} index=${params.index})`);

  let resultUrls: string[];
  if (params.mode === 'remove_text') {
    resultUrls = (await provider.removeText({ source: sourceUrls[0]! })).urls;
  } else if (params.mode === 'supporting_visual') {
    resultUrls = (await provider.generate({ prompt: params.prompt, aspect: params.aspect, n: 1 })).urls;
  } else if (params.mode === 'combine' && sourceUrls.length >= 2) {
    resultUrls = (await provider.combine({
      prompt: params.prompt,
      sources: sourceUrls.map((url, i) => ({ url, role: orderedSources[i]!.title ?? orderedSources[i]!.original_name ?? `source ${i + 1}` })),
    })).urls;
  } else {
    if (params.mode === 'combine' && sourceUrls.length < 2) {
      console.error(`[creative-image] combine requested with ${sourceUrls.length} source(s) — degrading to a single-source edit`);
    }
    resultUrls = (await provider.edit({
      prompt: params.prompt,
      sources: sourceUrls,
      aspect: params.aspect,
      keepFraming: KEEP_FRAMING_MODES.has(params.mode) && sourceUrls.length === 1,
    })).urls;
  }
  const outputUrl = resultUrls[0];
  if (!outputUrl) throw new Error(`provider:fal ${params.mode} returned no output URL`);

  // ── 5. Re-host the output ────────────────────────────────────────────────
  const fetchOutput = args.fetchOutput ?? (async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`provider:supabase output fetch failed (${res.status})`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? 'image/png' };
  });
  const { bytes, contentType } = await fetchOutput(outputUrl);
  const ext = contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : 'png';
  const storagePath = `creative/${pkg.content_id}/${crypto.randomUUID()}.${ext}`;
  const publicUrl = await io.uploadOutput(sb, storagePath, bytes, contentType);

  // ── 6. Register the candidate (files + media_assets + mos_assets + link) ──
  const contentTitle = await io.loadContentTitle(sb, pkg.content_id);
  const titleBase = truncate(`AI · ${params.mode} · ${contentTitle ?? pkg.content_id}`, 200);
  const assetNature = params.mode === 'supporting_visual' ? 'ai_generated' : 'ai_edited';

  let fileId: string;
  let mediaAssetId: string;
  let assetId: string;
  try {
    mediaAssetId = await io.insertMediaAsset(sb, {
      kind: 'image',
      storage_bucket: OUTPUT_BUCKET,
      storage_path: storagePath,
      public_url: publicUrl,
      mime_type: contentType,
      prompt: params.prompt,
      model_id: provider.model,
      settings: {
        package_id: params.package_id,
        index: params.index,
        source_file_ids: params.source_file_ids,
        mode: params.mode,
      },
      source_session_id: null,
      source_generation_id: null,
      created_by_user_id: job.userId,
    });

    fileId = await io.insertFile(sb, {
      uploaded_by_user_id: params.approved_by,
      original_name: truncate(`${titleBase}.${ext}`, 500),
      title: titleBase,
      mime_type: contentType,
      size_bytes: bytes.length,
      storage_bucket: OUTPUT_BUCKET,
      storage_path: storagePath,
      kind: 'image',
      asset_nature: assetNature,
      usage_rights: 'needs_review',
      production_state: 'edited',
      acquisition_source: 'internal',
      primary_category: 'ai_content',
      aspect_ratio: params.aspect,
      ai_description: params.prompt,
    });

    assetId = await io.findOrCreateMosAsset(sb, {
      id: fileId,
      title: titleBase,
      original_name: truncate(`${titleBase}.${ext}`, 500),
      mime_type: contentType,
      size_bytes: bytes.length,
    }, params.approved_by);

    await io.linkAsset(sb, assetId, pkg.content_id, 'reference');
  } catch (e) {
    await markFailed(e instanceof Error ? e.message : String(e));
    throw e;
  }

  // ── 7. Patch the execution + status (completed) ──────────────────────────
  await io.patchExecution(sb, params.package_id, params.index, {
    job_id: job.id,
    output_file_id: fileId,
    error: null,
    approved_by: params.approved_by,
    approved_at: new Date().toISOString(),
  });
  await io.patchStatus(sb, params.package_id, params.index, 'completed');

  log(`completed package=${params.package_id} index=${params.index} → file=${fileId} (${assetNature}, needs_review)`);
  return { file_id: fileId, asset_id: assetId, media_asset_id: mediaAssetId, output_url: publicUrl };
}
