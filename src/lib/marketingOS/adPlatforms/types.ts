/**
 * Ad platform settings schemas — shared shapes.
 *
 * Each supported paid platform (Meta, Snapchat, TikTok) ships a schema file
 * that describes, AS DATA, the fields its Ads Manager asks for when creating
 * a campaign + ad set: real API field names, real enum values, bilingual
 * labels, and the dependency rules between fields. One generic renderer
 * (`PlatformSettingsForm`) draws every platform's form from this — adding a
 * platform later (Google Ads…) is one new schema file, zero new UI.
 *
 * Values are persisted as-is into `mos_campaign_executions.platform_settings`
 * (jsonb). Keys are the REAL Marketing API field names so a saved execution
 * can later be pushed through the actual platform API without remapping.
 *
 * Money fields: entered and stored in the ad account currency (SAR for us) as
 * plain numbers. The platforms want minor units (Meta) or micros (Snapchat)
 * — that conversion belongs to the future push layer, not to the humans
 * typing budgets.
 *
 * Reference for every field + enum: docs/reference/ad-platforms/*.md
 * (researched 2026-08-09 from the official Marketing API docs).
 */

export interface PlatformFieldOption {
  /** The platform API's literal enum value. */
  value: string;
  ar: string;
  en: string;
  /** Needs a platform-rep allowlist before the API accepts it. */
  allowlist?: boolean;
}

export type PlatformFieldControl =
  | 'select'       // one enum value
  | 'multiselect'  // several enum values (string[])
  | 'tags'         // free-entry list (string[]) — ids/names the platform resolves
  | 'number'       // plain number
  | 'money'        // number in account currency (SAR)
  | 'text'         // one line
  | 'textarea'     // several lines
  | 'date'         // ISO date string
  | 'toggle';      // boolean

export interface PlatformFieldDef {
  /** Real API field name — this is the jsonb key. */
  key: string;
  control: PlatformFieldControl;
  ar: string;
  en: string;
  options?: PlatformFieldOption[];
  hint_ar?: string;
  hint_en?: string;
  placeholder?: string;
  /** Render LTR (ids, URLs, phone numbers). */
  ltr?: boolean;
  /** Show only when another field currently holds one of these values. */
  visibleWhen?: { key: string; anyOf: string[] };
  /** The platform refuses to change this after creation. */
  immutable?: boolean;
  min?: number;
  max?: number;
}

export interface PlatformSection {
  key: string;
  ar: string;
  en: string;
  fields: PlatformFieldDef[];
}

export interface PlatformSchema {
  /** Canonical platform key ('meta' also serves 'instagram'). */
  platform: 'meta' | 'snapchat' | 'tiktok';
  /** Campaign + ad-set level settings, in render order. */
  sections: PlatformSection[];
  /**
   * Optimization goals valid per objective. When present, the goal select
   * only offers `goalsByObjective[settings.objective]` — the matrix the
   * platform's own Ads Manager enforces.
   */
  goalsByObjective?: Record<string, string[]>;
  /**
   * Deterministic auto-fill: choosing a goal fixes the billing event
   * (TikTok's §2.7 table). The billing field renders read-only when its
   * value is dictated here.
   */
  billingByGoal?: Record<string, string>;
  /** Ad-level creative fields (rendered inside the ad editor). */
  adSections: PlatformSection[];
}

/** What actually lands in the jsonb column. */
export type PlatformSettingValue = string | string[] | number | boolean | null;
export type PlatformSettings = Record<string, PlatformSettingValue>;

/** A field is visible iff its `visibleWhen` (if any) matches the draft. */
export const fieldVisible = (f: PlatformFieldDef, s: PlatformSettings): boolean => {
  if (!f.visibleWhen) return true;
  const v = s[f.visibleWhen.key];
  return typeof v === 'string' && f.visibleWhen.anyOf.includes(v);
};

/**
 * Options for a field, narrowed by the schema's dependency matrices
 * (today: the optimization-goal-by-objective filter).
 */
export const fieldOptions = (
  schema: PlatformSchema,
  f: PlatformFieldDef,
  s: PlatformSettings,
): PlatformFieldOption[] => {
  const all = f.options ?? [];
  if (f.key === 'optimization_goal' && schema.goalsByObjective) {
    const objective = s.objective ?? s.objective_type ?? s.objective_v2_type;
    if (typeof objective === 'string' && schema.goalsByObjective[objective]) {
      const allowed = new Set(schema.goalsByObjective[objective]);
      return all.filter((o) => allowed.has(o.value));
    }
  }
  return all;
};

/**
 * Auto-fill patch after a field change (billing event follows the goal on
 * TikTok). Returns only the keys that must change.
 */
export const autoFillAfterChange = (
  schema: PlatformSchema,
  changedKey: string,
  draft: PlatformSettings,
): PlatformSettings => {
  const patch: PlatformSettings = {};
  if (changedKey === 'optimization_goal' && schema.billingByGoal) {
    const goal = draft.optimization_goal;
    if (typeof goal === 'string' && schema.billingByGoal[goal]) {
      patch.billing_event = schema.billingByGoal[goal];
    }
  }
  // A changed objective can strand a goal the matrix no longer allows.
  if ((changedKey === 'objective' || changedKey === 'objective_type' || changedKey === 'objective_v2_type')
      && schema.goalsByObjective) {
    const objective = draft[changedKey];
    const goal = draft.optimization_goal;
    if (typeof objective === 'string' && typeof goal === 'string') {
      const allowed = schema.goalsByObjective[objective];
      if (allowed && !allowed.includes(goal)) patch.optimization_goal = null;
    }
  }
  return patch;
};
