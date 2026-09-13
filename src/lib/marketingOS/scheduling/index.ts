/**
 * The campaign scheduling engine — one deterministic planner shared by the
 * preview (`campaign_plan_preview`) and the commit (`campaign_plan_commit`).
 *
 * PURE: safe to import from `src/**`, `api/**` and `worker/**`.
 */
export * from './calendar';
export * from './types';
export * from './defaults';
export * from './platforms';
export { effortWeights, CapacityBook } from './ledger';
export { forecastCycles, creativeTotals, type CycleForecast } from './refresh';
export { computeDeadlines, scheduleProduction } from './schedule';
export {
  distribute, buildSlots, slotCapacity, publishingDays,
  type DistItem, type PlatformPlan,
} from './distribute';
export { planCampaign, DEFAULT_RULES, type RuleSet } from './plan';
