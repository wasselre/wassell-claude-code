import React, { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { bilingualFromInput, slugify } from '@/lib/autoTranslate';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import FieldPicker from '@/components/ui/FieldPicker';
import OptionsEditor from './OptionsEditor';
import SaveAsTemplateModal from './SaveAsTemplateModal';
import { Info, Layers, Bookmark, RotateCcw, AlertTriangle } from 'lucide-react';
import { COUNTRY_CODES, DEFAULT_COUNTRY_CODE } from '@/lib/phone';
import { formatAutoId, resetAutoIdCounters, renumberAutoIdField } from '@/lib/autoIdAssigner';
import {
  validateFormula, findUnknownReferences, detectFormulaCycle, evaluateFormula,
} from '@/lib/formulaEngine';
import { countRenameImpact, type RenameImpact } from '@/lib/fieldRename';
import { countRecordsWithFieldData, isTypeChangeLossy } from '@/lib/fieldDataImpact';
import type {
  ModelField, FieldType, FieldWidth, FieldOption, FieldOptionGroup, AppModel,
  SectionMirrorControlMode, SectionMirrorFieldMode,
} from '@/types';

const FIELD_TYPES: FieldType[] = [
  'text', 'textarea', 'notes', 'number', 'range', 'email', 'phone', 'date', 'datetime',
  'currency', 'url', 'checkbox', 'dropdown', 'multiselect', 'lookup', 'mirror', 'section_mirror', 'section_selector', 'assignee',
  'auto_id', 'formula',
];

// Field types that can be the scope of an auto_id counter — values we can use
// as a per-group counter key. Excludes complex types (lookups, mirrors, etc.)
// where "value equality" is ambiguous.
const AUTO_ID_SCOPE_TYPES: FieldType[] = [
  'text', 'dropdown', 'multiselect', 'number', 'checkbox', 'email', 'phone', 'url',
];

// Target-field types a mirror can display. Includes `lookup` so a mirror can surface
// a linked record's lookup field (rendered through DynamicCell's lookup branch).
const MIRROR_TARGET_TYPES: FieldType[] = [
  'text', 'textarea', 'number', 'email', 'phone', 'url', 'currency', 'date', 'datetime', 'dropdown', 'lookup',
];

// Target-field types a lookup's display_field can be (relaxed from text/email/phone).
const LOOKUP_DISPLAY_TYPES: FieldType[] = [
  'text', 'email', 'phone', 'number', 'currency', 'date', 'datetime', 'url', 'dropdown', 'auto_id',
];

interface FieldEditorProps {
  field: ModelField | null;
  sectionId: string;
  model: AppModel;
  defaultType?: FieldType;
  onSave: (field: ModelField) => void;
  /**
   * 'model' (default) — enables rename propagation across records, formulas,
   * lookups, mirrors, workflows, and views via `renameField`.
   * 'role' — skips propagation (role fields are schema-local; renames don't
   * cascade to records/workflows). The Role Builder reuses this component to
   * edit a role's schema exactly like a model's.
   */
  ownerKind?: 'model' | 'role';
}

export default function FieldEditor({ field, sectionId, model, defaultType, onSave, ownerKind = 'model' }: FieldEditorProps) {
  const { t } = useTranslation();
  const { models, language, roles, records, workflows, views, saveModel, saveRecord, renameField, addToast } = useAppStore();
  const isAr = language === 'ar';

  const sectionFields = model.schema.sections.find((s) => s.id === sectionId)?.fields ?? [];
  const nextOrder = field ? field.order : sectionFields.length;

  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [required, setRequired] = useState(false);
  const [width, setWidth] = useState<FieldWidth>('half');
  const [showInTable, setShowInTable] = useState(true);
  const [fieldGroupId, setFieldGroupId] = useState<string | null>(null);
  const [options, setOptions] = useState<FieldOption[]>([]);
  const [optionGroups, setOptionGroups] = useState<FieldOptionGroup[]>([]);
  const [lookupModelId, setLookupModelId] = useState<string | null>(null);
  const [lookupDisplayField, setLookupDisplayField] = useState<string | null>(null);
  const [isMulti, setIsMulti] = useState<boolean>(false);
  const [lookupMaxRecords, setLookupMaxRecords] = useState<number>(20);
  const [assigneeRoleIds, setAssigneeRoleIds] = useState<string[]>([]);
  const [defaultCountryCode, setDefaultCountryCode] = useState<string>(DEFAULT_COUNTRY_CODE);
  const [mirrorViaLookupFieldId, setMirrorViaLookupFieldId] = useState<string | null>(null);
  const [mirrorTargetFieldName, setMirrorTargetFieldName] = useState<string | null>(null);
  const [rangeMin, setRangeMin] = useState<number | undefined>(undefined);
  const [rangeMax, setRangeMax] = useState<number | undefined>(undefined);
  const [rangeStep, setRangeStep] = useState<number | undefined>(undefined);
  const [rangeUnitAr, setRangeUnitAr] = useState<string>('');
  const [rangeUnitEn, setRangeUnitEn] = useState<string>('');
  // Section mirror config
  const [smViaLookupFieldId, setSmViaLookupFieldId] = useState<string | null>(null);
  const [smSourceSectionId, setSmSourceSectionId] = useState<string | null>(null);
  const [smFieldMode, setSmFieldMode] = useState<SectionMirrorFieldMode>('all');
  const [smFieldNames, setSmFieldNames] = useState<string[]>([]);
  const [smEditMode, setSmEditMode] = useState<SectionMirrorControlMode>('none');
  const [smEditableFieldNames, setSmEditableFieldNames] = useState<string[]>([]);
  const [smSyncMode, setSmSyncMode] = useState<SectionMirrorControlMode>('all');
  const [smSyncFieldNames, setSmSyncFieldNames] = useState<string[]>([]);
  const [targetSectionId, setTargetSectionId] = useState(sectionId);
  const [showSaveTemplate, setShowSaveTemplate] = useState(false);
  // Auto ID
  const [autoIdPrefix, setAutoIdPrefix] = useState<string>('');
  const [autoIdPadding, setAutoIdPadding] = useState<number>(3);
  const [autoIdStartValue, setAutoIdStartValue] = useState<number>(1);
  const [autoIdScopeFieldId, setAutoIdScopeFieldId] = useState<string | null>(null);
  const [autoIdCounters, setAutoIdCounters] = useState<Record<string, number>>({});
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [restartMode, setRestartMode] = useState<'reset' | 'renumber' | null>(null);
  // Formula
  const [formulaExpression, setFormulaExpression] = useState<string>('');
  const [formulaOutputType, setFormulaOutputType] = useState<'number' | 'currency' | 'percentage' | 'text'>('number');
  const [formulaDecimals, setFormulaDecimals] = useState<number>(2);
  const [formulaCurrency, setFormulaCurrency] = useState<string>('SAR');
  const [formulaThousandsSeparator, setFormulaThousandsSeparator] = useState<boolean>(true);
  // Ref to the formula textarea so operator/function buttons can insert at the caret.
  const formulaTextareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  // API name (slug). Initialised from field.name for existing fields; for new
  // fields auto-syncs from slugify(label) until the user types into the input.
  const [apiName, setApiName] = useState<string>('');
  const [apiNameTouched, setApiNameTouched] = useState<boolean>(false);
  // Rename confirmation — populated when the user saves an existing field with a changed slug.
  const [renamePrompt, setRenamePrompt] = useState<{ saved: ModelField; impact: RenameImpact } | null>(null);
  // Data-loss guard for type changes (text → dropdown, etc.). Same pattern as
  // renamePrompt — we hold the pending saved field aside until the user confirms.
  const [typeChangePrompt, setTypeChangePrompt] = useState<{
    saved: ModelField;
    fromType: string;
    toType: string;
    recordCount: number;
  } | null>(null);

  useEffect(() => {
    setTargetSectionId(sectionId);
    if (field) {
      setLabel(isAr ? field.label_ar : field.label_en);
      setType(field.type);
      setRequired(field.required);
      setWidth(field.width);
      setShowInTable(field.show_in_table);
      setFieldGroupId(field.field_group_id ?? null);
      // Normalize section_selector options on load so legacy data — which
      // pre-dates the `is_section_option` flag — doesn't render duplicates
      // (one locked row from the auto-generated section options, plus the
      // same option as an editable "custom" row). Options whose value is a
      // section id on this model are the section-managed ones; rebuild them
      // from the schema and drop any same-id lookalikes from the rest.
      if (field.type === 'section_selector') {
        const existing = field.options ?? [];
        const nonBase = model.schema.sections.filter((s) => !s.is_base && !s.is_mirrored);
        const sectionIds = new Set(model.schema.sections.map((s) => s.id));
        const rebuiltSectionOptions: FieldOption[] = nonBase.map((s) => ({
          id: s.id,
          label_ar: s.label_ar,
          label_en: s.label_en,
          value: s.id,
          color: s.color,
          is_section_option: true,
        }));
        const customOptions = existing.filter(
          (o) => !o.is_section_option && !sectionIds.has(o.value),
        );
        setOptions([...rebuiltSectionOptions, ...customOptions]);
      } else {
        setOptions(field.options ?? []);
      }
      setOptionGroups(field.option_groups ?? []);
      setLookupModelId(field.lookup_model_id ?? null);
      setLookupDisplayField(field.lookup_display_field ?? null);
      setIsMulti(field.is_multi ?? false);
      setLookupMaxRecords(field.lookup_max_records ?? 20);
      setAssigneeRoleIds(field.assignee_role_ids ?? []);
      setDefaultCountryCode(field.default_country_code ?? DEFAULT_COUNTRY_CODE);
      setMirrorViaLookupFieldId(field.mirror_via_lookup_field_id ?? null);
      setMirrorTargetFieldName(field.mirror_target_field_name ?? null);
      setRangeMin(field.range_min);
      setRangeMax(field.range_max);
      setRangeStep(field.range_step);
      setRangeUnitAr(field.range_unit_ar ?? '');
      setRangeUnitEn(field.range_unit_en ?? '');
      setSmViaLookupFieldId(field.section_mirror_via_lookup_field_id ?? null);
      setSmSourceSectionId(field.section_mirror_source_section_id ?? null);
      setSmFieldMode(field.section_mirror_field_mode ?? 'all');
      setSmFieldNames(field.section_mirror_field_names ?? []);
      setSmEditMode(field.section_mirror_edit_mode ?? 'none');
      setSmEditableFieldNames(field.section_mirror_editable_field_names ?? []);
      setSmSyncMode(field.section_mirror_sync_mode ?? 'all');
      setSmSyncFieldNames(field.section_mirror_sync_field_names ?? []);
      setAutoIdPrefix(field.auto_id_prefix ?? '');
      setAutoIdPadding(field.auto_id_padding ?? 3);
      setAutoIdStartValue(field.auto_id_start_value ?? 1);
      setAutoIdScopeFieldId(field.auto_id_scope_field_id ?? null);
      setAutoIdCounters(field.auto_id_counters ?? {});
      setFormulaExpression(field.formula_expression ?? '');
      setFormulaOutputType(field.formula_output_type ?? 'number');
      setFormulaDecimals(field.formula_decimals ?? 2);
      setFormulaCurrency(field.formula_currency ?? 'SAR');
      setFormulaThousandsSeparator(field.formula_thousands_separator !== false);
      setApiName(field.name);
      setApiNameTouched(true);
    } else {
      setLabel('');
      setType(defaultType ?? 'text');
      setRequired(false);
      setWidth('half');
      setShowInTable(true);
      setFieldGroupId(null);
      setOptions([]);
      setOptionGroups([]);
      setLookupModelId(null);
      setLookupDisplayField(null);
      setIsMulti(false);
      setLookupMaxRecords(20);
      setAssigneeRoleIds([]);
      setDefaultCountryCode(DEFAULT_COUNTRY_CODE);
      setMirrorViaLookupFieldId(null);
      setMirrorTargetFieldName(null);
      setRangeMin(undefined);
      setRangeMax(undefined);
      setRangeStep(undefined);
      setRangeUnitAr('');
      setRangeUnitEn('');
      setSmViaLookupFieldId(null);
      setSmSourceSectionId(null);
      setSmFieldMode('all');
      setSmFieldNames([]);
      setSmEditMode('none');
      setSmEditableFieldNames([]);
      setSmSyncMode('all');
      setSmSyncFieldNames([]);
      setAutoIdPrefix('');
      setAutoIdPadding(3);
      setAutoIdStartValue(1);
      setAutoIdScopeFieldId(null);
      setAutoIdCounters({});
      setFormulaExpression('');
      setFormulaOutputType('number');
      setFormulaDecimals(2);
      setFormulaCurrency('SAR');
      setFormulaThousandsSeparator(true);
      setApiName('');
      setApiNameTouched(false);
    }
  }, [field, isAr, sectionId, defaultType]);

  // Auto-sync the API name from the label while creating a NEW field, until the
  // user manually types into the API-name input. Existing fields are left alone.
  useEffect(() => {
    if (field || apiNameTouched) return;
    setApiName(label.trim() ? slugify(label.trim()) : '');
  }, [label, field, apiNameTouched]);

  // API name validation — format + uniqueness within this model.
  const apiNameError: 'empty' | 'invalid' | 'taken' | null = useMemo(() => {
    const trimmed = apiName.trim();
    if (!trimmed) return 'empty';
    if (!/^[a-z][a-z0-9_]*$/.test(trimmed)) return 'invalid';
    const collision = model.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => f.name === trimmed && f.id !== field?.id);
    if (collision) return 'taken';
    return null;
  }, [apiName, model, field]);

  // Formula validation — runs on every render for live inline feedback.
  const formulaParseError = useMemo(
    () => type === 'formula' ? validateFormula(formulaExpression) : null,
    [type, formulaExpression],
  );
  const formulaUnknownRefs = useMemo(
    () => type === 'formula' && !formulaParseError ? findUnknownReferences(formulaExpression, model) : [],
    [type, formulaExpression, model, formulaParseError],
  );
  const formulaCyclePath = useMemo(() => {
    if (type !== 'formula' || formulaParseError) return null;
    const candidate = {
      id: field?.id ?? '__new__',
      name: field?.name ?? (label.trim() ? slugify(label.trim()) : '__new__'),
    };
    return detectFormulaCycle(model, candidate, formulaExpression);
  }, [type, formulaExpression, formulaParseError, field, label, model]);

  const formulaHasError =
    type === 'formula' && (!!formulaParseError || formulaUnknownRefs.length > 0 || !!formulaCyclePath);

  const buildSavedField = (): ModelField | null => {
    if (!label.trim()) return null;
    if (formulaHasError) return null;
    if (apiNameError) return null;
    const { label_ar, label_en } = field
      ? { label_ar: isAr ? label.trim() : field.label_ar, label_en: isAr ? field.label_en : label.trim() }
      : bilingualFromInput(label.trim(), language);
    const slug = apiName.trim();
    // For auto_id: re-read counters from the LIVE model at save time. Our local
    // `autoIdCounters` state was captured when the modal opened; if records
    // were created in the meantime (e.g. by a workflow) the counter has since
    // advanced, and writing the stale snapshot back would reset future IDs to
    // "001" and cause duplicates. The config the user edits here is
    // prefix/padding/scope/start_value — counters are owned by `saveRecord`.
    const liveAutoIdCounters: Record<string, number> | undefined = (() => {
      if (type !== 'auto_id' || !field) return autoIdCounters;
      const liveModel = models.find((m) => m.id === model.id);
      const liveField = liveModel?.schema.sections.flatMap((s) => s.fields).find((f) => f.id === field.id);
      return liveField?.type === 'auto_id'
        ? (liveField.auto_id_counters ?? autoIdCounters)
        : autoIdCounters;
    })();
    const saved: ModelField = {
      id: field?.id ?? uuid(),
      name: slug,
      label_ar,
      label_en,
      type,
      required: (type === 'mirror' || type === 'section_mirror' || type === 'auto_id' || type === 'formula') ? false : required,
      order: nextOrder,
      section_id: targetSectionId,
      width,
      show_in_table: type === 'section_mirror' ? false : showInTable,
      field_group_id: fieldGroupId,
      options: (type === 'dropdown' || type === 'multiselect' || type === 'section_selector') ? options : undefined,
      option_groups: (type === 'dropdown' || type === 'multiselect' || type === 'section_selector') && optionGroups.length > 0 ? optionGroups : undefined,
      lookup_model_id: type === 'lookup' ? lookupModelId : null,
      lookup_display_field: type === 'lookup' ? lookupDisplayField : null,
      is_multi: type === 'lookup' ? isMulti : undefined,
      lookup_max_records: type === 'lookup' ? lookupMaxRecords : undefined,
      assignee_role_ids: type === 'assignee' ? assigneeRoleIds : undefined,
      default_country_code: type === 'phone' ? defaultCountryCode : undefined,
      mirror_via_lookup_field_id: type === 'mirror' ? mirrorViaLookupFieldId : null,
      mirror_target_field_name: type === 'mirror' ? mirrorTargetFieldName : null,
      section_mirror_via_lookup_field_id: type === 'section_mirror' ? smViaLookupFieldId : null,
      section_mirror_source_section_id: type === 'section_mirror' ? smSourceSectionId : null,
      section_mirror_field_mode: type === 'section_mirror' ? smFieldMode : undefined,
      section_mirror_field_names: type === 'section_mirror' && smFieldMode === 'custom' ? smFieldNames : undefined,
      section_mirror_edit_mode: type === 'section_mirror' ? smEditMode : undefined,
      section_mirror_editable_field_names: type === 'section_mirror' && smEditMode === 'custom' ? smEditableFieldNames : undefined,
      section_mirror_sync_mode: type === 'section_mirror' ? smSyncMode : undefined,
      section_mirror_sync_field_names: type === 'section_mirror' && smSyncMode === 'custom' ? smSyncFieldNames : undefined,
      range_min: type === 'range' ? rangeMin : undefined,
      range_max: type === 'range' ? rangeMax : undefined,
      range_step: type === 'range' ? rangeStep : undefined,
      range_unit_ar: type === 'range' ? (rangeUnitAr.trim() || undefined) : undefined,
      range_unit_en: type === 'range' ? (rangeUnitEn.trim() || undefined) : undefined,
      auto_id_prefix: type === 'auto_id' ? autoIdPrefix : undefined,
      auto_id_padding: type === 'auto_id' ? autoIdPadding : undefined,
      auto_id_start_value: type === 'auto_id' ? autoIdStartValue : undefined,
      auto_id_scope_field_id: type === 'auto_id' ? autoIdScopeFieldId : null,
      auto_id_counters: type === 'auto_id' ? liveAutoIdCounters : undefined,
      formula_expression: type === 'formula' ? formulaExpression : undefined,
      formula_output_type: type === 'formula' ? formulaOutputType : undefined,
      formula_decimals: type === 'formula' && formulaOutputType !== 'text' ? formulaDecimals : undefined,
      formula_currency: type === 'formula' && formulaOutputType === 'currency' ? formulaCurrency : undefined,
      formula_thousands_separator: type === 'formula' && formulaOutputType !== 'text' ? formulaThousandsSeparator : undefined,
    };
    return saved;
  };

  const handleSave = () => {
    const saved = buildSavedField();
    if (!saved) return;
    // For role schemas, rename propagation doesn't apply — role-field slugs
    // aren't referenced in records, workflows, views, or other models. Commit
    // directly. The parent (RoleEditor) handles persistence.
    if (ownerKind === 'role') {
      onSave(saved);
      return;
    }
    // Type-change guard: existing field whose type changed AND has record data →
    // warn the user. Skipped for lossless transitions (text↔textarea, etc.) and
    // when the field has no data. This is the Builder's minimum-safe data-loss
    // guard; the save proceeds only after explicit confirmation.
    if (field && field.type !== saved.type && isTypeChangeLossy(field.type, saved.type)) {
      const recordCount = countRecordsWithFieldData(model.id, field.name, records);
      if (recordCount > 0) {
        setTypeChangePrompt({
          saved,
          fromType: field.type,
          toType: saved.type,
          recordCount,
        });
        return;
      }
    }
    // Rename path: existing field whose slug changed → confirm if there's any impact,
    // then commit everything (propagation + field edits) atomically through the store.
    if (field && field.name !== saved.name) {
      const impact = countRenameImpact(model, field.name, saved.name, models, records, workflows, views);
      const hasAnyImpact =
        impact.records + impact.formulas + impact.lookups + impact.mirrors +
        impact.sectionMirrors + impact.workflows + impact.views > 0;
      if (hasAnyImpact) {
        setRenamePrompt({ saved, impact });
        return;
      }
      renameField(model.id, field.id, saved);
      addToast(t('toast.saved'), 'success');
      return;
    }
    onSave(saved);
  };

  // Called when the user confirms a lossy type change. Continues the normal
  // save path — if the slug ALSO changed we still surface the rename modal.
  const confirmTypeChange = () => {
    if (!typeChangePrompt || !field) return;
    const saved = typeChangePrompt.saved;
    setTypeChangePrompt(null);
    if (field.name !== saved.name) {
      const impact = countRenameImpact(model, field.name, saved.name, models, records, workflows, views);
      const hasAnyImpact =
        impact.records + impact.formulas + impact.lookups + impact.mirrors +
        impact.sectionMirrors + impact.workflows + impact.views > 0;
      if (hasAnyImpact) {
        setRenamePrompt({ saved, impact });
        return;
      }
      renameField(model.id, field.id, saved);
      addToast(t('toast.saved'), 'success');
      return;
    }
    onSave(saved);
  };

  const confirmRename = () => {
    if (!renamePrompt || !field) return;
    renameField(model.id, field.id, renamePrompt.saved);
    setRenamePrompt(null);
    addToast(t('toast.saved'), 'success');
  };

  // ── Restart counter handler ──
  // Operates against the currently-saved `field` prop + latest model state, not
  // in-progress edits. Prompt the user to save first if they've tweaked the
  // config but haven't hit Save yet.
  const performRestart = () => {
    if (!field || field.type !== 'auto_id' || !restartMode) return;
    const latestModel = models.find((m) => m.id === model.id) ?? model;
    const liveField = latestModel.schema.sections.flatMap((s) => s.fields).find((f) => f.id === field.id);
    if (!liveField || liveField.type !== 'auto_id') return;
    if (restartMode === 'reset') {
      const updated = resetAutoIdCounters(liveField, latestModel);
      saveModel(updated);
      addToast(t('toast.auto_id_reset'), 'success');
    } else {
      const modelRecords = records[latestModel.id] ?? [];
      const { records: newRecords, model: newModel } = renumberAutoIdField(liveField, latestModel, modelRecords);
      saveModel(newModel);
      for (const r of newRecords) saveRecord(r);
      addToast(t('toast.auto_id_renumbered', { count: newRecords.length }), 'success');
    }
    setShowRestartModal(false);
    setRestartMode(null);
  };

  const lookupModel = lookupModelId ? models.find((m) => m.id === lookupModelId) : null;
  const lookupFields = lookupModel
    ? lookupModel.schema.sections.flatMap((s) => s.fields).filter((f) =>
        LOOKUP_DISPLAY_TYPES.includes(f.type),
      )
    : [];
  const otherModels = models.filter((m) => m.id !== model.id);

  // Sibling lookup fields available as a mirror source (must be a configured lookup, not this field itself).
  const siblingLookupFields = model.schema.sections
    .flatMap((s) => s.fields)
    .filter((f) => f.type === 'lookup' && f.id !== field?.id && f.lookup_model_id);

  const mirrorSibling = mirrorViaLookupFieldId
    ? siblingLookupFields.find((f) => f.id === mirrorViaLookupFieldId)
    : null;
  const mirrorTargetModel = mirrorSibling?.lookup_model_id
    ? models.find((m) => m.id === mirrorSibling.lookup_model_id)
    : null;
  const mirrorTargetFields = mirrorTargetModel
    ? mirrorTargetModel.schema.sections.flatMap((s) => s.fields).filter((f) =>
        MIRROR_TARGET_TYPES.includes(f.type),
      )
    : [];

  // ── Section mirror derivations ──
  // Only single-select lookups can pin one source record for a whole-section mirror.
  const smSiblingLookupFields = model.schema.sections
    .flatMap((s) => s.fields)
    .filter((f) => f.type === 'lookup' && !f.is_multi && !!f.lookup_model_id && f.id !== field?.id);
  const smSibling = smViaLookupFieldId
    ? smSiblingLookupFields.find((f) => f.id === smViaLookupFieldId)
    : null;
  const smTargetModel = smSibling?.lookup_model_id
    ? models.find((m) => m.id === smSibling.lookup_model_id)
    : null;
  const smTargetSections = smTargetModel?.schema.sections ?? [];
  const smSourceSection = smSourceSectionId
    ? smTargetSections.find((s) => s.id === smSourceSectionId)
    : null;
  // Fields available to mirror. Skip `section_mirror` (no nesting) and
  // `section_selector` (meaningful only on its owning model).
  const smCandidateFields = smSourceSection
    ? smSourceSection.fields.filter((f) => f.type !== 'section_mirror' && f.type !== 'section_selector')
    : [];
  const smIncludedFieldNames = smFieldMode === 'all'
    ? smCandidateFields.map((f) => f.name)
    : smCandidateFields.filter((f) => smFieldNames.includes(f.name)).map((f) => f.name);

  return (
    <div className="h-full flex flex-col bg-[#FDFCFA]">
      {/* ── Header ── */}
      <div className="px-5 pt-5 pb-4">
        <h3 className="text-sm font-bold text-chocolate">
          {isAr ? 'خصائص الحقل' : 'Field Properties'}
        </h3>
        <p className="text-[11px] text-charcoal/30 mt-0.5">
          {field ? t(`fields.type.${type}`) : `${isAr ? 'حقل جديد' : 'New field'} · ${t(`fields.type.${type}`)}`}
        </p>
      </div>

      <div className="mx-5 border-t border-sand/15" />

      {/* ── Body (scrollable) ── */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

        {/* ─── Identity ─── */}
        <div>
          <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
            {isAr ? 'اسم الحقل' : 'Field Name'} <span className="text-red-300">*</span>
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="form-input text-sm"
            dir={isAr ? 'rtl' : 'ltr'}
            placeholder={isAr ? 'مثال: رقم الهاتف' : 'e.g. Phone Number'}
          />
        </div>

        {/* API name (slug) — editable identifier used in formulas, imports, automations. */}
        <div>
          <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
            {t('fields.api_name')} <span className="text-red-300">*</span>
          </label>
          <input
            type="text"
            value={apiName}
            onChange={(e) => { setApiName(e.target.value); setApiNameTouched(true); }}
            className={`form-input text-sm font-mono ${apiNameError ? 'border-red-300' : ''}`}
            dir="ltr"
            placeholder="my_field_name"
          />
          <p className="text-[11px] text-charcoal/40 mt-1">{t('fields.api_name_hint')}</p>
          {apiNameError && (
            <p className="text-[11px] text-red-500 mt-1">{t(`fields.api_name_${apiNameError}`)}</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-bold text-charcoal/50 mb-1.5">{t('fields.type')}</label>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as FieldType)}
            className="form-input text-sm"
          >
            {FIELD_TYPES.map((ft) => (
              <option key={ft} value={ft}>{t(`fields.type.${ft}`)}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
            {isAr ? 'القسم' : 'Section'}
          </label>
          <select
            value={targetSectionId}
            onChange={(e) => {
              setTargetSectionId(e.target.value);
              // Moving to a new section invalidates the group id — groups are
              // section-scoped. Clear so the user re-picks from the new section's
              // groups (or leaves it ungrouped).
              setFieldGroupId(null);
            }}
            className="form-input text-sm"
          >
            {model.schema.sections.map((s) => (
              <option key={s.id} value={s.id}>
                {isAr ? s.label_ar : s.label_en}
              </option>
            ))}
          </select>
        </div>

        {/* In-section group picker — only rendered when the target section
            has any field_groups defined. Lets the user place this field into
            one of the section's collapsible sub-groups. */}
        {(() => {
          const targetSection = model.schema.sections.find((s) => s.id === targetSectionId);
          const groups = [...(targetSection?.field_groups ?? [])].sort((a, b) => a.order - b.order);
          if (groups.length === 0) return null;
          return (
            <div>
              <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                {isAr ? 'المجموعة داخل القسم' : 'Group in section'}
              </label>
              <select
                value={fieldGroupId ?? ''}
                onChange={(e) => setFieldGroupId(e.target.value || null)}
                className="form-input text-sm"
              >
                <option value="">{isAr ? 'بدون مجموعة' : 'No group'}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {isAr ? g.label_ar : g.label_en}
                  </option>
                ))}
              </select>
            </div>
          );
        })()}

        <div className="border-t border-sand/10" />

        {/* ─── Behavior ─── */}
        <div className="space-y-3">
          <label
            className={`flex items-center gap-2.5 group py-0.5 ${
              type === 'mirror' || type === 'section_mirror' ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
            }`}
            title={
              type === 'mirror'
                ? (isAr ? 'حقول المرآة محسوبة، لا يمكن أن تكون مطلوبة' : 'Mirror fields are derived and cannot be required')
                : type === 'section_mirror'
                  ? (isAr ? 'مرآة القسم تعرض عدة حقول؛ اضبط الإلزام على الحقول الأصلية' : 'Section mirror shows multiple fields; set required on the source fields')
                  : undefined
            }
          >
            <input
              type="checkbox"
              checked={(type === 'mirror' || type === 'section_mirror') ? false : required}
              disabled={type === 'mirror' || type === 'section_mirror'}
              onChange={(e) => setRequired(e.target.checked)}
              className="w-4 h-4 rounded border-sand/50 text-copper focus:ring-copper/20 transition-colors"
            />
            <span className="text-[13px] font-semibold text-charcoal/70 group-hover:text-charcoal transition-colors">
              {t('fields.required')}
            </span>
          </label>
          {type !== 'section_mirror' && (
            <label className="flex items-center gap-2.5 cursor-pointer group py-0.5">
              <input
                type="checkbox"
                checked={showInTable}
                onChange={(e) => setShowInTable(e.target.checked)}
                className="w-4 h-4 rounded border-sand/50 text-copper focus:ring-copper/20 transition-colors"
              />
              <span className="text-[13px] font-semibold text-charcoal/70 group-hover:text-charcoal transition-colors">
                {t('fields.show_in_table')}
              </span>
            </label>
          )}
        </div>

        <div className="border-t border-sand/10" />

        {/* ─── Width — segmented control ─── */}
        {type !== 'section_mirror' && (
          <div>
            <label className="block text-xs font-bold text-charcoal/50 mb-2">{t('fields.width')}</label>
            <div className="flex bg-sand/10 rounded-xl p-1 gap-0.5">
              {(['full', 'half', 'third'] as FieldWidth[]).map((w) => (
                <button
                  key={w}
                  onClick={() => setWidth(w)}
                  className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${
                    width === w
                      ? 'bg-copper text-white shadow-sm'
                      : 'text-charcoal/40 hover:text-charcoal/60'
                  }`}
                >
                  {t(`fields.width_${w}`)}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-charcoal/30 mt-1.5 sr-only">{t('fields.width')}</p>
          </div>
        )}

        {/* ─── Type-specific config ─── */}

        {/* Phone default country code */}
        {type === 'phone' && (
          <>
            <div className="border-t border-sand/10" />
            <div>
              <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                {isAr ? 'رمز الدولة الافتراضي' : 'Default country code'}
              </label>
              <select
                value={defaultCountryCode}
                onChange={(e) => setDefaultCountryCode(e.target.value)}
                className="form-input text-sm"
              >
                {COUNTRY_CODES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} {isAr ? c.name_ar : c.name_en}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-charcoal/30 mt-1.5">
                {isAr
                  ? 'يُستخدم عند إدخال رقم محلي بدون رمز الدولة.'
                  : 'Used when entering a local number without a country code.'}
              </p>
            </div>
          </>
        )}

        {/* Options for dropdown/multiselect */}
        {(type === 'dropdown' || type === 'multiselect') && (
          <>
            <div className="border-t border-sand/10" />
            <OptionsEditor
              options={options}
              groups={optionGroups}
              onChange={setOptions}
              onGroupsChange={setOptionGroups}
            />
          </>
        )}

        {/* Extra (non-section) options for section_selector. Section-linked
            options render as locked rows so the user understands they're
            managed by the model's sections. Custom values the user adds here
            show up in the record dropdown but don't affect section visibility. */}
        {type === 'section_selector' && (
          <>
            <div className="border-t border-sand/10" />
            <OptionsEditor
              options={options}
              groups={optionGroups}
              onChange={setOptions}
              onGroupsChange={setOptionGroups}
              lockSectionOptions
              label={isAr ? 'الخيارات' : 'Options'}
              hint={
                isAr
                  ? 'الخيارات المرتبطة بأقسام تُدار تلقائياً (مقفلة). أضف قيماً مخصصة لعرضها في القائمة دون أن تتحكم في ظهور الأقسام.'
                  : 'Section-linked options are managed automatically (locked). Add custom values to appear in the dropdown without controlling section visibility.'
              }
            />
          </>
        )}

        {/* Lookup config */}
        {type === 'lookup' && (
          <>
            <div className="border-t border-sand/10" />
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                  {t('fields.link_to_model')}
                </label>
                <select
                  value={lookupModelId ?? ''}
                  onChange={(e) => {
                    setLookupModelId(e.target.value || null);
                    setLookupDisplayField(null);
                  }}
                  className="form-input text-sm"
                >
                  <option value="">—</option>
                  {otherModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {isAr ? m.label_ar : m.label_en}
                    </option>
                  ))}
                </select>
              </div>
              {lookupModelId && (
                <div>
                  <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                    {t('fields.display_field')}
                  </label>
                  <select
                    value={lookupDisplayField ?? ''}
                    onChange={(e) => setLookupDisplayField(e.target.value || null)}
                    className="form-input text-sm"
                  >
                    <option value="">—</option>
                    {lookupFields.map((f) => (
                      <option key={f.id} value={f.name}>
                        {isAr ? f.label_ar : f.label_en}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <label className="flex items-center gap-2.5 cursor-pointer group py-0.5">
                <input
                  type="checkbox"
                  checked={isMulti}
                  onChange={(e) => setIsMulti(e.target.checked)}
                  className="w-4 h-4 rounded border-sand/50 text-copper focus:ring-copper/20 transition-colors"
                />
                <span className="text-[13px] font-semibold text-charcoal/70 group-hover:text-charcoal transition-colors">
                  {isAr ? 'السماح بتحديد أكثر من قيمة' : 'Allow multiple values'}
                </span>
              </label>
              {lookupModelId && (
                <div>
                  <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                    {t('fields.max_records')}
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={500}
                    value={lookupMaxRecords}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      setLookupMaxRecords(Number.isFinite(n) && n > 0 ? n : 20);
                    }}
                    className="form-input text-sm"
                  />
                  <p className="text-[11px] text-charcoal/40 mt-1">
                    {t('fields.max_records_hint')}
                  </p>
                </div>
              )}
            </div>
          </>
        )}

        {/* Mirror config */}
        {type === 'mirror' && (
          <>
            <div className="border-t border-sand/10" />
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                  {t('fields.mirror_source')}
                </label>
                <select
                  value={mirrorViaLookupFieldId ?? ''}
                  onChange={(e) => {
                    setMirrorViaLookupFieldId(e.target.value || null);
                    setMirrorTargetFieldName(null);
                  }}
                  className="form-input text-sm"
                >
                  <option value="">—</option>
                  {siblingLookupFields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {isAr ? f.label_ar : f.label_en}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-charcoal/30 mt-1.5">
                  {t('fields.mirror_source_hint')}
                </p>
                {siblingLookupFields.length === 0 && (
                  <p className="text-[11px] text-amber-500 mt-1.5">
                    {isAr
                      ? 'لا توجد حقول ربط مجاورة. أضف حقل ربط أولاً.'
                      : 'No sibling lookup fields yet. Add a lookup field first.'}
                  </p>
                )}
              </div>
              <div>
                <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                  {t('fields.mirror_target')}
                </label>
                <select
                  value={mirrorTargetFieldName ?? ''}
                  onChange={(e) => setMirrorTargetFieldName(e.target.value || null)}
                  disabled={!mirrorSibling}
                  className="form-input text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <option value="">
                    {mirrorSibling ? '—' : t('fields.mirror_select_lookup_first')}
                  </option>
                  {mirrorTargetFields.map((f) => (
                    <option key={f.id} value={f.name}>
                      {isAr ? f.label_ar : f.label_en}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-charcoal/30 mt-1.5">
                  {t('fields.mirror_target_hint')}
                </p>
              </div>
            </div>
          </>
        )}

        {/* Section mirror config */}
        {type === 'section_mirror' && (
          <>
            <div className="border-t border-sand/10" />
            <div className="space-y-4">
              {/* Step 1: sibling lookup (defines the source model + link) */}
              <div>
                <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                  {t('fields.section_mirror_source')}
                </label>
                <select
                  value={smViaLookupFieldId ?? ''}
                  onChange={(e) => {
                    setSmViaLookupFieldId(e.target.value || null);
                    setSmSourceSectionId(null);
                    setSmFieldNames([]);
                    setSmEditableFieldNames([]);
                    setSmSyncFieldNames([]);
                  }}
                  className="form-input text-sm"
                >
                  <option value="">—</option>
                  {smSiblingLookupFields.map((f) => (
                    <option key={f.id} value={f.id}>
                      {isAr ? f.label_ar : f.label_en}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-charcoal/30 mt-1.5">
                  {t('fields.section_mirror_source_hint')}
                </p>
                {smSiblingLookupFields.length === 0 && (
                  <p className="text-[11px] text-amber-500 mt-1.5">
                    {isAr
                      ? 'لا يوجد حقل ربط أحادي مناسب. أضف حقل "بحث" في هذا النموذج أولاً.'
                      : 'No suitable single-select lookup. Add a lookup field on this model first.'}
                  </p>
                )}
              </div>

              {/* Step 2: source section on the linked model */}
              <div>
                <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                  {t('fields.section_mirror_source_section')}
                </label>
                <select
                  value={smSourceSectionId ?? ''}
                  onChange={(e) => {
                    setSmSourceSectionId(e.target.value || null);
                    setSmFieldNames([]);
                    setSmEditableFieldNames([]);
                    setSmSyncFieldNames([]);
                  }}
                  disabled={!smTargetModel}
                  className="form-input text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <option value="">
                    {smTargetModel ? '—' : t('fields.section_mirror_select_lookup_first')}
                  </option>
                  {smTargetSections.map((s) => (
                    <option key={s.id} value={s.id}>
                      {isAr ? s.label_ar : s.label_en}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-charcoal/30 mt-1.5">
                  {t('fields.section_mirror_source_section_hint')}
                </p>
              </div>

              {/* Step 3: fields to mirror */}
              {smSourceSection && (
                <div>
                  <label className="block text-xs font-bold text-charcoal/50 mb-2">
                    {t('fields.section_mirror_field_mode')}
                  </label>
                  <div className="flex bg-sand/10 rounded-xl p-1 gap-0.5 mb-2">
                    {(['all', 'custom'] as SectionMirrorFieldMode[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setSmFieldMode(m)}
                        className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${
                          smFieldMode === m
                            ? 'bg-copper text-white shadow-sm'
                            : 'text-charcoal/40 hover:text-charcoal/60'
                        }`}
                      >
                        {t(`fields.section_mirror_field_mode_${m}`)}
                      </button>
                    ))}
                  </div>
                  {smFieldMode === 'custom' && (
                    <FieldPicker
                      candidates={smCandidateFields}
                      selected={smFieldNames}
                      onChange={(names) => {
                        setSmFieldNames(names);
                        // Drop editable/sync selections that aren't included anymore.
                        setSmEditableFieldNames((prev) => prev.filter((n) => names.includes(n)));
                        setSmSyncFieldNames((prev) => prev.filter((n) => names.includes(n)));
                      }}
                      isAr={isAr}
                      selectAllLabel={t('fields.section_mirror_select_all')}
                      deselectAllLabel={t('fields.section_mirror_deselect_all')}
                    />
                  )}
                </div>
              )}

              {/* Step 4: edit permissions */}
              {smSourceSection && smIncludedFieldNames.length > 0 && (
                <div>
                  <label className="block text-xs font-bold text-charcoal/50 mb-2">
                    {t('fields.section_mirror_edit_mode')}
                  </label>
                  <div className="flex bg-sand/10 rounded-xl p-1 gap-0.5 mb-2">
                    {(['all', 'none', 'custom'] as SectionMirrorControlMode[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setSmEditMode(m)}
                        className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${
                          smEditMode === m
                            ? 'bg-copper text-white shadow-sm'
                            : 'text-charcoal/40 hover:text-charcoal/60'
                        }`}
                      >
                        {t(`fields.section_mirror_edit_${m}`)}
                      </button>
                    ))}
                  </div>
                  {smEditMode === 'custom' && (
                    <FieldPicker
                      candidates={smCandidateFields.filter((f) => smIncludedFieldNames.includes(f.name))}
                      selected={smEditableFieldNames}
                      onChange={(names) => {
                        setSmEditableFieldNames(names);
                        // Sync list cannot include non-editable fields.
                        setSmSyncFieldNames((prev) => prev.filter((n) => names.includes(n)));
                      }}
                      isAr={isAr}
                      selectAllLabel={t('fields.section_mirror_select_all')}
                      deselectAllLabel={t('fields.section_mirror_deselect_all')}
                    />
                  )}
                </div>
              )}

              {/* Step 5: sync-back — only if any field is editable */}
              {smSourceSection && smIncludedFieldNames.length > 0 && smEditMode !== 'none' && (
                <div>
                  <label className="block text-xs font-bold text-charcoal/50 mb-2">
                    {t('fields.section_mirror_sync_mode')}
                  </label>
                  <div className="flex bg-sand/10 rounded-xl p-1 gap-0.5 mb-2">
                    {(['all', 'none', 'custom'] as SectionMirrorControlMode[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setSmSyncMode(m)}
                        className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all ${
                          smSyncMode === m
                            ? 'bg-copper text-white shadow-sm'
                            : 'text-charcoal/40 hover:text-charcoal/60'
                        }`}
                      >
                        {t(`fields.section_mirror_sync_${m}`)}
                      </button>
                    ))}
                  </div>
                  {smSyncMode === 'custom' && (
                    <FieldPicker
                      candidates={smCandidateFields.filter((f) => {
                        if (!smIncludedFieldNames.includes(f.name)) return false;
                        if (smEditMode === 'all') return true;
                        if (smEditMode === 'custom') return smEditableFieldNames.includes(f.name);
                        return false;
                      })}
                      selected={smSyncFieldNames}
                      onChange={setSmSyncFieldNames}
                      isAr={isAr}
                      selectAllLabel={t('fields.section_mirror_select_all')}
                      deselectAllLabel={t('fields.section_mirror_deselect_all')}
                    />
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {/* Assignee roles */}
        {type === 'assignee' && (
          <>
            <div className="border-t border-sand/10" />
            <div>
              <label className="block text-xs font-bold text-charcoal/50 mb-1">
                {t('fields.assignee_roles')}
              </label>
              <p className="text-[11px] text-charcoal/30 mb-3">{t('fields.assignee_roles_hint')}</p>
              <div className="space-y-1">
                {roles.map((role) => {
                  const checked = assigneeRoleIds.includes(role.id);
                  return (
                    <label
                      key={role.id}
                      className={`flex items-center gap-2.5 cursor-pointer py-2 px-3 rounded-lg transition-colors ${
                        checked ? 'bg-copper/[0.05]' : 'hover:bg-sand/[0.06]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setAssigneeRoleIds((prev) =>
                            prev.includes(role.id) ? prev.filter((id) => id !== role.id) : [...prev, role.id],
                          );
                        }}
                        className="w-3.5 h-3.5 rounded border-sand/50 text-copper focus:ring-copper/20"
                      />
                      <span className={`text-[13px] font-semibold flex-1 ${checked ? 'text-charcoal' : 'text-charcoal/60'}`}>
                        {isAr ? role.label_ar : role.label_en}
                      </span>
                      <span className="text-[10px] text-charcoal/25 bg-sand/10 px-1.5 py-0.5 rounded-full">
                        {role.schema.sections.reduce((acc, s) => acc + s.fields.length, 0)}
                      </span>
                    </label>
                  );
                })}
                {roles.length === 0 && (
                  <p className="text-xs text-charcoal/25 py-2">{isAr ? 'لا توجد أدوار بعد' : 'No roles yet'}</p>
                )}
              </div>
            </div>
          </>
        )}

        {/* Range config */}
        {type === 'range' && (
          <>
            <div className="border-t border-sand/10" />
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                    {t('fields.range_min')}
                  </label>
                  <input
                    type="number"
                    value={rangeMin ?? ''}
                    onChange={(e) => setRangeMin(e.target.value === '' ? undefined : Number(e.target.value))}
                    className="form-input text-sm"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                    {t('fields.range_max')}
                  </label>
                  <input
                    type="number"
                    value={rangeMax ?? ''}
                    onChange={(e) => setRangeMax(e.target.value === '' ? undefined : Number(e.target.value))}
                    className="form-input text-sm"
                    placeholder="1000"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                    {t('fields.range_step')}
                  </label>
                  <input
                    type="number"
                    value={rangeStep ?? ''}
                    onChange={(e) => setRangeStep(e.target.value === '' ? undefined : Number(e.target.value))}
                    className="form-input text-sm"
                    placeholder="1"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                    {t('fields.range_unit_ar')}
                  </label>
                  <input
                    type="text"
                    value={rangeUnitAr}
                    onChange={(e) => setRangeUnitAr(e.target.value)}
                    className="form-input text-sm"
                    placeholder="م²"
                    dir="rtl"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                    {t('fields.range_unit_en')}
                  </label>
                  <input
                    type="text"
                    value={rangeUnitEn}
                    onChange={(e) => setRangeUnitEn(e.target.value)}
                    className="form-input text-sm"
                    placeholder="m²"
                    dir="ltr"
                  />
                </div>
              </div>
              <p className="text-[11px] text-charcoal/30">
                {t('fields.range_unit_hint')}
              </p>
            </div>
          </>
        )}

        {/* Section selector info */}
        {type === 'section_selector' && (
          <>
            <div className="border-t border-sand/10" />
            <div className="flex items-start gap-2.5 p-3 bg-copper/[0.04] rounded-xl text-charcoal/50 text-[12px] leading-relaxed">
              <Info size={14} className="shrink-0 mt-0.5 text-copper/50" />
              <span>{t('fields.section_selector_info')}</span>
            </div>
          </>
        )}

        {/* Auto ID config */}
        {type === 'auto_id' && (() => {
          const sameFields = model.schema.sections.flatMap((s) => s.fields);
          const scopeCandidates = sameFields.filter(
            (f) => f.id !== field?.id && AUTO_ID_SCOPE_TYPES.includes(f.type),
          );
          const previewField: ModelField = {
            ...(field ?? ({
              id: '__preview__', name: '__preview__', label_ar: '', label_en: '',
              type: 'auto_id', required: false, order: 0, section_id: sectionId,
              width: 'half', show_in_table: true,
            } as ModelField)),
            auto_id_prefix: autoIdPrefix,
            auto_id_padding: autoIdPadding,
            auto_id_start_value: autoIdStartValue,
          };
          const previewSample = formatAutoId(previewField, autoIdStartValue);
          return (
            <>
              <div className="border-t border-sand/10" />
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                      {t('fields.auto_id.prefix')}
                    </label>
                    <input
                      type="text"
                      value={autoIdPrefix}
                      onChange={(e) => setAutoIdPrefix(e.target.value)}
                      className="form-input text-sm"
                      placeholder={t('fields.auto_id.prefix_placeholder')}
                      dir={isAr ? 'rtl' : 'ltr'}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                      {t('fields.auto_id.padding')}
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={autoIdPadding}
                      onChange={(e) => setAutoIdPadding(Math.max(0, Number(e.target.value) || 0))}
                      className="form-input text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                    {t('fields.auto_id.start_value')}
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={autoIdStartValue}
                    onChange={(e) => setAutoIdStartValue(Math.max(0, Number(e.target.value) || 0))}
                    className="form-input text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                    {t('fields.auto_id.scope_field')}
                  </label>
                  <select
                    value={autoIdScopeFieldId ?? ''}
                    onChange={(e) => setAutoIdScopeFieldId(e.target.value || null)}
                    className="form-input text-sm"
                  >
                    <option value="">{t('fields.auto_id.scope_none')}</option>
                    {scopeCandidates.map((f) => (
                      <option key={f.id} value={f.id}>
                        {isAr ? f.label_ar : f.label_en} · {t(`fields.type.${f.type}`)}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-charcoal/30 mt-1.5">{t('fields.auto_id.scope_hint')}</p>
                </div>
                <div className="flex items-center gap-2 px-3 py-2 bg-copper/[0.04] rounded-lg">
                  <span className="text-[11px] font-bold text-charcoal/50">
                    {t('fields.auto_id.preview')}:
                  </span>
                  <span className="font-mono text-[13px] text-copper font-bold" dir="ltr">
                    {previewSample}
                  </span>
                </div>
                {field && field.type === 'auto_id' && (
                  <div className="pt-2 border-t border-sand/10">
                    <button
                      type="button"
                      onClick={() => { setRestartMode(null); setShowRestartModal(true); }}
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors"
                    >
                      <RotateCcw size={12} />
                      {t('fields.auto_id.restart')}
                    </button>
                    <p className="text-[11px] text-charcoal/30 mt-1.5">{t('fields.auto_id.restart_hint')}</p>
                  </div>
                )}
              </div>
            </>
          );
        })()}

        {/* Formula config */}
        {type === 'formula' && (() => {
          const sameFields = model.schema.sections
            .flatMap((s) => s.fields)
            .filter((f) => f.id !== field?.id && f.type !== 'section_mirror');
          // Range fields expose two pickable tokens — {slug.min} and {slug.max} — so
          // users can divide / compare / concatenate the two halves separately.
          // Other field types get a single token.
          const formulaTokens: { key: string; slug: string; label: string; typeHint: string }[] =
            sameFields.flatMap((f) => {
              const base = isAr ? f.label_ar : f.label_en;
              if (f.type === 'range') {
                return [
                  { key: `${f.id}.min`, slug: `${f.name}.min`, label: `${base} — ${t('fields.range_min')}`, typeHint: 'range' },
                  { key: `${f.id}.max`, slug: `${f.name}.max`, label: `${base} — ${t('fields.range_max')}`, typeHint: 'range' },
                ];
              }
              return [{ key: f.id, slug: f.name, label: base, typeHint: f.type }];
            });
          // Insert at the caret position when possible, else append. Keeps the
          // builder ergonomic — users can position the cursor and inject a
          // field/operator/function without losing their place.
          const insertAtCaret = (snippet: string) => {
            const ta = formulaTextareaRef.current;
            if (!ta) {
              setFormulaExpression((prev) => `${prev}${prev && !prev.endsWith(' ') && !snippet.startsWith(' ') ? ' ' : ''}${snippet}`);
              return;
            }
            const start = ta.selectionStart ?? ta.value.length;
            const end = ta.selectionEnd ?? ta.value.length;
            const before = ta.value.slice(0, start);
            const after = ta.value.slice(end);
            const pad = before && !before.endsWith(' ') && !snippet.startsWith(' ') ? ' ' : '';
            const next = `${before}${pad}${snippet}${after}`;
            setFormulaExpression(next);
            // Restore focus + caret after React flush.
            requestAnimationFrame(() => {
              const el = formulaTextareaRef.current;
              if (!el) return;
              const pos = (before + pad + snippet).length;
              el.focus();
              el.setSelectionRange(pos, pos);
            });
          };
          const insertToken = (slug: string) => insertAtCaret(`{${slug}}`);
          // Operator and function buttons — structured alternatives to free-form
          // typing. Each button writes a visible, syntactically valid snippet
          // into the textarea at the caret.
          const operatorButtons: { label: string; snippet: string; title: string }[] = [
            { label: '+', snippet: ' + ', title: t('fields.formula.op_add') },
            { label: '−', snippet: ' - ', title: t('fields.formula.op_sub') },
            { label: '×', snippet: ' * ', title: t('fields.formula.op_mul') },
            { label: '÷', snippet: ' / ', title: t('fields.formula.op_div') },
            { label: '(', snippet: '(', title: t('fields.formula.op_paren_open') },
            { label: ')', snippet: ')', title: t('fields.formula.op_paren_close') },
            { label: '=', snippet: ' = ', title: t('fields.formula.op_eq') },
            { label: '≠', snippet: ' != ', title: t('fields.formula.op_neq') },
            { label: '<', snippet: ' < ', title: t('fields.formula.op_lt') },
            { label: '>', snippet: ' > ', title: t('fields.formula.op_gt') },
          ];
          const functionButtons: { label: string; snippet: string; title: string }[] = [
            { label: 'IF', snippet: 'IF(, , )', title: t('fields.formula.fn_if') },
            { label: 'ROUND', snippet: 'ROUND(, 2)', title: t('fields.formula.fn_round') },
            { label: 'SUM', snippet: 'SUM()', title: t('fields.formula.fn_sum') },
            { label: 'MIN', snippet: 'MIN()', title: t('fields.formula.fn_min') },
            { label: 'MAX', snippet: 'MAX()', title: t('fields.formula.fn_max') },
            { label: 'ABS', snippet: 'ABS()', title: t('fields.formula.fn_abs') },
            { label: 'CONCAT', snippet: 'CONCAT()', title: t('fields.formula.fn_concat') },
            { label: 'DAYS', snippet: 'DAYS(, )', title: t('fields.formula.fn_days') },
            { label: 'ADD_DAYS', snippet: 'ADD_DAYS(, )', title: t('fields.formula.fn_add_days') },
          ];
          return (
            <>
              <div className="border-t border-sand/10" />
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold text-charcoal/50 mb-1.5">
                    {t('fields.formula.expression')}
                  </label>
                  <textarea
                    ref={formulaTextareaRef}
                    value={formulaExpression}
                    onChange={(e) => setFormulaExpression(e.target.value)}
                    className="form-input text-sm font-mono"
                    rows={3}
                    placeholder={t('fields.formula.expression_placeholder')}
                    dir="ltr"
                  />
                  <p className="text-[11px] text-charcoal/30 mt-1.5">
                    {t('fields.formula.expression_hint')}
                  </p>
                </div>
                {formulaTokens.length > 0 && (
                  <div>
                    <label className="block text-[11px] font-bold text-charcoal/40 mb-1.5">
                      {t('fields.formula.insert_field')}
                    </label>
                    <select
                      value=""
                      onChange={(e) => {
                        const slug = e.target.value;
                        if (slug) insertToken(slug);
                        // Reset so the same field can be picked again.
                        e.target.value = '';
                      }}
                      className="form-input text-sm"
                    >
                      <option value="">{t('fields.formula.pick_field_placeholder')}</option>
                      {formulaTokens.map((tok) => (
                        <option key={tok.key} value={tok.slug}>
                          {tok.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-[11px] font-bold text-charcoal/40 mb-1.5">
                    {t('fields.formula.operators')}
                  </label>
                  <div className="flex flex-wrap gap-1" dir="ltr">
                    {operatorButtons.map((b) => (
                      <button
                        key={b.label}
                        type="button"
                        onClick={() => insertAtCaret(b.snippet)}
                        title={b.title}
                        className="px-2.5 py-1 rounded-md bg-sand/15 hover:bg-copper/10 text-xs text-charcoal/70 hover:text-copper font-mono font-bold transition-colors min-w-[2rem]"
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-charcoal/40 mb-1.5">
                    {t('fields.formula.functions')}
                  </label>
                  <div className="flex flex-wrap gap-1" dir="ltr">
                    {functionButtons.map((b) => (
                      <button
                        key={b.label}
                        type="button"
                        onClick={() => insertAtCaret(b.snippet)}
                        title={b.title}
                        className="px-2 py-1 rounded-md bg-copper/5 hover:bg-copper/15 text-[11px] text-copper font-mono font-bold transition-colors"
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                </div>
                {formulaParseError && (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 text-red-700 text-[11px]">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                    <span>{t('fields.formula.error_parse', { msg: formulaParseError })}</span>
                  </div>
                )}
                {!formulaParseError && formulaUnknownRefs.length > 0 && (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 text-amber-700 text-[11px]">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                    <span>{t('fields.formula.error_unknown_field', { refs: formulaUnknownRefs.map((r) => `{${r}}`).join(', ') })}</span>
                  </div>
                )}
                {!formulaParseError && formulaCyclePath && (
                  <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-50 text-red-700 text-[11px]">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                    <span>{t('fields.formula.error_cycle', { path: formulaCyclePath.join(' → ') })}</span>
                  </div>
                )}
                {!formulaHasError && formulaExpression.trim() && (() => {
                  const sampleData: Record<string, unknown> = {};
                  const preview = evaluateFormula(formulaExpression, sampleData);
                  return (
                    <div className="flex items-center gap-2 px-3 py-2 bg-copper/[0.04] rounded-lg text-[11px]">
                      <span className="font-bold text-charcoal/50">{t('fields.formula.preview_label')}:</span>
                      <span className="font-mono text-copper truncate" dir="ltr">
                        {preview === null ? '—' : String(preview)}
                      </span>
                    </div>
                  );
                })()}

                {/* ── Output formatting ── */}
                <div className="border-t border-sand/10 pt-3 space-y-3">
                  <div className="text-[11px] font-bold text-charcoal/50">
                    {t('fields.formula.output_title')}
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold text-charcoal/40 mb-1.5">
                      {t('fields.formula.output_type')}
                    </label>
                    <select
                      value={formulaOutputType}
                      onChange={(e) => setFormulaOutputType(e.target.value as typeof formulaOutputType)}
                      className="form-input text-sm"
                    >
                      <option value="number">{t('fields.formula.output_number')}</option>
                      <option value="currency">{t('fields.formula.output_currency')}</option>
                      <option value="percentage">{t('fields.formula.output_percentage')}</option>
                      <option value="text">{t('fields.formula.output_text')}</option>
                    </select>
                  </div>
                  {formulaOutputType !== 'text' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-bold text-charcoal/40 mb-1.5">
                          {t('fields.formula.output_decimals')}
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={6}
                          value={formulaDecimals}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isFinite(n)) setFormulaDecimals(Math.max(0, Math.min(6, Math.round(n))));
                          }}
                          className="form-input text-sm"
                        />
                      </div>
                      <div className="flex items-end">
                        <label className="inline-flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={formulaThousandsSeparator}
                            onChange={(e) => setFormulaThousandsSeparator(e.target.checked)}
                            className="rounded border-sand/40 text-copper focus:ring-copper/30"
                          />
                          <span className="text-xs text-charcoal/70">
                            {t('fields.formula.output_thousands')}
                          </span>
                        </label>
                      </div>
                    </div>
                  )}
                  {formulaOutputType === 'currency' && (
                    <div>
                      <label className="block text-[11px] font-bold text-charcoal/40 mb-1.5">
                        {t('fields.formula.output_currency_code')}
                      </label>
                      <select
                        value={formulaCurrency}
                        onChange={(e) => setFormulaCurrency(e.target.value)}
                        className="form-input text-sm"
                      >
                        <option value="SAR">SAR — ر.س</option>
                        <option value="USD">USD — $</option>
                        <option value="EUR">EUR — €</option>
                        <option value="GBP">GBP — £</option>
                        <option value="AED">AED — د.إ</option>
                        <option value="KWD">KWD — د.ك</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>
            </>
          );
        })()}
      </div>

      {/* ── Footer ── */}
      <div className="px-5 py-4 bg-white border-t border-sand/15 space-y-2">
        <Button onClick={handleSave} disabled={!label.trim() || formulaHasError || !!apiNameError} className="w-full py-3">
          {t('common.save')}
        </Button>
        {field && type !== 'section_selector' && type !== 'mirror' && type !== 'section_mirror' && type !== 'auto_id' && type !== 'formula' && (
          <button
            type="button"
            onClick={() => setShowSaveTemplate(true)}
            className="w-full flex items-center justify-center gap-1.5 text-[11px] font-bold text-charcoal/40 hover:text-copper transition-colors py-1"
          >
            <Bookmark size={11} />
            {isAr ? 'حفظ كقالب' : 'Save as template'}
          </button>
        )}
      </div>

      {field && (
        <SaveAsTemplateModal
          open={showSaveTemplate}
          onClose={() => setShowSaveTemplate(false)}
          field={field}
          defaultLabelAr={field.label_ar}
          defaultLabelEn={field.label_en}
        />
      )}

      {/* Rename confirmation modal */}
      <Modal
        open={!!renamePrompt}
        onClose={() => setRenamePrompt(null)}
        title={t('fields.rename_title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRenamePrompt(null)}>
              {t('fields.rename_cancel')}
            </Button>
            <Button onClick={confirmRename}>
              {t('fields.rename_confirm')}
            </Button>
          </>
        }
      >
        {renamePrompt && field && (
          <div className="space-y-3 text-sm">
            <p className="text-charcoal/70 font-mono text-xs">
              {t('fields.rename_subtitle', { old: field.name, new: renamePrompt.saved.name })}
            </p>
            <p className="text-charcoal/80">{t('fields.rename_intro')}</p>
            <ul className="list-disc ms-5 space-y-1 text-charcoal/70">
              {renamePrompt.impact.records > 0 && (
                <li>{t('fields.rename_impact_records', { count: renamePrompt.impact.records })}</li>
              )}
              {renamePrompt.impact.formulas > 0 && (
                <li>{t('fields.rename_impact_formulas', { count: renamePrompt.impact.formulas })}</li>
              )}
              {renamePrompt.impact.lookups > 0 && (
                <li>{t('fields.rename_impact_lookups', { count: renamePrompt.impact.lookups })}</li>
              )}
              {renamePrompt.impact.mirrors > 0 && (
                <li>{t('fields.rename_impact_mirrors', { count: renamePrompt.impact.mirrors })}</li>
              )}
              {renamePrompt.impact.sectionMirrors > 0 && (
                <li>{t('fields.rename_impact_section_mirrors', { count: renamePrompt.impact.sectionMirrors })}</li>
              )}
              {renamePrompt.impact.workflows > 0 && (
                <li>{t('fields.rename_impact_workflows', { count: renamePrompt.impact.workflows })}</li>
              )}
              {renamePrompt.impact.views > 0 && (
                <li>{t('fields.rename_impact_views', { count: renamePrompt.impact.views })}</li>
              )}
            </ul>
            {renamePrompt.impact.crossModelLabels.length > 0 && (
              <p className="text-[11px] text-charcoal/50">
                {renamePrompt.impact.crossModelLabels.join(' · ')}
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* Type-change confirmation modal (data-loss guard) */}
      <Modal
        open={!!typeChangePrompt}
        onClose={() => setTypeChangePrompt(null)}
        title={isAr ? 'تغيير نوع الحقل' : 'Change field type'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setTypeChangePrompt(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={confirmTypeChange}>
              {isAr ? 'تغيير النوع' : 'Change type'}
            </Button>
          </>
        }
      >
        {typeChangePrompt && field && (
          <div className="space-y-3 text-sm">
            <p className="text-charcoal/70 font-mono text-xs">
              {field.name}: {typeChangePrompt.fromType} → {typeChangePrompt.toType}
            </p>
            <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 flex gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <div>
                {isAr ? (
                  <>
                    يحتوي هذا الحقل على قيم في{' '}
                    <b>{typeChangePrompt.recordCount}</b>{' '}
                    سجل. تغيير النوع قد يجعل القيم المخزنة غير قابلة للعرض بشكل صحيح.
                  </>
                ) : (
                  <>
                    This field has values in <b>{typeChangePrompt.recordCount}</b>{' '}
                    {typeChangePrompt.recordCount === 1 ? 'record' : 'records'}. Changing the type
                    may make the stored values display incorrectly.
                  </>
                )}
              </div>
            </div>
            <p className="text-charcoal/70">
              {isAr
                ? 'توصي النصيحة بإنشاء حقل جديد بالنوع المطلوب ونقل البيانات يدويًا. هل تريد المتابعة؟'
                : 'The safer path is to create a new field with the desired type and migrate the data manually. Continue anyway?'}
            </p>
          </div>
        )}
      </Modal>

      {/* Auto ID restart modal */}
      <Modal
        open={showRestartModal}
        onClose={() => setShowRestartModal(false)}
        title={t('fields.auto_id.restart_title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowRestartModal(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={performRestart} disabled={!restartMode}>
              {t('fields.auto_id.restart_confirm')}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-charcoal/70">{t('fields.auto_id.restart_choose')}</p>
          {(['reset', 'renumber'] as const).map((mode) => (
            <label
              key={mode}
              className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                restartMode === mode
                  ? 'border-copper bg-copper/[0.05]'
                  : 'border-sand/40 hover:border-sand/70 bg-white'
              }`}
            >
              <input
                type="radio"
                name="restart_mode"
                value={mode}
                checked={restartMode === mode}
                onChange={() => setRestartMode(mode)}
                className="mt-0.5 w-4 h-4 text-copper focus:ring-copper/20"
              />
              <div className="flex-1">
                <div className="text-sm font-bold text-charcoal mb-0.5">
                  {t(mode === 'reset' ? 'fields.auto_id.restart_reset_only' : 'fields.auto_id.restart_renumber')}
                </div>
                <div className="text-[12px] text-charcoal/50 leading-relaxed">
                  {t(mode === 'reset' ? 'fields.auto_id.restart_reset_desc' : 'fields.auto_id.restart_renumber_desc')}
                </div>
              </div>
            </label>
          ))}
        </div>
      </Modal>
    </div>
  );
}

/** Empty state when no field is selected */
export function FieldEditorEmpty() {
  const { language } = useAppStore();
  const isAr = language === 'ar';

  return (
    <div className="h-full flex flex-col bg-[#FDFCFA]">
      {/* Header — same as active state for consistency */}
      <div className="px-5 pt-5 pb-4">
        <h3 className="text-sm font-bold text-chocolate">
          {isAr ? 'خصائص الحقل' : 'Field Properties'}
        </h3>
      </div>
      <div className="mx-5 border-t border-sand/15" />

      {/* Centered empty state */}
      <div className="flex-1 flex flex-col items-center justify-center px-8">
        <div className="w-14 h-14 rounded-2xl bg-copper/[0.06] flex items-center justify-center mb-4">
          <Layers size={24} className="text-copper/30" />
        </div>
        <p className="text-[13px] font-bold text-charcoal/35 text-center leading-relaxed">
          {isAr ? 'حدد حقلاً لعرض خصائصه' : 'Select a field to view its properties'}
        </p>
        <p className="text-[11px] text-charcoal/20 text-center mt-1.5 leading-relaxed">
          {isAr
            ? 'اضغط على أي حقل في المنتصف، أو اختر نوعاً من القائمة'
            : 'Click any field in the center, or pick a type from the catalog'}
        </p>
      </div>
    </div>
  );
}
