/**
 * The SERVER twin of `src/pages/Marketing/lib/contentRoute.ts`.
 *
 * Every notification, task and worker message that links a human into the
 * Marketing workspace builds its URL here. Authoring these by hand in eight
 * different places is what produced the dead `?tab=publish` links (emitted by
 * `bundleStatusSync.ts` and a 2026-08-01 sweep migration, accepted by nobody).
 *
 * The URL vocabulary is deliberately built from STABLE DATA KEYS — a content id
 * and a workflow STEP KEY — never from a route stored in a row. Routes change;
 * step keys do not.
 */

/** The tabs `ContentDetailPage` accepts. `publish` is remapped, never emitted. */
export type ContentTab =
  | 'overview' | 'content' | 'placements' | 'materials'
  | 'project_assets' | 'project_info' | 'tasks' | 'performance' | 'creative';

/** The exact working area a task drops the user into. */
export type ContentSection =
  | 'writing' | 'writing_review' | 'design_upload' | 'design_review_writer'
  | 'final_review' | 'caption' | 'schedule' | 'publish_check'
  | 'materials_final' | 'overview';

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

export function tabForSection(section: ContentSection): ContentTab {
  return SECTION_TAB[section] ?? 'overview';
}

/**
 * Section for a step KEY, using the pinned step list when we have it.
 *
 * Mirrors the client resolver: the writing half is everything up to the first
 * approval by the manager; the design half starts at the first non-approval
 * step owned by a production role; scheduling/publishing steps end the chain.
 * A key the list no longer contains falls back to a keyword guess, so a stale
 * row still lands somewhere sensible.
 */
export function sectionForStep(
  steps: Array<{ key: string; role_key?: string | null; is_approval?: boolean | null }> | null | undefined,
  stepKey: string | null | undefined,
): ContentSection {
  if (!stepKey) return 'overview';
  const list = steps ?? [];
  const idx = list.findIndex((s) => s.key === stepKey);
  if (idx < 0) return keywordSection(stepKey);

  let seenProduction = false;
  for (let i = 0; i <= idx; i += 1) {
    const s = list[i];
    if (!s) continue;
    const role = s.role_key ?? '';
    const isApproval = Boolean(s.is_approval);
    if (!isApproval && (role === 'montage' || role === 'ops_supervisor')) seenProduction = true;
    if (i < idx) continue;

    if (/schedul|جدول/i.test(s.key)) return 'schedule';
    if (/publish|نشر/i.test(s.key)) return 'publish_check';
    if (!seenProduction) return isApproval ? 'writing_review' : 'writing';
    if (!isApproval) return 'design_upload';
    // An approval AFTER production started: the writer's gate, then the manager's.
    return role === 'writer' ? 'design_review_writer' : 'final_review';
  }
  return keywordSection(stepKey);
}

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

export interface ContentUrlOpts {
  /** Workflow step key — NEVER a step UUID. */
  stepKey?: string | null;
  steps?: Array<{ key: string; role_key?: string | null; is_approval?: boolean | null }> | null;
  section?: ContentSection | null;
  /** A finished item always lands on its final materials, wherever it came from. */
  done?: boolean;
}

/** `/m/content/:id?tab=…&step=…` — the one shape every producer emits. */
export function contentUrl(contentId: string, opts: ContentUrlOpts = {}): string {
  if (opts.done) return `/m/content/${contentId}?tab=materials&step=materials_final`;
  const section = opts.section ?? sectionForStep(opts.steps, opts.stepKey);
  const tab = tabForSection(section);
  const qs = new URLSearchParams({ tab });
  if (opts.stepKey) qs.set('step', opts.stepKey);
  else if (section !== 'overview') qs.set('step', section);
  return `/m/content/${contentId}?${qs.toString()}`;
}

/**
 * Campaign and execution pages were deleted with the old Marketing pages
 * (2026-09-16) — a campaign is planned on the month page now. The signatures
 * are kept so no producer breaks; every such link lands on the month, and the
 * client routes redirect any `/m/campaigns/...` link already sent.
 */
export function campaignUrl(_campaignId: string, _tab?: string): string {
  return '/m/month';
}

export function executionUrl(_campaignId: string, _executionId: string, _tab?: string): string {
  return '/m/month';
}

export const myWorkUrl = (): string => '/m/my-work';

/** The destination for a manual task of any kind. */
export function manualTaskUrl(task: {
  kind?: string | null;
  entity_kind?: string | null;
  entity_id?: string | null;
  content_id?: string | null;
  campaign_id?: string | null;
}): string {
  const ek = task.entity_kind ?? (task.content_id ? 'content' : task.campaign_id ? 'campaign' : null);
  const id = task.entity_id ?? task.content_id ?? task.campaign_id ?? null;
  if (!id) return myWorkUrl();
  switch (ek) {
    case 'content':
      return contentUrl(id, { section: task.kind === 'caption_review' ? 'caption' : null });
    case 'campaign':
      return campaignUrl(id);
    case 'refresh_cycle':
      return `/m/my-work?task=${id}`;
    // Server twin of the client resolver's `publication` case — one release,
    // its own screen.
    case 'publication':
      return `/m/releases/${id}`;
    default:
      return myWorkUrl();
  }
}
