/**
 * Project Finder — geography verification classifier (PURE, no I/O).
 *
 * The Project Finder's "exact district match" must be COORDINATE/BOUNDARY
 * verified, never a blind trust of the stored `location.district` id. This module
 * takes a project's coordinates + stored district + the district whose polygon
 * actually CONTAINS the point (resolved by the `districts_for_points` PostGIS RPC)
 * and decides:
 *   - which district id to TRUST for exact matching (`effectiveDistrictId`),
 *   - whether that decision is boundary-verified (`verified`),
 *   - the honest `geoConfidence`,
 *   - and any `mismatchWarnings` / `dataGaps` to surface on the result.
 *
 * The status/confidence recipe MUST stay semantically identical to the SQL view
 * `v_all_projects_geo_integrity` (supabase/migrations/2026-06-28_project_finder_geo.sql).
 * They are two implementations of one recipe — drift = the audit disagrees with
 * what matching does.
 */

export type GeoStatus =
  | 'verified_match' // coords inside a polygon that EQUALS the stored district
  | 'verified_derived' // coords inside a polygon; stored district was empty (derive it)
  | 'mismatch' // coords inside a polygon that DIFFERS from the stored district
  | 'outside_known_districts' // has coords but the point is outside every active polygon
  | 'unverified_no_coords' // no coords, but a stored district exists
  | 'no_geography'; // neither coords nor stored district

export type GeoConfidence = 'high' | 'medium' | 'low';

export interface GeoVerifyInput {
  lat: number | null | undefined;
  lng: number | null | undefined;
  storedDistrictId: string | null | undefined;
  /** District id whose polygon CONTAINS (lat,lng), from districts_for_points;
   *  null when the point is outside every polygon OR coords are absent. */
  polygonDistrictId: string | null | undefined;
}

export interface GeoVerification {
  status: GeoStatus;
  /** The district id to TRUST for exact matching: the polygon-derived district when
   *  coords exist (the source of truth), else the stored district (unverified),
   *  else null. */
  effectiveDistrictId: string | null;
  /** True only when `effectiveDistrictId` is boundary-verified (coords inside a polygon). */
  verified: boolean;
  geoConfidence: GeoConfidence;
  /** Human-readable warnings (e.g. stored ≠ polygon). UI shows them verbatim. */
  mismatchWarnings: string[];
  /** Machine gap codes appended to the project's data_gaps. */
  dataGaps: string[];
}

function hasCoords(lat: unknown, lng: unknown): boolean {
  return typeof lat === 'number' && Number.isFinite(lat) && typeof lng === 'number' && Number.isFinite(lng);
}

function clean(id: string | null | undefined): string | null {
  return typeof id === 'string' && id.trim() !== '' ? id : null;
}

/**
 * Classify one project's geography. Pure & deterministic — same recipe as the
 * SQL audit view. Never throws.
 */
export function classifyGeo(input: GeoVerifyInput): GeoVerification {
  const stored = clean(input.storedDistrictId);
  const polygon = clean(input.polygonDistrictId);
  const coords = hasCoords(input.lat, input.lng);

  // No coordinates → cannot boundary-verify. Match only via the stored district
  // (lower confidence) and record the data gap, per the non-negotiable rule
  // "If project coordinates are missing, allow matching only with lower
  // geo_confidence and clearly record the data gap."
  if (!coords) {
    if (stored) {
      return {
        status: 'unverified_no_coords',
        effectiveDistrictId: stored,
        verified: false,
        geoConfidence: 'medium',
        mismatchWarnings: [],
        dataGaps: ['missing_project_coordinates'],
      };
    }
    return {
      status: 'no_geography',
      effectiveDistrictId: null,
      verified: false,
      geoConfidence: 'low',
      mismatchWarnings: [],
      dataGaps: ['missing_geography'],
    };
  }

  // Has coordinates but the point is outside every known boundary → the stored
  // district can't be confirmed. Allow a stored-district match but flag it.
  if (!polygon) {
    return {
      status: 'outside_known_districts',
      effectiveDistrictId: stored, // fall back to stored (unverifiable)
      verified: false,
      geoConfidence: 'low',
      mismatchWarnings: ['Project coordinates fall outside all known district boundaries — district unverified.'],
      dataGaps: ['coordinates_outside_known_districts'],
    };
  }

  // Coordinates land inside a polygon → that polygon's district is the SOURCE OF
  // TRUTH. We always match against it (never the stored text).
  if (!stored) {
    // Stored district was missing; derive it from the boundary.
    return {
      status: 'verified_derived',
      effectiveDistrictId: polygon,
      verified: true,
      geoConfidence: 'high',
      mismatchWarnings: [],
      dataGaps: [],
    };
  }

  if (stored === polygon) {
    return {
      status: 'verified_match',
      effectiveDistrictId: polygon,
      verified: true,
      geoConfidence: 'high',
      mismatchWarnings: [],
      dataGaps: [],
    };
  }

  // Stored district CONFLICTS with the polygon the point sits in. Trust the
  // coordinates (effective = polygon) but mark the record inconsistent and DO NOT
  // award high confidence — "do not treat it as a trusted exact match" for the
  // stored district. A request for the polygon's district is still a real exact
  // (the pin is there), just flagged.
  return {
    status: 'mismatch',
    effectiveDistrictId: polygon,
    verified: true,
    geoConfidence: 'low',
    mismatchWarnings: [
      'Stored district does not match the district the project coordinates fall in — verify the record.',
    ],
    dataGaps: ['district_mismatch'],
  };
}
