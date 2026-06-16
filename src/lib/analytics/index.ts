/**
 * Public surface of the universal analytics engine. Consumers (dashboards, the
 * `/api/analytics` endpoint, future reports/AI/automations) import from here.
 * The engine is pure + isomorphic — see engine.ts.
 */
export * from './types.js';
export { runAnalyticsQuery } from './engine.js';
export type { AnalyticsContext } from './context.js';
export { validateAnalyticsQuery, assertSerializable } from './validate.js';
export {
  analyticsRoleFor,
  canAggregateFieldType,
  flattenFields,
  fieldMapById,
  findFieldById,
  type FieldRole,
} from './fieldResolver.js';
export { resolveDateRange, previousWindow, bucketDate, valueRiyadhMs, toRiyadhParts } from './dateWindows.js';
export { viewConditionsToFilterGroup } from './savedViewAdapter.js';
export { toNumeric } from './numeric.js';
