/**
 * POST /api/retell/agent-tools
 *
 * Mid-call tool server for the Retell voice agent (سعد). Retell custom
 * functions POST here while the agent is ON THE CALL; the response text goes
 * straight back into the LLM's context. This is what upgrades the agent from
 * a script-follower to a working sales assistant:
 *
 *   lookup_client          — who am I talking to? (by call metadata or phone)
 *   save_client_info       — write learned preferences onto the client record
 *                            (creates the client if the caller is unknown)
 *   find_matching_projects — run the REAL Project Finder engine
 *                            (findMatchingProjects — deterministic ranking)
 *   set_next_action        — book the next step (call/WhatsApp/visit) on the
 *                            client record's Sales-OS next-action fields
 *
 * Auth: `x-wassel-tool-secret` header must equal RETELL_WEBHOOK_SECRET —
 * configured as a static custom header on each tool in the Retell LLM config.
 * (Retell also signs with X-Retell-Signature; the shared-secret header is the
 * gate we fully control.)
 *
 * Request body (Retell standard mode): { name, args, call }. Responses are
 * compact Arabic-labeled JSON — the LLM reads them verbatim, so keep them
 * short (voice latency) and unambiguous.
 *
 * Writes to client records use optimistic concurrency (p_expected_version +
 * retry) — a rep may be editing the same client in the app mid-call.
 */

import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { normalizePhoneE164 } from '../_lib/hatif.js';
import { findMatchingProjects, FINDER_GROUP_KEYS } from '../_lib/projectFinder.js';
import type { MatchRequirements } from '../_lib/matchAgent.js';

export const config = {
  runtime: 'edge',
};

interface RetellToolCall {
  call_id?: string;
  direction?: string;
  from_number?: string;
  to_number?: string;
  metadata?: Record<string, unknown>;
}
interface ToolRequest {
  name?: string;
  args?: Record<string, unknown>;
  call?: RetellToolCall;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return json({ ok: true, hint: 'Retell custom-function tool server' });
  }
  if (req.method !== 'POST') {
    return json({ error: `Method ${req.method} not allowed` }, 405);
  }
  const secret = process.env.RETELL_WEBHOOK_SECRET;
  if (!secret) return json({ error: 'RETELL_WEBHOOK_SECRET not configured' }, 500);
  const provided = req.headers.get('x-wassel-tool-secret') ?? '';
  if (!constantTimeEqual(provided, secret)) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body: ToolRequest;
  try {
    body = (await req.json()) as ToolRequest;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  const name = body.name ?? '';
  const args = body.args ?? {};
  const call = body.call ?? {};

  try {
    switch (name) {
      case 'lookup_client':          return json(await lookupClient(call));
      case 'save_client_info':       return json(await saveClientInfo(call, args));
      case 'save_lead_info':         return json(await saveLeadInfo(call, args));
      case 'find_matching_projects': return json(await findProjects(call, args));
      case 'set_next_action':        return json(await setNextAction(call, args));
      default:
        return json({ error: `unknown tool: ${name}` }, 400);
    }
  } catch (err) {
    console.error(`[retell-tools] ${name} failed:`, err);
    // 200 with an Arabic error the LLM can voice gracefully — a 5xx would
    // surface to the agent as a hard tool failure.
    return json({ خطأ: 'صار خلل تقني بسيط، كمّل المكالمة بدون النظام واعتذر إذا لزم' });
  }
}

// ─── Shared: client resolution ─────────────────────────────────────

let clientsModelCache: { id: string; schema: Record<string, unknown> } | null = null;
async function clientsModel(): Promise<{ id: string; schema: Record<string, unknown> }> {
  if (clientsModelCache) return clientsModelCache;
  const supa = getServiceSupabase();
  const { data, error } = await supa.from('models').select('id, schema').eq('name', 'clients').maybeSingle();
  if (error || !data) throw new Error(`clients model load failed: ${error?.message ?? 'not found'}`);
  clientsModelCache = { id: data.id as string, schema: data.schema as Record<string, unknown> };
  return clientsModelCache;
}

/** The customer's phone for this call — the non-agent leg. */
function customerPhone(call: RetellToolCall): string | null {
  const raw = (call.direction ?? '').toLowerCase() === 'inbound' ? call.from_number : call.to_number;
  return normalizePhoneE164(raw ?? null);
}

interface ClientRow {
  id: string;
  version: number | null;
  data: Record<string, unknown>;
}

async function resolveClient(call: RetellToolCall): Promise<ClientRow | null> {
  const supa = getServiceSupabase();
  const metaId = typeof call.metadata?.client_record_id === 'string' ? call.metadata.client_record_id : null;
  if (metaId) {
    const { data } = await supa.from('records').select('id, version, data').eq('id', metaId).maybeSingle();
    if (data) return data as ClientRow;
  }
  const phone = customerPhone(call);
  if (!phone) return null;
  const { data: cid } = await supa.rpc('find_client_id_by_phone', { p_phone: phone });
  if (!cid) return null;
  const { data } = await supa.from('records').select('id, version, data').eq('id', cid as string).maybeSingle();
  return (data as ClientRow | null) ?? null;
}

// ─── Option mapping (dropdown/multiselect Arabic ↔ stored values) ──

interface OptionDef { value?: string; label_ar?: string; label_en?: string }

function fieldOptions(schema: Record<string, unknown>, slug: string): OptionDef[] {
  const sections = (schema.sections ?? []) as Array<{ fields?: Array<Record<string, unknown>> }>;
  for (const s of sections) {
    for (const f of s.fields ?? []) {
      if (f.name === slug) return (f.options ?? []) as OptionDef[];
    }
  }
  return [];
}

const normalizeAr = (s: string) =>
  s.trim().toLowerCase()
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ');

/** Map a spoken value ("شقة", "فيلا", "استثمار") to the option's stored value. */
function mapOption(options: OptionDef[], spoken: string): string | null {
  const n = normalizeAr(spoken);
  for (const o of options) {
    for (const cand of [o.value, o.label_ar, o.label_en]) {
      if (cand && (normalizeAr(cand) === n || normalizeAr(cand).includes(n) || n.includes(normalizeAr(cand)))) {
        return o.value ?? null;
      }
    }
  }
  return null;
}

function optionLabel(options: OptionDef[], value: unknown): string | null {
  const o = options.find((x) => x.value === value);
  return o?.label_ar ?? o?.label_en ?? (typeof value === 'string' ? value : null);
}

// ─── lookup_client ─────────────────────────────────────────────────

async function lookupClient(call: RetellToolCall): Promise<Record<string, unknown>> {
  const row = await resolveClient(call);
  if (!row) {
    return {
      found: false,
      ملاحظة: 'عميل غير مسجل — اسأل عن الاسم واحفظه مع تفضيلاته عبر save_client_info',
    };
  }
  const { schema } = await clientsModel();
  const d = row.data;
  const range = (v: unknown): string | null => {
    if (!v || typeof v !== 'object') return null;
    const r = v as { min?: unknown; max?: unknown };
    if (r.min == null && r.max == null) return null;
    return `${r.min ?? '؟'} - ${r.max ?? '؟'}`;
  };
  const multi = (slug: string): string[] => {
    const opts = fieldOptions(schema, slug);
    const vals = Array.isArray(d[slug]) ? (d[slug] as unknown[]) : [];
    return vals.map((v) => optionLabel(opts, v)).filter((x): x is string => !!x);
  };
  return {
    found: true,
    الاسم: (d.client_name as string | undefined) ?? null,
    الحالة: optionLabel(fieldOptions(schema, 'client_status'), d.client_status),
    الميزانية: range(d.budget),
    نوع_الوحدة_المفضل: multi('preferred_unit_type'),
    غرف_النوم: range(d.preferred_bedrooms),
    المساحة_المفضلة: range(d.preferred_area),
    هدف_الشراء: multi('purchase_objective'),
    ملاحظات_التفضيلات: (d.preference_notes as string | undefined) ?? null,
    ملاحظات_الموقع: (d.preferred_location_notes as string | undefined) ?? null,
  };
}

// ─── save_client_info ──────────────────────────────────────────────

async function saveClientInfo(
  call: RetellToolCall,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { id: modelId, schema } = await clientsModel();
  const supa = getServiceSupabase();

  let row = await resolveClient(call);
  const phone = customerPhone(call);

  // Unknown caller → create the client (lead intake, like a human would).
  if (!row) {
    if (!phone) return { خطأ: 'لا يمكن تحديد رقم العميل لإنشاء سجل' };
    const newId = crypto.randomUUID();
    const seed: Record<string, unknown> = {
      phone_number: phone,
      client_name: typeof args.client_name === 'string' ? args.client_name : 'عميل جديد (مكالمة AI)',
    };
    const { error } = await supa.rpc('record_save', { p_model_id: modelId, p_id: newId, p_data: seed });
    if (error) throw new Error(`client create failed: ${error.message}`);
    const { data } = await supa.from('records').select('id, version, data').eq('id', newId).maybeSingle();
    row = (data as ClientRow | null) ?? { id: newId, version: null, data: seed };
  }

  const str = (k: string) => (typeof args[k] === 'string' && (args[k] as string).trim() ? (args[k] as string).trim() : null);
  const num = (k: string) => (typeof args[k] === 'number' && Number.isFinite(args[k] as number) ? (args[k] as number) : null);
  const arr = (k: string) => (Array.isArray(args[k]) ? (args[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []);

  const applied: string[] = [];
  const skipped: string[] = [];

  const buildPatch = (data: Record<string, unknown>): Record<string, unknown> => {
    const patch: Record<string, unknown> = {};
    const mergeRange = (slug: string, min: number | null, max: number | null, label: string) => {
      if (min == null && max == null) return;
      const prev = (data[slug] ?? {}) as { min?: unknown; max?: unknown };
      patch[slug] = { min: min ?? prev.min ?? null, max: max ?? prev.max ?? null };
      applied.push(label);
    };
    const name = str('client_name');
    if (name) { patch.client_name = name; applied.push('الاسم'); }
    mergeRange('budget', num('budget_min'), num('budget_max'), 'الميزانية');
    mergeRange('preferred_bedrooms', num('bedrooms_min'), num('bedrooms_max'), 'غرف النوم');
    mergeRange('preferred_area', num('area_min'), num('area_max'), 'المساحة');

    const unitTypes = arr('unit_types');
    if (unitTypes.length) {
      const opts = fieldOptions(schema, 'preferred_unit_type');
      const mapped = unitTypes.map((t) => mapOption(opts, t)).filter((x): x is string => !!x);
      if (mapped.length) {
        const prev = Array.isArray(data.preferred_unit_type) ? (data.preferred_unit_type as string[]) : [];
        patch.preferred_unit_type = Array.from(new Set([...prev, ...mapped]));
        applied.push('نوع الوحدة');
      } else skipped.push(`نوع الوحدة غير معروف: ${unitTypes.join('، ')}`);
    }
    const objective = str('purchase_objective');
    if (objective) {
      const opts = fieldOptions(schema, 'purchase_objective');
      const mapped = mapOption(opts, objective);
      if (mapped) {
        const prev = Array.isArray(data.purchase_objective) ? (data.purchase_objective as string[]) : [];
        patch.purchase_objective = Array.from(new Set([...prev, mapped]));
        applied.push('هدف الشراء');
      } else skipped.push(`هدف الشراء غير معروف: ${objective}`);
    }
    const districts = arr('districts');
    const notes = str('notes');
    const stamp = new Date().toISOString().slice(0, 10);
    if (districts.length) {
      const prev = (data.preferred_location_notes as string | undefined) ?? '';
      patch.preferred_location_notes = `${prev ? `${prev}\n` : ''}[مكالمة AI ${stamp}] أحياء مطلوبة: ${districts.join('، ')}`;
      applied.push('الأحياء');
    }
    if (notes) {
      const prev = (data.preference_notes as string | undefined) ?? '';
      patch.preference_notes = `${prev ? `${prev}\n` : ''}[مكالمة AI ${stamp}] ${notes}`;
      applied.push('ملاحظات');
    }
    return patch;
  };

  // Optimistic write: merge onto the FRESH row each attempt.
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: fresh } = await supa.from('records').select('id, version, data').eq('id', row.id).maybeSingle();
    const current = (fresh as ClientRow | null) ?? row;
    applied.length = 0; skipped.length = 0;
    const patch = buildPatch(current.data ?? {});
    if (Object.keys(patch).length === 0) {
      return { تم: false, ملاحظة: 'لا توجد معلومات جديدة لحفظها', تجاهل: skipped };
    }
    const { error } = await supa.rpc('record_save', {
      p_model_id: modelId,
      p_id: current.id,
      p_data: { ...(current.data ?? {}), ...patch },
      p_created_by: null,
      p_expected_version: current.version,
    });
    if (!error) {
      return { تم: true, حفظ: applied, ...(skipped.length ? { تجاهل: skipped } : {}) };
    }
    lastError = error.message;
    if (!/version_mismatch|40001/.test(error.message)) break;
  }
  throw new Error(`save_client_info failed: ${lastError}`);
}

// ─── save_lead_info (the qualification-flow tool the prompt uses) ──
// The prompt's script ends every call path with save_lead_info. It's a thin
// adapter over saveClientInfo's field mapping: status → notes (+ callback →
// next action), property_type → unit types, preferred_location → district
// note, maximum_price → budget max.

const LEAD_STATUS_AR: Record<string, string> = {
  interested: 'مهتم',
  not_interested: 'غير مهتم',
  already_purchased: 'اشترى بالفعل',
  callback_requested: 'طلب إعادة اتصال',
  wrong_number: 'رقم خاطئ',
  no_clear_answer: 'إجابة غير واضحة',
};

async function saveLeadInfo(
  call: RetellToolCall,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const status = typeof args.status === 'string' ? args.status : '';
  const statusAr = LEAD_STATUS_AR[status] ?? status ?? 'غير محدد';
  const callback = typeof args.callback_time === 'string' && args.callback_time.trim()
    ? args.callback_time.trim()
    : null;

  const mapped: Record<string, unknown> = {
    notes: `نتيجة المكالمة: ${statusAr}${callback ? ` — إعادة الاتصال: ${callback}` : ''}`,
  };
  if (typeof args.property_type === 'string' && args.property_type.trim()) {
    mapped.unit_types = [args.property_type.trim()];
  }
  if (typeof args.preferred_location === 'string' && args.preferred_location.trim()) {
    mapped.districts = [args.preferred_location.trim()];
  }
  const maxPrice = typeof args.maximum_price === 'number' && Number.isFinite(args.maximum_price)
    ? args.maximum_price
    : typeof args.maximum_price === 'string' && args.maximum_price.trim() !== '' && Number.isFinite(Number(args.maximum_price))
      ? Number(args.maximum_price)
      : null;
  if (maxPrice != null) mapped.budget_max = maxPrice;

  const saved = await saveClientInfo(call, mapped);

  // A requested callback also books the next action so it shows in Sales OS.
  if (status === 'callback_requested') {
    try {
      await setNextAction(call, { action: 'call', note: `طلب العميل إعادة الاتصال: ${callback ?? 'بدون وقت محدد'}` });
    } catch (err) {
      console.error('[retell-tools] callback next-action failed:', err);
    }
  }
  return saved;
}

// ─── find_matching_projects ────────────────────────────────────────

async function findProjects(
  call: RetellToolCall,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const supa = getServiceSupabase();
  const row = await resolveClient(call);
  const d = row?.data ?? {};

  const num = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  };
  const rangeOf = (v: unknown): { min?: number; max?: number } => {
    if (!v || typeof v !== 'object') return {};
    const r = v as { min?: unknown; max?: unknown };
    return { min: num(r.min), max: num(r.max) };
  };

  const savedBudget = rangeOf(d.budget);
  const savedBeds = rangeOf(d.preferred_bedrooms);
  const savedArea = rangeOf(d.preferred_area);

  const req: MatchRequirements = { city: 'الرياض' };
  const city = typeof args.city === 'string' && args.city.trim() ? args.city.trim() : null;
  if (city) req.city = city;
  const districts = Array.isArray(args.districts)
    ? (args.districts as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    : [];
  if (districts.length) { req.districts = districts; req.district = districts[0]; }
  const pt = typeof args.property_type === 'string' && args.property_type.trim() ? args.property_type.trim() : null;
  if (pt) req.property_type = pt;
  const bmin = num(args.budget_min) ?? savedBudget.min; if (bmin != null) req.budget_min = bmin;
  const bmax = num(args.budget_max) ?? savedBudget.max; if (bmax != null) req.budget_max = bmax;
  const amin = num(args.area_min) ?? savedArea.min; if (amin != null) req.area_min = amin;
  const amax = num(args.area_max) ?? savedArea.max; if (amax != null) req.area_max = amax;
  const beds = num(args.bedrooms) ?? savedBeds.min; if (beds != null) req.bedrooms = beds;

  const out = await findMatchingProjects(supa, req, {
    perGroup: 3,
    sources: ['our_projects', 'all_projects'],
  });
  if (!out.ok) return { خطأ: `تعذر البحث: ${out.error}` };

  // Flatten groups in engine priority order; keep it voice-sized.
  const flat = FINDER_GROUP_KEYS.flatMap((g) => out.result.groups[g] ?? []).slice(0, 4);
  if (flat.length === 0) {
    return {
      نتائج: [],
      ملاحظة: 'لا توجد مشاريع مطابقة بهذه الشروط — جرّب توسيع الميزانية أو الأحياء',
    };
  }
  return {
    نتائج: flat.map((m) => ({
      المشروع: m.project_name,
      الشرح: m.explanation,
      ...(m.distance_km != null && m.nearest_ref_name
        ? { المسافة: `${Math.round(m.distance_km)} كم من ${m.nearest_ref_name}` }
        : {}),
    })),
    العدد_الكلي: out.result.metadata.total_candidates,
    تعليمات: 'اعرض مشروعاً أو مشروعين فقط بصيغة مختصرة، واعرض إرسال التفاصيل واتساب',
  };
}

// ─── set_next_action ───────────────────────────────────────────────

async function setNextAction(
  call: RetellToolCall,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const row = await resolveClient(call);
  if (!row) return { خطأ: 'العميل غير مسجل — احفظ معلوماته أولاً عبر save_client_info' };
  const { id: modelId, schema } = await clientsModel();
  const supa = getServiceSupabase();

  const action = typeof args.action === 'string' ? args.action : '';
  const opts = fieldOptions(schema, 'next_action_type');
  const mapped = action ? mapOption(opts, action) : null;

  let dueAt: string | null = null;
  if (typeof args.due_at === 'string' && args.due_at.trim()) {
    const t = new Date(args.due_at);
    if (!Number.isNaN(t.getTime())) dueAt = t.toISOString();
  }
  if (!dueAt) {
    // Default: tomorrow 10:00 Riyadh (07:00 UTC).
    const t = new Date(); t.setUTCDate(t.getUTCDate() + 1); t.setUTCHours(7, 0, 0, 0);
    dueAt = t.toISOString();
  }
  const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : null;

  const patch: Record<string, unknown> = { next_action_due_at: dueAt };
  if (mapped) patch.next_action_type = mapped;
  if (note) {
    const stamp = new Date().toISOString().slice(0, 10);
    const prev = (row.data.preference_notes as string | undefined) ?? '';
    patch.preference_notes = `${prev ? `${prev}\n` : ''}[مكالمة AI ${stamp}] متابعة: ${note}`;
  }
  const { error } = await supa.rpc('record_save', {
    p_model_id: modelId,
    p_id: row.id,
    p_data: { ...row.data, ...patch },
    p_created_by: null,
    p_expected_version: row.version,
  });
  if (error) throw new Error(`set_next_action failed: ${error.message}`);
  return {
    تم: true,
    الموعد: dueAt,
    ...(mapped ? {} : { ملاحظة: `نوع الإجراء "${action}" غير معروف — سُجّل الموعد فقط` }),
  };
}

// ─── plumbing ──────────────────────────────────────────────────────

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
