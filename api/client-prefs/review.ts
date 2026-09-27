/**
 * POST /api/client-prefs/review — a rep resolves ONE chat preference proposal
 * (`client_pref_proposals`, produced by the chat auto-read's preference agent).
 *
 *   { proposalId, action: 'save', fields: [slug…], expectedVersion? }
 *       Writes ONLY the ticked fields to the client: set fields (unit type,
 *       purpose, amenities) are UNIONED with the fresh row value, range fields
 *       (budget, area, bedrooms) REPLACE it. Set values are re-validated
 *       against the LIVE clients schema options at save time — an unknown one
 *       is dropped and console.error-ed, never saved.
 *   { proposalId, action: 'dismiss', expectedVersion? }
 *       Marks it dismissed. NEVER touches the client record.
 *
 * Guards (applyPrefReview, pure over injected ports — review.test.ts):
 * exists (404) → expectedVersion matches (409) → still pending (409) → the
 * fields are known preference slugs present in the suggestions (400) → the
 * caller can ACCESS the client under their own RLS (both actions — dismissing
 * is a decision about the client too) → write → mark the proposal decided with
 * a `status='pending'` guard (0 rows ⇒ 409, someone else resolved it).
 *
 * The client write goes through `recordSaveWithRetry` (the versioned
 * `record_save` RPC, fresh read each attempt) — the same path
 * /api/geo-preference/review uses. A human pressing save is the authorization;
 * the pipeline itself never writes a client (`auto_write_enabled` stays false).
 */

import { withAuth, jsonError, jsonOk, assertCanAccessRecord } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';
import { recordSaveWithRetry } from '../_lib/recordSaveRetry.js';
import {
  PREF_FIELD_KINDS, isPrefSlug, buildPrefPatch, type PrefSuggestionLike,
} from '../../src/lib/clientPrefs/mergePrefs.js';

export const config = { runtime: 'edge' };

const SERVICE_NAME = 'api:client-prefs-review';

export type PrefReviewAction = 'save' | 'dismiss';

export interface PrefProposalRow {
  id: string;
  client_id: string;
  chat_wid: string;
  status: string;
  version: number | null;
  suggestions: Record<string, PrefSuggestionLike>;
}

export interface PrefDecisionPatch {
  status: 'saved' | 'dismissed';
  decided_by: string;
  decided_at: string;
  saved_fields?: string[];
  after_values?: Record<string, unknown>;
}

export interface PrefClientWrite {
  /** The ticked fields' values before the write (from the fresh row). */
  before: Record<string, unknown>;
  /** The values actually written (only the fields that changed). */
  written: Record<string, unknown>;
  dropped: Array<{ slug: string; value: string }>;
}

export interface PrefReviewDeps {
  getProposal(id: string): Promise<PrefProposalRow | null>;
  /** Throws to deny. Called on BOTH actions. */
  assertCanAccess(clientId: string): Promise<void>;
  /** The LIVE clients schema's option values per set-field slug. */
  loadOptions(): Promise<Record<string, string[]>>;
  /** The ONLY client writer. Only the save branch reaches it. */
  writeClient(clientId: string, suggestions: Record<string, PrefSuggestionLike>, fields: string[], options: Record<string, string[]>): Promise<PrefClientWrite>;
  /** Mark the proposal decided — guarded on status='pending'; must throw PrefReviewError(409) when 0 rows matched. */
  markDecided(id: string, patch: PrefDecisionPatch): Promise<void>;
  now(): string;
}

export interface PrefReviewInput {
  proposalId: string;
  action: PrefReviewAction;
  reviewerId: string;
  fields?: string[];
  expectedVersion?: number | null;
}

export interface PrefReviewOutcome {
  proposalId: string;
  clientId: string;
  action: PrefReviewAction;
  status: 'saved' | 'dismissed';
  saved_fields: string[];
  before: Record<string, unknown> | null;
  written: Record<string, unknown> | null;
  dropped: Array<{ slug: string; value: string }>;
}

export class PrefReviewError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function applyPrefReview(deps: PrefReviewDeps, input: PrefReviewInput): Promise<PrefReviewOutcome> {
  const p = await deps.getProposal(input.proposalId);
  if (!p) throw new PrefReviewError(404, `proposal ${input.proposalId} not found`);
  if (input.expectedVersion != null && p.version != null && p.version !== input.expectedVersion) {
    throw new PrefReviewError(409, 'proposal changed since you loaded it — reload and try again');
  }
  if (p.status !== 'pending') throw new PrefReviewError(409, `proposal is already ${p.status}`);

  const fields = input.action === 'save' ? [...new Set(input.fields ?? [])] : [];
  if (input.action === 'save') {
    if (fields.length === 0) throw new PrefReviewError(400, 'save needs at least one ticked field');
    for (const f of fields) {
      if (!isPrefSlug(f)) throw new PrefReviewError(400, `'${f}' is not a preference field`);
      if (!p.suggestions?.[f]) throw new PrefReviewError(400, `'${f}' was not suggested by this proposal`);
    }
  }

  await deps.assertCanAccess(p.client_id);

  if (input.action === 'dismiss') {
    await deps.markDecided(p.id, { status: 'dismissed', decided_by: input.reviewerId, decided_at: deps.now() });
    return {
      proposalId: p.id, clientId: p.client_id, action: 'dismiss', status: 'dismissed',
      saved_fields: [], before: null, written: null, dropped: [],
    };
  }

  const options = await deps.loadOptions();
  const w = await deps.writeClient(p.client_id, p.suggestions, fields, options);
  for (const d of w.dropped) {
    console.error(`[client-prefs-review] proposal=${p.id} dropped '${d.value}' for ${d.slug} — not an option of the live clients schema`);
  }
  await deps.markDecided(p.id, {
    status: 'saved', decided_by: input.reviewerId, decided_at: deps.now(),
    saved_fields: fields, after_values: w.written,
  });
  return {
    proposalId: p.id, clientId: p.client_id, action: 'save', status: 'saved',
    saved_fields: fields, before: w.before, written: w.written, dropped: w.dropped,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Live-schema options (PURE over the schema JSON)
// ────────────────────────────────────────────────────────────────────────────

interface SchemaField { name?: unknown; options?: unknown }
interface SchemaSection { fields?: unknown }

/** Option `value`s of the set-kind preference fields in a clients-model schema. */
export function prefOptionsFromSchema(schema: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const sections = (schema as { sections?: unknown } | null)?.sections;
  if (!Array.isArray(sections)) return out;
  for (const sec of sections as SchemaSection[]) {
    if (!Array.isArray(sec?.fields)) continue;
    for (const f of sec.fields as SchemaField[]) {
      const name = typeof f?.name === 'string' ? f.name : '';
      if (PREF_FIELD_KINDS[name] !== 'set' || !Array.isArray(f.options)) continue;
      out[name] = (f.options as Array<{ value?: unknown }>)
        .map((o) => (typeof o?.value === 'string' ? o.value : ''))
        .filter(Boolean);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP handler
// ────────────────────────────────────────────────────────────────────────────

interface RawBody { proposalId?: unknown; action?: unknown; fields?: unknown; expectedVersion?: unknown }

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'method not allowed');
  return withAuth(req, async (user) => {
    let body: RawBody;
    try {
      body = (await req.json()) as RawBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const proposalId = typeof body.proposalId === 'string' ? body.proposalId : '';
    if (!proposalId) return jsonError(400, 'proposalId is required');
    if (body.action !== 'save' && body.action !== 'dismiss') return jsonError(400, "action must be 'save' or 'dismiss'");
    const action: PrefReviewAction = body.action;
    const fields = Array.isArray(body.fields) ? body.fields.filter((f): f is string => typeof f === 'string') : [];
    const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : null;

    const service = makeServiceClient(SERVICE_NAME);
    if (!service) return jsonError(500, 'Supabase service env not configured');

    const deps: PrefReviewDeps = {
      async getProposal(id) {
        const { data, error } = await service
          .from('client_pref_proposals')
          .select('id, client_id, chat_wid, status, version, suggestions')
          .eq('id', id).maybeSingle();
        if (error) throw new PrefReviewError(500, `proposal read failed: ${error.message}`);
        return (data as PrefProposalRow | null) ?? null;
      },
      // Service role bypasses RLS — this is the gate that stops a rep acting on
      // a client they cannot see.
      async assertCanAccess(clientId) {
        await assertCanAccessRecord(req, clientId, SERVICE_NAME);
      },
      async loadOptions() {
        const { data, error } = await service.from('models').select('schema').eq('name', 'clients').maybeSingle();
        if (error) throw new PrefReviewError(500, `clients schema read failed: ${error.message}`);
        if (!data) throw new PrefReviewError(500, 'clients model not found');
        return prefOptionsFromSchema(data.schema);
      },
      async writeClient(clientId, suggestions, ticked, options) {
        let before: Record<string, unknown> = {};
        let written: Record<string, unknown> = {};
        let dropped: Array<{ slug: string; value: string }> = [];
        // recordSaveWithRetry re-reads the FRESH row every attempt, so a set
        // union lands on top of a concurrent manual edit instead of wiping it.
        await recordSaveWithRetry(service, {
          recordId: clientId,
          build: (fresh) => {
            before = Object.fromEntries(ticked.map((f) => [f, fresh[f] ?? null]));
            const res = buildPrefPatch(fresh, suggestions, ticked, options);
            written = res.patch;
            dropped = res.dropped;
            return Object.keys(res.patch).length ? { ...fresh, ...res.patch } : null;
          },
        });
        return { before, written, dropped };
      },
      async markDecided(id, patch) {
        const { data, error } = await service
          .from('client_pref_proposals')
          .update(patch)
          .eq('id', id)
          .eq('status', 'pending') // a concurrent reviewer / a newer reading got there first
          .select('id');
        if (error) throw new PrefReviewError(500, `proposal update failed: ${error.message}`);
        if (!data || data.length === 0) throw new PrefReviewError(409, 'proposal was resolved or replaced by a newer reading');
      },
      now: () => new Date().toISOString(),
    };

    try {
      const outcome = await applyPrefReview(deps, { proposalId, action, reviewerId: user.userId, fields, expectedVersion });
      console.log(`[client-prefs-review] proposal=${proposalId} action=${action} fields=${outcome.saved_fields.join(',') || '-'} by=${user.userId}`);
      return jsonOk(outcome);
    } catch (err) {
      if (err instanceof PrefReviewError) return jsonError(err.status, err.message);
      throw err; // AuthError from assertCanAccessRecord + unknowns → withAuth maps them
    }
  });
}
