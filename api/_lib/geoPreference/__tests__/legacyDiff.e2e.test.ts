import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { gatherCallConversation, gatherChatConversation, makeSupabaseBackfillDeps } from '../backfillPorts.js';
import { evidenceForReview, rowToEvidence, rowToRelation } from '../chatCard.js';
import type { ProposalInput, ProposalRecord, ReviewFirstResult } from '../orchestrator.js';
import type { Conversation } from '../extractor.js';
import type { Evidence, EvidenceRelation, GeoPreference, ResolutionResult } from '../ontology.js';

/**
 * THE LEGACY DIFF (RUN_LEGACY_DIFF=1) — design 2026-10-04 §6.8, the release
 * blocker of the geo fix.
 *
 * Re-reviews EVERY stored model evidence row (grouped by client + conversation,
 * exactly as the chat card's review-only rerun does: stored rows → the call
 * speaker guard → runReviewFirst with the conversation attached) and writes
 * what each mention would be drawn as to the JSON file named by
 * LEGACY_DIFF_OUT. Run it once here and once in a worktree of origin/main, then
 * compare the two files with the scratchpad comparator (legacy-compare.mjs):
 * a stored reading that resolved to one place before and a DIFFERENT place now
 * blocks the release.
 *
 * READ-ONLY, NO LLM: nothing is extracted, nothing is verified, the proposal
 * store is in memory (nothing is inserted), no evidence / checkpoint /
 * proposal / client row is written. The calls made are table reads and the
 * resolver's STABLE RPCs (plus, on the new code, wassell_geo_road_axis and
 * wassell_geo_names_in_text — also STABLE).
 *
 * BASELINE-SAFE: every import exists on origin/main (checked with
 * `git show origin/main:<file>` on 2026-10-04), so the SAME file runs in a
 * baseline worktree. The conversation is attached with Object.assign (main's
 * RunContext has no `conversation`; main ignores it), and the per-mention
 * reasons read `reviewed_evidence` only when the result carries it (main's
 * prepares nothing, so its resolutions follow the evidence it was given).
 *
 * Per evidence row the file holds: ids, `graded` (the evidence or its
 * checkpoint is a geo_pref_labels / calibration-batch subject), the customer's
 * words (`mention_span`) and the anchors as reviewed, every compiled ref of the
 * mention { part, op, ids (sorted), side, radius, polarity, stub } (a stub's ids
 * are its anchor names, so they are left out), the state (resolved / ask /
 * absent / error) and the non-resolved anchor reasons. `id_kinds` names every
 * resolved uuid (district / city / region record), so the comparator can tell a
 * dropped CITY record id (C2, allowed) from a changed place.
 *
 *   # new code (this worktree)
 *   RUN_LEGACY_DIFF=1 LEGACY_DIFF_OUT=<scratch>/legacy-new.json \
 *     node <vitest.mjs> run api/_lib/geoPreference/__tests__/legacyDiff.e2e.test.ts
 *   # baseline: a detached worktree of origin/main (NOT git stash). Put it where
 *   # node can find the packages (under the repo's .claude/worktrees, or run
 *   # `npm ci` in it), copy this file in, point it at the env file:
 *   git worktree add --detach <dir>/legacy-base origin/main
 *   cp api/_lib/geoPreference/__tests__/legacyDiff.e2e.test.ts <dir>/legacy-base/api/_lib/geoPreference/__tests__/
 *   (cd <dir>/legacy-base && RUN_LEGACY_DIFF=1 LEGACY_DIFF_OUT=<scratch>/legacy-base.json \
 *      LEGACY_DIFF_ENV_FILE=<this worktree>/.env.local node <vitest.mjs> run api/_lib/geoPreference/__tests__/legacyDiff.e2e.test.ts)
 *   node <scratch>/legacy-compare.mjs <scratch>/legacy-base.json <scratch>/legacy-new.json
 *   git worktree remove <dir>/legacy-base
 */

const ENV_FILE = process.env.LEGACY_DIFF_ENV_FILE || fileURLToPath(new URL('../../../../.env.local', import.meta.url));
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
}

const RUN = process.env.RUN_LEGACY_DIFF === '1';
const URL_ = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT = process.env.LEGACY_DIFF_OUT;

/** A client-less evidence row reviews with the organisational default city (no client record has this id). */
const NO_CLIENT = '00000000-0000-0000-0000-000000000000';
const PAGE = 1000;

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

interface Page { data: unknown[] | null; error: { message: string } | null }

/** Every row of a query, paged over a TOTAL order (the caller orders by id). A read error THROWS. */
async function readAll(what: string, page: (from: number, to: number) => PromiseLike<Page>): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`[LEGACY-DIFF] ${what} read failed: ${error.message}`);
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// What the file holds
// ─────────────────────────────────────────────────────────────────────────────

interface LegacyRef {
  /** '' for the mention's own ref, else the sub-ref part («admin» …). */
  part: string;
  op: string;
  /** Sorted; empty for a stub (its ids are anchor names, not places). */
  ids: string[];
  side: string | null;
  radius: number | null;
  polarity: string;
  stub: boolean;
}
interface LegacyPlacement {
  evidence_id: string;
  client_id: string | null;
  conversation_id: string;
  checkpoint_id: string | null;
  channel: string;
  extraction_version: string | null;
  preference_role: string;
  graded: boolean;
  graded_evidence: boolean;
  graded_checkpoint: boolean;
  conversation_found: 'client_gather' | 'direct' | 'none';
  mention_span: string;
  /** The anchors AS REVIEWED: «type:span→token (role, distance)». */
  anchors: string[];
  /** resolved = at least one real ref; ask = only stub refs; absent = not in the expression; error = the review failed. */
  state: 'resolved' | 'ask' | 'absent' | 'error';
  refs: LegacyRef[];
  /** The non-resolved anchor results of this mention («needs_confirm:missing_radius»). */
  reasons: string[];
  /** The resolution → mention mapping did not add up, so `reasons` could not be named per mention. */
  reasons_unattributed: boolean;
}
interface LegacyDiffFile {
  meta: {
    generated_at: string;
    git_head: string;
    cwd: string;
    evidence_rows: number;
    conversations: number;
    errors: Array<{ client_id: string | null; conversation_id: string; error: string }>;
  };
  /** Every uuid a resolved ref holds → the record kind it is. */
  id_kinds: Record<string, 'district' | 'city' | 'region' | 'unknown'>;
  placements: LegacyPlacement[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a result
// ─────────────────────────────────────────────────────────────────────────────

/** Every ref of the compiled expression, by evidence id (geometry ids are `geo:<evidence>[:<part>]`). */
function refsByEvidence(pref: GeoPreference): { byEvidence: Map<string, LegacyRef[]>; unattributed: string[] } {
  const byEvidence = new Map<string, LegacyRef[]>();
  const unattributed: string[] = [];
  for (const g of pref.groups ?? []) {
    for (const c of g.clauses ?? []) {
      for (const ref of c.anyOf ?? []) {
        const gid = str(ref.geometry_id);
        if (!gid.startsWith('geo:')) { unattributed.push(gid); continue; }
        const [eid, ...rest] = gid.slice(4).split(':');
        const x = ref.recipe;
        const stub = !x || x.geo_data_version === 'stub';
        const r: LegacyRef = {
          part: rest.join(':'),
          op: x ? x.operation : '(none)',
          ids: stub || !x ? [] : [...x.resolved_element_ids].sort(),
          side: x?.side ?? null,
          radius: typeof x?.radius_or_band_m === 'number' ? x.radius_or_band_m : null,
          polarity: c.op,
          stub,
        };
        const list = byEvidence.get(eid!) ?? [];
        list.push(r);
        byEvidence.set(eid!, list);
      }
    }
  }
  for (const list of byEvidence.values()) {
    list.sort((a, b) => JSON.stringify([a.part, a.op, a.ids, a.side, a.radius, a.polarity, a.stub])
      .localeCompare(JSON.stringify([b.part, b.op, b.ids, b.side, b.radius, b.polarity, b.stub])));
  }
  return { byEvidence, unattributed };
}

/** The evidence the resolutions follow: the result's `reviewed_evidence` when it has one (new code), else what was reviewed (main). */
function reviewedEvidence(res: ReviewFirstResult, given: readonly Evidence[]): readonly Evidence[] {
  const extra: unknown = (res as unknown as Record<string, unknown>).reviewed_evidence;
  return Array.isArray(extra) ? (extra as Evidence[]) : given;
}

/** An anchor in one line. `distance_m` is read untyped: main's AnchorToken has no such field (its rows never carry one). */
const anchorText = (e: Evidence): string[] => e.anchors.map((a) => {
  const d: unknown = (a as unknown as Record<string, unknown>).distance_m;
  return `${a.anchor_type}:${a.span}${a.normalized_token && a.normalized_token !== a.span ? `→${a.normalized_token}` : ''}`
    + `${a.role_in_relation ? ` (${a.role_in_relation})` : ''}${typeof d === 'number' ? ` ${d}m` : ''}`;
});

const reasonOf = (r: ResolutionResult): string => `${r.status}:${r.reason ?? '(no reason)'}`;

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

let supabase: SupabaseClient;
beforeAll(() => { if (URL_ && KEY) supabase = createClient(URL_, KEY, { auth: { persistSession: false } }); });

describe.skipIf(!RUN || !URL_ || !KEY)('legacy diff: re-review every stored reading (read-only, no LLM)', () => {
  it('writes every stored mention\'s placement to LEGACY_DIFF_OUT', async () => {
    if (!OUT) throw new Error('[LEGACY-DIFF] set LEGACY_DIFF_OUT to the JSON file to write');
    const sb = supabase;

    // 1. Everything stored by the model, read in full (paged, never capped).
    const evRows = await readAll('geo_pref_evidence', (from, to) =>
      sb.from('geo_pref_evidence').select('*').eq('origin', 'model').order('id', { ascending: true }).range(from, to));
    const relRows = await readAll('geo_pref_relations', (from, to) =>
      sb.from('geo_pref_relations').select('*').eq('origin', 'model').order('id', { ascending: true }).range(from, to));
    const cpRows = await readAll('geo_pref_checkpoints', (from, to) =>
      sb.from('geo_pref_checkpoints').select('id, client_id, conversation_id, created_at, evidence_visible_so_far')
        .eq('origin_tag', 'model').order('id', { ascending: true }).range(from, to));
    const labelRows = await readAll('geo_pref_labels', (from, to) =>
      sb.from('geo_pref_labels').select('id, subject_ref').order('id', { ascending: true }).range(from, to));
    const batchRows = await readAll('geo_pref_calibration_batch', (from, to) =>
      sb.from('geo_pref_calibration_batch').select('id, subjects').order('id', { ascending: true }).range(from, to));

    const gradedRefs = new Set<string>(labelRows.map((r) => str(r.subject_ref)).filter(Boolean));
    for (const b of batchRows) {
      for (const sub of Array.isArray(b.subjects) ? b.subjects : []) {
        const ref = (sub as { subject_ref?: unknown } | null)?.subject_ref;
        if (typeof ref === 'string' && ref) gradedRefs.add(ref);
      }
    }

    // 2. Group by (client, conversation); the newest model checkpoint of each orders its evidence (as the chat card does).
    const keyOf = (client: string | null, conv: string): string => `${client ?? ''}|${conv}`;
    const groups = new Map<string, Row[]>();
    for (const r of evRows) {
      const k = keyOf(str(r.client_id) || null, str(r.conversation_id));
      const list = groups.get(k) ?? [];
      list.push(r);
      groups.set(k, list);
    }
    const newestCp = new Map<string, Row>();
    for (const c of cpRows) {
      const k = keyOf(str(c.client_id) || null, str(c.conversation_id));
      const prev = newestCp.get(k);
      if (!prev || str(c.created_at) > str(prev.created_at)) newestCp.set(k, c);
    }
    const relByConv = new Map<string, EvidenceRelation[]>();
    for (const r of relRows) {
      const k = str(r.conversation_id);
      const list = relByConv.get(k) ?? [];
      list.push(rowToRelation(r));
      relByConv.set(k, list);
    }

    const deps = makeSupabaseBackfillDeps(sb, 'legacy-diff');
    const created: ProposalRecord[] = [];
    const proposals = {
      async createProposal(input: ProposalInput): Promise<ProposalRecord> {
        const rec: ProposalRecord = { ...input, id: `mem-${created.length + 1}`, status: 'pending' };
        created.push(rec);
        return rec;
      },
    };
    const clientConversations = new Map<string, Conversation[]>();

    const placements: LegacyPlacement[] = [];
    const errors: LegacyDiffFile['meta']['errors'] = [];
    const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [n, [key, rowsRaw]] of ordered.entries()) {
      const [clientPart, conversationId] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
      const clientId = clientPart || null;
      const cp = newestCp.get(key) ?? null;
      const channel = str(rowsRaw[0]!.source_channel) === 'call' ? 'call' : 'chat';

      // The chat card's order: (source_timestamp, id), then the checkpoint's own order.
      const rows = [...rowsRaw].sort((a, b) => str(a.source_timestamp).localeCompare(str(b.source_timestamp)) || str(a.id).localeCompare(str(b.id)));
      const order = Array.isArray(cp?.evidence_visible_so_far) ? (cp!.evidence_visible_so_far as unknown[]).map(str) : [];
      if (order.length) {
        const pos = new Map(order.map((id, i) => [id, i]));
        rows.sort((a, b) => (pos.get(str(a.id)) ?? Number.MAX_SAFE_INTEGER) - (pos.get(str(b.id)) ?? Number.MAX_SAFE_INTEGER));
      }
      const stored = rows.map(rowToEvidence);
      const base = (e: Evidence): Omit<LegacyPlacement, 'anchors' | 'state' | 'refs' | 'reasons' | 'reasons_unattributed' | 'conversation_found'> => {
        const gEv = gradedRefs.has(e.id);
        const gCp = !!cp && gradedRefs.has(str(cp.id));
        return {
          evidence_id: e.id, client_id: clientId, conversation_id: conversationId, checkpoint_id: cp ? str(cp.id) : null,
          channel, extraction_version: e.extraction_version ?? null, preference_role: e.preference_role,
          graded: gEv || gCp, graded_evidence: gEv, graded_checkpoint: gCp, mention_span: e.mention_span,
        };
      };

      let found: LegacyPlacement['conversation_found'] = 'none';
      try {
        // The conversation, as the reviewers gather it: the client's own gather first, then by id.
        let conversation: Conversation | null = null;
        if (clientId) {
          if (!clientConversations.has(clientId)) clientConversations.set(clientId, await deps.gatherConversations(clientId));
          conversation = clientConversations.get(clientId)!.find((c) => c.id === conversationId) ?? null;
          if (conversation) found = 'client_gather';
        }
        if (!conversation) {
          conversation = channel === 'call'
            ? await gatherCallConversation(sb, conversationId)
            : await gatherChatConversation(sb, conversationId);
          if (conversation) found = 'direct';
        }

        const evidence = conversation ? evidenceForReview(stored, conversation).evidence : stored;
        const ctx = await deps.buildRunContext(clientId ?? NO_CLIENT, evidence.length);
        ctx.checkpoint_id = cp ? str(cp.id) : null;
        if (conversation) Object.assign(ctx, { conversation });
        const res = await deps.runReviewFirst(evidence, relByConv.get(conversationId) ?? [], ctx, { proposals });

        const { byEvidence, unattributed } = refsByEvidence(res.compiled);
        if (unattributed.length) console.log(`[LEGACY-DIFF] ${key}: refs with no evidence id: ${unattributed.join(', ')}`);
        const reviewed = reviewedEvidence(res, evidence);
        const total = reviewed.reduce((s, e) => s + e.anchors.length, 0);
        const mapped = reviewed.length === evidence.length && total === res.resolutions.length;
        let k = 0;
        for (const [i, e] of evidence.entries()) {
          const rev = mapped ? reviewed[i]! : e;
          const mine = mapped ? res.resolutions.slice(k, k + rev.anchors.length) : [];
          if (mapped) k += rev.anchors.length;
          const refs = byEvidence.get(e.id) ?? [];
          placements.push({
            ...base(e),
            conversation_found: found,
            anchors: anchorText(rev),
            state: refs.length === 0 ? 'absent' : refs.some((r) => !r.stub) ? 'resolved' : 'ask',
            refs,
            reasons: mapped
              ? mine.filter((r) => r.status !== 'resolved').map(reasonOf)
              : res.resolutions.filter((r) => r.status !== 'resolved').map(reasonOf),
            reasons_unattributed: !mapped,
          });
        }
        console.log(`[LEGACY-DIFF] ${n + 1}/${ordered.length} ${channel} ${conversationId} client=${clientId ?? '(none)'} evidence=${evidence.length} conversation=${found} decision=${res.decision}`);
      } catch (err) {
        // The one failure this harness records instead of stopping on: ONE
        // conversation whose review could not run (a gather / lookup / RPC
        // error). It is logged, written into the file as state 'error' and
        // fails the test at the end — a diff with a hole is not a pass.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[LEGACY-DIFF] review of ${key} failed:`, msg);
        errors.push({ client_id: clientId, conversation_id: conversationId, error: msg });
        for (const e of stored) {
          placements.push({ ...base(e), conversation_found: found, anchors: anchorText(e), state: 'error', refs: [], reasons: [msg], reasons_unattributed: true });
        }
      }
    }

    // 3. Name every uuid a resolved ref holds (C2 drops CITY / REGION record ids — the comparator allows that, nothing else).
    const { data: models, error: mErr } = await sb.from('models').select('id, name').in('name', ['districts', 'cities', 'regions']);
    if (mErr) throw new Error(`[LEGACY-DIFF] models read failed: ${mErr.message}`);
    const kindOfModel = new Map<string, 'district' | 'city' | 'region'>();
    for (const m of (models ?? []) as Array<{ id: string; name: string }>) {
      kindOfModel.set(m.id, m.name === 'districts' ? 'district' : m.name === 'cities' ? 'city' : 'region');
    }
    const uuids = [...new Set(placements.flatMap((p) => p.refs.flatMap((r) => r.ids)).filter(isUuid))].sort();
    const idKinds: LegacyDiffFile['id_kinds'] = {};
    for (let i = 0; i < uuids.length; i += 100) {
      const chunk = uuids.slice(i, i + 100);
      const { data, error } = await sb.from('unified_records').select('id, model_id').in('id', chunk);
      if (error) throw new Error(`[LEGACY-DIFF] id kinds read failed: ${error.message}`);
      for (const r of (data ?? []) as Array<{ id: string; model_id: string }>) idKinds[r.id] = kindOfModel.get(r.model_id) ?? 'unknown';
    }
    for (const id of uuids) if (!(id in idKinds)) idKinds[id] = 'unknown';

    placements.sort((a, b) => a.evidence_id.localeCompare(b.evidence_id));
    const file: LegacyDiffFile = {
      meta: {
        generated_at: new Date().toISOString(),
        git_head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirname(fileURLToPath(import.meta.url)) }).toString().trim(),
        cwd: process.cwd(),
        evidence_rows: evRows.length,
        conversations: groups.size,
        errors,
      },
      id_kinds: idKinds,
      placements,
    };
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`, 'utf8');

    const count = (s: LegacyPlacement['state']): number => placements.filter((p) => p.state === s).length;
    console.log(`[LEGACY-DIFF] wrote ${OUT}: ${placements.length} mentions over ${groups.size} conversations — resolved ${count('resolved')} · ask ${count('ask')} · absent ${count('absent')} · error ${count('error')}; graded ${placements.filter((p) => p.graded).length}; git ${file.meta.git_head.slice(0, 10)}`);

    expect(created.every((p) => p.id.startsWith('mem-'))).toBe(true);
    expect(placements.length).toBe(evRows.length);
    expect(errors, 'conversations whose review could not run').toEqual([]);
  }, 3_600_000);
});
