import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import type {
  TemplateFieldValues,
  TemplateVariableSpec,
  TemplateVariableValue,
} from '@/lib/templateUtils';
import type { AppModel, ModelField } from '@/types';

/**
 * Field types we'll let the user pick as a source for a 'mirror' link.
 * Keep this conservative — mirror values get inserted verbatim into the
 * design prompt, so anything multi-valued or structured produces noise
 * rather than useful copy.
 */
const LINKABLE_PROJECT_FIELD_TYPES = new Set<ModelField['type']>([
  'text', 'textarea', 'number', 'currency', 'email', 'phone', 'url',
  'date', 'datetime', 'dropdown', 'auto_id', 'formula',
]);

interface TemplateVariablesFieldProps {
  /** The marketing_operations model the record belongs to. */
  model: AppModel;
  /** Live form data — read-only here; we only emit through `onChange`. */
  recordData: Record<string, unknown>;
  /** Current stored map keyed by variable name. */
  value: TemplateFieldValues;
  onChange: (next: TemplateFieldValues) => void;
}

/**
 * Renders one input row per variable defined on the linked
 * `design_templates` record. Each row has a source toggle:
 *
 *  - `manual` → typed input matching the variable's type (text/number/currency).
 *  - `mirror` → dropdown of scalar project fields. Selected field's slug is
 *               stored as `mirror_field`; the live mirrored value renders
 *               next to the dropdown read-only.
 *
 * Stored shape (one entry per variable):
 *   { source, value: string|number, mirror_field?: string }
 *
 * On template change: keys not in the new template's variables get dropped;
 * new variables get a default `{ source: 'manual', value: '' }`. Done in a
 * useEffect so we don't mutate during render.
 */
export default function TemplateVariablesField({
  model,
  recordData,
  value,
  onChange,
}: TemplateVariablesFieldProps) {
  const { t: _t } = useTranslation();
  const { language, models, records } = useAppStore();
  const isAr = language === 'ar';

  // Resolve the picked template's variables list. We look up by template id
  // stored in recordData.template (set by the lookup field in section A).
  const templateId = typeof recordData.template === 'string' ? recordData.template : null;
  const templateRecord = useMemo(() => {
    if (!templateId) return null;
    const designTemplatesModel = models.find((m) => m.name === 'design_templates');
    if (!designTemplatesModel) return null;
    const list = records[designTemplatesModel.id] ?? [];
    return list.find((r) => r.id === templateId) ?? null;
  }, [templateId, models, records]);

  const variables: TemplateVariableSpec[] = useMemo(() => {
    if (!templateRecord) return [];
    const raw = templateRecord.data?.variables;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
      .map((row) => ({
        name: typeof row.name === 'string' ? row.name : '',
        label_ar: typeof row.label_ar === 'string' ? row.label_ar : '',
        label_en: typeof row.label_en === 'string' ? row.label_en : '',
        type: (row.type === 'number' || row.type === 'currency' ? row.type : 'text') as TemplateVariableSpec['type'],
      }))
      .filter((v) => v.name.trim() !== '');
  }, [templateRecord]);

  // Resolve the picked project + its fields for the "link" dropdown.
  const projectFields = useMemo(() => {
    const projectFieldOnSelf = model.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => f.type === 'lookup' && f.name === 'project');
    if (!projectFieldOnSelf?.lookup_model_id) return [];
    const projectModel = models.find((m) => m.id === projectFieldOnSelf.lookup_model_id);
    if (!projectModel) return [];
    return projectModel.schema.sections
      .flatMap((s) => s.fields)
      .filter((f) => LINKABLE_PROJECT_FIELD_TYPES.has(f.type));
  }, [model, models]);

  const projectRecord = useMemo(() => {
    const projectId = typeof recordData.project === 'string' ? recordData.project : null;
    if (!projectId) return null;
    const projectFieldOnSelf = model.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => f.type === 'lookup' && f.name === 'project');
    if (!projectFieldOnSelf?.lookup_model_id) return null;
    const list = records[projectFieldOnSelf.lookup_model_id] ?? [];
    return list.find((r) => r.id === projectId) ?? null;
  }, [recordData.project, model, records]);

  // Sync the value map to the current variable list. Drop orphans, init
  // missing rows. We compare keys to detect drift; if anything changed,
  // emit the corrected map. Use refs-style guard via useEffect to avoid
  // infinite loops.
  useEffect(() => {
    if (variables.length === 0 && Object.keys(value).length === 0) return;
    const wanted = new Set(variables.map((v) => v.name));
    const have = Object.keys(value);
    const missing = variables.filter((v) => !(v.name in value));
    const orphans = have.filter((k) => !wanted.has(k));
    if (missing.length === 0 && orphans.length === 0) return;
    const next: TemplateFieldValues = {};
    for (const v of variables) {
      next[v.name] = value[v.name] ?? { source: 'manual', value: '' };
    }
    onChange(next);
  }, [variables, value, onChange]);

  if (!templateId) {
    return (
      <div className="form-input bg-sand/5 text-charcoal/40 italic cursor-not-allowed">
        {isAr ? 'اختر قالباً أولاً' : 'Pick a template first'}
      </div>
    );
  }
  if (!templateRecord) {
    return (
      <div className="form-input bg-sand/5 text-red-400 italic cursor-not-allowed">
        {isAr ? 'القالب المحدد غير موجود — أعد الاختيار' : 'Selected template is missing — pick again'}
      </div>
    );
  }
  if (variables.length === 0) {
    return (
      <div className="form-input bg-sand/5 text-charcoal/40 italic cursor-not-allowed">
        {isAr ? 'هذا القالب لا يحتوي على متغيرات' : 'This template has no variables'}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {variables.map((v) => {
        const entry: TemplateVariableValue = value[v.name] ?? { source: 'manual', value: '' };
        const label = isAr ? v.label_ar || v.name : v.label_en || v.name;
        const handleSourceChange = (source: 'manual' | 'mirror') => {
          onChange({
            ...value,
            [v.name]: { source, value: source === 'manual' ? entry.value : '', mirror_field: source === 'mirror' ? entry.mirror_field : undefined },
          });
        };
        const handleManualValue = (raw: string) => {
          let parsed: string | number = raw;
          if (v.type === 'number' || v.type === 'currency') {
            parsed = raw === '' ? '' : Number(raw);
          }
          onChange({
            ...value,
            [v.name]: { source: 'manual', value: parsed },
          });
        };
        const handleMirrorField = (slug: string) => {
          onChange({
            ...value,
            [v.name]: { source: 'mirror', value: '', mirror_field: slug || undefined },
          });
        };
        const mirroredValue = entry.source === 'mirror' && entry.mirror_field && projectRecord
          ? projectRecord.data?.[entry.mirror_field]
          : undefined;
        return (
          <div key={v.name} className="border border-sand/30 rounded-xl p-3 bg-cream/30">
            <div className="flex items-center justify-between mb-2 gap-2">
              <span className="text-sm font-bold text-charcoal" dir="ltr">
                <code className="font-mono text-xs text-copper">{`{{${v.name}}}`}</code>
                <span className="ms-2">{label}</span>
              </span>
              <div className="inline-flex rounded-lg border border-sand/40 overflow-hidden text-xs">
                <button
                  type="button"
                  onClick={() => handleSourceChange('manual')}
                  className={`px-2 py-1 ${entry.source === 'manual' ? 'bg-copper text-cream' : 'bg-cream/60 text-charcoal/70 hover:bg-cream'}`}
                >
                  {isAr ? 'إدخال يدوي' : 'Manual'}
                </button>
                <button
                  type="button"
                  onClick={() => handleSourceChange('mirror')}
                  className={`px-2 py-1 ${entry.source === 'mirror' ? 'bg-copper text-cream' : 'bg-cream/60 text-charcoal/70 hover:bg-cream'}`}
                >
                  {isAr ? 'ربط بحقل المشروع' : 'Link to project field'}
                </button>
              </div>
            </div>
            {entry.source === 'manual' ? (
              <input
                type={v.type === 'number' || v.type === 'currency' ? 'number' : 'text'}
                value={entry.value === '' || entry.value === undefined ? '' : String(entry.value)}
                onChange={(e) => handleManualValue(e.target.value)}
                className="form-input w-full"
                placeholder={isAr ? 'اكتب القيمة' : 'Type a value'}
              />
            ) : (
              <div className="space-y-1.5">
                <select
                  value={entry.mirror_field ?? ''}
                  onChange={(e) => handleMirrorField(e.target.value)}
                  className="form-input w-full"
                >
                  <option value="">{isAr ? '— اختر حقلاً —' : '— Pick a project field —'}</option>
                  {projectFields.map((pf) => (
                    <option key={pf.id} value={pf.name}>
                      {isAr ? pf.label_ar || pf.name : pf.label_en || pf.name}
                    </option>
                  ))}
                </select>
                {entry.mirror_field && (
                  <div className="text-xs text-charcoal/60 px-2">
                    {projectRecord ? (
                      mirroredValue !== undefined && mirroredValue !== null && mirroredValue !== '' ? (
                        <>
                          <span className="text-charcoal/40">{isAr ? 'القيمة الحالية: ' : 'Current value: '}</span>
                          <span className="font-bold">{String(mirroredValue)}</span>
                        </>
                      ) : (
                        <span className="italic">{isAr ? 'لا توجد قيمة على المشروع' : 'No value on the project'}</span>
                      )
                    ) : (
                      <span className="italic">{isAr ? 'اختر مشروعاً لعرض القيمة' : 'Pick a project to preview the value'}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
