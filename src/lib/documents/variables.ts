/**
 * CRM variables for Wassel Documents.
 *
 * A document containing `{{slug}}` tokens resolves them LIVE from the
 * records linked to it via document↔record relationships (document_links).
 * Tokens stay as plain text in the stored TipTap JSON — the editor displays
 * the resolved value through a non-destructive ProseMirror decoration
 * (CrmVariablesExtension), so values are always fresh: edit the record, and
 * every document that references it shows the new value on next open.
 *
 * Resolution rule: links are walked in the order returned by
 * `listLinksForFile` (newest first); the FIRST linked record that carries a
 * non-empty value for a slug wins. So a doc linked to a client + a project
 * resolves {{client_name}} from the client and {{price_range}} from the
 * project with zero configuration.
 *
 * Project rollups (price_range, area_range, unit counts…) are NEVER stored
 * on the record — they're computed live from units. `rollupRecordForMirror`
 * applies them before field values are read, so {{price_range}} works.
 */

import type { AppModel, AppRecord, ModelField } from '@/types';
import { recordTitle } from './links';
import type { DocumentLink } from './links';

/** One resolvable variable, for the insert popover. */
export interface DocVariable {
  slug: string;
  label: string;
  value: string;
}

/** Variables grouped per linked record, for the insert popover. */
export interface DocVariableGroup {
  linkId: string;
  recordTitle: string;
  modelLabel: string;
  variables: DocVariable[];
}

export interface ResolvedDocVariables {
  /** slug → display value. First linked record carrying the slug wins. */
  values: Record<string, string>;
  groups: DocVariableGroup[];
}

/** Field types whose values can't be rendered as a short inline string. */
const SKIP_TYPES = new Set([
  'notes',
  'table',
  'section_selector',
  'section_mirror',
  'mirror',
  'whatsapp_history',
  'call_history',
  'image',
  'multi_image',
  'video',
  'multi_video',
  'file',
  'multi_file',
  'attachment',
  'multi_link',
]);

export function resolveDocVariables(
  links: DocumentLink[],
  models: AppModel[],
  recordsMap: Record<string, AppRecord[]>,
  isAr: boolean,
): ResolvedDocVariables {
  const values: Record<string, string> = {};
  const groups: DocVariableGroup[] = [];

  for (const link of links) {
    const model = models.find((m) => m.id === link.model_id);
    const rawRecord = (recordsMap[link.model_id] ?? []).find((r) => r.id === link.record_id);
    if (!model || !rawRecord) continue;

    // Project rollups are STORED on the record now (DB trigger), so the raw
    // record already carries price_range / unit counts.
    const record = rawRecord;

    const groupVars: DocVariable[] = [];
    for (const section of model.schema.sections) {
      for (const field of section.fields) {
        if (SKIP_TYPES.has(field.type)) continue;
        const formatted = formatFieldValue(field, record.data[field.name], models, recordsMap, isAr);
        if (formatted === null) continue;
        groupVars.push({
          slug: field.name,
          label: isAr ? field.label_ar : field.label_en,
          value: formatted,
        });
        if (!(field.name in values)) {
          values[field.name] = formatted;
        }
      }
    }
    if (groupVars.length > 0) {
      groups.push({
        linkId: link.id,
        recordTitle: recordTitle(model, record, isAr),
        modelLabel: isAr ? model.label_ar : model.label_en,
        variables: groupVars,
      });
    }
  }

  return { values, groups };
}

/** Render one field value as a short inline string, or null when empty /
 *  unrepresentable. Mirrors the display conventions of the record table. */
function formatFieldValue(
  field: ModelField,
  raw: unknown,
  models: AppModel[],
  recordsMap: Record<string, AppRecord[]>,
  isAr: boolean,
): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const locale = isAr ? 'ar-SA' : 'en-US';

  switch (field.type) {
    case 'dropdown': {
      const opt = field.options?.find((o) => o.value === raw || o.id === raw);
      if (!opt) return typeof raw === 'string' ? raw : null;
      return isAr ? opt.label_ar : opt.label_en;
    }
    case 'multiselect': {
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const labels = raw.map((v) => {
        const opt = field.options?.find((o) => o.value === v || o.id === v);
        return opt ? (isAr ? opt.label_ar : opt.label_en) : String(v);
      });
      return labels.join(isAr ? '، ' : ', ');
    }
    case 'number':
    case 'formula': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(n)) return n.toLocaleString(locale);
      return typeof raw === 'string' ? raw : null;
    }
    case 'currency': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) return typeof raw === 'string' ? raw : null;
      return `${n.toLocaleString(locale)} ${isAr ? 'ر.س' : 'SAR'}`;
    }
    case 'date': {
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) return String(raw);
      return d.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
    }
    case 'datetime': {
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) return String(raw);
      return d.toLocaleString(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
    case 'checkbox':
      return raw ? (isAr ? 'نعم' : 'Yes') : isAr ? 'لا' : 'No';
    case 'range': {
      const r = raw as { min?: unknown; max?: unknown };
      if (typeof r !== 'object') return String(raw);
      const min = r.min !== undefined && r.min !== null && r.min !== '' ? Number(r.min) : null;
      const max = r.max !== undefined && r.max !== null && r.max !== '' ? Number(r.max) : null;
      if (min === null && max === null) return null;
      const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString(locale));
      return `${fmt(min)} – ${fmt(max)}`;
    }
    case 'lookup': {
      const targetModel = models.find((m) => m.id === field.lookup_model_id);
      const ids = Array.isArray(raw) ? raw : [raw];
      const titles = ids
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .map((id) => {
          const rec = (recordsMap[field.lookup_model_id ?? ''] ?? []).find((r) => r.id === id);
          return rec ? recordTitle(targetModel, rec, isAr) : null;
        })
        .filter((x): x is string => !!x);
      return titles.length > 0 ? titles.join(isAr ? '، ' : ', ') : null;
    }
    default: {
      // text / textarea / email / phone / url / auto_id / assignee-ish strings
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
      if (typeof raw === 'number') return raw.toLocaleString(locale);
      return null;
    }
  }
}

/**
 * Token palette for a TEMPLATE author. A template isn't linked to any record,
 * so resolveDocVariables would show the empty state. Instead, derive the
 * available `{{slug}}` tokens from the bound model's schema + its lookup /
 * unit_picker targets (depth 1) + the engine-resolved extras ({{today}},
 * {{client_phone}}). Values are the token text itself (no live record yet), so
 * authors can see and insert the exact slugs that auto-fill at generation time.
 */
export function buildTemplateTokenGroups(
  model: AppModel,
  models: AppModel[],
  isAr: boolean,
): DocVariableGroup[] {
  const groups: DocVariableGroup[] = [];

  const groupFor = (m: AppModel, linkId: string) => {
    const variables: DocVariable[] = [];
    for (const section of m.schema.sections) {
      for (const field of section.fields) {
        if (SKIP_TYPES.has(field.type)) continue;
        variables.push({
          slug: field.name,
          label: isAr ? field.label_ar : field.label_en,
          value: `{{${field.name}}}`,
        });
      }
    }
    if (variables.length > 0) {
      groups.push({
        linkId,
        recordTitle: isAr ? m.label_ar : m.label_en,
        modelLabel: '',
        variables,
      });
    }
  };

  groupFor(model, 'tmpl-self');

  // Depth-1 expansion: lookup targets + the units model behind a unit_picker.
  const seen = new Set<string>([model.id]);
  for (const section of model.schema.sections) {
    for (const field of section.fields) {
      let targetId: string | null | undefined = null;
      if (field.type === 'lookup') targetId = field.lookup_model_id;
      else if (field.type === 'unit_picker') targetId = models.find((m) => m.name === 'units')?.id ?? null;
      if (!targetId || seen.has(targetId)) continue;
      const target = models.find((m) => m.id === targetId);
      if (target) {
        seen.add(target.id);
        groupFor(target, `tmpl-lk-${field.id}`);
      }
    }
  }

  // Engine-resolved tokens (no schema field backs these).
  groups.push({
    linkId: 'tmpl-engine',
    recordTitle: isAr ? 'متغيرات تلقائية' : 'Auto variables',
    modelLabel: '',
    variables: [
      { slug: 'today', label: isAr ? 'تاريخ اليوم' : 'Today', value: '{{today}}' },
      { slug: 'client_phone', label: isAr ? 'جوال العميل' : 'Client phone', value: '{{client_phone}}' },
      { slug: 'sales_rep', label: isAr ? 'ممثل المبيعات' : 'Sales rep', value: '{{sales_rep}}' },
    ],
  });

  return groups;
}
