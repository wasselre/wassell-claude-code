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
import { isWorkingDay, nextWorkingDay } from './calendar';
import type { CapacityBook } from './ledger';
import type {
  PathRole, PlanConflict, PlannedItem, PlannedRelease, ReleaseKind, ReleaseReason,
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

/**
 * One release per placement for organic; one per creative for paid.
 *
 * Manual releases are assigned and booked against the `publishing` bucket on
 * their own day. Automatic ones cost nobody anything and are still returned, so
 * the preview can show every destination rather than only the awkward ones.
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
    for (const pl of it.placements) {
      const reason = releaseKind === 'ad'
        // An ad is built and verified by the worker once the caption is
        // approved. There is no human publish step to invent, and inventing one
        // is exactly the phantom load this split removes.
        ? null
        : releaseReason(pl.platform, rules);
      const needsPerson = reason !== null;
      const rel: PlannedRelease = {
        key: `${it.key}@${pl.platform}#${pl.day}`,
        itemKey: it.key,
        kind: releaseKind,
        platform: pl.platform,
        executionKey: pl.executionKey,
        day: pl.day,
        plannedAt: pl.plannedAt,
        accountId: rules.accountByPlatform?.[pl.platform] ?? null,
        needsPerson,
        reason,
        assigneeUserId: null,
        workingDays: needsPerson ? effort : 0,
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
            detail: { platform: pl.platform, reason },
          });
        }
      }
      releases.push(rel);
    }
  }

  releases.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.key < b.key ? -1 : 1));
  return { releases, touched, conflicts };
}

/** Totals for the preview, counted from the releases (never assumed). */
export function releaseTotals(releases: PlannedRelease[]): {
  total: number; automatic: number; manual: number;
} {
  let manual = 0;
  for (const r of releases) if (r.needsPerson) manual += 1;
  return { total: releases.length, automatic: releases.length - manual, manual };
}
