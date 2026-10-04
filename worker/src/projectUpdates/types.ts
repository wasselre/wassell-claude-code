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
  unitNumber?: number | null;
  unitType?: string | null;
  status?: UnitStatus | null;
  /** SAR. null/0 = the source shows no price («عند الطلب») → never overwrite. */
  price?: number | null;
  area?: number | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  floor?: string | null;
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
  /** Source units that matched more than one CRM unit — skipped, never guessed. */
  ambiguous: string[];
  stats: {
    sourceUnits: number;
    crmUnits: number;
    matched: number;
    statusChanges: number;
    toSoldOrReserved: number;
    priceChanges: number;
  };
}
