/**
 * The ONE place that decides where a content item, a workflow step, or a task
 * SENDS you inside the Marketing workspace.
 *
 * Before this module every surface answered that question for itself, and they
 * disagreed. The preview popup sent a finished item to «المواد» while the
 * content page's own auto-tab sent it to «المواضع»; notification producers
 * emitted `?tab=publish`, a tab that does not exist; and the content page fed a
 * step UUID into a resolver that matches on the step KEY, so its auto-tab
 * silently fell through to «المحتوى» for every item in the system.
 *
 * URL shape: `/m/content/:id?tab=<tab>&step=<step_key>`.
 *   - `step` is ALWAYS a workflow step KEY. Never a UUID: keys are stable data
 *     the operator authors in Settings → Workflows, ids are re-minted whenever
 *     a workflow version is pinned.
 *   - A FINISHED item always lands on `?tab=materials&step=materials_final`,
 *     from every surface, with no exceptions.
 *
 * TWIN FILE — `api/_lib/marketing/routes.ts` is the server half of this, used
 * by every notification / worker / task producer. The two must agree link for
 * link: a notification that opens a different tab than an in-app click on the
 * same thing is the bug this pair exists to prevent. Change both together.
 */

/** The tabs `ContentDetailPage` renders. `publish` is REMAPPED, never emitted. */
export type ContentTab =
  | 'overview' | 'content' | 'placements' | 'materials'
  | 'project_assets' | 'project_info' | 'tasks' | 'performance' | 'creative';

/** The exact working area a step, a task or a link drops the reader into. */
export type ContentSection =
  | 'writing' | 'writing_review' | 'design_upload' | 'design_review_writer'
  | 'final_review' | 'caption' | 'schedule' | 'publish_check'
  | 'materials_final' | 'overview';

/**
 * The subset of a pinned workflow step the resolver reads. `MosStep` carries
 * `role`, `StepDef` carries `role_key` — either is accepted so a caller can
 * hand over whichever list it already has.
 */
export interface RouteStep {
  key: string;
  is_approval?: boolean | null;
  role?: string | null;
  role_key?: string | null;
}

/** Roles whose non-approval work IS the design half of production. */
const PRODUCTION_ROLES: ReadonlySet<string> = new Set(['montage', 'ops_supervisor']);

const SECTION_TAB: Record<ContentSection, ContentTab> = {
  writing: 'content',
  writing_review: 'content',
  caption: 'content',
  design_upload: 'materials',
  design_review_writer: 'materials',
  final_review: 'materials',
  materials_final: 'materials',
  schedule: 'placements',
  publish_check: 'placements',
  overview: 'overview',
};

/** Bilingual names for the sections — headings, breadcrumbs, task subtitles. */
export const SECTION_LABELS: Record<ContentSection, { ar: string; en: string }> = {
  writing:              { ar: 'الكتابة',              en: 'Writing' },
  writing_review:       { ar: 'مراجعة النص',          en: 'Copy review' },
  design_upload:        { ar: 'رفع التصميم',          en: 'Design upload' },
  design_review_writer: { ar: 'مراجعة الكاتب للتصميم', en: 'Writer’s design review' },
  final_review:         { ar: 'الاعتماد النهائي',      en: 'Final approval' },
  caption:              { ar: 'الكابشن',              en: 'Caption' },
  schedule:             { ar: 'الجدولة',              en: 'Scheduling' },
  publish_check:        { ar: 'تأكيد النشر',          en: 'Publish check' },
  materials_final:      { ar: 'المواد النهائية',       en: 'Final materials' },
  overview:             { ar: 'نظرة عامة',            en: 'Overview' },
};

/** The section a finished item always resolves to, from every surface. */
export const DONE_SECTION: ContentSection = 'materials_final';

/** Statuses `mos_content_v` invents when there is no open workflow step. */
const SYNTHETIC_STATUS: ReadonlySet<string> = new Set(['draft', 'done', 'unassigned']);

export function tabForSection(section: ContentSection): ContentTab {
  return SECTION_TAB[section] ?? 'overview';
}

const TAB_KEYS: ReadonlySet<string> = new Set<ContentTab>([
  'overview', 'content', 'placements', 'materials',
  'project_assets', 'project_info', 'tasks', 'performance', 'creative',
]);

/**
 * Tabs that were emitted historically under a name the page never had.
 *
 * `publish` was written into `mos_notifications.url` by the bundle status sync
 * and by a 2026-08-01 sweep migration. `ContentDetailPage` accepted no such
 * tab, so every one of those links silently opened «نظرة عامة» — the reader
 * was told a post needed publishing and landed on a summary. Those rows are
 * still in the table, so the alias is permanent, not transitional.
 */
const TAB_ALIASES: Readonly<Record<string, ContentTab>> = {
  publish: 'placements',
  publishing: 'placements',
  material: 'materials',
  writing: 'content',
};

/** A `?tab=` value → a tab the page actually renders. Unknown → `overview`. */
export function normalizeTab(raw: string | null | undefined): ContentTab {
  if (!raw) return 'overview';
  const key = raw.trim().toLowerCase();
  if (TAB_KEYS.has(key)) return key as ContentTab;
  return TAB_ALIASES[key] ?? 'overview';
}

/** Whether `raw` names a tab the page renders — an alias counts as known. */
export function isKnownTab(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const key = raw.trim().toLowerCase();
  return TAB_KEYS.has(key) || key in TAB_ALIASES;
}

/**
 * The section of `stepKey` inside the item's PINNED step list.
 *
 * Derived from position + role + is_approval, exactly like the old
 * `phaseOfStep` but one notch finer:
 *   - everything before the first non-approval step owned by a production role
 *     is the WRITING half — a plain step is `writing`, an approval is
 *     `writing_review`;
 *   - from that production step on it is the DESIGN half — a plain step is
 *     `design_upload`; an approval owned by the writer is the writer's gate
 *     (`design_review_writer`), anyone else's is the `final_review`;
 *   - a scheduling or publishing step ends the chain regardless of where it
 *     sits.
 * A key the pinned list no longer contains (a workflow edited under a live
 * item, a stale notification row) falls back to a keyword guess so it still
 * lands somewhere honest instead of nowhere.
 */
export function sectionForStep(
  steps: ReadonlyArray<RouteStep> | null | undefined,
  stepKey: string | null | undefined,
): ContentSection {
  if (!stepKey) return 'overview';
  if (stepKey === 'done') return DONE_SECTION;
  const list = steps ?? [];
  const idx = list.findIndex((s) => s.key === stepKey);
  if (idx < 0) return keywordSection(stepKey);

  let seenProduction = false;
  for (let i = 0; i <= idx; i += 1) {
    const s = list[i];
    /* istanbul ignore next — `idx` came from this same list. */
    if (!s) continue;
    const role = s.role ?? s.role_key ?? '';
    if (!s.is_approval && PRODUCTION_ROLES.has(role)) seenProduction = true;
    if (i < idx) continue;

    if (/schedul|جدول/i.test(s.key)) return 'schedule';
    if (/publish|نشر/i.test(s.key)) return 'publish_check';
    if (!seenProduction) return s.is_approval ? 'writing_review' : 'writing';
    if (!s.is_approval) return 'design_upload';
    // An approval AFTER production started: the writer's gate, then the manager's.
    return role === 'writer' ? 'design_review_writer' : 'final_review';
  }
  /* istanbul ignore next — unreachable: the loop always returns at i === idx. */
  return keywordSection(stepKey);
}

/**
 * The guess for a key the pinned list does not contain. Kept character-for-
 * character in step with the server twin's `keywordSection`.
 */
function keywordSection(stepKey: string): ContentSection {
  if (/schedul|جدول/i.test(stepKey)) return 'schedule';
  if (/publish_check|publish|نشر/i.test(stepKey)) return 'publish_check';
  if (/caption|كابشن/i.test(stepKey)) return 'caption';
  if (/design_writer|writer_review|مراجعة الكاتب/i.test(stepKey)) return 'design_review_writer';
  if (/design_review|^review$|الاعتماد/i.test(stepKey)) return 'final_review';
  if (/design|edit|montage|asset|version|footage|تصميم|مونتاج|مواد/i.test(stepKey)) return 'design_upload';
  if (/review|مراجعة/i.test(stepKey)) return 'writing_review';
  return 'writing';
}

/* ── content links ──────────────────────────────────────────────────── */

/**
 * The columns of a content row this module reads. Deliberately structural, not
 * `MosContentRow`: the same resolver serves the overview's stalled rows, the
 * calendar's title refs and the search hits, none of which carry a full row.
 */
export interface ContentRouteRow {
  id: string;
  /** `mos_content_v.status_key` — the open step's KEY, or a synthetic status. */
  status_key?: string | null;
  /** Present when a caller already resolved the open step's key explicitly. */
  current_step_key?: string | null;
}

export interface ContentHrefOpts {
  /** Force a section (a task pointing at the caption, say). Wins over the step. */
  section?: ContentSection | null;
  /** Override the step key when the row does not carry one. */
  stepKey?: string | null;
}

/** The open step's KEY for a row, or null when it has no real step. */
export function stepKeyOfRow(row: ContentRouteRow): string | null {
  const key = row.current_step_key ?? row.status_key ?? null;
  if (!key) return null;
  return SYNTHETIC_STATUS.has(key) ? null : key;
}

/** `/m/content/:id?tab=…&step=…` — the one shape every client surface links to. */
export function contentHref(
  row: ContentRouteRow,
  steps?: ReadonlyArray<RouteStep> | null,
  opts: ContentHrefOpts = {},
): string {
  // A finished item is never "at a stage" — it IS its final materials, and it
  // reads the same whether you clicked it in the list, a task, or a notification.
  if (row.status_key === 'done') {
    return `/m/content/${row.id}?tab=materials&step=${DONE_SECTION}`;
  }
  const stepKey = opts.stepKey ?? stepKeyOfRow(row);
  const section = opts.section ?? sectionForStep(steps, stepKey);
  const qs = new URLSearchParams({ tab: tabForSection(section) });
  // `step` carries a real workflow key when there is one; otherwise the section
  // name, which the detail page understands and which is never a UUID either.
  if (stepKey) qs.set('step', stepKey);
  else if (section !== 'overview') qs.set('step', section);
  return `/m/content/${row.id}?${qs.toString()}`;
}

/**
 * Repair a content URL that was minted before this module existed — the
 * `?tab=publish` rows sitting in `mos_notifications`, and anything that
 * smuggled a step UUID into `?step=`. Non-content and external URLs pass
 * through untouched.
 */
export function normalizeContentHref(url: string): string {
  if (!url.startsWith('/m/content/')) return url;
  const q = url.indexOf('?');
  if (q < 0) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  const rawTab = params.get('tab');
  const rawStep = params.get('step');
  let touched = false;
  if (rawTab && normalizeTab(rawTab) !== rawTab) {
    params.set('tab', normalizeTab(rawTab));
    touched = true;
  }
  // A UUID in `?step=` is the v2 bug's signature — it can never match a key, so
  // drop it rather than have the page silently ignore it.
  if (rawStep && UUID_RE.test(rawStep)) {
    params.delete('step');
    touched = true;
  }
  if (!touched) return url;
  const qs = params.toString();
  return qs ? `${url.slice(0, q)}?${qs}` : url.slice(0, q);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── tasks ──────────────────────────────────────────────────────────── */

/**
 * What a task asks the reader to DO. Drives the row's verb, and whether the
 * row's primary click opens the preview popup or navigates.
 *
 * `refresh_decision` / `plan_conflict` / `ad_failed` are the campaign-planning
 * task kinds; their columns (`entity_kind`, `entity_id`, `action`) are being
 * added to `mos_manual_tasks` in parallel, so every read of them here is
 * optional and every fallback is a real destination, not a crash.
 */
export type TaskAction =
  | 'work'
  | 'review'
  | 'caption_review'
  | 'refresh_decision'
  | 'plan_conflict'
  | 'ad_failed'
  /** Put ONE finished creative on ONE destination — the publication task. */
  | 'publish'
  | 'complete'
  | 'view';

export const TASK_ACTION_LABELS: Record<TaskAction, { ar: string; en: string }> = {
  work:             { ar: 'ابدئي',             en: 'Start' },
  review:           { ar: 'مراجعة',            en: 'Review' },
  caption_review:   { ar: 'مراجعة الكابشن',    en: 'Review caption' },
  refresh_decision: { ar: 'قرار التجديد',      en: 'Refresh decision' },
  plan_conflict:    { ar: 'تعارض في الخطة',    en: 'Plan conflict' },
  ad_failed:        { ar: 'إعلان متعثّر',      en: 'Ad failed' },
  publish:          { ar: 'نشر',                en: 'Publish' },
  complete:         { ar: 'تم',                en: 'Done' },
  view:             { ar: 'عرض',               en: 'View' },
};

/**
 * The subset of a task row the resolver reads — satisfied by `MosTask`
 * (workflow) and `MosManualTask` (hand-assigned and system), including the
 * columns the campaign-planning migration adds.
 */
export interface RouteTask {
  id?: string;
  /** 'open' | 'done' | 'skipped' (workflow) or 'open' | 'done' | 'cancelled'. */
  status?: string | null;
  content_id?: string | null;
  campaign_id?: string | null;
  /** The workflow step's KEY. Preferred over `step_id`. */
  step_key?: string | null;
  /** `MosTask.step_id` — a UUID; resolved against `steps` when one is passed. */
  step_id?: string | null;
  /** 'manual' | 'caption_review' | 'refresh_decision' | 'plan_conflict' | 'ad_failed'. */
  kind?: string | null;
  /** New columns (added in parallel) — 'content' | 'campaign' | 'refresh_cycle' | … */
  entity_kind?: string | null;
  entity_id?: string | null;
  /** A free-text action the producer stamped; wins when it names a known one. */
  action?: string | null;
  /** Whether the step is an approval, when the caller already knows. */
  is_approval?: boolean | null;
  /** The subject item's own status — a finished item routes to its materials. */
  content_status_key?: string | null;
}

const KNOWN_ACTIONS: ReadonlySet<string> = new Set<TaskAction>([
  'work', 'review', 'caption_review', 'refresh_decision', 'plan_conflict',
  'ad_failed', 'publish', 'complete', 'view',
]);

const taskIsClosed = (task: RouteTask): boolean =>
  task.status === 'done' || task.status === 'cancelled' || task.status === 'skipped';

/** Resolve a task's step KEY, using `steps` to translate a raw `step_id`. */
export function stepKeyOfTask(
  task: RouteTask,
  steps?: ReadonlyArray<RouteStep & { id?: string }> | null,
): string | null {
  if (task.step_key) return task.step_key;
  if (task.step_id && steps) {
    const hit = steps.find((s) => s.id === task.step_id);
    if (hit) return hit.key;
  }
  return null;
}

/** What this task asks for. Never throws; an unknown shape reads as `view`. */
export function actionOfTask(
  task: RouteTask,
  steps?: ReadonlyArray<RouteStep & { id?: string }> | null,
): TaskAction {
  if (taskIsClosed(task)) return 'view';
  // A producer that stamped an explicit action knows more than we can infer.
  const stamped = (task.action ?? '').trim();
  if (stamped && KNOWN_ACTIONS.has(stamped)) return stamped as TaskAction;

  const kind = (task.kind ?? '').trim();
  if (kind === 'caption_review') return 'caption_review';
  if (kind === 'refresh_decision') return 'refresh_decision';
  if (kind === 'plan_conflict') return 'plan_conflict';
  if (kind === 'ad_failed') return 'ad_failed';
  if (kind === 'publish') return 'publish';
  // A plain hand-assigned task has no step and is closed with «تم».
  if (kind === 'manual') return 'complete';

  if (task.is_approval === true) return 'review';
  const stepKey = stepKeyOfTask(task, steps);
  if (stepKey) {
    const hit = steps?.find((s) => s.key === stepKey);
    if (hit?.is_approval) return 'review';
    const section = sectionForStep(steps, stepKey);
    return section === 'writing_review' || section === 'design_review_writer' || section === 'final_review'
      ? 'review'
      : 'work';
  }
  // No step, no kind, but it hangs off a content item: it is still work.
  return task.content_id ? 'work' : 'complete';
}

/** What the «معاينة» button on a task row should open, or null when nothing. */
export function previewTargetOfTask(
  task: RouteTask,
  steps?: ReadonlyArray<RouteStep & { id?: string }> | null,
): { contentId: string; section: ContentSection } | null {
  const entityKind = task.entity_kind ?? (task.content_id ? 'content' : null);
  const contentId = entityKind === 'content'
    ? task.entity_id ?? task.content_id ?? null
    : task.content_id ?? null;
  if (!contentId) return null;
  // A task you already closed shows what came OUT of it, not what it asked for.
  if (taskIsClosed(task) || task.content_status_key === 'done') {
    return { contentId, section: DONE_SECTION };
  }
  const kind = (task.kind ?? '').trim();
  if (kind === 'caption_review') return { contentId, section: 'caption' };
  if (kind === 'ad_failed') return { contentId, section: 'publish_check' };
  // A publication task is about material that is already finished, so its
  // preview shows what is going out, not the step that produced it.
  if (kind === 'publish') return { contentId, section: DONE_SECTION };
  const stepKey = stepKeyOfTask(task, steps);
  return { contentId, section: sectionForStep(steps, stepKey) };
}

/**
 * Where a task row NAVIGATES. Every task in the workspace goes through here,
 * so a new kind lands somewhere sensible the day its rows appear rather than
 * dead-ending on «مهامي».
 */
export function taskHref(
  task: RouteTask,
  steps?: ReadonlyArray<RouteStep & { id?: string }> | null,
): string {
  const entityKind = task.entity_kind
    ?? (task.content_id ? 'content' : task.campaign_id ? 'campaign' : null);
  const entityId = task.entity_id ?? task.content_id ?? task.campaign_id ?? null;
  if (!entityId) return '/m/my-work';

  switch (entityKind) {
    case 'content': {
      const done = taskIsClosed(task) || task.content_status_key === 'done';
      if (done) return `/m/content/${entityId}?tab=materials&step=${DONE_SECTION}`;
      const target = previewTargetOfTask({ ...task, content_id: entityId, entity_kind: 'content' }, steps);
      const section = target?.section ?? 'overview';
      return contentHref(
        { id: entityId, current_step_key: stepKeyOfTask(task, steps) },
        steps,
        { section },
      );
    }
    case 'campaign':
      return `/m/campaigns/${entityId}?tab=tasks`;
    case 'execution':
      // Without the parent campaign id the execution route cannot be built;
      // the campaign's own tasks tab is the closest honest destination.
      return task.campaign_id
        ? `/m/campaigns/${task.campaign_id}/exec/${entityId}`
        : '/m/campaigns';
    case 'refresh_cycle':
      return `/m/my-work?task=${entityId}`;
    // ONE release to ONE destination. It opens on its own screen rather than
    // the content record: the publisher needs the finished material, the
    // destination and the platform's rules, and nothing else.
    case 'publication':
      return `/m/releases/${entityId}`;
    default:
      return '/m/my-work';
  }
}
