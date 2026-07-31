/**
 * POST /api/marketing-os
 *
 * Action-dispatch endpoint for the Marketing OS module — a ground-up rebuild.
 * It shares NOTHING with the `mkt_*` tables or `api/marketing-mgmt.ts`; it reads
 * and writes only `mos_*`.
 *
 * Deliberately NOT `api/marketing.ts` — that name is already the live Marketing
 * Intelligence endpoint (competitor intel, ~49k observed facts) and is unrelated.
 *
 * Posture, matching every other bespoke module here:
 *   - Edge runtime, one POST, `{ action, ...payload }`.
 *   - Runs on the CALLER's JWT, never the service role. RLS is the authorization
 *     boundary — `wassell_mos_can(<capability>)` decides, not this file.
 *   - Reads go through `mos_content_v`, which DERIVES status and current owner
 *     from the open task. There is no stored status column to disagree with.
 *   - Updates use an allow-list, never a deny-list.
 *   - Deliberate DB rejections are translated bilingually; raw Postgres is never
 *     returned to the browser but is always console.error-ed (repo rule: fail loudly).
 */
import { createClient, type SupabaseClient, type PostgrestError } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';

export const config = { runtime: 'edge' };

/* ------------------------------------------------------------------ */
/* transport                                                          */
/* ------------------------------------------------------------------ */

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

async function resolveAppUserId(sb: SupabaseClient, authUid: string): Promise<string | null> {
  const { data, error } = await sb.rpc('wassell_app_user_id', { auth_user_id: authUid });
  if (error) {
    console.error('[marketing-os] wassell_app_user_id failed', error.code, error.message, error.details);
    return null;
  }
  return (data as string | null) ?? null;
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/** Clamp any client-supplied limit. No list here is ever unbounded. */
const cap = (n: unknown, def: number, max: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : def;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/** Deliberate database rejections, translated. Anything unmapped stays generic. */
const DB_MESSAGES: Record<string, { en: string; ar: string }> = {
  'MOS:UNKNOWN_CONTENT_TYPE': {
    en: 'That content type does not exist.',
    ar: 'نوع المحتوى غير موجود.',
  },
  mos_tasks_reject_note_check: {
    en: 'Requesting changes requires a note explaining what to change.',
    ar: 'طلب التعديلات يستلزم ملاحظة توضّح المطلوب.',
  },
  uq_mos_tasks_one_open: {
    en: 'This item already has an open task.',
    ar: 'هذا العنصر لديه مهمة مفتوحة بالفعل.',
  },
  mos_content_purpose_check: {
    en: 'Purpose must be organic, paid or both.',
    ar: 'الغرض يجب أن يكون عضويًا أو مدفوعًا أو الاثنين.',
  },
};

function translateDbError(error: PostgrestError): { status: number; en: string; ar: string } {
  console.error('[marketing-os] db error', error.code, error.message, error.details, error.hint);

  if (error.code === '42501' || /row-level security/i.test(error.message)) {
    return {
      status: 403,
      en: 'Your marketing role does not allow this action.',
      ar: 'دورك في التسويق لا يسمح بهذا الإجراء.',
    };
  }
  for (const token of Object.keys(DB_MESSAGES)) {
    const mapped = DB_MESSAGES[token];
    if (mapped && error.message.includes(token)) {
      return { status: 400, en: mapped.en, ar: mapped.ar };
    }
  }
  return {
    status: 400,
    en: 'The database rejected this change.',
    ar: 'رفضت قاعدة البيانات هذا التغيير.',
  };
}

/** Returns a Response when `error` is set, otherwise null. */
function dbFail(error: PostgrestError | null): Response | null {
  if (!error) return null;
  const t = translateDbError(error);
  return new Response(JSON.stringify({ error: t.en, error_ar: t.ar }), {
    status: t.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Minimal row shape. PostgREST cannot infer a select built from a runtime string. */
interface Row {
  id: string;
  [key: string]: unknown;
}

/**
 * The Content list shows a dozen fields. Naming them keeps the payload
 * proportional to the screen instead of shipping every column of the view.
 */
const CONTENT_LIST_COLUMNS = [
  'id', 'ref', 'title', 'content_type_key', 'content_type_label_ar', 'content_type_label_en',
  'project_id', 'campaign_id', 'purpose',
  'status_key', 'current_step_label_ar', 'current_step_label_en',
  'owner_role', 'current_assignee_user_id', 'current_task_due_at', 'current_round',
  'due_at', 'target_publish_at', 'updated_at',
].join(', ');

/** Patchable content fields. Identity and provenance are excluded by omission. */
const CONTENT_EDITABLE = [
  'title', 'project_id', 'campaign_id', 'purpose', 'language',
  'goal', 'audience', 'angle', 'cta',
  'target_publish_at', 'due_at', 'data',
] as const;

/* ------------------------------------------------------------------ */
/* handler                                                            */
/* ------------------------------------------------------------------ */

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'method not allowed');

  return withAuth(req, async (user) => {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError(400, 'body must be JSON');
    }

    const sb = callerClient(req);
    const action = str(body.action);
    if (!action) return jsonError(400, 'action is required');

    switch (action) {
      /* -------------------------------------------------------- */
      /* bootstrap — role + content types, one call on page load   */
      /* -------------------------------------------------------- */
      case 'bootstrap': {
        const [roleRes, typesRes, appUserId] = await Promise.all([
          sb.rpc('wassell_mos_role', { p_auth_uid: user.userId }),
          sb.from('mos_content_types')
            .select('id, key, label_ar, label_en, prefix, workflow_id, field_schema, sort_order')
            .is('archived_at', null)
            .eq('is_active', true)
            .order('sort_order', { ascending: true }),
          resolveAppUserId(sb, user.userId),
        ]);
        const fail = dbFail(roleRes.error) ?? dbFail(typesRes.error);
        if (fail) return fail;
        return jsonOk({
          role: (roleRes.data as string | null) ?? 'viewer',
          app_user_id: appUserId,
          content_types: typesRes.data ?? [],
        });
      }

      /* -------------------------------------------------------- */
      /* Content list                                              */
      /* -------------------------------------------------------- */
      case 'content_list': {
        let q = sb.from('mos_content_v').select(CONTENT_LIST_COLUMNS).is('archived_at', null);

        const typeKey = str(body.content_type_key);
        const statusKey = str(body.status_key);
        const projectId = str(body.project_id);
        const role = str(body.role);
        const search = str(body.q);
        if (typeKey) q = q.eq('content_type_key', typeKey);
        if (statusKey) q = q.eq('status_key', statusKey);
        if (projectId) q = q.eq('project_id', projectId);
        if (role) q = q.eq('owner_role', role);
        if (search) q = q.ilike('title', `%${search}%`);

        // Items with a due date first, soonest first; undated fall to the end.
        const { data, error } = await q
          .order('due_at', { ascending: true, nullsFirst: false })
          .limit(cap(body.limit, 200, 500));

        const fail = dbFail(error);
        if (fail) return fail;
        return jsonOk({ content: data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Workspace — one round trip                                */
      /* -------------------------------------------------------- */
      case 'content_detail': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');

        const [item, tasks, scenes] = await Promise.all([
          sb.from('mos_content_v').select('*').eq('id', id).maybeSingle(),
          sb.from('mos_tasks').select('*').eq('content_id', id)
            .order('opened_at', { ascending: true }),
          sb.from('mos_scenes').select('*').eq('content_id', id)
            .order('position', { ascending: true }),
        ]);

        const fail = dbFail(item.error) ?? dbFail(tasks.error) ?? dbFail(scenes.error);
        if (fail) return fail;
        if (!item.data) return jsonError(404, 'content item not found');

        // Steps for the workflow this item is on — drives the stage rail.
        const workflowId = (item.data as Row).workflow_id as string | null;
        let steps: unknown[] = [];
        if (workflowId) {
          const stepsRes = await sb.from('mos_workflow_steps')
            .select('*').eq('workflow_id', workflowId)
            .order('position', { ascending: true });
          const stepsFail = dbFail(stepsRes.error);
          if (stepsFail) return stepsFail;
          steps = stepsRes.data ?? [];
        }

        return jsonOk({
          item: item.data,
          tasks: tasks.data ?? [],
          scenes: scenes.data ?? [],
          steps,
        });
      }

      /* -------------------------------------------------------- */
      /* Create — and open the first task in the same request      */
      /* -------------------------------------------------------- */
      case 'content_create': {
        const title = str(body.title);
        const typeKey = str(body.content_type_key);
        if (!title) return jsonError(400, 'title is required');
        if (!typeKey) return jsonError(400, 'content_type_key is required');

        const typeRes = await sb.from('mos_content_types')
          .select('id, workflow_id').eq('key', typeKey).maybeSingle();
        const typeFail = dbFail(typeRes.error);
        if (typeFail) return typeFail;
        if (!typeRes.data) return jsonError(400, 'unknown content type');
        const type = typeRes.data as { id: string; workflow_id: string | null };

        const appUserId = await resolveAppUserId(sb, user.userId);
        const insert: Record<string, unknown> = {};
        for (const k of CONTENT_EDITABLE) {
          if (Object.prototype.hasOwnProperty.call(body, k)) insert[k] = body[k];
        }
        insert.title = title;
        insert.content_type_id = type.id;
        insert.workflow_id = type.workflow_id;
        insert.created_by_user_id = appUserId;

        const created = await sb.from('mos_content').insert(insert).select('id, ref').maybeSingle();
        const createFail = dbFail(created.error);
        if (createFail) return createFail;
        if (!created.data) return jsonError(500, 'insert returned no row');
        const row = created.data as unknown as Row;

        // Open the workflow's first step immediately. Content with no task would
        // read as 'draft' and sit in nobody's queue — the exact failure mode this
        // module exists to remove.
        if (type.workflow_id) {
          const firstStep = await sb.from('mos_workflow_steps')
            .select('id, role, due_days')
            .eq('workflow_id', type.workflow_id)
            .order('position', { ascending: true })
            .limit(1)
            .maybeSingle();
          const stepFail = dbFail(firstStep.error);
          if (stepFail) return stepFail;

          if (firstStep.data) {
            const step = firstStep.data as { id: string; role: string; due_days: number };
            const dueAt = new Date(Date.now() + step.due_days * 86_400_000).toISOString();
            const taskRes = await sb.from('mos_tasks').insert({
              content_id: row.id,
              step_id: step.id,
              role: step.role,
              due_at: dueAt,
            });
            const taskFail = dbFail(taskRes.error);
            if (taskFail) return taskFail;
          }
        }

        const full = await sb.from('mos_content_v')
          .select(CONTENT_LIST_COLUMNS).eq('id', row.id).maybeSingle();
        const fullFail = dbFail(full.error);
        if (fullFail) return fullFail;
        return jsonOk({ item: full.data });
      }

      /* -------------------------------------------------------- */
      /* Allow-listed patch                                        */
      /* -------------------------------------------------------- */
      case 'content_update': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const raw = (body.patch ?? {}) as Record<string, unknown>;

        const patch: Record<string, unknown> = {};
        for (const k of CONTENT_EDITABLE) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (Object.keys(patch).length === 0) return jsonError(400, 'no editable fields in patch');

        const upd = await sb.from('mos_content').update(patch).eq('id', id).select('id').maybeSingle();
        const updFail = dbFail(upd.error);
        if (updFail) return updFail;
        if (!upd.data) return jsonError(404, 'content item not found');

        const full = await sb.from('mos_content_v')
          .select(CONTENT_LIST_COLUMNS).eq('id', id).maybeSingle();
        const fullFail = dbFail(full.error);
        if (fullFail) return fullFail;
        return jsonOk({ item: full.data });
      }

      /* -------------------------------------------------------- */
      /* Close the open task and open the next step                */
      /* -------------------------------------------------------- */
      case 'task_complete': {
        const taskId = str(body.task_id);
        const result = str(body.result);
        const note = str(body.note);
        if (!taskId) return jsonError(400, 'task_id is required');
        if (!result || !['submitted', 'approved', 'changes_requested'].includes(result)) {
          return jsonError(400, 'result must be submitted, approved or changes_requested');
        }
        // Mirrors the CHECK constraint so the user gets a sentence, not a violation.
        if (result === 'changes_requested' && !note) {
          return new Response(
            JSON.stringify({
              error: 'Requesting changes requires a note explaining what to change.',
              error_ar: 'طلب التعديلات يستلزم ملاحظة توضّح المطلوب.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const cur = await sb.from('mos_tasks')
          .select('id, content_id, step_id, round, status').eq('id', taskId).maybeSingle();
        const curFail = dbFail(cur.error);
        if (curFail) return curFail;
        if (!cur.data) return jsonError(404, 'task not found');
        const task = cur.data as unknown as {
          id: string; content_id: string; step_id: string | null; round: number; status: string;
        };
        if (task.status !== 'open') return jsonError(400, 'task is already closed');

        const appUserId = await resolveAppUserId(sb, user.userId);
        const close = await sb.from('mos_tasks').update({
          status: 'done',
          result,
          note,
          closed_at: new Date().toISOString(),
          closed_by_user_id: appUserId,
        }).eq('id', taskId);
        const closeFail = dbFail(close.error);
        if (closeFail) return closeFail;

        // Where the work goes next.
        const contentRes = await sb.from('mos_content')
          .select('workflow_id').eq('id', task.content_id).maybeSingle();
        const contentFail = dbFail(contentRes.error);
        if (contentFail) return contentFail;
        const workflowId = (contentRes.data as { workflow_id: string | null } | null)?.workflow_id;

        if (workflowId && task.step_id) {
          const stepsRes = await sb.from('mos_workflow_steps')
            .select('id, position, role, due_days')
            .eq('workflow_id', workflowId)
            .order('position', { ascending: true });
          const stepsFail = dbFail(stepsRes.error);
          if (stepsFail) return stepsFail;

          const steps = (stepsRes.data ?? []) as unknown as Array<{
            id: string; position: number; role: string; due_days: number;
          }>;
          const idx = steps.findIndex((s) => s.id === task.step_id);

          // Approved / submitted → forward. Changes requested → back one step,
          // as a new round, so the loop is visible in the task chain rather than
          // overwriting the record it came from.
          const nextStep =
            result === 'changes_requested'
              ? (idx > 0 ? steps[idx - 1] : steps[idx])
              : (idx >= 0 && idx < steps.length - 1 ? steps[idx + 1] : null);

          if (nextStep) {
            const dueAt = new Date(Date.now() + nextStep.due_days * 86_400_000).toISOString();
            const openRes = await sb.from('mos_tasks').insert({
              content_id: task.content_id,
              step_id: nextStep.id,
              role: nextStep.role,
              due_at: dueAt,
              round: result === 'changes_requested' ? task.round + 1 : task.round,
            });
            const openFail = dbFail(openRes.error);
            if (openFail) return openFail;
          }
        }

        const full = await sb.from('mos_content_v')
          .select(CONTENT_LIST_COLUMNS).eq('id', task.content_id).maybeSingle();
        const fullFail = dbFail(full.error);
        if (fullFail) return fullFail;
        return jsonOk({ item: full.data });
      }

      /* -------------------------------------------------------- */
      /* Scenes — the shoot list is derived from these             */
      /* -------------------------------------------------------- */
      case 'scene_save': {
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const raw = (body.scene ?? {}) as Record<string, unknown>;
        const id = str(raw.id);

        const patch: Record<string, unknown> = {};
        for (const k of ['position', 'start_sec', 'end_sec', 'visual', 'voiceover',
                         'on_screen_text', 'footage_status', 'note'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }

        if (id) {
          const upd = await sb.from('mos_scenes').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'scene not found');
        } else {
          patch.content_id = contentId;
          if (patch.position === undefined) {
            const last = await sb.from('mos_scenes').select('position')
              .eq('content_id', contentId).order('position', { ascending: false }).limit(1).maybeSingle();
            const f = dbFail(last.error);
            if (f) return f;
            patch.position = ((last.data as { position: number } | null)?.position ?? 0) + 1;
          }
          const ins = await sb.from('mos_scenes').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }

        const list = await sb.from('mos_scenes').select('*')
          .eq('content_id', contentId).order('position', { ascending: true });
        const f = dbFail(list.error);
        if (f) return f;
        return jsonOk({ scenes: list.data ?? [] });
      }

      case 'scene_delete': {
        const id = str(body.id);
        const contentId = str(body.content_id);
        if (!id || !contentId) return jsonError(400, 'id and content_id are required');
        const del = await sb.from('mos_scenes').delete().eq('id', id);
        const f = dbFail(del.error);
        if (f) return f;
        const list = await sb.from('mos_scenes').select('*')
          .eq('content_id', contentId).order('position', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ scenes: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Publications — one row per platform                       */
      /* -------------------------------------------------------- */
      case 'publication_list': {
        const contentId = str(body.content_id);
        const [pubs, accounts] = await Promise.all([
          contentId
            ? sb.from('mos_publication_v').select('*').eq('content_id', contentId)
                .order('scheduled_at', { ascending: true, nullsFirst: false })
            : sb.from('mos_publication_v').select('*')
                .order('scheduled_at', { ascending: true, nullsFirst: false })
                .limit(cap(body.limit, 200, 500)),
          sb.from('mos_platform_accounts').select('*').is('archived_at', null)
            .order('sort_order', { ascending: true }),
        ]);
        const f = dbFail(pubs.error) ?? dbFail(accounts.error);
        if (f) return f;
        return jsonOk({ publications: pubs.data ?? [], accounts: accounts.data ?? [] });
      }

      case 'publication_save': {
        const contentId = str(body.content_id);
        if (!contentId) return jsonError(400, 'content_id is required');
        const raw = (body.publication ?? {}) as Record<string, unknown>;
        const id = str(raw.id);

        const patch: Record<string, unknown> = {};
        for (const k of ['platform', 'account_id', 'status', 'scheduled_at', 'published_at',
                         'caption', 'external_url', 'external_id', 'note'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }

        // Marking published stamps who and when, so "who posted this" is never a
        // guess. The DB also refuses published without a timestamp.
        if (patch.status === 'published') {
          if (!patch.published_at) patch.published_at = new Date().toISOString();
          patch.published_by_user_id = await resolveAppUserId(sb, user.userId);
        }

        if (id) {
          const upd = await sb.from('mos_publications').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'publication not found');
        } else {
          if (!patch.platform) return jsonError(400, 'platform is required');
          patch.content_id = contentId;
          const ins = await sb.from('mos_publications').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }

        const list = await sb.from('mos_publication_v').select('*').eq('content_id', contentId)
          .order('scheduled_at', { ascending: true, nullsFirst: false });
        const f = dbFail(list.error);
        if (f) return f;
        return jsonOk({ publications: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Metric snapshots — append-only, never overwritten         */
      /* -------------------------------------------------------- */
      case 'metrics_record': {
        const publicationId = str(body.publication_id);
        if (!publicationId) return jsonError(400, 'publication_id is required');

        const num = (v: unknown): number | null =>
          typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null;
        const views = num(body.views);
        const engagement = num(body.engagement);
        const enquiries = num(body.enquiries);

        // Mirrors mos_snap_not_empty_check so the user gets a sentence rather
        // than a constraint violation.
        if (views === null && engagement === null && enquiries === null) {
          return new Response(
            JSON.stringify({
              error: 'Enter at least one number, or skip this publication.',
              error_ar: 'أدخل رقمًا واحدًا على الأقل، أو تخطَّ هذا المنشور.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }

        const ins = await sb.from('mos_metric_snapshots').insert({
          publication_id: publicationId,
          source: 'manual',
          views, engagement, enquiries,
          entered_by_user_id: await resolveAppUserId(sb, user.userId),
        }).select('id').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;

        const hist = await sb.from('mos_metric_snapshots').select('*')
          .eq('publication_id', publicationId).order('captured_at', { ascending: true });
        const hf = dbFail(hist.error);
        if (hf) return hf;
        return jsonOk({ snapshots: hist.data ?? [] });
      }

      case 'metrics_history': {
        const publicationId = str(body.publication_id);
        if (!publicationId) return jsonError(400, 'publication_id is required');
        const hist = await sb.from('mos_metric_snapshots').select('*')
          .eq('publication_id', publicationId).order('captured_at', { ascending: true });
        const f = dbFail(hist.error);
        if (f) return f;
        return jsonOk({ snapshots: hist.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Role grants — steps point at roles, this maps role→person */
      /* -------------------------------------------------------- */
      case 'roles_list': {
        const [users, grants] = await Promise.all([
          sb.from('users').select('id, name_ar, name_en, email, is_active')
            .eq('is_active', true).order('name_en', { ascending: true }).limit(500),
          sb.from('mos_role_grants').select('user_id, mos_role'),
        ]);
        const f = dbFail(users.error) ?? dbFail(grants.error);
        if (f) return f;
        return jsonOk({ users: users.data ?? [], grants: grants.data ?? [] });
      }

      case 'role_grant': {
        const targetUserId = str(body.user_id);
        const mosRole = str(body.mos_role);
        if (!targetUserId) return jsonError(400, 'user_id is required');
        const VALID = ['ceo', 'marketing_manager', 'ops_supervisor', 'writer', 'montage', 'viewer'];
        if (mosRole && !VALID.includes(mosRole)) return jsonError(400, 'unknown role');

        if (!mosRole) {
          const del = await sb.from('mos_role_grants').delete().eq('user_id', targetUserId);
          const f = dbFail(del.error);
          if (f) return f;
        } else {
          const up = await sb.from('mos_role_grants').upsert(
            {
              user_id: targetUserId,
              mos_role: mosRole,
              granted_by_user_id: await resolveAppUserId(sb, user.userId),
            },
            { onConflict: 'user_id' },
          );
          const f = dbFail(up.error);
          if (f) return f;
        }

        const grants = await sb.from('mos_role_grants').select('user_id, mos_role');
        const gf = dbFail(grants.error);
        if (gf) return gf;
        return jsonOk({ grants: grants.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Overview — four numbers and the two lists that need a     */
      /* decision today. Counts are COUNTS, not a fetched page     */
      /* trimmed client-side, so they stay true past 1,000 rows.   */
      /* -------------------------------------------------------- */
      case 'overview': {
        const nowIso = new Date().toISOString();
        const { weekStart, weekEnd } = weekBounds(str(body.week_of));
        const roleRes = await sb.rpc('wassell_mos_role', { p_auth_uid: user.userId });
        const roleFail = dbFail(roleRes.error);
        if (roleFail) return roleFail;
        const myRole = (roleRes.data as string | null) ?? 'viewer';

        const live = sb.from('mos_content_v').select('id', { count: 'exact', head: true })
          .is('archived_at', null).not('status_key', 'in', '("draft","done")');
        const mine = sb.from('mos_content_v').select('id', { count: 'exact', head: true })
          .is('archived_at', null).eq('owner_role', myRole);
        const late = sb.from('mos_content_v').select('id', { count: 'exact', head: true })
          .is('archived_at', null).not('status_key', 'in', '("draft","done")')
          .lt('current_task_due_at', nowIso);

        const [liveRes, mineRes, lateRes, stalled, week, spend, byType] = await Promise.all([
          live,
          mine,
          late,
          // Oldest-touched open work first — the bottleneck, by definition.
          sb.from('mos_content_v')
            .select('id, ref, title, status_key, current_step_label_ar, current_step_label_en, owner_role, current_task_due_at, updated_at, content_type_key')
            .is('archived_at', null).not('status_key', 'in', '("draft","done")')
            .order('updated_at', { ascending: true }).limit(8),
          sb.from('mos_publication_v')
            .select('id, content_id, platform, status, scheduled_at, published_at')
            .gte('scheduled_at', weekStart).lte('scheduled_at', weekEnd)
            .order('scheduled_at', { ascending: true }).limit(60),
          sb.from('mos_campaign_v')
            .select('id, ref, name, status, budget_total, total_spend, total_leads, total_qualified')
            .in('status', ['active', 'planning']).limit(20),
          sb.from('mos_content_v').select('content_type_key, status_key')
            .is('archived_at', null).not('status_key', 'in', '("draft","done")').limit(1000),
        ]);

        const f = dbFail(liveRes.error) ?? dbFail(mineRes.error) ?? dbFail(lateRes.error)
          ?? dbFail(stalled.error) ?? dbFail(week.error) ?? dbFail(spend.error) ?? dbFail(byType.error);
        if (f) return f;

        return jsonOk({
          role: myRole,
          counts: {
            in_production: liveRes.count ?? 0,
            waiting_on_me: mineRes.count ?? 0,
            publishing_this_week: (week.data ?? []).length,
            late: lateRes.count ?? 0,
          },
          stalled: stalled.data ?? [],
          week: week.data ?? [],
          campaigns: spend.data ?? [],
          mix: byType.data ?? [],
          week_start: weekStart,
          week_end: weekEnd,
        });
      }

      /* -------------------------------------------------------- */
      /* My work / Team work — the task queue, by role             */
      /* -------------------------------------------------------- */
      case 'work_list': {
        const scope = str(body.scope) === 'team' ? 'team' : 'mine';
        const roleRes = await sb.rpc('wassell_mos_role', { p_auth_uid: user.userId });
        const roleFail = dbFail(roleRes.error);
        if (roleFail) return roleFail;
        const myRole = (roleRes.data as string | null) ?? 'viewer';

        let q = sb.from('mos_content_v')
          .select(CONTENT_LIST_COLUMNS)
          .is('archived_at', null)
          .not('status_key', 'in', '("draft","done")');
        // 'mine' filters to the role the open task sits with. An administrator
        // has no queue of their own, so they see the team board instead of an
        // empty screen that would read as "nothing to do".
        if (scope === 'mine' && myRole !== 'administrator') q = q.eq('owner_role', myRole);

        const rows = await q.order('current_task_due_at', { ascending: true, nullsFirst: false })
          .limit(cap(body.limit, 300, 500));
        const f = dbFail(rows.error);
        if (f) return f;

        // The item's own open task carries the step id we need to name the action.
        const ids = (rows.data ?? []).map((r) => (r as unknown as Row).id);
        let tasks: unknown[] = [];
        if (ids.length > 0) {
          const t = await sb.from('mos_tasks').select('*').in('content_id', ids).eq('status', 'open');
          const tf = dbFail(t.error);
          if (tf) return tf;
          tasks = t.data ?? [];
        }
        return jsonOk({ role: myRole, content: rows.data ?? [], tasks });
      }

      /* -------------------------------------------------------- */
      /* Calendar — what is scheduled, and what is merely due       */
      /* -------------------------------------------------------- */
      case 'calendar': {
        const from = str(body.from);
        const to = str(body.to);
        if (!from || !to) return jsonError(400, 'from and to are required');

        const [pubs, due] = await Promise.all([
          sb.from('mos_publication_v')
            .select('id, content_id, platform, status, scheduled_at, published_at, caption')
            .or(`and(scheduled_at.gte.${from},scheduled_at.lte.${to}),and(published_at.gte.${from},published_at.lte.${to})`)
            .limit(500),
          sb.from('mos_content_v')
            .select('id, ref, title, content_type_key, status_key, due_at, target_publish_at, owner_role')
            .is('archived_at', null)
            .gte('due_at', from).lte('due_at', to)
            .limit(500),
        ]);
        const f = dbFail(pubs.error) ?? dbFail(due.error);
        if (f) return f;

        // Titles for the publication chips — one extra query beats N.
        const ids = Array.from(new Set((pubs.data ?? []).map((p) => (p as unknown as Row).content_id as string)));
        let titles: unknown[] = [];
        if (ids.length > 0) {
          const t = await sb.from('mos_content_v').select('id, ref, title, content_type_key').in('id', ids);
          const tf = dbFail(t.error);
          if (tf) return tf;
          titles = t.data ?? [];
        }
        return jsonOk({ publications: pubs.data ?? [], due: due.data ?? [], titles });
      }

      /* -------------------------------------------------------- */
      /* Campaigns — the spend side                                */
      /* -------------------------------------------------------- */
      case 'campaign_list': {
        const rows = await sb.from('mos_campaign_v').select('*')
          .is('archived_at', null)
          .order('starts_on', { ascending: false, nullsFirst: false })
          .limit(cap(body.limit, 200, 500));
        const f = dbFail(rows.error);
        if (f) return f;
        return jsonOk({ campaigns: rows.data ?? [] });
      }

      case 'campaign_detail': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const [item, execs, content, comments] = await Promise.all([
          sb.from('mos_campaign_v').select('*').eq('id', id).maybeSingle(),
          sb.from('mos_campaign_executions').select('*').eq('campaign_id', id)
            .order('created_at', { ascending: true }),
          sb.from('mos_content_v').select(CONTENT_LIST_COLUMNS).eq('campaign_id', id)
            .is('archived_at', null).limit(300),
          sb.from('mos_comments').select('*').eq('campaign_id', id)
            .order('created_at', { ascending: true }).limit(200),
        ]);
        const f = dbFail(item.error) ?? dbFail(execs.error) ?? dbFail(content.error) ?? dbFail(comments.error);
        if (f) return f;
        if (!item.data) return jsonError(404, 'campaign not found');
        return jsonOk({
          item: item.data,
          executions: execs.data ?? [],
          content: content.data ?? [],
          comments: comments.data ?? [],
        });
      }

      case 'campaign_save': {
        const raw = (body.campaign ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['name', 'project_id', 'objective', 'status', 'starts_on',
                         'ends_on', 'budget_total', 'note',
                         'kind', 'goal', 'owner_role', 'success_metric',
                         'success_threshold'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (id) {
          const upd = await sb.from('mos_campaigns').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'campaign not found');
        } else {
          // The design has no name field — the goal sentence IS the identity.
          // The list still wants a short handle, so the name falls back to it.
          if (!str(patch.name) && str(patch.goal)) patch.name = patch.goal;
          if (!str(patch.name)) return jsonError(400, 'goal or name is required');
          patch.created_by_user_id = await resolveAppUserId(sb, user.userId);
          const ins = await sb.from('mos_campaigns').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
          const created = ins.data as unknown as Row | null;

          // "التنفيذات التي ستُنشأ" — the modal's promise, kept server-side in
          // the same request: one DRAFT execution per chosen platform with its
          // budget share. Drafts spend nothing until someone launches them on
          // the platform itself.
          const execs = Array.isArray(body.executions) ? (body.executions as unknown[]) : [];
          if (created?.id && execs.length > 0) {
            const rows = execs
              .map((e) => e as Record<string, unknown>)
              .filter((e) => typeof e.platform === 'string' && e.platform !== '')
              .map((e) => ({
                campaign_id: created.id,
                platform: e.platform,
                label: typeof e.label === 'string' ? e.label : null,
                budget: typeof e.budget === 'number' && Number.isFinite(e.budget) ? e.budget : null,
                status: 'draft',
              }));
            if (rows.length > 0) {
              const execIns = await sb.from('mos_campaign_executions').insert(rows);
              const ef = dbFail(execIns.error);
              if (ef) return ef;
            }
          }

          const one = await sb.from('mos_campaign_v').select('*').eq('id', created?.id ?? '').maybeSingle();
          const of_ = dbFail(one.error);
          if (of_) return of_;
          return jsonOk({ item: one.data });
        }
        const one = await sb.from('mos_campaign_v').select('*').eq('id', id).maybeSingle();
        const f = dbFail(one.error);
        if (f) return f;
        return jsonOk({ item: one.data });
      }

      case 'execution_save': {
        const campaignId = str(body.campaign_id);
        if (!campaignId) return jsonError(400, 'campaign_id is required');
        const raw = (body.execution ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['content_id', 'platform', 'account_id', 'label', 'status',
                         'starts_on', 'ends_on', 'budget', 'spend', 'impressions',
                         'clicks', 'leads', 'qualified', 'note',
                         'targeting', 'lead_form_fields'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (id) {
          const upd = await sb.from('mos_campaign_executions').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'execution not found');
        } else {
          if (!str(patch.platform)) return jsonError(400, 'platform is required');
          patch.campaign_id = campaignId;
          const ins = await sb.from('mos_campaign_executions').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }
        const list = await sb.from('mos_campaign_executions').select('*')
          .eq('campaign_id', campaignId).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ executions: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Execution detail — the bottom layer, where each AD is a   */
      /* content reference + targeting + a result (screen 21)      */
      /* -------------------------------------------------------- */
      case 'execution_detail': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');

        const exec = await sb.from('mos_campaign_executions').select('*').eq('id', id).maybeSingle();
        const execFail = dbFail(exec.error);
        if (execFail) return execFail;
        if (!exec.data) return jsonError(404, 'execution not found');
        const row = exec.data as unknown as Row;

        const [campaign, ads, daily] = await Promise.all([
          sb.from('mos_campaign_v').select('*').eq('id', row.campaign_id as string).maybeSingle(),
          sb.from('mos_execution_ads').select('*').eq('execution_id', id)
            .order('created_at', { ascending: true }),
          sb.from('mos_execution_daily').select('*').eq('execution_id', id)
            .order('day', { ascending: false }).limit(90),
        ]);
        const f = dbFail(campaign.error) ?? dbFail(ads.error) ?? dbFail(daily.error);
        if (f) return f;

        // Each ad points at a content record — fetch the referenced rows so the
        // UI can show titles, types, project (for the wrong-project warning) and
        // the workflow state (for the "waiting on approval" note).
        const contentIds = Array.from(new Set(
          (ads.data ?? [])
            .map((a) => (a as unknown as Row).content_id as string | null)
            .filter((c): c is string => Boolean(c)),
        ));
        let adContent: unknown[] = [];
        if (contentIds.length > 0) {
          const c = await sb.from('mos_content_v').select(CONTENT_LIST_COLUMNS).in('id', contentIds);
          const cf = dbFail(c.error);
          if (cf) return cf;
          adContent = c.data ?? [];
        }

        return jsonOk({
          execution: exec.data,
          campaign: campaign.data,
          ads: ads.data ?? [],
          ad_content: adContent,
          daily: daily.data ?? [],
        });
      }

      case 'ad_save': {
        const executionId = str(body.execution_id);
        if (!executionId) return jsonError(400, 'execution_id is required');
        const raw = (body.ad ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['content_id', 'label', 'status', 'spend', 'impressions',
                         'clicks', 'leads', 'qualified', 'note'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (id) {
          const upd = await sb.from('mos_execution_ads').update(patch).eq('id', id).select('id').maybeSingle();
          const uf = dbFail(upd.error);
          if (uf) return uf;
          if (!upd.data) return jsonError(404, 'ad not found');
        } else {
          patch.execution_id = executionId;
          const ins = await sb.from('mos_execution_ads').insert(patch).select('id').maybeSingle();
          const inf = dbFail(ins.error);
          if (inf) return inf;
        }
        const list = await sb.from('mos_execution_ads').select('*')
          .eq('execution_id', executionId).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ ads: list.data ?? [] });
      }

      case 'ad_delete': {
        const id = str(body.id);
        const executionId = str(body.execution_id);
        if (!id || !executionId) return jsonError(400, 'id and execution_id are required');
        const del = await sb.from('mos_execution_ads').delete().eq('id', id);
        const df = dbFail(del.error);
        if (df) return df;
        const list = await sb.from('mos_execution_ads').select('*')
          .eq('execution_id', executionId).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ ads: list.data ?? [] });
      }

      case 'daily_save': {
        const executionId = str(body.execution_id);
        const day = str(body.day);
        if (!executionId || !day) return jsonError(400, 'execution_id and day are required');
        const numOrNull = (v: unknown): number | null =>
          typeof v === 'number' && Number.isFinite(v) ? v : null;
        const spend = numOrNull(body.spend);
        const leads = numOrNull(body.leads);
        const qualified = numOrNull(body.qualified);
        // Mirrors mos_exec_daily_not_empty so the user gets a sentence.
        if (spend === null && leads === null && qualified === null) {
          return new Response(
            JSON.stringify({
              error: 'Enter at least one number for the day.',
              error_ar: 'أدخل رقمًا واحدًا على الأقل لليوم.',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          );
        }
        const up = await sb.from('mos_execution_daily').upsert(
          {
            execution_id: executionId,
            day,
            spend,
            leads,
            qualified,
            entered_by_user_id: await resolveAppUserId(sb, user.userId),
          },
          { onConflict: 'execution_id,day' },
        );
        const uf = dbFail(up.error);
        if (uf) return uf;
        const list = await sb.from('mos_execution_daily').select('*')
          .eq('execution_id', executionId).order('day', { ascending: false }).limit(90);
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ daily: list.data ?? [] });
      }

      case 'execution_delete': {
        const id = str(body.id);
        const campaignId = str(body.campaign_id);
        if (!id || !campaignId) return jsonError(400, 'id and campaign_id are required');
        const del = await sb.from('mos_campaign_executions').delete().eq('id', id);
        const f = dbFail(del.error);
        if (f) return f;
        const list = await sb.from('mos_campaign_executions').select('*')
          .eq('campaign_id', campaignId).order('created_at', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ executions: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Assets — the material library                             */
      /* -------------------------------------------------------- */
      case 'asset_list': {
        let q = sb.from('mos_assets').select('*').is('archived_at', null);
        const kind = str(body.kind);
        const projectId = str(body.project_id);
        const search = str(body.q);
        if (kind) q = q.eq('kind', kind);
        if (projectId) q = q.eq('project_id', projectId);
        if (search) q = q.ilike('title', `%${search}%`);
        const rows = await q.order('created_at', { ascending: false }).limit(cap(body.limit, 200, 500));
        const f = dbFail(rows.error);
        if (f) return f;

        // Usage comes from the link table, so "unused" is a fact rather than a
        // counter somebody has to remember to decrement.
        const links = await sb.from('mos_asset_links').select('asset_id, content_id, role').limit(2000);
        const lf = dbFail(links.error);
        if (lf) return lf;
        return jsonOk({ assets: rows.data ?? [], links: links.data ?? [] });
      }

      case 'asset_save': {
        const raw = (body.asset ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['title', 'kind', 'source', 'project_id', 'file_id', 'url',
                         'thumb_url', 'shot_on', 'tags', 'note',
                         'file_path', 'mime_type', 'size_bytes', 'original_name',
                         'usage_rights'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (id) {
          const upd = await sb.from('mos_assets').update(patch).eq('id', id).select('*').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'asset not found');
          return jsonOk({ asset: upd.data });
        }
        if (!str(patch.title)) return jsonError(400, 'title is required');
        patch.created_by_user_id = await resolveAppUserId(sb, user.userId);
        const ins = await sb.from('mos_assets').insert(patch).select('*').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;
        return jsonOk({ asset: ins.data });
      }

      case 'asset_delete': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        // Archive rather than destroy: an asset referenced by shipped content
        // should stop appearing without breaking the record of what was used.
        const upd = await sb.from('mos_assets')
          .update({ archived_at: new Date().toISOString() }).eq('id', id).select('id').maybeSingle();
        const f = dbFail(upd.error);
        if (f) return f;
        if (!upd.data) return jsonError(404, 'asset not found');
        return jsonOk({ ok: true });
      }

      case 'asset_link': {
        const assetId = str(body.asset_id);
        const contentId = str(body.content_id);
        if (!assetId || !contentId) return jsonError(400, 'asset_id and content_id are required');
        const role = str(body.role) ?? 'source';
        const up = await sb.from('mos_asset_links')
          .upsert({ asset_id: assetId, content_id: contentId, role }, { onConflict: 'asset_id,content_id' });
        const f = dbFail(up.error);
        if (f) return f;
        const list = await sb.from('mos_asset_links').select('asset_id, content_id, role').eq('content_id', contentId);
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ links: list.data ?? [] });
      }

      case 'asset_unlink': {
        const assetId = str(body.asset_id);
        const contentId = str(body.content_id);
        if (!assetId || !contentId) return jsonError(400, 'asset_id and content_id are required');
        const del = await sb.from('mos_asset_links').delete()
          .eq('asset_id', assetId).eq('content_id', contentId);
        const f = dbFail(del.error);
        if (f) return f;
        const list = await sb.from('mos_asset_links').select('asset_id, content_id, role').eq('content_id', contentId);
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ links: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Shoot requests — what missing scenes turn into            */
      /* -------------------------------------------------------- */
      case 'shoot_list': {
        const [reqs, items] = await Promise.all([
          sb.from('mos_shoot_requests').select('*')
            .order('created_at', { ascending: false }).limit(cap(body.limit, 100, 300)),
          sb.from('mos_shoot_items').select('*').limit(1000),
        ]);
        const f = dbFail(reqs.error) ?? dbFail(items.error);
        if (f) return f;

        // Every scene still marked missing, whether or not it has been requested
        // yet — the backlog IS the pending shoot list.
        const missing = await sb.from('mos_scenes')
          .select('id, content_id, position, visual, footage_status')
          .eq('footage_status', 'missing').limit(500);
        const mf = dbFail(missing.error);
        if (mf) return mf;

        const contentIds = Array.from(new Set((missing.data ?? [])
          .map((s) => (s as unknown as Row).content_id as string)));
        let owners: unknown[] = [];
        if (contentIds.length > 0) {
          const o = await sb.from('mos_content_v')
            .select('id, ref, title, project_id, content_type_key').in('id', contentIds);
          const of_ = dbFail(o.error);
          if (of_) return of_;
          owners = o.data ?? [];
        }
        return jsonOk({
          requests: reqs.data ?? [],
          items: items.data ?? [],
          missing_scenes: missing.data ?? [],
          scene_owners: owners,
        });
      }

      case 'shoot_save': {
        const raw = (body.request ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['title', 'project_id', 'status', 'scheduled_at',
                         'location', 'note', 'assigned_role'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        let requestId = id;
        if (id) {
          const upd = await sb.from('mos_shoot_requests').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'shoot request not found');
        } else {
          if (!str(patch.title)) return jsonError(400, 'title is required');
          patch.requested_by_user_id = await resolveAppUserId(sb, user.userId);
          const ins = await sb.from('mos_shoot_requests').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
          requestId = (ins.data as unknown as Row | null)?.id ?? null;

          // Requests raised from the shoot backlog carry their scenes with them,
          // so the person filming sees the actual shot list.
          const scenes = Array.isArray(body.scene_ids) ? (body.scene_ids as unknown[]) : [];
          if (requestId && scenes.length > 0) {
            const sceneRows = await sb.from('mos_scenes')
              .select('id, content_id, visual, position')
              .in('id', scenes.filter((s): s is string => typeof s === 'string'));
            const sf = dbFail(sceneRows.error);
            if (sf) return sf;
            const payload = (sceneRows.data ?? []).map((s) => {
              const sc = s as unknown as Row;
              return {
                request_id: requestId,
                scene_id: sc.id,
                content_id: sc.content_id,
                description: (sc.visual as string | null) ?? `#${String(sc.position)}`,
              };
            });
            if (payload.length > 0) {
              const itemsIns = await sb.from('mos_shoot_items').insert(payload);
              const itf = dbFail(itemsIns.error);
              if (itf) return itf;
            }
          }
        }
        const list = await sb.from('mos_shoot_requests').select('*')
          .order('created_at', { ascending: false }).limit(300);
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ requests: list.data ?? [], request_id: requestId });
      }

      case 'shoot_item_toggle': {
        const id = str(body.id);
        if (!id) return jsonError(400, 'id is required');
        const done = body.done === true;
        const upd = await sb.from('mos_shoot_items').update({ done }).eq('id', id).select('*').maybeSingle();
        const f = dbFail(upd.error);
        if (f) return f;
        if (!upd.data) return jsonError(404, 'shoot item not found');
        return jsonOk({ item: upd.data });
      }

      /* -------------------------------------------------------- */
      /* Comments — the thread                                     */
      /* -------------------------------------------------------- */
      case 'comment_add': {
        const contentId = str(body.content_id);
        const campaignId = str(body.campaign_id);
        const bodyText = str(body.body);
        if (!bodyText) return jsonError(400, 'body is required');
        if (!contentId && !campaignId) return jsonError(400, 'content_id or campaign_id is required');
        const ins = await sb.from('mos_comments').insert({
          content_id: contentId,
          campaign_id: campaignId,
          body: bodyText,
          author_user_id: await resolveAppUserId(sb, user.userId),
        }).select('id').maybeSingle();
        const f = dbFail(ins.error);
        if (f) return f;

        let q = sb.from('mos_comments').select('*').order('created_at', { ascending: true }).limit(200);
        q = contentId ? q.eq('content_id', contentId) : q.eq('campaign_id', campaignId ?? '');
        const list = await q;
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ comments: list.data ?? [] });
      }

      case 'comment_list': {
        const contentId = str(body.content_id);
        const campaignId = str(body.campaign_id);
        if (!contentId && !campaignId) return jsonError(400, 'content_id or campaign_id is required');
        let q = sb.from('mos_comments').select('*').order('created_at', { ascending: true }).limit(200);
        q = contentId ? q.eq('content_id', contentId) : q.eq('campaign_id', campaignId ?? '');
        const list = await q;
        const f = dbFail(list.error);
        if (f) return f;
        return jsonOk({ comments: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Settings — workflows, steps, types, platforms             */
      /* -------------------------------------------------------- */
      case 'settings_data': {
        const [workflows, steps, types, accounts] = await Promise.all([
          sb.from('mos_workflows').select('*').is('archived_at', null).order('key', { ascending: true }),
          sb.from('mos_workflow_steps').select('*').order('position', { ascending: true }),
          sb.from('mos_content_types').select('*').is('archived_at', null)
            .order('sort_order', { ascending: true }),
          sb.from('mos_platform_accounts').select('*').is('archived_at', null)
            .order('sort_order', { ascending: true }),
        ]);
        const f = dbFail(workflows.error) ?? dbFail(steps.error)
          ?? dbFail(types.error) ?? dbFail(accounts.error);
        if (f) return f;
        return jsonOk({
          workflows: workflows.data ?? [],
          steps: steps.data ?? [],
          content_types: types.data ?? [],
          accounts: accounts.data ?? [],
        });
      }

      case 'step_save': {
        const raw = (body.step ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['workflow_id', 'position', 'key', 'label_ar', 'label_en', 'role',
                         'due_days', 'is_approval', 'approval_kind'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (id) {
          const upd = await sb.from('mos_workflow_steps').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'step not found');
        } else {
          if (!str(patch.workflow_id)) return jsonError(400, 'workflow_id is required');
          const ins = await sb.from('mos_workflow_steps').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }
        const list = await sb.from('mos_workflow_steps').select('*').order('position', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ steps: list.data ?? [] });
      }

      case 'content_type_save': {
        const raw = (body.content_type ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['key', 'label_ar', 'label_en', 'prefix', 'workflow_id',
                         'field_schema', 'sort_order', 'is_active'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        if (id) {
          const upd = await sb.from('mos_content_types').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'content type not found');
        } else {
          if (!str(patch.key) || !str(patch.prefix)) return jsonError(400, 'key and prefix are required');
          const ins = await sb.from('mos_content_types').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }
        const list = await sb.from('mos_content_types').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ content_types: list.data ?? [] });
      }

      case 'account_save': {
        const raw = (body.account ?? {}) as Record<string, unknown>;
        const id = str(raw.id);
        const patch: Record<string, unknown> = {};
        for (const k of ['platform', 'handle', 'label_ar', 'label_en', 'sort_order'] as const) {
          if (Object.prototype.hasOwnProperty.call(raw, k)) patch[k] = raw[k];
        }
        // `is_connected` / `can_publish` / `can_read_metrics` are deliberately NOT
        // editable here. Publishing stays manual until a real OAuth flow sets them;
        // a checkbox that claims a connection would be a lie in the UI.
        if (id) {
          const upd = await sb.from('mos_platform_accounts').update(patch).eq('id', id).select('id').maybeSingle();
          const f = dbFail(upd.error);
          if (f) return f;
          if (!upd.data) return jsonError(404, 'account not found');
        } else {
          if (!str(patch.platform)) return jsonError(400, 'platform is required');
          const ins = await sb.from('mos_platform_accounts').insert(patch).select('id').maybeSingle();
          const f = dbFail(ins.error);
          if (f) return f;
        }
        const list = await sb.from('mos_platform_accounts').select('*').is('archived_at', null)
          .order('sort_order', { ascending: true });
        const lf = dbFail(list.error);
        if (lf) return lf;
        return jsonOk({ accounts: list.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Projects — names for the brief, from the live CRM          */
      /* -------------------------------------------------------- */
      case 'projects_list': {
        const rows = await sb.from('v_all_projects').select('id, project_name')
          .order('project_name', { ascending: true }).limit(1000);
        const f = dbFail(rows.error);
        if (f) return f;
        return jsonOk({ projects: rows.data ?? [] });
      }

      /* -------------------------------------------------------- */
      /* Weekly numbers — everything published that has no reading  */
      /* since the given date. This is the Friday data-entry queue. */
      /* -------------------------------------------------------- */
      case 'metrics_queue': {
        const since = str(body.since)
          ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
        const pubs = await sb.from('mos_publication_v').select('*')
          .eq('status', 'published')
          .order('published_at', { ascending: false })
          .limit(cap(body.limit, 200, 500));
        const f = dbFail(pubs.error);
        if (f) return f;

        const rows = (pubs.data ?? []) as unknown as Array<Row & { latest_captured_at: string | null }>;
        const ids = Array.from(new Set(rows.map((p) => p.content_id as string)));
        let titles: unknown[] = [];
        if (ids.length > 0) {
          const t = await sb.from('mos_content_v').select('id, ref, title, content_type_key').in('id', ids);
          const tf = dbFail(t.error);
          if (tf) return tf;
          titles = t.data ?? [];
        }
        return jsonOk({ publications: rows, titles, since });
      }

      /* -------------------------------------------------------- */
      /* Search — one box, three kinds of object                   */
      /* -------------------------------------------------------- */
      case 'search': {
        const raw = str(body.q);
        // PostgREST's `or=` is a comma/parenthesis-delimited grammar, so a term
        // containing those characters would produce a malformed filter rather
        // than a search. Strip them instead of shipping a broken query.
        const term = raw ? raw.replace(/[(),*]/g, ' ').trim() : null;
        if (!term) return jsonOk({ content: [], campaigns: [], assets: [] });
        const like = `%${term}%`;
        const [content, campaigns, assets] = await Promise.all([
          sb.from('mos_content_v').select(CONTENT_LIST_COLUMNS)
            .is('archived_at', null).or(`title.ilike.${like},ref.ilike.${like}`).limit(40),
          sb.from('mos_campaign_v').select('*')
            .is('archived_at', null).or(`name.ilike.${like},ref.ilike.${like}`).limit(20),
          sb.from('mos_assets').select('*')
            .is('archived_at', null).or(`title.ilike.${like},ref.ilike.${like}`).limit(20),
        ]);
        const f = dbFail(content.error) ?? dbFail(campaigns.error) ?? dbFail(assets.error);
        if (f) return f;
        return jsonOk({
          content: content.data ?? [],
          campaigns: campaigns.data ?? [],
          assets: assets.data ?? [],
        });
      }

      default:
        return jsonError(400, `unknown action: ${action}`);
    }
  });
}

/**
 * Saturday→Friday week containing `iso` (or today). The Saudi working week
 * starts on Sunday, but the publishing week the team plans around runs to
 * Friday, which is the day the numbers get entered.
 */
function weekBounds(iso: string | null): { weekStart: string; weekEnd: string } {
  const base = iso ? new Date(iso) : new Date();
  const day = base.getUTCDay(); // 0 = Sunday
  const start = new Date(base);
  start.setUTCDate(base.getUTCDate() - day);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { weekStart: start.toISOString(), weekEnd: end.toISOString() };
}
