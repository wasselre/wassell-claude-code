/**
 * The ROW, client side.
 *
 * A row is three posts that move together: one task to work, one task to
 * approve, three slots on ONE day. Everything a pane needs to render one comes
 * back from a single `row_detail` call — the row's facts, its members with
 * their writing, the pinned steps, the material SCOPED TO THOSE MEMBERS, the
 * approvals already bound, the publications behind the preflight, and last
 * week's row of the same project.
 *
 * Deliberately its own module rather than more of `client.ts`: it shares that
 * file's transport (`mosCall`) and its row types, and nothing else. Row work
 * arrived long after the content vocabulary settled, and a row is not a content
 * item — `content_id` is NULL on a row task, which is exactly the shape that
 * makes an old reader skip it safely.
 */
import {
  MosApiError, MosAsset, MosAssetLink, MosContentRow, MosManualTask, MosPublication,
  MosRole, MosStep, MosUpcoming, mosCall, completeTask,
  type AutoAdOutcome,
} from './client';

/**
 * What a row pane is showing: a whole ROW, or ONE content item treated as a row
 * of one (a paid creative, or any single item). The faces are the same; what
 * differs is how the work is completed — see `completeSubjectTask`.
 */
export type MosRowSubject = { kind: 'row'; row_id: string } | { kind: 'item'; content_id: string };

/* ------------------------------------------------------------------ */
/* shapes                                                             */
/* ------------------------------------------------------------------ */

/** `mos_row_summary` — the row's own facts. */
export interface MosRowFacts {
  row_id: string;
  kind: 'organic_row' | 'paid_batch' | 'general_row' | string;
  /** The day all three posts go out. Null only on a row nothing scheduled yet. */
  batch_day: string | null;
  row_key: string | null;
  campaign_id: string | null;
  /** NULL on the Saturday general row — it belongs to no project by design. */
  project_id: string | null;
  plan_id: string | null;
  workflow_version_id: string | null;
  member_count: number;
  member_ids: string[];
}

/**
 * A row member: a content row plus the two things a list never carries — its
 * writing (`data`) and its place in the reading order.
 */
export interface MosRowMember extends MosContentRow {
  row_id: string | null;
  row_order: number | null;
  data: Record<string, unknown>;
  caption: string | null;
  caption_confirmed: boolean | null;
  created_at?: string;
  current_step_key?: string | null;
  open_task_id?: string | null;
}

/**
 * A task whose subject may be a ROW. `content_id` is null exactly when
 * `subject_table === 'mos_content_rows'`; `row_id` is the mirror of that.
 */
export interface MosSubjectTask {
  id: string;
  content_id: string | null;
  subject_table: 'mos_content' | 'mos_content_rows' | string;
  subject_id: string;
  row_id: string | null;
  step_id: string | null;
  role: MosRole;
  assignee_user_id: string | null;
  status: 'open' | 'done' | 'skipped';
  result: 'submitted' | 'approved' | 'changes_requested' | null;
  note: string | null;
  round: number;
  opened_at: string;
  due_at: string | null;
  /** When the current holder received it; its deadline counts from here. */
  assigned_at?: string | null;
  /** Capacity units: a row counts its posts, anything else 1. */
  units?: number | null;
  /** Open but not handed out yet — nobody eligible has room (see waiting_reason). */
  waiting_since?: string | null;
  waiting_reason?: 'capacity' | 'no_holder' | 'inactive' | string | null;
  closed_at: string | null;
  closed_by_user_id?: string | null;
  revision_targets?: string[];
  is_approval?: boolean;
  approval_kind?: 'creative' | 'process' | 'budget' | null;
}

/** One binding made at an approval — what was approved, and its fingerprints. */
export interface MosContentApproval {
  id: string;
  content_id: string;
  step_key: string;
  round: number;
  approved_by_user_id: string | null;
  approved_at: string;
  writing_hash: string | null;
  design_hash: string | null;
  caption_hash: string | null;
  package_hash: string | null;
}

export interface MosRowDetail {
  subject: MosRowSubject;
  row: MosRowFacts;
  /** In the WRITER's reading order. Publish order is its reverse. */
  members: MosRowMember[];
  /** The steps pinned on the ROW — never the workflow's current definition. */
  steps: MosStep[];
  /** The row's open task, or null when the row is between stages. */
  task: MosSubjectTask | null;
  /** Every task the row has ever carried, newest first — the history strip. */
  row_tasks: MosSubjectTask[];
  /** Open tasks on individual members (a per-post revision in flight). */
  member_tasks: MosSubjectTask[];
  assets: MosAsset[];
  links: MosAssetLink[];
  approvals: MosContentApproval[];
  publications: MosPublication[];
  /** Last week's row of the same project — for the visual comparison only. */
  previous_row: { row_id: string; members: MosRowMember[] } | null;
}

/* ------------------------------------------------------------------ */
/* calls                                                              */
/* ------------------------------------------------------------------ */

/** One trip. Address by row id, or by the task id a notification carried. */
export const fetchRowDetail = (ref: { rowId?: string | null; taskId?: string | null }) =>
  mosCall<MosRowDetail>('row_detail', {
    ...(ref.rowId ? { row_id: ref.rowId } : {}),
    ...(ref.taskId ? { task_id: ref.taskId } : {}),
  });

/**
 * Fix the reading order. Refused server-side once the designs are keyed to it,
 * so the final-approval pane's read-only order is enforced, not just drawn.
 */
/** One content item in the row screens' shape (`item_detail`). */
export const fetchItemDetail = (contentId: string) =>
  mosCall<MosRowDetail>('item_detail', { content_id: contentId });

export const saveRowOrder = (rowId: string, orderedIds: string[]) =>
  mosCall<{ row_id: string; ordered_ids: string[] }>('row_order_save', {
    row_id: rowId, ordered_ids: orderedIds,
  });

/**
 * The queue, with its ROW cards.
 *
 * `work_list` became person-keyed and row-aware (C8) and now returns `rows` and
 * `ledger` alongside everything it always returned. `fetchWork` in `client.ts`
 * still types only the older half, and every one of its five other callers
 * wants exactly that half — so the row-aware read is its own function rather
 * than a widening that would make five screens carry fields they never use.
 * One action, two typed views of it.
 */
export interface MosWorkQueue {
  role: MosRole;
  /** The posts behind the queue's tasks — a row's three members included. */
  content: MosContentRow[];
  tasks: MosSubjectTask[];
  upcoming: MosUpcoming[];
  manual_tasks: MosManualTask[];
  /** One entry per ROW task in the queue — a row card, not a post card. */
  rows: MosRowFacts[];
  scope: 'mine' | 'team';
  me_user_id: string | null;
}

export const fetchWorkQueue = (scope: 'mine' | 'team') =>
  mosCall<MosWorkQueue>('work_list', { scope });

export interface RowAdvanceResult {
  row_id: string;
  closed_task_id: string;
  opened_task_id: string | null;
  next_step_key: string | null;
  round: number;
  done: boolean;
}

/**
 * Advance the row: submit it, approve it, or send it back.
 *
 * `targets` carries the MEMBER dimension — `post:<content_id>` for a whole post
 * and `post:<content_id>:<field>` for one field of it — so a send-back names
 * which of the three needs changing and the other two are left exactly as they
 * were. There is no partial-approval state: the row returns once, carrying the
 * list.
 */
export const completeRowTask = (
  args: {
    rowId?: string | null;
    taskId?: string | null;
    result: 'submitted' | 'approved' | 'changes_requested';
    note?: string;
    targets?: string[];
    returnTo?: string | null;
  },
) => mosCall<RowAdvanceResult>('row_task_complete', {
  ...(args.rowId ? { row_id: args.rowId } : {}),
  ...(args.taskId ? { task_id: args.taskId } : {}),
  result: args.result,
  ...(args.note ? { note: args.note } : {}),
  ...(args.targets && args.targets.length > 0 ? { targets: args.targets } : {}),
  ...(args.returnTo ? { return_to: args.returnTo } : {}),
});

/** What every face needs back from a completion, whichever subject it was. */
export interface SubjectAdvanceResult {
  opened_task_id: string | null;
  done: boolean;
  /** Present only when a single item's approved step carried `auto_meta_ad`. */
  auto_ad?: AutoAdOutcome | null;
}

/**
 * Complete the open task of whatever the pane is showing.
 *
 *   • a ROW → `row_task_complete` (the subject is `mos_content_rows`);
 *   • an ITEM → `task_complete` (the subject is `mos_content`).
 *
 * The item path is LOAD-BEARING, not a convenience: `task_complete` is where
 * the Meta ad is created when the approved step carries `auto_meta_ad`, and
 * `adSetId` is how the manager's ad-set choice reaches it. An item must never be
 * completed through the row action.
 *
 * Send-back targets arrive in the row dialog's shape — `post:<id>` for a whole
 * post, `post:<id>:<field>` for one field. A single task names FIELDS, so the
 * field is kept and a whole-post target (which, for one item, is the item
 * itself) contributes nothing. A target already in field form passes through.
 */
export async function completeSubjectTask(
  detail: Pick<MosRowDetail, 'subject' | 'task'>,
  args: {
    taskId?: string | null;
    result: 'submitted' | 'approved' | 'changes_requested';
    note?: string;
    targets?: string[];
    returnTo?: string | null;
    adSetId?: string | null;
  },
): Promise<SubjectAdvanceResult> {
  const taskId = args.taskId ?? detail.task?.id ?? null;
  if (detail.subject.kind === 'row') {
    const r = await completeRowTask({
      rowId: detail.subject.row_id,
      taskId,
      result: args.result,
      note: args.note,
      targets: args.targets,
      returnTo: args.returnTo,
    });
    return { opened_task_id: r.opened_task_id, done: r.done };
  }
  if (!taskId) throw new Error('This item has no open task to complete.');
  const fields = (args.targets ?? [])
    .map((t) => {
      if (!t.startsWith('post:')) return t;
      const parts = t.split(':');
      return parts.length >= 3 ? parts.slice(2).join(':') : null;
    })
    .filter((x): x is string => !!x);
  const r = await completeTask(
    taskId, args.result, args.note, fields.length > 0 ? fields : undefined,
    { adSetId: args.adSetId ?? null, returnTo: args.returnTo ?? null },
  );
  return { opened_task_id: r.opened_task_id, done: r.done, auto_ad: r.auto_ad ?? null };
}

/* ------------------------------------------------------------------ */
/* the refusal                                                        */
/* ------------------------------------------------------------------ */

/**
 * One requirement the engine refused on, already named by the server so the two
 * never disagree about what `final_vertical` is called in Arabic.
 */
export interface MosMissingRequirement {
  /** The post it belongs to (`P-152`), or null when the subject is one item. */
  member: string | null;
  key: string;
  label_ar: string;
  label_en: string;
}

/**
 * `MOS:REQUIREMENTS_MISSING`, recovered as structure.
 *
 * The engine names the offending member and slot; without this the designer
 * sees «رفضت قاعدة البيانات هذا التغيير» and has to ask the manager which of
 * six files is missing. Returns null for every other failure, which then
 * surfaces as itself.
 */
export function missingRequirementsOf(e: unknown): MosMissingRequirement[] | null {
  if (!(e instanceof MosApiError)) return null;
  if (e.payload.code !== 'requirements_missing') return null;
  const raw = e.payload.missing;
  if (!Array.isArray(raw)) return null;
  const out: MosMissingRequirement[] = [];
  for (const item of raw) {
    const r = (item ?? {}) as Record<string, unknown>;
    if (typeof r.key !== 'string') continue;
    out.push({
      member: typeof r.member === 'string' ? r.member : null,
      key: r.key,
      label_ar: typeof r.label_ar === 'string' ? r.label_ar : r.key,
      label_en: typeof r.label_en === 'string' ? r.label_en : r.key,
    });
  }
  return out.length > 0 ? out : null;
}

/* ------------------------------------------------------------------ */
/* reading a row without asking the server again                      */
/* ------------------------------------------------------------------ */

/** The two design slots every post ships with. */
export const ROW_SLOT_ROLES = ['final_square', 'final_vertical'] as const;
export type RowSlotRole = (typeof ROW_SLOT_ROLES)[number];

/** The asset link filling one slot of one member, or null. */
export function slotLink(
  links: MosAssetLink[], contentId: string, role: RowSlotRole,
): MosAssetLink | null {
  return links.find((l) => l.content_id === contentId && l.role === role) ?? null;
}

/**
 * Where the row stands, as something a pane can branch on without knowing any
 * step key. A rename of `design` or `design_review` must not change behaviour,
 * so the rule is structural: an approval with no file-bearing step before it is
 * the WRITING review; one that comes after is the FINAL approval.
 *
 * Twin of `faceOfStep` in `api/_lib/marketing/rowTasks.ts` — the server uses it
 * to gate the order edit, the client to choose a pane. Change both together.
 */
export type RowFace = 'writing' | 'design' | 'writing_review' | 'final_approval' | 'other';

export function rowFaceOf(steps: MosStep[], stepKey: string | null | undefined): RowFace {
  if (!stepKey) return 'other';
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const idx = ordered.findIndex((s) => s.key === stepKey);
  if (idx < 0) return 'other';
  const step = ordered[idx];
  if (!step) return 'other';
  // A version pinned before steps carried requirement lists (a legacy item
  // still walking its old chain) has neither list, so its design and writing
  // steps are recognised by KEY as well — otherwise it would fall to 'other' and
  // the only screen left for it would be read-only.
  const isDesign = (s: MosStep): boolean =>
    !s.is_approval && ((s.required_files ?? []).length > 0 || s.key === 'design');
  const designBefore = ordered.slice(0, idx).some(isDesign);
  if (step.is_approval) return designBefore ? 'final_approval' : 'writing_review';
  if (isDesign(step)) return 'design';
  if ((step.required_fields ?? []).length > 0 || step.key === 'writing') return 'writing';
  return 'other';
}

/**
 * What the ENGINE would refuse this row for, computed from what the pane
 * already has.
 *
 * This is a prediction, not an authority: `workflow_advance_role_path` refuses
 * independently and its answer is the one that counts. But a submit button that
 * is only honest after you press it is a bad button, so the prediction has to
 * be the SAME rule — read off the PINNED step's own `required_fields` /
 * `required_files`, never a hardcoded list. A step that requires nothing blocks
 * nothing, which is exactly what the writing review and the final approval do.
 *
 * The field test mirrors SQL's `data ->> key`: absent or null is missing, and a
 * string is missing when it trims to empty. An array or object serialises to
 * non-empty text and therefore counts as present — the same (deliberate)
 * looseness the engine has, so the two can never disagree.
 */
export function missingForStep(
  detail: Pick<MosRowDetail, 'members' | 'links'>,
  step: Pick<MosStep, 'required_fields' | 'required_files'> | null | undefined,
): Array<{ member: MosRowMember; key: string }> {
  if (!step) return [];
  const fields = step.required_fields ?? [];
  const files = step.required_files ?? [];
  const out: Array<{ member: MosRowMember; key: string }> = [];
  for (const m of detail.members) {
    const data = m.data ?? {};
    for (const key of fields) {
      const raw = data[key];
      const missing = raw === undefined || raw === null
        || (typeof raw === 'string' && raw.trim() === '');
      if (missing) out.push({ member: m, key });
    }
    // A step that requires `caption` also requires the writer to have confirmed
    // THAT EXACT text — an AI draft is never pre-confirmed.
    if (fields.includes('caption')) {
      const caption = data.caption;
      const confirmed = data.caption_confirmed_text;
      if (typeof caption !== 'string' || confirmed !== caption) {
        out.push({ member: m, key: 'caption_confirmed' });
      }
    }
    for (const role of files) {
      const has = detail.links.some((l) => l.content_id === m.id && l.role === role);
      if (!has) out.push({ member: m, key: role });
    }
  }
  return out;
}

/**
 * The publish position of a post, 1-based from the top of the batch.
 *
 * The writer's FIRST-read post publishes LAST: Instagram shows the newest first,
 * so the reverse of the reading order is what lands the profile grid the way the
 * writer composed it. One function so no screen re-derives it wrongly.
 */
export function publishPosition(index: number, total: number): number {
  return total - index;
}

/* ── the writing, read off a member ─────────────────────────────────── */

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The ordered lines that land ON the design — 3 to 6, as many as it needs. */
export function headlinesOf(member: { data?: Record<string, unknown> }): string[] {
  const raw = member.data?.headlines;
  if (Array.isArray(raw)) return raw.map(asString).filter((s) => s.trim() !== '');
  const one = asString(raw).trim();
  return one ? [one] : [];
}

export function designBriefOf(member: { data?: Record<string, unknown> }): string {
  return asString(member.data?.design_brief).trim();
}

export function hashtagsOf(member: { data?: Record<string, unknown> }): string[] {
  const raw = member.data?.hashtags;
  if (Array.isArray(raw)) return raw.map(asString).filter((s) => s.trim() !== '');
  return asString(raw).split(/\s+/).filter((s) => s.trim() !== '');
}

/** Who wrote the caption: the AI (and merely accepted), or a person. */
export function captionSourceOf(
  member: { data?: Record<string, unknown> },
): 'ai' | 'fallback' | 'human' | null {
  const s = asString(member.data?.caption_source);
  if (s === 'ai' || s === 'fallback') return s;
  return asString(member.data?.caption).trim() ? 'human' : null;
}

/**
 * The caption, and whether the writer confirmed THAT EXACT text.
 *
 * `caption_confirmed` on the view already answers it; this repeats the rule for
 * the member shapes that do not come from the view (a freshly patched local
 * copy), so a pane never shows a stale green tick.
 */
export function captionStateOf(
  member: { data?: Record<string, unknown>; caption_confirmed?: boolean | null },
): { text: string; confirmed: boolean } {
  const text = asString(member.data?.caption).trim();
  const confirmedText = asString(member.data?.caption_confirmed_text).trim();
  const confirmed = text !== '' && confirmedText === text;
  return { text, confirmed };
}
