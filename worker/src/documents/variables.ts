/**
 * CRM variable resolution for server-side document generation.
 *
 * ⚠️ KEEP IN SYNC with src/lib/documents/variables.ts (resolveDocVariables /
 * formatFieldValue / recordTitle) and the replaceTextTokens walk in
 * src/lib/documents/templates.ts. The worker is a standalone npm package and
 * CANNOT import from src/* — same COPY posture as worker/src/imageGen.ts. The
 * generated PDF MUST format values identically to the editor's live preview, so
 * these conventions (dropdown→option label, currency→localized + ر.س,
 * range→min–max, lookup→target title, first-link-wins) must not drift.
 *
 * Types are intentionally minimal/structural copies of the app's AppModel /
 * AppRecord / ModelField so the worker stays dependency-free.
 */

// ─── Minimal structural types (subset of src/types) ────────────────────────

export interface DocOption {
  id: string;
  value: string;
  label_ar: string;
  label_en: string;
}

export interface DocField {
  id: string;
  name: string;
  type: string;
  label_ar: string;
  label_en: string;
  options?: DocOption[];
  lookup_model_id?: string | null;
}

export interface DocModel {
  id: string;
  name: string;
  label_ar: string;
  label_en: string;
  schema: { sections: Array<{ fields: DocField[] }> };
}

export interface DocRecord {
  id: string;
  data: Record<string, unknown>;
}

export interface DocLink {
  id: string;
  model_id: string;
  record_id: string;
}

export interface ResolvedDocVariables {
  /** slug → display value. First linked record carrying the slug wins. */
  values: Record<string, string>;
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
  'file',
  'multi_file',
  'attachment',
  'multi_link',
]);

export function resolveDocVariables(
  links: DocLink[],
  models: DocModel[],
  recordsMap: Record<string, DocRecord[]>,
  isAr: boolean,
): ResolvedDocVariables {
  const values: Record<string, string> = {};

  for (const link of links) {
    const model = models.find((m) => m.id === link.model_id);
    const record = (recordsMap[link.model_id] ?? []).find((r) => r.id === link.record_id);
    if (!model || !record) continue;

    for (const section of model.schema.sections) {
      for (const field of section.fields) {
        if (SKIP_TYPES.has(field.type)) continue;
        const formatted = formatFieldValue(field, record.data[field.name], models, recordsMap, isAr);
        if (formatted === null) continue;
        // First linked record carrying a non-empty value for a slug wins.
        if (!(field.name in values)) {
          values[field.name] = formatted;
        }
      }
    }
  }

  return { values };
}

/** Render one field value as a short inline string, or null when empty /
 *  unrepresentable. Mirrors the display conventions of the record table. */
export function formatFieldValue(
  field: DocField,
  raw: unknown,
  models: DocModel[],
  recordsMap: Record<string, DocRecord[]>,
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

// ─── Record title heuristic (copy of src/lib/documents/links.ts recordTitle) ─

const TITLE_SLUGS = [
  'client_name',
  'project_name',
  'full_name',
  'name',
  'title',
  'label',
  'unit_number',
  'unit_name',
];

/** Best-effort display title for a record. Never returns empty. */
export function recordTitle(model: DocModel | undefined, record: DocRecord, isAr: boolean): string {
  const data = record.data ?? {};
  for (const slug of TITLE_SLUGS) {
    const v = data[slug];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  if (model) {
    const textField = model.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => {
        if (f.type !== 'text') return false;
        const v = data[f.name];
        return typeof v === 'string' && v.trim().length > 0;
      });
    if (textField) return String(data[textField.name]).trim();
    const label = isAr ? model.label_ar : model.label_en;
    return `${label} · ${record.id.slice(0, 8)}`;
  }
  return record.id.slice(0, 8);
}

// ─── Token replacement (copy of replaceTextTokens in templates.ts) ──────────

/** Walk a TipTap JSON tree replacing {{key}} tokens in text nodes. Only the
 *  provided keys are replaced — unknown tokens are left intact. */
export function replaceTextTokens(node: unknown, vars: Record<string, string>): unknown {
  if (Array.isArray(node)) return node.map((n) => replaceTextTokens(n, vars));
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'text' && typeof v === 'string') {
        out[k] = v.replace(/\{\{(\w+)\}\}/g, (m, key: string) => vars[key] ?? m);
      } else {
        out[k] = replaceTextTokens(v, vars);
      }
    }
    return out;
  }
  return node;
}
