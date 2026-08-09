/**
 * Ad platform schema registry.
 *
 * `getPlatformSchema(platform)` is the single entry point: it returns the
 * structured settings schema for platforms we model (meta, instagram → the
 * Meta schema, snapchat, tiktok) and null for the rest (google, x,
 * youtube…), which keep the legacy free-text targeting brief.
 */
import { metaSchema } from './meta';
import { snapchatSchema } from './snapchat';
import { tiktokSchema } from './tiktok';
import {
  PlatformFieldDef, PlatformSchema, PlatformSettings, fieldVisible,
} from './types';

export * from './types';
export { metaSchema, snapchatSchema, tiktokSchema };

export const getPlatformSchema = (platform: string): PlatformSchema | null => {
  switch (platform) {
    case 'meta':
    case 'instagram':
      return metaSchema;
    case 'snapchat':
      return snapchatSchema;
    case 'tiktok':
      return tiktokSchema;
    default:
      return null;
  }
};

/**
 * Seed values for a fresh execution. The `instagram` platform is the Meta
 * schema with placements pinned to Instagram — that's what an "Instagram
 * campaign" IS on the real API.
 */
export const defaultPlatformSettings = (platform: string): PlatformSettings => {
  switch (platform) {
    case 'instagram':
      return {
        placement_mode: 'MANUAL',
        publisher_platforms: ['instagram'],
        instagram_positions: ['stream', 'story', 'reels', 'explore'],
      };
    case 'meta':
      return { placement_mode: 'AUTOMATIC' };
    case 'snapchat':
      return { placement_config: 'AUTOMATIC', billing_event: 'IMPRESSION' };
    case 'tiktok':
      return { placement_type: 'PLACEMENT_TYPE_AUTOMATIC', pacing: 'PACING_MODE_SMOOTH' };
    default:
      return {};
  }
};

/** The field whose value is the platform-campaign objective. */
export const objectiveKeyOf = (schema: PlatformSchema): string =>
  schema.platform === 'meta' ? 'objective'
    : schema.platform === 'snapchat' ? 'objective_v2_type'
      : 'objective_type';

const optionLabel = (
  schema: PlatformSchema,
  fieldKey: string,
  value: string,
  isAr: boolean,
): string | null => {
  for (const sec of schema.sections) {
    for (const f of sec.fields) {
      if (f.key !== fieldKey) continue;
      const o = f.options?.find((x) => x.value === value);
      return o ? (isAr ? o.ar : o.en) : value;
    }
  }
  return value;
};

/**
 * A one-line human summary of an execution's platform settings — for header
 * chips and campaign cards. Objective · goal · budget · first geo.
 */
export const settingsSummary = (
  platform: string,
  settings: PlatformSettings | null | undefined,
  isAr: boolean,
): string[] => {
  const schema = getPlatformSchema(platform);
  if (!schema || !settings) return [];
  const parts: string[] = [];

  const objective = settings[objectiveKeyOf(schema)];
  if (typeof objective === 'string' && objective) {
    parts.push(optionLabel(schema, objectiveKeyOf(schema), objective, isAr) ?? objective);
  }
  const goal = settings.optimization_goal;
  if (typeof goal === 'string' && goal) {
    parts.push(optionLabel(schema, 'optimization_goal', goal, isAr) ?? goal);
  }

  const budgetKeys = ['daily_budget', 'lifetime_budget', 'daily_budget_micro', 'lifetime_budget_micro', 'budget'];
  for (const k of budgetKeys) {
    const v = settings[k];
    if (typeof v === 'number' && v > 0) {
      const daily = k.startsWith('daily') || settings.budget_mode === 'BUDGET_MODE_DAY';
      parts.push(isAr
        ? `${v.toLocaleString('ar-SA')} ريال${daily ? '/يوم' : ''}`
        : `${v.toLocaleString('en-US')} SAR${daily ? '/day' : ''}`);
      break;
    }
  }

  const geoKeys = ['countries', 'country_code', 'location_ids', 'cities'];
  for (const k of geoKeys) {
    const v = settings[k];
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
      parts.push(v.slice(0, 2).join('، '));
      break;
    }
  }
  return parts;
};

/**
 * How many of a schema's (currently visible) fields carry a value — the
 * "12 of 31 set" progress note on the settings form.
 */
export const settingsProgress = (
  schema: PlatformSchema,
  settings: PlatformSettings,
): { set: number; total: number } => {
  let set = 0;
  let total = 0;
  const has = (f: PlatformFieldDef): boolean => {
    const v = settings[f.key];
    if (v === null || v === undefined || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'boolean') return v;
    return true;
  };
  for (const sec of schema.sections) {
    for (const f of sec.fields) {
      if (!fieldVisible(f, settings)) continue;
      total += 1;
      if (has(f)) set += 1;
    }
  }
  return { set, total };
};
