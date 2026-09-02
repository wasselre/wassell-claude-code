/**
 * Brief — what the writer is asked to do. Built ONCE in SQL (`mos_script_brief`)
 * so the API and the worker read the same thing; this module applies the
 * operator's overrides and derives the fields the SQL does not know about
 * (duration, scene-count hint, funnel, platform defaults).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Brief, BriefCampaign, BriefOverrides, ExistingScene, FactsPackage, Funnel, Purpose, RecipeRow } from './types.js';

export const DEFAULT_PLATFORMS = ['instagram', 'tiktok', 'snapchat'];
export const SECONDS_PER_SCENE = 7; // ≈6–8 s per scene
export const DEFAULT_RECIPE = 'walkthrough';
const MIN_DURATION = 15;
const MAX_DURATION = 180;

/** Raw jsonb returned by `mos_script_brief(p_content_id)` (migration 2026-09-02_12). */
export interface RawBrief {
  content_id: string;
  title: string | null;
  content_type_key: string | null;
  project_id: string | null;
  project_ids: unknown;
  project_name: string | null;
  multi_project_warning: boolean | null;
  campaign: (BriefCampaign & { audience_name?: string | null; audience_details?: string | null }) | null;
  purpose: string | null;
  platforms: unknown;
  objective: string | null;
  audience: string | null;
  language: string | null;
  cta: string | null;
  angle: string | null;
  core_message: string | null;
  idea: string | null;
  hook: string | null;
  existing_scenes: unknown;
  assets_summary: { count?: number; kinds?: Record<string, number> } | null;
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
}

export function sceneCountForDuration(durationSec: number): number {
  return Math.max(3, Math.min(10, Math.round(durationSec / SECONDS_PER_SCENE)));
}

const TOP = /awareness|reach|brand|launch|إطلاق|وعي|انتشار|تعريف/i;
const BOTTOM = /sales|conversion|lead|booking|حجز|مبيعات|بيع|تحويل|عملاء محتمل/i;
const MID = /traffic|consideration|engagement|زيارات|تفاعل|اهتمام/i;

/** Funnel stage from the campaign objective first, then the recipe. */
export function deriveFunnel(objective: string | null, recipe: string): Funnel {
  const o = objective ?? '';
  if (o) {
    if (BOTTOM.test(o)) return 'bottom';
    if (TOP.test(o)) return 'top';
    if (MID.test(o)) return 'mid';
  }
  switch (recipe) {
    case 'offer': return 'bottom';
    case 'launch': case 'product_explainer': return 'top';
    default: return 'mid';
  }
}

function normPurpose(p: string | null): Purpose {
  if (p === 'organic' || p === 'paid' || p === 'both') return p;
  if (p === 'ad' || p === 'ads' || p === 'paid_ad') return 'paid';
  return 'unknown';
}

/** Pure: raw SQL brief + recipe row + operator overrides → Brief. */
export function buildBrief(raw: RawBrief, recipe: RecipeRow, overrides: BriefOverrides, ctaDefault: string): Brief {
  if (!raw.project_id) throw new Error('facts_insufficient: no project linked to this content item');
  const warnings: string[] = [];
  const duration = overrides.duration_sec && Number.isFinite(overrides.duration_sec)
    ? Math.max(MIN_DURATION, Math.min(MAX_DURATION, Math.round(overrides.duration_sec)))
    : recipe.default_duration_sec;
  if (overrides.duration_sec && duration !== overrides.duration_sec) warnings.push(`duration clamped to ${duration}s`);
  const sceneHint = overrides.duration_sec ? sceneCountForDuration(duration) : (recipe.scene_count_hint || sceneCountForDuration(duration));
  const platforms = strArr(raw.platforms);
  if (platforms.length === 0) warnings.push('no platforms on the content/campaign — defaulting to instagram/tiktok/snapchat');
  const campaign = raw.campaign && raw.campaign.id ? {
    id: raw.campaign.id, name: raw.campaign.name ?? null, objective: raw.campaign.objective ?? null, kind: raw.campaign.kind ?? null,
    offer: raw.campaign.offer ?? null, audience_text: raw.campaign.audience_text ?? raw.campaign.audience_details ?? null, audience_id: raw.campaign.audience_id ?? null,
  } : undefined;
  const audience = (overrides.audience && overrides.audience.trim()) || raw.audience || campaign?.audience_text || null;
  const existing: ExistingScene[] = (Array.isArray(raw.existing_scenes) ? raw.existing_scenes : [])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      position: Number(s.position ?? 0), visual: (s.visual as string | null) ?? null, voiceover: (s.voiceover as string | null) ?? null,
      on_screen_text: (s.on_screen_text as string | null) ?? null, footage_status: (s.footage_status as string | null) ?? null,
    }));
  if (raw.multi_project_warning) warnings.push('content item is linked to several projects — facts come from the primary project only');
  const lang: 'ar' | 'en' = raw.language === 'en' ? 'en' : 'ar';
  if (raw.language && raw.language !== 'ar' && raw.language !== 'en') warnings.push(`language '${raw.language}' not supported — writing Arabic`);

  const brief: Brief = {
    content_id: raw.content_id,
    project_id: raw.project_id,
    project_ids: strArr(raw.project_ids),
    multi_project_warning: Boolean(raw.multi_project_warning),
    purpose: normPurpose(raw.purpose),
    platforms: platforms.length ? Array.from(new Set(platforms)) : [...DEFAULT_PLATFORMS],
    objective: raw.objective ?? null,
    audience,
    language: lang,
    cta: raw.cta?.trim() || ctaDefault,
    recipe: recipe.key,
    duration_sec: duration,
    scene_count_hint: sceneHint,
    funnel: deriveFunnel(raw.objective ?? campaign?.objective ?? null, recipe.key),
    existing_scenes: existing,
    assets_summary: { count: Number(raw.assets_summary?.count ?? 0), kinds: raw.assets_summary?.kinds ?? {} },
    warnings,
  };
  if (campaign) brief.campaign = campaign;
  if (raw.core_message) brief.core_message = raw.core_message;
  if (raw.idea) brief.idea = raw.idea;
  if (raw.hook) brief.hook = raw.hook;
  if (overrides.objection && overrides.objection.trim()) brief.objection = overrides.objection.trim();
  if (raw.title) brief.title = raw.title;
  if (raw.angle) brief.angle = raw.angle;
  if (raw.project_name) brief.project_name = raw.project_name;
  return brief;
}

function parseRecipeRow(r: Record<string, unknown>): RecipeRow {
  return {
    key: String(r.key), label_ar: String(r.label_ar ?? ''), label_en: String(r.label_en ?? ''),
    structure: strArr(r.structure), guidance: String(r.guidance ?? ''),
    default_duration_sec: Number(r.default_duration_sec ?? 45), scene_count_hint: Number(r.scene_count_hint ?? 7),
    retrieval_content_types: strArr(r.retrieval_content_types), requires_facts: strArr(r.requires_facts),
    version: Number(r.version ?? 1), is_active: Boolean(r.is_active ?? true),
  };
}

export async function loadRecipes(sb: SupabaseClient): Promise<RecipeRow[]> {
  const { data, error } = await sb.from('mos_script_recipes').select('*').eq('is_active', true);
  if (error) throw new Error(`recipes read failed: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map(parseRecipeRow);
}

export interface LoadedBrief { brief: Brief; recipe: RecipeRow; raw: RawBrief }

/**
 * RPC mos_script_brief + recipe lookup + overrides. An unknown recipe falls
 * back to `walkthrough` with a warning (the API validates recipes upstream;
 * the worker must still finish a job whose recipe row was deactivated).
 */
export async function loadBrief(sb: SupabaseClient, contentId: string, overrides: BriefOverrides, ctaDefault: string): Promise<LoadedBrief> {
  const { data, error } = await sb.rpc('mos_script_brief', { p_content_id: contentId });
  if (error) throw new Error(`mos_script_brief failed: ${error.message}`);
  if (!data) throw new Error('content item not found');
  const raw = data as RawBrief;
  const recipes = await loadRecipes(sb);
  const wanted = (overrides.recipe ?? '').trim() || DEFAULT_RECIPE;
  let recipe = recipes.find((r) => r.key === wanted);
  const warnings: string[] = [];
  if (!recipe) {
    recipe = recipes.find((r) => r.key === DEFAULT_RECIPE);
    if (!recipe) throw new Error('no active recipes in mos_script_recipes');
    warnings.push(`recipe '${wanted}' not found/active — using '${recipe.key}'`);
  }
  const brief = buildBrief(raw, recipe, overrides, ctaDefault);
  brief.warnings.push(...warnings);
  return { brief, recipe, raw };
}

/**
 * Deterministic recipe suggestion (objective × purpose × readiness × has-offer).
 * Used only to SUGGEST; the operator's choice always wins.
 */
export function recommendRecipe(brief: Pick<Brief, 'objective' | 'purpose' | 'audience' | 'campaign' | 'core_message' | 'idea'>, facts: Pick<FactsPackage, 'readiness' | 'sold_out' | 'facts'>): string {
  const objective = `${brief.objective ?? ''} ${brief.campaign?.objective ?? ''} ${brief.core_message ?? ''} ${brief.idea ?? ''}`;
  const hasOffer = Boolean(brief.campaign?.offer && brief.campaign.offer.trim());
  const hasPrice = facts.facts.some((f) => f.class === 'price' && f.claimable);
  const audience = brief.audience ?? '';
  if (/مستأجر|مستاجر|إيجار|ايجار|\brent/i.test(`${audience} ${objective}`) && hasPrice) return 'rent_vs_own';
  if (/launch|إطلاق|اطلاق|تدشين|طرح/i.test(objective)) return 'launch';
  if (hasOffer && hasPrice && !facts.sold_out) return 'offer';
  if (BOTTOM.test(objective) && hasPrice) return hasOffer ? 'offer' : 'walkthrough';
  if (facts.readiness === 'off_plan' && (TOP.test(objective) || brief.purpose === 'paid')) return 'launch';
  if (TOP.test(objective)) return 'product_explainer';
  return 'walkthrough';
}
