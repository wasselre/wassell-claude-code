/**
 * GET / POST /api/cron/build-project-templates — the auto-picker MAINTAINS the
 * saved WhatsApp template for every one of our projects, once a day.
 *
 * A project's chat_templates row is what the bot AND reps actually send (its
 * `project_image_file_ids` gallery + `videos` + `body_ar`/`body_en`). Instead of
 * a rep hand-building each one, this fills them from the deterministic picker:
 *   • photos  — the sendable images (designs / floor plans / competitor social /
 *               rights-restricted already excluded by buildPickerItems), ranked
 *               hero_image → raw_photo, top 3.
 *   • video   — the LONGEST video that is NOT competitor-origin (a rival's video
 *               carries their branding/CTA — same reason designs are barred).
 *   • body    — the deterministic project message (available-price facts).
 *
 * MANUAL PROTECTION (operator, 2026-09-27): a template a rep has edited is marked
 * `media_source: 'manual'` and is NEVER touched here. Only `auto` (or unmarked)
 * templates are (re)built. ONE template per project — extra duplicates are
 * removed, keeping the newest as canonical.
 *
 * DRY-RUN BY DEFAULT. A bare call (or `?dryRun=1`) computes and REPORTS what it
 * would write, touching nothing. The daily Vercel cron calls it with
 * `?dryRun=0` to actually write. `?projectId=` / `?limit=` scope a test run.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` or `?secret=` — same posture as the
 * other crons here. This does NOT send anything to a customer; it only keeps the
 * templates ready. Whether the bot sends media is a separate flag.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { generateProjectMessage } from '../_lib/projectMessageAi.js';
import { buildPickerItems, isUnitPlanFile } from '../../src/pages/Chats/lib/projectFilePicker.js';

export const config = { runtime: 'nodejs', maxDuration: 300 };

const FILE_COLS =
  'id, kind, title, original_name, document_type, primary_category, origin, usage_rights, acquisition_source, duration_seconds, width_px, height_px, size_bytes';
const PHOTO_COUNT = 3;
// A real project photo is never this small. The developer-site imports also
// scraped amenity ICONS («حضانة أطفال», «مقهى», «أندية رياضية» — 356×112 SVGs
// saved as .jpg, 6–15 KB) tagged raw_photo; with no size check they tied with
// the 1920px renders and were sent to a customer as صفا 78's photos (2026-09-29).
// 300px: every icon measured was 112px tall; real photos in live templates go
// down to 480×360 (صفا 102) and 540×413 (الماجدية 174), which must stay.
const MIN_PHOTO_SIDE_PX = 300;
const MIN_PHOTO_BYTES = 40_000;
// The body is written by the SAME AI rewrite a rep triggers (generateProjectMessage,
// Kimi ~40s each), NOT the deterministic sheet. Vercel caps a request at 300s, so
// only this many bodies are (re)generated per run — missing/stale ones first; the
// rest wait for the next daily run. Media refreshes for EVERY project every run.
const BODY_BUDGET_PER_RUN = 5;

interface FileRow {
  id: string;
  kind: string;
  title: string | null;
  original_name: string | null;
  document_type: string | null;
  primary_category: string | null;
  origin: string | null;
  usage_rights: string | null;
  acquisition_source: string | null;
  duration_seconds: number | null;
  width_px: number | null;
  height_px: number | null;
  size_bytes: number | null;
}

/** Too small to be a project photo (an icon / logo / thumbnail). Unknown
 *  dimensions fall back to the byte size; both unknown → kept. */
export function isTooSmallForPhoto(f: Pick<FileRow, 'width_px' | 'height_px' | 'size_bytes'>): boolean {
  if (f.width_px != null && f.height_px != null) return Math.min(f.width_px, f.height_px) < MIN_PHOTO_SIDE_PX;
  return f.size_bytes != null && f.size_bytes < MIN_PHOTO_BYTES;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json' } });
}

/** hero_image before raw_photo before anything else (designs are already gone). */
function photoRank(cat: string | null): number {
  if (cat === 'hero_image') return 0;
  if (cat === 'raw_photo') return 1;
  return 2;
}

interface Selection { imageIds: string[]; videoId: string | null; videoLen: number | null }

// The picker's field types (BusinessFileRow) are stricter about null than our
// lean query result; the fields we pass are compatible, so cast at the boundary.
type PickerFile = Parameters<typeof buildPickerItems>[0][number]['file'];
type UnitPlanArg = Parameters<typeof isUnitPlanFile>[0];

/** Compute the picker selection for one project from its linked files. */
function selectMedia(files: FileRow[]): Selection {
  const rows = files.filter((f) => !isUnitPlanFile(f as unknown as UnitPlanArg));
  // buildPickerItems applies designs/rights/social-image/floor-plan exclusions.
  const picker = buildPickerItems(rows.map((f) => ({ file: f as unknown as PickerFile })), []);
  const sendable = new Set(picker.map((it) => it.ref));
  const byId = new Map(rows.map((f) => [f.id, f]));

  // Real photos ONLY (hero_image + raw_photo) — NOT ai_content, brochure-as-image
  // etc. Matches the "3 best real photos" intent; designs are already excluded.
  // Within a category the sharpest (largest) image wins — never storage order.
  const area = (f: FileRow) => (f.width_px ?? 0) * (f.height_px ?? 0);
  const imageIds = rows
    .filter((f) => f.kind === 'image' && sendable.has(f.id)
      && (f.primary_category === 'hero_image' || f.primary_category === 'raw_photo')
      && !isTooSmallForPhoto(f))
    .sort((a, b) => photoRank(a.primary_category) - photoRank(b.primary_category)
      || area(b) - area(a) || (b.size_bytes ?? 0) - (a.size_bytes ?? 0))
    .slice(0, PHOTO_COUNT)
    .map((f) => f.id);

  // Video: ONE per project — the LONGEST sendable video, ANY origin (competitor
  // videos ARE allowed; operator 2026-09-27). Only the rights guard (isSendable,
  // via buildPickerItems) still applies.
  const videos = rows
    .filter((f) => f.kind === 'video' && sendable.has(f.id)
      && typeof f.duration_seconds === 'number' && f.duration_seconds > 0)
    .sort((a, b) => (b.duration_seconds ?? 0) - (a.duration_seconds ?? 0));
  const video = videos[0] ?? null;
  void byId;
  return { imageIds, videoId: video?.id ?? null, videoLen: video?.duration_seconds ?? null };
}

/**
 * Vercel's NODE runtime calls a default export with (IncomingMessage,
 * ServerResponse), not a web Request — `req.url` there is a bare path, so the
 * old `handler(req: Request)` threw `Invalid URL` on EVERY call: the daily
 * cron never ran once from 2026-09-27 to 2026-09-29. Adapt at the edge (same
 * shape as chat-auto-read) and keep the body as a Request→Response function.
 */
export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  // The cron takes no body — GET and POST are read the same way.
  const req = new Request(new URL(nodeReq.url ?? '/', `https://${host}`).toString(), { method: 'GET', headers });
  const res = await run(req);
  nodeRes.statusCode = res.status;
  res.headers.forEach((v, k) => nodeRes.setHeader(k, v));
  nodeRes.end(await res.text());
}

async function run(req: Request): Promise<Response> {
  const startedAt = Date.now();
  const expected = process.env.CRON_SECRET;
  if (!expected) return json({ error: 'CRON_SECRET is not set; refusing to run' }, 500);
  const url = new URL(req.url);
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const sent = bearer || url.searchParams.get('secret') || '';
  if (sent !== expected) return json({ error: 'unauthorized' }, 401);

  // Writes by default (the daily cron's job); ?dryRun=1 previews without writing.
  // The build is idempotent (rebuilds the same auto templates, skips manual), so
  // a repeat write run is harmless.
  const dryRunParam = (url.searchParams.get('dryRun') ?? '0').toLowerCase();
  const dryRun = dryRunParam === '1' || dryRunParam === 'true';
  const onlyProject = url.searchParams.get('projectId') || null;
  const limit = Number(url.searchParams.get('limit') ?? '0') || 0;

  const svc = getServiceSupabase();

  const [{ data: apModel }, { data: opModel }, { data: ctModel }] = await Promise.all([
    svc.from('models').select('id').eq('name', 'all_projects').maybeSingle(),
    svc.from('models').select('id').eq('name', 'our_projects').maybeSingle(),
    svc.from('models').select('id').eq('name', 'chat_templates').maybeSingle(),
  ]);
  const apId = apModel?.id as string | undefined;
  const opId = opModel?.id as string | undefined;
  const ctId = ctModel?.id as string | undefined;
  if (!apId || !opId || !ctId) return json({ error: 'missing models' }, 500);

  // Our projects = distinct all_projects id referenced by an our_projects row.
  const { data: opRows, error: opErr } = await svc.from('records').select('data').eq('model_id', opId);
  if (opErr) return json({ error: `our_projects load: ${opErr.message}` }, 500);
  let projectIds = [...new Set((opRows ?? [])
    .map((r) => (r.data as Record<string, unknown>)?.project)
    .filter((p): p is string => typeof p === 'string' && p.length > 0))];
  if (onlyProject) projectIds = projectIds.filter((p) => p === onlyProject);
  if (limit > 0) projectIds = projectIds.slice(0, limit);

  const report: Array<Record<string, unknown>> = [];
  const stats = { projects: projectIds.length, built: 0, created: 0, updated: 0, skipped_manual: 0, deduped: 0, no_media: 0, body_generated: 0, body_pending: 0, errors: 0 };
  let bodyBudget = BODY_BUDGET_PER_RUN;

  for (const projectId of projectIds) {
    try {
      // Linked files for this project.
      const { data: links } = await svc.from('file_links').select('file_id').eq('model_id', apId).eq('record_id', projectId);
      const fileIds = [...new Set((links ?? []).map((l) => (l as { file_id: string }).file_id))];
      let files: FileRow[] = [];
      if (fileIds.length) {
        const { data: fr } = await svc.from('files').select(FILE_COLS).eq('status', 'active').in('id', fileIds);
        files = (fr ?? []) as FileRow[];
      }
      const sel = selectMedia(files);

      // Existing templates for this project (newest first).
      const { data: tplRows } = await svc.from('records').select('id, data, created_at')
        .eq('model_id', ctId).eq('data->>project_id', projectId).order('created_at', { ascending: false });
      const tpls = (tplRows ?? []) as Array<{ id: string; data: Record<string, unknown>; created_at: string }>;
      const newest = tpls[0] ?? null;
      const dups = tpls.slice(1);

      if (newest && newest.data?.media_source === 'manual') {
        stats.skipped_manual++;
        report.push({ projectId, action: 'skip_manual', images: sel.imageIds.length, video: sel.videoId, dups: dups.length });
        continue;
      }
      if (sel.imageIds.length === 0 && !sel.videoId) stats.no_media++;

      // Project record → name + a signature of the numbers the message quotes, so
      // the AI body is (re)written only when it's missing or those numbers moved.
      const { data: apRec } = await svc.from('records').select('data').eq('id', projectId).maybeSingle();
      const pdata = (apRec?.data ?? {}) as Record<string, unknown>;
      const projName = typeof pdata.project_name === 'string' ? pdata.project_name : '';
      const factsSig = JSON.stringify([
        pdata.available_price_range, pdata.available_area_range, pdata.unit_count,
        pdata.available_units, pdata.bedroom_range, pdata.bathroom_range,
      ]);

      const existingAr = typeof newest?.data?.body_ar === 'string' ? (newest.data.body_ar as string) : '';
      const existingEn = typeof newest?.data?.body_en === 'string' ? (newest.data.body_en as string) : '';
      const bodyIsAi = newest?.data?.body_source === 'ai';
      // Needs a body write when: none yet, never AI-written, or the numbers changed.
      const bodyStale = (!existingAr && !existingEn) || !bodyIsAi || newest?.data?.facts_sig !== factsSig;

      let bodyAr = existingAr;
      let bodyEn = existingEn;
      let bodySource: string | undefined = bodyIsAi ? 'ai' : (newest?.data?.body_source as string | undefined);
      let generatedBy: string | undefined;

      if (bodyStale && !dryRun && bodyBudget > 0) {
        bodyBudget--;
        // fact-check (keep the rep-quality wording, fix numbers) once a body exists
        // and was AI-written; otherwise generate fresh — same call the rep triggers.
        const factcheck = bodyIsAi && (existingAr || existingEn);
        const r = await generateProjectMessage(svc, svc, {
          projectId,
          ...(factcheck ? { existingAr, existingEn } : {}),
        });
        if (r.ok) {
          bodyAr = r.body_ar; bodyEn = r.body_en; bodySource = 'ai'; generatedBy = r.generated_by;
          stats.body_generated++;
        } else {
          console.error(`[build-templates] AI body project=${projectId} failed (${r.status}): ${r.error}`);
        }
      } else if (bodyStale) {
        stats.body_pending++; // over budget this run, or dry-run — next run picks it up
      }

      const canonicalId = newest?.id ?? crypto.randomUUID();
      const action = newest ? 'update' : 'create';
      const data: Record<string, unknown> = {
        ...(newest?.data ?? {
          name: projName ? `${projName} — تلقائي` : 'قالب المشروع',
          language: 'both',
          category: 'project',
        }),
        project_id: projectId,
        project_image_file_ids: sel.imageIds,
        videos: sel.videoId ? [sel.videoId] : [],
        body_ar: bodyAr,
        body_en: bodyEn,
        ...(bodySource ? { body_source: bodySource } : {}),
        facts_sig: factsSig,
        ...(generatedBy ? { body_generated_by: generatedBy } : {}),
        media_source: 'auto',
      };

      if (!dryRun) {
        const { error: saveErr } = await svc.rpc('record_save', {
          p_model_id: ctId, p_id: canonicalId, p_data: data, p_expected_version: null,
        });
        if (saveErr) throw new Error(`record_save: ${saveErr.message}`);
        for (const d of dups) {
          const { error: delErr } = await svc.rpc('record_delete', { p_model_id: ctId, p_id: d.id });
          if (delErr) console.error(`[build-templates] dedup delete ${d.id} failed: ${delErr.message}`);
          else stats.deduped++;
        }
      } else if (dups.length) {
        stats.deduped += dups.length;
      }

      stats.built++;
      if (action === 'create') stats.created++; else stats.updated++;
      report.push({ projectId, projName, action, images: sel.imageIds.length, video: sel.videoId, videoLen: sel.videoLen, hasBody: !!bodyAr, dups: dups.length });
    } catch (err) {
      stats.errors++;
      report.push({ projectId, error: err instanceof Error ? err.message : String(err) });
      console.error(`[build-templates] project=${projectId} failed:`, err);
    }
  }

  return json({ dryRun, ms: Date.now() - startedAt, stats, report }, 200);
}
