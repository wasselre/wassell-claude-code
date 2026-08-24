/**
 * Shared: build the DETERMINISTIC project WhatsApp sheet for one all_projects
 * record, from live data, reusing the app's canonical composer verbatim
 * (available-only prices, exact house labels).
 *
 * Extracted from api/templates/project-message.ts so BOTH that endpoint AND the
 * in-process basic responder (api/whatsapp/basic-reply.ts) can call it without
 * an internal HTTP hop.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveLocalizedName, type LocalizedName } from '../../src/lib/geo/localizedName.js';
import {
  composeProjectMessage,
  type ProjectMessageFacts,
  type NumericRange,
} from '../../src/lib/projectMessage/compose.js';

export type SheetResult =
  | { ok: true; project_id: string; body_ar: string; body_en: string; facts: Record<string, unknown>; missing: string[] }
  | { ok: false; reason: 'not_found' | 'ambiguous' | 'error'; message?: string; matches?: { id: string; name: string | null }[] };

const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const asFiniteNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) { const n = Number(v.trim()); return Number.isFinite(n) ? n : null; }
  return null;
};
const oneId = (v: unknown): string | null =>
  Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : null) : (typeof v === 'string' && v ? v : null);

interface SchemaField { name: string; is_rollup?: boolean; rollup_kind?: string; options?: Array<{ id?: string; value?: string; label_ar?: string; label_en?: string }> }
interface ModelSchema { sections?: Array<{ fields?: SchemaField[] }> }
const fieldsOf = (schema: ModelSchema | null): SchemaField[] => (schema?.sections ?? []).flatMap((s) => s.fields ?? []);
const slugByRollupKind = (schema: ModelSchema | null, kind: string): string | null =>
  fieldsOf(schema).find((f) => f.is_rollup && f.rollup_kind === kind)?.name ?? null;
function slugByCandidates(schema: ModelSchema | null, cands: string[]): string | null {
  const fs = fieldsOf(schema);
  for (const c of cands) if (fs.some((f) => f.name === c)) return c;
  return null;
}
function formatPrice(n: number): { ar: string; en: string } {
  const g = Math.round(n).toLocaleString('en-US');
  return { ar: `${g} ر.س`, en: `SAR ${g}` };
}
const asRangeObj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
function toNumericRange(v: unknown): NumericRange | null {
  const r = asRangeObj(v);
  if (!r) return null;
  const mn = asFiniteNumber(r.min);
  const mx = asFiniteNumber(r.max);
  return mn != null && mx != null ? { min: mn, max: mx } : null;
}

/**
 * `readClient` reads the model + project (RLS for a JWT caller, service role for
 * the shared-secret / in-process caller); `svc` is always service role (geo is
 * reference data). Provide project_id OR project_name.
 */
export async function resolveProjectSheet(
  readClient: SupabaseClient,
  svc: SupabaseClient,
  input: { projectId?: string; projectName?: string },
): Promise<SheetResult> {
  const { data: apModel, error: apModelErr } = await readClient
    .from('models').select('id, schema').eq('name', 'all_projects').single();
  if (apModelErr || !apModel) return { ok: false, reason: 'error', message: `all_projects model not found: ${apModelErr?.message ?? ''}` };
  const modelId = apModel.id as string;
  const schema = (apModel.schema ?? null) as ModelSchema | null;

  let projectId = input.projectId ?? null;
  if (!projectId) {
    const name = input.projectName ?? '';
    const { data: matches, error: mErr } = await readClient
      .from('unified_records').select('id, data').eq('model_id', modelId)
      .ilike('data->>project_name', `%${name}%`).limit(10);
    if (mErr) return { ok: false, reason: 'error', message: `name lookup failed: ${mErr.message}` };
    const rows = (matches ?? []) as Array<{ id: string; data: Record<string, unknown> }>;
    const [first] = rows;
    if (!first) return { ok: false, reason: 'not_found' };
    if (rows.length > 1) {
      const exact = rows.filter((r) => asString(r.data?.project_name)?.toLowerCase() === name.toLowerCase());
      if (exact.length === 1 && exact[0]) projectId = exact[0].id;
      else return { ok: false, reason: 'ambiguous', matches: rows.map((r) => ({ id: r.id, name: asString(r.data?.project_name) })) };
    } else {
      projectId = first.id;
    }
  }

  const { data: projRow, error: projErr } = await readClient
    .from('unified_records').select('data').eq('id', projectId as string).eq('model_id', modelId).single();
  if (projErr || !projRow) return { ok: false, reason: 'not_found', message: projErr?.message };
  const pd = (projRow.data ?? {}) as Record<string, unknown>;

  const resolveGeoLocalized = async (id: string | null): Promise<LocalizedName | null> => {
    if (!id) return null;
    const { data } = await svc.from('unified_records').select('data').eq('id', id).maybeSingle();
    const gd = (data as { data?: Record<string, unknown> } | null)?.data ?? null;
    return resolveLocalizedName(id, gd);
  };
  const loc = pd.location && typeof pd.location === 'object' && !Array.isArray(pd.location)
    ? (pd.location as Record<string, unknown>) : {};
  const cityGeo = await resolveGeoLocalized(oneId(loc.city));
  const districtGeo = await resolveGeoLocalized(oneId(loc.district));

  const availPriceSlug = slugByRollupKind(schema, 'available_price_range');
  const availAreaSlug = slugByRollupKind(schema, 'available_area_range');
  const bedSlug = slugByRollupKind(schema, 'bedroom_range');
  const bathSlug = slugByRollupKind(schema, 'bathroom_range');
  const utSlug = slugByCandidates(schema, ['unit_types', 'unit_type']);

  const priceRange = availPriceSlug ? toNumericRange(pd[availPriceSlug]) : null;
  const minPriceNum = priceRange ? priceRange.min : null;

  const utField = utSlug ? fieldsOf(schema).find((f) => f.name === utSlug) : undefined;
  const utRaw = utSlug ? pd[utSlug] : null;
  const utVals = Array.isArray(utRaw) ? utRaw : utRaw != null && utRaw !== '' ? [utRaw] : [];
  const unitTypes = utVals.map((v) => {
    const opt = (utField?.options ?? []).find((o) => o.value === v || o.id === v);
    return opt
      ? { ar: opt.label_ar || opt.label_en || String(v), en: opt.label_en || opt.label_ar || String(v) }
      : { ar: String(v), en: String(v) };
  });

  const facts: ProjectMessageFacts = {
    ourProjectId: projectId as string,
    allProjectId: projectId as string,
    name: asString(pd.project_name),
    city: cityGeo ? { ar: cityGeo.ar, en: cityGeo.enDisplay } : null,
    district: districtGeo ? { ar: districtGeo.ar, en: districtGeo.enDisplay } : null,
    unitTypes,
    bedrooms: bedSlug ? toNumericRange(pd[bedSlug]) : null,
    bathrooms: bathSlug ? toNumericRange(pd[bathSlug]) : null,
    areaRange: availAreaSlug ? toNumericRange(pd[availAreaSlug]) : null,
    minPrice: minPriceNum != null ? formatPrice(minPriceNum) : null,
    brochureLink: null,
    locationLink: null,
    websiteUnitsLink: `https://wassel.re/project?id=${encodeURIComponent(projectId as string)}#units`,
    imageFileIds: [],
    missing: [],
  };

  const { body_ar, body_en } = composeProjectMessage(facts);

  const missing: string[] = [];
  if (!facts.name) missing.push('name');
  if (!facts.city) missing.push('city');
  if (!facts.district) missing.push('district');
  if (facts.unitTypes.length === 0) missing.push('unit_types');
  if (!facts.bedrooms) missing.push('bedrooms');
  if (!facts.areaRange) missing.push('area');
  if (!facts.bathrooms) missing.push('bathrooms');
  if (!facts.minPrice) missing.push('min_price');

  return { ok: true, project_id: projectId as string, body_ar, body_en, facts: facts as unknown as Record<string, unknown>, missing };
}
