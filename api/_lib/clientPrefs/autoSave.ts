/**
 * The client profile fills itself in — the AI's OWN save of what the readers
 * heard, with no rep tick (operator, 2026-10-04: "no one needs to approve the
 * product preference, location preference … After the AI reads it, it just
 * adds the preference to the client profile").
 *
 * Called right after a reader mints a proposal (readChat.ts for chats, the
 * chat-auto-read cron for the call audit). It reuses the SAME pieces a rep's
 * save uses — the merge rules (src/lib/clientPrefs/mergePrefs.ts), the geo
 * review core (`applyReview` in api/geo-preference/review.ts) and the versioned
 * `recordSaveWithRetry` write — so there is still ONE way a preference reaches a
 * client; only who presses save changed.
 *
 * Guards (each one is why a value is NOT written):
 *   - preferences: the quote must be in the CUSTOMER's own messages
 *     (`customerSaidIt`, the call audit's guard — chats now get it too);
 *     a range a REP set is never overwritten (`buildAiPrefPatch`); a call stays
 *     fill-empty-only.
 *   - places: only placements that are resolved and savable (the card's own
 *     rule) AND that the second-pass checker did not doubt; a call proposal is
 *     still saved only for a client with no places.
 * Everything written — and everything heard but not written — lands in
 * `client_ai_changes`, which the chat card lists with Undo.
 *
 * A failure here never fails the read: the proposal simply stays pending and
 * the rep sees it as before. Errors are logged, never swallowed.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordSaveWithRetry } from '../recordSaveRetry.js';
import { customerSaidIt } from './quoteMatch.js';
import type { Conversation } from '../geoPreference/extractor.js';
import type { GeoPreference } from '../geoPreference/ontology.js';
import { placementsByEvidence, isUuid, type Placement } from '../geoPreference/placementText.js';
import { pruneGeoExpression } from '../../../src/lib/geo/pruneGeoExpression.js';
import {
  PREF_FIELD_KINDS, isPrefSlug, buildAiPrefPatch, buildFillEmptyPatch, asRangeValue, valueEqual, undoPrefValue,
  type PrefSuggestionLike,
} from '../../../src/lib/clientPrefs/mergePrefs.js';
import { parseLocationItems, type LocationItem } from '../../../src/lib/geo/locationItems.js';
import {
  applyReview, geoPreferenceToLocationItems, locationItemSignature, mergeLocationItems, buildGeoApplyData,
  ReviewError, CLIENT_HAS_PLACES, type ReviewDeps, type ProposalRow,
} from '../../geo-preference/review.js';
import { prefOptionsFromSchema } from '../../client-prefs/review.js';

export type ChangeSource = 'chat' | 'call' | 'agent';

export interface AutomationSettings {
  auto_save_profile: boolean;
  auto_apply_outcomes: boolean;
  outcome_auto_min_confidence: number;
  outcome_quiet_minutes: number;
}

/** The automatic-path switches (ai_automation_settings, id=1). A read error throws. */
export async function loadAutomationSettings(sb: SupabaseClient): Promise<AutomationSettings> {
  const { data, error } = await sb.from('ai_automation_settings')
    .select('auto_save_profile, auto_apply_outcomes, outcome_auto_min_confidence, outcome_quiet_minutes')
    .eq('id', 1).maybeSingle();
  if (error) throw new Error(`ai_automation_settings read failed: ${error.message}`);
  const d = (data ?? {}) as Partial<AutomationSettings>;
  return {
    auto_save_profile: d.auto_save_profile !== false,
    auto_apply_outcomes: d.auto_apply_outcomes !== false,
    outcome_auto_min_confidence: typeof d.outcome_auto_min_confidence === 'number' ? d.outcome_auto_min_confidence : 80,
    outcome_quiet_minutes: typeof d.outcome_quiet_minutes === 'number' ? d.outcome_quiet_minutes : 15,
  };
}

interface ChangeRow {
  client_id: string;
  kind: 'pref' | 'place' | 'outcome';
  field?: string | null;
  before_value?: unknown;
  after_value?: unknown;
  added?: unknown;
  applied?: boolean;
  note?: string | null;
  source: ChangeSource;
  source_ref?: string | null;
  proposal_id?: string | null;
  quote?: string | null;
  label?: string | null;
}

/**
 * Every row with EVERY column set: PostgREST inserts a batch with the union of
 * the rows' keys and fills a key one row lacks with NULL — which broke the NOT
 * NULL `applied` column when an applied row and a kept row went in together
 * (live test, 2026-10-04). PURE.
 */
export function normalizeChangeRows(rows: ChangeRow[]): Array<Required<ChangeRow>> {
  return rows.map((r) => ({
    client_id: r.client_id, kind: r.kind, field: r.field ?? null,
    before_value: r.before_value ?? null, after_value: r.after_value ?? null, added: r.added ?? null,
    applied: r.applied ?? true, note: r.note ?? null, source: r.source, source_ref: r.source_ref ?? null,
    proposal_id: r.proposal_id ?? null, quote: r.quote ?? null, label: r.label ?? null,
  }));
}

/** Append change rows. A failure throws (the trail is what makes auto-save safe to undo). */
export async function logAiChanges(sb: SupabaseClient, rows: ChangeRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await sb.from('client_ai_changes').insert(normalizeChangeRows(rows));
  if (error) throw new Error(`client_ai_changes insert failed: ${error.message}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Preferences
// ────────────────────────────────────────────────────────────────────────────

export interface AutoSavePrefsResult {
  status: 'saved' | 'nothing' | 'skipped';
  written: string[];
  keptRepValue: string[];
  unverified: string[];
  reason?: string;
}

/**
 * Save ONE pending preference proposal onto its client, as the AI. `conversation`
 * = the chat it was read from (quotes are checked against the customer's turns);
 * null for a call proposal (the call audit already checked them).
 */
export async function autoSavePrefs(
  sb: SupabaseClient,
  a: { proposalId: string; conversation: Conversation | null; source: ChangeSource; sourceRef: string | null; log?: (m: string) => void },
): Promise<AutoSavePrefsResult> {
  const log = a.log ?? ((m: string) => console.log(m));
  const { data: p, error: pErr } = await sb.from('client_pref_proposals')
    .select('id, client_id, status, suggestions, source').eq('id', a.proposalId).maybeSingle();
  if (pErr) throw new Error(`proposal read failed: ${pErr.message}`);
  const prop = p as { id: string; client_id: string; status: string; suggestions: Record<string, PrefSuggestionLike> | null; source: string | null } | null;
  if (!prop || prop.status !== 'pending') return { status: 'skipped', written: [], keptRepValue: [], unverified: [], reason: prop ? `already ${prop.status}` : 'not found' };

  const suggestions = prop.suggestions ?? {};
  const fields: string[] = [];
  const unverified: string[] = [];
  for (const [slug, s] of Object.entries(suggestions)) {
    if (!isPrefSlug(slug) || !s) continue;
    if (a.conversation && !customerSaidIt(a.conversation, s.quote)) { unverified.push(slug); continue; }
    fields.push(slug);
  }

  // Claim the proposal first (pending → saved), so two readers can never both
  // apply it; a failed write below puts it back to pending.
  const { data: claimed, error: cErr } = await sb.from('client_pref_proposals')
    .update({ status: 'saved', decided_by: null, decided_at: new Date().toISOString() })
    .eq('id', prop.id).eq('status', 'pending').select('id');
  if (cErr) throw new Error(`proposal claim failed: ${cErr.message}`);
  if (!claimed || claimed.length === 0) return { status: 'skipped', written: [], keptRepValue: [], unverified, reason: 'claimed by someone else' };

  // Before the client write, a failure puts the proposal back to pending (the
  // rep still sees it). AFTER the write the client already changed: the
  // proposal stays saved and the failure is thrown (never swallowed).
  let wroteClient = false;
  try {
    const { data: schemaRow, error: sErr } = await sb.from('models').select('schema').eq('name', 'clients').maybeSingle();
    if (sErr || !schemaRow) throw new Error(`clients schema read failed: ${sErr?.message ?? 'not found'}`);
    const options = prefOptionsFromSchema(schemaRow.schema);

    // The range values the AI wrote last (not undone) — a field still holding
    // one of these is the AI's, so a newer customer statement may replace it.
    const lastAi = new Map<string, unknown>();
    const rangeSlugs = fields.filter((f) => PREF_FIELD_KINDS[f] === 'range');
    if (rangeSlugs.length) {
      const { data: prev, error: hErr } = await sb.from('client_ai_changes')
        .select('field, after_value, created_at')
        .eq('client_id', prop.client_id).eq('kind', 'pref').eq('applied', true).is('undone_at', null)
        .in('field', rangeSlugs).order('created_at', { ascending: false });
      if (hErr) throw new Error(`client_ai_changes read failed: ${hErr.message}`);
      for (const r of (prev ?? []) as Array<{ field: string; after_value: unknown }>) if (!lastAi.has(r.field)) lastAi.set(r.field, r.after_value);
    }

    const isCall = prop.source === 'call';
    let before: Record<string, unknown> = {};
    let patch: Record<string, unknown> = {};
    let added: Record<string, string[]> = {};
    let kept: Array<{ slug: string; current: unknown; heard: unknown }> = [];
    let dropped: Array<{ slug: string; value: string }> = [];
    if (fields.length) {
      await recordSaveWithRetry(sb, {
        recordId: prop.client_id,
        build: (fresh) => {
          before = Object.fromEntries(fields.map((f) => [f, fresh[f] ?? null]));
          if (isCall) {
            const r = buildFillEmptyPatch(fresh, suggestions, fields, options);
            patch = r.patch; dropped = r.dropped; kept = []; added = {};
            for (const [slug, v] of Object.entries(r.patch)) if (PREF_FIELD_KINDS[slug] === 'set') added[slug] = v as string[];
          } else {
            const owned = new Set([...lastAi].filter(([f, v]) => valueEqual(asRangeValue(fresh[f]), asRangeValue(v))).map(([f]) => f));
            const r = buildAiPrefPatch(fresh, suggestions, fields, options, owned);
            patch = r.patch; dropped = r.dropped; kept = r.keptRepValue; added = r.added;
          }
          return Object.keys(patch).length ? { ...fresh, ...patch } : null;
        },
      });
    }
    for (const d of dropped) console.error(`[auto-save] proposal=${prop.id} dropped '${d.value}' for ${d.slug} — not an option of the live clients schema`);
    wroteClient = true;

    const written = Object.keys(patch);
    const { error: mErr } = await sb.from('client_pref_proposals')
      .update({ saved_fields: written, after_values: patch }).eq('id', prop.id);
    if (mErr) console.error(`[auto-save] proposal=${prop.id} saved but its saved_fields update failed: ${mErr.message}`);

    await logAiChanges(sb, [
      ...written.map((slug) => ({
        client_id: prop.client_id, kind: 'pref' as const, field: slug, before_value: before[slug] ?? null, after_value: patch[slug],
        added: added[slug] ?? null, source: a.source, source_ref: a.sourceRef, proposal_id: prop.id, quote: suggestions[slug]?.quote ?? null,
      })),
      ...kept.map((k) => ({
        client_id: prop.client_id, kind: 'pref' as const, field: k.slug, before_value: k.current, after_value: k.heard, applied: false,
        note: 'kept_rep_value', source: a.source, source_ref: a.sourceRef, proposal_id: prop.id, quote: suggestions[k.slug]?.quote ?? null,
      })),
    ]);
    log(`[auto-save] prefs proposal=${prop.id} client=${prop.client_id} wrote=${written.join(',') || '-'} kept_rep=${kept.map((k) => k.slug).join(',') || '-'} unverified=${unverified.join(',') || '-'}`);
    return { status: written.length ? 'saved' : 'nothing', written, keptRepValue: kept.map((k) => k.slug), unverified };
  } catch (err) {
    if (wroteClient) {
      console.error(`[auto-save] proposal=${prop.id} client=${prop.client_id} was WRITTEN but a later step failed — the proposal stays saved:`, err instanceof Error ? err.message : String(err));
      throw err;
    }
    // Put the proposal back so the rep still sees it; the error propagates.
    const { error: rErr } = await sb.from('client_pref_proposals')
      .update({ status: 'pending', decided_by: null, decided_at: null }).eq('id', prop.id).eq('status', 'saved');
    if (rErr) console.error(`[auto-save] proposal=${prop.id} could not be put back to pending: ${rErr.message}`);
    throw err;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Places
// ────────────────────────────────────────────────────────────────────────────

/** Can this placement be saved? The card's own rule (placementSavable in src/pages/GeoGrade/lib/placementLine.ts). */
export function placementIsSavable(p: Placement): boolean {
  if (!p.resolved) return false;
  if (p.operation === 'district_side_clip') return p.clip_state === 'ok';
  if (p.operation === 'directional_band') return !!p.side;
  return true;
}

/** PURE — which mentions the AI may save: savable AND not doubted by the checker. */
export function pickSavablePlaces(
  expression: GeoPreference,
  verifier: { status?: string; mentions?: Array<{ evidence_id: string; verdict: string; reason?: string }> } | null,
): { keep: string[]; drop: Array<{ evidenceId: string; label: string; why: 'unsavable' | 'doubted'; reason?: string }> } {
  const byEv = placementsByEvidence(expression);
  const doubts = new Map((verifier?.status === 'ok' ? verifier.mentions ?? [] : [])
    .filter((m) => m.verdict !== 'right').map((m) => [m.evidence_id, m]));
  const keep: string[] = [];
  const drop: Array<{ evidenceId: string; label: string; why: 'unsavable' | 'doubted'; reason?: string }> = [];
  for (const [id, p] of Object.entries(byEv)) {
    if (!placementIsSavable(p)) { drop.push({ evidenceId: id, label: p.label, why: 'unsavable' }); continue; }
    const d = doubts.get(id);
    if (d) { drop.push({ evidenceId: id, label: p.label, why: 'doubted', reason: d.reason }); continue; }
    keep.push(id);
  }
  return { keep, drop };
}

const itemLabel = (it: LocationItem): string => {
  const o = it as LocationItem & { district_label?: string; element_label?: string; label?: string };
  return o.district_label || o.label || o.element_label || '';
};

export interface AutoSavePlacesResult {
  status: 'saved' | 'nothing' | 'skipped';
  added: number;
  doubted: number;
  reason?: string;
}

/** Save ONE pending places proposal onto its client, as the AI. */
export async function autoSavePlaces(
  sb: SupabaseClient,
  a: { proposalId: string; source: ChangeSource; sourceRef: string | null; log?: (m: string) => void },
): Promise<AutoSavePlacesResult> {
  const log = a.log ?? ((m: string) => console.log(m));
  const { data: p, error: pErr } = await sb.from('geo_pref_proposals')
    .select('id, client_id, status, proposed_action, proposed_expression, final_expression, reviewer_note, version, verifier')
    .eq('id', a.proposalId).maybeSingle();
  if (pErr) throw new Error(`geo proposal read failed: ${pErr.message}`);
  const prop = p as (ProposalRow & { verifier: Parameters<typeof pickSavablePlaces>[1] }) | null;
  if (!prop || (prop.status !== 'pending' && prop.status !== 'must_confirm')) {
    return { status: 'skipped', added: 0, doubted: 0, reason: prop ? `already ${prop.status}` : 'not found' };
  }
  const expression = (prop.final_expression ?? prop.proposed_expression) as GeoPreference;
  const { keep, drop } = pickSavablePlaces(expression, prop.verifier);
  const doubtedRows = drop.filter((d) => d.why === 'doubted');
  if (keep.length === 0) {
    // Nothing safe to save: the proposal stays for the rep; the doubts are logged once.
    await logAiChanges(sb, doubtedRows.map((d) => ({
      client_id: prop.client_id, kind: 'place' as const, applied: false, note: 'doubted', label: d.label,
      quote: d.reason ?? null, source: a.source, source_ref: a.sourceRef, proposal_id: prop.id,
    })));
    log(`[auto-save] places proposal=${prop.id} nothing safe to save (${drop.length} unsavable/doubted) — left for the rep`);
    return { status: 'nothing', added: 0, doubted: doubtedRows.length };
  }
  const pruned = drop.length ? pruneGeoExpression(expression, drop.map((d) => d.evidenceId)) : expression;
  const items = geoPreferenceToLocationItems(pruned).filter((li) => li.kind !== 'district' || isUuid(String(li.district_id ?? '')));
  if (items.length === 0) {
    log(`[auto-save] places proposal=${prop.id} kept mentions produced no saveable items — left for the rep`);
    return { status: 'nothing', added: 0, doubted: doubtedRows.length };
  }

  let addedItems: LocationItem[] = [];
  const deps: ReviewDeps = {
    getProposal: async () => prop,
    async isCallAuditProposal(id) {
      const { data, error } = await sb.from('call_pref_audit').select('call_id').eq('geo_proposal_id', id).limit(1);
      if (error) throw new ReviewError(500, `call audit lookup failed: ${error.message}`);
      return (data ?? []).length > 0;
    },
    async applyToClient(clientId, its, opts) {
      let before: LocationItem[] = [];
      let after: LocationItem[] = [];
      await recordSaveWithRetry(sb, {
        recordId: clientId,
        build: (fresh) => {
          before = parseLocationItems(fresh.location_items);
          const next = buildGeoApplyData(fresh, its, opts);
          after = mergeLocationItems(before, its);
          addedItems = after.slice(before.length);
          return addedItems.length ? next : null;
        },
      });
      return { before, after };
    },
    async updateProposal(id, patch, expectedStatus) {
      const { data, error } = await sb.from('geo_pref_proposals').update(patch).eq('id', id).eq('status', expectedStatus).select('id').maybeSingle();
      if (error) throw new ReviewError(500, `proposal update failed: ${error.message}`);
      if (!data) throw new ReviewError(409, 'proposal was resolved by someone else');
    },
    async insertAudit(row) {
      const { error } = await sb.from('geo_pref_review_audit').insert({
        proposal_id: row.proposal_id, reviewer: null, action: row.action,
        before_state: { status: row.status_before, expression: row.expression_before, location_items: row.location_items_before },
        after_state: { status: row.status_after, expression: row.expression_after, location_items: row.location_items_after, applied: row.applied, note: row.note },
        at: row.created_at,
      });
      if (error) throw new ReviewError(500, `audit write failed: ${error.message}`);
    },
    now: () => new Date().toISOString(),
  };

  try {
    await applyReview(deps, {
      proposalId: prop.id,
      action: drop.length ? 'edit' : 'confirm',
      reviewerId: null, // the AI — reviewed_by stays NULL
      note: 'saved automatically by the AI',
      finalExpression: drop.length ? pruned : null,
    });
  } catch (err) {
    if (err instanceof ReviewError && err.message === CLIENT_HAS_PLACES) {
      // A call proposal for a client who already has places: never added to.
      await applyReview(deps, { proposalId: prop.id, action: 'reject', reviewerId: null, note: 'client already has places (call audit is fill-empty-only)' });
      log(`[auto-save] places proposal=${prop.id} skipped — client already has places`);
      return { status: 'skipped', added: 0, doubted: doubtedRows.length, reason: 'client_has_places' };
    }
    throw err;
  }

  await logAiChanges(sb, [
    ...addedItems.map((it) => ({
      client_id: prop.client_id, kind: 'place' as const, field: 'location_items', added: [it], label: itemLabel(it),
      source: a.source, source_ref: a.sourceRef, proposal_id: prop.id,
    })),
    ...doubtedRows.map((d) => ({
      client_id: prop.client_id, kind: 'place' as const, applied: false, note: 'doubted', label: d.label,
      quote: d.reason ?? null, source: a.source, source_ref: a.sourceRef, proposal_id: prop.id,
    })),
  ]);
  log(`[auto-save] places proposal=${prop.id} client=${prop.client_id} added=${addedItems.length} doubted=${doubtedRows.length}`);
  return { status: addedItems.length ? 'saved' : 'nothing', added: addedItems.length, doubted: doubtedRows.length };
}

// ────────────────────────────────────────────────────────────────────────────
// Undo + list
// ────────────────────────────────────────────────────────────────────────────

export interface AiChangeRow {
  id: string; client_id: string; kind: 'pref' | 'place' | 'outcome'; field: string | null;
  before_value: unknown; after_value: unknown; added: unknown; applied: boolean; note: string | null;
  source: ChangeSource; source_ref: string | null; proposal_id: string | null; quote: string | null; label: string | null;
  created_at: string; undone_at: string | null; undone_by: string | null;
}

export class UndoError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** The newest AI changes on a client (any status). */
export async function listAiChanges(sb: SupabaseClient, clientId: string, limit = 30): Promise<AiChangeRow[]> {
  const { data, error } = await sb.from('client_ai_changes').select('*')
    .eq('client_id', clientId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(`client_ai_changes read failed: ${error.message}`);
  return (data ?? []) as AiChangeRow[];
}

/**
 * Undo ONE applied AI change on the FRESH client row: a preference set loses the
 * values the AI added, a range goes back to what it was (only if it still holds
 * the AI's value), places the AI added are removed. 409 when the field has moved
 * on since (a rep edited it) — nothing is written then.
 */
export async function undoAiChange(sb: SupabaseClient, changeId: string, userId: string | null): Promise<{ undone: true }> {
  const { data, error } = await sb.from('client_ai_changes').select('*').eq('id', changeId).maybeSingle();
  if (error) throw new UndoError(500, `change read failed: ${error.message}`);
  const c = data as AiChangeRow | null;
  if (!c) throw new UndoError(404, 'change not found');
  if (!c.applied) throw new UndoError(400, 'this change was not applied — nothing to undo');
  if (c.undone_at) throw new UndoError(409, 'already undone');
  if (c.kind === 'outcome') throw new UndoError(400, 'a recorded follow-up result is undone from the follow-up itself');

  let moved = false;
  await recordSaveWithRetry(sb, {
    recordId: c.client_id,
    build: (fresh) => {
      moved = false;
      if (c.kind === 'pref' && c.field) {
        const r = undoPrefValue(c.field, fresh[c.field], { before: c.before_value, after: c.after_value, added: c.added });
        if (!r) { moved = true; return null; }
        return { ...fresh, [c.field]: r.value };
      }
      const remove = new Set((Array.isArray(c.added) ? (c.added as LocationItem[]) : []).map(locationItemSignature));
      const cur = parseLocationItems(fresh.location_items);
      const kept = cur.filter((it) => !remove.has(locationItemSignature(it)));
      if (kept.length === cur.length) { moved = true; return null; }
      return { ...fresh, location_items: kept };
    },
  });
  if (moved) throw new UndoError(409, 'the value changed since the AI saved it — nothing to undo');
  const { error: uErr } = await sb.from('client_ai_changes')
    .update({ undone_at: new Date().toISOString(), undone_by: userId }).eq('id', c.id).is('undone_at', null);
  if (uErr) throw new UndoError(500, `undo recorded on the client but not on the change: ${uErr.message}`);
  return { undone: true };
}
