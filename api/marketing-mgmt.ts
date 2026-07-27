/**
 * POST /api/marketing-mgmt
 *
 * Internal Marketing Management (إدارة التسويق) — the execution side.
 * Distinct from /api/marketing, which serves external competitor intelligence
 * (ذكاء التسويق). One action-dispatch endpoint so the SPA makes a single
 * authenticated call per screen.
 *
 * AUTH POSTURE — deliberately different from /api/marketing.
 * Every call runs on the CALLER'S JWT, never service-role. The 22 mkt_mgmt
 * tables carry RLS policies driven by `wassell_mkt_can(capability)`, so the
 * database is the authorization boundary: a writer physically cannot approve, a
 * reviewer physically cannot publish, a viewer physically cannot write — even if
 * they call this endpoint directly with a hand-made request. Hiding buttons is
 * not access control; this endpoint does not pretend otherwise, and there is no
 * service-role escape hatch in it.
 *
 * Actions
 *   overview            → KPIs + operational queues + alerts (one round trip)
 *   generate_alerts     → run the deterministic alert rules
 *   campaign_list       → campaigns with rollups
 *   campaign_detail     → one campaign + content + tasks + performance
 *   campaign_save       → create/update a campaign
 *   content_list        → filtered content items (table/board/calendar feed)
 *   content_detail      → one item + versions + tasks + approvals + publications
 *   content_create      → create content (+ auto-generate its task checklist)
 *   content_update      → patch fields
 *   content_transition  → move status (DB rejects invalid jumps)
 *   version_create      → add a version (approved ones become immutable)
 *   approval_decide     → approve / request changes / reject
 *   task_update         → status, assignee, due date
 *   scene_save/slide_save/scene_reorder/slide_reorder
 *   asset_list/asset_save/asset_link
 *   publication_save    → schedule / mark published (manual workflow)
 *   performance_record  → append a snapshot (never overwrites)
 *   attribution_record  → link CRM outcome to campaign/content/publication
 *   intelligence_action → create content/campaign from an external insight
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';

export const config = { runtime: 'edge' };

interface Body {
  action?: string;
  id?: string;
  campaign_id?: string;
  content_item_id?: string;
  project_id?: string;
  limit?: number;
  patch?: Record<string, unknown>;
  // content_create
  title?: string;
  content_type?: string;
  // transitions
  to_status?: string;
  reason?: string;
  // versions / approvals
  version_type?: string;
  payload?: Record<string, unknown>;
  change_summary?: string;
  file_id?: string;
  approval_id?: string;
  decision?: 'approved' | 'changes_requested' | 'rejected' | 'cancelled';
  stage?: string;
  comment?: string;
  requested_changes?: string;
  target_type?: string;
  target_id?: string;
  // tasks / scenes / slides
  task_id?: string;
  scene_id?: string;
  slide_id?: string;
  order?: string[];
  // assets
  asset_id?: string;
  // publications / performance
  publication_id?: string;
  metrics?: Record<string, unknown>;
  collection_status?: string;
  // filters
  status?: string;
  platform?: string;
  owner_user_id?: string;
  q?: string;
  // intelligence
  source_type?: string;
  source_id?: string;
  action_type?: string;
}

function callerClient(req: Request): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('supabase env missing');
  const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
  return createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

/** public.users.id for the caller. AuthenticatedUser.userId is the AUTH uid;
 *  every FK in this module points at public.users, and the two are different
 *  ids in this schema — writing the auth uid into a user FK would silently
 *  create rows attributed to nobody. */
async function resolveAppUserId(sb: SupabaseClient, authUid: string): Promise<string | null> {
  const { data } = await sb.rpc('wassell_app_user_id', { auth_user_id: authUid });
  return (data as string | null) ?? null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const cap = (n: unknown, def: number, max: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : def;

/** RLS returns an empty result rather than an error when a capability is
 *  missing, which would read as "no data" instead of "not allowed". Translate
 *  PostgREST's RLS rejection into an honest 403. */
function rlsAware(error: { message: string; code?: string } | null): Response | null {
  if (!error) return null;
  const m = error.message ?? '';
  if (error.code === '42501' || /row-level security|permission denied/i.test(m)) {
    return jsonError(403, 'your marketing role does not permit this action');
  }
  if (error.code === '23514' || /check_violation|violates check constraint/i.test(m)) {
    return jsonError(409, m);   // invalid status jump, locked version, etc.
  }
  if (error.code === '23503') return jsonError(409, 'referenced record is missing or still in use');
  return jsonError(500, m || 'database error');
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'method not allowed');
  return withAuth(req, async (user) => {
    const body = (await req.json().catch(() => ({}))) as Body;
    const action = body.action ?? '';
    let sb: SupabaseClient;
    try { sb = callerClient(req); } catch { return jsonError(500, 'supabase env missing'); }
    const appUserId = await resolveAppUserId(sb, user.userId);

    switch (action) {
      // ── Overview ─────────────────────────────────────────────────────────
      case 'overview': {
        const { data, error } = await sb.rpc('mkt_mgmt_overview', { p_limit: cap(body.limit, 12, 50) });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ overview: data });
      }
      case 'generate_alerts': {
        const { data, error } = await sb.rpc('mkt_mgmt_generate_alerts');
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ rules: data });
      }

      // ── Campaigns ────────────────────────────────────────────────────────
      case 'campaign_list': {
        const { data, error } = await sb
          .from('mkt_internal_campaigns')
          .select('*, mkt_internal_campaign_projects(project_id), mkt_content_items(id,status)')
          .is('archived_at', null)
          .order('created_at', { ascending: false })
          .limit(cap(body.limit, 100, 500));
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ campaigns: data ?? [] });
      }
      case 'campaign_detail': {
        const id = str(body.id ?? body.campaign_id);
        if (!id) return jsonError(400, 'id required');
        const [c, items, tasks, perf] = await Promise.all([
          sb.from('mkt_internal_campaigns').select('*, mkt_internal_campaign_projects(project_id), mkt_internal_campaign_members(user_id,role_in_campaign)').eq('id', id).maybeSingle(),
          sb.from('mkt_content_items').select('id,content_number,title,content_type,status,due_date,owner_user_id').eq('campaign_id', id).is('archived_at', null),
          sb.from('mkt_content_tasks').select('id,title,status,due_date,assigned_user_id,content_item_id').eq('campaign_id', id),
          sb.from('mkt_performance_snapshots').select('*').eq('campaign_id', id).order('captured_at', { ascending: false }).limit(200),
        ]);
        const bad = rlsAware(c.error ?? items.error ?? tasks.error ?? perf.error); if (bad) return bad;
        if (!c.data) return jsonError(404, 'campaign not found');
        return jsonOk({ campaign: c.data, content: items.data ?? [], tasks: tasks.data ?? [], performance: perf.data ?? [] });
      }
      case 'campaign_save': {
        const patch = body.patch ?? {};
        const id = str(body.id);
        const q = id
          ? sb.from('mkt_internal_campaigns').update(patch).eq('id', id).select().maybeSingle()
          : sb.from('mkt_internal_campaigns').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ campaign: data });
      }

      // ── Content ──────────────────────────────────────────────────────────
      case 'content_list': {
        let q = sb.from('mkt_content_items')
          .select('*, mkt_content_platforms(platform)')
          .is('archived_at', null);
        if (str(body.status))        q = q.eq('status', body.status!);
        if (str(body.campaign_id))   q = q.eq('campaign_id', body.campaign_id!);
        if (str(body.project_id))    q = q.eq('project_id', body.project_id!);
        if (str(body.owner_user_id)) q = q.eq('owner_user_id', body.owner_user_id!);
        if (str(body.q))             q = q.ilike('title', `%${body.q}%`);
        const { data, error } = await q.order('due_date', { ascending: true, nullsFirst: false })
                                       .limit(cap(body.limit, 200, 500));
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ content: data ?? [] });
      }
      case 'content_detail': {
        const id = str(body.id ?? body.content_item_id);
        if (!id) return jsonError(400, 'id required');
        const [item, versions, tasks, approvals, pubs, history, scenes, slides, video, post, links] = await Promise.all([
          sb.from('mkt_content_items').select('*, mkt_content_platforms(platform)').eq('id', id).maybeSingle(),
          sb.from('mkt_content_versions').select('*').eq('content_item_id', id).order('version_type').order('version_number', { ascending: false }),
          sb.from('mkt_content_tasks').select('*').eq('content_item_id', id).order('sort_order'),
          sb.from('mkt_approvals').select('*').eq('target_id', id).order('created_at', { ascending: false }),
          sb.from('mkt_publications').select('*').eq('content_item_id', id).order('scheduled_for', { nullsFirst: false }),
          sb.from('mkt_content_status_history').select('*').eq('content_item_id', id).order('changed_at', { ascending: false }),
          sb.from('mkt_video_scenes').select('*').eq('content_item_id', id).order('scene_number'),
          sb.from('mkt_carousel_slides').select('*').eq('content_item_id', id).order('slide_number'),
          sb.from('mkt_video_details').select('*').eq('content_item_id', id).maybeSingle(),
          sb.from('mkt_post_details').select('*').eq('content_item_id', id).maybeSingle(),
          sb.from('mkt_asset_links').select('asset_id, mkt_raw_assets(*)').eq('target_type', 'content_item').eq('target_id', id),
        ]);
        const bad = rlsAware(item.error); if (bad) return bad;
        if (!item.data) return jsonError(404, 'content item not found');
        return jsonOk({
          item: item.data, versions: versions.data ?? [], tasks: tasks.data ?? [],
          approvals: approvals.data ?? [], publications: pubs.data ?? [], history: history.data ?? [],
          scenes: scenes.data ?? [], slides: slides.data ?? [],
          video: video.data ?? null, post: post.data ?? null, assets: links.data ?? [],
        });
      }
      case 'content_create': {
        const title = str(body.title); const ctype = str(body.content_type);
        if (!title || !ctype) return jsonError(400, 'title + content_type required');
        const { data, error } = await sb.from('mkt_content_items')
          .insert({ ...(body.patch ?? {}), title, content_type: ctype, created_by_user_id: appUserId })
          .select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        // production checklist: idempotent, returns 0 if one already exists
        const { data: nTasks } = await sb.rpc('mkt_generate_content_tasks', { p_content_item_id: data!.id });
        return jsonOk({ item: data, tasks_generated: nTasks ?? 0 });
      }
      case 'content_update': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const patch = { ...(body.patch ?? {}) };
        delete (patch as Record<string, unknown>).status;   // status only via content_transition
        const { data, error } = await sb.from('mkt_content_items').update(patch).eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ item: data });
      }
      case 'content_transition': {
        const id = str(body.id); const to = str(body.to_status);
        if (!id || !to) return jsonError(400, 'id + to_status required');
        const { data, error } = await sb.from('mkt_content_items')
          .update({ status: to }).eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;   // 409 on an invalid jump
        return jsonOk({ item: data });
      }

      // ── Cross-item queues (Calendar / Publishing / Approvals / Performance)
      // These exist because those screens are NOT per-item: a calendar that can
      // only read one content item at a time is a mock, not a calendar.
      case 'publication_list': {
        let q = sb.from('mkt_publications')
          .select('*, mkt_content_items(id,content_number,title,content_type,status)');
        if (str(body.status))      q = q.eq('status', body.status!);
        if (str(body.platform))    q = q.eq('platform', body.platform!);
        if (str(body.campaign_id)) q = q.eq('campaign_id', body.campaign_id!);
        const { data, error } = await q
          .order('scheduled_for', { ascending: true, nullsFirst: false })
          .limit(cap(body.limit, 300, 1000));
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ publications: data ?? [] });
      }
      case 'approval_list': {
        let q = sb.from('mkt_approvals').select('*');
        if (str(body.status)) q = q.eq('decision', body.status!);
        const { data, error } = await q.order('created_at', { ascending: false }).limit(cap(body.limit, 200, 500));
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ approvals: data ?? [] });
      }
      case 'performance_list': {
        let q = sb.from('mkt_performance_snapshots').select('*');
        if (str(body.publication_id)) q = q.eq('publication_id', body.publication_id!);
        if (str(body.campaign_id))    q = q.eq('campaign_id', body.campaign_id!);
        const { data, error } = await q.order('captured_at', { ascending: false }).limit(cap(body.limit, 300, 1000));
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ snapshots: data ?? [] });
      }

      // ── Versions & approvals ─────────────────────────────────────────────
      case 'version_create': {
        const id = str(body.content_item_id); const vtype = str(body.version_type);
        if (!id || !vtype) return jsonError(400, 'content_item_id + version_type required');
        const { data: prev } = await sb.from('mkt_content_versions')
          .select('version_number').eq('content_item_id', id).eq('version_type', vtype)
          .order('version_number', { ascending: false }).limit(1);
        const next = (prev?.[0]?.version_number ?? 0) + 1;
        const { data, error } = await sb.from('mkt_content_versions').insert({
          content_item_id: id, version_type: vtype, version_number: next,
          payload: body.payload ?? {}, file_id: str(body.file_id) ?? null,
          change_summary: str(body.change_summary) ?? null, created_by_user_id: appUserId,
        }).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ version: data });
      }
      case 'approval_decide': {
        const decision = body.decision;
        if (!decision) return jsonError(400, 'decision required');
        const existing = str(body.approval_id);
        if (existing) {
          const { data, error } = await sb.from('mkt_approvals')
            .update({ decision, comment: str(body.comment) ?? null,
                      requested_changes: str(body.requested_changes) ?? null,
                      reviewer_user_id: appUserId, decided_at: new Date().toISOString() })
            .eq('id', existing).select().maybeSingle();
          const bad = rlsAware(error); if (bad) return bad;
          return jsonOk({ approval: data });
        }
        const tType = str(body.target_type) ?? 'content_item';
        const tId = str(body.target_id); const stage = str(body.stage);
        if (!tId || !stage) return jsonError(400, 'target_id + stage required');
        const { data, error } = await sb.from('mkt_approvals').insert({
          target_type: tType, target_id: tId, stage, decision,
          version_id: str(body.id) ?? null, reviewer_user_id: appUserId,
          comment: str(body.comment) ?? null, requested_changes: str(body.requested_changes) ?? null,
          decided_at: decision === 'pending' ? null : new Date().toISOString(),
        }).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        // approving a version locks it (DB trigger enforces immutability)
        if (decision === 'approved' && str(body.id)) {
          await sb.from('mkt_content_versions')
            .update({ approval_state: 'approved', approved_by_user_id: appUserId })
            .eq('id', body.id!);
        }
        return jsonOk({ approval: data });
      }

      // ── Tasks / scenes / slides ──────────────────────────────────────────
      case 'task_update': {
        const id = str(body.task_id ?? body.id); if (!id) return jsonError(400, 'task_id required');
        const { data, error } = await sb.from('mkt_content_tasks').update(body.patch ?? {}).eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;   // 409 if a dependency is unfinished
        return jsonOk({ task: data });
      }
      case 'scene_save': case 'slide_save': {
        const table = action === 'scene_save' ? 'mkt_video_scenes' : 'mkt_carousel_slides';
        const id = str(body.id);
        const q = id ? sb.from(table).update(body.patch ?? {}).eq('id', id).select().maybeSingle()
                     : sb.from(table).insert(body.patch ?? {}).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ row: data });
      }
      case 'scene_reorder': case 'slide_reorder': {
        const table = action === 'scene_reorder' ? 'mkt_video_scenes' : 'mkt_carousel_slides';
        const col = action === 'scene_reorder' ? 'scene_number' : 'slide_number';
        const ids = Array.isArray(body.order) ? body.order : [];
        if (ids.length === 0) return jsonError(400, 'order[] required');
        // two-pass: park into a negative range first so the per-item unique
        // ordering never collides mid-reorder
        for (let i = 0; i < ids.length; i++) {
          const { error } = await sb.from(table).update({ [col]: -(i + 1) }).eq('id', ids[i]!);
          const bad = rlsAware(error); if (bad) return bad;
        }
        for (let i = 0; i < ids.length; i++) {
          const { error } = await sb.from(table).update({ [col]: i + 1 }).eq('id', ids[i]!);
          const bad = rlsAware(error); if (bad) return bad;
        }
        return jsonOk({ reordered: ids.length });
      }

      // ── Assets ───────────────────────────────────────────────────────────
      case 'asset_list': {
        let q = sb.from('mkt_raw_assets').select('*').is('archived_at', null);
        if (str(body.project_id)) q = q.eq('project_id', body.project_id!);
        if (str(body.q)) q = q.or(`asset_name.ilike.%${body.q}%,transcript.ilike.%${body.q}%,ocr_text.ilike.%${body.q}%,ai_description.ilike.%${body.q}%`);
        const { data, error } = await q.order('created_at', { ascending: false }).limit(cap(body.limit, 100, 500));
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ assets: data ?? [] });
      }
      case 'asset_save': {
        const id = str(body.id);
        const q = id ? sb.from('mkt_raw_assets').update(body.patch ?? {}).eq('id', id).select().maybeSingle()
                     : sb.from('mkt_raw_assets').insert({ ...(body.patch ?? {}), uploaded_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ asset: data });
      }
      case 'asset_link': {
        const aId = str(body.asset_id); const tType = str(body.target_type); const tId = str(body.target_id);
        if (!aId || !tType || !tId) return jsonError(400, 'asset_id + target_type + target_id required');
        const { data, error } = await sb.from('mkt_asset_links')
          .upsert({ asset_id: aId, target_type: tType, target_id: tId, created_by_user_id: appUserId },
                  { onConflict: 'asset_id,target_type,target_id' })
          .select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ link: data });
      }

      // ── Publishing / performance / attribution ───────────────────────────
      case 'publication_save': {
        const id = str(body.id);
        const patch = { ...(body.patch ?? {}) } as Record<string, unknown>;
        if (patch.status === 'published' && !patch.published_at) {
          patch.published_at = new Date().toISOString();
          patch.published_by_user_id = appUserId;
        }
        const q = id ? sb.from('mkt_publications').update(patch).eq('id', id).select().maybeSingle()
                     : sb.from('mkt_publications').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ publication: data });
      }
      case 'performance_record': {
        const pubId = str(body.publication_id); const campId = str(body.campaign_id);
        if (!pubId && !campId) return jsonError(400, 'publication_id or campaign_id required');
        // APPEND — snapshots are never updated in place
        const { data, error } = await sb.from('mkt_performance_snapshots').insert({
          publication_id: pubId ?? null, campaign_id: campId ?? null,
          platform: str(body.platform) ?? null,
          metrics: body.metrics ?? {},
          collection_status: str(body.collection_status) ?? 'collected',
          source: 'manual', created_by_user_id: appUserId,
        }).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ snapshot: data });
      }
      case 'attribution_record': {
        const { data, error } = await sb.from('mkt_lead_attributions')
          .insert({ ...(body.patch ?? {}), created_by_user_id: appUserId }).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ attribution: data });
      }

      // ── Intelligence → execution ─────────────────────────────────────────
      case 'intelligence_action': {
        const sType = str(body.source_type); const sId = str(body.source_id); const aType = str(body.action_type);
        if (!sType || !sId || !aType) return jsonError(400, 'source_type + source_id + action_type required');
        let contentId: string | null = null; let tasks = 0;
        if (aType === 'create_content') {
          const title = str(body.title) ?? 'محتوى من رؤية سوقية';
          const { data: item, error } = await sb.from('mkt_content_items').insert({
            ...(body.patch ?? {}), title, content_type: str(body.content_type) ?? 'static_image',
            source_insight_id: sType === 'insight' ? sId : null,
            source_post_id:    sType === 'content_post' ? sId : null,
            source_ad_id:      sType === 'paid_ad' ? sId : null,
            created_by_user_id: appUserId,
          }).select().maybeSingle();
          const bad = rlsAware(error); if (bad) return bad;
          contentId = item!.id as string;
          const { data: n } = await sb.rpc('mkt_generate_content_tasks', { p_content_item_id: contentId });
          tasks = (n as number) ?? 0;
        }
        const { data, error } = await sb.from('mkt_intelligence_actions').insert({
          source_type: sType, source_id: sId, action_type: aType,
          content_item_id: contentId, campaign_id: str(body.campaign_id) ?? null,
          note: str(body.comment) ?? null, created_by_user_id: appUserId,
        }).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ action: data, content_item_id: contentId, tasks_generated: tasks });
      }
      case 'intelligence_responses': {
        const sId = str(body.source_id);
        if (!sId) return jsonError(400, 'source_id required');
        const { data, error } = await sb.from('mkt_intelligence_actions')
          .select('*, mkt_content_items(id,content_number,title,status,mkt_publications(id,platform,status,published_url))')
          .eq('source_id', sId).order('created_at', { ascending: false });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ responses: data ?? [] });
      }

      default:
        return jsonError(400, `unknown action: ${action}`);
    }
  });
}
