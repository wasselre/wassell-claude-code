/**
 * Candidate asset ranker + pick sanitizer.
 *
 * Rows come from RPC `creative_candidate_assets` (contracts §2 `_24`) — project
 * images with rights trust. Two jobs:
 *
 *   rankCandidateAssets(rows, intent)   → deterministic worker-side ranking for
 *                                         the prompt (mirrors the RPC ORDER
 *                                         clause: verified rights first →
 *                                         developer/internal source → raw
 *                                         production state → real/cgi → recency).
 *                                         Competitor + restricted/do_not_use
 *                                         rows are EXCLUDED, not just demoted.
 *
 *   sanitizeAssetPicks(picks, rows)     → post-process the model's asset picks:
 *                                         hallucinated ids dropped, competitor
 *                                         ids rejected, rights fields COPIED
 *                                         from the rows (the model never
 *                                         decides rights — contracts §0 rule 9),
 *                                         needs_rights_confirmation forced when
 *                                         rights are unverified.
 *
 * Pure module — no I/O.
 */
import type {
  AcquisitionSource,
  AssetNature,
  AssetPick,
  PostFormat,
  ProductionState,
  RightsProvenance,
  UsageRights,
} from '../contracts.js';

/** Row shape of RPC `creative_candidate_assets` (contracts §2 `_24`). */
export interface CandidateAssetRow {
  file_id: string;
  original_name: string | null;
  primary_category: string | null;
  document_type: string | null;
  link_role: string | null;
  asset_nature: AssetNature | string | null;
  acquisition_source: AcquisitionSource | string | null;
  usage_rights: UsageRights | string | null;
  rights_provenance: RightsProvenance | string | null;
  rights_verified: boolean | null;
  production_state: ProductionState | string | null;
  aspect_ratio: string | null;
  width_px: number | null;
  height_px: number | null;
  ai_description: string | null;
  tags: string[] | null;
  subjects: string[] | null;
  /** jsonb — array of hex strings or {hex,share} objects (shape not fixed yet). */
  dominant_colors: unknown;
  has_text: boolean | null;
  headline_space: 'none' | 'top' | 'bottom' | 'left' | 'right' | 'center' | string | null;
  storage_bucket?: string | null;
  storage_path?: string | null;
  /** Recency hint when the caller has it (created_at ISO) — newer ranks higher. */
  created_at?: string | null;
}

export interface AssetIntent {
  recipe?: string | null;
  format?: PostFormat;
  /** Cap for the prompt list. Default 12. */
  limit?: number;
}

/** Rights that can never be selected for production (contracts §0 rule 9). */
const BLOCKED_RIGHTS: ReadonlySet<string> = new Set(['restricted', 'do_not_use']);
/** Rights that make an asset immediately production-trusted. */
const TRUSTED_RIGHTS: ReadonlySet<string> = new Set(['approved', 'use_after_edit']);

/** True when a row may be shown to the model at all. */
export function isCandidateAllowed(row: CandidateAssetRow): boolean {
  if (row.acquisition_source === 'competitor') return false; // reference-only, never an asset
  if (row.usage_rights && BLOCKED_RIGHTS.has(row.usage_rights)) return false;
  return true;
}

/** Deterministic ranking score — mirrors the RPC ORDER (§2 `_24`). `newestTs` = the newest created_at in the candidate set (recency is relative, so the score never ages). */
export function candidateScore(row: CandidateAssetRow, newestTs: number | null = null): number {
  let score = 0;
  const verified = row.rights_verified === true;
  if (verified && row.usage_rights && TRUSTED_RIGHTS.has(row.usage_rights)) score += 100;
  else if (row.usage_rights && TRUSTED_RIGHTS.has(row.usage_rights)) score += 60;
  else if (row.usage_rights === 'needs_review' || !row.usage_rights) score += 20;
  else score += 10; // attribution_required / internal_only — usable with care
  if (row.acquisition_source === 'developer' || row.acquisition_source === 'internal') score += 20;
  if (row.production_state === 'raw') score += 10; // untouched canvas takes design text best
  else if (row.production_state === 'final') score += 5;
  if (row.asset_nature === 'real' || row.asset_nature === 'cgi_render') score += 10;
  if (row.ai_description) score += 5;
  if (row.headline_space && row.headline_space !== 'none') score += 3; // design-friendly empty space
  if (row.has_text === true) score -= 3; // existing text fights the design's headlines
  if (row.created_at && newestTs !== null) {
    const ageDays = Math.max(0, (newestTs - Date.parse(row.created_at)) / 86_400_000);
    score += Math.max(0, 5 - Math.floor(ageDays / 30)); // ~recency, decayed monthly vs the newest candidate
  }
  return score;
}

/**
 * Rank + cap the candidate rows for the prompt. Disallowed rows (competitor /
 * blocked rights) are removed BEFORE scoring. Stable: ties keep RPC order.
 */
export function rankCandidateAssets(rows: CandidateAssetRow[], intent: AssetIntent = {}): CandidateAssetRow[] {
  const limit = intent.limit ?? 12;
  const newestTs = rows.reduce<number | null>(
    (acc, r) => {
      if (!r.created_at) return acc;
      const ts = Date.parse(r.created_at);
      return Number.isFinite(ts) && (acc === null || ts > acc) ? ts : acc;
    },
    null,
  );
  return rows
    .map((row, i) => ({ row, i, score: isCandidateAllowed(row) ? candidateScore(row, newestTs) : -1 }))
    .filter((e) => e.score >= 0)
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .slice(0, limit)
    .map((e) => e.row);
}

/** The fields the model authors per picked asset (rights are NEVER model-authored). */
export type ModelAssetPick = Pick<AssetPick, 'file_id' | 'placement' | 'usage' | 'treatment' | 'why' | 'is_production'>;

export interface AssetSanitizeResult {
  assets: AssetPick[];
  dropped: Array<{ file_id: string; reason: 'unknown_id' | 'competitor_media' | 'rights_blocked' | 'duplicate' }>;
  warnings: string[];
}

/**
 * Post-process the model's `assets` array against the candidate rows.
 * Rights / nature / source / production_state / rights_verified are copied
 * from the ROW — the model only authors placement, usage, treatment, why and
 * the is_production suggestion. First pick of a file_id wins (dupes dropped).
 */
export function sanitizeAssetPicks(picks: ModelAssetPick[], rows: CandidateAssetRow[]): AssetSanitizeResult {
  const byId = new Map(rows.map((r) => [r.file_id, r]));
  const seen = new Set<string>();
  const assets: AssetPick[] = [];
  const dropped: AssetSanitizeResult['dropped'] = [];
  const warnings: string[] = [];

  for (const pick of picks) {
    if (seen.has(pick.file_id)) {
      dropped.push({ file_id: pick.file_id, reason: 'duplicate' });
      continue;
    }
    const row = byId.get(pick.file_id);
    if (!row) {
      dropped.push({ file_id: pick.file_id, reason: 'unknown_id' });
      warnings.push(`asset ${pick.file_id} is not among the candidate files — dropped (hallucination guard)`);
      continue;
    }
    seen.add(pick.file_id);
    if (row.acquisition_source === 'competitor') {
      dropped.push({ file_id: pick.file_id, reason: 'competitor_media' });
      warnings.push(`asset ${pick.file_id} is competitor media — reference-only, rejected as a production asset`);
      continue;
    }
    if (row.usage_rights && BLOCKED_RIGHTS.has(row.usage_rights)) {
      dropped.push({ file_id: pick.file_id, reason: 'rights_blocked' });
      warnings.push(`asset ${pick.file_id} has usage_rights='${row.usage_rights}' — never selectable`);
      continue;
    }
    const rightsVerified = row.rights_verified === true;
    assets.push({
      file_id: pick.file_id,
      nature: (row.asset_nature as AssetNature | null) ?? null,
      source: (row.acquisition_source as AcquisitionSource | null) ?? null,
      rights: (row.usage_rights as UsageRights | null) ?? null,
      rights_verified: rightsVerified,
      production_state: (row.production_state as ProductionState | null) ?? null,
      placement: pick.placement,
      usage: pick.usage,
      treatment: pick.treatment,
      why: pick.why,
      is_production: pick.is_production,
      needs_rights_confirmation: !rightsVerified,
    });
  }

  return { assets, dropped, warnings };
}
