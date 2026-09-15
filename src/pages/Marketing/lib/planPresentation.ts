/**
 * Campaign plan → screen. PURE presentation logic for the wizard's preview.
 *
 * Every judgement the preview makes lives HERE, not in a component: the
 * feasibility wording, the Instagram grid mapping, the over-capacity flag, the
 * refresh forecast rows, the 409 conflict body. Components render what these
 * functions return, so the wording that matters most — «مستحيل» versus «لم
 * نعثر» — is unit-tested rather than buried in JSX.
 *
 * The distinction the engine draws (plan v2.1 correction 1) is the whole point:
 *
 *   feasible === false && infeasibleProof !== null  → we PROVED it cannot be done.
 *   feasible === false && infeasibleProof === null  → our SEARCH ran out of budget.
 *
 * The second is not the first. Telling a manager "impossible" when we only
 * failed to look hard enough costs them a campaign they could have run.
 */
import type {
  ConflictKind, LoadBucket, LoadCell, PlanConflict, PlannedCycle, PlannedItem,
  PlanResult, PlanTotals,
} from '@/lib/marketingOS/scheduling';
import { POST_WORKFLOW, VIDEO_WORKFLOW } from '@/lib/marketingOS/scheduling';
// TYPE-ONLY, and it must stay that way: `client.ts` reaches for `import.meta.env`
// at module scope, and this file is imported by tests that have no Vite env.
import type { MosPlanRequestInput } from '@/lib/marketingOS/client';
import { num } from './format';

/* ------------------------------------------------------------------ */
/* bilingual primitive                                                 */
/* ------------------------------------------------------------------ */

/** Every user-visible string this module produces carries both languages. */
export interface BiText { ar: string; en: string }

export const bi = (ar: string, en: string): BiText => ({ ar, en });

export function pickText(t: BiText, isAr: boolean): string {
  return isAr ? t.ar : t.en;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whole days from `a` to `b`, or null when either side is not a civil date.
 * Deliberately does NOT call the engine's `daysBetween`, which THROWS on a
 * malformed date — a preview must never blow up because one date is missing.
 */
export function dayDiff(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b || !YMD.test(a) || !YMD.test(b)) return null;
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 86_400_000);
}

/* ------------------------------------------------------------------ */
/* 1. feasibility wording — the rule this file exists for              */
/* ------------------------------------------------------------------ */

export type FeasibilityCase =
  | 'feasible'
  | 'feasible_incomplete'
  | 'time_bound'
  | 'capacity_bound'
  | 'not_found';

export interface FeasibilityVerdict {
  kind: FeasibilityCase;
  tone: 'ok' | 'warn' | 'bad';
  title: BiText;
  body: BiText;
  /**
   * True ONLY when the engine proved infeasibility. The word «مستحيل» /
   * "impossible" may appear in the copy if and only if this is true.
   */
  provenImpossible: boolean;
}

export function feasibilityVerdict(plan: PlanResult): FeasibilityVerdict {
  if (plan.feasible) {
    if (plan.searchIncomplete) {
      return {
        kind: 'feasible_incomplete',
        tone: 'warn',
        title: bi('الخطة قابلة للتنفيذ — مع تحفّظ', 'The plan fits — with a caveat'),
        body: bi(
          'وجدنا جدولًا صالحًا قبل أن يستنفد البحث حدّه، فقد يوجد ترتيب أفضل لم نصل إليه. ما تراه صالح، لا أكثر.',
          'We found a workable schedule before the search hit its budget, so a better arrangement may exist that we did not reach. What you see is valid, not necessarily optimal.',
        ),
        provenImpossible: false,
      };
    }
    return {
      kind: 'feasible',
      tone: 'ok',
      title: bi('الخطة قابلة للتنفيذ', 'The plan fits'),
      body: bi(
        'كل بند يصل إلى تاريخ نشره، وكل مرحلة تقع داخل طاقة صاحبها اليومية.',
        'Every item reaches its publishing date, and every stage lands inside its owner’s daily capacity.',
      ),
      provenImpossible: false,
    };
  }

  if (plan.infeasibleProof === 'time_bound') {
    return {
      kind: 'time_bound',
      tone: 'bad',
      title: bi('هذا المدى مستحيل: الوقت لا يكفي', 'This range is impossible: there is not enough time'),
      body: bi(
        'حتى لو كان الفريق بلا حدود، سلسلة الإنتاج نفسها أطول من المدة المتاحة قبل أول تاريخ نشر. هذا إثبات، لا تقدير.',
        'Even with unlimited people, the production chain itself is longer than the time available before the first publishing date. That is a proof, not an estimate.',
      ),
      provenImpossible: true,
    };
  }

  if (plan.infeasibleProof === 'capacity_bound') {
    return {
      kind: 'capacity_bound',
      tone: 'bad',
      title: bi('هذا المدى مستحيل: السعة لا تكفي', 'This range is impossible: there is not enough capacity'),
      body: bi(
        'مجموع أيام العمل المطلوبة يتجاوز كل الأيام الشاغرة لدى الفريق قبل المواعيد. هذا إثبات، لا تقدير — قلّل العدد أو مدّد المدى أو ارفع الطاقة.',
        'The slot-days the work needs exceed every free slot-day the team has before the deadlines. That is a proof, not an estimate — cut the count, extend the range, or raise capacity.',
      ),
      provenImpossible: true,
    };
  }

  // infeasibleProof === null. NEVER the word "impossible" here.
  return {
    kind: 'not_found',
    tone: 'warn',
    title: bi(
      'لم نعثر على جدول ضمن حدّ البحث — هذا ليس إثباتًا بالاستحالة',
      'No schedule found within the search budget — this is not proof that it is impossible',
    ),
    body: bi(
      `توقّف البحث عند حدّه (${num(plan.searchStats.expansions, true)} محاولة) قبل أن يستنفد كل الاحتمالات. قد يوجد جدول صالح لم نصل إليه: جرّب أقرب مدى ممكن، أو نفس التواريخ بعدد أقل، أو ثبّت بعض المواضع يدويًا.`,
      `The search stopped at its budget (${num(plan.searchStats.expansions, false)} expansions) before exhausting the possibilities. A workable schedule may exist that we did not reach: try the earliest feasible range, the same dates with fewer items, or pin a few placements by hand.`,
    ),
    provenImpossible: false,
  };
}

/* ------------------------------------------------------------------ */
/* 2. alternatives — always offered, one click each                    */
/* ------------------------------------------------------------------ */

export interface PlanAlternative {
  kind: 'earliest_start' | 'fewer_items';
  label: BiText;
  detail: BiText;
  rangeStart?: string;
  rangeEnd?: string;
  maxItems?: number;
}

/**
 * The two escape hatches §6.3 requires. Rendered whenever the engine produced
 * them — including on a `not_found`, where they are the only honest next step.
 */
export function alternativeOptions(plan: PlanResult, requestedItems: number): PlanAlternative[] {
  const out: PlanAlternative[] = [];
  const { earliestFeasibleStart: start, earliestFeasibleEnd: end, maxItemsInRange: max } = plan.alternatives;

  if (start && end) {
    out.push({
      kind: 'earliest_start',
      label: bi('أقرب مدى ممكن', 'Earliest feasible range'),
      detail: bi(`${start} ← ${end}`, `${start} → ${end}`),
      rangeStart: start,
      rangeEnd: end,
    });
  }
  if (max !== null && max > 0 && max < requestedItems) {
    out.push({
      kind: 'fewer_items',
      label: bi('نفس التواريخ بعدد أقل', 'Same dates, fewer items'),
      detail: bi(
        `${num(max, true)} بندًا بدل ${num(requestedItems, true)} — تُحذف البنود من آخر الدفعات.`,
        `${num(max, false)} items instead of ${num(requestedItems, false)} — dropped from the last batches first.`,
      ),
      maxItems: max,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 3. the Instagram grid                                               */
/* ------------------------------------------------------------------ */

/**
 * Cell colours are per PROJECT, so the operator's rule — three different
 * projects to a row — is checkable at a glance instead of by reading names.
 */
export const PROJECT_COLORS = [
  '#B8734F', '#4A6FA5', '#5C8A5C', '#8E4E3A', '#7A5C9E', '#C09B5F', '#4A7C7E', '#A2555C',
] as const;

/** Keyed by `string | null`: a general-row post belongs to NO project (A8b). */
export function projectColorMap(items: PlannedItem[]): Map<string | null, number> {
  const m = new Map<string | null, number>();
  for (const it of items) {
    if (!m.has(it.projectId)) m.set(it.projectId, m.size % PROJECT_COLORS.length);
  }
  return m;
}

export function projectColor(index: number): string {
  return PROJECT_COLORS[index % PROJECT_COLORS.length] ?? PROJECT_COLORS[0];
}

export interface GridCell {
  itemKey: string;
  title: string;
  projectId: string;
  projectName: string;
  contentTypeKey: string;
  day: string;
  slotIndex: number;
  row: number;
  col: number;
  colorIndex: number;
}

export interface PlanGridModel {
  platform: string;
  columns: number;
  /** Row-major, padded with nulls so every row has `columns` entries. */
  rows: Array<Array<GridCell | null>>;
  cells: GridCell[];
}

/**
 * Which platforms get a FEED GRID, and whether the publishing-batches table is
 * shown at all. Both answers turn on the campaign KIND, which is why they live
 * here and are tested rather than being an `&&` inside the JSX.
 *
 * Paid gets neither, because neither exists for an ad:
 *
 *   • There is no feed. An ad has no row of three, no post before it and no
 *     post after it, so «لا نكرر المشروع في الصف نفسه» — the only reason the
 *     grid exists — has nothing to check. The engine says so itself by leaving
 *     `gridRow`/`gridCol` null on every paid placement; `buildPlanGrid` then
 *     fills the gap from the array index (deliberate for a stream platform like
 *     TikTok, where publish ORDER is real), and that fabricated r/c is what
 *     drew an Instagram-shaped grid over a set of Meta ad creatives.
 *   • There is no publishing batch. The planner REUSES `batches` for paid to
 *     mean one refresh cycle, so the table rendered the refresh calendar under
 *     the heading «دفعات النشر», with a «اليوم» column holding the refresh date
 *     and a content column repeating the project name once per creative — one
 *     card above `RefreshForecastCard`, which shows the same cycles with their
 *     ready, production-start and decision dates. For paid that card IS the
 *     schedule.
 */
export function gridPlatformsFor(
  items: PlannedItem[],
  kind: MosPlanRequestInput['kind'],
): string[] {
  if (kind === 'paid') return [];
  return [...new Set(items.flatMap((i) => i.placements.map((pl) => pl.platform)))];
}

/** Organic publishes in batches; for paid a "batch" is a refresh cycle. */
export function showsPublishingBatches(kind: MosPlanRequestInput['kind']): boolean {
  return kind !== 'paid';
}

/**
 * Map a platform's placements onto a grid.
 *
 * The engine already assigns `gridRow`/`gridCol` for grid platforms; we honour
 * them exactly, because those positions are what the placement rules were
 * checked against. For a stream platform (no grid) we lay the placements out in
 * publish order so the preview still shows something ordered — that grid is a
 * VIEW, not a rule.
 *
 * `newestFirst` reverses the row order for display (Instagram shows the newest
 * row at the top); the underlying row indices are untouched.
 */
export function buildPlanGrid(
  items: PlannedItem[],
  platform: string,
  opts?: { columns?: number; newestFirst?: boolean; colors?: Map<string | null, number> },
): PlanGridModel {
  const columns = Math.max(1, opts?.columns ?? 3);
  const colors = opts?.colors ?? projectColorMap(items);

  const flat: Array<{ item: PlannedItem; day: string; slotIndex: number; row: number | null; col: number | null }> = [];
  for (const item of items) {
    for (const p of item.placements) {
      if (p.platform !== platform) continue;
      flat.push({ item, day: p.day, slotIndex: p.slotIndex, row: p.gridRow, col: p.gridCol });
    }
  }
  flat.sort((a, b) => (
    a.day === b.day
      ? a.slotIndex - b.slotIndex
      : a.day < b.day ? -1 : 1
  ));

  const cells: GridCell[] = flat.map((f, i) => {
    const row = f.row ?? Math.floor(i / columns);
    const col = f.col ?? i % columns;
    return {
      itemKey: f.item.key,
      title: f.item.title,
      // This grid is the campaign wizard's preview, where every item has a
      // project. A general row (no project) is labelled by its title instead.
      projectId: f.item.projectId ?? '',
      projectName: f.item.projectName ?? '',
      contentTypeKey: f.item.contentTypeKey,
      day: f.day,
      slotIndex: f.slotIndex,
      row,
      col,
      colorIndex: colors.get(f.item.projectId) ?? 0,
    };
  });

  const maxRow = cells.reduce((m, c) => Math.max(m, c.row), -1);
  const rows: Array<Array<GridCell | null>> = Array.from(
    { length: maxRow + 1 },
    () => Array.from({ length: columns }, () => null),
  );
  for (const c of cells) {
    const r = rows[c.row];
    if (r && c.col >= 0 && c.col < columns) r[c.col] = c;
  }
  return { platform, columns, rows: opts?.newestFirst ? [...rows].reverse() : rows, cells };
}

/** A locked placement, in the snake_case shape `campaign_plan_revise` expects. */
export interface LockedPlacement {
  item_key: string;
  platform: string;
  day: string;
  index: number;
}

/**
 * Dragging cell A onto cell B swaps their publishing slots. Both sides are
 * pinned, because pinning only the dragged one would let the re-plan move the
 * other back under it.
 */
export function swapPlacements(
  cells: GridCell[], aKey: string, bKey: string, platform: string,
): LockedPlacement[] {
  if (aKey === bKey) return [];
  const a = cells.find((c) => c.itemKey === aKey);
  const b = cells.find((c) => c.itemKey === bKey);
  if (!a || !b) return [];
  return [
    { item_key: a.itemKey, platform, day: b.day, index: b.slotIndex },
    { item_key: b.itemKey, platform, day: a.day, index: a.slotIndex },
  ];
}

/** Later locks win; earlier ones for other items survive. */
export function mergeLockedPlacements(
  existing: LockedPlacement[], incoming: LockedPlacement[],
): LockedPlacement[] {
  const byKey = new Map<string, LockedPlacement>();
  for (const l of existing) byKey.set(`${l.item_key}|${l.platform}`, l);
  for (const l of incoming) byKey.set(`${l.item_key}|${l.platform}`, l);
  return [...byKey.values()];
}

/* ------------------------------------------------------------------ */
/* 4. the load table                                                   */
/* ------------------------------------------------------------------ */

export interface LoadTableCell {
  day: string;
  existing: number;
  proposed: number;
  capacity: number;
  /** existing + proposed exceeds the day's capacity. Painted red. */
  over: boolean;
}

export interface LoadTableRow {
  userId: string;
  bucket: LoadBucket;
  cells: LoadTableCell[];
  anyOver: boolean;
  totalProposed: number;
}

export interface LoadTableModel {
  days: string[];
  rows: LoadTableRow[];
  /** How many (person, day, bucket) cells are over capacity. */
  overCells: number;
}

const BUCKET_ORDER: Record<string, number> = { post: 0, video: 1, approvals: 2 };

/** Floating-point tolerance — a 0.5-weight ledger sums to 2.9999999999999996. */
const EPS = 1e-9;

export function isOverCapacity(cell: { existing: number; proposed: number; capacity: number }): boolean {
  return cell.existing + cell.proposed > cell.capacity + EPS;
}

/**
 * One row per (person, bucket), one column per day the plan touches.
 *
 * Rows with no proposed work AND no over-capacity day are dropped: the preview
 * is about what THIS plan does, and a table of everyone's untouched days would
 * bury the two red cells that matter.
 */
export function buildLoadTable(load: LoadCell[]): LoadTableModel {
  const days = [...new Set(load.map((c) => c.day))].sort();
  const byRow = new Map<string, LoadTableRow>();

  for (const c of load) {
    const key = `${c.userId}|${c.bucket}`;
    let row = byRow.get(key);
    if (!row) {
      row = { userId: c.userId, bucket: c.bucket, cells: [], anyOver: false, totalProposed: 0 };
      byRow.set(key, row);
    }
    const over = isOverCapacity(c);
    row.cells.push({
      day: c.day, existing: c.existing, proposed: c.proposed, capacity: c.capacity, over,
    });
    row.anyOver = row.anyOver || over;
    row.totalProposed += c.proposed;
  }

  const rows = [...byRow.values()]
    .filter((r) => r.totalProposed > EPS || r.anyOver)
    .map((r) => ({ ...r, cells: [...r.cells].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)) }))
    .sort((a, b) => (
      a.userId === b.userId
        ? (BUCKET_ORDER[a.bucket] ?? 9) - (BUCKET_ORDER[b.bucket] ?? 9)
        : a.userId < b.userId ? -1 : 1
    ));

  return { days, rows, overCells: rows.reduce((n, r) => n + r.cells.filter((c) => c.over).length, 0) };
}

export const BUCKET_LABELS: Record<string, BiText> = {
  post: bi('منشورات', 'Posts'),
  video: bi('فيديو', 'Video'),
  approvals: bi('اعتمادات', 'Approvals'),
};

export function bucketLabel(bucket: string): BiText {
  return BUCKET_LABELS[bucket] ?? bi(bucket, bucket);
}

/* ------------------------------------------------------------------ */
/* 5. the paid refresh forecast                                        */
/* ------------------------------------------------------------------ */

export interface RefreshForecastRow {
  executionKey: string;
  round: number;
  label: BiText;
  refreshOn: string | null;
  readyBy: string | null;
  productionStartOn: string | null;
  decisionDueOn: string | null;
  produced: number;
  /** Days of campaign left at this refresh, inclusive. Null when undatable. */
  daysLeft: number | null;
  skipped: boolean;
  bankedSpareSlotId: string | null;
  note: BiText;
}

export function buildRefreshRows(cycles: PlannedCycle[], rangeEnd: string): RefreshForecastRow[] {
  return cycles.map((c) => {
    const diff = dayDiff(c.refreshOn, rangeEnd);
    const daysLeft = diff === null ? null : diff + 1;
    const skipped = c.round > 0 && c.produced === 0;
    const label = c.round === 0
      ? bi('الإطلاق', 'Launch')
      : bi(`التحديث ${num(c.round, true)}`, `Refresh ${num(c.round, false)}`);

    let note: BiText;
    if (c.round === 0) {
      note = bi('دفعة الإطلاق — تُنتَج قبل بدء الحملة.', 'The launch slate — produced before the campaign starts.');
    } else if (skipped) {
      note = bi(
        `متخطّى — لم يتبقّ سوى ${num(daysLeft, true)} يوم من الحملة.`,
        `Skipped — only ${num(daysLeft, false)} day(s) of the campaign remain.`,
      );
    } else if (c.bankedSpareSlotId) {
      note = bi(
        'أحد التصاميم مغطّى بتصميم احتياطي محجوز لهذه الدورة حصريًا.',
        'One creative is covered by a banked spare reserved exclusively for this cycle.',
      );
    } else {
      note = bi(
        'يبدأ الإنتاج قبل موعد القرار — لا ننتظر معرفة الفائز.',
        'Production starts before the decision is due — we never wait to learn the winner.',
      );
    }

    return {
      executionKey: c.executionKey,
      round: c.round,
      label,
      refreshOn: c.refreshOn,
      readyBy: c.readyBy,
      productionStartOn: c.productionStartOn,
      decisionDueOn: c.decisionDueOn,
      produced: c.produced,
      daysLeft,
      skipped,
      bankedSpareSlotId: c.bankedSpareSlotId,
      note,
    };
  });
}

/**
 * «٢٠ تصميمًا = ٥ إطلاق + ١٢ بديلًا + ٣ خامس · عبر ٣ تحديثات».
 * Every number goes through `num()`, so Arabic reads Arabic-Indic digits.
 */
export function creativeTotalsText(totals: PlanTotals['creatives'], isAr: boolean): string {
  if (!totals) return '—';
  const { initial, replacements, fifths, total, cycles } = totals;
  if (isAr) {
    const parts = [`${num(initial, true)} إطلاق`, `${num(replacements, true)} بديلًا`];
    if (fifths > 0) parts.push(`${num(fifths, true)} خامس`);
    return `${num(total, true)} تصميمًا = ${parts.join(' + ')} · عبر ${num(cycles, true)} تحديثات`;
  }
  const parts = [`${num(initial, false)} launch`, `${num(replacements, false)} replacements`];
  if (fifths > 0) parts.push(`${num(fifths, false)} fifths`);
  return `${num(total, false)} creatives = ${parts.join(' + ')} · across ${num(cycles, false)} refreshes`;
}

/* ------------------------------------------------------------------ */
/* 6. conflicts in plain words                                         */
/* ------------------------------------------------------------------ */

const CONFLICT_HEADLINES: Record<ConflictKind, BiText> = {
  no_capacity: bi('لا توجد طاقة في اليوم المطلوب', 'No capacity on the day it is needed'),
  time_bound: bi('الوقت لا يكفي للسلسلة', 'The chain does not fit in the time'),
  no_eligible_person: bi('لا يوجد شخص يصلح لهذه المرحلة', 'Nobody is eligible for this stage'),
  not_enough_slots: bi('فترات النشر أقل من عدد البنود', 'Fewer publishing slots than items'),
  platform_rule: bi('قاعدة المنصة تمنع هذا الترتيب', 'A platform rule blocks this arrangement'),
  search_incomplete: bi('توقّف البحث عند حدّه', 'The search stopped at its budget'),
  range_in_past: bi('المدى المطلوب في الماضي', 'The requested range is in the past'),
  publish_time: bi('وقت نشر الصف غير صالح', 'The row’s publishing time is unusable'),
};

export interface ConflictLine {
  kind: ConflictKind;
  headline: BiText;
  body: BiText;
  day: string | null;
  itemKey: string | null;
  stepKey: string | null;
}

export function conflictLines(conflicts: PlanConflict[]): ConflictLine[] {
  return conflicts.map((c) => ({
    kind: c.kind,
    headline: CONFLICT_HEADLINES[c.kind] ?? bi(c.kind, c.kind),
    body: bi(c.messageAr, c.messageEn),
    day: c.day,
    itemKey: c.itemKey,
    stepKey: c.stepKey,
  }));
}

/* ------------------------------------------------------------------ */
/* 7. stage labels                                                     */
/* ------------------------------------------------------------------ */

const STEP_LABELS: Map<string, BiText> = new Map(
  [...POST_WORKFLOW.steps, ...VIDEO_WORKFLOW.steps].map((s) => [s.key, bi(s.labelAr, s.labelEn)]),
);

export function stepLabel(stepKey: string): BiText {
  return STEP_LABELS.get(stepKey) ?? bi(stepKey, stepKey);
}

/** The step keys the plan actually uses, in first-seen order — the table's columns. */
export function stageColumns(items: PlannedItem[]): string[] {
  const seen: string[] = [];
  for (const it of items) {
    for (const s of it.stages) if (!seen.includes(s.stepKey)) seen.push(s.stepKey);
  }
  return seen;
}

/* ------------------------------------------------------------------ */
/* 8. windows and ranges                                               */
/* ------------------------------------------------------------------ */

export function rangeText(start: string | null, end: string | null, isAr: boolean): string {
  if (!start || !end) return '—';
  return isAr ? `${start} ← ${end}` : `${start} → ${end}`;
}

export function productionWindowText(plan: PlanResult, isAr: boolean): string {
  const { start, end } = plan.productionWindow;
  if (!start || !end) return '—';
  const days = dayDiff(start, end);
  const span = days === null ? '' : isAr
    ? ` · ${num(days + 1, true)} يومًا`
    : ` · ${num(days + 1, false)} days`;
  return `${rangeText(start, end, isAr)}${span}`;
}

/* ------------------------------------------------------------------ */
/* 9. the 409 commit conflict                                          */
/* ------------------------------------------------------------------ */

export interface PlanDiffEntry { item: string; was: string; now: string }

export interface CommitConflict {
  kind: 'plan_changed' | 'capacity_conflict';
  message: BiText;
  diff: PlanDiffEntry[];
  /** The refreshed plan the server re-planned, when it sent one. */
  plan: PlanResult | null;
}

/** Structural shape of `MosApiError` — matched without importing the client. */
interface ApiErrorLike { status?: unknown; payload?: unknown; message?: unknown }

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function parseMaybeJson(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s.startsWith('{')) return null;
    // A non-JSON body is a legitimate outcome here (the server also sends plain
    // error strings), so a SyntaxError means "not a structured conflict" and the
    // caller falls back to surfacing the raw message. Anything else — a getter
    // that throws, an out-of-memory — is NOT ours to swallow and re-throws.
    try {
      return asRecord(JSON.parse(s));
    } catch (e) {
      if (e instanceof SyntaxError) return null;
      throw e;
    }
  }
  return asRecord(v);
}

/**
 * Pull the structured 409 out of a commit failure.
 *
 * The server sends `jsonError(409, JSON.stringify({error, error_ar, error_en,
 * diff, plan}))`, so the useful body arrives as a JSON STRING inside
 * `payload.error` (and, because the client copies it, as the error message).
 * Both spellings are handled. Returns null for anything that is not one of the
 * two planned conflicts — the caller must then surface the raw error.
 */
export function parseCommitConflict(err: unknown): CommitConflict | null {
  const e = asRecord(err) as ApiErrorLike | null;
  if (!e) return null;
  if (typeof e.status === 'number' && e.status !== 409) return null;

  const payload = asRecord(e.payload);
  const body = parseMaybeJson(payload?.error)
    ?? (payload && typeof payload.error === 'string' ? null : payload)
    ?? parseMaybeJson(e.message);
  if (!body) return null;

  const kindRaw = body.error;
  if (kindRaw !== 'plan_changed' && kindRaw !== 'capacity_conflict') return null;

  const diff: PlanDiffEntry[] = Array.isArray(body.diff)
    ? body.diff.flatMap((d) => {
      const r = asRecord(d);
      return r ? [{ item: String(r.item ?? ''), was: String(r.was ?? '—'), now: String(r.now ?? '—') }] : [];
    })
    : [];

  const fallback: BiText = kindRaw === 'capacity_conflict'
    ? bi(
      'لم تعد الخطة تناسب السعة المتاحة — تغيّرت الطاقة أو الجهد بين المعاينة والاعتماد.',
      'The plan no longer fits the available capacity — caps or effort changed between the preview and the approval.',
    )
    : bi(
      'تغيّر الحمل أثناء مراجعتك. راجع الخطة المحدَّثة قبل الاعتماد.',
      'The workload changed while you were reviewing. Review the refreshed plan before approving.',
    );

  return {
    kind: kindRaw,
    message: bi(
      typeof body.error_ar === 'string' ? body.error_ar : fallback.ar,
      typeof body.error_en === 'string' ? body.error_en : fallback.en,
    ),
    diff,
    plan: (body.plan as PlanResult | undefined) ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* 10. plan identity — the same signature the server commits against   */
/* ------------------------------------------------------------------ */

/**
 * Mirrors `planSignature` in `api/_lib/marketing/planning/actions.ts`. The
 * wizard uses it for exactly one thing: after creating the campaign envelope it
 * re-previews with the new `campaign_id`, and if the fresh plan differs from
 * the one the human just read, it shows the difference instead of committing
 * something they never saw.
 */
export function planSignature(plan: PlanResult): string {
  const stages = plan.items.flatMap((i) =>
    i.stages.map((s) => `${i.key}|${s.stepKey}|${s.assigneeUserId ?? '-'}|${s.start}|${s.end}`));
  const places = plan.items.flatMap((i) =>
    i.placements.map((p) => `${i.key}@${p.platform}|${p.day}|${p.slotIndex}`));
  return [...stages, ...places].sort().join('\n');
}

export function diffPlans(before: PlanResult, after: PlanResult): PlanDiffEntry[] {
  const idx = (p: PlanResult): Map<string, string> => {
    const m = new Map<string, string>();
    for (const i of p.items) {
      for (const s of i.stages) m.set(`${i.key}|${s.stepKey}`, `${s.assigneeUserId ?? '-'} ${s.start}→${s.end}`);
    }
    return m;
  };
  const a = idx(before);
  const b = idx(after);
  const out: PlanDiffEntry[] = [];
  for (const [k, was] of a) {
    const now = b.get(k);
    if (now !== was) out.push({ item: k, was, now: now ?? '—' });
  }
  for (const [k, now] of b) if (!a.has(k)) out.push({ item: k, was: '—', now });
  return out.slice(0, 40);
}

/* ------------------------------------------------------------------ */
/* 11. people                                                          */
/* ------------------------------------------------------------------ */

export interface NamedPerson { user_id: string; name_ar: string | null; name_en: string | null }

/** A person's display name, or a short id when they are not in the directory. */
export function personName(
  userId: string | null, people: NamedPerson[], isAr: boolean,
): string {
  if (!userId) return isAr ? 'غير مُسند' : 'Unassigned';
  const p = people.find((x) => x.user_id === userId);
  if (!p) return userId.slice(0, 8);
  return (isAr ? p.name_ar || p.name_en : p.name_en || p.name_ar) || userId.slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* 12. the wizard's requirements draft → a plan request                */
/* ------------------------------------------------------------------ */

/**
 * The refresh policy's shipped defaults — `mos_settings.refresh_policy` in the
 * build contract §6. Settings override them per install; the wizard lets the
 * manager override them per campaign.
 */
export const DEFAULT_REFRESH_POLICY = {
  slate_size: 5,
  keep_min: 1,
  cycle_days: 7,
  min_remaining_days: 3,
  lead_time_working_days: 7,
  fifth_policy: 'A' as 'A' | 'B',
};

export type RefreshPolicyDraft = typeof DEFAULT_REFRESH_POLICY;

export interface FrequencyDraft {
  perDay: number;
  /** Allowed publishing weekdays (0=Sun…6=Sat). null = every day. */
  weekdays: number[] | null;
}

export interface QuantityDraft { posts: number; videos: number }

export interface RequirementsDraft {
  kind: 'organic' | 'paid';
  projectIds: string[];
  /** Per-project override of the global quantity. Missing = use the global. */
  quantities: Record<string, QuantityDraft>;
  globalPosts: number;
  globalVideos: number;
  platforms: string[];
  rangeStart: string;
  rangeEnd: string;
  frequency: Record<string, FrequencyDraft>;
  crossPost: boolean;
  refresh: RefreshPolicyDraft;
}

export function emptyRequirements(kind: 'organic' | 'paid'): RequirementsDraft {
  return {
    kind,
    projectIds: [],
    quantities: {},
    globalPosts: kind === 'paid' ? 5 : 1,
    globalVideos: 0,
    platforms: kind === 'paid' ? ['meta'] : ['instagram'],
    rangeStart: '',
    rangeEnd: '',
    frequency: {},
    crossPost: false,
    refresh: { ...DEFAULT_REFRESH_POLICY },
  };
}

export function quantityOf(draft: RequirementsDraft, projectId: string): QuantityDraft {
  return draft.quantities[projectId] ?? { posts: draft.globalPosts, videos: draft.globalVideos };
}

export function frequencyOf(draft: RequirementsDraft, platform: string): FrequencyDraft {
  return draft.frequency[platform] ?? { perDay: 1, weekdays: null };
}

/** Total creatives the requirements ask for — the number the preview compares against. */
export function requestedItemCount(draft: RequirementsDraft): number {
  return draft.projectIds.reduce((n, id) => {
    const q = quantityOf(draft, id);
    return n + Math.max(0, q.posts) + Math.max(0, q.videos);
  }, 0);
}

/**
 * The wizard's draft in the snake_case shape `campaign_plan_preview` parses.
 * `overrides` carries the manual grid pins, which survive every re-preview.
 */
export function buildPlanRequest(
  draft: RequirementsDraft,
  opts: {
    campaignId?: string | null;
    lockedPlacements?: LockedPlacement[];
    droppedItemKeys?: string[];
    projectNameOf?: (id: string) => string;
  } = {},
): MosPlanRequestInput {
  const projects = draft.projectIds.map((id) => {
    const q = quantityOf(draft, id);
    return {
      project_id: id,
      project_name: opts.projectNameOf ? opts.projectNameOf(id) : undefined,
      posts: Math.max(0, Math.floor(q.posts)),
      videos: Math.max(0, Math.floor(q.videos)),
    };
  });

  const frequency = draft.platforms.map((p) => {
    const f = frequencyOf(draft, p);
    return {
      platform: p,
      per_day: Math.max(1, Math.floor(f.perDay)),
      weekdays: f.weekdays && f.weekdays.length > 0 ? [...f.weekdays].sort((a, b) => a - b) : null,
    };
  });

  const paid = draft.kind === 'paid'
    ? draft.platforms.map((p) => ({
      execution_key: `exec:${p}`,
      execution_id: null,
      platform: p,
      policy: {
        slate_size: draft.refresh.slate_size,
        keep_min: draft.refresh.keep_min,
        cycle_days: draft.refresh.cycle_days,
        min_remaining_days: draft.refresh.min_remaining_days,
        lead_time_working_days: draft.refresh.lead_time_working_days,
        fifth_policy: draft.refresh.fifth_policy,
      },
    }))
    : undefined;

  return {
    campaign_id: opts.campaignId ?? null,
    kind: draft.kind,
    projects,
    platforms: draft.platforms,
    range_start: draft.rangeStart,
    range_end: draft.rangeEnd,
    frequency,
    cross_post: draft.crossPost,
    ...(paid ? { paid } : {}),
    overrides: {
      locked_placements: opts.lockedPlacements ?? [],
      dropped_item_keys: opts.droppedItemKeys ?? [],
    },
  };
}

/**
 * Everything wrong with the requirements, in both languages. An empty array
 * means the preview may be requested — the server validates again, and its
 * refusal is surfaced, never swallowed.
 */
export function requirementsProblems(draft: RequirementsDraft): BiText[] {
  const out: BiText[] = [];
  if (draft.projectIds.length === 0) {
    out.push(bi('اختر مشروعًا واحدًا على الأقل.', 'Pick at least one project.'));
  }
  // Organic only. A paid plan's item count comes from the refresh policy, not
  // from posts/videos, so demanding a quantity here would block a campaign on a
  // number the planner never reads.
  if (draft.kind !== 'paid' && requestedItemCount(draft) === 0) {
    out.push(bi('حدّد عدد المنشورات أو الفيديوهات المطلوبة.', 'Set how many posts or videos are needed.'));
  }
  if (draft.platforms.length === 0) {
    out.push(draft.kind === 'paid'
      ? bi('اختر قناة إعلانية واحدة على الأقل.', 'Pick at least one ad channel.')
      : bi('اختر منصة نشر واحدة على الأقل.', 'Pick at least one publishing platform.'));
  }
  if (!draft.rangeStart || !draft.rangeEnd) {
    out.push(bi('حدّد تاريخي بداية ونهاية النشر.', 'Set the publishing start and end dates.'));
  } else if (draft.rangeEnd < draft.rangeStart) {
    out.push(bi('تاريخ النهاية قبل تاريخ البداية.', 'The end date precedes the start date.'));
  }
  // Publishing frequency is an organic idea and the paid branch ignores it —
  // «عدد المنشورات اليومية في إعلانات ميتا» is not a question an ad answers.
  if (draft.kind !== 'paid') {
    for (const p of draft.platforms) {
      const f = frequencyOf(draft, p);
      if (!Number.isFinite(f.perDay) || f.perDay < 1) {
        out.push(bi(`عدد المنشورات اليومية في «${p}» يجب أن يكون ١ أو أكثر.`, `Posts per day on “${p}” must be 1 or more.`));
      }
      if (f.weekdays && f.weekdays.length === 0) {
        out.push(bi(`اختر يومًا واحدًا على الأقل للنشر في «${p}».`, `Pick at least one publishing weekday for “${p}”.`));
      }
    }
  }
  if (draft.kind === 'paid') {
    const r = draft.refresh;
    if (r.slate_size < 1) out.push(bi('حجم الدفعة يجب أن يكون ١ أو أكثر.', 'The slate size must be 1 or more.'));
    if (r.keep_min < 0 || r.keep_min > r.slate_size) {
      out.push(bi('الحد الأدنى للإبقاء يجب أن يكون بين صفر وحجم الدفعة.', 'Keep-min must be between zero and the slate size.'));
    }
    if (r.cycle_days < 1) out.push(bi('طول الدورة يجب أن يكون يومًا أو أكثر.', 'The cycle length must be one day or more.'));
    if (r.lead_time_working_days < 1) {
      out.push(bi('مهلة الإنتاج يجب أن تكون يوم عمل أو أكثر.', 'The production lead time must be one working day or more.'));
    }
  }
  return out;
}

/**
 * Which items the «نفس التواريخ بعدد أقل» alternative should drop.
 *
 * §6.3: drop from the LAST batches first — the earliest waves are the ones the
 * campaign actually needs on time, and a tail item is the cheapest thing to
 * lose. Ordering is by the item's own publishing slot (latest day, then latest
 * position in that day), so the choice is deterministic and re-running the
 * preview never shuffles a different set out.
 */
export function itemsToDrop(plan: PlanResult, maxItems: number): string[] {
  const excess = plan.items.length - Math.max(0, maxItems);
  if (excess <= 0) return [];
  const ranked = plan.items.map((i) => {
    const ordered = [...i.placements].sort((a, b) => (
      a.day === b.day ? a.slotIndex - b.slotIndex : a.day < b.day ? -1 : 1
    ));
    const last = ordered.length > 0 ? ordered[ordered.length - 1] : undefined;
    return { key: i.key, day: last?.day ?? '', slot: last?.slotIndex ?? 0 };
  }).sort((a, b) => (
    a.day === b.day ? b.slot - a.slot : a.day > b.day ? -1 : 1
  ));
  return ranked.slice(0, excess).map((r) => r.key);
}

/* ------------------------------------------------------------------ */
/* 13. reading the LIVE capacity configuration                         */
/* ------------------------------------------------------------------ */

/**
 * Where a number on the Capacity screen came from. Shown next to the value,
 * because "4" that nobody chose and "4" that a manager typed are different
 * facts, and only the second one should look settled.
 */
export type ConfigSource = 'stored' | 'default';

export interface ResolvedValue { value: number; source: ConfigSource }

export interface StepEffortRow {
  workflow_key: string;
  step_key: string;
  bucket: string;
  working_days: number;
}

/**
 * The stored effort for one step, or the engine seed when nothing is stored.
 *
 * `mos_step_effort` is keyed `(workflow_key, step_key, bucket)`, and a row may
 * be bucket-specific or the wildcard `'*'`. The specific row wins; the wildcard
 * is the fallback. Anything else is the engine's seed and is LABELLED as such,
 * so an untouched grid can never be mistaken for tuned data (and, because only
 * edited rows are sent, can never overwrite it either).
 */
export function resolveStepEffort(
  rows: StepEffortRow[], workflowKey: string, stepKey: string, bucket: string, seed: number,
): ResolvedValue {
  const mine = rows.filter((r) => r.workflow_key === workflowKey && r.step_key === stepKey);
  const exact = mine.find((r) => r.bucket === bucket);
  if (exact) return { value: exact.working_days, source: 'stored' };
  const wildcard = mine.find((r) => r.bucket === '*' || r.bucket === '');
  if (wildcard) return { value: wildcard.working_days, source: 'stored' };
  return { value: seed, source: 'default' };
}

export interface UserCapRow { user_id: string; bucket: string; daily_slots: number }

/**
 * A person's daily slots: their own override when one exists, otherwise the cap
 * the snapshot resolved for them from their role. Both are real numbers the
 * planner uses — the source only says whether a human chose this one.
 */
export function resolveUserCap(
  overrides: UserCapRow[], userId: string, bucket: string, roleFallback: number,
): ResolvedValue {
  const row = overrides.find((r) => r.user_id === userId && r.bucket === bucket);
  return row ? { value: row.daily_slots, source: 'stored' } : { value: roleFallback, source: 'default' };
}

/** `mos_settings.planning.weekend_days`, when it is a usable weekday list. */
export function weekendFromSettings(settings: Record<string, unknown>): number[] | null {
  const raw = settings.weekend_days;
  if (!Array.isArray(raw)) return null;
  const days = raw
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return days.length === raw.length ? days : null;
}
