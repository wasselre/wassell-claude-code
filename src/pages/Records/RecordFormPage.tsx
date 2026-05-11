import { useState, useMemo, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { getIconComponent } from '@/components/layout/Sidebar';
import * as lucideIcons from 'lucide-react';
import { ArrowRight, Save, Trash2, ChevronLeft, ChevronRight, Sparkles, Loader2, type LucideIcon } from 'lucide-react';
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
import RecordFormModal from './components/RecordFormModal';
import RecordTabBar, { type RecordTab } from './components/RecordTabBar';
import ClientDetailsTabPane from './components/ClientDetailsTabPane';
import { Users } from 'lucide-react';
import { useAutoLink } from './hooks/useAutoLink';
import { useAutoFill } from './hooks/useAutoFill';
import { buildCreatePrefill, buildPrefill, findLatestMatch } from './utils/recordButtonActions';
import { useCanEditRecord, useCanViewRecord, useFieldPermissionResolver, usePermission } from '@/hooks/usePermission';
import { isButtonVisible } from '@/lib/permissions';

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
  // Audit fix H5: snapshot the version we LOADED with so saveRecord can
  // pass it as p_expected_version. The live store value is mutated by
  // realtime echoes — if a concurrent writer bumps the version while
  // this form is open, sourcing from the live store would silently
  // accept the write and overwrite the other user's changes.
  //
  // Implementation note: a useState initializer + useEffect pattern
  // doesn't work reliably here. The initializer captures `existingRecord`
  // at first render; if records are still loading at first paint, it
  // captures null. The useEffect then sets the snapshot to the live
  // version — but if the live version was ALREADY bumped by a realtime
  // echo before the effect ran, we'd capture the bumped value. Using a
  // useRef captured during render fixes both: we set the ref the first
  // time we observe a non-null existingRecord for this nav key, and
  // ignore every subsequent change. Reset on navigation.
  const versionSnapshotRef = useRef<{ navKey: string; version: number | null } | null>(null);
  // Per-target version snapshots for mirrored-section fan-out (audit C1).
  // Captured the first time the user touches a mirror field for that
  // target — same reasoning as the main versionSnapshotRef.
  const targetVersionSnapshotsRef = useRef<Record<string, number | null>>({});
  const navKey = `${modelName ?? ''}/${recordId ?? 'new'}`;
  if (existingRecord && versionSnapshotRef.current?.navKey !== navKey) {
    versionSnapshotRef.current = {
      navKey,
      version: existingRecord.version ?? null,
    };
  }
  const versionSnapshot = versionSnapshotRef.current?.version ?? null;
  // Audit fix M2: snapshot the model's `updated_at` at form-mount so
  // we can detect "the schema changed while this form was open" on
  // Save. If an admin renamed/added/removed a field via the Builder
  // mid-edit, the form's slugs are stale; saving would either lose
  // the user's work to the now-removed slug or silently write to
  // the new one with the wrong shape. Refusing the save and prompting
  // a reload is the only safe default.
  const [modelUpdatedAtSnapshot, setModelUpdatedAtSnapshot] = useState<string | null>(
    model?.updated_at ?? null,
  );
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
  // Open record-form modal triggered by a `create_record` /
  // `find_or_create_record` custom button. Null when no modal is open.
  const [recordModal, setRecordModal] = useState<{
    modelId: string;
    recordId: string | null;
    prefill?: Record<string, unknown>;
  } | null>(null);

  // Smart auto-link + auto-fill primitives. The hooks no-op when no field
  // on this model declares the relevant config, so they're cheap to mount
  // unconditionally for every record form.
  useAutoLink({ model, formData, setFormData });
  useAutoFill({ model, formData, setFormData });

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

  // Reset form when navigating between records. Also re-initialize when the
  // record first becomes available after store hydration — on hard reloads
  // `initialize()` runs after the first render, so the useState initializer
  // captured an empty record and formData would otherwise stay empty.
  useEffect(() => {
    setFormData(existingRecord?.data ?? {});
    setMirrorEdits({});
    setShowDelete(false);
    setIsDirty(false);
    // Audit fix H5/C1: clear the per-target snapshots on navigation.
    // The main versionSnapshotRef is keyed on navKey and re-captures
    // automatically during render when navKey changes — no reset here.
    targetVersionSnapshotsRef.current = {};
    setModelUpdatedAtSnapshot(model?.updated_at ?? null);
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

  // ─── Client Details tab ──────────────────────────────────────────
  // Show a "Client Details" tab when this record either IS a client (so the
  // tab adds the cross-model related-records list to the 360°) or has at
  // least one populated `lookup` field pointing at the clients model.
  // Multi-client-lookup case: surface every populated candidate so the user
  // can switch between them via the `?client=<id>` query param. Default to
  // the first.
  const clientsModelId = useMemo(
    () => models.find((m) => m.name === 'clients')?.id ?? null,
    [models],
  );

  const clientCandidateIds = useMemo<string[]>(() => {
    if (!model) return [];
    if (model.name === 'clients' && existingRecord) return [existingRecord.id];
    if (!clientsModelId) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const sec of model.schema.sections) {
      for (const f of sec.fields) {
        if (f.type !== 'lookup' || f.lookup_model_id !== clientsModelId) continue;
        const v = formData[f.name];
        if (Array.isArray(v)) {
          for (const id of v) {
            if (typeof id === 'string' && id && !seen.has(id)) { seen.add(id); out.push(id); }
          }
        } else if (typeof v === 'string' && v && !seen.has(v)) {
          seen.add(v);
          out.push(v);
        }
      }
    }
    return out;
  }, [model, formData, clientsModelId, existingRecord]);

  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') === 'client' && clientCandidateIds.length > 0
    ? 'client'
    : 'form';
  const activeClientId = (() => {
    const param = searchParams.get('client');
    if (param && clientCandidateIds.includes(param)) return param;
    return clientCandidateIds[0] ?? null;
  })();

  const tabs = useMemo<RecordTab[]>(() => {
    if (clientCandidateIds.length === 0) return [];
    return [
      { id: 'form', label_ar: 'النموذج', label_en: 'Form' },
      {
        id: 'client',
        label_ar: 'تفاصيل العميل',
        label_en: 'Client Details',
        icon: <Users size={14} />,
      },
    ];
  }, [clientCandidateIds]);

  const handleTabChange = (next: string) => {
    const sp = new URLSearchParams(searchParams);
    if (next === 'client') {
      sp.set('tab', 'client');
      if (activeClientId) sp.set('client', activeClientId);
    } else {
      sp.delete('tab');
      sp.delete('client');
    }
    setSearchParams(sp, { replace: true });
  };

  const handleClientSwitch = (id: string) => {
    const sp = new URLSearchParams(searchParams);
    sp.set('tab', 'client');
    sp.set('client', id);
    setSearchParams(sp, { replace: true });
  };

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
    // Audit fix C1: capture the target's version on first touch only,
    // so realtime echoes between now and Save don't silently advance it
    // past the value we'd want to send as p_expected_version. Stored on
    // a ref so it isn't reset by re-renders or realtime updates.
    if (!(targetRecordId in targetVersionSnapshotsRef.current)) {
      let snapshot: number | null = null;
      for (const list of Object.values(records)) {
        const found = list.find((r) => r.id === targetRecordId);
        if (found) {
          snapshot = found.version ?? null;
          break;
        }
      }
      targetVersionSnapshotsRef.current = {
        ...targetVersionSnapshotsRef.current,
        [targetRecordId]: snapshot,
      };
    }
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
   * Fire one of the model's user-configured custom buttons. Dispatches on
   * the action type:
   *
   *   - `trigger_workflow` → POST /api/run-button-workflow (Paseet flow).
   *   - `generate_design`  → POST /api/marketing/generate (two-phase
   *     Higgsfield orchestration on marketing_operations records).
   *
   * After either succeeds we re-read the record via `unified_records` so
   * the form reflects whatever the server wrote without a full reload.
   */
  const handleCustomButtonClick = async (button: CustomButton): Promise<void> => {
    if (!model || !existingRecord) return;
    setRunningButtonId(button.id);
    try {
      const session = supabase ? (await supabase.auth.getSession()).data.session : null;
      const authHeader: Record<string, string> = session?.access_token
        ? { Authorization: `Bearer ${session.access_token}` }
        : {};

      if (button.action.type === 'trigger_workflow') {
        if (!button.action.workflow_id) {
          addToast(
            isAr ? 'هذا الزر لم يربط بأي سير عمل بعد' : 'This button is not connected to any workflow yet',
            'error',
          );
          return;
        }
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
      } else if (button.action.type === 'create_record') {
        // Open RecordFormModal with a blank new record, prefilled per the
        // action's mapping. No server call — the workflow engine isn't
        // involved here. The modal's own save flow goes through the
        // store's saveRecord (record_save RPC).
        const prefill = buildCreatePrefill(button.action, formData);
        setRecordModal({
          modelId: button.action.target_model_id,
          recordId: null,
          prefill,
        });
        return;
      } else if (button.action.type === 'find_or_create_record') {
        // Look up the latest matching record. If found, open it for edit.
        // If not (or the trigger record lacks the search criteria), open
        // a blank create with prefill. Errors during the search are
        // surfaced and we abort — better than silently falling through
        // to "create new" which could create a duplicate.
        let searchFailed = false;
        const found = await findLatestMatch(
          button.action,
          formData,
          (msg) => {
            searchFailed = true;
            addToast(
              isAr ? `تعذر البحث عن السجل: ${msg}` : `Search failed: ${msg}`,
              'error',
            );
          },
        );
        if (searchFailed) return;
        if (found) {
          setRecordModal({
            modelId: button.action.target_model_id,
            recordId: found.id,
          });
        } else {
          setRecordModal({
            modelId: button.action.target_model_id,
            recordId: null,
            prefill: buildPrefill(button.action.prefill, formData),
          });
        }
        return;
      } else if (button.action.type === 'generate_design') {
        // Pre-flight validation. The orchestrator re-checks server-side,
        // but failing fast here avoids a round-trip and surfaces clearer
        // error messages. Required: project, template, raw_photo.
        const missing: string[] = [];
        if (!formData.project) missing.push(isAr ? 'المشروع' : 'project');
        const tplsRaw = formData.templates;
        const tplsArr = Array.isArray(tplsRaw) ? (tplsRaw as unknown[]).filter((x) => typeof x === 'string') : [];
        if (tplsArr.length === 0) missing.push(isAr ? 'القوالب (اختر واحداً على الأقل)' : 'templates (pick at least one)');
        if (!formData.raw_photo) missing.push(isAr ? 'الصورة الخام' : 'raw photo');
        if (missing.length > 0) {
          addToast(
            isAr
              ? `أكمل الحقول التالية أولاً: ${missing.join('، ')}`
              : `Fill in first: ${missing.join(', ')}`,
            'error',
          );
          return;
        }
        const res = await fetch('/api/marketing/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({
            record_id: existingRecord.id,
            model_id: model.id,
          }),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({ error: res.statusText }));
          addToast(
            isAr
              ? `فشل توليد التصميم: ${errBody?.error ?? `(${res.status})`}`
              : `Design generation failed: ${errBody?.error ?? `(${res.status})`}`,
            'error',
          );
          return;
        }
        addToast(
          isAr
            ? 'بدأ توليد التصميم — ستظهر النتائج تلقائياً'
            : 'Design generation started — results will appear automatically',
          'success',
        );
      } else {
        addToast(
          isAr ? 'إجراء الزر غير مدعوم' : 'Unsupported button action',
          'error',
        );
        return;
      }

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

  const handleSave = async () => {
    // Audit fix M2: refuse to save if the schema changed under us.
    // The form's slugs / required-field map / lookup config are bound
    // to the model state at mount. If an admin edited the model mid-form
    // we'd silently write to a stale slug or to a field that no longer
    // exists. Tell the user to reload before proceeding.
    if (modelUpdatedAtSnapshot && model.updated_at && model.updated_at !== modelUpdatedAtSnapshot) {
      addToast(
        isAr
          ? 'تم تعديل بنية النموذج أثناء فتح هذه الصفحة. حدّث الصفحة قبل الحفظ لتجنّب فقدان البيانات.'
          : 'The model schema changed while this form was open. Reload before saving to avoid losing data.',
        'error',
      );
      return;
    }
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
    //
    // Audit fix C1 — atomicity & concurrency:
    // - We AWAIT each fan-out save (was fire-and-forget).
    // - We pass the per-target snapshot version (captured the first
    //   time the user touched a mirror field for that target).
    // - On `conflict`, abort the whole save: showing the user a "saved"
    //   toast while a linked record is half-applied is a worse outcome
    //   than asking them to reload.
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
      const targetExpectedVersion =
        targetId in targetVersionSnapshotsRef.current
          ? targetVersionSnapshotsRef.current[targetId] ?? null
          : null;
      const targetResult = await saveRecord(updatedTarget, {
        expectedVersion: targetExpectedVersion,
      });
      if (targetResult.status === 'conflict') {
        addToast(
          isAr
            ? 'تم تعديل سجل مرتبط من مستخدم آخر — حدّث الصفحة قبل الحفظ.'
            : 'A linked record was just edited by another user — reload before saving.',
          'error',
        );
        return;
      }
      // `queued` is OK: the local state still reflects the user's
      // intent and the retry queue will replay on the next reload.
    }

    // 4. Save this record with the form-mount version snapshot (audit H5).
    const record = {
      id: existingRecord?.id ?? uuid(),
      model_id: model.id,
      data: formData,
      created_at: existingRecord?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const result = await saveRecord(record, { expectedVersion: versionSnapshot });
    if (result.status === 'conflict') {
      addToast(
        isAr
          ? 'تم تعديل هذا السجل من مستخدم آخر — حدّث الصفحة لمشاهدة التغييرات قبل الحفظ.'
          : 'This record was just edited by another user — reload to see their changes before re-saving.',
        'error',
      );
      return;
    }
    setIsDirty(false);
    if (result.status === 'queued') {
      addToast(
        isAr
          ? 'تم الحفظ محلياً — سيُزامن مع الخادم عند توفر الاتصال.'
          : 'Saved locally — will sync to the server when the connection is back.',
        'info',
      );
    } else {
      addToast(t('toast.saved'), 'success');
    }
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

      {/* Tabs — visible whenever this record references a client or IS a client */}
      <RecordTabBar tabs={tabs} active={activeTab} onChange={handleTabChange} />

      {/* When multiple client lookups are populated on a non-clients record,
        * surface a small switcher chip strip so the user can flip between
        * them inside the same Client Details tab. */}
      {activeTab === 'client' && clientCandidateIds.length > 1 && (
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs text-charcoal/50">
            {isAr ? 'عميل:' : 'Client:'}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {clientCandidateIds.map((cid) => {
              const r = (records[clientsModelId ?? ''] ?? []).find((rr) => rr.id === cid);
              const label = (r?.data as Record<string, unknown> | undefined)?.client_name;
              const displayLabel = (typeof label === 'string' && label.trim()) || cid.slice(0, 8);
              const selected = activeClientId === cid;
              return (
                <button
                  key={cid}
                  type="button"
                  onClick={() => handleClientSwitch(cid)}
                  className={`text-xs font-bold px-2.5 py-1 rounded-full transition-colors ${
                    selected
                      ? 'bg-copper text-cream'
                      : 'bg-sand/30 text-charcoal/70 hover:bg-sand/50'
                  }`}
                >
                  {displayLabel}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'client' && activeClientId ? (
        <ClientDetailsTabPane clientId={activeClientId} />
      ) : (
      /* Sections */
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
            formReadOnly={readOnly}
            getFieldPermission={resolveFieldPermission}
            recordId={existingRecord?.id}
          />
        ))}
      </div>
      )}

      {/* Call history fallback — every Hatif-logged call for any phone on this
        * record. Suppressed for the `clients` model: client records have a
        * dedicated `call_history` field-typed section that renders the same
        * panel inside the form, so this bottom-of-form copy would duplicate it.
        * Kept for every other model with a phone field as a backward-compatible
        * default — those models can opt into the in-section render later by
        * adding a `call_history` field via the Builder. */}
      {existingRecord && phoneValues.length > 0 && model.name !== 'clients' && (
        <div className="mt-6">
          <CallHistoryPanel phones={phoneValues} />
        </div>
      )}

      {/* Record-form modal triggered by create_record / find_or_create_record buttons */}
      {recordModal && (
        <RecordFormModal
          modelId={recordModal.modelId}
          recordId={recordModal.recordId}
          prefill={recordModal.prefill}
          onClose={() => setRecordModal(null)}
        />
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
