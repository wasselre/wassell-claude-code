import type { AppModel, AppRecord, ModelField, ModelSection } from '@/types';
import { resolveMirrorTarget, resolveMirrorValueWithTarget, resolveLookupDisplayValue, type MirrorTarget } from './mirrorResolver';

/**
 * Ad-hoc (faceted) per-field filters shown in the Advanced Filter panel above the table.
 *
 * Semantics:
 * - Within a single field with multi-value picks, records pass if the field matches ANY of the
 *   picked values (OR).
 * - Across different fields, records must pass ALL field filters (AND).
 *
 * This is a different shape than the saved-view `WidgetFilterCondition[]` because the
 * view filters are AND-only and can't express "status in {A, B}" in one row.
 * The two layer together: view conditions apply first, then ad-hoc on top.
 */
export type AdhocFieldFilter =
  // dropdown, multiselect, lookup, assignee, section_selector
  // mode 'is' (default): record passes if ANY picked value is in the field.
  // mode 'is_not': record passes if NONE of the picked values is in the field
  // (records with no value for the field also pass — they have none of the picked values).
  | { kind: 'values'; values: string[]; mode?: 'is' | 'is_not' }
  | { kind: 'checkbox'; value: 'true' | 'false' }
  | { kind: 'date_range'; from?: string; to?: string }
  | { kind: 'number_range'; min?: number; max?: number }
  | { kind: 'contains'; query: string }
  // location cascade — selections keyed by level key ('region' | 'city' | 'district').
  // Within a level: OR (any picked id). Across levels: AND (region X AND district Y).
  // A record's location value is the compound { region, city, district } object
  // (scalar in single mode, id[] in multi mode); both shapes are matched.
  | { kind: 'location'; levels: Record<string, string[]> };

/** Full ad-hoc state for one (user, model, view) scope: keyed by field ID. */
export type AdhocFilterState = Record<string, AdhocFieldFilter>;

/** Which ad-hoc filter shape a given field type uses. Null = field type isn't filterable this way. */
export function adhocKindFor(fieldType: ModelField['type']): AdhocFieldFilter['kind'] | null {
  switch (fieldType) {
    case 'dropdown':
    case 'multiselect':
    case 'section_selector':
    case 'lookup':
    case 'assignee':
      return 'values';
    case 'checkbox':
      return 'checkbox';
    case 'date':
    case 'datetime':
      return 'date_range';
    case 'number':
    case 'currency':
      return 'number_range';
    case 'text':
    case 'textarea':
    case 'email':
    case 'phone':
    case 'url':
      return 'contains';
    case 'location':
      return 'location';
    // notes and range are structured — not exposed in the simple ad-hoc panel.
    case 'notes':
    case 'range':
      return null;
    default:
      return null;
  }
}

/**
 * One filterable entry in the ad-hoc panel: a UI-ready field plus, for mirrored fields, the hop
 * needed to read its live value off a linked record.
 */
export interface AdhocFilterableField {
  /**
   * Synthetic field driving the chip + popover. Its `id` is the filter-state key (the real field id
   * for own/scalar-mirror fields; a `<container>::<sourceField>` composite for fields surfaced by a
   * mirrored section or a `section_mirror`, so two mirrors of the same source field never collide).
   * Its `type` / `options` / `lookup_*` carry the value semantics used to render and match.
   */
  field: ModelField;
  /** Resolution hop for mirrored values; `null` for the host model's own stored fields. */
  target: MirrorTarget | null;
}

/**
 * Build a synthetic filter field for a scalar `mirror` field: keep the mirror's own identity (id,
 * slug, labels) so the chip, popover header, and per-field filter state all key off the mirror — but
 * borrow the *value semantics* (type, options, lookup wiring, multi-ness) from the target field it
 * points at. Drops straight into the existing chip/popover/summary code paths, which read
 * `type` / `options` / `lookup_model_id` to decide how to render and match.
 */
function effectiveMirrorFilterField(field: ModelField, target: MirrorTarget): ModelField {
  return {
    ...field,
    type: target.targetField.type,
    options: target.targetField.options,
    lookup_model_id: target.targetField.lookup_model_id ?? null,
    lookup_display_field: target.targetField.lookup_display_field ?? null,
    // Carry the cascade config so a mirrored `location` field renders + matches like the original.
    location_levels: target.targetField.location_levels,
    location_multi: target.targetField.location_multi,
    location_default: target.targetField.location_default,
    // A multi sibling lookup yields an array of mirrored values; so does a multi target field.
    is_multi: !!(target.sibling.is_multi || target.targetField.is_multi),
  };
}

/**
 * Build a synthetic filter field for a child field surfaced by a mirrored section or a
 * `section_mirror`. Identity comes from the source field — its labels are kept as-is so the chip
 * reads as just the field name (e.g. "City"), not "Client info · City". Only the `id` is made unique
 * with the container prefix, so two mirrors of the same source field never collide in the filter
 * state (the prefix never surfaces in the UI).
 */
function mirroredChildFilterField(sourceField: ModelField, keyPrefix: string): ModelField {
  return {
    ...sourceField,
    id: `${keyPrefix}::${sourceField.id}`,
  };
}

/**
 * Resolve a mirror container's hop from schema alone: the sibling `lookup` field on the host model,
 * the model it points at, and the named source section on that model. Shared by mirrored sections
 * (`section.is_mirrored`) and `section_mirror` fields, which wire up the same way.
 */
function resolveSiblingSourceSection(
  viaLookupFieldId: string | null | undefined,
  sourceSectionId: string | null | undefined,
  model: AppModel,
  allModels: AppModel[],
): { sibling: ModelField; targetModel: AppModel; sourceSection: ModelSection } | null {
  if (!viaLookupFieldId || !sourceSectionId) return null;
  const sibling = model.schema.sections.flatMap((s) => s.fields).find((f) => f.id === viaLookupFieldId);
  if (!sibling || sibling.type !== 'lookup' || !sibling.lookup_model_id) return null;
  const targetModel = allModels.find((m) => m.id === sibling.lookup_model_id);
  if (!targetModel) return null;
  const sourceSection = targetModel.schema.sections.find((s) => s.id === sourceSectionId);
  if (!sourceSection) return null;
  return { sibling, targetModel, sourceSection };
}

/** Source-section fields eligible to be mirrored as filters (skip mirror/section concepts; in order). */
function mirroredChildFields(sourceSection: ModelSection): ModelField[] {
  return [...sourceSection.fields]
    .filter((f) => f.type !== 'mirror' && f.type !== 'section_mirror' && f.type !== 'section_selector')
    .sort((a, b) => a.order - b.order);
}

/**
 * The entries a model exposes in the ad-hoc filter panel, in schema order. Own filterable fields
 * pass through (`target: null`). Mirrored values are surfaced too, so users can filter by them just
 * like original fields — e.g. filter Follow-Ups by the linked client's city:
 * - scalar `mirror` fields → the field they point at;
 * - mirrored sections (`section.is_mirrored`) → each filterable field of the source section;
 * - `section_mirror` fields → each included filterable field of the source section.
 *
 * Mirrors whose hop can't be resolved, or whose value type isn't filterable, are omitted.
 */
export function getAdhocFilterableFields(model: AppModel, allModels: AppModel[]): AdhocFilterableField[] {
  const out: AdhocFilterableField[] = [];
  for (const section of model.schema.sections) {
    // Mirrored section: its own fields[] is empty; surface the linked source section's fields.
    if (section.is_mirrored) {
      const resolved = resolveSiblingSourceSection(
        section.mirror_via_lookup_field_id,
        section.mirror_source_section_id,
        model,
        allModels,
      );
      if (!resolved) continue;
      for (const sf of mirroredChildFields(resolved.sourceSection)) {
        if (adhocKindFor(sf.type) === null) continue;
        out.push({
          field: mirroredChildFilterField(sf, section.id),
          target: { sibling: resolved.sibling, targetModel: resolved.targetModel, targetField: sf, multiMode: 'first' },
        });
      }
      continue;
    }

    for (const field of section.fields) {
      if (field.type === 'mirror') {
        const target = resolveMirrorTarget(field, model, allModels);
        if (!target || adhocKindFor(target.targetField.type) === null) continue;
        out.push({ field: effectiveMirrorFilterField(field, target), target });
      } else if (field.type === 'section_mirror') {
        const resolved = resolveSiblingSourceSection(
          field.section_mirror_via_lookup_field_id,
          field.section_mirror_source_section_id,
          model,
          allModels,
        );
        if (!resolved) continue;
        const customMode = (field.section_mirror_field_mode ?? 'all') === 'custom';
        const picked = new Set(field.section_mirror_field_names ?? []);
        for (const sf of mirroredChildFields(resolved.sourceSection)) {
          if (customMode && !picked.has(sf.name)) continue;
          if (adhocKindFor(sf.type) === null) continue;
          out.push({
            field: mirroredChildFilterField(sf, field.id),
            target: { sibling: resolved.sibling, targetModel: resolved.targetModel, targetField: sf, multiMode: 'first' },
          });
        }
      } else if (adhocKindFor(field.type) !== null) {
        out.push({ field, target: null });
      }
    }
  }
  return out;
}

/** True if the filter has any meaningful selection (affects the result set). */
export function isAdhocActive(filter: AdhocFieldFilter | undefined): boolean {
  if (!filter) return false;
  switch (filter.kind) {
    case 'values':
      return filter.values.length > 0;
    case 'checkbox':
      return true;
    case 'date_range':
      return !!(filter.from || filter.to);
    case 'number_range':
      return filter.min != null || filter.max != null;
    case 'contains':
      return filter.query.trim().length > 0;
    case 'location':
      return Object.values(filter.levels).some((ids) => ids.length > 0);
  }
}

function evaluateAdhoc(recordValue: unknown, filter: AdhocFieldFilter): boolean {
  switch (filter.kind) {
    case 'values': {
      if (filter.values.length === 0) return true;
      const isNot = filter.mode === 'is_not';
      let matched: boolean;
      if (Array.isArray(recordValue)) {
        // multiselect / section_selector — "is" passes when ANY picked value is in the array
        matched = (recordValue as unknown[]).some((v) => filter.values.includes(String(v)));
      } else if (recordValue === undefined || recordValue === null) {
        // no value: doesn't match any picked value → fail under "is", pass under "is_not"
        matched = false;
      } else {
        matched = filter.values.includes(String(recordValue));
      }
      return isNot ? !matched : matched;
    }
    case 'checkbox':
      return String(!!recordValue) === filter.value;
    case 'date_range': {
      if (!filter.from && !filter.to) return true;
      if (recordValue === undefined || recordValue === null || recordValue === '') return false;
      const t = new Date(String(recordValue)).getTime();
      if (Number.isNaN(t)) return false;
      if (filter.from && t < new Date(filter.from).getTime()) return false;
      if (filter.to) {
        // Inclusive: treat to as end-of-day if the string is a date only
        const toRaw = filter.to.length <= 10 ? `${filter.to}T23:59:59.999` : filter.to;
        if (t > new Date(toRaw).getTime()) return false;
      }
      return true;
    }
    case 'number_range': {
      if (filter.min == null && filter.max == null) return true;
      const n = Number(recordValue);
      if (Number.isNaN(n)) return false;
      if (filter.min != null && n < filter.min) return false;
      if (filter.max != null && n > filter.max) return false;
      return true;
    }
    case 'contains': {
      if (!filter.query.trim()) return true;
      return String(recordValue ?? '').toLowerCase().includes(filter.query.toLowerCase());
    }
    case 'location': {
      const activeKeys = Object.keys(filter.levels).filter((k) => filter.levels[k]!.length > 0);
      if (activeKeys.length === 0) return true;
      if (!recordValue || typeof recordValue !== 'object' || Array.isArray(recordValue)) return false;
      const compound = recordValue as Record<string, unknown>;
      // AND across levels; within a level, the record's id(s) must intersect the picked ids.
      return activeKeys.every((key) => {
        const want = filter.levels[key]!;
        const stored = compound[key];
        const haveIds = Array.isArray(stored)
          ? stored.map(String)
          : stored === undefined || stored === null || stored === ''
            ? []
            : [String(stored)];
        return haveIds.some((id) => want.includes(id));
      });
    }
  }
}

/**
 * Filter records by ad-hoc per-field filters (AND between fields).
 *
 * Mirrored fields have no stored value on the record — the value lives on a linked record reached
 * through a sibling lookup. For each active mirror filter we resolve the hop once (target model +
 * field) and index that model's records by id once, then read the mirrored value per row. Own fields
 * read straight from `record.data`.
 *
 * A filter whose key no longer maps to a filterable field — a deleted field, or a mirror whose hop
 * broke after the filter was saved — is ignored (the same way a stale filter for any removed field
 * is). Such keys can't be created through the panel (the chip simply isn't offered); this only
 * covers leftover state in localStorage.
 */
export function applyAdhocFilters(
  records: AppRecord[],
  state: AdhocFilterState,
  model: AppModel,
  allModels: AppModel[],
  allRecords: Record<string, AppRecord[]>,
): AppRecord[] {
  const activeEntries = Object.entries(state).filter(([, f]) => isAdhocActive(f));
  if (activeEntries.length === 0) return records;

  // Same descriptors the panel renders — so every filterable thing (own field, scalar mirror,
  // mirrored-section field, section_mirror field) resolves its value the same way it's offered.
  const byKey = new Map(getAdhocFilterableFields(model, allModels).map((d) => [d.field.id, d]));
  // One id→record index per source model, reused across every mirror that targets it.
  const targetIndexCache = new Map<string, Map<string, AppRecord>>();

  type Resolver = { filter: AdhocFieldFilter; getValue: (rec: AppRecord) => unknown };
  const resolvers = activeEntries
    .map(([key, filter]): Resolver | null => {
      const desc = byKey.get(key);
      if (!desc) return null; // field no longer filterable (deleted / mirror broke) → ignore this filter
      if (desc.target) {
        const target = desc.target;
        let index = targetIndexCache.get(target.targetModel.id);
        if (!index) {
          index = new Map((allRecords[target.targetModel.id] ?? []).map((r) => [r.id, r]));
          targetIndexCache.set(target.targetModel.id, index);
        }
        const idx = index;
        return { filter, getValue: (rec) => resolveMirrorValueWithTarget(target, rec.data, idx) };
      }
      const name = desc.field.name;
      return { filter, getValue: (rec) => rec.data?.[name] };
    })
    .filter((r): r is Resolver => r !== null);

  if (resolvers.length === 0) return records;
  return records.filter((rec) => resolvers.every((r) => evaluateAdhoc(r.getValue(rec), r.filter)));
}

/** localStorage key for a (user, model, view) scope. */
export function adhocStorageKey(modelId: string, userId: string, viewId: string | null): string {
  return `wassell_adhoc_${modelId}_${userId}_${viewId ?? 'default'}`;
}

/**
 * Drop filter entries whose key no longer maps to a live filterable field — a field deleted in the
 * Builder, or a model rebuilt with new field ids. Such keys can't be created or cleared through the
 * panel (no chip is rendered for them), so without this they linger in localStorage forever: they
 * inflate the active-filter badge and confuse the user even though `applyAdhocFilters` already skips
 * them when computing results. Returns the same object when nothing was stale (so callers can cheaply
 * detect a no-op).
 */
export function pruneAdhocFilters(
  state: AdhocFilterState,
  model: AppModel,
  allModels: AppModel[],
): AdhocFilterState {
  const liveKeys = new Set(getAdhocFilterableFields(model, allModels).map((d) => d.field.id));
  const keys = Object.keys(state);
  if (keys.every((k) => liveKeys.has(k))) return state;
  const pruned: AdhocFilterState = {};
  for (const k of keys) {
    if (liveKeys.has(k)) pruned[k] = state[k]!;
  }
  return pruned;
}

export function loadAdhocFilters(key: string): AdhocFilterState {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

export function saveAdhocFilters(key: string, state: AdhocFilterState): void {
  try {
    // Drop inactive entries so the stored state stays clean.
    const clean: AdhocFilterState = {};
    for (const [fieldId, filter] of Object.entries(state)) {
      if (isAdhocActive(filter)) clean[fieldId] = filter;
    }
    if (Object.keys(clean).length === 0) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(clean));
    }
  } catch {
    // full / unavailable — ignore
  }
}

/** Short human summary of an active filter, e.g. "A, B, +2" or "≥ 100" or "contains foo". */
export function summarizeAdhoc(
  filter: AdhocFieldFilter,
  field: ModelField,
  isAr: boolean,
  lookup?: {
    records: AppRecord[];
    displayField: string | null;
    // Supplied so a `mirror` display field can be resolved (computed at runtime).
    // Optional — without them a mirror display field reads raw (i.e. empty).
    targetModel?: AppModel | null;
    allModels?: AppModel[];
    allRecords?: Record<string, AppRecord[]>;
  },
  users?: { id: string; name_ar: string; name_en: string }[],
  // Supplied for `location` filters so level ids can be resolved to names.
  locationCtx?: { recordsByModel: Record<string, AppRecord[]>; models: AppModel[] },
): string {
  switch (filter.kind) {
    case 'values': {
      if (filter.values.length === 0) return '';
      const labels = filter.values.map((v) => {
        if (field.type === 'lookup' && lookup) {
          const rec = lookup.records.find((r) => r.id === v);
          if (rec && lookup.displayField) {
            return String(
              resolveLookupDisplayValue(rec, lookup.displayField, {
                targetModel: lookup.targetModel,
                allModels: lookup.allModels,
                allRecords: lookup.allRecords,
              }) ?? v,
            );
          }
          return v;
        }
        if (field.type === 'assignee' && users) {
          const u = users.find((x) => x.id === v);
          if (u) return isAr ? u.name_ar : u.name_en;
        }
        const opt = field.options?.find((o) => o.value === v);
        if (opt) return isAr ? opt.label_ar : opt.label_en;
        return v;
      });
      const joined = labels.length <= 2
        ? labels.join(isAr ? '، ' : ', ')
        : `${labels.slice(0, 2).join(isAr ? '، ' : ', ')} +${labels.length - 2}`;
      return filter.mode === 'is_not' ? `≠ ${joined}` : joined;
    }
    case 'checkbox':
      return filter.value === 'true' ? (isAr ? 'نعم' : 'Yes') : (isAr ? 'لا' : 'No');
    case 'date_range': {
      if (filter.from && filter.to) return `${filter.from} → ${filter.to}`;
      if (filter.from) return `≥ ${filter.from}`;
      if (filter.to) return `≤ ${filter.to}`;
      return '';
    }
    case 'number_range': {
      if (filter.min != null && filter.max != null) return `${filter.min} – ${filter.max}`;
      if (filter.min != null) return `≥ ${filter.min}`;
      if (filter.max != null) return `≤ ${filter.max}`;
      return '';
    }
    case 'contains':
      return filter.query;
    case 'location': {
      const levels = field.location_levels ?? [];
      // Summarize the deepest active level (most specific — usually district).
      for (let i = levels.length - 1; i >= 0; i--) {
        const lv = levels[i]!;
        const ids = filter.levels[lv.key] ?? [];
        if (!ids.length) continue;
        if (!locationCtx) return `${ids.length}`;
        const recs = locationCtx.recordsByModel[lv.model_id] ?? [];
        const m = locationCtx.models.find((mm) => mm.id === lv.model_id) ?? null;
        const names = ids.map((id) => {
          const rec = recs.find((r) => r.id === id);
          if (!rec) return id.slice(0, 8);
          const dv = resolveLookupDisplayValue(rec, lv.display_field, {
            targetModel: m,
            allModels: locationCtx.models,
            allRecords: locationCtx.recordsByModel,
          });
          return dv !== null && dv !== undefined && typeof dv !== 'object' ? String(dv) : id.slice(0, 8);
        });
        return names.length <= 2
          ? names.join(isAr ? '، ' : ', ')
          : `${names.slice(0, 2).join(isAr ? '، ' : ', ')} +${names.length - 2}`;
      }
      return '';
    }
  }
}
