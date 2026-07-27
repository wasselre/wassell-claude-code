/**
 * Pure planning logic for the Posts Content writer: how many posts each
 * project gets, and which marketing angles those posts are written from.
 *
 * Kept free of React, network and Supabase so it can be unit-tested directly
 * (src/lib/__tests__/postsContentPlanning.test.ts) — the distribution and the
 * angle ranking are the two places a silent off-by-one would quietly change
 * what the user asked for.
 */

import { POST_ANGLES, matchAngleEvidence, type PostAngle, type UnitTypeValue } from './templates';

/** Safety ceiling for one generation run — see PLAN_LIMITS in the PRD. */
export const MAX_POSTS_PER_BATCH = 60;
export const MAX_POSTS_PER_PROJECT = 30;
export const MAX_PROJECTS_PER_BATCH = 10;

export type QuantityMode = 'total' | 'per_project';
export type PostLanguage = 'ar' | 'en' | 'both';

/**
 * Split `total` posts across `projectCount` projects as evenly as possible.
 * The remainder goes to the EARLIEST projects, deterministically — so the same
 * request always yields the same split and the preview shown before generation
 * is exactly what runs. 10 across 3 → [4, 3, 3].
 */
export function distributePosts(total: number, projectCount: number): number[] {
  if (projectCount <= 0 || total <= 0) return [];
  const base = Math.floor(total / projectCount);
  const remainder = total % projectCount;
  return Array.from({ length: projectCount }, (_, i) => base + (i < remainder ? 1 : 0));
}

export interface AngleScore {
  angleId: string;
  /** Matched evidence keywords from the project's own data. */
  evidence: string[];
  /** Higher = better grounded. Below MIN_ANGLE_SCORE the angle is excluded. */
  score: number;
}

/**
 * Minimum grounding for an angle to be generated at all.
 *
 * Set to 2 after reviewing live output: a single incidental keyword produced
 * junk eligibility — «سطح» (a rooftop feature) made the "family independence"
 * angle eligible for an apartment tower, and «حديقة» made "prestige" eligible.
 * Requiring TWO evidence keywords, or one keyword plus a unit-type the angle
 * naturally fits, drops that tail without losing genuinely-supported angles.
 */
export const MIN_ANGLE_SCORE = 2;

/**
 * Score every angle against ONE project's real facts and drop the unsupported
 * ones.
 *
 * Scoring: one point per distinct evidence keyword the project's text actually
 * contains, plus one bonus point when the project's unit type is a type the
 * angle reads naturally for. An angle scoring below MIN_ANGLE_SCORE is excluded
 * — the product rule is "never generate an angle the data can't back", not
 * "generate it and warn".
 *
 * Ties break on the angle's registry order, so ranking is stable across runs.
 */
export function rankAngles(
  haystack: string[],
  unitTypes: string[],
  angles: PostAngle[] = POST_ANGLES,
): AngleScore[] {
  const types = new Set(unitTypes);
  return angles
    .map((a) => {
      const evidence = matchAngleEvidence(a, haystack);
      const typeBonus = a.preferred_types.some((t) => types.has(t as UnitTypeValue)) ? 1 : 0;
      return { angleId: a.id, evidence, score: evidence.length === 0 ? 0 : evidence.length + typeBonus };
    })
    .filter((s) => s.score >= MIN_ANGLE_SCORE)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const oa = angles.find((x) => x.id === a.angleId)?.order ?? 0;
      const ob = angles.find((x) => x.id === b.angleId)?.order ?? 0;
      return oa - ob;
    });
}

export interface PostAssignment {
  angleId: string;
  /** 0 for the first post from this angle, 1 for the second, … */
  variationIndex: number;
  evidence: string[];
  /** 1-based position within this project's posts. */
  postNumber: number;
}

/**
 * Turn a ranked angle list into exactly `count` post assignments, strongest
 * angle first. An angle is only reused once every supported angle has been
 * used — and each reuse carries a `variationIndex` the prompt uses to force a
 * different hook, headline shape, lead benefit and closing.
 *
 * Returns FEWER than `count` only when the project supports no angles at all
 * (empty ranking); the caller surfaces that as an explicit shortfall rather
 * than padding with invented claims.
 */
export function assignAngles(ranked: AngleScore[], count: number): PostAssignment[] {
  if (ranked.length === 0 || count <= 0) return [];
  const out: PostAssignment[] = [];
  for (let i = 0; i < count; i++) {
    const pick = ranked[i % ranked.length];
    if (!pick) break;
    out.push({
      angleId: pick.angleId,
      variationIndex: Math.floor(i / ranked.length),
      evidence: pick.evidence,
      postNumber: i + 1,
    });
  }
  return out;
}

export interface PlannedProject {
  ourProjectId: string;
  requested: number;
}

export interface QuantityPlan {
  perProject: PlannedProject[];
  total: number;
  errors: string[];
}

/**
 * Validate + resolve the requested quantities into a concrete per-project plan.
 *
 * Never silently changes what the user asked for: an over-limit request comes
 * back as an ERROR (with the limit named), not as a quietly truncated batch.
 */
export function buildQuantityPlan(args: {
  projectIds: string[];
  mode: QuantityMode;
  /** Used when mode === 'total'. */
  totalCount: number;
  /** Used when mode === 'per_project'; keyed by our_projects id. */
  perProjectCounts: Record<string, number>;
  isAr: boolean;
}): QuantityPlan {
  const { projectIds, mode, totalCount, perProjectCounts, isAr } = args;
  const errors: string[] = [];

  if (projectIds.length === 0) {
    errors.push(isAr ? 'اختر مشروعًا واحدًا على الأقل.' : 'Select at least one project.');
    return { perProject: [], total: 0, errors };
  }
  if (projectIds.length > MAX_PROJECTS_PER_BATCH) {
    errors.push(
      isAr
        ? `الحد الأقصى ${MAX_PROJECTS_PER_BATCH} مشاريع في الدفعة الواحدة (اخترت ${projectIds.length}).`
        : `At most ${MAX_PROJECTS_PER_BATCH} projects per batch (you selected ${projectIds.length}).`,
    );
  }

  let perProject: PlannedProject[];
  if (mode === 'total') {
    if (!Number.isInteger(totalCount) || totalCount < 1) {
      errors.push(isAr ? 'أدخل عددًا صحيحًا للمنشورات (1 فأكثر).' : 'Enter a whole number of posts (1 or more).');
      return { perProject: [], total: 0, errors };
    }
    if (totalCount < projectIds.length) {
      errors.push(
        isAr
          ? `العدد الإجمالي (${totalCount}) أقل من عدد المشاريع (${projectIds.length}) — بعض المشاريع لن تحصل على منشور.`
          : `The total (${totalCount}) is smaller than the number of projects (${projectIds.length}) — some projects would get none.`,
      );
    }
    const split = distributePosts(totalCount, projectIds.length);
    perProject = projectIds.map((id, i) => ({ ourProjectId: id, requested: split[i] ?? 0 }));
  } else {
    perProject = projectIds.map((id) => ({ ourProjectId: id, requested: perProjectCounts[id] ?? 0 }));
    if (perProject.every((p) => p.requested < 1)) {
      errors.push(isAr ? 'حدّد عدد المنشورات لكل مشروع.' : 'Set a post count for each project.');
    }
  }

  for (const p of perProject) {
    if (p.requested > MAX_POSTS_PER_PROJECT) {
      errors.push(
        isAr
          ? `الحد الأقصى ${MAX_POSTS_PER_PROJECT} منشورًا للمشروع الواحد.`
          : `At most ${MAX_POSTS_PER_PROJECT} posts per project.`,
      );
      break;
    }
  }

  const total = perProject.reduce((s, p) => s + Math.max(0, p.requested), 0);
  if (total > MAX_POSTS_PER_BATCH) {
    errors.push(
      isAr
        ? `الحد الأقصى ${MAX_POSTS_PER_BATCH} منشورًا في الدفعة الواحدة (طلبت ${total}).`
        : `At most ${MAX_POSTS_PER_BATCH} posts per batch (you requested ${total}).`,
    );
  }

  return { perProject: perProject.filter((p) => p.requested > 0), total, errors };
}
