/**
 * POST /api/files/used-in
 *
 * Body: { fileId: string }  →  { links: UsedInLink[], hiddenCount: number }
 *
 * Read-only resolver for the Phase 1 "Used in" panel. Returns the business
 * records a file is linked to — and ONLY those the caller may actually see.
 *
 * PRIVACY MODEL (the reason this is an endpoint and not a direct table read):
 * owning a file does not entitle you to know which client, reservation or
 * project uses it. A leak here would expose restricted record titles, record
 * types, deep links, and the mere existence of a client or transaction.
 *
 * Two independent gates, both enforced by the database, neither by this file:
 *   1. `file_links.file_links_select` requires BOTH
 *        wassell_can_access_file(file_id,'view')
 *      AND the target existing in `unified_records` — which is
 *      security_invoker=true, so the caller's own record RLS decides. That one
 *      predicate covers dynamic records AND every frozen model, and inherits the
 *      per-profile view_scope rules already in force.
 *   2. The title join reads `unified_records` again under the same JWT, so a
 *      record that slipped through could still not surface a title.
 *
 * This endpoint therefore cannot widen access: it runs entirely on the caller's
 * JWT and never touches the service role.
 *
 * `hiddenCount` is deliberately NOT returned as a per-record hint. It is the
 * count of links this caller cannot see at all, and it ships as 0 until product
 * explicitly approves exposing "N restricted uses" — see the Phase 1 design,
 * decision 2. Returning it silently would itself be a disclosure.
 */

import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { getJwtClient, isFileIdShape } from '../_lib/files.js';

export const config = { runtime: 'edge' };

/** Enough for any real file; the 212-record floor plan is the known worst case. */
const MAX_LINKS = 300;

interface LinkRow {
  id: string;
  role: string;
  model_id: string;
  record_id: string;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async () => {
    let body: { fileId?: string };
    try {
      body = (await req.json()) as { fileId?: string };
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const fileId = body.fileId;
    if (!fileId || !isFileIdShape(fileId)) {
      return jsonError(400, 'fileId (uuid) is required');
    }

    const jwt = getJwtClient(req);

    // RLS-filtered: only links whose file AND target record the caller may view.
    const { data: linkData, error: linkErr } = await jwt
      .from('file_links')
      .select('id, role, model_id, record_id')
      .eq('file_id', fileId)
      .limit(MAX_LINKS);
    if (linkErr) return jsonError(500, `link lookup failed: ${linkErr.message}`);

    const links = (linkData ?? []) as LinkRow[];
    if (links.length === 0) return jsonOk({ links: [], hiddenCount: 0 });

    // Titles come from unified_records under the SAME jwt — a second, independent
    // pass of the caller's record RLS. Frozen models are covered because the view
    // UNIONs them.
    const recordIds = Array.from(new Set(links.map((l) => l.record_id)));
    const [recRes, modelRes] = await Promise.all([
      jwt.from('unified_records').select('id, model_id, data').in('id', recordIds),
      jwt.from('models').select('id, name, label_ar, label_en'),
    ]);
    if (recRes.error) return jsonError(500, `record lookup failed: ${recRes.error.message}`);

    // Keyed by MODEL+RECORD, never record id alone. Record ids are only unique
    // per model in this schema — that is why model_id is part of the edge
    // identity and of the RLS target predicate — so an id-only lookup could
    // resolve a link against a different model's row that happens to share the
    // uuid, and hand back that row's title.
    const recordKey = (modelId: string, recordId: string) => `${modelId}|${recordId}`;
    const records = new Map(
      ((recRes.data ?? []) as Array<{ id: string; model_id: string; data: Record<string, unknown> }>)
        .map((r) => [recordKey(r.model_id, r.id), r] as const),
    );
    const models = new Map(
      ((modelRes.data ?? []) as Array<{ id: string; name: string; label_ar: string; label_en: string }>)
        .map((m) => [m.id, m] as const),
    );

    // Title slugs mirror the recordTitle heuristic used elsewhere in the app.
    const TITLE_SLUGS = [
      'project_name', 'name', 'title', 'client_name', 'full_name',
      'unit_number', 'unit_code', 'developer_name', 'label',
    ];
    const titleOf = (data: Record<string, unknown>): string | null => {
      for (const slug of TITLE_SLUGS) {
        const v = data[slug];
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number') return String(v);
      }
      return null;
    };

    const out = [];
    for (const l of links) {
      const rec = records.get(recordKey(l.model_id, l.record_id));
      // A link row whose record did not come back is one the caller may not see
      // (or one whose uuid exists only under a different model). Drop it
      // silently — no id, no role, no type, no placeholder.
      if (!rec) continue;
      const model = models.get(l.model_id);
      out.push({
        link_id: l.id,
        role: l.role,
        record_id: l.record_id,
        model_id: l.model_id,
        model_name: model?.name ?? null,
        model_label_ar: model?.label_ar ?? null,
        model_label_en: model?.label_en ?? null,
        title: titleOf(rec.data ?? {}),
      });
    }

    return jsonOk({ links: out, hiddenCount: 0 });
  });
}
