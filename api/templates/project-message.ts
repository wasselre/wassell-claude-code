/**
 * POST /api/templates/project-message
 *
 * DETERMINISTIC WhatsApp marketing message for ONE of our own projects (an
 * `all_projects` record), built from the project's CURRENT data. No LLM: this
 * is the exact fixed-format sheet the reps already send — the sibling
 * `project-message-ai.ts` is the AI-rewrite variant of the same facts.
 *
 * It reuses the app's canonical composer VERBATIM
 * (`src/lib/projectMessageFacts.ts#composeProjectMessage`) so wording, labels,
 * the omit-missing behaviour, and the AVAILABLE-only price/area ranges (QA-003 —
 * a customer is never quoted a sold/reserved unit's price) stay identical to
 * what the browser produces. This endpoint only does the server-side data
 * loading the composer can't (it is a pure, store-shaped function).
 *
 * Built for the headless WhatsApp basic-reply agent (`wa-agent/tools/project.mjs`),
 * which has no user JWT — so it authenticates with the shared WHATSAPP_AI_SECRET
 * and reads via service role. A normal SPA caller (user JWT) is also accepted and
 * is RLS-gated, same as project-message-ai.
 *
 * Input:  { project_id?, project_name? }   (one required; name is resolved
 *          case-insensitively against all_projects.project_name)
 * Output: { ok, project_id, body_ar, body_en, facts, missing }
 *         { not_found } | { ambiguous, matches } | { error }
 *
 * Loud failures only (CLAUDE.md): 401 (auth), 400 (validation), 404 (project),
 * 409 (ambiguous name), 500 (env/query).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { getServiceClient } from '../_lib/files.js';
import { resolveLocalizedName, type LocalizedName } from '../../src/lib/geo/localizedName.js';
import {
  composeProjectMessage,
  type ProjectMessageFacts,
  type NumericRange,
} from '../../src/lib/projectMessage/compose.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

interface RequestBody {
  project_id?: string;
  project_name?: string;
}

// ── Node↔Web bridge (the nodejs runtime ignores a returned Web Response) ────
async function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function nodeToWebRequest(nodeReq: IncomingMessage): Promise<Request> {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = nodeReq.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readNodeBody(nodeReq);
  return new Request(url.toString(), { method, headers, body });
}
async function writeWebResponseToNode(webResp: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webResp.status;
  for (const [k, v] of webResp.headers) nodeRes.setHeader(k, v);
  nodeRes.end(Buffer.from(await webResp.arrayBuffer()));
}

/** Length-safe constant-time string compare (mirrors api/whatsapp/ai-send.ts). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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
function fieldsOf(schema: ModelSchema | null): SchemaField[] {
  return (schema?.sections ?? []).flatMap((s) => s.fields ?? []);
}
function slugByRollupKind(schema: ModelSchema | null, kind: string): string | null {
  return fieldsOf(schema).find((f) => f.is_rollup && f.rollup_kind === kind)?.name ?? null;
}
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
 * The core: load one project's data through `readClient` (RLS for a JWT caller,
 * service role for the shared-secret caller), resolve it into the composer's
 * `ProjectMessageFacts` shape, and compose the deterministic message.
 *
 * `svc` is always service role — geography is reference data resolved the same
 * way as project-message-ai regardless of who is calling.
 */
async function buildMessage(
  readClient: SupabaseClient,
  svc: SupabaseClient,
  input: { projectId?: string; projectName?: string },
): Promise<Response> {
  // all_projects model → schema (rollup slugs + unit_types options).
  const { data: apModel, error: apModelErr } = await readClient
    .from('models').select('id, schema').eq('name', 'all_projects').single();
  if (apModelErr || !apModel) return jsonError(500, `all_projects model not found: ${apModelErr?.message ?? ''}`);
  const modelId = apModel.id as string;
  const schema = (apModel.schema ?? null) as ModelSchema | null;

  // Resolve the target id: explicit id wins; otherwise resolve by name.
  let projectId = input.projectId ?? null;
  if (!projectId) {
    const name = input.projectName ?? '';
    const { data: matches, error: mErr } = await readClient
      .from('unified_records')
      .select('id, data')
      .eq('model_id', modelId)
      .ilike('data->>project_name', `%${name}%`)
      .limit(10);
    if (mErr) return jsonError(500, `name lookup failed: ${mErr.message}`);
    const rows = (matches ?? []) as Array<{ id: string; data: Record<string, unknown> }>;
    const [first] = rows;
    if (!first) return jsonOk({ not_found: true, project_name: name });
    if (rows.length > 1) {
      // Prefer an exact (case-insensitive) name match before giving up.
      const exact = rows.filter((r) => asString(r.data?.project_name)?.toLowerCase() === name.toLowerCase());
      if (exact.length === 1 && exact[0]) projectId = exact[0].id;
      else return jsonOk({ ambiguous: true, matches: rows.map((r) => ({ id: r.id, name: asString(r.data?.project_name) })) }, 409);
    } else {
      projectId = first.id;
    }
  }

  // Read the project's full data (frozen-safe via unified_records).
  const { data: projRow, error: projErr } = await readClient
    .from('unified_records')
    .select('data')
    .eq('id', projectId as string)
    .eq('model_id', modelId)
    .single();
  if (projErr || !projRow) return jsonError(404, `project not found: ${projErr?.message ?? projectId}`);
  const pd = (projRow.data ?? {}) as Record<string, unknown>;

  // Authoritative geography — resolve the location cascade ids to localized names.
  const resolveGeoLocalized = async (id: string | null): Promise<LocalizedName | null> => {
    if (!id) return null;
    const { data } = await svc.from('unified_records').select('data').eq('id', id).maybeSingle();
    const gd = (data as { data?: Record<string, unknown> } | null)?.data ?? null;
    const localized = resolveLocalizedName(id, gd);
    if (!localized && gd) {
      console.error(`[project-message] geography ${id} is not fully localized (missing name_en) — omitting rather than leaking Arabic into the English body`);
    }
    return localized;
  };
  const loc = pd.location && typeof pd.location === 'object' && !Array.isArray(pd.location)
    ? (pd.location as Record<string, unknown>) : {};
  const cityGeo = await resolveGeoLocalized(oneId(loc.city));
  const districtGeo = await resolveGeoLocalized(oneId(loc.district));

  // Available-only rollups (QA-003) + ranges + unit types, read from the record.
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

  // Assemble the composer's ProjectMessageFacts. The message uses the public
  // website link (not the brochure/location), so those are intentionally null;
  // imageFileIds is unused by the text composer. This endpoint takes the
  // all_projects id directly, so ourProjectId == allProjectId == projectId.
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

  return jsonOk({
    ok: true,
    project_id: projectId,
    body_ar,
    body_en,
    facts,
    missing,
  });
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const req = await nodeToWebRequest(nodeReq);

  if (req.method !== 'POST') {
    await writeWebResponseToNode(jsonError(405, 'Method not allowed'), nodeRes);
    return;
  }

  let body: RequestBody;
  try {
    body = (await req.clone().json()) as RequestBody;
  } catch {
    await writeWebResponseToNode(jsonError(400, 'invalid JSON body'), nodeRes);
    return;
  }
  const projectId = body.project_id?.trim() || undefined;
  const projectName = body.project_name?.trim() || undefined;
  if (!projectId && !projectName) {
    await writeWebResponseToNode(jsonError(400, 'project_id or project_name is required'), nodeRes);
    return;
  }

  const svc = getServiceClient();

  // Shared-secret path (the headless agent) — service-role reads, no user JWT.
  const aiSecret = process.env.WHATSAPP_AI_SECRET;
  const provided = req.headers.get('x-wassel-ai-secret') ?? '';
  if (aiSecret && provided && constantTimeEqual(provided, aiSecret)) {
    const resp = await buildMessage(svc, svc, { projectId, projectName });
    await writeWebResponseToNode(resp, nodeRes);
    return;
  }

  // Otherwise require a user JWT and RLS-gate the read (same posture as -ai).
  const resp = await withAuth(req, async (_user) => {
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    const auth = req.headers.get('Authorization') ?? '';
    const jwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!supabaseUrl || !anonKey || !jwt) return jsonError(500, 'Supabase env vars missing or JWT absent');
    const jwtClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    return buildMessage(jwtClient, svc, { projectId, projectName });
  });
  await writeWebResponseToNode(resp, nodeRes);
}
