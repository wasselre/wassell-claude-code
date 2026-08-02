import type { AppModel, AppRecord, ModelField, User } from '@/types';
import { resolveLookupDisplayValue, resolveMirror } from './mirrorResolver';
import { collectViewFields, readExpandedValue, type ExpandedField } from './sectionMirrorExpand';

/**
 * Convert Arabic-Indic (٠-٩, U+0660–U+0669) and Extended / Persian Arabic-Indic
 * (۰-۹, U+06F0–U+06F9) digits to ASCII 0-9 so a query typed in one digit script
 * matches data stored in the other — e.g. typing "١٤" matches "14".
 */
export function normalizeDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 0x30))
    .replace(/[۰-۹]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0x06F0 + 0x30));
}

/**
 * Fold Arabic orthographic variants so a query matches regardless of how the
 * hamza / ta-marbuta / alef-maqsura was typed (bilingual W5). This mirrors the
 * SQL `wassell_search_norm` used by the server-side search index EXACTLY —
 * client-side substring search and server trigram search must fold the same
 * way, or the two disagree on what "الأصيل" matches. SQL:
 *   translate(strip(ـ), 'أإآةى', 'اا هي') + digit unification + lower.
 */
export function foldArabic(input: string): string {
  return input
    .replace(/ـ/g, '')      // strip tatweel (kashida)
    .replace(/[أإآ]/g, 'ا')       // hamza-carrying alef → bare alef
    .replace(/ة/g, 'ه')          // ta-marbuta → heh (matches SQL)
    .replace(/ى/g, 'ي');         // alef-maqsura → yeh
}

/** Lowercase + digit-normalize + Arabic-fold, for case-, digit-script-, and
 *  orthography-insensitive matching. Kept in lockstep with SQL wassell_search_norm. */
export function normalizeForSearch(input: string): string {
  return foldArabic(normalizeDigits(input)).toLowerCase();
}

export interface RecordSearchContext {
  models: AppModel[];
  records: Record<string, AppRecord[]>;
  /** Users, for resolving assignee ids → names (both languages). Optional; when
   *  absent, assignee ids are indexed raw (previous behavior). */
  users?: User[];
  /**
   * Bilingual W5: resolve a record field's TRANSLATION for a language so an
   * English-typed query finds an Arabic-source record (and vice versa). Injected
   * (never imported) so this module stays free of the browser translation store
   * — same server-bundle-safety rule as W0's grouping.ts. Absent ⇒ only source
   * text is indexed (previous behavior, still correct).
   */
  translate?: (entityId: string, fieldPath: string, lang: 'ar' | 'en') => string | null;
}

/**
 * Resolve one expanded field's effective value for a record, plus the field
 * definition to FORMAT it with. Handles the three shapes uniformly:
 *   - mirrored child (`section_mirror`)  → value resolved through the sibling
 *     lookup; format with the source child field (so its dropdown/lookup
 *     options resolve too).
 *   - single `mirror` field              → resolved via `resolveMirror`; format
 *     with the mirror's *target* field (so a mirror of a dropdown/lookup still
 *     resolves to a label).
 *   - ordinary local field               → raw stored value; format with itself.
 */
function resolveExpanded(
  ef: ExpandedField,
  record: AppRecord,
  model: AppModel,
  ctx: RecordSearchContext,
): { value: unknown; field: ModelField } {
  if (ef.kind === 'mirrored') {
    return { value: readExpandedValue(ef, record, ctx.records, model, ctx.models), field: ef.field };
  }
  if (ef.field.type === 'mirror') {
    const res = resolveMirror(ef.field, record.data, ctx.records, ctx.models);
    return { value: res.status === 'ok' ? res.value : undefined, field: res.targetField ?? ef.field };
  }
  return { value: record.data[ef.field.name], field: ef.field };
}

/**
 * Searchable string for ONE expanded field of a record (local, mirrored child,
 * single mirror, lookup, dropdown, …). Used by field-scoped search.
 */
export function buildExpandedFieldSearchText(
  ef: ExpandedField,
  record: AppRecord,
  model: AppModel,
  ctx: RecordSearchContext,
): string {
  const { value, field } = resolveExpanded(ef, record, model, ctx);
  if (value === null || value === undefined || value === '') return '';
  const parts: string[] = [];
  // A value that came from a mirror belongs to a DIFFERENT record — its
  // translation is keyed by that target's id, which we don't resolve here, so
  // leave the entityId undefined (source-only index) for mirrored values. A
  // plain local field's translation is keyed by (this record, this field slug).
  const isLocal = ef.kind !== 'mirrored' && field.type !== 'mirror';
  const entityId = isLocal ? record.id : undefined;
  collectFieldSearchParts(field, value, ctx, parts, entityId);
  return parts.join(' ');
}

/**
 * Searchable string for a record spanning ALL of its fields — local fields,
 * single `mirror` fields, AND `section_mirror` children — resolving the
 * human-readable value wherever the stored value differs from what the user
 * sees (dropdown/multiselect → labels, lookup → linked display value, range →
 * "min max", checkbox → نعم/لا + yes/no). Callers normalize the result (and the
 * query) with {@link normalizeForSearch} and substring-match. Resolving
 * lookups/mirrors is O(linked rows); build this once per record and reuse
 * across keystrokes rather than calling it inside a filter.
 */
export function buildRecordSearchText(
  record: AppRecord,
  model: AppModel,
  ctx: RecordSearchContext,
): string {
  const parts: string[] = [];
  for (const ef of collectViewFields(model, ctx.models)) {
    const text = buildExpandedFieldSearchText(ef, record, model, ctx);
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

/** Push both-language translations of a (record, field-path) into the haystack
 *  when a translate resolver is available. No-op otherwise (source stays). */
function pushTranslations(
  ctx: RecordSearchContext,
  entityId: string | undefined,
  fieldPath: string,
  out: string[],
): void {
  if (!ctx.translate || !entityId) return;
  const ar = ctx.translate(entityId, fieldPath, 'ar');
  const en = ctx.translate(entityId, fieldPath, 'en');
  if (ar) out.push(ar);
  if (en) out.push(en);
}

function collectFieldSearchParts(
  field: ModelField,
  v: unknown,
  ctx: RecordSearchContext,
  out: string[],
  entityId?: string,
): void {
  switch (field.type) {
    case 'dropdown': {
      out.push(String(v));
      const opt = (field.options ?? []).find((o) => o.value === v);
      if (opt) out.push(opt.label_ar, opt.label_en);
      return;
    }
    case 'multiselect':
    case 'section_selector': {
      const arr = Array.isArray(v) ? v : [v];
      for (const val of arr) {
        out.push(String(val));
        const opt = (field.options ?? []).find((o) => o.value === val);
        if (opt) out.push(opt.label_ar, opt.label_en);
      }
      return;
    }
    case 'lookup': {
      if (!field.lookup_model_id || !field.lookup_display_field) return;
      const targetModel = ctx.models.find((m) => m.id === field.lookup_model_id);
      const targets = ctx.records[field.lookup_model_id] ?? [];
      const ids = Array.isArray(v) ? v : [v];
      for (const id of ids) {
        const target = targets.find((r) => r.id === id);
        if (!target) continue;
        const disp = resolveLookupDisplayValue(target, field.lookup_display_field, {
          targetModel: targetModel ?? undefined,
          allModels: ctx.models,
          allRecords: ctx.records,
        });
        if (disp !== null && disp !== undefined && disp !== '') out.push(String(disp));
        // Bilingual W5: also index the LINKED record's translated display name,
        // keyed by the target's own id + display field — so searching a
        // project's English name finds every unit that links to it.
        if (typeof id === 'string') pushTranslations(ctx, id, field.lookup_display_field, out);
      }
      return;
    }
    case 'assignee': {
      // Resolve the assignee id → user name in BOTH languages (the raw uuid is
      // useless to search; the cell shows the name).
      const ids = Array.isArray(v) ? v : [v];
      for (const id of ids) {
        const u = ctx.users?.find((x) => x.id === id);
        if (u) out.push(u.name_ar, u.name_en);
      }
      return;
    }
    case 'location': {
      // Compound { levelKey: id(s) }; resolve each populated level to its geo
      // record's display name (region/city/district are loaded records — the
      // same resolution DynamicCell renders).
      if (!v || typeof v !== 'object' || Array.isArray(v)) return;
      const compound = v as Record<string, unknown>;
      for (const lv of field.location_levels ?? []) {
        const raw = compound[lv.key];
        const ids = Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? [raw] : [];
        const lvModel = ctx.models.find((m) => m.id === lv.model_id);
        for (const id of ids) {
          if (typeof id !== 'string') continue;
          const rec = (ctx.records[lv.model_id] ?? []).find((r) => r.id === id);
          if (!rec) continue;
          const dv = resolveLookupDisplayValue(rec, lv.display_field, {
            targetModel: lvModel ?? undefined,
            allModels: ctx.models,
            allRecords: ctx.records,
          });
          if (dv !== null && dv !== undefined && typeof dv !== 'object') out.push(String(dv));
          // Geo names have official ar/en; index the other-language name too.
          pushTranslations(ctx, id, lv.display_field, out);
        }
      }
      return;
    }
    case 'range': {
      if (v && typeof v === 'object') {
        const r = v as { min?: unknown; max?: unknown };
        if (r.min !== undefined && r.min !== null) out.push(String(r.min));
        if (r.max !== undefined && r.max !== null) out.push(String(r.max));
      } else {
        out.push(String(v));
      }
      return;
    }
    case 'checkbox':
      out.push(v ? 'نعم' : 'لا', v ? 'yes' : 'no');
      return;
    case 'table': {
      if (Array.isArray(v)) {
        for (const row of v) {
          if (row && typeof row === 'object') {
            for (const [cellKey, cell] of Object.entries(row as Record<string, unknown>)) {
              // `_row_id` (W1 element identity) and other system keys must not
              // pollute the search haystack.
              if (cellKey.startsWith('_')) continue;
              if (cell !== null && cell !== undefined && cell !== '' && typeof cell !== 'object') {
                out.push(String(cell));
              }
            }
          }
        }
      }
      return;
    }
    case 'notes': {
      if (Array.isArray(v)) {
        for (const e of v) {
          if (e && typeof e === 'object' && 'text' in (e as object)) {
            out.push(String((e as { text?: unknown }).text ?? ''));
            // Per-entry translation, keyed by the element path (W1 identity).
            const id = (e as { id?: unknown }).id;
            if (typeof id === 'string') pushTranslations(ctx, entityId, `${field.name}[id=${id}]`, out);
          } else if (typeof e !== 'object') {
            out.push(String(e));
          }
        }
      } else if (typeof v !== 'object') {
        out.push(String(v));
      }
      return;
    }
    case 'multi_link': {
      const arr = Array.isArray(v) ? v : [v];
      for (const u of arr) if (typeof u !== 'object') out.push(String(u));
      return;
    }
    case 'unit_picker': {
      // Stored as unit id(s); index each unit's code/number so a search for a
      // unit code matches the parent record.
      const unitModelId = field.unit_picker_unit_model_id ?? ctx.models.find((m) => m.name === 'units')?.id ?? null;
      if (!unitModelId) return;
      const targets = ctx.records[unitModelId] ?? [];
      const ids = Array.isArray(v) ? v : [v];
      for (const id of ids) {
        if (typeof id !== 'string') continue;
        const target = targets.find((r) => r.id === id);
        if (!target) continue;
        const dv = target.data['unit_code'] ?? target.data['unit_number'];
        if (dv !== null && dv !== undefined && dv !== '') out.push(String(dv));
      }
      return;
    }
    default: {
      // text / email / phone / url / textarea / number / currency / formula /
      // auto_id / date / datetime / etc. — stringify scalars; skip unknown
      // object shapes (no meaningful text to search).
      if (typeof v !== 'object') out.push(String(v));
      // Bilingual W5: free-text fields (text / textarea) carry translations —
      // index both languages so a cross-language query matches. Numbers / dates
      // etc. have no translation unit, so this is a no-op for them.
      if ((field.type === 'text' || field.type === 'textarea') && typeof v === 'string') {
        pushTranslations(ctx, entityId, field.name, out);
      }
    }
  }
}
