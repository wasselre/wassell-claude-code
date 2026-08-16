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
 * modules must also be viewable?" It walks the schema graph deterministically:
 *
 *   - every `lookup` field contributes its `lookup_model_id` target, and
 *   - `mirror` / `section_mirror` fields hop through a SIBLING lookup that lives
 *     on the same model — so that sibling's `lookup_model_id` is already counted
 *     when we scan the model's own lookup fields.
 *
 * Therefore collecting every `lookup_model_id` on a model, then recursing into
 * each target, yields the exact transitive display-dependency closure (e.g.
 * our_projects → all_projects → units / developers / geography).
 *
 * Pure + side-effect-free. Used by the profile editor to auto-grant read-only
 * "reference" access to a granted module's dependencies. NOT an enforcement
 * path — it only drives the editor's suggested grants.
 */

import type { AppModel } from '@/types';

/** Every `lookup_model_id` referenced by any field in a model's schema. */
function directLookupTargets(model: AppModel): string[] {
  const targets: string[] = [];
  for (const section of model.schema.sections) {
    for (const field of section.fields) {
      // A lookup field (single or multi) points at exactly one target model.
      // mirror / section_mirror fields don't carry their own target — they
      // reference a sibling lookup on THIS model, which is already covered by
      // the sibling's own `lookup_model_id` above. So scanning `lookup_model_id`
      // across all fields is sufficient.
      if (field.type === 'lookup' && field.lookup_model_id) {
        targets.push(field.lookup_model_id);
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
    for (const targetId of directLookupTargets(current)) {
      if (seen.has(targetId)) continue;
      seen.add(targetId);
      if (!byId.has(targetId)) continue; // dangling reference — skip
      result.push(targetId);
      queue.push(targetId);
    }
  }

  return result;
}
