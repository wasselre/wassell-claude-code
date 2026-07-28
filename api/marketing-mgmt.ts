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

/** Columns a user may edit on a content item. See content_update for why. */
const CONTENT_EDITABLE = [
  'title', 'content_type', 'priority', 'purpose', 'project_id', 'campaign_id',
  'owner_user_id', 'writer_user_id', 'designer_user_id', 'editor_user_id',
  'presenter_user_id', 'photographer_user_id',
  'due_date', 'planned_publish_at', 'language', 'target_audience', 'content_pillar',
  'hook', 'main_idea', 'cta', 'caption', 'hashtags', 'reference_links',
  'production_notes', 'archived_at',
  // 2026-08-21 marketing fields
  'organic_or_paid', 'funnel_stage', 'content_angle', 'offer_message',
  'cta_destination', 'tracking_link', 'next_action', 'blocker', 'final_asset_id',
  // v2 strategic context. origin_* is settable because a draft may be
  // reclassified; the DB CHECK keeps kind and FK in agreement, and reuse goes
  // through mkt_content_usage rather than rewriting these.
  'plan_id', 'primary_goal_id', 'primary_pillar_id', 'strategic_purpose',
  'origin_kind', 'origin_program_id', 'origin_campaign_id', 'reactive_trigger',
] as const;

/** Copy only allow-listed keys. Everything the v2 layer writes goes through
 *  this, so ids, generated numbers, approval stamps and needs_classification
 *  can never be set by a caller. */
function pick(src: unknown, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!src || typeof src !== 'object') return out;
  const o = src as Record<string, unknown>;
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  return out;
}

// status is NOT here: it moves via strategy_approve, which also supersedes the
// incumbent. approver_user_id / approved_at are stamped server-side.
const STRATEGY_EDITABLE = [
  'name_ar', 'name_en', 'summary_ar', 'summary_en', 'effective_date', 'expires_at',
  'positioning', 'organic_paid_strategy', 'priority_audiences', 'customer_problems',
  'value_propositions', 'priority_markets', 'property_categories', 'funnel',
  'channel_roles', 'content_principles', 'measurement_principles',
  'strategic_priorities', 'not_priorities', 'assumptions', 'risks',
  'owner_user_id', 'archived_at',
] as const;

const PLAN_EDITABLE = [
  'plan_type', 'parent_plan_id', 'strategy_version_id', 'name_ar', 'name_en',
  'summary_ar', 'summary_en', 'status', 'period_start', 'period_end', 'priorities',
  'budget', 'channel_budgets', 'team_capacity', 'production_capacity',
  'priority_audiences', 'priority_locations', 'property_types', 'assumptions',
  'risks', 'dependencies', 'review_frequency', 'owner_user_id', 'archived_at',
] as const;

const GOAL_EDITABLE = [
  'plan_id', 'parent_goal_id', 'goal_category', 'name_ar', 'name_en', 'description',
  'metric', 'unit', 'baseline_value', 'target_value', 'start_date', 'end_date',
  'owner_user_id', 'measurement_frequency', 'source_of_truth', 'scope', 'status',
  'actual_value', 'forecast_value', 'result', 'notes', 'assumptions', 'archived_at',
] as const;

const TARGET_PERIOD_EDITABLE = [
  'label', 'period_start', 'period_end', 'target_value', 'actual_value',
  'forecast_value', 'notes',
] as const;

const INITIATIVE_EDITABLE = [
  'plan_id', 'primary_goal_id', 'name_ar', 'name_en', 'problem_or_opportunity',
  'hypothesis', 'target_audiences', 'scope', 'locations', 'property_types',
  'channels', 'start_date', 'review_date', 'end_date', 'budget', 'owner_user_id',
  'status', 'expected_contribution', 'actual_contribution', 'lessons', 'archived_at',
] as const;

const PROGRAM_EDITABLE = [
  'plan_id', 'initiative_id', 'primary_goal_id', 'name_ar', 'name_en', 'purpose',
  'target_audience', 'content_pillars', 'platforms', 'accounts', 'formats',
  'cadence', 'commitment_count', 'commitment_unit', 'kpi_targets', 'owner_user_id',
  'review_frequency', 'status', 'start_date', 'lessons', 'archived_at',
] as const;

const CHANNEL_PLAN_EDITABLE = [
  'plan_id', 'platform', 'account_handle', 'max_per_day', 'max_per_week',
  'format_mix', 'pillar_mix', 'reactive_reserve', 'same_project_max_per_week', 'notes',
] as const;

const ALLOCATION_EDITABLE = [
  'channel_plan_id', 'week_start', 'allocation_kind', 'program_id', 'campaign_id',
  'slots_requested', 'slots_granted', 'note',
] as const;

const PLATFORM_CAMPAIGN_EDITABLE = [
  'campaign_id', 'platform', 'name', 'platform_config', 'config_schema_version',
  'objective', 'budget', 'budget_kind', 'start_date', 'end_date', 'destination_url',
  'conversion_event', 'tracking_template', 'status', 'external_id', 'owner_user_id',
] as const;

const AD_GROUP_EDITABLE = [
  'platform_campaign_id', 'name', 'targeting', 'targeting_schema_version',
  'budget', 'bid_strategy', 'start_date', 'end_date', 'status', 'external_id',
] as const;

const AD_EDITABLE = [
  'ad_group_id', 'name', 'content_item_id', 'primary_text', 'headline',
  'description', 'cta_label', 'destination_url', 'status', 'external_id',
] as const;

const REVIEW_EDITABLE = [
  'plan_id', 'review_type', 'period_start', 'period_end', 'summary', 'what_worked',
  'what_did_not', 'lessons', 'status', 'reviewer_user_id', 'held_at',
] as const;

const REVIEW_DECISION_EDITABLE = [
  'review_id', 'initiative_id', 'program_id', 'campaign_id', 'goal_id', 'decision',
  'rationale', 'goal_forecast_before', 'goal_forecast_after', 'budget_change',
  'capacity_change',
] as const;

const USAGE_EDITABLE = [
  'content_item_id', 'usage_kind', 'campaign_id', 'program_id', 'initiative_id',
  'publication_id', 'note',
] as const;

/** Campaign columns a user may edit: the v1 set, verified against the live
 *  table's columns, plus the v2 portfolio fields. campaign_save previously
 *  forwarded ANY key — the same hole that was closed on content_update — so id,
 *  created_by_user_id, needs_classification and the review-owned decision
 *  columns were all writable by a caller. They are not on this list.
 *  `decision` is set by review_decide, never by editing the campaign. */
const CAMPAIGN_EDITABLE = [
  // v1
  'code', 'name_ar', 'name_en', 'campaign_type', 'channel_mix', 'status', 'priority',
  'start_date', 'end_date', 'objective', 'offer', 'main_message', 'hooks', 'cta',
  'landing_url', 'positioning', 'content_pillars', 'target_audience', 'budget',
  'target_leads', 'target_revenue', 'target_sales', 'target_appointments',
  'target_cpl', 'target_cpa', 'target_roas', 'owner_user_id', 'archived_at',
  // v2 portfolio
  'plan_id', 'initiative_id', 'program_id', 'primary_goal_id', 'campaign_class',
  'funnel_stage', 'deliverables', 'lessons',
] as const;

interface Body {
  action?: string;
  id?: string;
  platforms?: unknown[];
  // v2 planning layer
  plan_id?: string;
  goal_id?: string;
  channel_plan_id?: string;
  week_start?: string;
  periods?: unknown[];
  user_id?: string;
  role?: string;
  version_number?: number;
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
  asset_ids?: string[];
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
  // 42703 = undefined_column / 42883 = undefined_function. In this codebase that
  // means the app deployed ahead of its migration, which otherwise surfaces as a
  // bare 500 and reads like a bug in the form. Name the actual remedy.
  if (error.code === '42703' || error.code === '42883') {
    return jsonError(503, `${m} — the database is missing an object this build expects. `
      + 'Apply the latest supabase/migrations file, then retry.');
  }
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
        const patch = pick(body.patch, CAMPAIGN_EDITABLE);
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

        // Performance and attribution for THIS item, so the detail page can show
        // a result summary without a second round trip. Attribution is joined
        // through this item's publications — a lead can be credited to the
        // publication, the content or the campaign, and all three must count.
        const pubIds = (pubs.data ?? []).map((p: { id: string }) => p.id);
        const [perf, attrib, nextStatuses] = await Promise.all([
          pubIds.length
            ? sb.from('mkt_performance_snapshots').select('*')
                .in('publication_id', pubIds).order('captured_at', { ascending: false })
            : Promise.resolve({ data: [], error: null }),
          pubIds.length
            ? sb.from('mkt_lead_attributions').select('*')
                .or(`content_item_id.eq.${id},publication_id.in.(${pubIds.join(',')})`)
            : sb.from('mkt_lead_attributions').select('*').eq('content_item_id', id),
          sb.rpc('mkt_content_next_statuses', { p_from: (item.data as { status: string }).status }),
        ]);

        return jsonOk({
          item: item.data, versions: versions.data ?? [], tasks: tasks.data ?? [],
          approvals: approvals.data ?? [], publications: pubs.data ?? [], history: history.data ?? [],
          scenes: scenes.data ?? [], slides: slides.data ?? [],
          video: video.data ?? null, post: post.data ?? null, assets: links.data ?? [],
          performance: perf.data ?? [], attributions: attrib.data ?? [],
          // null (not []) when the RPC is missing, so the UI can tell "no legal
          // moves" apart from "this build is ahead of the database".
          allowed_transitions: (nextStatuses.data as string[] | null) ?? null,
        });
      }
      case 'platform_set': {
        // Target platforms are a set, so the write is a replace. Delete-then-
        // insert rather than upsert because removing a platform is the common
        // edit and upsert alone would never drop one.
        const id = str(body.content_item_id ?? body.id);
        if (!id) return jsonError(400, 'content_item_id required');
        const list = Array.isArray(body.platforms) ? body.platforms.filter((p): p is string => typeof p === 'string') : [];
        const del = await sb.from('mkt_content_platforms').delete().eq('content_item_id', id);
        const badDel = rlsAware(del.error); if (badDel) return badDel;
        if (list.length) {
          const ins = await sb.from('mkt_content_platforms')
            .insert(list.map((platform) => ({ content_item_id: id, platform })));
          const badIns = rlsAware(ins.error); if (badIns) return badIns;
        }
        return jsonOk({ platforms: list });
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
        // Allow-list, not deny-list. `status` moves only through content_transition
        // (the DB rejects invalid jumps), and identity/provenance columns —
        // content_number, created_by_user_id, created_at, source_* — are not
        // editable at all: the spec's claim that external evidence stays
        // traceable to internal execution is only true if nothing can rewrite
        // the link after the fact.
        const patch: Record<string, unknown> = {};
        for (const k of CONTENT_EDITABLE) {
          if (body.patch && Object.prototype.hasOwnProperty.call(body.patch, k)) patch[k] = body.patch[k];
        }
        if (Object.keys(patch).length === 0) return jsonError(400, 'no editable fields in patch');
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
      case 'asset_process': {
        // Queue OCR / transcript / description for specific assets, or for every
        // un-analysed asset that actually has a file. The RPC is capability-gated
        // and idempotent — it never double-queues an asset already in flight.
        const ids = Array.isArray(body.asset_ids) ? body.asset_ids.filter((x): x is string => typeof x === 'string') : null;
        const { data, error } = await sb.rpc('mkt_asset_enqueue_processing', {
          p_asset_ids: ids && ids.length ? ids : null,
          p_limit: cap(body.limit, 50, 500),
        });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ queued: data ?? 0 });
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

      // ══ v2 planning layer ═══════════════════════════════════════════════
      // Every write goes through pick() with an explicit allow-list, so no
      // caller can set an id, a generated number, an approval stamp or the
      // needs_classification flag by hand. RLS still decides who may write at
      // all; this only decides WHAT may be written.

      case 'planning_overview': {
        // One call for the Strategy & Planning tab.
        const [current, strategies, plans] = await Promise.all([
          sb.from('mkt_strategy_versions').select('*').eq('status', 'approved').maybeSingle(),
          // Archived drafts are hidden: a throwaway draft should not clutter the
          // list of versions a reviewer has to consider.
          sb.from('mkt_strategy_versions').select('*').is('archived_at', null)
            .order('version_number', { ascending: false }).limit(50),
          sb.from('mkt_plans').select('*, mkt_goals(id,goal_category,name_ar,target_value,actual_value,result,status)')
            .is('archived_at', null).order('period_start', { ascending: false }).limit(100),
        ]);
        const bad = rlsAware(strategies.error); if (bad) return bad;
        return jsonOk({
          current_strategy: current.data ?? null,
          strategies: strategies.data ?? [],
          plans: plans.data ?? [],
        });
      }

      case 'strategy_save': {
        const patch = pick(body.patch, STRATEGY_EDITABLE);
        if (!body.id && !patch.name_ar) return jsonError(400, 'name_ar required');
        const q = body.id
          ? sb.from('mkt_strategy_versions').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_strategy_versions').insert({
              ...patch,
              // Next version number, computed server-side so two editors cannot
              // both claim the same one.
              version_number: (body.version_number as number | undefined)
                ?? ((await sb.from('mkt_strategy_versions').select('version_number')
                      .order('version_number', { ascending: false }).limit(1).maybeSingle()
                    ).data?.version_number ?? 0) + 1,
              created_by_user_id: appUserId,
            }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ strategy: data });
      }

      case 'strategy_approve': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        // Supersede the incumbent first: exactly one approved strategy may
        // exist, so approving a new one without retiring the old would hit the
        // unique index. Two statements, one intent.
        const prior = await sb.from('mkt_strategy_versions').select('id')
          .eq('status', 'approved').maybeSingle();
        if (prior.data?.id && prior.data.id !== id) {
          const sup = await sb.from('mkt_strategy_versions')
            .update({ status: 'superseded' }).eq('id', prior.data.id);
          const badSup = rlsAware(sup.error); if (badSup) return badSup;
        }
        const { data, error } = await sb.from('mkt_strategy_versions')
          .update({ status: 'approved', approver_user_id: appUserId, approved_at: new Date().toISOString(),
                    supersedes_version_id: prior.data?.id ?? null })
          .eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ strategy: data, superseded: prior.data?.id ?? null });
      }

      case 'plan_detail': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const [plan, goals, inits, progs, camps, channels, reviews] = await Promise.all([
          sb.from('mkt_plans').select('*').eq('id', id).maybeSingle(),
          sb.from('mkt_goals').select('*, mkt_goal_target_periods(*)').eq('plan_id', id)
            .is('archived_at', null).order('goal_category'),
          sb.from('mkt_initiatives').select('*').eq('plan_id', id).is('archived_at', null),
          sb.from('mkt_programs').select('*').eq('plan_id', id).is('archived_at', null),
          sb.from('mkt_internal_campaigns').select('*').eq('plan_id', id).is('archived_at', null),
          sb.from('mkt_channel_plans').select('*, mkt_capacity_allocations(*)').eq('plan_id', id),
          sb.from('mkt_reviews').select('*, mkt_review_decisions(*)').eq('plan_id', id)
            .order('period_start', { ascending: false }),
        ]);
        const bad = rlsAware(plan.error); if (bad) return bad;
        if (!plan.data) return jsonError(404, 'plan not found');
        return jsonOk({
          plan: plan.data, goals: goals.data ?? [], initiatives: inits.data ?? [],
          programs: progs.data ?? [], campaigns: camps.data ?? [],
          channels: channels.data ?? [], reviews: reviews.data ?? [],
        });
      }

      case 'plan_save': {
        const patch = pick(body.patch, PLAN_EDITABLE);
        const q = body.id
          ? sb.from('mkt_plans').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_plans').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ plan: data });
      }

      case 'plan_approve': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const { data, error } = await sb.from('mkt_plans')
          .update({ status: 'approved', approver_user_id: appUserId, approved_at: new Date().toISOString() })
          .eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ plan: data });
      }

      case 'goal_save': {
        const patch = pick(body.patch, GOAL_EDITABLE);
        const q = body.id
          ? sb.from('mkt_goals').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_goals').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ goal: data });
      }

      case 'goal_targets_set': {
        // Replace the whole allocation for a goal in one call. Deliberately a
        // replace: a per-period upsert would leave orphaned months behind when
        // someone re-plans the year, and the sum is only meaningful as a set.
        const goalId = str(body.goal_id); if (!goalId) return jsonError(400, 'goal_id required');
        const rows = Array.isArray(body.periods) ? body.periods : [];
        const del = await sb.from('mkt_goal_target_periods').delete().eq('goal_id', goalId);
        const badDel = rlsAware(del.error); if (badDel) return badDel;
        if (rows.length) {
          const ins = await sb.from('mkt_goal_target_periods').insert(
            rows.map((r) => ({ ...pick(r as Record<string, unknown>, TARGET_PERIOD_EDITABLE), goal_id: goalId })));
          const badIns = rlsAware(ins.error); if (badIns) return badIns;
        }
        const { data } = await sb.from('mkt_goal_target_periods').select('*')
          .eq('goal_id', goalId).order('period_start');
        return jsonOk({ periods: data ?? [] });
      }

      case 'goal_pacing': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const [pacing, rollup] = await Promise.all([
          sb.rpc('mkt_goal_pacing', { p_goal_id: id }),
          sb.rpc('mkt_goal_rollup', { p_goal_id: id }),
        ]);
        const bad = rlsAware(pacing.error); if (bad) return bad;
        return jsonOk({ pacing: pacing.data ?? null, rollup: rollup.data ?? null });
      }

      case 'portfolio_list': {
        const planId = str(body.plan_id);
        const q = <T extends { eq: unknown }>(b: T) => (planId ? (b as { eq: (a: string, b: string) => T }).eq('plan_id', planId) : b);
        const [inits, progs, camps] = await Promise.all([
          q(sb.from('mkt_initiatives').select('*, mkt_programs(id,name_ar,status), mkt_internal_campaigns(id,code,name_ar,campaign_class,status)').is('archived_at', null)),
          q(sb.from('mkt_programs').select('*').is('archived_at', null)),
          q(sb.from('mkt_internal_campaigns').select('*').is('archived_at', null)),
        ]);
        const bad = rlsAware(inits.error); if (bad) return bad;
        return jsonOk({ initiatives: inits.data ?? [], programs: progs.data ?? [], campaigns: camps.data ?? [] });
      }

      case 'initiative_save': {
        const patch = pick(body.patch, INITIATIVE_EDITABLE);
        const q = body.id
          ? sb.from('mkt_initiatives').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_initiatives').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ initiative: data });
      }

      case 'program_save': {
        const patch = pick(body.patch, PROGRAM_EDITABLE);
        const q = body.id
          ? sb.from('mkt_programs').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_programs').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ program: data });
      }

      case 'channel_plan_save': {
        const patch = pick(body.patch, CHANNEL_PLAN_EDITABLE);
        const q = body.id
          ? sb.from('mkt_channel_plans').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_channel_plans').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ channel_plan: data });
      }

      case 'capacity_allocate': {
        const patch = pick(body.patch, ALLOCATION_EDITABLE);
        const q = body.id
          ? sb.from('mkt_capacity_allocations').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_capacity_allocations').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ allocation: data });
      }

      case 'capacity_status': {
        const chan = str(body.channel_plan_id); const week = str(body.week_start);
        if (!chan || !week) return jsonError(400, 'channel_plan_id and week_start required');
        const { data, error } = await sb.rpc('mkt_capacity_status',
          { p_channel_plan_id: chan, p_week_start: week });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ status: data ?? null });
      }

      case 'platform_campaign_save': {
        const patch = pick(body.patch, PLATFORM_CAMPAIGN_EDITABLE);
        const q = body.id
          ? sb.from('mkt_platform_campaigns').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_platform_campaigns').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ platform_campaign: data });
      }

      case 'ad_group_save': {
        const patch = pick(body.patch, AD_GROUP_EDITABLE);
        const q = body.id
          ? sb.from('mkt_ad_groups').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_ad_groups').insert(patch).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ ad_group: data });
      }

      case 'ad_save': {
        const patch = pick(body.patch, AD_EDITABLE);
        const q = body.id
          ? sb.from('mkt_ads').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_ads').insert(patch).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ ad: data });
      }

      case 'paid_tree': {
        const campId = str(body.campaign_id); if (!campId) return jsonError(400, 'campaign_id required');
        const { data, error } = await sb.from('mkt_platform_campaigns')
          .select('*, mkt_ad_groups(*, mkt_ads(*))').eq('campaign_id', campId).order('platform');
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ platform_campaigns: data ?? [] });
      }

      case 'review_save': {
        const patch = pick(body.patch, REVIEW_EDITABLE);
        const q = body.id
          ? sb.from('mkt_reviews').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_reviews').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ review: data });
      }

      case 'review_decide': {
        const patch = pick(body.patch, REVIEW_DECISION_EDITABLE);
        const { data, error } = await sb.from('mkt_review_decisions').insert(patch).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ decision: data });
      }

      case 'pillar_list': {
        const { data, error } = await sb.from('mkt_content_pillars').select('*')
          .eq('is_active', true).order('sort_order');
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ pillars: data ?? [] });
      }

      case 'content_usage_add': {
        const patch = pick(body.patch, USAGE_EDITABLE);
        const { data, error } = await sb.from('mkt_content_usage')
          .insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ usage: data });
      }

      case 'content_missing_context': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const { data, error } = await sb.rpc('mkt_content_missing_context', { p_content_item_id: id });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ missing: (data as string[] | null) ?? [] });
      }

      case 'generate_v2_alerts': {
        const { data, error } = await sb.rpc('mkt_mgmt_generate_v2_alerts');
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ rules: data ?? [] });
      }

      case 'set_marketing_role': {
        const uid = str(body.user_id); if (!uid) return jsonError(400, 'user_id required');
        const { error } = await sb.rpc('mkt_set_role_grant',
          { p_user_id: uid, p_role: str(body.role) ?? null });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ ok: true });
      }

      default:
        return jsonError(400, `unknown action: ${action}`);
    }
  });
}
