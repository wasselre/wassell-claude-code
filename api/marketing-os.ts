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

      default:
        return jsonError(400, `unknown action: ${action}`);
    }
  });
}
