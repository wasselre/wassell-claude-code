/**
 * runSocialFileJob — register ONE competitor/developer post's stored photos and
 * videos as first-class `files` rows so they appear on the project's Files
 * tab, in the Business Library and in the WhatsApp file picker.
 *
 * The bytes were downloaded long ago by the content pipeline into the PUBLIC
 * marketing-assets bucket (mkt_content_media.stored_path). This lane COPIES
 * each object server-side (Storage copy — no download, no re-upload) into the
 * private wassel-files bucket under the owner's uid prefix, inserts a `files`
 * row with its metadata pre-filled from what the pipeline already read, and
 * writes the files id back onto the media row. The Files projection then
 * derives the project link from `mkt_content_media.file_id` joined to the
 * post's attribution (origin 'social') — so a human re-attribution moves the
 * link by itself; nothing here writes document_links.
 *
 * Copy, not reference: `files` deletion removes the object at
 * storage_bucket/storage_path, and marketing-assets objects are shared
 * content-addressed blobs the Competitor Watch library still renders.
 *
 * Rights defaults (operator decisions 2026-09-13):
 *   the project is ONE OF OURS (an our_projects row points at it) → 'approved'
 *   whoever published it — "we could use videos from other companies about
 *   our projects";
 *   else the publisher IS the project's developer → 'approved';
 *   else (a rival's content about a rival's project) → 'internal_only' —
 *   visible for study, hidden from the customer picker.
 * acquisition_source records WHO published (developer | competitor) either way.
 *
 * Never sets files.record_id — that column fires files_autoregister_library
 * and would create a duplicate marketing-library asset + a second 'marketing'
 * link. Never enqueues the Files AI read — the trigger skips origin
 * 'social_intake' (the competitor pipeline already OCR'd these pixels).
 *
 * Partial success is success: one media that fails to copy is reported and
 * left unregistered (the backfill/sweep retries it); the job fails only when
 * every media failed.
 */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface SocialFileJob {
  /** generation_jobs.id */
  id: string;
  /** mkt_content_posts.id */
  recordId: string;
  params: Record<string, unknown>;
  attempts: number;
}

const SOURCE_BUCKET = 'marketing-assets';
const FILES_BUCKET = 'wassel-files';
const ALL_PROJECTS_MODEL = '220c49b9-de57-492d-9eca-c0d9f54fd40f';

interface Settings {
  is_enabled: boolean;
  owner_user_id: string | null;
  owner_auth_uid: string | null;
  root_folder_id: string | null;
}

interface MediaRow {
  id: string; carousel_index: number; media_kind: 'image' | 'video';
  stored_path: string | null; mime_type: string | null; bytes: number | null;
  width: number | null; height: number | null; duration_ms: number | null;
  checksum_sha256: string | null; file_id: string | null;
}

function extOf(path: string, mime: string | null, kind: string): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(path);
  if (m) return m[1]!.toLowerCase();
  if (mime?.includes('png')) return 'png';
  if (mime?.includes('webp')) return 'webp';
  return kind === 'video' ? 'mp4' : 'jpg';
}

function mimeFor(ext: string, mime: string | null, kind: string): string {
  if (mime && mime !== 'application/octet-stream') return mime;
  if (kind === 'video') return 'video/mp4';
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
}

/**
 * A UNIT PLAN, recognised from the words the OCR already read off the image.
 *
 * Competitors post floor plans inside ordinary carousels, so classifying every
 * post image as a designed creative filed «رقم الوحدة 01 · المساحة الإجمالية
 * 115.85 م · الدور الأرضي» — a plain floor plan — under «تصميم» (found by the
 * operator 2026-09-15, 31 of 421 images).
 *
 * The discriminator is a FLOOR LABEL or a UNIT/VILLA NUMBER, not room names: a
 * spec creative happily lists «غرفة خادمة · غرفة سائق · مطبخ» as selling points
 * while being a poster, whereas «الدور الأرضي» / «رقم الفيلا 04» only appear on
 * the drawing itself. «رقم الغيلا» is in the list because that is how the OCR
 * renders «رقم الفيلا» on several real plans — matching what the reader
 * actually produces beats matching correct spelling.
 */
const PLAN_MARKERS = [
  'الدور الأرضي', 'الدور الارضي', 'الدور الأول', 'الدور الاول', 'الدور الثاني', 'الدور الثانى',
  'GROUND FLOOR', 'FIRST FLOOR', 'SECOND FLOOR',
  'رقم الوحدة', 'رقم الفيلا', 'رقم الغيلا', 'رقم الشقة', 'رقم النموذج',
  'مخطط',
];
export function looksLikeUnitPlan(ocrText: string | null | undefined): boolean {
  if (!ocrText) return false;
  const upper = ocrText.toUpperCase();
  return PLAN_MARKERS.some((m) => (m === m.toUpperCase() ? upper.includes(m) : ocrText.includes(m)));
}

/** Storage object keys must be ASCII-safe; the display name lives in files.title. */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
}

export async function runSocialFileJob({ supabase, job }: { supabase: SupabaseClient; job: SocialFileJob }): Promise<Record<string, unknown>> {
  const postId = job.recordId;

  const { data: settings, error: sErr } = await supabase.from('social_file_settings').select('is_enabled, owner_user_id, owner_auth_uid, root_folder_id').eq('id', true).maybeSingle();
  if (sErr) throw new Error(`settings: ${sErr.message}`);
  const cfg = (settings ?? null) as Settings | null;
  if (!cfg?.is_enabled) return { post_id: postId, skipped: 'disabled' };
  if (!cfg.owner_user_id || !cfg.owner_auth_uid) throw new Error('social_file_settings.owner_user_id / owner_auth_uid are not set');

  const { data: post, error: pErr } = await supabase.from('mkt_content_posts').select('id, organization_id, published_at, caption, post_url, platform').eq('id', postId).maybeSingle();
  if (pErr) throw new Error(`post: ${pErr.message}`);
  if (!post) throw new Error(`post ${postId} not found`);

  const { data: enr, error: eErr } = await supabase.from('mkt_content_enrichment').select('primary_project_id, result, status').eq('content_post_id', postId).maybeSingle();
  if (eErr) throw new Error(`enrichment: ${eErr.message}`);
  const projectId = (enr?.primary_project_id as string | null) ?? null;
  if (!projectId || enr?.status !== 'done') return { post_id: postId, skipped: 'no project' };

  const [{ data: org, error: oErr }, { data: proj, error: prErr }, { data: mediaRows, error: mErr }] = await Promise.all([
    supabase.from('mkt_organizations').select('id, name_ar, name_en, developer_record_id').eq('id', post.organization_id as string).maybeSingle(),
    supabase.from('unified_records').select('id, data').eq('id', projectId).eq('model_id', ALL_PROJECTS_MODEL).maybeSingle(),
    supabase.from('mkt_content_media').select('id, carousel_index, media_kind, stored_path, mime_type, bytes, width, height, duration_ms, checksum_sha256, file_id')
      .eq('content_post_id', postId).eq('download_status', 'stored').in('media_kind', ['image', 'video']).order('carousel_index'),
  ]);
  if (oErr) throw new Error(`organization: ${oErr.message}`);
  if (prErr) throw new Error(`project: ${prErr.message}`);
  if (mErr) throw new Error(`media: ${mErr.message}`);
  if (!proj) return { post_id: postId, skipped: 'project record missing' };

  const pdata = (proj.data ?? {}) as Record<string, unknown>;
  const projectName = (typeof pdata.project_name === 'string' && pdata.project_name) || (typeof pdata.project_name_en === 'string' && pdata.project_name_en) || 'مشروع';
  const projectDeveloper = typeof pdata.developer === 'string' ? pdata.developer : null;
  const orgName = (org?.name_ar as string | null) || (org?.name_en as string | null) || 'حساب';
  const isOwnDeveloper = !!org?.developer_record_id && !!projectDeveloper && org.developer_record_id === projectDeveloper;
  const isOurProject = await projectIsOurs(supabase, projectId);
  const sendable = isOurProject || isOwnDeveloper;

  const result = ((enr?.result ?? {}) as Record<string, unknown>);
  const descriptionBits: string[] = [];
  if (typeof result.campaign_message === 'string' && result.campaign_message) descriptionBits.push(result.campaign_message);
  if (Array.isArray(result.selling_points) && result.selling_points.length) descriptionBits.push((result.selling_points as string[]).join('، '));
  if (typeof result.offer === 'string' && result.offer) descriptionBits.push(`عرض: ${result.offer}`);
  const description = [
    `منشور ${orgName} على ${post.platform ?? ''}${post.published_at ? ' بتاريخ ' + String(post.published_at).slice(0, 10) : ''} عن مشروع ${projectName}.`,
    ...descriptionBits,
    post.post_url ? `المصدر: ${post.post_url}` : '',
  ].filter(Boolean).join('\n');

  const folderId = await ensureOrgFolder(supabase, cfg, orgName);

  const pending = ((mediaRows ?? []) as MediaRow[]).filter((m) => !m.file_id && m.stored_path);

  // What the OCR read off each image, so a floor plan posted inside a carousel
  // is filed as one instead of as a designed creative.
  const ocrByMedia = new Map<string, string>();
  if (pending.some((m) => m.media_kind === 'image')) {
    const { data: visual, error: vErr } = await supabase
      .from('mkt_visual_text').select('content_media_id, text').eq('content_post_id', postId);
    if (vErr) console.error(`[social-file] visual text unavailable for ${postId}: ${vErr.message}`);
    for (const v of (visual ?? []) as Array<{ content_media_id: string; text: string | null }>) {
      if (v.content_media_id && v.text) ocrByMedia.set(v.content_media_id, v.text);
    }
  }
  if (pending.length === 0) return { post_id: postId, registered: 0, already: (mediaRows ?? []).length };

  const dateTag = post.published_at ? String(post.published_at).slice(0, 10) : '';
  let registered = 0, reused = 0;
  const failures: string[] = [];

  for (const m of pending) {
    try {
      // identical bytes already registered from another post → reuse that file
      let fileId: string | null = null;
      if (m.checksum_sha256) {
        const { data: dup } = await supabase.from('mkt_content_media').select('file_id').eq('checksum_sha256', m.checksum_sha256).not('file_id', 'is', null).limit(1).maybeSingle();
        if (dup?.file_id) { fileId = dup.file_id as string; reused++; }
      }
      if (!fileId) {
        fileId = await copyAndRegister(supabase, cfg, folderId, m, {
          orgName, projectName, dateTag, index: pending.length > 1 ? m.carousel_index + 1 : 0,
          description, isOwnDeveloper, sendable, projectId,
          isUnitPlan: m.media_kind === 'image' && looksLikeUnitPlan(ocrByMedia.get(m.id)),
        });
        registered++;
      }
      const { error: uErr } = await supabase.from('mkt_content_media').update({ file_id: fileId, file_registered_at: new Date().toISOString() }).eq('id', m.id);
      if (uErr) throw new Error(`media pointer: ${uErr.message}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${m.media_kind}#${m.carousel_index}: ${msg}`);
      console.error(`[social-file] post=${postId} media=${m.id} failed — ${msg}`);
    }
  }

  console.log(`[social-file] post=${postId} project=${projectName} registered=${registered} reused=${reused} failed=${failures.length} rights=${isOwnDeveloper ? 'developer' : 'competitor'}/${sendable ? 'approved' : 'internal_only'}${isOurProject ? ' (our project)' : ''}`);
  if (registered + reused === 0 && failures.length > 0) {
    throw new Error(`all ${failures.length} media failed for post ${postId} — first: ${failures[0]}`);
  }
  return { post_id: postId, project_id: projectId, registered, reused, failed: failures.length, ...(failures.length ? { errors: failures.slice(0, 5) } : {}) };
}

/** True when an our_projects row points at this all_projects record. */
async function projectIsOurs(supabase: SupabaseClient, projectId: string): Promise<boolean> {
  const { data: model, error: mErr } = await supabase.from('models').select('id').eq('name', 'our_projects').maybeSingle();
  if (mErr) throw new Error(`our_projects model: ${mErr.message}`);
  if (!model?.id) return false;
  const { count, error } = await supabase.from('records').select('id', { count: 'exact', head: true }).eq('model_id', model.id).eq('data->>project', projectId);
  if (error) throw new Error(`our_projects lookup: ${error.message}`);
  return (count ?? 0) > 0;
}

/** One subfolder per publishing company under the intake root, created lazily. */
async function ensureOrgFolder(supabase: SupabaseClient, cfg: Settings, orgName: string): Promise<string | null> {
  if (!cfg.root_folder_id) return null;
  const { data: found, error: fErr } = await supabase.from('folders').select('id').eq('parent_folder_id', cfg.root_folder_id).eq('name', orgName).limit(1).maybeSingle();
  if (fErr) throw new Error(`folder lookup: ${fErr.message}`);
  if (found?.id) return found.id as string;
  const { data: made, error: mkErr } = await supabase.from('folders').insert({ parent_folder_id: cfg.root_folder_id, name: orgName, created_by_user_id: cfg.owner_user_id }).select('id').single();
  if (mkErr) {
    // lost a race with a sibling job — read the winner
    const { data: again } = await supabase.from('folders').select('id').eq('parent_folder_id', cfg.root_folder_id).eq('name', orgName).limit(1).maybeSingle();
    if (again?.id) return again.id as string;
    throw new Error(`folder create: ${mkErr.message}`);
  }
  return (made as { id: string }).id;
}

async function copyAndRegister(
  supabase: SupabaseClient, cfg: Settings, folderId: string | null, m: MediaRow,
  ctx: { orgName: string; projectName: string; dateTag: string; index: number; description: string; isOwnDeveloper: boolean; sendable: boolean; projectId: string; isUnitPlan: boolean },
): Promise<string> {
  const fileId = randomUUID();
  const ext = extOf(m.stored_path!, m.mime_type, m.media_kind);
  const mime = mimeFor(ext, m.mime_type, m.media_kind);
  const destPath = `${cfg.owner_auth_uid}/${fileId}.${ext}`;

  const { error: cpErr } = await supabase.storage.from(SOURCE_BUCKET).copy(m.stored_path!, destPath, { destinationBucket: FILES_BUCKET });
  if (cpErr) throw new Error(`storage copy ${m.stored_path} → ${FILES_BUCKET}/${destPath}: ${cpErr.message}`);

  const title = safeName(`${ctx.orgName} — ${ctx.projectName}${ctx.dateTag ? ' — ' + ctx.dateTag : ''}${ctx.index ? ` (${ctx.index})` : ''}`);
  const row = {
    id: fileId,
    folder_id: folderId,
    model_id: null,
    record_id: null,               // NEVER set — see header
    uploaded_by_user_id: cfg.owner_user_id,
    original_name: `${title}.${ext}`,
    title,
    mime_type: mime,
    size_bytes: m.bytes ?? 0,
    storage_bucket: FILES_BUCKET,
    storage_path: destPath,
    kind: m.media_kind,
    origin: 'social_intake',
    file_class: 'business',
    confidentiality: 'internal',
    acquisition_source: ctx.isOwnDeveloper ? 'developer' : 'competitor',
    usage_rights: ctx.sendable ? 'approved' : 'internal_only',
    // NOT raw_*: a competitor's published reel or post image is a FINISHED,
    // published creative — logo, captions, colour grade — not unedited source
    // material. Filing 711 of them under «خام» buried the real raw pool (278
    // photos, 2 videos) under other companies' finished work.
    // asset_nature is deliberately LEFT EMPTY: off-plan marketing is often a
    // CGI render, so asserting 'real' was a guess we had no basis for. The
    // visual-intelligence read can fill it later; an empty field is honest.
    asset_nature: null,
    production_state: 'published',
    primary_category: m.media_kind === 'video' ? 'ready_video' : ctx.isUnitPlan ? 'unit_plan' : 'design',
    description: ctx.description,
    ai_description: ctx.description,
    checksum_sha256: m.checksum_sha256,
    width_px: m.width,
    height_px: m.height,
    duration_seconds: m.duration_ms != null ? Math.round(m.duration_ms / 100) / 10 : null,
    tags: ['social_intake', ctx.isOwnDeveloper ? 'developer_content' : 'competitor_content'],
  };
  const { error: insErr } = await supabase.from('files').insert(row);
  if (insErr) {
    await supabase.storage.from(FILES_BUCKET).remove([destPath]).catch((e: unknown) => console.error(`[social-file] orphan cleanup failed ${destPath}: ${(e as Error).message}`));
    throw new Error(`files insert: ${insErr.message}`);
  }
  return fileId;
}
