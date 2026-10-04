/**
 * Which officers (the developer's / marketer's contact person) cover a project.
 * One resolver for the «إشعار المسؤول» button (/api/whatsapp/notify-officer)
 * and the AI officer-notice drafts (/api/cron/ai-sales-automation), so both
 * pick the same person.
 *
 * Coverage: an officer covers project P when
 *   P.id ∈ officer.projects                                   (explicit), OR
 *   officer.projects is empty AND officer.developer == P.developer, OR
 *   officer.projects is empty AND officer.marketer ∈ P.marketers.
 * Developer-officer-wins (the operator's rule): when ANY developer-side officer
 * covers P, only developer-side officers are returned. Explicit first.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

type Rec = { id: string; data: Record<string, unknown> };

export interface CoveringOfficer {
  id: string;
  name: string;
  phone: string;
  coverage: 'explicit' | 'developer' | 'marketer';
  party: 'developer' | 'marketer' | null;
}

/** Lookup values are stored as a target id string, an array of them, or {id}. */
function idList(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === 'string' ? x : (x && typeof x === 'object' && 'id' in x ? String((x as { id: unknown }).id) : ''))).filter(Boolean);
  }
  if (typeof v === 'string') return [v];
  if (typeof v === 'object' && v !== null && 'id' in v) return [String((v as { id: unknown }).id)];
  return [];
}

export async function resolveProjectOfficers(svc: SupabaseClient, projectId: string): Promise<CoveringOfficer[]> {
  const { data: models, error: mErr } = await svc.from('models').select('id, name').eq('name', 'project_officers').maybeSingle();
  if (mErr) throw new Error(`project_officers model lookup failed: ${mErr.message}`);
  const officersModelId = (models as { id: string } | null)?.id;
  if (!officersModelId) return [];

  // A project can carry BOTH a developer and a marketer (a marketing company
  // reselling a developer's project). We resolve officers on either side.
  const { data: projRow, error: pErr } = await svc.from('unified_records').select('data').eq('id', projectId).maybeSingle();
  if (pErr) throw new Error(`project lookup failed: ${pErr.message}`);
  const pdata = (projRow as Rec | null)?.data ?? {};
  const developerId = idList(pdata.developer)[0] ?? null;
  // Several marketers per project since 2026-09-29 — an officer of ANY covers it.
  const marketerIds = idList(pdata.marketer);

  const { data: offRows, error: oErr } = await svc
    .from('unified_records')
    .select('id, data')
    .eq('model_id', officersModelId);
  if (oErr) throw new Error(`officers lookup failed: ${oErr.message}`);

  const covering: CoveringOfficer[] = [];
  for (const o of (offRows ?? []) as Rec[]) {
    const d = o.data ?? {};
    if (d.is_active === false) continue;
    const phone = typeof d.phone === 'string' ? d.phone : '';
    if (!phone) continue;
    const offDev = idList(d.developer)[0] ?? null;
    const offMkt = idList(d.marketer)[0] ?? null;
    // An officer is tied to a developer OR a marketer; that is their "party".
    const party: CoveringOfficer['party'] = offDev ? 'developer' : offMkt ? 'marketer' : null;
    const projs = idList(d.projects);

    let coverage: CoveringOfficer['coverage'] | null = null;
    if (projs.includes(projectId)) {
      coverage = 'explicit';
    } else if (projs.length === 0) {
      if (offDev && developerId && offDev === developerId) coverage = 'developer';
      else if (offMkt && marketerIds.includes(offMkt)) coverage = 'marketer';
    }
    if (!coverage) continue;
    covering.push({ id: o.id, name: String(d.name ?? ''), phone, coverage, party });
  }

  // Developer-officer-wins: evaluated live per call, so it self-corrects when
  // an officer is added or removed.
  const devSide = covering.filter((o) => o.party === 'developer');
  const chosen = devSide.length > 0 ? devSide : covering.filter((o) => o.party !== 'developer');

  // Explicit subset assignment is a stronger signal than a whole-entity match.
  chosen.sort((a, b) => (a.coverage === b.coverage ? 0 : a.coverage === 'explicit' ? -1 : 1));
  return chosen;
}
