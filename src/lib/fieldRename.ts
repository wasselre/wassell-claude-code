// Rename a field's `name` slug and propagate the change to every place that
// references it. Pure functions — no store access. The caller commits the
// returned state in a single atomic set().
//
// What gets rewritten:
//   - Record data keys on the renamed field's model.
//   - Formula expressions on the same model (only `{slug}` / `{slug.path}` tokens).
//   - Cross-model `lookup_display_field` on any lookup pointing at this model.
//   - Cross-model `mirror_target_field_name` on any mirror whose sibling lookup
//     targets this model.
//   - Cross-model `section_mirror_field_names` / `..._editable_field_names` /
//     `..._sync_field_names` arrays on any section-mirror whose source section
//     is the renamed field's section.
//   - Workflow conditions, field mappings, dedup/filter/assignment refs, and
//     role conditions — scoped to workflows whose trigger or action target is
//     this model.
//   - View `field_ids` entries that have the virtual-mirror shape
//     `${containerId}${VIRTUAL_FIELD_SEPARATOR}${oldSlug}` on any view.
//
// What doesn't need rewriting (references by UUID, not slug):
//   - view.sort_field_id, view.conditions[].field_id, card_config, ad-hoc
//     filters, section_selector_field_id, auto_id_scope_field_id, and all
//     sibling lookup pointers (mirror_via_lookup_field_id, etc).

import type { AppModel, AppRecord, FieldMapping, ModelField, ModelView, Workflow, WorkflowAction, WorkflowCondition } from '@/types';
import { rewriteFormulaSlug } from './formulaEngine';
import { VIRTUAL_FIELD_SEPARATOR } from './sectionMirrorExpand';

export interface RenameImpact {
  records: number;
  formulas: number;
  lookups: number;
  mirrors: number;
  sectionMirrors: number;
  workflows: number;
  views: number;
  /** Labels of OTHER models whose fields will be touched (cross-model refs) — for display. */
  crossModelLabels: string[];
}

export interface RenameState {
  models: AppModel[];
  records: Record<string, AppRecord[]>;
  workflows: Workflow[];
  views: ModelView[];
}

export interface RenameResult extends RenameState {
  /** Per-table, the ids of rows whose content changed — callers use this to upsert only the deltas. */
  changedModelIds: Set<string>;
  changedRecordIds: Set<string>;
  changedWorkflowIds: Set<string>;
  changedViewIds: Set<string>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function findField(model: AppModel, fieldId: string): ModelField | null {
  for (const s of model.schema.sections) {
    const f = s.fields.find((x) => x.id === fieldId);
    if (f) return f;
  }
  return null;
}

function sectionContainingField(model: AppModel, fieldId: string): string | null {
  for (const s of model.schema.sections) {
    if (s.fields.some((f) => f.id === fieldId)) return s.id;
  }
  return null;
}

/**
 * For a `mirror` or `section_mirror` field on some host model, does its sibling
 * lookup target the given renamed model?
 */
function siblingTargetsModel(
  field: ModelField,
  hostModel: AppModel,
  targetModelId: string,
  viaKey: 'mirror_via_lookup_field_id' | 'section_mirror_via_lookup_field_id',
): boolean {
  const viaId = field[viaKey];
  if (!viaId) return false;
  const sibling = hostModel.schema.sections.flatMap((s) => s.fields).find((f) => f.id === viaId);
  if (!sibling || sibling.type !== 'lookup') return false;
  return sibling.lookup_model_id === targetModelId;
}

// ── Impact counting ──────────────────────────────────────────────────────────

export function countRenameImpact(
  model: AppModel,
  oldSlug: string,
  newSlug: string,
  allModels: AppModel[],
  allRecords: Record<string, AppRecord[]>,
  workflows: Workflow[],
  views: ModelView[],
): RenameImpact {
  if (oldSlug === newSlug) {
    return { records: 0, formulas: 0, lookups: 0, mirrors: 0, sectionMirrors: 0, workflows: 0, views: 0, crossModelLabels: [] };
  }

  const field = model.schema.sections.flatMap((s) => s.fields).find((f) => f.name === oldSlug);
  const sectionId = field ? sectionContainingField(model, field.id) : null;

  let records = 0;
  for (const r of allRecords[model.id] ?? []) {
    if (oldSlug in r.data) records++;
  }

  let formulas = 0;
  for (const s of model.schema.sections) {
    for (const f of s.fields) {
      if (f.type !== 'formula' || !f.formula_expression) continue;
      const rewritten = rewriteFormulaSlug(f.formula_expression, oldSlug, newSlug);
      if (rewritten !== f.formula_expression) formulas++;
    }
  }

  const crossModelLabels = new Set<string>();
  let lookups = 0;
  let mirrors = 0;
  let sectionMirrors = 0;

  for (const other of allModels) {
    if (other.id === model.id) continue;
    for (const s of other.schema.sections) {
      for (const f of s.fields) {
        if (f.type === 'lookup' && f.lookup_model_id === model.id && f.lookup_display_field === oldSlug) {
          lookups++;
          crossModelLabels.add(other.label_en || other.label_ar);
        } else if (f.type === 'mirror' && f.mirror_target_field_name === oldSlug && siblingTargetsModel(f, other, model.id, 'mirror_via_lookup_field_id')) {
          mirrors++;
          crossModelLabels.add(other.label_en || other.label_ar);
        } else if (
          f.type === 'section_mirror' &&
          f.section_mirror_source_section_id === sectionId &&
          siblingTargetsModel(f, other, model.id, 'section_mirror_via_lookup_field_id')
        ) {
          const inNames = f.section_mirror_field_names?.includes(oldSlug) ?? false;
          const inEdit = f.section_mirror_editable_field_names?.includes(oldSlug) ?? false;
          const inSync = f.section_mirror_sync_field_names?.includes(oldSlug) ?? false;
          if (inNames || inEdit || inSync) {
            sectionMirrors++;
            crossModelLabels.add(other.label_en || other.label_ar);
          }
        }
      }
    }
  }

  let workflowCount = 0;
  for (const wf of workflows) {
    if (workflowReferences(wf, model.id, oldSlug)) workflowCount++;
  }

  let viewCount = 0;
  const virtualTail = `${VIRTUAL_FIELD_SEPARATOR}${oldSlug}`;
  for (const v of views) {
    if (v.field_ids.some((id) => id.endsWith(virtualTail))) viewCount++;
  }

  return {
    records,
    formulas,
    lookups,
    mirrors,
    sectionMirrors,
    workflows: workflowCount,
    views: viewCount,
    crossModelLabels: [...crossModelLabels],
  };
}

function mappingFormulaReferences(m: FieldMapping, slug: string): boolean {
  if (m.source_type !== 'formula' || !m.formula_expression) return false;
  return rewriteFormulaSlug(m.formula_expression, slug, '__probe__') !== m.formula_expression;
}

// Does this workflow reference (modelId, slug) anywhere — legacy flat shape or
// any branch? Either answers yes and the workflow needs rewriting.
function workflowReferences(wf: Workflow, modelId: string, slug: string): boolean {
  const triggersThisModel = wf.trigger_model_id === modelId;
  const pools: { conditions: WorkflowCondition[]; actions: WorkflowAction[] }[] = [
    { conditions: wf.conditions ?? [], actions: wf.actions ?? [] },
    ...(wf.branches ?? []).map((b) => ({ conditions: b.conditions, actions: b.actions })),
  ];
  for (const pool of pools) {
    if (triggersThisModel && pool.conditions.some((c) => c.field_id === slug)) return true;
    for (const a of pool.actions) {
      if (a.type === 'create_record') {
        const targetsThisModel = a.target_model_id === modelId;
        if (targetsThisModel) {
          if (a.field_mappings.some((m) => m.target_field_id === slug)) return true;
          if (a.dedup_target_field_id === slug) return true;
        }
        if (triggersThisModel) {
          if (a.field_mappings.some((m) => m.source_type === 'trigger_field' && m.trigger_field_id === slug)) return true;
          if (a.field_mappings.some((m) => mappingFormulaReferences(m, slug))) return true;
        }
      } else if (a.type === 'update_record') {
        const targetsThisModel = a.target_model_id === modelId;
        if (targetsThisModel) {
          if (a.filter_field_id === slug) return true;
          if (a.field_mappings.some((m) => m.target_field_id === slug)) return true;
        }
        if (triggersThisModel) {
          if (a.filter_value_source === 'trigger_field' && a.filter_trigger_field_id === slug) return true;
          if (a.field_mappings.some((m) => m.source_type === 'trigger_field' && m.trigger_field_id === slug)) return true;
          if (a.field_mappings.some((m) => mappingFormulaReferences(m, slug))) return true;
        }
      } else if (a.type === 'assign_user') {
        const targetsThisModel = triggersThisModel; // assignment writes onto the trigger record
        if (targetsThisModel && a.assignment_field_id === slug) return true;
      }
    }
  }
  return false;
}

// ── Application (rewrite) ────────────────────────────────────────────────────

export function applyFieldRename(
  modelId: string,
  fieldId: string,
  oldSlug: string,
  newSlug: string,
  state: RenameState,
): RenameResult {
  const noop: RenameResult = {
    ...state,
    changedModelIds: new Set(),
    changedRecordIds: new Set(),
    changedWorkflowIds: new Set(),
    changedViewIds: new Set(),
  };
  if (oldSlug === newSlug) return noop;

  const origModel = state.models.find((m) => m.id === modelId);
  if (!origModel) return noop;
  const origField = findField(origModel, fieldId);
  if (!origField || origField.name !== oldSlug) return noop;
  const sectionId = sectionContainingField(origModel, fieldId);

  const changedModelIds = new Set<string>();
  const changedRecordIds = new Set<string>();
  const changedWorkflowIds = new Set<string>();
  const changedViewIds = new Set<string>();

  // ── 1. Rewrite THIS model: field.name + formula expressions on siblings ──
  const nextThisModel: AppModel = {
    ...origModel,
    schema: {
      ...origModel.schema,
      sections: origModel.schema.sections.map((s) => ({
        ...s,
        fields: s.fields.map((f) => {
          let next: ModelField = f;
          if (f.id === fieldId) next = { ...next, name: newSlug };
          if (f.type === 'formula' && f.formula_expression) {
            const rewritten = rewriteFormulaSlug(f.formula_expression, oldSlug, newSlug);
            if (rewritten !== f.formula_expression) next = { ...next, formula_expression: rewritten };
          }
          return next;
        }),
      })),
    },
    updated_at: new Date().toISOString(),
  };
  if (nextThisModel !== origModel) changedModelIds.add(modelId);

  // ── 2. Rewrite OTHER models: lookups, mirrors, section-mirrors pointing here ──
  const nextModels = state.models.map((m) => {
    if (m.id === modelId) return nextThisModel;
    let modelChanged = false;
    const nextSections = m.schema.sections.map((s) => ({
      ...s,
      fields: s.fields.map((f) => {
        if (f.type === 'lookup' && f.lookup_model_id === modelId && f.lookup_display_field === oldSlug) {
          modelChanged = true;
          return { ...f, lookup_display_field: newSlug };
        }
        if (
          f.type === 'mirror' &&
          f.mirror_target_field_name === oldSlug &&
          siblingTargetsModel(f, m, modelId, 'mirror_via_lookup_field_id')
        ) {
          modelChanged = true;
          return { ...f, mirror_target_field_name: newSlug };
        }
        if (
          f.type === 'section_mirror' &&
          f.section_mirror_source_section_id === sectionId &&
          siblingTargetsModel(f, m, modelId, 'section_mirror_via_lookup_field_id')
        ) {
          const rename = (arr: string[] | undefined) =>
            arr ? arr.map((n) => (n === oldSlug ? newSlug : n)) : arr;
          const nextNames = rename(f.section_mirror_field_names);
          const nextEdit = rename(f.section_mirror_editable_field_names);
          const nextSync = rename(f.section_mirror_sync_field_names);
          const changed =
            nextNames !== f.section_mirror_field_names ||
            nextEdit !== f.section_mirror_editable_field_names ||
            nextSync !== f.section_mirror_sync_field_names;
          if (changed && (
            (f.section_mirror_field_names?.includes(oldSlug)) ||
            (f.section_mirror_editable_field_names?.includes(oldSlug)) ||
            (f.section_mirror_sync_field_names?.includes(oldSlug))
          )) {
            modelChanged = true;
            return {
              ...f,
              section_mirror_field_names: nextNames,
              section_mirror_editable_field_names: nextEdit,
              section_mirror_sync_field_names: nextSync,
            };
          }
        }
        return f;
      }),
    }));
    if (modelChanged) {
      changedModelIds.add(m.id);
      return { ...m, schema: { ...m.schema, sections: nextSections }, updated_at: new Date().toISOString() };
    }
    return m;
  });

  // ── 3. Rewrite records: replace data[oldSlug] with data[newSlug] ──
  const nextRecords: Record<string, AppRecord[]> = { ...state.records };
  const modelRecords = state.records[modelId] ?? [];
  if (modelRecords.length > 0) {
    const rewritten = modelRecords.map((r) => {
      if (!(oldSlug in r.data)) return r;
      const { [oldSlug]: moved, ...rest } = r.data;
      changedRecordIds.add(r.id);
      return {
        ...r,
        data: { ...rest, [newSlug]: moved },
        updated_at: new Date().toISOString(),
      };
    });
    nextRecords[modelId] = rewritten;
  }

  // ── 4. Rewrite workflows ──
  const nextWorkflows = state.workflows.map((wf) => {
    if (!workflowReferences(wf, modelId, oldSlug)) return wf;
    const triggersThisModel = wf.trigger_model_id === modelId;

    const rewriteMapping = (m: FieldMapping, targetsThisModel: boolean): FieldMapping => {
      let next = m;
      if (targetsThisModel && m.target_field_id === oldSlug) next = { ...next, target_field_id: newSlug };
      if (triggersThisModel && m.source_type === 'trigger_field' && m.trigger_field_id === oldSlug) {
        next = { ...next, trigger_field_id: newSlug };
      }
      if (triggersThisModel && m.source_type === 'formula' && m.formula_expression) {
        const rewritten = rewriteFormulaSlug(m.formula_expression, oldSlug, newSlug);
        if (rewritten !== m.formula_expression) next = { ...next, formula_expression: rewritten };
      }
      return next;
    };
    const rewriteConditions = (conds: WorkflowCondition[]) =>
      triggersThisModel ? conds.map((c) => (c.field_id === oldSlug ? { ...c, field_id: newSlug } : c)) : conds;
    const rewriteActions = (actions: WorkflowAction[]) => actions.map((a) => {
      if (a.type === 'create_record') {
        const targetsThisModel = a.target_model_id === modelId;
        const mappings = a.field_mappings.map((m) => rewriteMapping(m, targetsThisModel));
        return {
          ...a,
          field_mappings: mappings,
          dedup_target_field_id: targetsThisModel && a.dedup_target_field_id === oldSlug ? newSlug : a.dedup_target_field_id,
        };
      }
      if (a.type === 'update_record') {
        const targetsThisModel = a.target_model_id === modelId;
        const mappings = a.field_mappings.map((m) => rewriteMapping(m, targetsThisModel));
        return {
          ...a,
          filter_field_id: targetsThisModel && a.filter_field_id === oldSlug ? newSlug : a.filter_field_id,
          filter_trigger_field_id: triggersThisModel && a.filter_value_source === 'trigger_field' && a.filter_trigger_field_id === oldSlug ? newSlug : a.filter_trigger_field_id,
          field_mappings: mappings,
        };
      }
      if (a.type === 'assign_user') {
        if (triggersThisModel && a.assignment_field_id === oldSlug) {
          return { ...a, assignment_field_id: newSlug };
        }
      }
      return a;
    });

    const nextConditions = rewriteConditions(wf.conditions ?? []);
    const nextActions = rewriteActions(wf.actions ?? []);
    const nextBranches = wf.branches
      ? wf.branches.map((b) => ({
          ...b,
          conditions: rewriteConditions(b.conditions),
          actions: rewriteActions(b.actions),
        }))
      : wf.branches;

    changedWorkflowIds.add(wf.id);
    return {
      ...wf,
      conditions: nextConditions,
      actions: nextActions,
      branches: nextBranches,
      updated_at: new Date().toISOString(),
    };
  });

  // ── 5. Rewrite views: virtual mirror IDs embedding oldSlug ──
  const virtualTail = `${VIRTUAL_FIELD_SEPARATOR}${oldSlug}`;
  const nextVirtualTail = `${VIRTUAL_FIELD_SEPARATOR}${newSlug}`;
  const nextViews = state.views.map((v) => {
    if (!v.field_ids.some((id) => id.endsWith(virtualTail))) return v;
    const nextFieldIds = v.field_ids.map((id) => (id.endsWith(virtualTail) ? id.slice(0, -virtualTail.length) + nextVirtualTail : id));
    changedViewIds.add(v.id);
    return { ...v, field_ids: nextFieldIds, updated_at: new Date().toISOString() };
  });

  return {
    models: nextModels,
    records: nextRecords,
    workflows: nextWorkflows,
    views: nextViews,
    changedModelIds,
    changedRecordIds,
    changedWorkflowIds,
    changedViewIds,
  };
}
