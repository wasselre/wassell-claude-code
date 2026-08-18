// ============================================================================
// Shared ingestion contract — the ONE cross-source vocabulary for the market
// ingestion pipeline. Each source ships its own deterministic adapter that
// emits these shapes; raw evidence, state, mapping, gaps, provenance and
// publishing all ride the shared Gate A pipeline (docs/market-ingest/gate-a.md).
//
// These types mirror the Gate A table contracts + the 2026-09-06_01 write-path
// RPCs EXACTLY. Keep them in sync with those migrations. No AI, no scoring —
// adapters are pure functions from captured evidence to these values.
// ============================================================================

// ── enums mirrored from the Gate A CHECK constraints ────────────────────────

/** ingestion_items.state — the per-attempt lifecycle state machine. */
export type IngestionItemState =
  | 'discovered' | 'fetched' | 'raw_snapshot_saved' | 'parsed' | 'normalized'
  | 'validated' | 'enriched' | 'ready_to_publish' | 'published'
  | 'published_with_schema_gaps' | 'fetch_failed' | 'parse_failed'
  | 'validation_failed' | 'enrichment_failed' | 'quarantined' | 'noop';

/** raw_snapshots.capture_class — derived from the section manifest. */
export type CaptureClass = 'complete' | 'partial' | 'blocked' | 'failed';

/** page_capture_manifest.state — one row per expected section (7 states). */
export type CaptureState =
  | 'captured' | 'not_present' | 'not_applicable' | 'missing_expected'
  | 'blocked' | 'failed' | 'unknown';

/** page_capture_manifest.why_expected — the evidence a section should exist. */
export type WhyExpected =
  | 'source_reported_count' | 'tab' | 'button' | 'embedded_identifier'
  | 'api_reference' | 'platform_contract' | 'none';

/** raw_snapshot_artifacts.retention_mode — mechanism used to retain the asset. */
export type RetentionMode =
  | 'original_bytes' | 'immutable_mirror' | 'manifest_and_segments'
  | 'source_url_metadata_only' | 'existing_storage_ref';

/** raw_snapshot_artifacts.retention_state — durability outcome. */
export type RetentionState =
  | 'durable_original' | 'durable_existing_asset' | 'external_reference_only'
  | 'retention_failed' | 'not_applicable';

/** raw_snapshot_artifacts.completeness. */
export type ArtifactCompleteness = 'complete' | 'partial' | 'unknown';

/** source_field_mappings.status — the authoritative mapping decision. */
export type MappingStatus =
  | 'mapped_existing_field' | 'candidate_new_field' | 'review_required'
  | 'reviewed_source_specific' | 'intentionally_ignored' | 'technical_excluded'
  | 'unresolved';

/** schema_gap_events.criticality. */
export type GapCriticality = 'critical' | 'non_critical';

// ── the evidence package an adapter emits for ingest_capture_put ─────────────

/** One immutable content-addressed blob. Exactly one storage location. */
export interface RawBlobInput {
  content_hash: string;            // sha256 hex (64) — the primary key
  media_type: string;              // MIME
  size_bytes: number;
  // Exactly ONE of the following location shapes (Gate A CHECK enforces it):
  storage_bucket?: string | null;  // set iff storage_object_path is set
  storage_object_path?: string | null;
  aqar_evidence_listing_id?: string | null; // FK to aqar_listing_evidence
}

/** One artifact of a snapshot + its retention decision + media metadata. */
export interface RawArtifactInput {
  artifact_type: string;           // detail_html|next_data|jsonld|detail_api|image|video|floor_plan|...
  media_type?: string | null;
  source_url_or_endpoint?: string | null;
  content_hash?: string | null;    // NULL only for source_url_metadata_only
  retention_mode: RetentionMode;
  retention_state: RetentionState;
  http_status?: number | null;
  parser_hint?: string | null;
  completeness?: ArtifactCompleteness;
  order_index?: number | null;     // gallery order preserved
  caption?: string | null;
  width?: number | null;
  height?: number | null;
  duration_seconds?: number | null;
  media_metadata?: Record<string, unknown>;
}

/** One expected section's capture state. `artifact_index` is 0-based into artifacts[]. */
export interface CaptureManifestEntry {
  section: string;
  state: CaptureState;
  why_expected: WhyExpected;
  artifact_index?: number | null;
  note?: string | null;
}

/** The complete evidence package passed to public.ingest_capture_put(). */
export interface EvidencePackage {
  external_id: string;
  adapter_id: string;
  adapter_version: string;
  manifest_hash: string;           // sha256 hex over the ordered artifacts+manifest
  media_summary: Record<string, unknown>; // source-reported AND captured counts (never conflated)
  blobs: RawBlobInput[];
  artifacts: RawArtifactInput[];
  manifest: CaptureManifestEntry[];
}

/** A discovered source field to record via source_field_observe(). */
export interface ObservedField {
  source_path: string;             // stable path, e.g. property.price
  page_section?: string | null;
  source_label?: string | null;
  raw_data_type?: string | null;   // string|number|bool|array|object|url|date
  unit?: string | null;
  language?: 'ar' | 'en' | 'mixed' | 'na' | null;
  example_values: unknown[];       // bounded to 10 downstream
}

/** A captured-but-unmapped field to raise via schema_gap_raise(). */
export interface SchemaGap {
  source_path: string;
  suggested_type?: string | null;
  suggested_canonical_field?: string | null;
  criticality: GapCriticality;
}

/**
 * The full deterministic output of an adapter for ONE listing:
 *  - evidence      → ingest_capture_put
 *  - observed[]    → source_field_observe (discovery catalog)
 *  - gaps[]        → schema_gap_raise (captured-but-unmapped only; NEVER optional-absent)
 *  - canonical     → the mapped canonical field values (consumed by the publisher,
 *                    which re-derives them ONLY through source_field_mappings)
 *  - capture_class → derived from the section manifest
 */
export interface AdapterResult {
  external_id: string;
  contract_version: string;        // zero-padded, e.g. 'v001' (lexical "latest")
  evidence: EvidencePackage;
  observed: ObservedField[];
  gaps: SchemaGap[];
  canonical: Record<string, unknown>;
  capture_class: CaptureClass;
}

/** Deterministic capture_class from a section manifest (mirrors SQL derivation). */
export function deriveCaptureClass(manifest: CaptureManifestEntry[]): CaptureClass {
  if (manifest.some((m) => m.state === 'blocked')) return 'blocked';
  if (manifest.some((m) => m.state === 'failed')) return 'failed';
  if (manifest.some((m) => m.state === 'missing_expected' || m.state === 'unknown')) return 'partial';
  return 'complete';
}
