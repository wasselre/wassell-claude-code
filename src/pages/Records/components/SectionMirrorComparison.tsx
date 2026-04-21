import { useMemo, useState } from 'react';
import { Link2, Plus } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import DynamicField from './DynamicField';
import DynamicCell from './DynamicCell';
import ViewSelector from './ViewSelector';
import ResearchViewEditor from './ResearchViewEditor';
import type { AppModel, AppRecord, ModelField, ModelView } from '@/types';

interface SectionMirrorComparisonProps {
  /** The section_mirror FIELD on the current model. Used for labelling + view scoping. */
  container: ModelField;
  /** The model on the sibling lookup (typically All Projects). */
  sourceModel: AppModel;
  /** The current model of the record being edited (e.g. projects_research). Needed for views scoping. */
  currentModel: AppModel;
  /** The record's own data — used to render record-level fields added as columns. */
  currentRecordData: Record<string, unknown>;
  /** Fields from the current (research) model eligible to be added as columns. Record-level; same value in every row. */
  currentModelFields: ModelField[];
  /** Child fields of the source section to compare across the linked records. */
  includedFields: ModelField[];
  /** Slugs that are editable per the container's edit_mode config. */
  editableFieldNames: Set<string>;
  /** Slugs whose edits sync back to the linked record on save (subset of editableFieldNames). */
  syncFieldNames: Set<string>;
  /** One entry per ID in the sibling's value array (in order). `targetRecord` null = deleted. */
  targets: Array<{ id: string; targetRecord: AppRecord | null }>;
  /** Pending edits to linked target records, keyed by target id. Forwarded from RecordFormPage. */
  pendingOverlay: Record<string, Record<string, unknown>>;
  /** Local overrides stored on this record under formData[container.name]. */
  localOverrides: Record<string, unknown>;
  /** Handler for sync-back edits (writes to linked record on save). */
  onMirrorFieldChange: (targetRecordId: string, fieldName: string, value: unknown) => void;
  /** Handler for non-sync edits (stored in formData[container.name]). Values are local-only overrides. */
  onLocalOverrideChange: (fieldName: string, value: unknown) => void;
  /** Handler for edits on current-model fields added as columns. */
  onCurrentFieldChange: (fieldName: string, value: unknown) => void;
  /** Currently active saved view for this container, or null when "Default view" is selected. */
  activeView: ModelView | null;
  /** Handler for switching views. */
  onSelectView: (viewId: string | null) => void;
}

/**
 * Editable, view-scoped comparison table for a `section_mirror` field whose
 * sibling lookup is multi-select with 2+ linked records.
 *
 * Orientation: **projects are rows, fields are columns** (one row per linked
 * target record, one column per included source-section field). Cells are
 * editable when the container's edit_mode permits; edits sync back to the
 * source record when sync_mode permits, otherwise stored as local overrides
 * on this record under `formData[container.name][targetId][fieldName]`.
 *
 * The saved view (ModelView scoped to this container) scopes:
 *   - columns → view.field_ids (filtered to the container's includedFields)
 *   - rows    → view.project_ids ∩ currently-linked ids ∩ existing records
 *
 * "Default view" (null) shows all included fields and all linked projects.
 */
export default function SectionMirrorComparison({
  container,
  sourceModel,
  currentModel,
  currentRecordData,
  currentModelFields,
  includedFields,
  editableFieldNames,
  syncFieldNames,
  targets,
  pendingOverlay,
  localOverrides,
  onMirrorFieldChange,
  onLocalOverrideChange,
  onCurrentFieldChange,
  activeView,
  onSelectView,
}: SectionMirrorComparisonProps) {
  const { language, records: allRecords, views } = useAppStore();
  const isAr = language === 'ar';

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorView, setEditorView] = useState<ModelView | null>(null);

  // Views scoped to this model + this container.
  const containerViews = useMemo(
    () =>
      views.filter(
        (v) =>
          v.model_id === currentModel.id &&
          (v.research_container_field_id === container.id || v.research_container_field_id == null),
      ),
    [views, currentModel.id, container.id],
  );

  // All candidate columns: source-section (target-origin) + research-model (current-origin).
  // Each entry tags its origin so rendering can branch on where the value comes from.
  interface ColumnCandidate {
    field: ModelField;
    origin: 'target' | 'current';
  }
  const allCandidates: ColumnCandidate[] = useMemo(
    () => [
      ...includedFields.map((f) => ({ field: f, origin: 'target' as const })),
      ...currentModelFields.map((f) => ({ field: f, origin: 'current' as const })),
    ],
    [includedFields, currentModelFields],
  );

  // Columns filtered by the active view's field_ids (preserving view order).
  // Default view shows all candidates.
  const visibleFields: ColumnCandidate[] = useMemo(() => {
    if (!activeView?.field_ids?.length) return allCandidates;
    const byId = new Map(allCandidates.map((c) => [c.field.id, c]));
    return activeView.field_ids.map((id) => byId.get(id)).filter((c): c is ColumnCandidate => !!c);
  }, [allCandidates, activeView]);

  // Rows filtered by the active view's project_ids ∩ currently linked ∩ existing.
  const visibleTargets = useMemo(() => {
    if (!activeView?.project_ids?.length) return targets;
    const picked = new Set(activeView.project_ids);
    return targets.filter((t) => picked.has(t.id));
  }, [targets, activeView]);

  const resolveTargetLabel = (record: AppRecord | null, fallbackId: string): string => {
    if (!record) return isAr ? 'سجل محذوف' : 'Deleted record';
    const titleFieldId = sourceModel.card_config?.title_field_id ?? null;
    const titleField = titleFieldId
      ? sourceModel.schema.sections.flatMap((s) => s.fields).find((f) => f.id === titleFieldId)
      : null;
    if (titleField) {
      const v = record.data[titleField.name];
      if (typeof v === 'string' || typeof v === 'number') return String(v);
    }
    return `#${fallbackId.slice(0, 6)}`;
  };

  const effectiveValueFor = (targetId: string, targetRecord: AppRecord | null, field: ModelField): unknown => {
    if (!targetRecord) return undefined;
    const willSync = syncFieldNames.has(field.name);
    if (willSync) {
      // sync path: source record's data + pending overlay for this target.
      const overlay = pendingOverlay[targetId] ?? {};
      return field.name in overlay ? overlay[field.name] : targetRecord.data[field.name];
    }
    // local path: local overrides keyed by [targetId][fieldName] on this research record.
    const perTarget = (localOverrides?.[targetId] as Record<string, unknown> | undefined) ?? {};
    if (field.name in perTarget) return perTarget[field.name];
    return targetRecord.data[field.name];
  };

  const handleCellChange = (targetId: string, fieldName: string, value: unknown) => {
    if (syncFieldNames.has(fieldName)) {
      onMirrorFieldChange(targetId, fieldName, value);
    } else {
      // Update the nested local-override map: { [targetId]: { [fieldName]: value } }
      const perTarget = (localOverrides?.[targetId] as Record<string, unknown> | undefined) ?? {};
      const nextPerTarget = { ...perTarget, [fieldName]: value };
      const nextMap: Record<string, unknown> = { ...localOverrides, [targetId]: nextPerTarget };
      onLocalOverrideChange(targetId, nextMap);
    }
  };

  const openCreateView = () => {
    setEditorView(null);
    setEditorOpen(true);
  };

  const openEditView = (view: ModelView) => {
    setEditorView(view);
    setEditorOpen(true);
  };

  return (
    <div className="col-span-12">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-copper/80 bg-copper/8 px-2 py-0.5 rounded-full">
          <Link2 size={10} />
          {isAr ? 'مقارنة' : 'Comparison'}
        </span>
        <span className="text-[11px] text-charcoal/50">
          {isAr
            ? `${visibleTargets.length} مشاريع × ${visibleFields.length} حقول`
            : `${visibleTargets.length} projects × ${visibleFields.length} fields`}
        </span>
        <div className="flex-1" />
        <ViewSelector
          modelId={currentModel.id}
          views={containerViews}
          activeViewId={activeView?.id ?? null}
          onSelect={onSelectView}
          onCreateNew={openCreateView}
          onEdit={openEditView}
        />
      </div>

      {visibleFields.length === 0 ? (
        <div className="rounded-xl border border-dashed border-sand/50 bg-cream/30 px-4 py-8 text-center">
          <p className="text-sm text-charcoal/50 mb-3">
            {isAr ? 'لم تختر أي حقل لهذا العرض.' : 'No fields selected for this view.'}
          </p>
          <button
            onClick={() => activeView && openEditView(activeView)}
            className="pill text-xs text-copper border-copper/30 hover:bg-copper/5"
          >
            <Plus size={12} />
            {isAr ? 'تعديل العرض' : 'Edit view'}
          </button>
        </div>
      ) : visibleTargets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-sand/50 bg-cream/30 px-4 py-8 text-center text-sm text-charcoal/50">
          {isAr ? 'لا توجد مشاريع في هذا العرض.' : 'No projects in this view.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-sand/40 bg-white comparison-table">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-cream/60">
                <th
                  className="text-[11px] font-bold text-charcoal/60 px-3 py-2 text-start sticky start-0 top-0 bg-cream/60 border-b border-sand/40 min-w-[160px] z-20"
                >
                  {isAr ? 'المشروع' : 'Project'}
                </th>
                {visibleFields.map((c) => {
                  const isReadOnly = c.origin === 'target' && !editableFieldNames.has(c.field.name);
                  return (
                    <th
                      key={c.field.id}
                      className="text-[12px] font-bold text-chocolate px-3 py-2 text-start sticky top-0 bg-cream/60 border-b border-sand/40 min-w-[160px] z-10"
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="truncate">{isAr ? c.field.label_ar : c.field.label_en}</span>
                        {isReadOnly && (
                          <span
                            className="inline-flex items-center text-[9px] font-bold text-chocolate/60 bg-chocolate/8 px-1.5 py-0.5 rounded-full"
                            title={isAr ? 'للقراءة فقط' : 'Read-only'}
                          >
                            <Link2 size={8} />
                          </span>
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visibleTargets.map((t) => {
                const rowLabel = resolveTargetLabel(t.targetRecord, t.id);
                return (
                  <tr key={t.id} className="border-b border-sand/20 last:border-b-0">
                    <th
                      className="text-[12px] font-semibold text-charcoal/80 px-3 py-2 text-start sticky start-0 bg-white align-top z-10 border-b border-sand/20"
                      title={rowLabel}
                    >
                      <span className="truncate block max-w-[220px]">{rowLabel}</span>
                    </th>
                    {visibleFields.map((c) => {
                      const child = c.field;
                      if (c.origin === 'current') {
                        // Record-level field — same value in every row. Edits go to the
                        // research record's own data via onCurrentFieldChange.
                        const currentValue = currentRecordData[child.name];
                        return (
                          <td key={child.id} className="px-3 py-2 align-top">
                            {child.type === 'url' ? (
                              <DynamicCell
                                field={child}
                                value={currentValue}
                                allRecords={allRecords}
                                recordData={currentRecordData}
                              />
                            ) : (
                              <DynamicField
                                field={child}
                                value={currentValue}
                                onChange={(val) => onCurrentFieldChange(child.name, val)}
                                recordData={currentRecordData}
                                compact
                              />
                            )}
                          </td>
                        );
                      }
                      // origin === 'target' — per-project mirror cell
                      const cellValue = effectiveValueFor(t.id, t.targetRecord, child);
                      const isEditable = !!t.targetRecord && editableFieldNames.has(child.name);
                      const willSync = syncFieldNames.has(child.name);
                      const perTarget = (localOverrides?.[t.id] as Record<string, unknown> | undefined) ?? {};
                      const isOverridden = child.name in perTarget || (pendingOverlay[t.id] && child.name in pendingOverlay[t.id]!);
                      return (
                        <td key={child.id} className="px-3 py-2 align-top">
                          {!t.targetRecord ? (
                            <span className="text-charcoal/30 italic text-xs">
                              {isAr ? 'غير متاح' : 'Unavailable'}
                            </span>
                          ) : child.type === 'url' ? (
                            <DynamicCell
                              field={child}
                              value={cellValue}
                              allRecords={allRecords}
                              recordData={t.targetRecord.data}
                            />
                          ) : isEditable ? (
                            <div className="space-y-1">
                              <DynamicField
                                field={child}
                                value={cellValue}
                                onChange={(val) => handleCellChange(t.id, child.name, val)}
                                recordData={t.targetRecord.data}
                                compact
                              />
                              {isOverridden && (
                                <span
                                  className={`inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                                    willSync
                                      ? 'bg-copper/10 text-copper/80'
                                      : 'bg-sand/35 text-charcoal/60'
                                  }`}
                                >
                                  <Link2 size={9} />
                                  {willSync
                                    ? (isAr ? 'سيتم التزامن' : 'Will sync')
                                    : (isAr ? 'محلي' : 'Local')}
                                </span>
                              )}
                            </div>
                          ) : (
                            <DynamicCell
                              field={child}
                              value={cellValue}
                              allRecords={allRecords}
                              recordData={t.targetRecord.data}
                            />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ResearchViewEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        currentModel={currentModel}
        sourceModel={sourceModel}
        container={container}
        includedFields={includedFields}
        currentModelFields={currentModelFields}
        targets={targets}
        view={editorView}
        onSaved={(v) => {
          onSelectView(v.id);
          setEditorOpen(false);
        }}
      />
    </div>
  );
}
