import { useEffect, useMemo, useState } from 'react';
import { Search, X, ChevronRight, Building2, Home } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import CardView from './CardView';
import type { AppRecord, ModelField } from '@/types';

interface UnitPickerFieldProps {
  field: ModelField;
  value: unknown;
  onChange: (value: unknown) => void;
  /**
   * The live form data of the owning record. Only read to resolve
   * `unit_picker_project_from_field` — the sibling field (e.g. the appointment's
   * own `project_id`) whose project the picker should land on. Optional; when
   * absent the picker behaves as a plain project→unit cascade.
   */
  recordData?: Record<string, unknown>;
}

/** First non-empty string among the given slugs, else null. */
function firstString(data: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * Cascading project → unit picker (field type `unit_picker`).
 *
 * The project step is a FILTER only — it is never stored. The field's value is
 * the selected unit id(s): a `string` when single, `string[]` when `is_multi`.
 * Units are shown as full cards (the unit model's `card_config`) by reusing the
 * existing {@link CardView} in multi-select mode. Only projects that actually
 * own at least one unit are offered.
 *
 * Config (both optional, sensible defaults): `unit_picker_unit_model_id`
 * (defaults to the `units` model) and `unit_picker_project_link_field` (the unit
 * slug whose lookup points at the project, default `project_id`). The project
 * model is derived from that link field's `lookup_model_id`.
 */
export default function UnitPickerField({ field, value, onChange, recordData }: UnitPickerFieldProps) {
  const { models, records, language } = useAppStore();
  const isAr = language === 'ar';

  // Sibling project id (e.g. the appointment's own `project_id`) the picker
  // should default to, so the user selects units "after selecting a project"
  // without a redundant re-pick. Null when unconfigured or the sibling is empty.
  const projectFromField = field.unit_picker_project_from_field;
  const siblingProjectId =
    projectFromField && typeof recordData?.[projectFromField] === 'string' && recordData[projectFromField]
      ? (recordData[projectFromField] as string)
      : null;

  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(siblingProjectId);
  const [projQuery, setProjQuery] = useState('');

  // Follow the form's chosen project: when the sibling project changes, land the
  // picker on it. The user can still browse other projects via "All projects".
  useEffect(() => {
    if (siblingProjectId) setProjectId(siblingProjectId);
  }, [siblingProjectId]);

  // ── Resolve config → unit model, project link field, project model ──
  const unitModelId = field.unit_picker_unit_model_id ?? models.find((m) => m.name === 'units')?.id ?? null;
  const unitModel = useMemo(() => models.find((m) => m.id === unitModelId) ?? null, [models, unitModelId]);
  const linkField = field.unit_picker_project_link_field ?? 'project_id';
  const projectModelId = useMemo(() => {
    const def = unitModel?.schema.sections.flatMap((s) => s.fields).find((f) => f.name === linkField);
    return def?.lookup_model_id ?? null;
  }, [unitModel, linkField]);
  const projectModel = useMemo(() => models.find((m) => m.id === projectModelId) ?? null, [models, projectModelId]);

  const allUnits = unitModelId ? records[unitModelId] ?? [] : [];

  // Projects that own ≥1 unit (the only ones worth offering in step 1).
  const projectsWithUnits = useMemo(() => {
    if (!projectModelId) return [] as AppRecord[];
    const withUnits = new Set<string>();
    for (const u of allUnits) {
      const p = u.data[linkField];
      if (typeof p === 'string' && p) withUnits.add(p);
    }
    return (records[projectModelId] ?? []).filter((p) => withUnits.has(p.id));
  }, [allUnits, linkField, projectModelId, records]);

  // ── Normalize value → selected unit id list (single or multi) ──
  const selectedIds = useMemo<string[]>(() => {
    if (field.is_multi) return Array.isArray(value) ? (value as unknown[]).filter((v): v is string => typeof v === 'string') : [];
    return typeof value === 'string' && value ? [value] : [];
  }, [value, field.is_multi]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const unitLabel = (u: AppRecord) => firstString(u.data, ['unit_code', 'unit_number', 'unit_model']) ?? u.id.slice(0, 8);
  const projectLabel = (p: AppRecord) => firstString(p.data, ['project_name', 'name']) ?? p.id.slice(0, 8);

  const toggleUnit = (id: string) => {
    if (field.is_multi) {
      onChange(selectedSet.has(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
    } else {
      onChange(id);
      setOpen(false);
    }
  };
  const removeUnit = (id: string) => {
    if (field.is_multi) {
      const next = selectedIds.filter((x) => x !== id);
      onChange(next.length > 0 ? next : []);
    } else {
      onChange(undefined);
    }
  };

  if (!unitModel || !projectModel) {
    return <div className="text-sm text-red-400">{isAr ? 'لم يتم إعداد حقل الوحدات' : 'Unit picker not configured'}</div>;
  }

  const unitsForProject = projectId ? allUnits.filter((u) => u.data[linkField] === projectId) : [];

  const toggleAllForProject = () => {
    if (!field.is_multi) return;
    const ids = unitsForProject.map((u) => u.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedSet.has(id));
    if (allSelected) {
      onChange(selectedIds.filter((id) => !ids.includes(id)));
    } else {
      const merged = new Set(selectedIds);
      ids.forEach((id) => merged.add(id));
      onChange(Array.from(merged));
    }
  };

  const filteredProjects = projQuery.trim()
    ? projectsWithUnits.filter((p) => projectLabel(p).toLowerCase().includes(projQuery.trim().toLowerCase()))
    : projectsWithUnits;

  // Resolve from projectsWithUnits first, then the full project list — the
  // sibling-default project may own zero units yet still needs a header label.
  const selectedProject = projectId
    ? projectsWithUnits.find((p) => p.id === projectId)
        ?? (projectModelId ? (records[projectModelId] ?? []).find((p) => p.id === projectId) : undefined)
        ?? null
    : null;

  return (
    <div>
      {/* Selected unit chips */}
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selectedIds.map((id) => {
            const u = allUnits.find((x) => x.id === id);
            return (
              <span
                key={id}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-copper/10 text-copper"
              >
                <Home size={11} />
                {u ? unitLabel(u) : isAr ? 'وحدة محذوفة' : 'Deleted unit'}
                <button type="button" onClick={() => removeUnit(id)} className="hover:opacity-70" aria-label={isAr ? 'إزالة' : 'Remove'}>
                  <X size={12} />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="form-input w-full flex items-center justify-between text-start hover:bg-cream/40 transition-colors"
      >
        <span className={selectedIds.length === 0 ? 'text-charcoal/40' : 'text-charcoal'}>
          {selectedIds.length === 0
            ? isAr ? 'اختر المشروع ثم الوحدات...' : 'Pick a project, then units...'
            : isAr ? `${selectedIds.length} وحدة مختارة` : `${selectedIds.length} unit${selectedIds.length === 1 ? '' : 's'} selected`}
        </span>
        <Home size={16} className="text-copper/60" />
      </button>

      {open && (
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          maxWidth="max-w-4xl"
          title={isAr ? 'اختيار الوحدات' : 'Select Units'}
          footer={
            <Button onClick={() => setOpen(false)}>
              {isAr ? `تم${selectedIds.length ? ` (${selectedIds.length})` : ''}` : `Done${selectedIds.length ? ` (${selectedIds.length})` : ''}`}
            </Button>
          }
        >
          {!projectId ? (
            // ── Step 1: pick a project (only those with units) ──
            <div>
              <p className="text-sm text-charcoal/60 mb-3">
                {isAr ? 'اختر مشروعاً لعرض وحداته' : 'Choose a project to view its units'}
              </p>
              <div className="relative mb-3">
                <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-charcoal/30" />
                <input
                  type="text"
                  value={projQuery}
                  onChange={(e) => setProjQuery(e.target.value)}
                  placeholder={isAr ? 'بحث عن مشروع...' : 'Search projects...'}
                  className="form-input ps-8 text-sm"
                  autoFocus
                />
              </div>
              <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1">
                {filteredProjects.length === 0 ? (
                  <div className="py-10 text-center text-sm text-charcoal/30">
                    {isAr ? 'لا توجد مشاريع بها وحدات' : 'No projects with units'}
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {filteredProjects.map((p) => {
                      const count = allUnits.filter((u) => u.data[linkField] === p.id).length;
                      const selectedHere = allUnits.filter((u) => u.data[linkField] === p.id && selectedSet.has(u.id)).length;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => { setProjectId(p.id); setProjQuery(''); }}
                          className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border border-sand/50 hover:border-copper/40 hover:bg-cream/40 transition-colors text-start"
                        >
                          <span className="flex items-center gap-2.5 min-w-0">
                            <Building2 size={16} className="text-copper shrink-0" />
                            <span className="font-bold text-charcoal truncate">{projectLabel(p)}</span>
                          </span>
                          <span className="flex items-center gap-2 shrink-0">
                            {selectedHere > 0 && (
                              <span className="text-[11px] font-bold text-copper bg-copper/10 rounded-full px-2 py-0.5">
                                {selectedHere} {isAr ? 'مختارة' : 'sel.'}
                              </span>
                            )}
                            <span className="text-xs text-charcoal/40">
                              {count} {isAr ? 'وحدة' : count === 1 ? 'unit' : 'units'}
                            </span>
                            <ChevronRight size={16} className="text-charcoal/30 rtl:rotate-180" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            // ── Step 2: pick units in the chosen project (cards) ──
            <div>
              <button
                type="button"
                onClick={() => setProjectId(null)}
                className="inline-flex items-center gap-1.5 text-sm font-bold text-copper hover:text-terracotta transition-colors mb-3"
              >
                <ChevronRight size={16} className="ltr:rotate-180" />
                {isAr ? 'كل المشاريع' : 'All projects'}
              </button>
              <div className="flex items-center gap-2 mb-3">
                <Building2 size={16} className="text-copper" />
                <h3 className="font-bold text-charcoal">{selectedProject ? projectLabel(selectedProject) : ''}</h3>
              </div>
              <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1">
                {unitsForProject.length === 0 ? (
                  <div className="py-10 text-center text-sm text-charcoal/30">
                    {isAr ? 'لا توجد وحدات في هذا المشروع' : 'No units in this project'}
                  </div>
                ) : field.is_multi ? (
                  <CardView
                    model={unitModel}
                    records={unitsForProject}
                    onCardClick={(r) => toggleUnit(r.id)}
                    selectedIds={selectedSet}
                    onToggleSelect={toggleUnit}
                    onToggleSelectAll={toggleAllForProject}
                  />
                ) : (
                  <CardView
                    model={unitModel}
                    records={unitsForProject}
                    onCardClick={(r) => toggleUnit(r.id)}
                  />
                )}
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
