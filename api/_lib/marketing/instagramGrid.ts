/**
 * THE INSTAGRAM GRID RULE — the profile grid only ever grows by whole rows.
 * ============================================================================
 * Operator rule, 2026-10-01: "we only post full rows on Instagram — full,
 * complete rows."
 *
 * Instagram shows a profile as a grid three tiles wide, newest first. The month
 * plan designs organic posts as ROWS: three posts of one project, written and
 * designed together and posted minutes apart on one evening so they sit side by
 * side (`mos_content_rows`, `mos_month_template.posts_per_row` = 3). A row stays
 * a row only while everything above it also came in threes: ONE extra tile
 * shifts every tile below it by one place, and every designed row on the
 * profile breaks at once.
 *
 * That is what happened on 29–30 Sep. The publisher knew nothing about rows —
 * it handed releases to bundle.social one at a time. The eight older ربوة الرمز
 * posts belonged to no row and went out as 1 + 7; the one (P-150) was later
 * taken off Instagram, and the seven left are two rows plus one. That one extra
 * tile split both يمام rows underneath it.
 *
 * The rule, enforced in `publishRelease.ts` for every caller (the sweep and
 * «انشر الآن» alike):
 *
 *   • A release lands on the grid when it is an Instagram release whose
 *     destination is not a story: a feed post (one image, a carousel, or a
 *     single video, which goes out as a Reel). Stories never touch the grid
 *     and are not affected.
 *   • A grid release goes out only WITH ITS ROW. The content must belong to a
 *     row holding exactly three live Instagram grid releases, and every one not
 *     yet sent must pass the material rule at the same moment. Then all of them
 *     are handed to bundle.social together, each at its own planned time, in
 *     the row's order. If any one is not ready, none goes.
 *   • A handoff that fails part-way takes back what it already scheduled, so a
 *     failure leaves no tiles rather than one or two.
 *   • A post that belongs to no row never reaches the grid. It can still go to
 *     stories.
 *   • A row that is already partly out (an older failure) is completed, never
 *     left short: the members still to send go together.
 *
 * Pure, so the rule is testable without a platform or a database.
 */

/** Instagram's profile grid is three tiles wide; a row is exactly this many posts. */
export const INSTAGRAM_GRID_COLUMNS = 3;

/** How far ahead a row is scheduled when its moment has already come: room to
 *  hand off all three — and to take them back if one fails — before the first
 *  goes live. The sweep normally hands a row off ~15 minutes early, so its
 *  planned times are kept as they are. */
export const ROW_LEAD_MS = 5 * 60_000;

/** The least time between two posts of one row, so Instagram keeps their order. */
export const ROW_MIN_GAP_MS = 2 * 60_000;

/** The longest a row may take from its first post to its last. The plan spreads
 *  a row over 10 minutes (18:00, 18:05, 18:10); anything wider means one of its
 *  posts was moved on its own, and posting the rest first would leave the grid
 *  short for however long the gap is. */
export const ROW_MAX_SPAN_MS = 30 * 60_000;

/**
 * Does this release land on the Instagram profile grid?
 *
 * `placement` is the destination the publisher will actually use: the managed
 * variant ('feed' | 'story'), or null for a legacy release — which always goes
 * out as a feed POST or a Reel, both of which sit on the grid.
 */
export function landsOnInstagramGrid(platform: string, placement: string | null | undefined): boolean {
  return platform === 'instagram' && placement !== 'story';
}

/** One Instagram grid release of a row member, as the rule needs to see it. */
export interface GridRelease {
  releaseId: string;
  contentId: string;
  ref: string | null;
  /** The writer's order inside the row (0 = read first). */
  rowOrder: number | null;
  status: string;
  bundlePostId: string | null;
  bundleStatus: string | null;
  /** COALESCE(scheduled_at, planned_at). */
  dueAt: string | null;
}

/**
 * Already handed to the platform, or already on Instagram. A bundle post that
 * died (ERROR / DELETED) is not out: it is sent again, with its row.
 */
export function isAlreadyOut(r: GridRelease): boolean {
  if (r.status === 'published') return true;
  if (!r.bundlePostId) return false;
  const s = (r.bundleStatus ?? '').toUpperCase();
  return s !== 'ERROR' && s !== 'DELETED';
}

/**
 * Posting order inside a row. The plan reverses the writer's order — the post
 * read first (row_order 0) goes LAST, so it is the newest and takes the row's
 * first tile. Ties fall back to the planned time, then the id, so the order is
 * always the same.
 */
export function rowPostingOrder(a: GridRelease, b: GridRelease): number {
  const ao = a.rowOrder ?? -1;
  const bo = b.rowOrder ?? -1;
  if (ao !== bo) return bo - ao;
  const at = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
  const bt = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
  if (at !== bt) return at < bt ? -1 : 1;
  return a.releaseId < b.releaseId ? -1 : a.releaseId > b.releaseId ? 1 : 0;
}

export const NOT_IN_ROW = {
  ar: 'منشورات الفيد في إنستقرام تُنشر صفوفًا كاملة من ثلاثة فقط، وهذا المنشور ليس ضمن صف — لا يُنشر وحده. يمكن نشره ستوري.',
  en: 'Instagram feed posts go out only as complete rows of three, and this post is not part of a row — it is never posted on its own. It can still go out as a story.',
} as const;

export type RowVerdict =
  | { kind: 'not_in_row' }
  | { kind: 'malformed'; ar: string; en: string; live: GridRelease[] }
  | { kind: 'complete' }
  | { kind: 'send'; toSend: GridRelease[]; alreadyOut: GridRelease[] };

/**
 * May this row go to the grid, and which of its releases are still to send?
 * `releases` are the Instagram grid releases of every member of the row,
 * cancelled ones included (they are filtered here).
 */
export function judgeRow(rowId: string | null, releases: GridRelease[]): RowVerdict {
  if (!rowId) return { kind: 'not_in_row' };
  const live = releases.filter((r) => r.status !== 'cancelled');
  const members = new Set(live.map((r) => r.contentId));
  if (members.size !== live.length) {
    return {
      kind: 'malformed', live,
      ar: 'أحد منشورات هذا الصف له أكثر من نشر فيد على إنستقرام — لا يُنشر الصف حتى يبقى لكل منشور نشر واحد.',
      en: 'A post in this row has more than one Instagram feed release — the row is not posted until each post has exactly one.',
    };
  }
  if (live.length !== INSTAGRAM_GRID_COLUMNS) {
    return {
      kind: 'malformed', live,
      ar: `صف إنستقرام يحتاج ${INSTAGRAM_GRID_COLUMNS} منشورات فيد قائمة، وفي هذا الصف ${live.length} — لا يُنشر صف ناقص. ألغِ الصف كله أو أعد المنشور الملغى.`,
      en: `An Instagram row needs ${INSTAGRAM_GRID_COLUMNS} live feed posts and this row has ${live.length} — a partial row is never posted. Cancel the whole row or restore the cancelled post.`,
    };
  }
  const toSend = live.filter((r) => !isAlreadyOut(r)).sort(rowPostingOrder);
  if (toSend.length === 0) return { kind: 'complete' };
  return { kind: 'send', toSend, alreadyOut: live.filter(isAlreadyOut) };
}

/**
 * The time each release of the row is scheduled for, in posting order.
 *
 * A release keeps its planned time when that is still ahead. When the moment has
 * passed (a late approval, «انشر الآن» on a held row), the row goes as soon as
 * it safely can — never earlier than `ROW_LEAD_MS` from now — and each post at
 * least `ROW_MIN_GAP_MS` after the one before, so Instagram still lays the row
 * out in its order.
 */
export function rowPostDates(
  toSend: ReadonlyArray<{ releaseId: string; dueAt: string | null }>, nowMs: number,
): Map<string, string> {
  const out = new Map<string, string>();
  let prev = Number.NEGATIVE_INFINITY;
  for (const r of toSend) {
    const slot = r.dueAt ? Date.parse(r.dueAt) : Number.NaN;
    const t = Math.max(
      Number.isFinite(slot) ? slot : Number.NEGATIVE_INFINITY,
      nowMs + ROW_LEAD_MS,
      prev + ROW_MIN_GAP_MS,
    );
    out.set(r.releaseId, new Date(t).toISOString());
    prev = t;
  }
  return out;
}

export type RowTiming =
  | { ok: true; dates: Map<string, string> }
  | { ok: false; latest: string; ar: string; en: string };

/**
 * The row's times, or a refusal when its posts are not scheduled together.
 *
 * A row posts as ONE burst. When a person moved one of its posts on its own —
 * «أعد الجدولة» works per post — the rest must not go first and leave the grid
 * a tile or two short until the moved one catches up. The row waits instead,
 * and goes together when its latest post comes due: by then the others' times
 * have passed, so they close up behind it (see `rowPostDates`).
 */
export function rowTiming(
  toSend: ReadonlyArray<{ releaseId: string; ref?: string | null; dueAt: string | null }>, nowMs: number,
): RowTiming {
  const dates = rowPostDates(toSend, nowMs);
  const times = [...dates.values()].map((d) => Date.parse(d));
  const first = Math.min(...times);
  const last = Math.max(...times);
  if (last - first <= ROW_MAX_SPAN_MS) return { ok: true, dates };
  const latest = new Date(last).toISOString();
  const riyadh = new Date(last + 3 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
  return {
    ok: false, latest,
    ar: `منشورات هذا الصف ليست مجدولة معًا — آخرها في ${riyadh} بتوقيت الرياض. ينتظر الصف ويُنشر كاملًا في ذلك الموعد، أو أعد جدولة منشوراته الثلاثة على وقت واحد.`,
    en: `This row's posts are not scheduled together — the last is at ${riyadh} Riyadh time. The row waits and posts whole then, or reschedule all three of its posts to one time.`,
  };
}

/* ------------------------------------------------------------------ */
/* handing a row off — all of it, or none of it                         */
/* ------------------------------------------------------------------ */

/** The platform and database steps a row handoff needs, injected so the
 *  all-or-nothing logic is testable without bundle.social or Supabase. */
export interface RowHandoffSteps<P, Post extends { id: string }> {
  /** Upload the files and create the scheduled post. Throws on failure. */
  create(item: P, postDate: string): Promise<Post>;
  /** Record the handoff on the publication row. Returns an error message, or null. */
  record(item: P, post: Post, postDate: string): Promise<string | null>;
  /** Delete scheduled posts and confirm each is gone. Returns the ids still live. */
  takeBack(postIds: string[]): Promise<string[]>;
  /** Put already-recorded publication rows back as they were. Returns the ids it could not restore. */
  restore(items: P[]): Promise<string[]>;
}

export type RowHandoffResult =
  | { ok: true; handedOff: Array<{ postId: string; postDate: string }> }
  | {
      ok: false;
      stage: 'create' | 'record';
      /** Index (in posting order) of the release that failed. */
      failedAt: number;
      message: string;
      /** Scheduled posts that could NOT be taken back — live work for a person. */
      leftLive: string[];
      /** Publication rows that could not be put back. */
      unrestored: string[];
    };

/**
 * Hand every release of the row to the platform, in order. If one fails, the
 * posts already created are taken back (and any rows already recorded are put
 * back), so the grid gets the whole row or nothing.
 */
export async function handOffRow<P, Post extends { id: string }>(
  items: ReadonlyArray<{ item: P; postDate: string }>, steps: RowHandoffSteps<P, Post>,
): Promise<RowHandoffResult> {
  const created: Array<{ item: P; post: Post; postDate: string }> = [];
  for (const [i, { item, postDate }] of items.entries()) {
    try {
      const post = await steps.create(item, postDate);
      created.push({ item, post, postDate });
    } catch (e) {
      const leftLive = await steps.takeBack(created.map((c) => c.post.id));
      return {
        ok: false, stage: 'create', failedAt: i,
        message: e instanceof Error ? e.message : String(e),
        leftLive, unrestored: [],
      };
    }
  }
  const recorded: P[] = [];
  for (const [i, c] of created.entries()) {
    const err = await steps.record(c.item, c.post, c.postDate);
    if (err !== null) {
      const leftLive = await steps.takeBack(created.map((x) => x.post.id));
      const unrestored = recorded.length > 0 ? await steps.restore(recorded) : [];
      return { ok: false, stage: 'record', failedAt: i, message: err, leftLive, unrestored };
    }
    recorded.push(c.item);
  }
  return { ok: true, handedOff: created.map((c) => ({ postId: c.post.id, postDate: c.postDate })) };
}
