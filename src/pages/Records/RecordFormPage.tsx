import { useState, useMemo, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { getIconComponent } from '@/components/layout/Sidebar';
import * as lucideIcons from 'lucide-react';
import { ArrowRight, Save, Trash2, FileDown, ChevronLeft, ChevronRight, Sparkles, Loader2, type LucideIcon } from 'lucide-react';
import { generateResearchPDF } from '@/lib/pdfGenerator';
import { resolveSectionMirror } from '@/lib/sectionMirrorResolver';
import { resolveSectionMirrorFieldMulti } from '@/lib/sectionMirrorExpand';
import { activityLogger } from '@/lib/activityLogger';
import { supabase } from '@/lib/supabase';
import type { CustomButton } from '@/types';

/**
 * Resolve a lucide-react icon by name. Names are kebab-case in the Builder
 * input ('wand-2', 'file-down') because that's how Lucide documents them;
 * the ESM exports are PascalCase ('Wand2', 'FileDown'), so we normalize.
 * Falls back to Sparkles when the name doesn't resolve.
 */
function resolveLucideIcon(name?: string): LucideIcon {
  const pascal = (name ?? 'sparkles')
    .trim()
    .replace(/(^|-)(\w)/g, (_, _dash, c: string) => c.toUpperCase());
  const Icon = (lucideIcons as unknown as Record<string, LucideIcon>)[pascal];
  return Icon ?? Sparkles;
}
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import SectionBlock from './components/SectionBlock';
import CallHistoryPanel from './components/CallHistoryPanel';
import { useCanEditRecord, useCanViewRecord, useFieldPermissionResolver, usePermission } from '@/hooks/usePermission';
import { isButtonVisible } from '@/lib/permissions';
import type { ModelView } from '@/types';

export default function RecordFormPage() {
  const { modelName, recordId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const {
    models,
    records,
    language,
    saveRecord,
    deleteRecord,
    addToast,
    views,
    currentUserId,
    users,
    profiles,
    recordNavContext,
  } = useAppStore();
  const isAr = language === 'ar';

  const model = models.find((m) => m.name === modelName);
  const canCreate = usePermission(model?.id ?? '', 'create');
  const canDelete = usePermission(model?.id ?? '', 'delete');
  const isNew = !recordId || recordId === 'new';
  const existingRecord = model && !isNew
    ? (records[model.id] ?? []).find((r) => r.id === recordId)
    : null;
  // For existing records, view/edit eligibility threads through view_scope and
  // edit_scope (canViewRecord/canEditRecord compose both with the model-level
  // perms). For new records, we still gate on the create permission only —
  // there's no record to scope yet.
  const canViewExisting = useCanViewRecord(model, existingRecord);
  const canEditExisting = useCanEditRecord(model, existingRecord);
  const readOnly = isNew ? !canCreate : !canEditExisting;
  // Per-field hidden/readonly/editable resolver. Computed fields are forced
  // to readonly inside the helper, so the form never offers an editable
  // formula even if the matrix says so.
  const resolveFieldPermission = useFieldPermissionResolver(model?.id ?? '');

  const [formData, setFormData] = useState<Record<string, unknown>>(
    existingRecord?.data ?? {},
  );
  // Pending edits to linked records inside mirrored sections.
  // Keyed by target record id → field-name → new value.
  const [mirrorEdits, setMirrorEdits] = useState<Record<string, Record<string, unknown>>>({});
  const [showDelete, setShowDelete] = useState(false);
  // Tracks whether the form has unsaved user edits. Used to guard prev/next
  // navigation with a confirm prompt.
  const [isDirty, setIsDirty] = useState(false);
  // True while the All Projects "Research project" button is firing the
  // Claude Code routine via /api/research-project.
  const [isResearching, setIsResearching] = useState(false);
  // ID of the currently-running custom button (if any). Used to render a
  // spinner on the active button and disable other buttons while it runs.
  const [runningButtonId, setRunningButtonId] = useState<string | null>(null);

  // Prev/next navigation uses the filtered+sorted list published by
  // RecordListPage. If no nav context is available (e.g. deep-linked into a
  // record), fall back to the full model's insertion order.
  const orderedIds = useMemo(() => {
    if (recordNavContext && model && recordNavContext.modelId === model.id) {
      return recordNavContext.orderedIds;
    }
    return model ? (records[model.id] ?? []).map((r) => r.id) : [];
  }, [recordNavContext, model, records]);
  const currentIndex = recordId ? orderedIds.indexOf(recordId) : -1;
  const prevId = currentIndex > 0 ? orderedIds[currentIndex - 1] ?? null : null;
  const nextId =
    currentIndex >= 0 && currentIndex < orderedIds.length - 1
      ? orderedIds[currentIndex + 1] ?? null
      : null;

  // Active research comparison view — per research record, persisted to localStorage.
  const researchViewKey = useMemo(
    () =>
      model && model.name === 'projects_research'
        ? `wassell_research_view_last_${recordId ?? 'new'}_${currentUserId ?? 'anon'}`
        : null,
    [model, recordId, currentUserId],
  );
  const [activeResearchViewId, setActiveResearchViewIdState] = useState<string | null>(() => {
    if (!researchViewKey) return null;
    try {
      const raw = localStorage.getItem(researchViewKey);
      return raw ? (JSON.parse(raw) as string | null) : null;
    } catch {
      return null;
    }
  });
  const setActiveResearchViewId = (id: string | null) => {
    setActiveResearchViewIdState(id);
    if (researchViewKey) {
      try {
        localStorage.setItem(researchViewKey, JSON.stringify(id));
      } catch {
        // ignore
      }
    }
  };
  const activeResearchView: ModelView | null = useMemo(() => {
    if (!model || !activeResearchViewId) return null;
    return views.find((v) => v.id === activeResearchViewId && v.model_id === model.id) ?? null;
  }, [views, model, activeResearchViewId]);

  // Auto-apply the default research view on first load if the user hasn't chosen one.
  useEffect(() => {
    if (!model || model.name !== 'projects_research') return;
    if (activeResearchViewId !== null) return;
    const defaultView = views.find(
      (v) => v.model_id === model.id && v.is_default && (v.user_id === currentUserId || v.is_shared),
    );
    if (defaultView) setActiveResearchViewId(defaultView.id);
  }, [model, views, currentUserId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset form when navigating between records. Also re-initialize when the
  // record first becomes available after store hydration — on hard reloads
  // `initialize()` runs after the first render, so the useState initializer
  // captured an empty record and formData would otherwise stay empty.
  useEffect(() => {
    setFormData(existingRecord?.data ?? {});
    setMirrorEdits({});
    setShowDelete(false);
    setIsDirty(false);
  }, [recordId, modelName, existingRecord?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Activity log — fire one "record opened" event per record-mount. The
  // RecordFormPageRoute wrapper in App.tsx remounts on recordId change, so
  // this useEffect runs once per record visit. We only fire for existing
  // records (skip the "new record" form) and only after the record + model
  // have hydrated.
  useEffect(() => {
    if (isNew || !model || !existingRecord) return;
    activityLogger.recordOpened(existingRecord.id, model.id, model, existingRecord);
  }, [model?.id, existingRecord?.id, isNew]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every phone-type value currently on the record. Passed to CallHistoryPanel
  // so we load call_logs rows keyed on any phone on the record (main +
  // alternates). When the list is empty, the panel renders nothing.
  const phoneValues = useMemo(() => {
    if (!model) return [] as string[];
    const out: string[] = [];
    for (const section of model.schema.sections) {
      for (const field of section.fields) {
        if (field.type !== 'phone') continue;
        const raw = formData[field.name];
        if (typeof raw === 'string' && raw.trim()) out.push(raw);
      }
    }
    return out;
  }, [model, formData]);

  const visibleSections = useMemo(() => {
    if (!model) return [];
    const sorted = [...model.schema.sections].sort((a, b) => a.order - b.order);
    const selectorFieldId = model.schema.section_selector_field_id;
    if (!selectorFieldId) return sorted;
    const selectorField = model.schema.sections
      .flatMap((s) => s.fields)
      .find((f) => f.id === selectorFieldId);
    const selectorValue = selectorField
      ? (formData[selectorField.name] as string[] | undefined) ?? []
      : [];
    // Base sections + mirrored sections always render; others only if picked via selector.
    return sorted.filter((s) => s.is_base || s.is_mirrored || selectorValue.includes(s.id));
  }, [model, formData]);

  if (!model) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-charcoal/40">
        <p className="text-lg font-bold">404</p>
      </div>
    );
  }

  // View-scope gate. A record that fails the profile's view_scope is invisible
  // — render the same 404 state as a missing record so the URL never confirms
  // existence. Skip the check while existingRecord is still resolving (e.g.
  // first paint before initialize() drains pending writes) to avoid flicker.
  if (!isNew && existingRecord && !canViewExisting) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-charcoal/40">
        <p className="text-lg font-bold">404</p>
      </div>
    );
  }

  const Icon = getIconComponent(model.icon);

  const handleFieldChange = (fieldName: string, value: unknown) => {
    setFormData((prev) => ({ ...prev, [fieldName]: value }));
    setIsDirty(true);
  };

  const handleMirrorFieldChange = (targetRecordId: string, fieldName: string, value: unknown) => {
    setMirrorEdits((prev) => ({
      ...prev,
      [targetRecordId]: { ...(prev[targetRecordId] ?? {}), [fieldName]: value },
    }));
    setIsDirty(true);
  };

  const goToRecord = (targetId: string) => {
    if (isDirty && !window.confirm(t('records.discard_changes_confirm'))) return;
    navigate(`/model/${model!.name}/${targetId}`);
  };

  // Fires the Claude Code "Research Project" routine for an All Projects
  // record. Sends the live form values for project name + location URL (so
  // the user can edit + click without saving first). The OAuth token never
  // reaches the browser — /api/research-project forwards with the bearer
  // header from server-side env vars.
  //
  // Field resolution: the All Projects model's schema is user-customizable
  // in the Builder (slugs change, fields get added/removed). We read the
  // location URL via the canonical per-model pointer used by the Maps view —
  // `model.maps_config.location_url_field_id` — and fall back to the seed
  // default `location` slug only when no Maps location field is configured.
  const handleResearchProject = async () => {
    if (!model || !existingRecord) return;
    const allFields = model.schema.sections.flatMap((s) => s.fields);
    const locationFieldId = model.maps_config?.location_url_field_id ?? null;
    const locationField = locationFieldId
      ? allFields.find((f) => f.id === locationFieldId) ?? null
      : null;
    const locationValue = locationField
      ? formData[locationField.name]
      : formData.location;
    const projectName = String(formData.project_name ?? '').trim();
    const location = String(locationValue ?? '').trim();
    if (!projectName) {
      addToast(
        isAr ? 'اسم المشروع مطلوب لبدء البحث' : 'Project name is required to start research',
        'error',
      );
      return;
    }
    if (!location) {
      addToast(
        isAr
          ? 'رابط الموقع مطلوب لبدء البحث — اضبط حقل رابط الموقع في إعدادات الخريطة بالنموذج'
          : 'Location URL is required — set the location URL field in the Maps Builder',
        'error',
      );
      return;
    }

    setIsResearching(true);
    try {
      const session = supabase ? (await supabase.auth.getSession()).data.session : null;
      const authHeader: Record<string, string> = session?.access_token
        ? { Authorization: `Bearer ${session.access_token}` }
        : {};
      const res = await fetch('/api/research-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          project_name: projectName,
          location,
          record_id: existingRecord.id,
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: res.statusText }));
        const message = errBody?.error ?? `Request failed (${res.status})`;
        addToast(
          isAr ? `فشل بدء البحث: ${message}` : `Research failed: ${message}`,
          'error',
        );
        return;
      }
      const okBody = (await res.json().catch(() => null)) as
        | { rows_added?: number; project_name?: string; sources?: string[] }
        | null;
      const rowCount = okBody?.rows_added ?? 0;
      addToast(
        isAr
          ? `تم بحث "${projectName}" — أضيفت ${rowCount} صف لجدول دراسة 2 كيلو`
          : `Researched "${projectName}" — added ${rowCount} rows to the 2 km study`,
        'success',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(
        isAr ? `فشل بدء البحث: ${msg}` : `Research failed: ${msg}`,
        'error',
      );
    } finally {
      setIsResearching(false);
    }
  };

  /**
   * Fire one of the model's user-configured custom buttons. Sends
   * { record_id, button_id } to /api/run-button-workflow. The server-side
   * runner loads the workflow, executes its paseet_query actions against
   * the current record, and applies the response mappings back onto the
   * record. On success we surface what the runner did (rows added, fields
   * touched) and refresh the form's local state by re-reading the record
   * from Supabase — so the UI shows the new values without a hard reload.
   */
  const handleCustomButtonClick = async (button: CustomButton): Promise<void> => {
    if (!model || !existingRecord) return;
    if (button.action.type !== 'trigger_workflow') return;
    if (!button.action.workflow_id) {
      addToast(
        isAr ? 'هذا الزر لم يربط بأي سير عمل بعد' : 'This button is not connected to any workflow yet',
        'error',
      );
      return;
    }
    setRunningButtonId(button.id);
    try {
      const session = supabase ? (await supabase.auth.getSession()).data.session : null;
      const authHeader: Record<string, string> = session?.access_token
        ? { Authorization: `Bearer ${session.access_token}` }
        : {};
      const res = await fetch('/api/run-button-workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          record_id: existingRecord.id,
          button_id: button.id,
        }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: res.statusText }));
        addToast(
          isAr
            ? `فشل تنفيذ الزر: ${errBody?.error ?? `(${res.status})`}`
            : `Button failed: ${errBody?.error ?? `(${res.status})`}`,
          'error',
        );
        return;
      }
      const okBody = (await res.json().catch(() => null)) as
        | { ran?: number; mappings_applied?: number; skipped?: number }
        | null;
      const updated = okBody?.mappings_applied ?? 0;
      addToast(
        isAr
          ? updated > 0
            ? `تم — تم تحديث ${updated} حقل من رد بسيط`
            : 'تم تنفيذ الزر بدون تغييرات على السجل'
          : updated > 0
            ? `Done — ${updated} field${updated === 1 ? '' : 's'} updated from Paseet`
            : 'Button ran with no record changes',
        'success',
      );
      // Refresh the record's data from Supabase so the form picks up
      // anything the workflow wrote — without a full page reload.
      // Reads go through `unified_records`, the UNION of the JSONB
      // `records` table and each frozen model's `<name>_v` view, so
      // the right data is fetched whether the model has been frozen or
      // not.
      if (supabase) {
        const { data: fresh } = await supabase
          .from('unified_records')
          .select('data')
          .eq('id', existingRecord.id)
          .single();
        if (fresh && fresh.data) {
          setFormData(fresh.data as Record<string, unknown>);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(isAr ? `فشل تنفيذ الزر: ${msg}` : `Button failed: ${msg}`, 'error');
    } finally {
      setRunningButtonId(null);
    }
  };

  const handleSave = () => {
    // 1. Validate required fields on this record (skip derived mirror fields).
    const allFields = model.schema.sections
      .filter((s) => !s.is_mirrored)
      .flatMap((s) => s.fields);
    const missing = allFields.filter((f) => {
      if (!f.required) return false;
      if (f.type === 'mirror') return false;
      const val = formData[f.name];
      if (f.type === 'lookup' && f.is_multi) {
        return !Array.isArray(val) || val.length === 0;
      }
      return val === undefined || val === null || val === '';
    });

    if (missing.length > 0) {
      const label = isAr ? missing[0]!.label_ar : missing[0]!.label_en;
      addToast(`${isAr ? 'الحقل مطلوب: ' : 'Required field: '}${label}`, 'error');
      return;
    }

    // 2. Validate required fields inside mirrored sections (using overlaid effective values).
    for (const section of model.schema.sections) {
      if (!section.is_mirrored) continue;
      const res = resolveSectionMirror(section, formData, model, records, models);
      if (res.status !== 'ok' || !res.sourceSection || !res.targetRecord) continue;
      const targetId = res.targetRecord.id;
      const overlay = mirrorEdits[targetId] ?? {};
      const effective = { ...res.targetRecord.data, ...overlay };
      const missingMirror = res.sourceSection.fields.filter((f) => {
        if (!f.required) return false;
        if (f.type === 'mirror') return false;
        const val = effective[f.name];
        if (f.type === 'lookup' && f.is_multi) {
          return !Array.isArray(val) || val.length === 0;
        }
        return val === undefined || val === null || val === '';
      });
      if (missingMirror.length > 0) {
        const label = isAr ? missingMirror[0]!.label_ar : missingMirror[0]!.label_en;
        addToast(`${isAr ? 'الحقل مطلوب في السجل المرتبط: ' : 'Required field on linked record: '}${label}`, 'error');
        return;
      }
    }

    // 2b. Validate required fields inside multi-target section_mirror overlays.
    // Fires on research comparison edits — each target record's required fields
    // are validated against the effective (record.data + pendingOverlay) state.
    for (const section of model.schema.sections) {
      for (const fld of section.fields) {
        if (fld.type !== 'section_mirror') continue;
        const multi = resolveSectionMirrorFieldMulti(fld, formData, model, records, models);
        if (multi.status !== 'ok') continue;
        for (const t of multi.targets) {
          if (!t.targetRecord) continue;
          const overlay = mirrorEdits[t.id] ?? {};
          if (Object.keys(overlay).length === 0) continue; // nothing edited for this target
          const effective = { ...t.targetRecord.data, ...overlay };
          const missingOverlay = multi.includedFields.filter((f) => {
            if (!f.required) return false;
            if (f.type === 'mirror') return false;
            if (!multi.syncFieldNames.has(f.name)) return false; // only validate what will actually sync back
            if (!(f.name in overlay)) return false; // only validate edits the user made
            const val = effective[f.name];
            if (f.type === 'lookup' && f.is_multi) {
              return !Array.isArray(val) || val.length === 0;
            }
            return val === undefined || val === null || val === '';
          });
          if (missingOverlay.length > 0) {
            const label = isAr ? missingOverlay[0]!.label_ar : missingOverlay[0]!.label_en;
            addToast(`${isAr ? 'الحقل مطلوب في السجل المرتبط: ' : 'Required field on linked record: '}${label}`, 'error');
            return;
          }
        }
      }
    }

    // 3. Fan-out: save each edited target record first.
    for (const [targetId, overlay] of Object.entries(mirrorEdits)) {
      if (!overlay || Object.keys(overlay).length === 0) continue;
      // Find which model this target lives under by scanning records.
      let hostModelId: string | null = null;
      let target = null as (typeof records)[string][number] | null;
      for (const [modelId, list] of Object.entries(records)) {
        const found = list.find((r) => r.id === targetId);
        if (found) {
          hostModelId = modelId;
          target = found;
          break;
        }
      }
      if (!hostModelId || !target) {
        addToast(isAr ? 'تعذّر حفظ السجل المرتبط: تم حذفه.' : 'Could not save linked record: it was deleted.', 'error');
        return;
      }
      const updatedTarget = {
        ...target,
        data: { ...target.data, ...overlay },
        updated_at: new Date().toISOString(),
      };
      saveRecord(updatedTarget);
    }

    // 4. Save this record.
    const record = {
      id: existingRecord?.id ?? uuid(),
      model_id: model.id,
      data: formData,
      created_at: existingRecord?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    saveRecord(record);
    setIsDirty(false);
    addToast(t('toast.saved'), 'success');
    navigate(`/model/${model.name}`);
  };

  const handleDelete = () => {
    if (existingRecord) {
      deleteRecord(model.id, existingRecord.id);
      addToast(t('toast.deleted'), 'success');
    }
    setShowDelete(false);
    navigate(`/model/${model.name}`);
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(`/model/${model.name}`)}
            className="p-2 rounded-lg hover:bg-sand/30 text-charcoal/40 hover:text-charcoal transition-colors"
          >
            <ArrowRight size={20} className="rtl:rotate-0 ltr:rotate-180" />
          </button>
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: `${model.color}15` }}
          >
            <Icon size={22} style={{ color: model.color }} />
          </div>
          <h1 className="text-xl font-bold text-charcoal">
            {isNew
              ? `${t('records.new_record')} — ${isAr ? model.label_ar : model.label_en}`
              : `${t('records.edit_record')} — ${isAr ? model.label_ar : model.label_en}`}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {!isNew && (
            <>
              <button
                type="button"
                onClick={() => prevId && goToRecord(prevId)}
                disabled={!prevId}
                title={t('records.previous_record')}
                aria-label={t('records.previous_record')}
                className="p-2 rounded-lg hover:bg-sand/30 text-charcoal/40 hover:text-charcoal transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-charcoal/40"
              >
                <ChevronLeft size={20} className="rtl:rotate-180" />
              </button>
              <button
                type="button"
                onClick={() => nextId && goToRecord(nextId)}
                disabled={!nextId}
                title={t('records.next_record')}
                aria-label={t('records.next_record')}
                className="p-2 rounded-lg hover:bg-sand/30 text-charcoal/40 hover:text-charcoal transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-charcoal/40"
              >
                <ChevronRight size={20} className="rtl:rotate-180" />
              </button>
            </>
          )}
          {model.name === 'all_projects' && existingRecord && (
            <Button
              variant="secondary"
              onClick={() => void handleResearchProject()}
              disabled={isResearching}
            >
              <Sparkles size={16} />
              {isResearching ? t('records.research_project_running') : t('records.research_project')}
            </Button>
          )}
          {/* User-configured custom buttons attached to this model. Filtered
           *  to those that opted into the record_form location, aren't
           *  disabled, AND aren't hidden by the active profile's
           *  hidden_button_ids deny-list. Hidden on /new (no existingRecord
           *  to act on). */}
          {existingRecord && (model.schema.custom_buttons ?? [])
            .filter((b: CustomButton) => b.enabled !== false && b.locations.includes('record_form'))
            .filter((b: CustomButton) => isButtonVisible(currentUserId, users, profiles, b.id))
            .map((btn: CustomButton) => {
              const Icon = resolveLucideIcon(btn.icon);
              const running = runningButtonId === btn.id;
              const someoneRunning = runningButtonId !== null;
              const label = (isAr ? btn.label_ar : btn.label_en) || btn.id;
              return (
                <Button
                  key={btn.id}
                  variant="secondary"
                  onClick={() => void handleCustomButtonClick(btn)}
                  disabled={someoneRunning}
                  style={btn.color ? { color: btn.color, borderColor: `${btn.color}40` } : undefined}
                >
                  {running ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} />}
                  {label}
                </Button>
              );
            })}
          {model.name === 'projects_research' && existingRecord && (
            <Button
              variant="secondary"
              onClick={() => void generateResearchPDF(existingRecord, records, models, activeResearchView)}
            >
              <FileDown size={16} />
              {t('records.generate_pdf')}
            </Button>
          )}
          {!isNew && canDelete && (
            <Button variant="danger" onClick={() => setShowDelete(true)}>
              <Trash2 size={16} />
              {t('common.delete')}
            </Button>
          )}
          {!readOnly && (
          <Button onClick={handleSave}>
            <Save size={16} />
            {t('common.save')}
          </Button>
          )}
        </div>
      </div>

      {/* Sections */}
      <div className="space-y-6">
        {visibleSections.map((section) => (
          <SectionBlock
            key={section.id}
            section={section}
            formData={formData}
            onChange={handleFieldChange}
            currentModel={model}
            mirrorEdits={mirrorEdits}
            onMirrorFieldChange={handleMirrorFieldChange}
            activeResearchView={activeResearchView}
            onSelectResearchView={setActiveResearchViewId}
            formReadOnly={readOnly}
            getFieldPermission={resolveFieldPermission}
          />
        ))}
      </div>

      {/* Call history — every Hatif-logged call for any phone on this record */}
      {existingRecord && phoneValues.length > 0 && (
        <div className="mt-6">
          <CallHistoryPanel phones={phoneValues} />
        </div>
      )}

      {/* Delete modal */}
      <Modal
        open={showDelete}
        onClose={() => setShowDelete(false)}
        title={t('records.delete_record')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowDelete(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={handleDelete}>
              <Trash2 size={14} />
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="text-charcoal">{t('records.delete_confirm')}</p>
      </Modal>
    </div>
  );
}
