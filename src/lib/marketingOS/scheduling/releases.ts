/**
 * Releases — putting a finished creative out, as its own job.
 *
 * Making a design and publishing it are different work. They are done by
 * different people, at different times, and one creative can be released many
 * times: two platforms, two dates, or the same evergreen post run again next
 * quarter. Until 2026-09-14 the content workflow ended in a single
 * `scheduling` + `publish_check` pair, which meant:
 *
 *   • N destinations shared ONE task, with one owner and one completion, so
 *     closing it declared the whole creative published and the second platform
 *     was invisible;
 *   • every paid creative booked those two steps too, even though an ad's path
 *     closes at final approval and the ad is built by the worker — measured at
 *     twenty phantom tasks for a two-week ten-creative Meta campaign;
 *   • `scheduling` drew on the writer's PRODUCTION budget, so publishing work
 *     that never happened displaced design work that had to.
 *
 * So a release is modelled here instead, and it is charged to its own
 * `publishing` bucket.
 *
 * THE RULE THAT MAKES THIS AN IMPROVEMENT: a release only becomes a task when a
 * person is actually needed. Where a connected account can publish by itself,
 * the system schedules the post and asks nobody. Splitting publishing out
 * WITHOUT this rule would simply manufacture more of the orphaned publish
 * checks it exists to remove — on 2026-09-14 production held three of those,
 * open since the 12th, unassigned, because nobody holds the role that owns the
 * step.
 *
 * What this module may decide is only what the PLAN can know: whether the
 * destination can publish by itself. Reasons discovered at run time — the
 * preflight blocked it, the platform rejected it, the ad failed — are not
 * plan-time facts and are never guessed here. The release sweep raises a task
 * for those when they actually happen.
 *
 * PURE.
 */
import type { WorkCalendar } from './calendar';
import { isWorkingDay, nextWorkingDay, toInstant } from './calendar';
import type { CapacityBook } from './ledger';
import type {
  PathRole, PlacementVariant, PlanConflict, PlannedItem, PlannedRelease, ReleaseKind,
  ReleaseReason,
} from './types';

/** What the planner needs to know about publishing, all of it operator data. */
export interface PublishingRules {
  /**
   * Platform → can the system publish to it by itself right now.
   *
   * True means BOTH that an integration exists AND that a connected account on
   * it is allowed to publish. The API derives it from `mos_platform_accounts`;
   * it is never inferred from the platform name, because "Instagram" tells you
   * nothing about whether this tenant's Instagram is actually connected.
   */
  automatable: Record<string, boolean>;
  /** Platforms the operator has deliberately kept manual even though they could be automated. */
  manualByPolicy?: string[];
  /** Working-day effort of ONE release a person has to do. */
  releaseEffortDays: number;
  /** Role that owns a manual organic release. */
  organicOwnerRole: PathRole;
  /** Role that owns a manual ad release. */
  adOwnerRole: PathRole;
  /** Platform → the account a release lands on, when the plan already knows one. */
  accountByPlatform?: Record<string, string | null>;
  /**
   * The month template's publishing moment for a ROW. Only consulted for items
   * that belong to one; absent = the engine default below.
   */
  rowPublishing?: RowPublishing;
}

/**
 * When a row's three posts go out (`mos_month_template.publish_time` +
 * `intra_row_gap_minutes`).
 */
export interface RowPublishing {
  /** `HH:MM` in the calendar's zone. */
  publishTime: string;
  /** Minutes between consecutive feed posts of the same row. */
  intraRowGapMinutes: number;
}

export const DEFAULT_ROW_PUBLISHING: RowPublishing = {
  publishTime: '18:00',
  intraRowGapMinutes: 5,
};

/** The last minute of a civil day, in minutes past midnight. */
const LAST_MINUTE = 23 * 60 + 59;

/**
 * The row-publishing moment, PARSED and CHECKED.
 *
 * `publishTime` and `intraRowGapMinutes` are operator data
 * (`mos_month_template`), so they can be wrong, and until 2026-09-15 being
 * wrong was silent in two different ways:
 *
 *   • a value the pattern rejected (`25:00`, `6pm`, `18:0`) quietly became
 *     18:00, so the screen showed one time and the plan carried another;
 *   • a row that spilled past midnight had every overflowing member clamped
 *     onto 23:59, which **collapses the publish order** — with `23:00` and a
 *     60-minute gap, two of three posts land on the same minute and the
 *     reverse-order rule this module exists to enforce is destroyed.
 *
 * Neither is recoverable here: this function has no conflict channel and a
 * publishing time is not the engine's to invent. So both are REPORTED, and
 * `plan.ts` — which does have the channel — raises a `publish_time` conflict
 * and refuses the plan rather than shipping a month with colliding posts.
 */
export interface RowPublishingCheck {
  /** Base hour 0–23 actually used (after the fallback). */
  hour: number;
  /** Base minute 0–59 actually used (after the fallback). */
  minute: number;
  /** Minutes between consecutive feed posts, ≥ 0. */
  gap: number;
  /** Effective `HH:MM` — what the plan will really publish the LAST-read post at. */
  publishTime: string;
  /** `publishTime` was not a real `HH:MM`; `DEFAULT_ROW_PUBLISHING` was used instead. */
  invalidTime: boolean;
  /** A row of `rowSize` does not fit before midnight — members collide on 23:59. */
  clamped: boolean;
  /** The `HH:MM` the earliest-published member would have taken, unclamped. */
  wouldEndAt: string;
}

/**
 * Parse + validate one `RowPublishing` against the widest row that will use it.
 *
 * `rowSize` is the member count of the LARGEST row in the plan: the check is
 * "does this row still fit inside its own day", and only the widest row can
 * push past midnight.
 */
export function checkRowPublishing(
  pub: RowPublishing | null | undefined, rowSize = 1,
): RowPublishingCheck {
  // ABSENT is not INVALID. No `rowPublishing` at all means "no month template
  // in play", which is a legitimate state with a legitimate default — the same
  // one `rowSlotTime`'s default parameter uses. `invalidTime` must mean "a
  // value was supplied and it is unusable", or every plan built from the bare
  // engine defaults would refuse itself.
  const eff = pub ?? DEFAULT_ROW_PUBLISHING;
  const raw = (eff.publishTime ?? '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  const h = m ? Number(m[1]) : NaN;
  const mi = m ? Number(m[2]) : NaN;
  // A pattern match is not a valid time: `25:70` matches and is nonsense.
  const ok = Number.isInteger(h) && Number.isInteger(mi) && h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
  const hour = ok ? h : 18;
  const minute = ok ? mi : 0;
  const gap = Math.max(0, Math.floor(Number(eff.intraRowGapMinutes) || 0));
  const size = Math.max(1, Math.floor(rowSize));
  const end = hour * 60 + minute + (size - 1) * gap;
  return {
    hour,
    minute,
    gap,
    publishTime: hhmm(hour * 60 + minute),
    invalidTime: !ok,
    clamped: end > LAST_MINUTE,
    wouldEndAt: end > LAST_MINUTE ? `${Math.floor(end / 60)}:${String(end % 60).padStart(2, '0')}` : hhmm(end),
  };
}

const hhmm = (total: number): string =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

/**
 * `HH:MM` for the member at `rowOrder` of a row of `rowSize` — **reversed**.
 *
 * Instagram shows newest first, so the post the WRITER placed first must be
 * published LAST for a reader to meet it first. With three posts, a 18:00
 * publish time and a 5-minute gap:
 *
 *   row_order 0 (first read)  → 18:10
 *   row_order 1              → 18:05
 *   row_order 2 (last read)  → 18:00
 *
 * The story of a post shares its feed post's moment — one slot, two placements.
 *
 * `rowOrder` here is the member's POSITION among the row's LIVE members, not
 * its stored `row_order`: a dropped member must close the gap it left rather
 * than leave a hole, and only the caller that holds the live list knows that.
 * `plan.ts` is that caller, and it is the ONLY one (see `buildReleases`).
 */
export function rowSlotTime(
  rowOrder: number, rowSize: number, pub: RowPublishing = DEFAULT_ROW_PUBLISHING,
): string {
  const chk = checkRowPublishing(pub, rowSize);
  const size = Math.max(1, Math.floor(rowSize));
  const order = Math.min(Math.max(0, Math.floor(rowOrder)), size - 1);
  const total = chk.hour * 60 + chk.minute + (size - 1 - order) * chk.gap;
  // A row that would spill past midnight stays on its own day: the last minute
  // of it is still the same batch, and a post silently jumping to the next
  // civil date would break the batch/row identity everything else keys on. The
  // clamp is reported by `checkRowPublishing().clamped`, because on its own it
  // silently merges two members onto one minute.
  return hhmm(Math.min(total, LAST_MINUTE));
}

/**
 * The ISO instant of `rowSlotTime` on `day` — the one PRODUCER of a row's
 * batch moment.
 *
 * It has exactly ONE caller: `plan.ts`'s row placement loop, which writes the
 * result onto `PlannedPlacement.plannedAt`. `buildReleases` deliberately does
 * NOT call it — it reads the placement. Adding a second caller re-opens the
 * divergence removed on 2026-09-15 (see the comment in `buildReleases`).
 */
export function rowReleaseInstant(
  day: string, rowOrder: number, rowSize: number, pub: RowPublishing, cal: WorkCalendar,
): string {
  return toInstant(day, rowSlotTime(rowOrder, rowSize, pub), cal);
}

export const DEFAULT_PUBLISHING: PublishingRules = {
  automatable: {},
  manualByPolicy: [],
  releaseEffortDays: 0.25,
  // The writer already owned `scheduling` before the split, so keeping the
  // owner unchanged is the least surprising default. It is a setting, not a
  // law: `mos_settings.planning.release_owner_role` overrides it.
  organicOwnerRole: 'writer',
  adOwnerRole: 'marketing_manager',
};

/** `null` when the release is automatic. Otherwise why a person is needed. */
export function releaseReason(platform: string, rules: PublishingRules): ReleaseReason | null {
  if ((rules.manualByPolicy ?? []).includes(platform)) return 'manual_by_policy';
  const known = Object.prototype.hasOwnProperty.call(rules.automatable, platform);
  // An UNKNOWN platform is not automatable. Defaulting the other way would
  // silently promise a publish nothing can perform.
  if (!known) return 'platform_not_automatable';
  return rules.automatable[platform] === true ? null : 'account_not_connected';
}

export interface BuildReleasesResult {
  releases: PlannedRelease[];
  /** (userId, day, bucket) triples the load table must include. */
  touched: Array<{ userId: string; day: string; bucket: 'publishing' }>;
  conflicts: PlanConflict[];
}

/** One half of an organic post's publication pair, or the single legacy release. */
interface VariantSpec {
  variant: PlacementVariant | null;
  /** Key suffix — empty for the legacy single release, so its key never moves. */
  suffix: string;
  carriesCaption: boolean;
}

/** The legacy shape: one release per placement, caption and all. */
const SINGLE: VariantSpec[] = [{ variant: null, suffix: '', carriesCaption: true }];

/**
 * The month model's pair. The FEED post is the square design and carries the
 * caption; the STORY is the vertical design and carries **no caption at all** —
 * only the picture (§3.4 rule 4).
 */
const FEED_SUFFIX = ':feed';
const PAIR: VariantSpec[] = [
  { variant: 'feed', suffix: FEED_SUFFIX, carriesCaption: true },
  { variant: 'story', suffix: ':story', carriesCaption: false },
];

/**
 * One release per placement for a loose organic item; **TWO** for a post that
 * belongs to a row (feed + story); one per creative for paid.
 *
 * Manual releases are assigned and booked against the `publishing` bucket on
 * their own day. Automatic ones cost nobody anything and are still returned, so
 * the preview can show every destination rather than only the awkward ones.
 * A pair is booked as two units of work when a person has to do it, because
 * posting a feed post and posting a story are two actions.
 */
export function buildReleases(
  items: PlannedItem[],
  kind: 'organic' | 'paid',
  rules: PublishingRules,
  book: CapacityBook,
  cal: WorkCalendar,
): BuildReleasesResult {
  const releases: PlannedRelease[] = [];
  const touched: Array<{ userId: string; day: string; bucket: 'publishing' }> = [];
  const conflicts: PlanConflict[] = [];
  const releaseKind: ReleaseKind = kind === 'paid' ? 'ad' : 'organic';
  const ownerRole = releaseKind === 'ad' ? rules.adOwnerRole : rules.organicOwnerRole;
  const effort = Math.max(0, rules.releaseEffortDays);

  for (const it of items) {
    const inRow = releaseKind === 'organic' && Boolean(it.rowKey);
    const specs = inRow ? PAIR : SINGLE;
    for (const pl of it.placements) {
      const reason = releaseKind === 'ad'
        // An ad is built and verified by the worker once the caption is
        // approved. There is no human publish step to invent, and inventing one
        // is exactly the phantom load this split removes.
        ? null
        : releaseReason(pl.platform, rules);
      const needsPerson = reason !== null;
      const base = `${it.key}@${pl.platform}#${pl.day}`;
      // THE PLACEMENT IS THE MOMENT. Not recomputed here — READ.
      //
      // This used to call `rowReleaseInstant(pl.day, it.rowOrder, …)` while
      // `plan.ts` built the placement from the member's POSITION among the live
      // members. The two agree only while `row_order` is exactly 0…n−1, which
      // `overrides.droppedItemKeys` breaks — and §3.3 names "drop the late post"
      // as a standing exception. Measured on a 3-post row with member 1 dropped:
      // the survivors' placements read 18:05 / 18:00 while their releases both
      // read 18:00, so `mos_content_placements.planned_at` and
      // `mos_publications.planned_at` held DIFFERENT times for the same post and
      // two posts published at the same second in the wrong order.
      //
      // There is now exactly ONE producer of a row's moment (`plan.ts`'s
      // placement loop) and every other reader takes it from the placement, so
      // the drift this comment used to merely assert away is structurally
      // impossible.
      const plannedAt = pl.plannedAt;
      const pairId = inRow ? `${base}${FEED_SUFFIX}` : null;

      for (const spec of specs) {
        const rel: PlannedRelease = {
          key: `${base}${spec.suffix}`,
          itemKey: it.key,
          kind: releaseKind,
          platform: pl.platform,
          executionKey: pl.executionKey,
          day: pl.day,
          plannedAt,
          accountId: rules.accountByPlatform?.[pl.platform] ?? null,
          needsPerson,
          reason,
          assigneeUserId: null,
          workingDays: needsPerson ? effort : 0,
          placementVariant: spec.variant,
          pairId,
          carriesCaption: spec.carriesCaption,
        };

        if (needsPerson && effort > 0) {
          // Book it on the release day itself, never earlier: a release is not
          // production and has no backward chain to satisfy.
          const day = isWorkingDay(pl.day, cal) ? pl.day : nextWorkingDay(pl.day, cal);
          const people = book.eligible(ownerRole, 'publishing');
          const cand = people
            .filter((p) => book.fits(p.userId, [day], 'publishing', [effort]))
            .sort((a, b) => (a.userId < b.userId ? -1 : 1))[0];
          if (cand) {
            book.add(cand.userId, day, 'publishing', effort);
            rel.assigneeUserId = cand.userId;
            touched.push({ userId: cand.userId, day, bucket: 'publishing' });
          } else {
            // A release never makes a campaign infeasible — the creative is
            // finished either way and the post can go out late. It is recorded
            // unassigned so the queue still shows the work instead of hiding it.
            conflicts.push({
              kind: 'no_capacity',
              itemKey: it.key,
              stepKey: 'release',
              day,
              messageAr: `النشر على ${pl.platform} في ${day} بلا مسؤول متاح — ستفتح المهمة بلا تعيين.`,
              messageEn: `The ${pl.platform} release on ${day} has no available owner — the task will open unassigned.`,
              detail: { platform: pl.platform, reason, placementVariant: spec.variant },
            });
          }
        }
        releases.push(rel);
      }
    }
  }

  releases.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.key < b.key ? -1 : 1));
  return { releases, touched, conflicts };
}

/** Totals for the preview, counted from the releases (never assumed). */
export function releaseTotals(releases: PlannedRelease[]): {
  total: number; automatic: number; manual: number; feed: number; story: number;
} {
  let manual = 0;
  let feed = 0;
  let story = 0;
  for (const r of releases) {
    if (r.needsPerson) manual += 1;
    if (r.placementVariant === 'feed') feed += 1;
    else if (r.placementVariant === 'story') story += 1;
  }
  return { total: releases.length, automatic: releases.length - manual, manual, feed, story };
}
