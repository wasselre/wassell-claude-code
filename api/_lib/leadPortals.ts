/**
 * Shared lead-portal helpers — portal coverage, field parsing/prefill, recipe
 * sanity check, worker wake. Used by `/api/portal-registration` (the rep's
 * "Register in portal" button) and `/api/cron/portal-auto-register` (the
 * automatic registration of ad leads), so both paths resolve a portal and
 * prefill a lead EXACTLY the same way.
 */
import { makeServiceClient } from './serviceClient.js';

export const LEAD_PORTALS_MODEL_ID = '1ead0000-0000-4000-8000-000000000001';

export type Svc = NonNullable<ReturnType<typeof makeServiceClient>>;
export type Rec = { id: string; data: Record<string, unknown> };

export interface PortalFieldSpec {
  key: string;
  label_ar: string;
  label_en: string;
  type?: 'text' | 'phone' | 'email' | 'number' | 'select' | 'textarea';
  required?: boolean;
  /** Where the prefill comes from: client.<field> | project.<field> | user.<email|name> | literal:<text> */
  source?: string;
  options?: { value: string; label_ar: string; label_en: string }[];
  placeholder?: string;
  /** Translate the resolved source value (exact match) into what the portal
   *  wants — e.g. our unit-type slug → the portal's Arabic option, or a CRM
   *  project name → the portal's spelling of it. Applied before the options
   *  check. */
  map?: Record<string, string>;
  /** Prefill fallback when the source resolves to nothing. */
  default?: string;
  /** Not shown in the modal — sent with its prefilled/default value. A hidden
   *  REQUIRED field that resolves to nothing still blocks the run (the modal
   *  names it so the rep can fix the client record). */
  hidden?: boolean;
}

export interface PortalOption {
  id: string;
  name: string;
  login_url: string;
  login_phone: string | null;
  otp_channel: string | null;
  coverage: 'project' | 'officer' | 'developer' | 'marketer';
  fields: PortalFieldSpec[];
  prefill: Record<string, string>;
  recipe_ok: boolean;
  recipe_error: string | null;
  /** The portal's `auto_register` switch: ad leads for a covered project are
   *  registered by /api/cron/portal-auto-register without a rep clicking. */
  auto_register: boolean;
}

/** Default customer fields when a portal declares none. */
export const DEFAULT_FIELDS: PortalFieldSpec[] = [
  { key: 'name', label_ar: 'اسم العميل', label_en: 'Customer name', source: 'client.client_name', required: true },
  { key: 'phone', label_ar: 'رقم الجوال', label_en: 'Mobile', type: 'phone', source: 'client.phone_number', required: true },
];

/** Lookup values are stored as a target id string, an array of them, or {id}. */
export function idList(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' && 'id' in x ? String((x as { id: unknown }).id) : ''))
      .filter(Boolean);
  }
  if (typeof v === 'string') return [v];
  if (typeof v === 'object' && v !== null && 'id' in v) return [String((v as { id: unknown }).id)];
  return [];
}

export function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** Parse the portal's `required_fields` (JSON text or array). Invalid → the
 *  defaults, with the parse error surfaced so the admin can fix the record. */
export function parseFields(raw: unknown): { fields: PortalFieldSpec[]; error: string | null } {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return { fields: DEFAULT_FIELDS, error: null };
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (err) {
      return { fields: DEFAULT_FIELDS, error: `required_fields is not valid JSON: ${(err as Error).message}` };
    }
  }
  if (!Array.isArray(value)) return { fields: DEFAULT_FIELDS, error: 'required_fields must be a JSON array' };
  const fields: PortalFieldSpec[] = [];
  for (const f of value) {
    if (!f || typeof f !== 'object') continue;
    const o = f as Record<string, unknown>;
    const key = str(o.key).trim();
    if (!key) continue;
    fields.push({
      key,
      label_ar: str(o.label_ar) || key,
      label_en: str(o.label_en) || key,
      type: (['text', 'phone', 'email', 'number', 'select', 'textarea'] as const).find((t) => t === o.type) ?? 'text',
      required: o.required !== false,
      source: str(o.source) || undefined,
      options: Array.isArray(o.options)
        ? (o.options as unknown[])
            .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : null))
            .filter((x): x is Record<string, unknown> => !!x)
            .map((x) => ({ value: str(x.value), label_ar: str(x.label_ar) || str(x.value), label_en: str(x.label_en) || str(x.value) }))
        : undefined,
      placeholder: str(o.placeholder) || undefined,
      map:
        o.map && typeof o.map === 'object' && !Array.isArray(o.map)
          ? Object.fromEntries(Object.entries(o.map as Record<string, unknown>).map(([k, v]) => [k, str(v)]))
          : undefined,
      default: str(o.default) || undefined,
      hidden: o.hidden === true,
    });
  }
  return { fields: fields.length ? fields : DEFAULT_FIELDS, error: null };
}

/** A record value → the string a form wants. Arrays (multiselect / multi
 *  lookup) → their first string; {min,max} ranges → "min - max" with thousands
 *  separators (the shape portals ask budgets in); scalars → as-is. */
export function valueToText(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) {
    const first = v.find((x) => typeof x === 'string' && x.trim()) ?? v[0];
    return typeof first === 'string' ? first : str(first);
  }
  if (typeof v === 'object') {
    const o = v as { min?: unknown; max?: unknown };
    if ('min' in o || 'max' in o) {
      const fmt = (n: unknown) => (typeof n === 'number' ? n.toLocaleString('en-US') : str(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
      const lo = o.min != null && o.min !== '' ? fmt(o.min) : '';
      const hi = o.max != null && o.max !== '' ? fmt(o.max) : '';
      return lo && hi ? `${lo} - ${hi}` : lo || hi;
    }
    return '';
  }
  return str(v);
}

/** Prefill one field: source → map → (select) option match → default. */
export function prefillField(
  f: PortalFieldSpec,
  ctx: { client: Record<string, unknown>; project: Record<string, unknown>; user: { email: string; name: string; phone: string } },
): string {
  let v = resolveSource(f.source, ctx);
  if (v && f.map && f.map[v] != null) v = f.map[v]!;
  if (f.type === 'select' && f.options?.length) {
    if (v && !f.options.some((o) => o.value === v)) {
      const byLabel = f.options.find((o) => o.label_ar === v || o.label_en === v);
      v = byLabel ? byLabel.value : '';
    }
  }
  return v || f.default || '';
}

/** Light recipe check (the worker does the deep one): non-empty JSON array of
 *  objects with a string `do`. Lets the modal grey out a portal whose recipe is
 *  missing/broken instead of burning a Browserbase session to find out. */
export function checkRecipe(raw: unknown): { ok: boolean; error: string | null } {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return { ok: false, error: 'no recipe yet' };
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `recipe is not valid JSON: ${(err as Error).message}` };
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { steps?: unknown }).steps)) {
    value = (value as { steps: unknown[] }).steps;
  }
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: 'recipe must be a non-empty array of steps' };
  const bad = value.findIndex((s) => !s || typeof s !== 'object' || typeof (s as { do?: unknown }).do !== 'string');
  if (bad >= 0) return { ok: false, error: `step ${bad} has no "do"` };
  return { ok: true, error: null };
}

/** Resolve a prefill `source` against the client / project / caller. */
export function resolveSource(
  source: string | undefined,
  ctx: { client: Record<string, unknown>; project: Record<string, unknown>; user: { email: string; name: string; phone: string } },
): string {
  if (!source) return '';
  if (source.startsWith('literal:')) return source.slice('literal:'.length);
  const [root, ...rest] = source.split('.');
  const path = rest.join('.');
  if (root === 'client') return valueToText(ctx.client[path]);
  if (root === 'project') return valueToText(ctx.project[path]);
  if (root === 'user') return path === 'email' ? ctx.user.email : path === 'name' ? ctx.user.name : path === 'phone' ? ctx.user.phone : '';
  return '';
}

export async function loadRecord(svc: Svc, id: string | null): Promise<Rec | null> {
  if (!id) return null;
  const { data, error } = await svc.from('unified_records').select('id, data').eq('id', id).maybeSingle();
  if (error) throw new Error(`record load failed: ${error.message}`);
  return (data as Rec | null) ?? null;
}

/** Ids of officers covering a project — the same rule as /api/whatsapp/notify-officer. */
export async function coveringOfficerIds(svc: Svc, projectId: string, developerId: string | null, marketerId: string | null): Promise<Set<string>> {
  const { data: m } = await svc.from('models').select('id').eq('name', 'project_officers').maybeSingle();
  const officersModelId = (m as { id: string } | null)?.id;
  if (!officersModelId) return new Set();
  const { data: rows } = await svc.from('unified_records').select('id, data').eq('model_id', officersModelId);
  const out = new Set<string>();
  for (const o of (rows ?? []) as Rec[]) {
    const d = o.data ?? {};
    if (d.is_active === false) continue;
    const projs = idList(d.projects);
    const offDev = idList(d.developer)[0] ?? null;
    const offMkt = idList(d.marketer)[0] ?? null;
    if (projs.includes(projectId)) out.add(o.id);
    else if (projs.length === 0 && ((offDev && offDev === developerId) || (offMkt && offMkt === marketerId))) out.add(o.id);
  }
  return out;
}

export async function resolvePortals(
  svc: Svc,
  client: Rec,
  project: Rec | null,
  user: { email: string; name: string; phone: string },
): Promise<PortalOption[]> {
  const { data: rows, error } = await svc
    .from('unified_records')
    .select('id, data')
    .eq('model_id', LEAD_PORTALS_MODEL_ID);
  if (error) throw new Error(`portals load failed: ${error.message}`);
  const portals = ((rows ?? []) as Rec[]).filter((p) => (p.data ?? {}).is_active !== false);
  if (portals.length === 0) return [];

  const pdata = project?.data ?? {};
  const developerId = idList(pdata.developer)[0] ?? null;
  const marketerId = idList(pdata.marketer)[0] ?? null;
  const officerIds = project ? await coveringOfficerIds(svc, project.id, developerId, marketerId) : new Set<string>();

  const rank: Record<PortalOption['coverage'], number> = { project: 0, officer: 1, developer: 2, marketer: 3 };
  const out: PortalOption[] = [];
  for (const p of portals) {
    const d = p.data ?? {};
    let coverage: PortalOption['coverage'] | null = null;
    if (project && idList(d.projects).includes(project.id)) coverage = 'project';
    else if (idList(d.officers).some((id) => officerIds.has(id))) coverage = 'officer';
    else if (developerId && idList(d.developer)[0] === developerId) coverage = 'developer';
    else if (marketerId && idList(d.marketer)[0] === marketerId) coverage = 'marketer';
    if (!coverage) continue;

    const { fields, error: fieldsErr } = parseFields(d.required_fields);
    const recipe = checkRecipe(d.recipe);
    const prefill: Record<string, string> = {};
    for (const f of fields) {
      const v = prefillField(f, { client: client.data ?? {}, project: pdata, user });
      if (v) prefill[f.key] = v;
    }
    out.push({
      id: p.id,
      name: str(d.name) || '—',
      login_url: str(d.login_url),
      login_phone: str(d.login_phone) || null,
      otp_channel: str(d.otp_channel) || null,
      coverage,
      fields,
      prefill,
      recipe_ok: recipe.ok && !fieldsErr,
      recipe_error: recipe.error ?? fieldsErr,
      auto_register: d.auto_register === true,
    });
  }
  out.sort((a, b) => rank[a.coverage] - rank[b.coverage] || a.name.localeCompare(b.name));
  return out;
}

/** Best-effort wake ping so the worker skips its ~3s poll. Never blocks. */
export async function wakeWorker(jobId: string): Promise<void> {
  const workerUrl = process.env.WASSEL_DECK_WORKER_URL;
  if (!workerUrl) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    await fetch(`${workerUrl.replace(/\/$/, '')}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (err) {
    console.warn(`[portal-registration] wake ping failed (non-fatal): ${(err as Error).message}`);
  }
}
