import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type {
  TemplateVariableSpec,
  TemplateVariableValue,
} from '@/lib/templateUtils';
import type { AppModel, ModelField } from '@/types';

/**
 * Stored shape on the marketing-operations record:
 *
 *   record.data.template_field_values = {
 *     [templateId]: {
 *       [variableName]: { source, value, mirror_field? }
 *     }
 *   }
 *
 * One sub-map per template the user has selected. The orchestrator
 * iterates this map per generation when running the three phases.
 */
export type PerTemplateValues = Record<string, TemplateVariableValue>;
export type AllTemplatesValues = Record<string, PerTemplateValues>;

const LINKABLE_PROJECT_FIELD_TYPES = new Set<ModelField['type']>([
  'text', 'textarea', 'number', 'currency', 'email', 'phone', 'url',
  'date', 'datetime', 'dropdown', 'auto_id', 'formula',
]);

interface TemplateVariablesFieldProps {
  /** The marketing_operations model the record belongs to. */
  model: AppModel;
  /** Live form data — read-only here; we only emit through `onChange`. */
  recordData: Record<string, unknown>;
  /** Current stored map keyed by template id → variable name. */
  value: AllTemplatesValues;
  onChange: (next: AllTemplatesValues) => void;
}

interface ResolvedTemplate {
  id: string;
  name: string;
  variables: TemplateVariableSpec[];
}

/**
 * Renders a collapsible section per selected template. Each section
 * shows the template's variables as input rows, identical to the
 * single-template version but indexed by template id.
 *
 * On `recordData.templates` change: drops orphan template-id keys
 * AND drops orphan variable keys within each remaining template.
 * New templates init to an empty map; new variables init to manual.
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

  const templateIds: string[] = useMemo(() => {
    const raw = recordData.templates;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  }, [recordData.templates]);

  const resolvedTemplates: ResolvedTemplate[] = useMemo(() => {
    const dt = models.find((m) => m.name === 'design_templates');
    if (!dt) return [];
    const list = records[dt.id] ?? [];
    return templateIds
      .map((id) => {
        const r = list.find((rec) => rec.id === id);
        if (!r) return null;
        const data = r.data as Record<string, unknown>;
        const name = typeof data.name === 'string' ? data.name : id;
        const rawVars = Array.isArray(data.variables) ? (data.variables as unknown[]) : [];
        const variables: TemplateVariableSpec[] = rawVars
          .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
          .map((row) => ({
            name: typeof row.name === 'string' ? row.name : '',
            label_ar: typeof row.label_ar === 'string' ? row.label_ar : '',
            label_en: typeof row.label_en === 'string' ? row.label_en : '',
            type: (row.type === 'number' || row.type === 'currency' ? row.type : 'text') as TemplateVariableSpec['type'],
          }))
          .filter((v) => v.name.trim() !== '');
        return { id, name, variables };
      })
      .filter((x): x is ResolvedTemplate => x !== null);
  }, [templateIds, models, records]);

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

  // Sync the value map to the current selection. Drop orphan templates
  // AND orphan variables within retained templates. Init missing rows.
  useEffect(() => {
    const wantedTemplateIds = new Set(resolvedTemplates.map((t) => t.id));
    const currentTemplateIds = new Set(Object.keys(value));
    const variablesByTemplate = new Map(
      resolvedTemplates.map((t) => [t.id, new Set(t.variables.map((v) => v.name))]),
    );

    let changed = false;
    const next: AllTemplatesValues = {};

    for (const t of resolvedTemplates) {
      const prev = value[t.id] ?? {};
      const slot: PerTemplateValues = {};
      const wantedVars = variablesByTemplate.get(t.id) ?? new Set<string>();
      for (const v of t.variables) {
        slot[v.name] = prev[v.name] ?? { source: 'manual', value: '' };
        if (!(v.name in prev)) changed = true;
      }
      // Detect dropped variables in prev
      for (const k of Object.keys(prev)) {
        if (!wantedVars.has(k)) changed = true;
      }
      next[t.id] = slot;
      if (!currentTemplateIds.has(t.id)) changed = true;
    }
    // Detect dropped templates
    for (const k of currentTemplateIds) {
      if (!wantedTemplateIds.has(k)) changed = true;
    }
    if (changed) onChange(next);
  }, [resolvedTemplates, value, onChange]);

  if (templateIds.length === 0) {
    return (
      <div className="form-input bg-sand/5 text-charcoal/40 italic cursor-not-allowed">
        {isAr ? 'اختر قالباً واحداً على الأقل' : 'Pick at least one template'}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {resolvedTemplates.map((tpl) => (
        <PerTemplateSection
          key={tpl.id}
          template={tpl}
          values={value[tpl.id] ?? {}}
          onChange={(slot) => onChange({ ...value, [tpl.id]: slot })}
          projectFields={projectFields}
          projectRecord={projectRecord}
          isAr={isAr}
        />
      ))}
    </div>
  );
}

interface PerTemplateSectionProps {
  template: ResolvedTemplate;
  values: PerTemplateValues;
  onChange: (next: PerTemplateValues) => void;
  projectFields: ModelField[];
  projectRecord: { data: Record<string, unknown> } | null;
  isAr: boolean;
}

function PerTemplateSection({
  template,
  values,
  onChange,
  projectFields,
  projectRecord,
  isAr,
}: PerTemplateSectionProps) {
  const [open, setOpen] = useState(true);

  if (template.variables.length === 0) {
    return (
      <div className="border border-sand/40 rounded-xl bg-cream/30 p-3">
        <div className="flex items-center gap-2">
          <Layers size={14} className="text-copper/60" />
          <span className="font-bold text-sm text-charcoal">{template.name}</span>
          <span className="text-xs text-charcoal/40 italic ms-auto">
            {isAr ? 'هذا القالب لا يحتوي على متغيرات' : 'No variables'}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-sand/40 rounded-xl bg-cream/30 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 p-3 hover:bg-cream/50 transition-colors text-start"
      >
        {open ? <ChevronDown size={14} className="text-charcoal/50" /> : <ChevronRight size={14} className="text-charcoal/50" />}
        <Layers size={14} className="text-copper/60" />
        <span className="font-bold text-sm text-charcoal flex-1">{template.name}</span>
        <span className="text-xs text-charcoal/50">
          {isAr ? `${template.variables.length} متغير` : `${template.variables.length} var${template.variables.length === 1 ? '' : 's'}`}
        </span>
      </button>
      {open && (
        <div className="border-t border-sand/30 p-3 space-y-3">
          {template.variables.map((v) => {
            const entry: TemplateVariableValue = values[v.name] ?? { source: 'manual', value: '' };
            const label = isAr ? v.label_ar || v.name : v.label_en || v.name;
            const handleSourceChange = (source: 'manual' | 'mirror') => {
              onChange({
                ...values,
                [v.name]: { source, value: source === 'manual' ? entry.value : '', mirror_field: source === 'mirror' ? entry.mirror_field : undefined },
              });
            };
            const handleManualValue = (raw: string) => {
              let parsed: string | number = raw;
              if (v.type === 'number' || v.type === 'currency') {
                parsed = raw === '' ? '' : Number(raw);
              }
              onChange({ ...values, [v.name]: { source: 'manual', value: parsed } });
            };
            const handleMirrorField = (slug: string) => {
              onChange({
                ...values,
                [v.name]: { source: 'mirror', value: '', mirror_field: slug || undefined },
              });
            };
            const mirroredValue = entry.source === 'mirror' && entry.mirror_field && projectRecord
              ? projectRecord.data?.[entry.mirror_field]
              : undefined;
            return (
              <div key={v.name} className="border border-sand/30 rounded-lg p-3 bg-white">
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
      )}
    </div>
  );
}
