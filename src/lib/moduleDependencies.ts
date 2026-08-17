/**
 * Module data-dependency resolver.
 *
 * A module's record forms / lists routinely DISPLAY data pulled from other
 * modules. Because cross-module display values resolve client-side against the
 * RLS-filtered record set, a profile that can `view` module X but NOT the
 * modules X pulls from will see those fields render blank (or, for an embedded
 * child list, empty). This resolver answers: "to see everything module X
 * displays, which OTHER modules must also be viewable?"
 *
 * It is DERIVED from the schema, not a hand-maintained list of field types —
 * that distinction matters. Two mechanisms, both mechanical:
 *
 *  1. FORWARD references (type-agnostic). Every cross-model reference in this
 *     system is ultimately a model id stored somewhere in a field's definition:
 *     `lookup_model_id` on a lookup, `location_levels[].model_id` on a location
 *     field, and so on. Rather than branch per field type (and forget the next
 *     one added), `collectModelRefs` walks the whole field definition and
 *     harvests every value under a `model_id` / `*_model_id` key. Any field
 *     type — present or future — that references a model this way is covered
 *     with zero new code. `mirror` / `section_mirror` need no special case:
 *     they route through a sibling `lookup` on the SAME model (whose
 *     `lookup_model_id` is already harvested here), and whatever they surface
 *     from the target is reached when we recurse into that target.
 *
 *  2. CHILD (reverse) references. Some pages embed a list of CHILD records whose
 *     link lives on the child, not on this model (e.g. the units inventory on a
 *     project — `units.project → all_projects`). A forward scan can never see
 *     these, so each such relationship is declared as DATA on the parent model
 *     (`schema.displayed_child_models`, by slug) and read here.
 *
 * Collecting both per model and recursing yields the exact transitive display
 * closure (e.g. our_projects → all_projects → developers + regions/cities/
 * districts + units).
 *
 * Pure + side-effect-free. Used by the profile editor to auto-grant read-only
 * "reference" access to a granted module's dependencies. NOT an enforcement
 * path — it only drives the editor's suggested grants.
 */

import type { AppModel } from '@/types';

/**
 * Harvest every model id a value references, by walking it recursively and
 * collecting strings held under a `model_id` or `*_model_id` key. This is what
 * makes forward-reference discovery type-agnostic: it reads the DATA shape of a
 * field definition rather than switching on `field.type`.
 */
function collectModelRefs(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectModelRefs(item, out);
    return;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && v && (key === 'model_id' || key.endsWith('_model_id'))) {
      out.add(v);
    } else if (v && typeof v === 'object') {
      collectModelRefs(v, out);
    }
  }
}

/**
 * Every other-model target a model's records DISPLAY: forward references
 * harvested generically from each field (1), plus declared child modules its
 * pages embed (2). `bySlug` resolves `displayed_child_models` slugs to ids.
 */
function directModelTargets(model: AppModel, bySlug: Map<string, string>): string[] {
  const out = new Set<string>();
  for (const section of model.schema.sections) {
    for (const field of section.fields) {
      collectModelRefs(field, out);
    }
  }
  for (const childSlug of model.schema.displayed_child_models ?? []) {
    const childId = bySlug.get(childSlug);
    if (childId) out.add(childId);
  }
  return [...out];
}

/**
 * Transitive closure of the modules whose data `rootModelId` displays, EXCLUDING
 * the root itself. Returns only model ids that still exist in `models` (a
 * dangling reference to a deleted model is skipped). Order is deterministic
 * (breadth-first from the root).
 */
export function resolveModelDataDependencies(
  rootModelId: string,
  models: AppModel[],
): string[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const bySlug = new Map(models.map((m) => [m.name, m.id]));
  const root = byId.get(rootModelId);
  if (!root) return [];

  const seen = new Set<string>([rootModelId]);
  const result: string[] = [];
  const queue: string[] = [rootModelId];

  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    const current = byId.get(currentId);
    if (!current) continue;
    for (const targetId of directModelTargets(current, bySlug)) {
      if (seen.has(targetId)) continue;
      seen.add(targetId);
      if (!byId.has(targetId)) continue; // dangling reference — skip
      result.push(targetId);
      queue.push(targetId);
    }
  }

  return result;
}
