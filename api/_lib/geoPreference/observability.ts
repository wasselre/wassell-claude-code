/**
 * Light structured-event observability for the Geography Understanding pipeline,
 * plus the PII/coordinate redaction helpers the same data must pass through
 * before it is surfaced to a human reviewer.
 *
 * TWO responsibilities, both about "what is safe to surface":
 *
 * 1. STRUCTURED EVENTS. Each pipeline stage (extraction → resolution → gating →
 *    review outcome, plus versioning) emits one single-line JSON event carrying
 *    the stage, outcome, latency, and — on failure — the error MESSAGE (never the
 *    raw error object, which can carry request bodies / PII). The `time()` wrapper
 *    measures latency and logs an `ok`/`error` event, and ALWAYS re-throws on
 *    failure. Per CLAUDE.md's silent-failure rule, nothing here swallows an
 *    exception: observability records the failure loudly and lets it propagate.
 *
 * 2. REDACTION. The pipeline's evidence is derived from a customer's WhatsApp/call
 *    text and resolves to coordinates that can pin a home. Two reviewer roles see
 *    it under different rules (mirrors the review-and-ops SQL views — this is the
 *    application-side enforcement, kept in sync with them):
 *      - `meaning_reviewer` — judges the LINGUISTIC reading. Gets the evidence's
 *        meaning fields but NO phone/name and NO precise coordinates.
 *      - `geo_operator`     — validates GEOMETRY. Gets coordinates PSEUDONYMIZED
 *        (reduced precision + a stable non-identifying pseudonym instead of the
 *        client id) and NO phone/name.
 *      - `admin`            — sees everything (still logged).
 *
 * NOTHING here writes to a client record or to the DB. It formats and it logs.
 */

import { createHash } from 'node:crypto';

// ────────────────────────────────────────────────────────────────────────────
// Event model.
// ────────────────────────────────────────────────────────────────────────────
export type GeoStage =
  | 'extraction'
  | 'resolution'
  | 'gating'
  | 'review_outcome'
  | 'versioning';

export type GeoOutcome = 'ok' | 'error';

export interface GeoEvent {
  stage: GeoStage;
  outcome: GeoOutcome;
  /** Wall-clock duration of the stage in milliseconds (when measured). */
  latency_ms?: number;
  /** Non-identifying correlation ids only. NEVER a phone number or a name. */
  client_id?: string;
  checkpoint_id?: string | null;
  conversation_id?: string;
  /** A stage-specific outcome label, e.g. the gate decision or a proposal action. */
  result?: string;
  /** Small, non-PII structured detail (counts, versions, flags). Scrubbed on log. */
  detail?: Record<string, unknown>;
  /** Failure message ONLY (never the raw error object). Present iff outcome==='error'. */
  error?: string;
}

export type GeoEventSink = (event: GeoEvent) => void;

// ────────────────────────────────────────────────────────────────────────────
// PII scrubbing for log payloads. Keys that could carry personal data are dropped
// from any `detail` object before it reaches a sink — defence in depth so a
// careless caller can't leak a phone number into the logs.
// ────────────────────────────────────────────────────────────────────────────
const PII_KEYS = new Set([
  'phone', 'phone_number', 'msisdn', 'wid', 'chat_wid', 'from', 'to',
  'name', 'client_name', 'full_name', 'contact', 'email',
  'lat', 'lng', 'latitude', 'longitude', 'coordinates', 'coordinate', 'centroid',
  'geom', 'geometry', 'mention_span', 'text', 'transcript', 'message', 'body',
]);

/** Shallow-scrub a detail object: drop PII-ish keys. Returns a new object. */
export function scrubPii(detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (PII_KEYS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Sinks. The default console sink stays SILENT under Vitest (VITEST=true) and
// when GEO_OBS_SILENT=1, so unit tests don't drown in log noise; production logs
// one line per event, matching the repo's `[module] …` console style.
// ────────────────────────────────────────────────────────────────────────────
export const consoleSink: GeoEventSink = (event) => {
  if (process.env.VITEST || process.env.GEO_OBS_SILENT === '1') return;
  const payload: GeoEvent = { ...event, detail: scrubPii(event.detail) };
  const line = `[geoPreference] ${JSON.stringify(payload)}`;
  if (event.outcome === 'error') console.error(line);
  else console.log(line);
};

// ────────────────────────────────────────────────────────────────────────────
// Observer. `event()` logs one event (scrubbing detail); `time()` measures a
// stage, logs its outcome, and re-throws on error (never swallows).
// ────────────────────────────────────────────────────────────────────────────
export interface StageMeta {
  client_id?: string;
  checkpoint_id?: string | null;
  conversation_id?: string;
  result?: string;
  detail?: Record<string, unknown>;
}

export interface GeoObserver {
  event(event: GeoEvent): void;
  time<T>(stage: GeoStage, meta: StageMeta, fn: () => Promise<T> | T): Promise<T>;
}

export function createGeoObserver(sink: GeoEventSink): GeoObserver {
  const emit = (event: GeoEvent) => {
    // The sink itself must never break the pipeline; a logging failure is logged
    // once to console.error and otherwise ignored (it is NOT a pipeline error).
    try {
      sink({ ...event, detail: scrubPii(event.detail) });
    } catch (err) {
      console.error('[geoPreference] observability sink threw:', err instanceof Error ? err.message : String(err));
    }
  };

  return {
    event: emit,
    async time<T>(stage: GeoStage, meta: StageMeta, fn: () => Promise<T> | T): Promise<T> {
      const started = Date.now();
      try {
        const result = await fn();
        emit({
          stage,
          outcome: 'ok',
          latency_ms: Date.now() - started,
          client_id: meta.client_id,
          checkpoint_id: meta.checkpoint_id,
          conversation_id: meta.conversation_id,
          result: meta.result,
          detail: meta.detail,
        });
        return result;
      } catch (err) {
        emit({
          stage,
          outcome: 'error',
          latency_ms: Date.now() - started,
          client_id: meta.client_id,
          checkpoint_id: meta.checkpoint_id,
          conversation_id: meta.conversation_id,
          detail: meta.detail,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err; // NEVER swallow — record loudly, then propagate (CLAUDE.md).
      }
    },
  };
}

/** The process-wide default observer (console sink, silent under Vitest). */
export const geoObserver: GeoObserver = createGeoObserver(consoleSink);

/** A no-op observer for callers/tests that want the pipeline to emit nothing. */
export const nullObserver: GeoObserver = {
  event() {},
  async time(_stage, _meta, fn) {
    return fn();
  },
};

// ════════════════════════════════════════════════════════════════════════════
// REDACTION — role-scoped surfacing of pipeline data. Kept in sync with the
// review-and-ops SQL views; this is the application-side twin of that gate.
// ════════════════════════════════════════════════════════════════════════════
export type ReviewerRole = 'meaning_reviewer' | 'geo_operator' | 'admin';

/** The unredacted row as the pipeline knows it (a projection for review). */
export interface PreferenceReviewRow {
  proposal_id: string;
  client_id: string;
  /** PII — a phone number / WhatsApp id. */
  client_phone?: string | null;
  /** PII — the customer's name. */
  client_name?: string | null;
  /** The verbatim customer utterance (can contain PII). */
  mention_span?: string | null;
  /** The linguistic reading the meaning reviewer judges. */
  meaning?: Record<string, unknown>;
  /** Precise resolved coordinates (can pin a home). */
  coordinate?: { lat: number; lng: number } | null;
  /** The gate decision / proposed action. */
  proposed_action?: string;
}

/**
 * Reduce a coordinate to a PSEUDONYMIZED form: truncate to `precision` decimal
 * places (default 2 ≈ 1.1 km grid) so an exact pin is never exposed, and attach a
 * stable, non-reversible pseudonym derived from the client id + a salt (so the geo
 * operator can tell two mentions apart without learning WHO). Returns null in,
 * null out.
 */
export function pseudonymizeCoordinate(
  coordinate: { lat: number; lng: number } | null | undefined,
  clientId: string,
  opts: { precision?: number; salt?: string } = {},
): { lat: number; lng: number; pseudonym: string } | null {
  if (!coordinate || typeof coordinate.lat !== 'number' || typeof coordinate.lng !== 'number') {
    return null;
  }
  const precision = opts.precision ?? 2;
  const factor = 10 ** precision;
  const trunc = (n: number) => Math.trunc(n * factor) / factor;
  const salt = opts.salt ?? 'geo-pref-pseudonym-v1';
  const pseudonym = createHash('sha256').update(`${salt}:${clientId}`).digest('hex').slice(0, 12);
  return { lat: trunc(coordinate.lat), lng: trunc(coordinate.lng), pseudonym };
}

/** The shape returned after role redaction — every field optional by role. */
export interface RedactedReviewRow {
  proposal_id: string;
  /** Present only for admin (raw client id is an identity handle). */
  client_id?: string;
  client_phone?: string | null;
  client_name?: string | null;
  mention_span?: string | null;
  meaning?: Record<string, unknown>;
  coordinate?: { lat: number; lng: number } | null;
  pseudo_coordinate?: { lat: number; lng: number; pseudonym: string } | null;
  proposed_action?: string;
}

/**
 * Redact a review row for a reviewer role. Deterministic, pure.
 *
 *  - meaning_reviewer: meaning + action ONLY. No phone/name, no mention_span (it
 *    can echo PII), no coordinates at all.
 *  - geo_operator: action + PSEUDONYMIZED coordinates ONLY. No phone/name, no
 *    precise coordinate, no client id, no raw utterance.
 *  - admin: the full row, unredacted.
 */
export function redactPreferenceForRole(row: PreferenceReviewRow, role: ReviewerRole): RedactedReviewRow {
  if (role === 'admin') {
    return {
      proposal_id: row.proposal_id,
      client_id: row.client_id,
      client_phone: row.client_phone ?? null,
      client_name: row.client_name ?? null,
      mention_span: row.mention_span ?? null,
      meaning: row.meaning,
      coordinate: row.coordinate ?? null,
      proposed_action: row.proposed_action,
    };
  }

  if (role === 'meaning_reviewer') {
    return {
      proposal_id: row.proposal_id,
      meaning: row.meaning,
      proposed_action: row.proposed_action,
      // No client_id, phone, name, mention_span, or coordinates.
    };
  }

  // geo_operator
  return {
    proposal_id: row.proposal_id,
    proposed_action: row.proposed_action,
    pseudo_coordinate: pseudonymizeCoordinate(row.coordinate ?? null, row.client_id),
    // No client_id, phone, name, mention_span, meaning, or precise coordinate.
  };
}
