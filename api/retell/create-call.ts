/**
 * POST /api/retell/create-call
 *
 * Fire an outbound AI voice-agent call (Retell over the Hatif SIP trunk) at
 * the customer on a CRM record. Called by the record form's `ai_call` custom
 * button. The Retell API key is server-side — the browser never talks to
 * Retell directly.
 *
 * Body: { record_id: string, model_id?: string, phone_field?: string }
 *
 * Flow:
 *   1. withAuth — valid Supabase JWT required.
 *   2. assertCanAccessRecord — RLS (the caller's own JWT) decides whether they
 *      can see the record; service role is used only AFTER this gate.
 *   3. Resolve the customer phone from the record: explicit `phone_field`,
 *      else the first phone-type field in the model schema with a value,
 *      else common phone slugs. Normalized to E.164.
 *   4. POST Retell create-phone-call with from = the trunk number and
 *      metadata.client_record_id = record_id — the retell-call webhook
 *      prefers that id over the phone match, so the resulting phone_calls
 *      record links to exactly this record.
 *
 * The call outcome (transcript, summary, recording) lands via
 * api/webhook/retell-call.ts — this endpoint only starts the call.
 */

import { withAuth, assertCanAccessRecord, jsonOk, jsonError, AuthError } from '../_lib/auth.js';
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { normalizePhoneE164 } from '../_lib/hatif.js';

export const config = {
  runtime: 'edge',
};

/** The Hatif SIP trunk number — the only CLI the trunk accepts. */
const DEFAULT_FROM_NUMBER = '+966115001290';

interface SchemaField {
  name?: string;
  type?: string;
}
interface SchemaSection {
  fields?: SchemaField[];
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonError(405, `Method ${req.method} not allowed`);
  }
  return withAuth(req, async (user) => {
    let input: Record<string, unknown>;
    try {
      input = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const recordId = typeof input.record_id === 'string' ? input.record_id : '';
    if (!recordId) return jsonError(400, 'record_id is required');
    const modelId = typeof input.model_id === 'string' ? input.model_id : undefined;
    const phoneField = typeof input.phone_field === 'string' ? input.phone_field : undefined;

    const apiKey = process.env.RETELL_API_KEY;
    if (!apiKey) return jsonError(500, 'RETELL_API_KEY not configured');

    try {
      await assertCanAccessRecord(req, recordId, 'retell-create-call', modelId);
    } catch (err) {
      if (err instanceof AuthError) return jsonError(err.status, err.message);
      throw err;
    }

    // Post-gate reads via service role (frozen-safe through unified_records).
    const supa = getServiceSupabase();
    const { data: row, error: rowError } = await supa
      .from('unified_records')
      .select('model_id, data')
      .eq('id', recordId)
      .maybeSingle();
    if (rowError) return jsonError(500, `record read failed: ${rowError.message}`);
    if (!row) return jsonError(404, 'record not found');
    const data = (row.data ?? {}) as Record<string, unknown>;

    // Phone-typed field slugs from the model schema, in schema order.
    let phoneSlugs: string[] = [];
    let nameSlugs: string[] = [];
    const { data: modelRow } = await supa
      .from('models')
      .select('schema')
      .eq('id', row.model_id as string)
      .maybeSingle();
    const sections = ((modelRow?.schema as { sections?: SchemaSection[] } | null)?.sections) ?? [];
    for (const s of sections) {
      for (const f of s.fields ?? []) {
        if (!f?.name) continue;
        if (f.type === 'phone') phoneSlugs.push(f.name);
        if (f.type === 'text' && /(^|_)name/.test(f.name)) nameSlugs.push(f.name);
      }
    }
    if (phoneField) phoneSlugs = [phoneField, ...phoneSlugs];
    phoneSlugs.push('phone', 'phone_number', 'mobile', 'client_phone');

    let toNumber: string | null = null;
    for (const slug of phoneSlugs) {
      const v = data[slug];
      if (typeof v === 'string' && v.trim()) {
        toNumber = normalizePhoneE164(v);
        if (toNumber) break;
      }
    }
    if (!toNumber) return jsonError(400, 'no phone number found on this record');

    let clientName: string | null = null;
    for (const slug of [...nameSlugs, 'name', 'client_name', 'full_name', 'customer_name']) {
      const v = data[slug];
      if (typeof v === 'string' && v.trim()) { clientName = v.trim(); break; }
    }

    // Known-client context — a short Arabic summary the agent's prompt reads
    // as {{client_context}} so سعد doesn't re-ask what the CRM already knows.
    const contextParts: string[] = [];
    const range = (v: unknown, label: string, unit = '') => {
      if (!v || typeof v !== 'object') return;
      const r = v as { min?: unknown; max?: unknown };
      if (r.min == null && r.max == null) return;
      contextParts.push(`${label}: ${r.min ?? '؟'} إلى ${r.max ?? '؟'}${unit}`);
    };
    range(data.budget, 'الميزانية', ' ريال');
    range(data.preferred_bedrooms, 'غرف النوم');
    range(data.preferred_area, 'المساحة', ' م²');
    if (Array.isArray(data.preferred_unit_type) && data.preferred_unit_type.length) {
      contextParts.push(`نوع الوحدة: ${(data.preferred_unit_type as unknown[]).join('، ')}`);
    }
    if (typeof data.preferred_location_notes === 'string' && data.preferred_location_notes.trim()) {
      contextParts.push(`الموقع: ${data.preferred_location_notes.trim().slice(-300)}`);
    }
    if (typeof data.preference_notes === 'string' && data.preference_notes.trim()) {
      contextParts.push(`ملاحظات: ${data.preference_notes.trim().slice(-300)}`);
    }
    const clientContext = contextParts.length
      ? contextParts.join(' | ').slice(0, 1200)
      : 'لا توجد معلومات محفوظة عن هذا العميل بعد';

    const payload: Record<string, unknown> = {
      from_number: process.env.RETELL_FROM_NUMBER ?? DEFAULT_FROM_NUMBER,
      to_number: toNumber,
      metadata: {
        client_record_id: recordId,
        model_id: row.model_id,
        triggered_by_user_id: user.userId,
        source: 'ai_call_button',
      },
      retell_llm_dynamic_variables: {
        client_name: clientName ?? 'غير معروف',
        client_context: clientContext,
      },
    };

    const res = await fetch('https://api.retellai.com/v2/create-phone-call', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const msg = typeof body?.error === 'string' ? body.error : `Retell create-phone-call failed: ${res.status}`;
      // Retell 4xx (bad number, unfunded account…) surfaces as-is; 5xx → 502.
      return jsonError(res.status >= 500 ? 502 : res.status, msg);
    }
    return jsonOk({
      call_id: (body?.call_id as string | undefined) ?? null,
      to_number: toNumber,
    });
  });
}
