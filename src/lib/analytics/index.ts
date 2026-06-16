/**
 * Public surface of the universal analytics engine. Consumers (dashboards, the
 * `/api/analytics` endpoint, future reports/AI/automations) import from here.
 * The engine is pure + isomorphic — see engine.ts.
 */
export * from './types';
export { runAnalyticsQuery } from './engine';
export type { AnalyticsContext } from './context';
export { validateAnalyticsQuery, assertSerializable } from './validate';
export {
  analyticsRoleFor,
  canAggregateFieldType,
  flattenFields,
  fieldMapById,
  findFieldById,
  type FieldRole,
} from './fieldResolver';
export { resolveDateRange, previousWindow, bucketDate, valueRiyadhMs, toRiyadhParts } from './dateWindows';
export { viewConditionsToFilterGroup } from './savedViewAdapter';
export { toNumeric } from './numeric';
