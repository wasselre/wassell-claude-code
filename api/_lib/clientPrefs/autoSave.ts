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
  PREF_FIELD_KINDS, isPrefSlug, buildAiPrefPatch, buildFillEmptyPatch, asRangeValue, asSetValue, valueEqual, undoPrefValue,
  type PrefSuggestionLike,
} from '../../../src/lib/clientPrefs/mergePrefs.js';
import { parseLocationItems, type LocationItem } from '../../../src/lib/geo/locationItems.js';
import {
  applyReview, geoPreferenceToLocationItems, locationItemSignature, mergeLocationItems, buildGeoApplyData,
  ReviewError, CLIENT_HAS_PLACES, type ReviewDeps, type ProposalRow,
} from '../../geo-preference/review.js';
import { prefOptionsFromSchema } from '../../client-prefs/review.js';
import { locationItemPlaceKey } from '../../geo-preference/review.js';
import {
  readStoredProfiles, resolveTarget, profileValues, writeProfileValues, addAiProfile, removeAiProfile, DEFAULT_PROFILE_ID,
} from './profileTarget.js';
import { routeWish, SLUG_OF_FIELD, type Heard, type WishField, type WishRoute } from './wishRouter.js';

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

/**
 * Where a save goes (wishRouter.ts): a profile (null = the active one) and, for
 * a change of mind, the fields whose earlier AI values are replaced.
 */
export interface SaveTarget {
  profileId: string | null;
  replace?: WishField[];
  /**
   * A second wish got its own new profile. The whole-chat proposals mix the two
   * wishes, so each value goes by WHERE the customer said it: quoted in the new
   * messages → the new profile; quoted earlier → `profileId` (the first wish).
   */
  split?: { profileId: string; newTexts: string[] };
}

/** The customer's new messages as a conversation, for the quote check. PURE. */
function newConversation(newTexts: readonly string[]): Conversation {
  return { channel: 'chat', id: 'new-messages', turns: newTexts.map((text) => ({ speaker: 'client' as const, text })) };
}

interface ChangeRow {
  client_id: string;
  kind: 'pref' | 'place' | 'outcome' | 'profile';
  /** The profile written (null = the active one, for a client without profiles). */
  profile_id?: string | null;
  profile_name?: string | null;
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
    profile_id: r.profile_id ?? null, profile_name: r.profile_name ?? null,
  }));
}

/**
 * Does an earlier change row belong to the profile being written? A row with
 * no profile_id was written while the client had one profile — the main one
 * (`default`), even if another profile is active now. PURE.
 */
export function rowInProfile(rowProfileId: string | null, target: string | null, activeId: string): boolean {
  return (rowProfileId ?? DEFAULT_PROFILE_ID) === (target ?? activeId);
}

/** The name to record for a non-active target profile (null for the active one). PURE. */
function targetProfileName(data: Record<string, unknown>, target: string | null): string | null {
  return target ? readStoredProfiles(data).profiles.find((p) => p.id === target)?.name ?? null : null;
}

/** The profile id to record on a change row: the target, else the active id once profiles exist. PURE. */
function recordedProfileId(data: Record<string, unknown>, target: string | null): string | null {
  if (target) return target;
  const { activeId, materialized } = readStoredProfiles(data);
  return materialized ? activeId : null;
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
  a: { proposalId: string; conversation: Conversation | null; source: ChangeSource; sourceRef: string | null; target?: SaveTarget; log?: (m: string) => void },
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

    // The AI's own earlier writes (not undone): the range values it wrote last
    // (a field still holding one is the AI's, so a newer statement may replace
    // it) and, for a change of mind, the set values it added.
    const replaceSlugs = new Set((a.target?.replace ?? []).filter((f): f is Exclude<WishField, 'location'> => f !== 'location').map((f) => SLUG_OF_FIELD[f]));
    const historySlugs = fields.filter((f) => PREF_FIELD_KINDS[f] === 'range' || replaceSlugs.has(f));
    let history: Array<{ field: string; after_value: unknown; added: unknown; profile_id: string | null }> = [];
    if (historySlugs.length) {
      const { data: prev, error: hErr } = await sb.from('client_ai_changes')
        .select('field, after_value, added, profile_id, created_at')
        .eq('client_id', prop.client_id).eq('kind', 'pref').eq('applied', true).is('undone_at', null)
        .in('field', historySlugs).order('created_at', { ascending: false });
      if (hErr) throw new Error(`client_ai_changes read failed: ${hErr.message}`);
      history = (prev ?? []) as typeof history;
    }

    const isCall = prop.source === 'call';
    // One part per profile written (two only for a second wish — see SaveTarget.split).
    const split = a.target?.split;
    const splitConv = split ? newConversation(split.newTexts) : null;
    const newFields = splitConv ? fields.filter((f) => customerSaidIt(splitConv, suggestions[f]?.quote ?? null)) : [];
    const partSpecs: Array<{ profileId: string | null; fields: string[]; replace: boolean }> = [
      { profileId: a.target?.profileId ?? null, fields: fields.filter((f) => !newFields.includes(f)), replace: true },
      ...(split ? [{ profileId: split.profileId, fields: newFields, replace: false }] : []),
    ].filter((ps) => ps.fields.length > 0);
    interface PartResult {
      profileId: string | null; profileName: string | null; before: Record<string, unknown>; patch: Record<string, unknown>;
      added: Record<string, string[]>; kept: Array<{ slug: string; current: unknown; heard: unknown }>; replaced: string[];
    }
    let parts: PartResult[] = [];
    let dropped: Array<{ slug: string; value: string }> = [];
    if (partSpecs.length) {
      await recordSaveWithRetry(sb, {
        recordId: prop.client_id,
        build: (fresh) => {
          parts = []; dropped = [];
          const { activeId } = readStoredProfiles(fresh);
          let data = fresh;
          for (const ps of partSpecs) {
            const target = resolveTarget(fresh, ps.profileId);
            if (ps.profileId && !target) console.error(`[auto-save] proposal=${prop.id} target profile ${ps.profileId} is gone or active — writing the active profile`);
            const values = profileValues(data, target);
            const part: PartResult = {
              profileId: recordedProfileId(fresh, target), profileName: targetProfileName(fresh, target),
              before: Object.fromEntries(ps.fields.map((f) => [f, values[f] ?? null])), patch: {}, added: {}, kept: [], replaced: [],
            };
            if (isCall) {
              const r = buildFillEmptyPatch(values, suggestions, ps.fields, options);
              part.patch = r.patch; dropped.push(...r.dropped);
              for (const [slug, v] of Object.entries(r.patch)) if (PREF_FIELD_KINDS[slug] === 'set') part.added[slug] = v as string[];
            } else {
              const mine = history.filter((h) => rowInProfile(h.profile_id, target, activeId));
              const lastAi = new Map<string, unknown>();
              const aiAdded: Record<string, string[]> = {};
              for (const h of mine) {
                if (PREF_FIELD_KINDS[h.field] === 'range' && !lastAi.has(h.field)) lastAi.set(h.field, h.after_value);
                if (PREF_FIELD_KINDS[h.field] === 'set') aiAdded[h.field] = [...(aiAdded[h.field] ?? []), ...asSetValue(h.added)];
              }
              const owned = new Set([...lastAi].filter(([f, v]) => valueEqual(asRangeValue(values[f]), asRangeValue(v))).map(([f]) => f));
              const r = buildAiPrefPatch(values, suggestions, ps.fields, options, owned, ps.replace && replaceSlugs.size ? { slugs: replaceSlugs, aiAdded } : undefined);
              part.patch = r.patch; part.added = r.added; part.kept = r.keptRepValue; part.replaced = r.replaced; dropped.push(...r.dropped);
            }
            if (Object.keys(part.patch).length) data = writeProfileValues(data, target, part.patch);
            parts.push(part);
          }
          return parts.some((pt) => Object.keys(pt.patch).length) ? data : null;
        },
      });
    }
    for (const d of dropped) console.error(`[auto-save] proposal=${prop.id} dropped '${d.value}' for ${d.slug} — not an option of the live clients schema`);
    wroteClient = true;

    const written = parts.flatMap((pt) => Object.keys(pt.patch));
    const kept = parts.flatMap((pt) => pt.kept);
    const { error: mErr } = await sb.from('client_pref_proposals')
      .update({ saved_fields: written, after_values: Object.assign({}, ...parts.map((pt) => pt.patch)) }).eq('id', prop.id);
    if (mErr) console.error(`[auto-save] proposal=${prop.id} saved but its saved_fields update failed: ${mErr.message}`);

    await logAiChanges(sb, parts.flatMap((pt) => [
      ...Object.keys(pt.patch).map((slug) => ({
        client_id: prop.client_id, kind: 'pref' as const, field: slug, before_value: pt.before[slug] ?? null, after_value: pt.patch[slug],
        added: pt.added[slug] ?? null, source: a.source, source_ref: a.sourceRef, proposal_id: prop.id, quote: suggestions[slug]?.quote ?? null,
        note: pt.replaced.includes(slug) ? 'replaced' : null, profile_id: pt.profileId, profile_name: pt.profileName,
      })),
      ...pt.kept.map((k) => ({
        client_id: prop.client_id, kind: 'pref' as const, field: k.slug, before_value: k.current, after_value: k.heard, applied: false,
        note: 'kept_rep_value', source: a.source, source_ref: a.sourceRef, proposal_id: prop.id, quote: suggestions[k.slug]?.quote ?? null,
        profile_id: pt.profileId, profile_name: pt.profileName,
      })),
    ]));
    log(`[auto-save] prefs proposal=${prop.id} client=${prop.client_id} wrote=${written.join(',') || '-'}${split ? ` (new profile: ${newFields.join(',') || '-'})` : ''} kept_rep=${kept.map((k) => k.slug).join(',') || '-'} unverified=${unverified.join(',') || '-'}`);
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

/**
 * PURE — the items one save ADDED, grouped by the mention that produced them,
 * so the trail (and Undo) is one line per thing the customer said: «شمال
 * الرياض» is ONE line holding its 37 districts, not 37 lines (the backfill
 * logged 1,088 rows for 45 proposals before this, 2026-10-04). Items no mention
 * claims (should not happen) form one last group.
 */
export function groupAddedByMention(
  expression: GeoPreference, keptEvidenceIds: string[], added: LocationItem[],
): Array<{ label: string; items: LocationItem[] }> {
  const remaining = new Map(added.map((it) => [locationItemSignature(it), it]));
  const placements = placementsByEvidence(expression);
  const out: Array<{ label: string; items: LocationItem[] }> = [];
  for (const id of keptEvidenceIds) {
    const own = geoPreferenceToLocationItems(pruneGeoExpression(expression, keptEvidenceIds.filter((x) => x !== id)));
    const items: LocationItem[] = [];
    for (const it of own) {
      const sig = locationItemSignature(it);
      const hit = remaining.get(sig);
      if (hit) { items.push(hit); remaining.delete(sig); }
    }
    if (items.length) out.push({ label: placements[id]?.label || items.map(itemLabel).filter(Boolean).slice(0, 3).join('، '), items });
  }
  if (remaining.size) out.push({ label: [...remaining.values()].map(itemLabel).filter(Boolean).slice(0, 3).join('، '), items: [...remaining.values()] });
  return out;
}

export interface AutoSavePlacesResult {
  status: 'saved' | 'nothing' | 'skipped';
  added: number;
  doubted: number;
  reason?: string;
}

/**
 * The doubted places worth logging: one record per client and place. Each chat
 * read re-proposes what it heard, so without this a place the verifier doubts
 * is logged again on EVERY read — measured 2026-10-06: «الملقا» 17 times for
 * one client. The doubt was never saved to the client; the repeats only buried
 * the AI's real changes in the history and the review cards.
 */
export function dropKnownDoubts<T extends { label: string | null }>(rows: readonly T[], known: ReadonlySet<string>): T[] {
  const seen = new Set(known);
  return rows.filter((r) => {
    const k = (r.label ?? '').trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function newDoubts<T extends { label: string | null }>(sb: SupabaseClient, clientId: string, rows: readonly T[]): Promise<T[]> {
  const labels = [...new Set(rows.map((r) => (r.label ?? '').trim()).filter(Boolean))];
  if (!labels.length) return [];
  const { data, error } = await sb.from('client_ai_changes').select('label')
    .eq('client_id', clientId).eq('kind', 'place').eq('applied', false).eq('note', 'doubted').in('label', labels);
  if (error) throw new Error(`client_ai_changes read failed: ${error.message}`);
  return dropKnownDoubts(rows, new Set(((data ?? []) as { label: string | null }[]).map((r) => (r.label ?? '').trim())));
}

/** Save ONE pending places proposal onto its client, as the AI. */
export async function autoSavePlaces(
  sb: SupabaseClient,
  a: { proposalId: string; source: ChangeSource; sourceRef: string | null; target?: SaveTarget; log?: (m: string) => void },
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
  // Only doubts not already on record for this client (once per place, not per read).
  const freshDoubted = await newDoubts(sb, prop.client_id, doubtedRows);
  if (keep.length === 0) {
    // Nothing safe to save: the proposal stays for the rep; the doubts are logged once.
    await logAiChanges(sb, freshDoubted.map((d) => ({
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

  // A change of mind about the places: the ones the AI added earlier (not undone) go.
  let aiPlaceHistory: Array<{ added: unknown; profile_id: string | null }> = [];
  if (a.target?.replace?.includes('location')) {
    const { data: prev, error: hErr } = await sb.from('client_ai_changes')
      .select('added, profile_id').eq('client_id', prop.client_id).eq('kind', 'place').eq('applied', true).is('undone_at', null);
    if (hErr) throw new Error(`client_ai_changes read failed: ${hErr.message}`);
    aiPlaceHistory = (prev ?? []) as typeof aiPlaceHistory;
  }

  // A second wish: the places the customer named in the NEW messages go to its
  // profile; the rest stay with the first wish.
  const split = a.target?.split;
  const splitConv = split ? newConversation(split.newTexts) : null;
  const newEvidence = splitConv
    ? keep.filter((id) => (placementsByEvidence(pruned)[id]?.label ?? '').split(' / ').some((span) => span.trim() && customerSaidIt(splitConv, span)))
    : [];
  const newSigs = new Set(newEvidence.length
    ? geoPreferenceToLocationItems(pruneGeoExpression(pruned, keep.filter((id) => !newEvidence.includes(id)))).map(locationItemSignature)
    : []);
  let splitAdded: LocationItem[] = [];

  let addedItems: LocationItem[] = [];
  let removedItems: LocationItem[] = [];
  let profileId: string | null = null;
  let profileName: string | null = null;
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
          const target = resolveTarget(fresh, a.target?.profileId);
          const { activeId } = readStoredProfiles(fresh);
          profileId = recordedProfileId(fresh, target);
          profileName = targetProfileName(fresh, target);
          // Places for the second wish's profile, written first (the main merge below never sees them).
          let base0 = fresh;
          splitAdded = [];
          const forSplit = split ? its.filter((it) => newSigs.has(locationItemSignature(it))) : [];
          if (split && forSplit.length) {
            const splitTarget = resolveTarget(fresh, split.profileId);
            if (splitTarget) {
              const cur = parseLocationItems(profileValues(fresh, splitTarget).location_items);
              const merged = mergeLocationItems(cur, forSplit);
              const curSigs = new Set(cur.map(locationItemSignature));
              splitAdded = merged.filter((it) => !curSigs.has(locationItemSignature(it)));
              base0 = writeProfileValues(fresh, splitTarget, { location_items: merged });
            } else {
              console.error(`[auto-save] places proposal=${prop.id} second-wish profile ${split.profileId} is gone or active — its places stay with the first wish`);
            }
          }
          if (split && splitAdded.length) its = its.filter((it) => !newSigs.has(locationItemSignature(it)));
          before = parseLocationItems(profileValues(base0, target).location_items);
          if (opts.onlyIfNoPlaces) buildGeoApplyData({ location_items: before }, its, opts); // throws CLIENT_HAS_PLACES
          const aiSigs = new Set(aiPlaceHistory
            .filter((h) => rowInProfile(h.profile_id, target, activeId))
            .flatMap((h) => (Array.isArray(h.added) ? (h.added as LocationItem[]) : []).map(locationItemSignature)));
          const base = aiSigs.size ? before.filter((it) => !aiSigs.has(locationItemSignature(it))) : before;
          after = mergeLocationItems(base, its);
          const beforeSigs = new Set(before.map(locationItemSignature));
          const afterSigs = new Set(after.map(locationItemSignature));
          addedItems = after.filter((it) => !beforeSigs.has(locationItemSignature(it)));
          removedItems = before.filter((it) => !afterSigs.has(locationItemSignature(it)));
          if (!addedItems.length && !removedItems.length) return splitAdded.length ? base0 : null;
          return writeProfileValues(base0, target, { location_items: after });
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

  // Places that left: replaced by a change of mind, or the opposite of what was
  // just said (wanted ↔ excluded). One row; Undo puts them back.
  const flipped = new Set(addedItems.map(locationItemPlaceKey));
  const removedRows = removedItems.length ? [{
    client_id: prop.client_id, kind: 'place' as const, field: 'location_items', before_value: removedItems,
    note: removedItems.every((it) => flipped.has(locationItemPlaceKey(it))) ? 'flipped' : 'replaced',
    label: [...new Set(removedItems.map(itemLabel).filter(Boolean))].slice(0, 3).join('، '),
    source: a.source, source_ref: a.sourceRef, proposal_id: prop.id, profile_id: profileId, profile_name: profileName,
  }] : [];
  const splitName = split && splitAdded.length ? (await readProfileName(sb, prop.client_id, split.profileId)) : null;
  await logAiChanges(sb, [
    ...(split && splitAdded.length ? groupAddedByMention(pruned, newEvidence, splitAdded).map((g) => ({
      client_id: prop.client_id, kind: 'place' as const, field: 'location_items', added: g.items, label: g.label,
      source: a.source, source_ref: a.sourceRef, proposal_id: prop.id, profile_id: split.profileId, profile_name: splitName,
    })) : []),
    ...groupAddedByMention(pruned, keep.filter((id) => !(splitAdded.length && newEvidence.includes(id))), addedItems).map((g) => ({
      client_id: prop.client_id, kind: 'place' as const, field: 'location_items', added: g.items, label: g.label,
      source: a.source, source_ref: a.sourceRef, proposal_id: prop.id, profile_id: profileId, profile_name: profileName,
    })),
    ...removedRows,
    ...freshDoubted.map((d) => ({
      client_id: prop.client_id, kind: 'place' as const, applied: false, note: 'doubted', label: d.label,
      quote: d.reason ?? null, source: a.source, source_ref: a.sourceRef, proposal_id: prop.id, profile_id: profileId, profile_name: profileName,
    })),
  ]);
  log(`[auto-save] places proposal=${prop.id} client=${prop.client_id} added=${addedItems.length}${split ? ` new-profile=${splitAdded.length}` : ''} removed=${removedItems.length} doubted=${doubtedRows.length}`);
  return { status: addedItems.length || removedItems.length || splitAdded.length ? 'saved' : 'nothing', added: addedItems.length + splitAdded.length, doubted: doubtedRows.length };
}

/** A profile's name, for the change trail. */
async function readProfileName(sb: SupabaseClient, clientId: string, profileId: string): Promise<string | null> {
  const { data, error } = await sb.from('records').select('data').eq('id', clientId).maybeSingle();
  if (error) throw new Error(`client read failed: ${error.message}`);
  const d = (data as { data: Record<string, unknown> } | null)?.data ?? {};
  return readStoredProfiles(d).profiles.find((p) => p.id === profileId)?.name ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// Profiles — routing a chat read's saves (wishRouter.ts)
// ────────────────────────────────────────────────────────────────────────────

/**
 * What one chat read would save — the SAME filters the two saves apply (the
 * customer-quote guard; savable, undoubted places) — for the router to look at.
 */
export async function heardFromProposals(
  sb: SupabaseClient, a: { prefProposalId: string | null; geoProposalId: string | null; conversation: Conversation; newTexts?: string[] },
): Promise<Heard> {
  const heard: Heard = { prefs: {}, places: [], newTexts: a.newTexts ?? [] };
  if (a.prefProposalId) {
    const { data, error } = await sb.from('client_pref_proposals').select('status, suggestions').eq('id', a.prefProposalId).maybeSingle();
    if (error) throw new Error(`proposal read failed: ${error.message}`);
    const row = data as { status: string; suggestions: Record<string, PrefSuggestionLike> | null } | null;
    if (row?.status === 'pending') {
      for (const [slug, sug] of Object.entries(row.suggestions ?? {})) {
        if (isPrefSlug(slug) && sug && customerSaidIt(a.conversation, sug.quote)) heard.prefs[slug] = { value: sug.value, quote: sug.quote };
      }
    }
  }
  if (a.geoProposalId) {
    const { data, error } = await sb.from('geo_pref_proposals').select('status, proposed_expression, final_expression, verifier').eq('id', a.geoProposalId).maybeSingle();
    if (error) throw new Error(`geo proposal read failed: ${error.message}`);
    const row = data as { status: string; proposed_expression: unknown; final_expression: unknown; verifier: Parameters<typeof pickSavablePlaces>[1] } | null;
    if (row && (row.status === 'pending' || row.status === 'must_confirm')) {
      const expression = (row.final_expression ?? row.proposed_expression) as GeoPreference;
      const { drop } = pickSavablePlaces(expression, row.verifier);
      const pruned = drop.length ? pruneGeoExpression(expression, drop.map((d) => d.evidenceId)) : expression;
      heard.places = geoPreferenceToLocationItems(pruned).filter((li) => li.kind !== 'district' || isUuid(String(li.district_id ?? '')));
    }
  }
  return heard;
}

/** Add the profile for a customer's separate second wish (never made active), logged with Undo. */
export async function createAiProfile(
  sb: SupabaseClient, a: { clientId: string; name: string; quote: string; source: ChangeSource; sourceRef: string | null },
): Promise<{ profileId: string; name: string }> {
  let created: { profileId: string; name: string } | null = null;
  await recordSaveWithRetry(sb, {
    recordId: a.clientId,
    build: (fresh) => {
      const r = addAiProfile(fresh, a.name, new Date().toISOString());
      const name = readStoredProfiles(r.data).profiles.find((p) => p.id === r.profileId)?.name ?? a.name;
      created = { profileId: r.profileId, name };
      return r.data;
    },
  });
  if (!created) throw new Error('profile was not created');
  const c = created as { profileId: string; name: string };
  await logAiChanges(sb, [{
    client_id: a.clientId, kind: 'profile', profile_id: c.profileId, profile_name: c.name, label: c.name,
    quote: a.quote, source: a.source, source_ref: a.sourceRef,
  }]);
  return c;
}

/** The route as save targets — a second wish becomes a new profile first. */
export async function targetForRoute(
  sb: SupabaseClient, route: WishRoute, a: { clientId: string; source: ChangeSource; sourceRef: string | null; newTexts?: string[]; log?: (m: string) => void },
): Promise<SaveTarget> {
  if (route.kind === 'same') return { profileId: route.profileId };
  if (route.kind === 'changed') return { profileId: route.profileId, replace: route.fields };
  const p = await createAiProfile(sb, { clientId: a.clientId, name: route.profileName, quote: route.quote, source: a.source, sourceRef: a.sourceRef });
  const written = await fillProfile(sb, { clientId: a.clientId, profileId: p.profileId, profileName: p.name, values: route.values, source: a.source, sourceRef: a.sourceRef });
  a.log?.(`[auto-save] client=${a.clientId} new profile «${p.name}» (${p.profileId}) for a second wish — filled ${written.join(',') || 'nothing'}`);
  return { profileId: null, split: { profileId: p.profileId, newTexts: a.newTexts ?? [] } };
}

/** Write a new profile's values (the second wish's, each quoted), logged per field with Undo. */
async function fillProfile(
  sb: SupabaseClient,
  a: { clientId: string; profileId: string; profileName: string; values: Record<string, { value: unknown; quote: string }>; source: ChangeSource; sourceRef: string | null },
): Promise<string[]> {
  const fields = Object.keys(a.values).filter(isPrefSlug);
  if (!fields.length) return [];
  const { data: schemaRow, error: sErr } = await sb.from('models').select('schema').eq('name', 'clients').maybeSingle();
  if (sErr || !schemaRow) throw new Error(`clients schema read failed: ${sErr?.message ?? 'not found'}`);
  const options = prefOptionsFromSchema(schemaRow.schema);
  const suggestions: Record<string, PrefSuggestionLike> = Object.fromEntries(fields.map((f) => [f, { slug: f, value: a.values[f]!.value, quote: a.values[f]!.quote, confidence: 80 }]));
  let patch: Record<string, unknown> = {};
  let added: Record<string, string[]> = {};
  await recordSaveWithRetry(sb, {
    recordId: a.clientId,
    build: (fresh) => {
      const target = resolveTarget(fresh, a.profileId);
      if (!target) throw new Error(`new profile ${a.profileId} is gone or active — not filled`);
      const r = buildAiPrefPatch(profileValues(fresh, target), suggestions, fields, options, new Set());
      for (const d of r.dropped) console.error(`[auto-save] new profile ${a.profileId} dropped '${d.value}' for ${d.slug} — not an option of the live clients schema`);
      patch = r.patch; added = r.added;
      return Object.keys(patch).length ? writeProfileValues(fresh, target, patch) : null;
    },
  });
  await logAiChanges(sb, Object.keys(patch).map((slug) => ({
    client_id: a.clientId, kind: 'pref' as const, field: slug, before_value: null, after_value: patch[slug], added: added[slug] ?? null,
    source: a.source, source_ref: a.sourceRef, quote: a.values[slug]?.quote ?? null, profile_id: a.profileId, profile_name: a.profileName,
  })));
  return Object.keys(patch);
}

/** Route a chat read's two proposals once, before either is saved. */
export async function routeChatRead(
  sb: SupabaseClient,
  a: { clientId: string; chatWid: string; conversation: Conversation; geoProposalId: string | null; prefProposalId: string | null; newTexts?: string[]; log?: (m: string) => void },
): Promise<SaveTarget> {
  const heard = await heardFromProposals(sb, a);
  const { data, error } = await sb.from('records').select('data').eq('id', a.clientId).maybeSingle();
  if (error) throw new Error(`client read failed: ${error.message}`);
  if (!data) throw new Error(`client ${a.clientId} not found`);
  const route = await routeWish({ clientId: a.clientId, data: (data as { data: Record<string, unknown> }).data ?? {}, conversation: a.conversation, heard, log: a.log });
  return targetForRoute(sb, route, { clientId: a.clientId, source: 'chat', sourceRef: a.chatWid, newTexts: a.newTexts, log: a.log });
}

// ────────────────────────────────────────────────────────────────────────────
// Undo + list
// ────────────────────────────────────────────────────────────────────────────

export interface AiChangeRow {
  id: string; client_id: string; kind: 'pref' | 'place' | 'outcome' | 'profile'; field: string | null;
  profile_id: string | null; profile_name: string | null;
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
      if (c.kind === 'profile') {
        const next = c.profile_id ? removeAiProfile(fresh, c.profile_id) : null;
        if (!next) { moved = true; return null; }
        return next;
      }
      // The profile the change was written to (none recorded = the main one, `default`).
      const target = resolveTarget(fresh, c.profile_id ?? DEFAULT_PROFILE_ID);
      const values = profileValues(fresh, target);
      if (c.kind === 'pref' && c.field) {
        const r = undoPrefValue(c.field, values[c.field], { before: c.before_value, after: c.after_value, added: c.added, replaced: c.note === 'replaced' });
        if (!r) { moved = true; return null; }
        return writeProfileValues(fresh, target, { [c.field]: r.value });
      }
      const remove = new Set((Array.isArray(c.added) ? (c.added as LocationItem[]) : []).map(locationItemSignature));
      const restore = Array.isArray(c.before_value) && (c.note === 'replaced' || c.note === 'flipped') ? (c.before_value as LocationItem[]) : [];
      const cur = parseLocationItems(values.location_items);
      const kept = cur.filter((it) => !remove.has(locationItemSignature(it)));
      // Putting a removed place back drops whatever now says the opposite about it.
      const back = restore.filter((it) => !kept.some((k) => locationItemSignature(k) === locationItemSignature(it)));
      const backKeys = new Set(back.map(locationItemPlaceKey));
      const next = [...kept.filter((k) => !backKeys.has(locationItemPlaceKey(k))), ...back];
      if (kept.length === cur.length && back.length === 0) { moved = true; return null; }
      return writeProfileValues(fresh, target, { location_items: next });
    },
  });
  if (moved) {
    throw new UndoError(409, c.kind === 'profile'
      ? 'this profile is active now, or a rep made it — switch to another profile first, or delete it from the Preferences tab'
      : 'the value changed since the AI saved it — nothing to undo');
  }
  const { error: uErr } = await sb.from('client_ai_changes')
    .update({ undone_at: new Date().toISOString(), undone_by: userId }).eq('id', c.id).is('undone_at', null);
  if (uErr) throw new UndoError(500, `undo recorded on the client but not on the change: ${uErr.message}`);
  return { undone: true };
}
