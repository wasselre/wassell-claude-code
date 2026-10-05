/**
 * Shared shapes for the automated project-update lane (project_update_runs).
 *
 * Every source (a broker portal, a developer page, a WhatsApp group) is turned
 * into the SAME snapshot shape below; one reconciler (reconcile.ts) compares a
 * snapshot with the CRM and produces the patches. Adapters only fetch + parse;
 * they never decide what to write.
 */

export type UnitStatus = 'available' | 'reserved' | 'sold' | 'under_construction';

/** One unit as the SOURCE lists it. Every field except `key` is optional: an
 *  adapter fills only what its source actually states — a missing value means
 *  "the source said nothing", never "clear it". */
export interface SourceUnit {
  /** The source's own id for the unit (portal unit id) — for logs + dedupe. */
  sourceId: string | null;
  /** Join key against CRM `unit_model` (normalised by `normUnitKey`). */
  unitModel: string | null;
  buildingNumber?: string | null;
  /** Block / plot («بلك 494»). */
  block?: string | null;
  unitNumber?: number | null;
  /** A CRM unit code (U-123) or the developer's own unit code, when the
   *  source quotes one. */
  unitCode?: string | null;
  unitType?: string | null;
  status?: UnitStatus | null;
  /** SAR. null/0 = the source shows no price («عند الطلب») → never overwrite. */
  price?: number | null;
  /** Original currency price. These three fields form one provenance tuple;
   *  when supplied, the reconciler writes them with the SAR price. */
  sourcePrice?: number | null;
  sourceCurrency?: string | null;
  sourceFxRate?: number | null;
  area?: number | null;
  sourceNetArea?: number | null;
  sourceTotalArea?: number | null;
  sourceAreaUnit?: 'sqft' | 'sqm' | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  floor?: string | null;
  sourceFloor?: string | null;
  /** Original unit type label (or its id if the source supplies no label). */
  sourceUnitType?: string | null;
  /** Portal type identity for evidence-based mapping; not a CRM type name. */
  sourceUnitTypeId?: string | null;
  description?: string | null;
  planUrl?: string | null;
}

/** One project as the source lists it. */
export interface SourceProject {
  sourceId: string;          // portal project id
  name: string;
  url: string;
  units: SourceUnit[];
  /** Total the source DECLARES (e.g. the «Showing 1 to 12 of N» footer). */
  declaredTotal: number | null;
  /** Free-form extras (district, description…) for creating a NEW project. */
  meta?: Record<string, unknown>;
}

/** A CRM unit row (records.data of the units model, plus id). */
export interface CrmUnit {
  id: string;
  data: Record<string, unknown>;
}

/** What to do when a CRM unit that is still `available` is missing from the
 *  source. Riva lists sold units too, but hides some cards server-side, so its
 *  absence means nothing → 'leave'. A full "available units" price sheet means
 *  everything not on it is gone → 'sold'. */
export type AbsentPolicy = 'leave' | 'sold';

export interface ReconcilePolicy {
  absentAvailable: AbsentPolicy;
  /** Create CRM units for source units that have no CRM match. */
  createMissing: boolean;
  /** Overwrite prices from the source (false for sources whose prices are
   *  marketing "starting from" headlines). */
  updatePrices: boolean;
  /** Status may only move FORWARD (available → reserved → sold), never back.
   *  For a project whose source here is secondary (auto_scope = status_only). */
  forwardOnly?: boolean;
  /** Store the source's own unit id on a unit matched by a weaker key
   *  (default true). Off where the existing keys are already unique and
   *  stable — every backfill write costs a full record save. */
  recordSourceId?: boolean;
  /** A source that never shows reservations (Safa) must not turn a CRM
   *  «reserved» unit back to available just because it still lists it. */
  keepReserved?: boolean;
  /** Opt-in for Binghatti: developer code first, then unit number alone
   *  after stripping leading letters, unique on BOTH sides. Other sources
   *  keep their existing model / building / block matching. */
  matchByUnitNumber?: boolean;
}

export interface UnitPatch {
  kind: 'update';
  unitId: string;
  label: string;          // unit_model / code, for the log
  patch: Record<string, unknown>;
  reasons: string[];
}

export interface UnitCreate {
  kind: 'create';
  label: string;
  data: Record<string, unknown>;
  source: SourceUnit;
}

export interface ReconcileResult {
  updates: UnitPatch[];
  creates: UnitCreate[];
  /** CRM units the source did not list (left untouched under 'leave'). */
  missingFromSource: string[];
  /** Prices the source shows that differ from ours but were NOT written
   *  (policy.updatePrices = false) — reported for a person to judge. */
  priceDiffsNotApplied: Array<{ unit: string; crm: number | null; source: number }>;
  /** New units NOT created because the source lacks one of the four
   *  essentials (area, price, bedrooms, unit type) — reported to the operator. */
  incomplete: Array<{ unit: string; missing: Array<'area' | 'price' | 'bedrooms' | 'unit_type'> }>;
  /** Source units that matched more than one CRM unit — skipped, never guessed. */
  ambiguous: string[];
  stats: {
    sourceUnits: number;
    crmUnits: number;
    /** CRM units not yet sold — an empty source only alarms when these exist. */
    crmUnsold: number;
    matched: number;
    statusChanges: number;
    toSoldOrReserved: number;
    priceChanges: number;
  };
}
