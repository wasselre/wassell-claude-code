import { useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { Shield, Link2, ChevronDown } from 'lucide-react';
import DynamicField from './DynamicField';
import DynamicCell from './DynamicCell';
import CallHistoryPanel from './CallHistoryPanel';
import WhatsAppHistoryPanel from './WhatsAppHistoryPanel';
import { isFieldVisible } from '@/lib/fieldVisibility';
import { resolveSectionMirror } from '@/lib/sectionMirrorResolver';
import { resolveSectionMirrorField } from '@/lib/sectionMirrorFieldResolver';
import { resolveSectionMirrorFieldMulti } from '@/lib/sectionMirrorExpand';
import SectionMirrorComparison from './SectionMirrorComparison';
import type { AppModel, FieldPermission, ModelField, ModelSection, ModelView } from '@/types';

interface SectionBlockProps {
  section: ModelSection;
  formData: Record<string, unknown>;
  onChange: (fieldName: string, value: unknown) => void;
  /** The model this record is being edited under. Needed to resolve mirrored sections. */
  currentModel: AppModel;
  /**
   * Pending edits to linked records inside mirrored sections. Keyed by target record id.
   * Each entry is an overlay on top of that record's current data. Updated via
   * `onMirrorFieldChange` and applied on save.
   */
  mirrorEdits: Record<string, Record<string, unknown>>;
  /** Handler for edits inside mirrored sections. */
  onMirrorFieldChange: (targetRecordId: string, fieldName: string, value: unknown) => void;
  /** Currently active research comparison view (applies to any multi-target section_mirror container on this model). */
  activeResearchView?: ModelView | null;
  /** Handler for switching the active research view. */
  onSelectResearchView?: (viewId: string | null) => void;
  /**
   * Whole-form read-only override. Set when the user lacks the model `edit`
   * permission, the record fails the profile's edit-scope, or `useCanEditRecord`
   * returns false. Forces every field on the section to render as DynamicCell
   * (display-only) regardless of its individual `field_permissions` entry.
   * Defaults to false (no override).
   */
  formReadOnly?: boolean;
  /**
   * Per-field permission resolver. Called once per native field at render
   * time. Mirrored / inline-mirror children are NOT routed through this —
   * they belong to a different model and have their own editable/sync rules
   * that compose with mirror semantics. Defaults to `() => 'editable'`.
   */
  getFieldPermission?: (field: ModelField) => FieldPermission;
  /**
   * Current record's id. Required for the `whatsapp_history` field type
   * (the panel needs the id to find chat records via `client_link`). Optional
   * because we can't pass it for /new (no record id yet) — those field types
   * render an empty state until the record is saved.
   */
  recordId?: string;
}

function widthClass(width: ModelField['width']): string {
  return width === 'full'
    ? 'col-span-12'
    : width === 'half'
      ? 'col-span-12 sm:col-span-6'
      : 'col-span-12 sm:col-span-4';
}

function MirroredBadge({ isAr, tone = 'muted' }: { isAr: boolean; tone?: 'muted' | 'synced' | 'local' }) {
  const cls =
    tone === 'synced'
      ? 'bg-copper/10 text-copper/80'
      : tone === 'local'
        ? 'bg-sand/35 text-charcoal/60'
        : 'bg-chocolate/8 text-chocolate/70';
  const label =
    tone === 'synced'
      ? (isAr ? 'متزامن' : 'Synced')
      : tone === 'local'
        ? (isAr ? 'محلي' : 'Local')
        : (isAr ? 'مرآة' : 'Mirrored');
  return (
    <span className={`inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full ${cls}`}>
      <Link2 size={9} />
      {label}
    </span>
  );
}

export default function SectionBlock({
  section,
  formData,
  onChange,
  currentModel,
  mirrorEdits,
  onMirrorFieldChange,
  activeResearchView,
  onSelectResearchView,
  formReadOnly,
  getFieldPermission,
  recordId,
}: SectionBlockProps) {
  const { language, records, models } = useAppStore();
  const isAr = language === 'ar';
  const [collapsed, setCollapsed] = useState<boolean>(!!section.default_collapsed);

  // Conditional units-derived fields (e.g. all_projects.unit_types) render
  // read-only whenever this project has linked units — the DB trigger
  // (`recalc_project_rollups_data`) derives their value from the units, so
  // manual editing is disabled to avoid a value the next save would overwrite.
  // With NO linked units the field stays manually editable. Only computed when
  // a field on this section actually opts in via `auto_from_units`.
  const projectHasLinkedUnits = useMemo(() => {
    if (!section.fields.some((f) => f.auto_from_units)) return false;
    // 1) Authoritative: the stored units-count rollup on this record. It is
    //    present on every project row (the rollup trigger maintains it) and is
    //    unaffected by the viewer's unit-level RLS.
    const countField = currentModel.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => f.rollup_kind === 'units_count');
    if (countField) {
      const n = Number(formData[countField.name]);
      if (Number.isFinite(n) && n > 0) return true;
    }
    // 2) Fallback for units linked in this session but not yet rolled up:
    //    count units whose project lookup points at this record.
    if (!recordId) return false;
    const unitsModel = models.find((m) => m.name === 'units');
    if (!unitsModel) return false;
    const lookupFields = unitsModel.schema.sections
      .flatMap((s) => s.fields)
      .filter((f) => f.type === 'lookup' && f.lookup_model_id === currentModel.id);
    if (lookupFields.length === 0) return false;
    return (records[unitsModel.id] ?? []).some((r) =>
      lookupFields.some((f) => {
        const v = (r.data as Record<string, unknown>)[f.name];
        return Array.isArray(v) ? v.includes(recordId) : v === recordId;
      }),
    );
  }, [section.fields, currentModel, formData, models, records, recordId]);

  const header = (
    <button
      type="button"
      onClick={() => setCollapsed((c) => !c)}
      aria-expanded={!collapsed}
      className="w-full px-6 py-4 flex items-center gap-2.5 text-start hover:bg-sand/10 transition-colors cursor-pointer"
      style={{ borderInlineStartWidth: '4px', borderInlineStartColor: section.color ?? '#B8734F' }}
    >
      <span className="font-bold text-chocolate text-base flex-1">
        {isAr ? section.label_ar : section.label_en}
      </span>
      {section.is_base && <Shield size={13} className="text-copper/40" />}
      {section.is_mirrored && (
        <span className="inline-flex items-center gap-1 text-[10px] text-copper/70 bg-copper/8 px-2 py-0.5 rounded-full font-bold">
          <Link2 size={10} />
          {isAr ? 'منسوخ' : 'Mirrored'}
        </span>
      )}
      <ChevronDown
        size={16}
        className={`text-charcoal/35 transition-transform ${collapsed ? '-rotate-90 rtl:rotate-90' : ''}`}
      />
    </button>
  );

  // ── Mirrored section ──
  if (section.is_mirrored) {
    const res = resolveSectionMirror(section, formData, currentModel, records, models);

    if (res.status === 'sibling_not_selected') {
      return (
        <div className="section-block">
          {header}
          {!collapsed && (
            <div className="px-6 pb-6 text-sm text-charcoal/40 italic">
              {isAr ? 'اختر السجل المرتبط أولاً لعرض البيانات هنا.' : 'Select the linked record first to view its data here.'}
            </div>
          )}
        </div>
      );
    }

    if (res.status === 'target_record_missing') {
      return (
        <div className="section-block">
          {header}
          {!collapsed && (
            <div className="px-6 pb-6 text-sm text-red-400 italic">
              {isAr ? 'السجل المرتبط محذوف.' : 'The linked record has been deleted.'}
            </div>
          )}
        </div>
      );
    }

    if (res.status !== 'ok' || !res.sourceSection || !res.targetRecord || !res.targetModel) {
      return (
        <div className="section-block">
          {header}
          {!collapsed && (
            <div className="px-6 pb-6 text-sm text-amber-500 italic">
              {isAr ? 'إعدادات القسم المنسوخ غير مكتملة.' : 'Mirrored section is not fully configured.'}
            </div>
          )}
        </div>
      );
    }

    const targetRecord = res.targetRecord;
    const overlay = mirrorEdits[targetRecord.id] ?? {};
    const effectiveData = { ...targetRecord.data, ...overlay };
    // Skip model-local field types that don't survive mirroring cleanly.
    const sortedFields = [...res.sourceSection.fields]
      .filter((f) => f.type !== 'section_mirror' && f.type !== 'section_selector')
      .sort((a, b) => a.order - b.order);
    const targetLabel = (() => {
      const titleFieldId = res.targetModel.card_config?.title_field_id;
      const titleField = titleFieldId
        ? res.targetModel.schema.sections.flatMap((s) => s.fields).find((f) => f.id === titleFieldId)
        : null;
      if (titleField) {
        const v = effectiveData[titleField.name];
        if (typeof v === 'string' || typeof v === 'number') return String(v);
      }
      return targetRecord.id.slice(0, 8);
    })();

    return (
      <div className="section-block">
        {header}
        {!collapsed && (
          <>
            <div className="px-6 -mt-2 pb-2 text-[11px] text-charcoal/40">
              {isAr
                ? `تعديلاتك تُحفظ على: ${isAr ? res.targetModel.label_ar : res.targetModel.label_en} / ${targetLabel}`
                : `Edits save to: ${res.targetModel.label_en} / ${targetLabel}`}
            </div>
            <div className="px-6 pb-6 pt-2 grid grid-cols-12 gap-x-5 gap-y-5">
              {sortedFields.map((field) => (
                <div key={field.id} className={widthClass(field.width)}>
                  <DynamicField
                    field={field}
                    value={effectiveData[field.name]}
                    onChange={(val) => onMirrorFieldChange(targetRecord.id, field.name, val)}
                    recordData={effectiveData}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  // ── Regular section: expand section_mirror containers into inline children ──
  // `fired_at` on the followups model is system-managed: the on_due cron sweeper
  // stamps it to prevent double-firing. It stays in the schema (visible in the
  // Builder) but never renders in the user form.
  const sortedFields = [...section.fields]
    .filter((f) => f.name !== 'fired_at')
    // Field-level conditional visibility — drop fields whose `visible_when`
    // rule doesn't match the current record. Done here (not inside
    // renderFieldNodes) so the grouped/ungrouped split and empty-group
    // collapse below all see the already-filtered list.
    .filter((f) => isFieldVisible(f, formData, currentModel))
    .sort((a, b) => a.order - b.order);

  if (collapsed) {
    return (
      <div className="section-block">
        {header}
      </div>
    );
  }

  // Field renderer — expands section_mirror containers into inline children,
  // same logic the section body used to inline. Extracted so we can render
  // ungrouped fields AND each field group's members through the same path.
  const renderFieldNodes = (fieldsToRender: ModelField[]) =>
    fieldsToRender.flatMap((field) => {
          // Display-only derived field types — render their own panel inside
          // the section, bypassing the standard label / input chrome. Always
          // full-width, never editable, no value stored.
          if (field.type === 'whatsapp_history' || field.type === 'call_history') {
            const fieldPerm = getFieldPermission ? getFieldPermission(field) : 'editable';
            if (fieldPerm === 'hidden') return [];
            if (!recordId) {
              return [(
                <div key={field.id} className="col-span-12 text-[12px] text-charcoal/40 italic">
                  {isAr ? 'احفظ السجل أولاً لعرض هذا القسم.' : 'Save the record first to view this section.'}
                </div>
              )];
            }
            if (field.type === 'whatsapp_history') {
              return [(
                <div key={field.id} className="col-span-12">
                  <WhatsAppHistoryPanel clientId={recordId} chrome="naked" />
                </div>
              )];
            }
            // call_history — extract every phone-typed value on the current
            // record and feed CallHistoryPanel. The panel dedupes by call id
            // so multiple matching phones don't double-list calls.
            const phoneValues: string[] = [];
            for (const sec of currentModel.schema.sections) {
              for (const f of sec.fields) {
                if (f.type !== 'phone') continue;
                const v = formData[f.name];
                if (typeof v === 'string' && v.trim()) phoneValues.push(v.trim());
              }
            }
            return [(
              <div key={field.id} className="col-span-12">
                <CallHistoryPanel phones={phoneValues} chrome="naked" />
              </div>
            )];
          }

          if (field.type !== 'section_mirror') {
            // Resolve the effective per-field rule. `hidden` removes the field
            // from layout entirely; `readonly` (or whole-form read-only) renders
            // a display-only DynamicCell wrapped in the same disabled-input shell
            // the mirror system uses for non-editable mirror fields.
            const fieldPerm = getFieldPermission ? getFieldPermission(field) : 'editable';
            if (fieldPerm === 'hidden') return [];
            const renderReadOnly =
              !!formReadOnly ||
              fieldPerm === 'readonly' ||
              (!!field.auto_from_units && projectHasLinkedUnits);
            return [(
              <div key={field.id} className={widthClass(field.width)}>
                {renderReadOnly ? (
                  <div>
                    <label className="text-[11px] font-bold text-charcoal/60 mb-1 block">
                      {isAr ? field.label_ar : field.label_en}
                    </label>
                    <div className="form-input bg-sand/5 cursor-default opacity-80 [&_*]:pointer-events-none">
                      <DynamicCell
                        field={field}
                        value={formData[field.name]}
                        allRecords={records}
                        recordData={formData}
                        recordId={recordId}
                      />
                    </div>
                  </div>
                ) : (
                  <DynamicField
                    field={field}
                    value={formData[field.name]}
                    onChange={(val) => onChange(field.name, val)}
                    recordData={formData}
                    modelId={currentModel.id}
                    recordId={recordId}
                    onPatch={(patch) => Object.entries(patch).forEach(([k, v]) => onChange(k, v))}
                  />
                )}
              </div>
            )];
          }

          // Multi-project comparison — render a side-by-side table when the sibling
          // lookup is multi-select AND has ≥2 linked records. Falls through to the
          // single-target renderer otherwise.
          const sibling = field.section_mirror_via_lookup_field_id
            ? currentModel.schema.sections
                .flatMap((s) => s.fields)
                .find((f) => f.id === field.section_mirror_via_lookup_field_id)
            : null;
          if (sibling && sibling.type === 'lookup' && sibling.is_multi) {
            const raw = formData[sibling.name];
            const ids = Array.isArray(raw) ? (raw as unknown[]).filter((v) => typeof v === 'string' && v) : [];
            if (ids.length >= 2) {
              const multi = resolveSectionMirrorFieldMulti(field, formData, currentModel, records, models);
              if (multi.status === 'ok' && multi.sourceModel) {
                const localOverrides = (formData[field.name] as Record<string, unknown> | undefined) ?? {};
                // Fields from the current (research) model that can be added as
                // additional columns — record-level values that repeat across rows.
                // Excluded:
                //   - the container itself (would self-reference)
                //   - other section_mirror / section_selector fields
                //   - lookups (they ARE the rows, or would be misleading as columns)
                //   - notes (no useful tabular rendering)
                //   - mirror type — these resolve per-linked-record, so they're already
                //     represented in the target-origin columns from the source section.
                //     Including them here would duplicate + render arrays as concatenated text.
                const currentModelFields = currentModel.schema.sections
                  .flatMap((s) => s.fields)
                  .filter((f) =>
                    f.id !== field.id &&
                    f.type !== 'section_mirror' &&
                    f.type !== 'section_selector' &&
                    f.type !== 'lookup' &&
                    f.type !== 'mirror' &&
                    f.type !== 'notes',
                  );
                return [(
                  <SectionMirrorComparison
                    key={field.id}
                    container={field}
                    sourceModel={multi.sourceModel}
                    currentModel={currentModel}
                    currentRecordData={formData}
                    currentModelFields={currentModelFields}
                    includedFields={multi.includedFields}
                    editableFieldNames={multi.editableFieldNames}
                    syncFieldNames={multi.syncFieldNames}
                    targets={multi.targets}
                    pendingOverlay={mirrorEdits}
                    localOverrides={localOverrides}
                    onMirrorFieldChange={onMirrorFieldChange}
                    onLocalOverrideChange={(_targetId, nextMap) => onChange(field.name, nextMap)}
                    onCurrentFieldChange={(fieldName, val) => onChange(fieldName, val)}
                    activeView={activeResearchView ?? null}
                    onSelectView={(id) => onSelectResearchView?.(id)}
                  />
                )];
              }
            }
          }

          // Expand mirrored children inline in the section's grid.
          const res = resolveSectionMirrorField(field, formData, currentModel, records, models);

          if (res.status === 'sibling_missing' || res.status === 'sibling_not_lookup' ||
              res.status === 'target_model_missing' || res.status === 'target_section_missing') {
            return [(
              <div key={field.id} className="col-span-12 text-[12px] text-amber-500 italic">
                <MirroredBadge isAr={isAr} />{' '}
                <span className="ms-1.5">
                  {isAr ? 'إعدادات مرآة القسم غير مكتملة.' : 'Section mirror is not configured.'}
                </span>
              </div>
            )];
          }
          if (res.status === 'sibling_not_selected') {
            return [(
              <div key={field.id} className="col-span-12 text-[12px] text-charcoal/40 italic">
                <MirroredBadge isAr={isAr} />{' '}
                <span className="ms-1.5">
                  {isAr ? 'اختر السجل المرتبط لعرض الحقول المنسوخة.' : 'Select the linked record to view mirrored fields.'}
                </span>
              </div>
            )];
          }
          if (res.status === 'target_record_missing') {
            return [(
              <div key={field.id} className="col-span-12 text-[12px] text-red-400 italic">
                <MirroredBadge isAr={isAr} />{' '}
                <span className="ms-1.5">
                  {isAr ? 'السجل المرتبط محذوف.' : 'The linked record has been deleted.'}
                </span>
              </div>
            )];
          }
          if (res.status !== 'ok' || !res.targetRecord || !res.targetModel) {
            return [];
          }

          const targetRecord = res.targetRecord;
          const overlay = mirrorEdits[targetRecord.id] ?? {};
          const localOverrides = (formData[field.name] as Record<string, unknown> | undefined) ?? {};
          // Effective: local overrides beat sync overlay beat source record value.
          const effective: Record<string, unknown> = {
            ...targetRecord.data,
            ...overlay,
            ...localOverrides,
          };

          return res.includedFields.map((child) => {
            const isEditable = res.editableFieldNames.has(child.name);
            const willSync = res.syncFieldNames.has(child.name);
            return (
              <div key={`${field.id}::${child.name}`} className={widthClass(child.width)}>
                <div className="flex items-center gap-1.5 mb-1">
                  <label className="text-[11px] font-bold text-charcoal/60 flex-1 truncate">
                    {isAr ? child.label_ar : child.label_en}
                  </label>
                  <MirroredBadge
                    isAr={isAr}
                    tone={!isEditable ? 'muted' : willSync ? 'synced' : 'local'}
                  />
                </div>
                {isEditable ? (
                  <DynamicField
                    field={child}
                    value={effective[child.name]}
                    onChange={(val) => {
                      if (willSync) {
                        onMirrorFieldChange(targetRecord.id, child.name, val);
                      } else {
                        onChange(field.name, { ...localOverrides, [child.name]: val });
                      }
                    }}
                    recordData={effective}
                  />
                ) : (
                  <div className="form-input bg-sand/5 cursor-default opacity-80 [&_*]:pointer-events-none">
                    <DynamicCell
                      field={child}
                      value={effective[child.name]}
                      allRecords={records}
                      recordData={effective}
                      recordId={recordId}
                    />
                  </div>
                )}
              </div>
            );
          });
        });

  const groups = [...(section.field_groups ?? [])].sort((a, b) => a.order - b.order);
  const validGroupIds = new Set(groups.map((g) => g.id));
  const ungroupedFields = sortedFields.filter(
    (f) => !f.field_group_id || !validGroupIds.has(f.field_group_id),
  );
  const fieldsByGroup = new Map<string, ModelField[]>();
  for (const g of groups) fieldsByGroup.set(g.id, []);
  for (const f of sortedFields) {
    if (f.field_group_id && validGroupIds.has(f.field_group_id)) {
      fieldsByGroup.get(f.field_group_id)!.push(f);
    }
  }

  return (
    <div className="section-block">
      {header}
      {ungroupedFields.length > 0 && (
        <div className="px-6 pb-2 pt-2 grid grid-cols-12 gap-x-5 gap-y-5">
          {renderFieldNodes(ungroupedFields)}
        </div>
      )}
      {groups.length > 0 && (
        <div className="px-6 pb-6 pt-2 space-y-3">
          {groups.map((g) => {
            const groupFields = fieldsByGroup.get(g.id) ?? [];
            if (groupFields.length === 0) return null;
            return (
              <FieldGroupBlock
                key={g.id}
                group={g}
                isAr={isAr}
              >
                <div className="grid grid-cols-12 gap-x-5 gap-y-5">
                  {renderFieldNodes(groupFields)}
                </div>
              </FieldGroupBlock>
            );
          })}
        </div>
      )}
      {ungroupedFields.length === 0 && groups.length === 0 && (
        <div className="px-6 pb-6 pt-2" />
      )}
    </div>
  );
}

/**
 * Collapsible wrapper for an in-section field group. Its own header + its
 * own local `collapsed` state (seeded from `group.default_collapsed`). The
 * parent section's collapse state still wins — when the section is
 * collapsed, this whole tree is hidden.
 */
function FieldGroupBlock({
  group,
  isAr,
  children,
}: {
  group: { label_ar: string; label_en: string; default_collapsed?: boolean };
  isAr: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<boolean>(!!group.default_collapsed);
  return (
    <div className="rounded-xl border border-sand/25 bg-cream/20">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="w-full px-4 py-2.5 flex items-center gap-2 text-start hover:bg-sand/20 transition-colors rounded-t-xl"
      >
        <span className="font-bold text-chocolate text-sm flex-1">
          {isAr ? group.label_ar : group.label_en}
        </span>
        <ChevronDown
          size={14}
          className={`text-charcoal/35 transition-transform ${collapsed ? '-rotate-90 rtl:rotate-90' : ''}`}
        />
      </button>
      {!collapsed && <div className="px-4 pb-4 pt-1">{children}</div>}
    </div>
  );
}
