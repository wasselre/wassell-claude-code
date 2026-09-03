/**
 * Static satisfiability of a compiled {@link GeoPreference} (v5 #4).
 *
 * The geometry/universe is INJECTED — this module never hits a database. The
 * caller supplies a {@link SatUniverse} that maps each `geometry_id` to the set
 * of opaque "cells" it covers, the bounded universe of cells, and an inventory
 * count for any cell set. Cells are just addressable units of space (districts,
 * grid tiles, whatever the caller uses); this code only does set algebra on them.
 *
 * Per-group eligibility (v5 #4):
 *   eligible(group) = ∩(required include clauses) − (group-scoped exclusions)
 *   eligible_total  = ∪(eligible HARD groups)      − bounded by the universe
 * Soft groups are ranking-only and never tighten eligibility. With NO hard
 * group, nothing filters, so eligible_total is the whole universe.
 *
 * Classification precedence:
 *   empty eligible set                → 'unsatisfiable_expression'
 *   non-empty but zero inventory      → 'no_current_inventory'
 *   non-empty, has inventory, tiny    → 'spatially_narrow'   (a small area is
 *                                        satisfiable, NOT unsatisfiable)
 *   otherwise                         → 'satisfiable'
 *
 * Pure. Writes to no client record.
 */

import type { GeoPreference, GeoGroup, SatisfiabilityFlag } from './ontology';

export interface SatUniverse {
  /** The bounded universe — every cell that exists. Eligibility is clipped to this. */
  universe: Iterable<string>;
  /** Cells covered by a resolved geometry id. Unknown id ⇒ empty. */
  cellsOf(geometryId: string): Iterable<string>;
  /** How many current-inventory items fall inside the given cells. */
  inventoryIn(cells: ReadonlySet<string>): number;
  /**
   * Cells at/under this count ⇒ 'spatially_narrow'. Default 2. A genuinely
   * empty set is never "narrow" — it is unsatisfiable.
   */
  narrowThreshold?: number;
}

export function classify(pref: GeoPreference, universe: SatUniverse): SatisfiabilityFlag {
  const universeCells = new Set<string>(universe.universe);
  const hardGroups = pref.groups.filter((g) => g.strength === 'hard');

  let eligible: Set<string>;
  if (hardGroups.length === 0) {
    // No hard filter ⇒ the whole (bounded) universe is eligible; soft groups
    // only rank within it.
    eligible = new Set(universeCells);
  } else {
    eligible = new Set<string>();
    for (const g of hardGroups) {
      for (const c of eligibleForGroup(g, universe, universeCells)) eligible.add(c);
    }
  }

  if (eligible.size === 0) return 'unsatisfiable_expression';

  const inventory = universe.inventoryIn(eligible);
  if (inventory <= 0) return 'no_current_inventory';

  const threshold = universe.narrowThreshold ?? 2;
  if (eligible.size <= threshold) return 'spatially_narrow';

  return 'satisfiable';
}

/**
 * eligible(group) = ∩(include clauses) − ∪(exclude clauses), clipped to the
 * universe. Each include clause is an OR over its `anyOf` (union of cells); the
 * clauses AND together (intersection). A group with only exclude clauses starts
 * from the whole universe.
 */
export function eligibleForGroup(
  group: GeoGroup,
  universe: SatUniverse,
  universeCells: ReadonlySet<string>,
): Set<string> {
  const includeClauses = group.clauses.filter((c) => c.op === 'include');
  const excludeClauses = group.clauses.filter((c) => c.op === 'exclude');

  let acc: Set<string>;
  if (includeClauses.length === 0) {
    acc = new Set(universeCells); // "everywhere", then subtract exclusions
  } else {
    acc = clauseCells(includeClauses[0]!, universe, universeCells);
    for (let i = 1; i < includeClauses.length; i++) {
      acc = intersect(acc, clauseCells(includeClauses[i]!, universe, universeCells));
      if (acc.size === 0) break;
    }
  }

  for (const ex of excludeClauses) {
    if (acc.size === 0) break;
    const remove = clauseCells(ex, universe, universeCells);
    for (const c of remove) acc.delete(c);
  }
  return acc;
}

/** Union of the anyOf anchors' cells, clipped to the universe. */
function clauseCells(
  clause: GeoPreference['groups'][number]['clauses'][number],
  universe: SatUniverse,
  universeCells: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const ref of clause.anyOf) {
    for (const c of universe.cellsOf(ref.geometry_id)) {
      if (universeCells.has(c)) out.add(c);
    }
  }
  return out;
}

function intersect(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const c of small) if (big.has(c)) out.add(c);
  return out;
}
