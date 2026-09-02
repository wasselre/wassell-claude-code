/**
 * Asset rights classification — Post Creative Director (contracts §0 rule 9).
 *
 * THIS FILE HAS TWO IDENTICAL COPIES — change both together:
 *   worker/src/creative/assetMeta/rights.ts        (worker: lanes, tests)
 *   api/_lib/marketing/creative/rights.ts          (api: final-approval re-check)
 *
 * It is deliberately SELF-CONTAINED (no imports beyond the supabase-js type)
 * so the two copies stay byte-identical. The string unions mirror
 * src/lib/creative/contracts.ts (UsageRights / AcquisitionSource / AssetNature)
 * and the DB CHECKs / vocabulary exactly.
 *
 * The rules (contracts §0.9):
 *   - competitor media is REFERENCE-ONLY — never selectable for production;
 *   - restricted / do_not_use are BLOCKED — never selectable for production;
 *   - AI outputs (ai_generated / ai_edited) require human review before use;
 *   - internal_only is not for customer-facing production;
 *   - verified rights (a HUMAN approved/modified the usage_rights value) on an
 *     approved / use_after_edit / attribution_required asset → selectable;
 *   - anything unclear (no rights, needs_review, AI-suggested or unknown
 *     provenance) → needs_rights_confirmation=true; developer/internal-sourced
 *     assets are still PRESENTED as production candidates (with the source and
 *     verification state visible), everything else waits for a human.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type UsageRightsValue =
  | 'approved' | 'use_after_edit' | 'attribution_required' | 'internal_only'
  | 'restricted' | 'do_not_use' | 'needs_review';
export type AcquisitionSourceValue =
  | 'developer' | 'internal' | 'competitor' | 'client' | 'partner' | 'public' | 'unknown';
export type AssetNatureValue =
  | 'real' | 'ai_generated' | 'ai_edited' | 'cgi_render' | 'graphic_design' | 'screenshot';

export type RightsBadge = 'verified' | 'unverified' | 'blocked' | 'reference_only' | 'ai_review';

/** The columns classifyRights needs — a subset of creative_candidate_assets /
 *  files_rights_v + files. All optional: an unset field is "unknown", and
 *  unknown rights NEVER classify as verified. */
export interface RightsRow {
  usage_rights?: string | null;
  /** file_metadata_provenance.state for usage_rights: human_approved |
   *  human_modified | ai_suggested | unknown (files_rights_v). */
  rights_provenance?: string | null;
  /** files_rights_v.rights_verified — true only on a HUMAN decision. */
  rights_verified?: boolean | null;
  acquisition_source?: string | null;
  asset_nature?: string | null;
}

export interface RightsClassification {
  /** May the creative director pick this as a PRODUCTION asset (vs reference)? */
  selectable_for_production: boolean;
  /** Unclear/AI-suggested rights — a human must confirm before final approval
   *  (content_set_approval_asset re-checks via recheckRightsForFinal). */
  needs_rights_confirmation: boolean;
  /** Short machine-readable reason (stable wording — tests assert on it). */
  reason: string;
  badge: RightsBadge;
}

const BLOCKED_RIGHTS = new Set(['restricted', 'do_not_use']);
const PRODUCTION_OK_RIGHTS = new Set(['approved', 'use_after_edit', 'attribution_required']);
const AI_NATURES = new Set(['ai_generated', 'ai_edited']);
/** Sources we may present as production candidates even before rights are confirmed. */
const PRODUCTION_CANDIDATE_SOURCES = new Set(['developer', 'internal']);

export function classifyRights(row: RightsRow): RightsClassification {
  const rights = row.usage_rights ?? null;
  const source = row.acquisition_source ?? null;
  const nature = row.asset_nature ?? null;
  const verified = row.rights_verified === true;

  // 1. Competitor media — reference only, always (rule 9, first clause). This
  //    outranks even a blocked-rights value so the reason reads correctly.
  if (source === 'competitor') {
    return {
      selectable_for_production: false,
      needs_rights_confirmation: false,
      reason: 'competitor_reference_only',
      badge: 'reference_only',
    };
  }

  // 2. Blocked rights — never selectable, for anyone.
  if (rights !== null && BLOCKED_RIGHTS.has(rights)) {
    return {
      selectable_for_production: false,
      needs_rights_confirmation: false,
      reason: `rights_${rights}`,
      badge: 'blocked',
    };
  }

  // 3. AI outputs require human review before they are production assets.
  if (nature !== null && AI_NATURES.has(nature) && !verified) {
    return {
      selectable_for_production: false,
      needs_rights_confirmation: true,
      reason: 'ai_output_needs_review',
      badge: 'ai_review',
    };
  }

  // 4. Internal-only is not for customer-facing production.
  if (rights === 'internal_only') {
    return {
      selectable_for_production: false,
      needs_rights_confirmation: false,
      reason: 'internal_only',
      badge: 'reference_only',
    };
  }

  // 5. Verified production-clear rights — the only fully-trusted state.
  if (verified && rights !== null && PRODUCTION_OK_RIGHTS.has(rights)) {
    return {
      selectable_for_production: true,
      needs_rights_confirmation: false,
      reason: 'rights_verified',
      badge: 'verified',
    };
  }

  // 6. Everything else is unclear: no rights value, needs_review, or an
  //    AI-suggested/unknown provenance. Developer/internal assets are still
  //    presented as production candidates (source + verification visible);
  //    anything else waits for a human.
  return {
    selectable_for_production: source !== null && PRODUCTION_CANDIDATE_SOURCES.has(source),
    needs_rights_confirmation: true,
    reason:
      rights === 'needs_review' ? 'rights_needs_review'
      : row.rights_provenance === 'ai_suggested' ? 'rights_ai_suggested'
      : 'rights_unverified',
    badge: 'unverified',
  };
}

// ---------------------------------------------------------------------------
// recheckRightsForFinal — the final-approval rights re-check (rule 9, last
// clause). Reads files_rights_v (which resolves the LATEST usage_rights
// provenance per file) and reports what still blocks or needs a human.
// ---------------------------------------------------------------------------

export interface RightsRecheckItem {
  file_id: string;
  reason: string;
}

export interface RightsRecheckResult {
  /** True only when NOTHING is blocked and NOTHING is unconfirmed. */
  ok: boolean;
  /** restricted / do_not_use — final approval must REFUSE while any exist. */
  blocked: RightsRecheckItem[];
  /** Rights not human-verified — approval needs confirm_unverified_rights. */
  unconfirmed: RightsRecheckItem[];
}

/** The only slice of a Supabase client this needs (tests inject a fake). */
export type RightsReadClient = Pick<SupabaseClient, 'from'>;

/**
 * Re-check rights at final approval. Throws (loudly) on a read error — a
 * rights check that cannot run must never pass silently. A file id ABSENT
 * from files_rights_v counts as unconfirmed ('rights_unknown'), never as ok.
 */
export async function recheckRightsForFinal(
  sb: RightsReadClient,
  fileIds: string[],
): Promise<RightsRecheckResult> {
  const ids = [...new Set(fileIds)];
  const blocked: RightsRecheckItem[] = [];
  const unconfirmed: RightsRecheckItem[] = [];
  if (ids.length === 0) return { ok: true, blocked, unconfirmed };

  const { data, error } = await sb
    .from('files_rights_v')
    .select('file_id, usage_rights, rights_provenance, rights_verified')
    .in('file_id', ids);
  if (error) throw new Error(`rights_blocked: files_rights_v read failed: ${error.message}`);

  const byId = new Map(
    ((data ?? []) as Array<{
      file_id: string;
      usage_rights: string | null;
      rights_provenance: string | null;
      rights_verified: boolean | null;
    }>).map((r) => [r.file_id, r]),
  );

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) {
      unconfirmed.push({ file_id: id, reason: 'rights_unknown' });
      continue;
    }
    if (row.usage_rights !== null && BLOCKED_RIGHTS.has(row.usage_rights)) {
      blocked.push({ file_id: id, reason: `rights_${row.usage_rights}` });
      continue;
    }
    if (row.rights_verified !== true) {
      unconfirmed.push({
        file_id: id,
        reason: row.rights_provenance === 'ai_suggested' ? 'rights_ai_suggested' : 'rights_unverified',
      });
    }
  }
  return { ok: blocked.length === 0 && unconfirmed.length === 0, blocked, unconfirmed };
}
