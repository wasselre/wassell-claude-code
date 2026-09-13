// ============================================================================
// ONE loader for everything the project matcher needs — shared by the content
// pipeline (runContentProcess → the Claude runner's candidate list) and the
// collection job (caption attribution at ingest). Until 2026-09-13 the two
// paths built their own indexes: the collection path excluded developer-name
// tokens, the content path did NOT, and the content path is the one that feeds
// the AI. That gap is how "عزوم" became evidence for عزوم النرجس on 156
// furniture posts.
//
// What it gives the matcher:
//   catalog        every all_projects record (id, names, developer) — LIVE, not
//                  the July snapshot
//   commonTokens   name words shared by ≥2 catalog projects (series/developer
//                  names) — never distinctive on their own
//   excludedTokens brand words of every tracked organization + its account
//                  handles, district / city names, generic real-estate words —
//                  never evidence on their own
//   brandPhrases   the organizations' full names
// and per publisher:
//   publisherProjects(orgId) — the org's project set = the relationship table
//                  ∪ every catalog project whose `developer` IS this org's
//                  developer record. The relationship table was seeded once on
//                  2026-07-22 and never synced, so projects created since
//                  (ستون الملقا, تل الربوة) were invisible to attribution and
//                  their posts fell onto a sibling. The developer-field union
//                  closes that; the DB trigger added the same day keeps the
//                  table itself in sync for the SQL side.
//
// Cached in-process for a few minutes: the worker narrows many posts per
// minute and the catalog changes rarely.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeCommonTokens, normalizeAr, type ProjectAlias } from '../pipeline.js';

export const ALL_PROJECTS_MODEL = '220c49b9-de57-492d-9eca-c0d9f54fd40f';
const CACHE_TTL_MS = 5 * 60_000;

export interface CatalogProject extends ProjectAlias {
  developerId: string | null;
}

export interface AttributionContext {
  catalog: CatalogProject[];
  commonTokens: Set<string>;
  excludedTokens: Set<string>;
  brandPhrases: string[];
  loadedAt: number;
}

let cached: AttributionContext | null = null;

function nameTokens(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const w of normalizeAr(raw).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
    if (w.length >= 3 && !/^\d+$/.test(w)) out.push(w);
  }
  return out;
}

/** Page through a table — PostgREST caps a single select at 1,000 rows, and
 *  silently truncating the district list would quietly un-exclude places. */
async function pageAll<T>(fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, label: string): Promise<T[]> {
  const out: T[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await fetchPage(from, from + size - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < size) break;
  }
  return out;
}

export async function loadCatalog(sb: SupabaseClient): Promise<CatalogProject[]> {
  const rows = await pageAll<{ id: string; data: Record<string, unknown> | null }>(
    (from, to) => sb.from('unified_records').select('id, data').eq('model_id', ALL_PROJECTS_MODEL).order('id').range(from, to),
    'load all_projects catalog',
  );
  return rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const dev = d.developer;
    return {
      projectId: r.id,
      nameAr: typeof d.project_name === 'string' ? d.project_name : null,
      nameEn: typeof d.project_name_en === 'string' ? d.project_name_en : null,
      tokens: [],
      developerId: typeof dev === 'string' && dev ? dev : Array.isArray(dev) && typeof dev[0] === 'string' ? (dev[0] as string) : null,
    };
  }).filter((p) => p.nameAr || p.nameEn);
}

export async function loadAttributionContext(sb: SupabaseClient, opts: { force?: boolean } = {}): Promise<AttributionContext> {
  if (!opts.force && cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached;

  const catalog = await loadCatalog(sb);
  const commonTokens = computeCommonTokens(catalog);

  const excludedTokens = new Set<string>();
  const brandPhrases: string[] = [];

  // every tracked organization's name + its account handles
  const { data: orgs, error: orgErr } = await sb.from('mkt_organizations').select('id, name_ar, name_en');
  if (orgErr) throw new Error(`load organizations: ${orgErr.message}`);
  for (const o of orgs ?? []) {
    for (const raw of [o.name_ar as string | null, o.name_en as string | null]) {
      if (!raw) continue;
      brandPhrases.push(raw);
      for (const t of nameTokens(raw)) excludedTokens.add(t);
    }
  }
  const { data: accounts, error: accErr } = await sb.from('mkt_social_accounts').select('handle, display_name');
  if (accErr) throw new Error(`load social accounts: ${accErr.message}`);
  for (const a of accounts ?? []) {
    for (const raw of [a.handle as string | null, a.display_name as string | null]) {
      // handles are "alajlan_riviera" — split on the separators a handle uses
      for (const t of nameTokens((raw ?? '').replace(/[._-]+/g, ' '))) excludedTokens.add(t);
    }
  }

  // district + city names — "جنوب الربوة" mentioned in passing is not ربوة الرمز
  const districts = await pageAll<{ name_ar: string | null; name_en: string | null; city_name_ar: string | null; city_name_en: string | null }>(
    (from, to) => sb.from('districts').select('name_ar, name_en, city_name_ar, city_name_en').order('id').range(from, to),
    'load districts',
  );
  for (const d of districts) {
    for (const raw of [d.name_ar, d.name_en, d.city_name_ar, d.city_name_en]) {
      for (const t of nameTokens(raw)) if (t !== 'حي') excludedTokens.add(t);
    }
  }

  cached = { catalog, commonTokens, excludedTokens, brandPhrases, loadedAt: Date.now() };
  return cached;
}

/** The publisher's project set — relationship table ∪ live developer-field
 *  match. Returns ids; index the catalog with `scopedIndex`. */
export async function publisherProjects(sb: SupabaseClient, ctx: AttributionContext, orgId: string | null): Promise<string[]> {
  if (!orgId) return [];
  const ids = new Set<string>();
  const { data: rel, error: relErr } = await sb.from('mkt_project_organizations').select('project_id, is_active').eq('organization_id', orgId);
  if (relErr) throw new Error(`load project relationships: ${relErr.message}`);
  for (const r of rel ?? []) if (r.is_active !== false) ids.add(r.project_id as string);
  const { data: org, error: orgErr } = await sb.from('mkt_organizations').select('developer_record_id').eq('id', orgId).maybeSingle();
  if (orgErr) throw new Error(`load organization: ${orgErr.message}`);
  const dev = (org?.developer_record_id as string | null) ?? null;
  if (dev) for (const p of ctx.catalog) if (p.developerId === dev) ids.add(p.projectId);
  return [...ids];
}

export function scopedIndex(ctx: AttributionContext, projectIds: string[]): CatalogProject[] {
  const want = new Set(projectIds);
  return ctx.catalog.filter((p) => want.has(p.projectId));
}

/** Test hook. */
export function resetAttributionContextCache(): void { cached = null; }
