/**
 * Drop mentions from a compiled geography expression — PURE, no IO.
 *
 * The geography ability compiles a conversation into a Boolean tree
 * (`groups` = ranked OR, `clauses` = AND, `anyOf` = OR within a clause) whose
 * leaves are refs named `geo:<evidence id>` — one per mention the customer made.
 * When a rep unticks a line on the chat's location card, that mention's refs
 * are removed here and the result is sent as the `edit` finalExpression to
 * `/api/geo-preference/review`.
 *
 * Rules:
 *  - every `anyOf` ref whose `geometry_id` is `geo:<dropped id>` is removed;
 *  - a clause left with no refs is removed (an empty OR would mean "nothing");
 *  - a group left with no clauses is removed.
 * Refs that do not follow the `geo:<id>` convention are never touched.
 *
 * Structural typing on purpose: this file is imported by BOTH the SPA (the chat
 * card) and the server (`api/_lib/geoPreference/chatCard.ts` re-exports it
 * typed on `GeoPreference`), so it cannot depend on the server ontology module.
 * The input is never mutated.
 */

export interface PrunableRef { geometry_id: string }
export interface PrunableClause<R extends PrunableRef = PrunableRef> { anyOf: R[] }
export interface PrunableGroup<C extends PrunableClause = PrunableClause> { clauses: C[] }
export interface PrunableExpression<G extends PrunableGroup = PrunableGroup> { groups: G[] }

export function pruneGeoExpression<T extends PrunableExpression>(expr: T, dropEvidenceIds: readonly string[]): T {
  const drop = new Set(dropEvidenceIds.map((id) => `geo:${id}`));
  const groups = (Array.isArray(expr.groups) ? expr.groups : [])
    .map((g) => {
      const clauses = (Array.isArray(g.clauses) ? g.clauses : [])
        .map((c) => ({ ...c, anyOf: (Array.isArray(c.anyOf) ? c.anyOf : []).filter((r) => !drop.has(r.geometry_id)) }))
        .filter((c) => c.anyOf.length > 0);
      return { ...g, clauses };
    })
    .filter((g) => g.clauses.length > 0);
  return { ...expr, groups } as T;
}

/** Evidence ids that still have at least one `geo:<id>` ref in the expression. */
export function expressionEvidenceIds(expr: PrunableExpression | null | undefined): string[] {
  const out = new Set<string>();
  for (const g of expr?.groups ?? []) {
    for (const c of g.clauses ?? []) {
      for (const r of c.anyOf ?? []) {
        if (typeof r.geometry_id === 'string' && r.geometry_id.startsWith('geo:')) out.add(r.geometry_id.slice(4));
      }
    }
  }
  return [...out];
}
