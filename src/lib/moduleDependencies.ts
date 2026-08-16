/**
 * Module data-dependency resolver.
 *
 * A module's record forms / lists routinely DISPLAY data pulled from other
 * modules — through `lookup` fields and the `mirror` / `section_mirror` fields
 * that hop through them. Because cross-module display values resolve client-side
 * against the RLS-filtered record set, a profile that can `view` module X but
 * NOT the modules X mirrors from will see those fields render blank.
 *
 * This resolver answers: "to see everything module X displays, which OTHER
 * modules must also be viewable?" It walks the schema graph deterministically,
 * collecting the target model of every field that RESOLVES its display value
 * against another model's records:
 *
 *   - `lookup` fields contribute their `lookup_model_id` target.
 *   - `location` fields contribute every `location_levels[].model_id` — the
 *     region / city / district geography models. A location field stores geo
 *     record IDs and its human-readable name is resolved against those models'
 *     records (see `geoLocalized` in `projectView.ts`), so they must be
 *     viewable or the location renders "غير متوفر". This is NOT a `lookup`
 *     field, which is why the first cut of this resolver missed it.
 *   - `mirror` / `section_mirror` fields hop through a SIBLING lookup that lives
 *     on the same model — so that sibling's `lookup_model_id` is already counted
 *     when we scan the model's own fields, and anything the mirror surfaces from
 *     the target model is picked up when we recurse into that target.
 *
 * Therefore collecting these per-model targets and recursing into each yields
 * the exact transitive display-dependency closure (e.g. our_projects →
 * all_projects → developers + regions/cities/districts).
 *
 * Pure + side-effect-free. Used by the profile editor to auto-grant read-only
 * "reference" access to a granted module's dependencies. NOT an enforcement
 * path — it only drives the editor's suggested grants.
 */

import type { AppModel } from '@/types';

/** Every other-model target referenced by any field in a model's schema. */
function directModelTargets(model: AppModel): string[] {
  const targets: string[] = [];
  for (const section of model.schema.sections) {
    for (const field of section.fields) {
      // A lookup field (single or multi) points at exactly one target model.
      if (field.type === 'lookup' && field.lookup_model_id) {
        targets.push(field.lookup_model_id);
        continue;
      }
      // A location field resolves each level's name against a geography model
      // declared in location_levels[].model_id (region → city → district). The
      // stored value is only IDs; without view on those models the location
      // name can't resolve. mirror / section_mirror fields carry no own target
      // — they route through a sibling lookup already scanned here, and the
      // target model is reached by recursion.
      if (field.type === 'location' && Array.isArray(field.location_levels)) {
        for (const level of field.location_levels) {
          if (level?.model_id) targets.push(level.model_id);
        }
      }
    }
  }
  return targets;
}

/**
 * Transitive closure of the modules whose data `rootModelId` displays, EXCLUDING
 * the root itself. Returns only model ids that still exist in `models` (a
 * dangling `lookup_model_id` pointing at a deleted model is skipped). Order is
 * deterministic (breadth-first from the root).
 */
export function resolveModelDataDependencies(
  rootModelId: string,
  models: AppModel[],
): string[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const root = byId.get(rootModelId);
  if (!root) return [];

  const seen = new Set<string>([rootModelId]);
  const result: string[] = [];
  const queue: string[] = [rootModelId];

  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    const current = byId.get(currentId);
    if (!current) continue;
    for (const targetId of directModelTargets(current)) {
      if (seen.has(targetId)) continue;
      seen.add(targetId);
      if (!byId.has(targetId)) continue; // dangling reference — skip
      result.push(targetId);
      queue.push(targetId);
    }
  }

  return result;
}
