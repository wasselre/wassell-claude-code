/**
 * Which client stages count as a QUALIFIED lead — derived, never hand-listed.
 *
 * Decision D5 of the monthly operating model (`docs/plans/monthly-operating-model-build.md`):
 * «qualified = anything that is not unqualified or lost». The canonical stage
 * list (`./config`) has thirteen stages and THREE of them are terminal-lost:
 * «غير مؤهل», «خاسر» and «يريد إيجار» — the last one a client who wants a rental
 * we do not sell, whose own config comment reads "Terminal — client wants a
 * rental we don't offer". «مغلق ناجح» is terminal too and is obviously
 * qualified, so it is the one terminal stage that stays in.
 *
 * WHY DERIVED. Two traps, both live in this repo:
 *
 *  1. **Never an ordinal range.** `src/lib/salesStudio/analytics.ts:154` already
 *     implements `stageOrderOf(c) >= 7` semantics, under which all three
 *     terminal-lost stages read as "reached every funnel stage". A rule written
 *     as `order < 10` here would silently inherit that reading, and a stage
 *     inserted in the middle would renumber the cut.
 *  2. **Never a literal.** A fourth terminal stage added by the Sales OS must
 *     change this set by itself. The derivation below is "a stage no follow-up
 *     type can be scheduled on" — which is exactly how the config marks a
 *     terminal stage (`followup_types: []`) — minus «مغلق ناجح» and minus any
 *     stage flagged `is_suspended`.
 *
 *  3. **Empty `followup_types` no longer implies terminal** (2026-09-20).
 *     «طلب غير مجاب» has no follow-up types because its work lives in
 *     `sales_tasks`, not `followups` — the relationship is very much alive and
 *     the client is demand we failed to meet. Counting it as terminal-lost
 *     would drop those clients from the qualified measure and make
 *     cost-per-qualified-lead look BETTER the worse our inventory matches the
 *     market. Hence the explicit `is_suspended` flag: a stage now has to say
 *     which kind of "no follow-up" it means.
 *
 * Pure: type-only imports apart from the config constant itself, so the api
 * bundle and the Fly worker can import it as freely as the SPA can. It reads the
 * config through `getSalesProcessConfig()`, the one accessor a persisted /
 * Studio-editable process would slot into, so an edited process changes this set
 * too.
 *
 * Consumers: `api/_lib/marketing/planning/monthActions.ts` (the month report's
 * cost per qualified lead, passed to the `mos_month_metrics` RPC as
 * `p_excluded_stages` — the RPC RAISES on an empty array rather than counting
 * every stage qualified).
 */
import { getSalesProcessConfig } from './config';
import type { SalesProcessConfig } from './types';

/** The one terminal stage that is a WIN, and therefore qualified. */
export const CLOSED_WON_STAGE = 'مغلق ناجح';

/**
 * Stages that END the relationship without a sale — the qualified measure's
 * exclusion set. Sorted so the value is stable for caching and for a SQL
 * argument that shows up in a query plan.
 */
export function terminalLostStages(
  config: SalesProcessConfig = getSalesProcessConfig(),
): string[] {
  return config.stages
    .filter((s) => (s.followup_types?.length ?? 0) === 0
      && s.value !== CLOSED_WON_STAGE
      && !s.is_suspended)
    .map((s) => s.value)
    .sort();
}

/** Is this client stage a qualified lead? An unknown/absent stage is NOT. */
export function isQualifiedStage(
  stage: string | null | undefined,
  config: SalesProcessConfig = getSalesProcessConfig(),
): boolean {
  if (!stage) return false;
  return !terminalLostStages(config).includes(stage);
}
