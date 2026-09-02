/**
 * Creative settings actions — everything under mos_settings the creative
 * director reads or an admin edits: feature flags, brand kit (get/save/review),
 * writer rules, role map, AI roles.
 *
 * Brand kit rules (contracts §0 rule 12): a plain save NEVER promotes — status/
 * mode/reviewed_* are preserved from the existing row; only brand_kit_review
 * (approve_creative gate) sets status='reviewed', mode='constraint', version+1.
 * AI roles are DATA: save validates the {provider, model, params?} shape per key
 * and MERGES — keys are never dropped (rule 2: no vendor lock-in in code).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { jsonOk, jsonError } from '../../auth.js';
import { loadBrandKit } from './brandKit.js';
import type { BrandKit, CreativeFlags, RoleMap, WriterRules } from '../../../../src/lib/creative/contracts.js';
import { cStr, jsonFail, requireSvc, resolveAppUserId, type CreativeCtx } from './wake.js';
import { readCreativeFlags } from './packages.js';

const DEFAULT_ROLE_MAP: RoleMap = { design_owner: 'montage', design_reviewer: 'marketing_manager' };
const DEFAULT_WRITER_RULES: WriterRules = { shared: [], post: [], decisions_log: [] };

/* ------------------------------------------------------------------ */
/* mos_settings helpers                                               */
/* ------------------------------------------------------------------ */

async function readSetting(sb: SupabaseClient, key: string): Promise<Record<string, unknown>> {
  const { data, error } = await sb.from('mos_settings').select('value').eq('key', key).maybeSingle();
  if (error) {
    console.error(`[creative] mos_settings.${key} read failed`, error.code, error.message);
    return {};
  }
  const v = (data as { value?: unknown } | null)?.value;
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

async function writeSetting(
  svc: SupabaseClient,
  key: string,
  value: Record<string, unknown>,
  userId: string | null,
): Promise<Response | null> {
  const { error } = await svc.from('mos_settings').upsert({
    key, value, updated_by_user_id: userId, updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error(`[creative] mos_settings.${key} write failed`, error.code, error.message);
    return jsonError(500, error.message);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* creative_flags / creative_flags_save                               */
/* ------------------------------------------------------------------ */

export async function creativeFlags(ctx: CreativeCtx): Promise<Response> {
  const [flags, roleMapRaw, kit] = await Promise.all([
    readCreativeFlags(ctx.sb),
    readSetting(ctx.sb, 'role_map'),
    loadBrandKit(ctx.sb),
  ]);
  const role_map: RoleMap = {
    design_owner: typeof roleMapRaw.design_owner === 'string' && roleMapRaw.design_owner
      ? roleMapRaw.design_owner : DEFAULT_ROLE_MAP.design_owner,
    design_reviewer: typeof roleMapRaw.design_reviewer === 'string' && roleMapRaw.design_reviewer
      ? roleMapRaw.design_reviewer : DEFAULT_ROLE_MAP.design_reviewer,
  };
  return jsonOk({
    flags,
    role_map,
    brand_kit_status: kit ? { status: kit.status, mode: kit.mode, version: kit.version } : null,
  });
}

export async function creativeFlagsSave(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const raw = (typeof ctx.body.flags === 'object' && ctx.body.flags !== null
    ? ctx.body.flags : {}) as Record<string, unknown>;
  const keys: Array<keyof CreativeFlags> = [
    'post_enabled', 'ai_image_execution', 'design_reads_enabled', 'asset_enrich_v2', 'backfill_enabled',
  ];
  for (const k of keys) {
    if (k in raw && typeof raw[k] !== 'boolean') {
      return jsonError(400, `flags.${k} must be a boolean`);
    }
  }
  // Merge over the current row — a partial save never resets the other flags.
  const current = await readSetting(ctx.sb, 'creative_writer');
  const next: Record<string, unknown> = { ...current };
  for (const k of keys) if (k in raw) next[k] = raw[k];
  const appUserId = await resolveAppUserId(ctx.sb, ctx.userId);
  const fail = await writeSetting(svc, 'creative_writer', next, appUserId);
  if (fail) return fail;
  return jsonOk({ flags: await readCreativeFlags(ctx.sb) });
}

/* ------------------------------------------------------------------ */
/* brand kit                                                          */
/* ------------------------------------------------------------------ */

export async function brandKitGet(ctx: CreativeCtx): Promise<Response> {
  const kit = await loadBrandKit(ctx.sb);
  return jsonOk({ kit });
}

export async function brandKitSave(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const raw = ctx.body.kit;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return jsonError(400, 'kit must be an object');
  }
  const kit = raw as Record<string, unknown>;
  if (!Array.isArray(kit.palette) || kit.palette.length === 0) {
    return jsonFail(400, 'The brand kit needs a non-empty palette.', 'هوية العلامة تحتاج لوحة ألوان غير فارغة.');
  }

  // A plain save NEVER promotes: status/mode/review metadata come from the
  // existing row (or the drafted defaults for a first save); the version only
  // moves on review.
  const existing = await loadBrandKit(ctx.sb);
  const next = {
    ...kit,
    version: existing?.version ?? 1,
    status: existing?.status ?? 'draft',
    mode: existing?.mode ?? 'advisory',
    reviewed_by: existing?.reviewed_by ?? null,
    reviewed_at: existing?.reviewed_at ?? null,
  } as unknown as BrandKit;
  const appUserId = await resolveAppUserId(ctx.sb, ctx.userId);
  const fail = await writeSetting(svc, 'brand_kit', next as unknown as Record<string, unknown>, appUserId);
  if (fail) return fail;
  return jsonOk({ kit: next });
}

export async function brandKitReview(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const existing = await loadBrandKit(ctx.sb);
  if (!existing) {
    return jsonFail(404,
      'No brand kit exists to review — save one first.',
      'لا توجد هوية علامة لمراجعتها — احفظها أولًا.');
  }
  const appUserId = await resolveAppUserId(ctx.sb, ctx.userId);
  const next: BrandKit = {
    ...existing,
    status: 'reviewed',
    mode: 'constraint',
    version: existing.version + 1,
    reviewed_by: appUserId,
    reviewed_at: new Date().toISOString(),
  };
  const fail = await writeSetting(svc, 'brand_kit', next as unknown as Record<string, unknown>, appUserId);
  if (fail) return fail;
  return jsonOk({ kit: next });
}

/* ------------------------------------------------------------------ */
/* writer rules                                                       */
/* ------------------------------------------------------------------ */

export async function writerRulesGet(ctx: CreativeCtx): Promise<Response> {
  const raw = await readSetting(ctx.sb, 'writer_rules');
  const rules: WriterRules = {
    shared: Array.isArray(raw.shared) ? (raw.shared as string[]) : [],
    post: Array.isArray(raw.post) ? (raw.post as string[]) : [],
    ...(Array.isArray(raw.video) ? { video: raw.video as string[] } : {}),
    decisions_log: Array.isArray(raw.decisions_log)
      ? (raw.decisions_log as WriterRules['decisions_log']) : [],
  };
  return jsonOk({ rules });
}

export async function writerRulesSave(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const raw = (typeof ctx.body.rules === 'object' && ctx.body.rules !== null
    ? ctx.body.rules : null) as Record<string, unknown> | null;
  if (!raw) return jsonError(400, 'rules must be an object');
  const listOk = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (!listOk(raw.shared) || !listOk(raw.post)) {
    return jsonError(400, 'rules.shared and rules.post must be string arrays');
  }
  if (raw.video !== undefined && !listOk(raw.video)) return jsonError(400, 'rules.video must be a string array');
  if (!Array.isArray(raw.decisions_log)) return jsonError(400, 'rules.decisions_log must be an array');
  const appUserId = await resolveAppUserId(ctx.sb, ctx.userId);
  const fail = await writeSetting(svc, 'writer_rules', raw, appUserId);
  if (fail) return fail;
  return writerRulesGet(ctx);
}

/* ------------------------------------------------------------------ */
/* role map                                                           */
/* ------------------------------------------------------------------ */

export async function roleMapGet(ctx: CreativeCtx): Promise<Response> {
  const raw = await readSetting(ctx.sb, 'role_map');
  const role_map: RoleMap = {
    design_owner: typeof raw.design_owner === 'string' && raw.design_owner
      ? raw.design_owner : DEFAULT_ROLE_MAP.design_owner,
    design_reviewer: typeof raw.design_reviewer === 'string' && raw.design_reviewer
      ? raw.design_reviewer : DEFAULT_ROLE_MAP.design_reviewer,
  };
  return jsonOk({ role_map });
}

export async function roleMapSave(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const raw = (typeof ctx.body.role_map === 'object' && ctx.body.role_map !== null
    ? ctx.body.role_map : {}) as Record<string, unknown>;
  const designOwner = cStr(raw.design_owner);
  const designReviewer = cStr(raw.design_reviewer);
  if (!designOwner || !designReviewer) {
    return jsonError(400, 'role_map.design_owner and role_map.design_reviewer are required');
  }
  const current = await readSetting(ctx.sb, 'role_map');
  const appUserId = await resolveAppUserId(ctx.sb, ctx.userId);
  const fail = await writeSetting(svc, 'role_map', {
    ...current, design_owner: designOwner, design_reviewer: designReviewer,
  }, appUserId);
  if (fail) return fail;
  return jsonOk({ role_map: { design_owner: designOwner, design_reviewer: designReviewer } });
}

/* ------------------------------------------------------------------ */
/* ai roles                                                           */
/* ------------------------------------------------------------------ */

/** {provider, model, version?, params?} per key — anything else is refused. */
function roleConfigProblem(key: string, raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `${key}: role must be an object`;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== 'string' || !r.provider) return `${key}: provider must be a non-empty string`;
  if (typeof r.model !== 'string' || !r.model) return `${key}: model must be a non-empty string`;
  if (r.params !== undefined && (typeof r.params !== 'object' || r.params === null || Array.isArray(r.params))) {
    return `${key}: params must be an object`;
  }
  return null;
}

export async function aiRolesGet(ctx: CreativeCtx): Promise<Response> {
  const roles = await readSetting(ctx.sb, 'ai_roles');
  return jsonOk({ roles });
}

export async function aiRolesSave(ctx: CreativeCtx): Promise<Response> {
  const svc = requireSvc(ctx);
  if (svc instanceof Response) return svc;
  const raw = (typeof ctx.body.roles === 'object' && ctx.body.roles !== null && !Array.isArray(ctx.body.roles)
    ? ctx.body.roles : null) as Record<string, unknown> | null;
  if (!raw) return jsonError(400, 'roles must be an object');
  for (const [k, v] of Object.entries(raw)) {
    const problem = roleConfigProblem(k, v);
    if (problem) return jsonError(400, problem);
  }
  // MERGE over the existing row — saving roles never drops keys (rule 2).
  const current = await readSetting(ctx.sb, 'ai_roles');
  const next = { ...current, ...raw };
  const appUserId = await resolveAppUserId(ctx.sb, ctx.userId);
  const fail = await writeSetting(svc, 'ai_roles', next, appUserId);
  if (fail) return fail;
  return jsonOk({ roles: next });
}

/* ------------------------------------------------------------------ */
/* defaults export (the SPA renders the same fallbacks)               */
/* ------------------------------------------------------------------ */

export const CREATIVE_SETTINGS_DEFAULTS = {
  role_map: DEFAULT_ROLE_MAP,
  writer_rules: DEFAULT_WRITER_RULES,
} as const;
