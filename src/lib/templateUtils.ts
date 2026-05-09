/**
 * Replace `{{slug}}` tokens in a template string with values from a data
 * record. Missing slugs render as empty string. Object/array values are
 * JSON-stringified so they're at least visible in the substituted output
 * rather than `[object Object]`.
 *
 * Single source of truth — both the marketing-generate orchestrator and
 * `api/run-button-workflow.ts` import from here so the regex never drifts.
 *
 * Slug grammar mirrors a field-name slug: letters, digits, underscores,
 * dots, and hyphens.
 */
export function substituteTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{([\w.-]+)\}\}/g, (_match, slug: string) => {
    const v = data[slug];
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}

// ── Shared shapes for the marketing-operations template_variables field ─

/**
 * Defines one placeholder a template exposes. Stored on the
 * `design_templates` record under the `variables` table field.
 */
export type TemplateVariableType = 'text' | 'number' | 'currency';

export interface TemplateVariableSpec {
  name: string;
  label_ar: string;
  label_en: string;
  type: TemplateVariableType;
}

/**
 * One row of the `template_field_values` map on a marketing-operations
 * record. The user picks a source per variable: 'manual' = type a value
 * directly; 'mirror' = link to a field on the picked project record and
 * resolve at substitution time.
 */
export interface TemplateVariableValue {
  source: 'manual' | 'mirror';
  /** Stored manual value when source='manual'. Ignored for 'mirror'. */
  value: string | number;
  /** Slug of the project field to mirror when source='mirror'. */
  mirror_field?: string;
}

export type TemplateFieldValues = Record<string, TemplateVariableValue>;
