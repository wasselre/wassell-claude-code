import { useState, useMemo, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { getIconComponent } from '@/components/layout/Sidebar';
import * as lucideIcons from 'lucide-react';
import { ArrowRight, Save, Trash2, ChevronLeft, ChevronRight, Sparkles, Loader2, type LucideIcon } from 'lucide-react';
import { resolveSectionMirror } from '@/lib/sectionMirrorResolver';
import { resolveSectionMirrorFieldMulti } from '@/lib/sectionMirrorExpand';
import { isFieldVisible } from '@/lib/fieldVisibility';
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
import BackToSettings from '@/pages/Settings/components/BackToSettings';
import SectionBlock from './components/SectionBlock';
import RecordFormModal from './components/RecordFormModal';
import LinkedDocumentsPanel from './components/LinkedDocumentsPanel';
import RecordTabBar, { type RecordTab } from './components/RecordTabBar';
import ClientDetailsTabPane from './components/ClientDetailsTabPane';
import UnitsTabPane from './components/UnitsTabPane';
import { Users, Home } from 'lucide-react';
import { useAutoLink } from './hooks/useAutoLink';
import { useAutoFill } from './hooks/useAutoFill';
import { useFieldDefaults } from './hooks/useFieldDefaults';
import { createMissingLinkedRecords, pendingOnSaveLookupNames, type CreatedLinkedRecord } from './utils/createMissingLinkedRecords';
import { findDuplicateRecord, type DuplicateMatch } from './utils/findDuplicateRecord';
import DuplicateWarningModal from './components/DuplicateWarningModal';
import { buildCreatePrefill, buildPrefill, findLatestMatch } from './utils/recordButtonActions';
import { applyFollowupAutoStamp } from './utils/followupAutoStamp';
import { useCanEditRecord, useCanViewRecord, useFieldPermissionResolver, usePermission } from '@/hooks/usePermission';
import { useRolledUpRecord } from '@/hooks/useRolledUpRecords';
import { isButtonVisible } from '@/lib/permissions';

/**
 * Drives the "new client created" popup shown after a save that auto-created a
 * linked record (e.g. a client made from a phone-first appointment with no
 * matching client). `onContinue` runs the navigation the save would otherwise
 * have done — deferred so the popup shows before we leave the page.
 */
interface NewLinkedNotice {
  records: CreatedLinkedRecord[];
  onContinue: () => void;
}

export default function RecordFormPage() {
  const { modelName, recordId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
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
  const rawExistingRecord = model && !isNew
    ? (records[model.id] ?? []).find((r) => r.id === recordId)
    : null;
  // Inject cross-record rollup values (our_projects → units rollups) so
  // the form shows live computed counts/ranges/per-meter stats. Pass-
  // through for every other model. Computed values are render-only —
  // the save path (appStore.saveRecord) strips them before persist.
  const existingRecord = useRolledUpRecord(model?.id, rawExistingRecord);
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
  // Open "new client created" popup, set by a caller after a save that
  // auto-created a linked record. Null when no popup is showing.
  const [newLinkedNotice, setNewLinkedNotice] = useState<NewLinkedNotice | null>(null);
  // handleSave stashes the records it just created here (it keeps its boolean
  // contract); the Save callers read it synchronously after the await to decide
  // whether to show the popup or navigate straight away. Reset at each save.
  const justCreatedLinkedRef = useRef<CreatedLinkedRecord[]>([]);
  // Tracks whether the form has unsaved user edits. Used to guard prev/next
  // navigation and the back button with a Save / Discard / Cancel prompt.
  const [isDirty, setIsDirty] = useState(false);
  // When the user attempts to leave a dirty form, we stash the navigation
  // action here and open the unsaved-changes modal. Null when no exit is
  // pending. Wrapped in `{ run }` so React's setState doesn't invoke the
  // function (setState treats top-level functions as updaters).
  const [pendingExit, setPendingExit] = useState<{ run: () => void } | null>(null);
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
  // When a `find_or_create_record` button finds an existing match we no longer
  // force-open it for edit — we ask whether to open the existing record or
  // create a NEW one (e.g. "Register a visit" when the client already has a
  // prior visit but the rep wants to log another). Null when no prompt is open.
  const [findCreatePrompt, setFindCreatePrompt] = useState<{
    modelId: string;
    foundId: string;
    prefill: Record<string, unknown>;
  } | null>(null);
  // Set when a NEW record's duplicate-check value collides with an existing
  // record (model.schema.duplicate_check_field_id). handleSave opens this
  // warn-and-choose modal instead of writing the duplicate. Null when closed.
  const [duplicateMatch, setDuplicateMatch] = useState<DuplicateMatch | null>(null);

  // Smart auto-link + auto-fill primitives. The hooks no-op when no field
  // on this model declares the relevant config, so they're cheap to mount
  // unconditionally for every record form.
  useAutoLink({ model, formData, setFormData });
  useAutoFill({ model, formData, setFormData });
  // Seed dynamic defaults (current user / now) into NEW records on mount.
  useFieldDefaults({ model, isNew, formData, setFormData });

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
    setPendingExit(null);
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

  // ─── Units tab ───────────────────────────────────────────────────
  // Same logic as the Client Details tab, but for the All Projects model:
  // show a "Units" tab when this record either IS an All Projects record (so
  // the tab lists that project's units) or has at least one populated `lookup`
  // field pointing at the All Projects model. Multi-project case: surface every
  // populated candidate so the user can switch between them via the
  // `?project=<id>` query param. Default to the first.
  const allProjectsModelId = useMemo(
    () => models.find((m) => m.name === 'all_projects')?.id ?? null,
    [models],
  );

  const projectCandidateIds = useMemo<string[]>(() => {
    if (!model) return [];
    if (model.name === 'all_projects' && existingRecord) return [existingRecord.id];
    if (!allProjectsModelId) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const sec of model.schema.sections) {
      for (const f of sec.fields) {
        if (f.type !== 'lookup' || f.lookup_model_id !== allProjectsModelId) continue;
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
  }, [model, formData, allProjectsModelId, existingRecord]);

  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab =
    tabParam === 'client' && clientCandidateIds.length > 0
      ? 'client'
      : tabParam === 'units' && projectCandidateIds.length > 0
        ? 'units'
        : 'form';
  const activeClientId = (() => {
    const param = searchParams.get('client');
    if (param && clientCandidateIds.includes(param)) return param;
    return clientCandidateIds[0] ?? null;
  })();
  const activeProjectId = (() => {
    const param = searchParams.get('project');
    if (param && projectCandidateIds.includes(param)) return param;
    return projectCandidateIds[0] ?? null;
  })();

  const tabs = useMemo<RecordTab[]>(() => {
    if (clientCandidateIds.length === 0 && projectCandidateIds.length === 0) return [];
    const out: RecordTab[] = [{ id: 'form', label_ar: 'النموذج', label_en: 'Form' }];
    if (clientCandidateIds.length > 0) {
      out.push({
        id: 'client',
        label_ar: 'تفاصيل العميل',
        label_en: 'Client Details',
        icon: <Users size={14} />,
      });
    }
    if (projectCandidateIds.length > 0) {
      out.push({
        id: 'units',
        label_ar: 'الوحدات',
        label_en: 'Units',
        icon: <Home size={14} />,
      });
    }
    return out;
  }, [clientCandidateIds, projectCandidateIds]);

  const handleTabChange = (next: string) => {
    const sp = new URLSearchParams(searchParams);
    // Tabs are mutually exclusive; clear all tab params, then set the picked one.
    sp.delete('tab');
    sp.delete('client');
    sp.delete('project');
    if (next === 'client') {
      sp.set('tab', 'client');
      if (activeClientId) sp.set('client', activeClientId);
    } else if (next === 'units') {
      sp.set('tab', 'units');
      if (activeProjectId) sp.set('project', activeProjectId);
    }
    setSearchParams(sp, { replace: true });
  };

  const handleClientSwitch = (id: string) => {
    const sp = new URLSearchParams(searchParams);
    sp.set('tab', 'client');
    sp.set('client', id);
    sp.delete('project');
    setSearchParams(sp, { replace: true });
  };

  const handleProjectSwitch = (id: string) => {
    const sp = new URLSearchParams(searchParams);
    sp.set('tab', 'units');
    sp.set('project', id);
    sp.delete('client');
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
    setFormData((prev) => {
      const next = { ...prev, [fieldName]: value };
      applyFollowupAutoStamp(model.name, fieldName, value, next);
      return next;
    });
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

  // Unsaved-changes gate. When the form has pending edits, prompt the user
  // with Save / Discard / Cancel before running `action`. Otherwise run it
  // immediately. Centralized so every exit path (back button, prev, next)
  // goes through the same guard.
  const tryExit = (action: () => void) => {
    if (isDirty) {
      setPendingExit({ run: action });
    } else {
      action();
    }
  };

  const goToRecord = (targetId: string) => {
    tryExit(() => navigate(`/model/${model!.name}/${targetId}`));
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
   *   - `analyze_reel`      → POST /api/analyze-reel (clean + analyze one
   *     competitor reel transcript on the Competitor Library).
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
          // Don't force-edit the match — let the user choose "open existing" or
          // "create new". The new record stays prefilled from the trigger record,
          // exactly like the not-found path below.
          setFindCreatePrompt({
            modelId: button.action.target_model_id,
            foundId: found.id,
            prefill: buildPrefill(button.action.prefill, formData),
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
      } else if (button.action.type === 'analyze_reel') {
        // Clean + analyze one competitor reel. Pre-flight: needs a raw
        // transcript in `content`. The endpoint runs synchronously (one
        // ~10–30s Anthropic call) and writes the cleaned transcript +
        // analysis fields before responding, so the shared re-read below
        // picks them up.
        const contentVal = formData.content;
        if (typeof contentVal !== 'string' || contentVal.trim().length < 20) {
          addToast(
            isAr ? 'لا يوجد نص لتحليله في هذا السجل' : 'This record has no transcript to analyze',
            'error',
          );
          return;
        }
        const res = await fetch('/api/analyze-reel', {
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
              ? `فشل التنظيف والتحليل: ${errBody?.error ?? `(${res.status})`}`
              : `Clean & analyze failed: ${errBody?.error ?? `(${res.status})`}`,
            'error',
          );
          return;
        }
        addToast(
          isAr ? 'تم تنظيف النص وتحليله' : 'Transcript cleaned and analyzed',
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

  // Saves the record. Returns true on success so callers can decide what to
  // do next (the toolbar Save button navigates to the list; the unsaved-
  // changes modal's "Save & Exit" runs the deferred prev/next/back target).
  // Returns false on any validation or conflict failure — handleSave has
  // already toasted the user in that case.
  const handleSave = async (): Promise<boolean> => {
    // Reset the per-save "records I just created" stash (read by the Save
    // callers after the await to drive the new-client popup).
    justCreatedLinkedRef.current = [];
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
      return false;
    }
    // 1. Validate required fields on this record (skip derived mirror fields).
    const allFields = model.schema.sections
      .filter((s) => !s.is_mirrored)
      .flatMap((s) => s.fields);
    // A required lookup that a save-time deferred create will fill (phone →
    // client_id) counts as satisfied — otherwise a phone-first appointment for
    // a brand-new client would be blocked by the required client_id before
    // createMissingLinkedRecords ever runs. When there's no creatable source
    // value the lookup is NOT in this set, so the required check still applies.
    const deferredLookupNames = pendingOnSaveLookupNames(model, formData);
    const missing = allFields.filter((f) => {
      if (!f.required) return false;
      if (f.type === 'mirror') return false;
      if (deferredLookupNames.has(f.name)) return false;
      // A field hidden by its `visible_when` rule can't be filled, so it must
      // not block the save (mirrors the form, which doesn't render it).
      if (!isFieldVisible(f, formData, model)) return false;
      const val = formData[f.name];
      if (f.type === 'lookup' && f.is_multi) {
        return !Array.isArray(val) || val.length === 0;
      }
      if (f.type === 'multi_link') {
        return !Array.isArray(val) || (val as unknown[]).every((x) => typeof x !== 'string' || x.trim() === '');
      }
      return val === undefined || val === null || val === '';
    });

    if (missing.length > 0) {
      const label = isAr ? missing[0]!.label_ar : missing[0]!.label_en;
      addToast(`${isAr ? 'الحقل مطلوب: ' : 'Required field: '}${label}`, 'error');
      return false;
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
        if (f.type === 'multi_link') {
          return !Array.isArray(val) || (val as unknown[]).every((x) => typeof x !== 'string' || x.trim() === '');
        }
        return val === undefined || val === null || val === '';
      });
      if (missingMirror.length > 0) {
        const label = isAr ? missingMirror[0]!.label_ar : missingMirror[0]!.label_en;
        addToast(`${isAr ? 'الحقل مطلوب في السجل المرتبط: ' : 'Required field on linked record: '}${label}`, 'error');
        return false;
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
            return false;
          }
        }
      }
    }

    // 2c. Duplicate-check (create only). If this model declares a
    //     duplicate_check_field_id and we're creating a NEW record whose value
    //     for that field already matches an existing record, stop and let the
    //     user decide — fix the value, or open the existing record. Runs BEFORE
    //     any side-effecting save (mirror fan-out / linked-record creation) so
    //     an aborted save leaves nothing half-written. This enforces on the
    //     form what the Import wizard already enforces on import; the other
    //     create paths (createMissingLinkedRecords, useAutoLink) already link
    //     to an existing match instead of duplicating.
    if (isNew) {
      const dup = findDuplicateRecord(model, formData, records[model.id] ?? []);
      if (dup) {
        setDuplicateMatch(dup);
        return false;
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
        return false;
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
        return false;
      }
      // `queued` is OK: the local state still reflects the user's
      // intent and the retry queue will replay on the next reload.
    }

    // 3b. Save-time linked-record creation. For visits this turns a typed
    //     phone + name with no matching client into a brand-new client, linked
    //     via client_id — but only now, at commit, so a half-typed phone never
    //     spawns a stray client (createMissingLinkedRecords + the phone field's
    //     auto_link_create_timing:'on_save'). Runs after validation so we never
    //     create for an invalid form, and before the parent save so the link is
    //     attached in a single write.
    const dataToSave: Record<string, unknown> = { ...formData };
    const { patch: linkedPatch, created: createdLinked } = await createMissingLinkedRecords({
      model,
      formData: dataToSave,
      records,
      saveRecord,
    });
    if (Object.keys(linkedPatch).length > 0) {
      Object.assign(dataToSave, linkedPatch);
      setFormData((prev) => ({ ...prev, ...linkedPatch }));
    }

    // 4. Save this record with the form-mount version snapshot (audit H5).
    const record = {
      id: existingRecord?.id ?? uuid(),
      model_id: model.id,
      data: dataToSave,
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
      return false;
    }
    setIsDirty(false);
    // Hand any linked records created during this save (e.g. a new client
    // auto-created from a typed phone+name) to the Save callers via a ref, so
    // they can show the "new client created" popup and defer the post-save
    // navigation until the user dismisses it.
    justCreatedLinkedRef.current = createdLinked;
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
    return true;
  };

  // Save & Exit: runs handleSave, and if it succeeds, runs the deferred
  // navigation the user originally attempted (back to list, prev record,
  // or next record). If save fails (validation, conflict, etc.) handleSave
  // toasts the user and we leave the modal open so they can fix it.
  const handleSaveAndExit = async () => {
    const exit = pendingExit;
    const ok = await handleSave();
    if (!ok) return;
    setPendingExit(null);
    const runExit = () => (exit ? exit.run() : navigate(exitTarget));
    const created = justCreatedLinkedRef.current;
    if (created.length > 0) {
      setNewLinkedNotice({ records: created, onContinue: runExit });
    } else {
      runExit();
    }
  };

  const handleDiscardAndExit = () => {
    const exit = pendingExit;
    setIsDirty(false);
    setPendingExit(null);
    exit?.run();
  };

  // "New client created" popup — Continue runs the deferred post-save
  // navigation; View Client opens the freshly-created client instead.
  const dismissNewLinkedNotice = () => {
    const cont = newLinkedNotice?.onContinue;
    setNewLinkedNotice(null);
    cont?.();
  };
  const viewNewLinked = () => {
    const notice = newLinkedNotice;
    setNewLinkedNotice(null);
    const rec = notice?.records[0];
    const tm = rec ? models.find((m) => m.id === rec.modelId) : null;
    if (rec && tm) {
      navigate(`/model/${tm.name}/${rec.id}`);
    } else {
      notice?.onContinue?.();
    }
  };

  const handleDelete = () => {
    if (existingRecord) {
      deleteRecord(model.id, existingRecord.id);
      addToast(t('toast.deleted'), 'success');
    }
    setShowDelete(false);
    navigate(exitTarget);
  };

  // `site_settings` is a settings-only singleton reached from the Settings
  // hub (Website Settings card). It has no meaningful list view — navigating
  // to /model/site_settings just redirects back here — so its exits return
  // to the Settings hub instead, and we show the shared "← Settings" link.
  const isSettingsOnly = model.name === 'site_settings';
  // When this record was opened from an embedded context — e.g. clicking a unit
  // in the Units tab on a project page, which passes `state.backTo` — the back
  // button and the post-save / delete exits return THERE instead of this model's
  // own list. Falls back to the model list (or the Settings hub for the
  // site_settings singleton) when there's no origin to return to.
  const backTo = (location.state as { backTo?: string } | null)?.backTo ?? null;
  const exitTarget = backTo ?? (isSettingsOnly ? '/settings' : `/model/${model.name}`);

  return (
    <div>
      {isSettingsOnly && <BackToSettings />}
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => tryExit(() => navigate(exitTarget))}
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
          <Button onClick={async () => {
            const ok = await handleSave();
            if (!ok) return;
            const created = justCreatedLinkedRef.current;
            if (created.length > 0) {
              // Auto-created a client — show the popup, then navigate on dismiss.
              setNewLinkedNotice({ records: created, onContinue: () => navigate(exitTarget) });
            } else {
              navigate(exitTarget);
            }
          }}>
            <Save size={16} />
            {t('common.save')}
          </Button>
          )}
        </div>
      </div>

      {/* Tabs — visible whenever this record references (or IS) a client or an
        * All Projects record: Form + Client Details and/or Units. */}
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

      {/* When multiple All Projects lookups are populated on a record, surface
        * a switcher chip strip so the user can flip between the linked projects
        * inside the same Units tab. Mirrors the client chip strip above. */}
      {activeTab === 'units' && projectCandidateIds.length > 1 && (
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs text-charcoal/50">
            {isAr ? 'المشروع:' : 'Project:'}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {projectCandidateIds.map((pid) => {
              const r = (records[allProjectsModelId ?? ''] ?? []).find((rr) => rr.id === pid);
              const label = (r?.data as Record<string, unknown> | undefined)?.project_name;
              const displayLabel = (typeof label === 'string' && label.trim()) || pid.slice(0, 8);
              const selected = activeProjectId === pid;
              return (
                <button
                  key={pid}
                  type="button"
                  onClick={() => handleProjectSwitch(pid)}
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
      ) : activeTab === 'units' && activeProjectId ? (
        <UnitsTabPane projectId={activeProjectId} />
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

      {/* Documents linked to this record via document↔record relationships.
        * Renders nothing when there are none — zero visual change for
        * records without documents. */}
      {model && existingRecord?.id && (
        <LinkedDocumentsPanel modelId={model.id} recordId={existingRecord.id} />
      )}

      {/* Call history is no longer a bottom-of-form fallback on every model
        * with a phone field. It only renders when a model explicitly opts in
        * by adding a `call_history` field in the Builder — which the clients
        * model does in its dedicated Calls section. Projects and other models
        * that happen to carry a phone field don't show calls anymore. */}

      {/* Record-form modal triggered by create_record / find_or_create_record buttons */}
      {recordModal && (
        <RecordFormModal
          modelId={recordModal.modelId}
          recordId={recordModal.recordId}
          prefill={recordModal.prefill}
          onClose={() => setRecordModal(null)}
        />
      )}

      {/* Duplicate-check warning — a NEW record's duplicate_check_field value
        * (e.g. phone) already exists. Two ways out, never a silent dup. */}
      {duplicateMatch && (
        <DuplicateWarningModal
          model={model}
          match={duplicateMatch}
          onEdit={() => setDuplicateMatch(null)}
          onOpenExisting={() => {
            const target = duplicateMatch.record.id;
            setDuplicateMatch(null);
            // The new draft is intentionally abandoned for the existing record,
            // so clear the dirty flag to skip the unsaved-changes guard.
            setIsDirty(false);
            navigate(`/model/${model.name}/${target}`);
          }}
        />
      )}

      {/* find_or_create match → choose: open the existing record, or create a new
        * one (still prefilled from this record). Lets "Register a visit" log a
        * fresh visit even when the client already has a prior one. */}
      <Modal
        open={findCreatePrompt !== null}
        onClose={() => setFindCreatePrompt(null)}
        title={t('records.find_or_create_title')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setFindCreatePrompt(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (!findCreatePrompt) return;
                setRecordModal({ modelId: findCreatePrompt.modelId, recordId: findCreatePrompt.foundId });
                setFindCreatePrompt(null);
              }}
            >
              {t('records.find_or_create_open_existing')}
            </Button>
            <Button
              onClick={() => {
                if (!findCreatePrompt) return;
                setRecordModal({
                  modelId: findCreatePrompt.modelId,
                  recordId: null,
                  prefill: findCreatePrompt.prefill,
                });
                setFindCreatePrompt(null);
              }}
            >
              {t('records.find_or_create_make_new')}
            </Button>
          </>
        }
      >
        <p className="text-charcoal">
          {t('records.find_or_create_body', {
            model: (() => {
              const tm = models.find((m) => m.id === findCreatePrompt?.modelId);
              return tm ? (isAr ? tm.label_ar : tm.label_en) : '';
            })(),
          })}
        </p>
      </Modal>

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

      {/* Unsaved-changes guard — fires whenever the user tries to leave a
        * dirty form via the back button or prev/next nav. Three options:
        * Save & Exit (saves then completes the navigation), Discard & Exit
        * (navigates without saving), Cancel (stays). Closing via the X or
        * backdrop is treated the same as Cancel. */}
      <Modal
        open={pendingExit !== null}
        onClose={() => setPendingExit(null)}
        title={t('records.unsaved_changes_title')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingExit(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={handleDiscardAndExit}>
              {t('records.discard_and_exit')}
            </Button>
            <Button onClick={() => void handleSaveAndExit()}>
              <Save size={16} />
              {t('records.save_and_exit')}
            </Button>
          </>
        }
      >
        <p className="text-charcoal">{t('records.unsaved_changes_message')}</p>
      </Modal>

      {/* New-client notice — shown after a save that auto-created a client from
        * a phone-first appointment (no existing client matched the typed phone).
        * Continue runs the deferred navigation; View Client opens the client.
        * The same mechanism backs the visits model, so the copy is client-
        * oriented (both current consumers create a client). */}
      <Modal
        open={newLinkedNotice !== null}
        onClose={dismissNewLinkedNotice}
        title={isAr ? 'تم إنشاء عميل جديد' : 'New client created'}
        footer={
          <>
            {newLinkedNotice?.records.length === 1 && (
              <Button variant="secondary" onClick={viewNewLinked}>
                <Users size={16} />
                {isAr ? 'عرض العميل' : 'View Client'}
              </Button>
            )}
            <Button onClick={dismissNewLinkedNotice}>
              {isAr ? 'متابعة' : 'Continue'}
            </Button>
          </>
        }
      >
        <p className="text-charcoal">
          {isAr
            ? 'لم يكن هناك عميل بهذا الرقم، فتم إنشاء عميل جديد تلقائيًا وربطه بهذا السجل.'
            : 'No client matched this number, so a new client was created automatically and linked to this record.'}
        </p>
        <div className="mt-3 space-y-1">
          {newLinkedNotice?.records.map((c) => (
            <div
              key={c.id}
              dir="auto"
              className="rounded-xl bg-sand/20 px-4 py-2 text-sm font-bold text-charcoal"
            >
              {c.label}
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
