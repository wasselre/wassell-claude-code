import { useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { v4 as uuid } from 'uuid';
import { FileSearch, Link2, Plus } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import type { AppModel, AppRecord } from '@/types';

/**
 * Fires whenever one or more new Targeted Projects records are saved. For
 * every queued targeted project the user picks one of three actions:
 *   - Create a fresh research study seeded with this project
 *   - Append to an existing research record's `project_name` multi-select lookup
 *   - Skip (leave unlinked)
 *
 * The store's queue is the source of truth — saving a single Targeted Projects
 * record from the form enqueues one id; bulk-edit / bulk-import / workflow
 * fan-out enqueue many. A single modal handles the whole batch so the user is
 * never surprised by a chain of popups.
 *
 * The Targeted Projects model uses a plain `project_name` text field (often
 * populated from the source All Projects record by the user's workflow). The
 * research model's `project_name` is a lookup into All Projects. This modal
 * bridges the two: it auto-matches by id (from any Targeted Projects lookup
 * field) first, then falls back to exact-name matching on All Projects, then
 * exposes a manual picker per-row when both auto-strategies fail.
 */
export default function ResearchPromptModal() {
  const navigate = useNavigate();
  const {
    pendingResearchPromptTargetedIds,
    dismissResearchPrompts,
    language,
    models,
    records,
    saveRecord,
    addToast,
  } = useAppStore();
  const isAr = language === 'ar';

  const targetedModel = useMemo(() => models.find((m) => m.name === 'targeted_projects') ?? null, [models]);
  const allProjectsModel = useMemo(() => models.find((m) => m.name === 'all_projects') ?? null, [models]);
  const researchModel = useMemo(() => models.find((m) => m.name === 'projects_research') ?? null, [models]);

  // The research model's `project_name` is a multi-select lookup into all_projects.
  const researchProjectNameFieldName = useMemo(() => {
    if (!researchModel) return null;
    const fields = researchModel.schema.sections.flatMap((s) => s.fields);
    const lookup = fields.find(
      (f) => f.type === 'lookup' && f.lookup_model_id === allProjectsModel?.id && f.is_multi,
    );
    return lookup?.name ?? null;
  }, [researchModel, allProjectsModel]);

  // Hydrate each queued id into {targetedRecord, linkedProjectRecord, displayName}.
  // Stale ids (record was deleted after being queued) drop out silently here so
  // downstream code can iterate a clean list.
  const queue = useMemo(() => {
    if (!targetedModel || !allProjectsModel) return [];
    const tps = records[targetedModel.id] ?? [];
    const aps = records[allProjectsModel.id] ?? [];
    return pendingResearchPromptTargetedIds
      .map((id) => {
        const targeted = tps.find((r) => r.id === id);
        if (!targeted) return null;
        const linked = resolveLinkedProjectRecord(targeted, targetedModel, aps, allProjectsModel);
        return {
          id,
          targeted,
          linked,
          displayName: resolveDisplayName(targeted, linked),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [pendingResearchPromptTargetedIds, targetedModel, allProjectsModel, records]);

  // Research records available for the "add to existing" path.
  const researchRecords: AppRecord[] = researchModel ? records[researchModel.id] ?? [] : [];

  // Per-row picks. Keyed by the queued targeted-project id so re-ordering the
  // queue doesn't lose the user's choices. Defaults to "new" for every row.
  //
  // `existing.target` is either:
  //   - `study:<researchRecordId>`  — append to a saved research record
  //   - `draft:<queuedRowId>`       — append to a sibling row's in-modal draft
  //
  // Drafts are purely a modal-local concept: a row with kind='new' defines a
  // draft whose id IS the row's queued id. Sibling rows can reference that
  // draft instead of creating their own — on Apply, all referencing rows merge
  // into one research record along with the draft-owner row's project.
  type Pick =
    | { kind: 'new'; draftName?: string; manualProjectId?: string }
    | { kind: 'existing'; target: string; manualProjectId?: string }
    | { kind: 'skip' };
  const [picks, setPicks] = useState<Record<string, Pick>>({});

  // Seed picks for newly-queued rows without clobbering existing user choices.
  useEffect(() => {
    setPicks((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const q of queue) {
        if (!next[q.id]) {
          next[q.id] = { kind: 'new' };
          changed = true;
        }
      }
      // Clean up picks for ids no longer in queue (dismissed / deleted).
      const queueIds = new Set(queue.map((q) => q.id));
      for (const k of Object.keys(next)) {
        if (!queueIds.has(k)) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [queue]);

  const setPick = (id: string, update: Partial<Pick> | Pick) => {
    setPicks((p) => {
      const current = p[id] ?? { kind: 'new' };
      // When switching kind, reset fields that don't apply to avoid stale target / draftName.
      if ('kind' in update && update.kind && update.kind !== current.kind) {
        const manualProjectId = 'manualProjectId' in current ? current.manualProjectId : undefined;
        if (update.kind === 'new') return { ...p, [id]: { kind: 'new', manualProjectId } };
        if (update.kind === 'existing') {
          return { ...p, [id]: { kind: 'existing', target: '', manualProjectId } };
        }
        return { ...p, [id]: { kind: 'skip' } };
      }
      return { ...p, [id]: { ...current, ...update } as Pick };
    });
  };

  const close = () => dismissResearchPrompts();

  const handleApply = () => {
    if (!researchModel || !researchProjectNameFieldName) {
      addToast(isAr ? 'نموذج الأبحاث غير متاح.' : 'Research model unavailable.', 'error');
      return;
    }

    // Resolve each row's effective project id + effective action. Unresolved
    // rows (no auto-match + no manual pick, or existing-pick with no target,
    // or draft-ref pointing at a row that's no longer kind='new') block apply.
    const unresolved: string[] = [];

    // Draft rowId → accumulated project ids (starts with the draft owner's
    // own project once we visit its row).
    const draftProjectIds: Record<string, string[]> = {};
    const draftNames: Record<string, string | undefined> = {};
    // Saved research record id → accumulated project ids to append.
    const appendsByStudy: Record<string, string[]> = {};

    for (const q of queue) {
      const pick = picks[q.id] ?? { kind: 'new' };
      if (pick.kind === 'skip') continue;
      const manual = 'manualProjectId' in pick ? pick.manualProjectId : undefined;
      const projectId = q.linked?.id ?? (manual || null);
      if (!projectId) {
        unresolved.push(q.displayName || q.id);
        continue;
      }
      if (pick.kind === 'new') {
        (draftProjectIds[q.id] ??= []).push(projectId);
        if (pick.draftName && pick.draftName.trim()) {
          draftNames[q.id] = pick.draftName.trim();
        }
      } else if (pick.kind === 'existing') {
        if (!pick.target) {
          unresolved.push(q.displayName || q.id);
          continue;
        }
        if (pick.target.startsWith('draft:')) {
          const draftRowId = pick.target.slice('draft:'.length);
          const ownerPick = picks[draftRowId];
          if (!ownerPick || ownerPick.kind !== 'new') {
            // User pointed at a draft that's no longer a draft (owner flipped
            // to skip or existing). Surface this so they can fix it.
            unresolved.push(q.displayName || q.id);
            continue;
          }
          (draftProjectIds[draftRowId] ??= []).push(projectId);
        } else if (pick.target.startsWith('study:')) {
          const studyId = pick.target.slice('study:'.length);
          (appendsByStudy[studyId] ??= []).push(projectId);
        } else {
          unresolved.push(q.displayName || q.id);
        }
      }
    }

    if (unresolved.length > 0) {
      const list = unresolved.slice(0, 3).join('، ');
      addToast(
        isAr
          ? `لم يتم حل الصفوف: ${list}${unresolved.length > 3 ? '…' : ''}`
          : `Unresolved rows: ${list}${unresolved.length > 3 ? '…' : ''}`,
        'error',
      );
      return;
    }

    // Fan out writes. Each `saveRecord` runs the normal pipeline (auto_id,
    // formula, Supabase upsert, workflows).
    const now = new Date().toISOString();
    const createdStudyIds: string[] = [];

    // One research record per draft — project ids already grouped above so
    // sibling rows that referenced the same draft merge into one study.
    // draftNames are purely in-modal labels today (the research model has no
    // freestanding "study name" field) — the user can rename inside the
    // research record later if they want to label the study differently from
    // the auto-derived "first project +N" title.
    for (const [rowId, pids] of Object.entries(draftProjectIds)) {
      const deduped = Array.from(new Set(pids));
      const rec: AppRecord = {
        id: uuid(),
        model_id: researchModel.id,
        data: { [researchProjectNameFieldName]: deduped },
        created_at: now,
        updated_at: now,
      };
      saveRecord(rec);
      createdStudyIds.push(rec.id);
      // draftNames[rowId] is referenced but not persisted; keep the variable
      // around so it flows into any future "study name" field if added.
      void draftNames[rowId];
    }

    // Appends: merge every project per target study into one write.
    let appendedCount = 0;
    for (const [studyId, projectIds] of Object.entries(appendsByStudy)) {
      const target = researchRecords.find((r) => r.id === studyId);
      if (!target) continue;
      const existing = target.data[researchProjectNameFieldName];
      const currentIds = Array.isArray(existing)
        ? (existing as unknown[]).filter((v): v is string => typeof v === 'string')
        : [];
      const merged = Array.from(new Set([...currentIds, ...projectIds]));
      if (merged.length === currentIds.length) continue; // nothing new
      saveRecord({
        ...target,
        data: { ...target.data, [researchProjectNameFieldName]: merged },
        updated_at: now,
      });
      appendedCount += merged.length - currentIds.length;
    }

    const createdCount = createdStudyIds.length;
    const skippedCount = queue.filter((q) => (picks[q.id]?.kind ?? 'new') === 'skip').length;
    const parts: string[] = [];
    if (createdCount > 0) {
      parts.push(isAr ? `أنشئت ${createdCount} دراسة` : `${createdCount} new stud${createdCount === 1 ? 'y' : 'ies'}`);
    }
    if (appendedCount > 0) {
      parts.push(isAr ? `أضيف ${appendedCount} مشروع` : `${appendedCount} project${appendedCount === 1 ? '' : 's'} appended`);
    }
    if (skippedCount > 0) {
      parts.push(isAr ? `تم تخطي ${skippedCount}` : `${skippedCount} skipped`);
    }
    if (parts.length > 0) {
      addToast(parts.join(isAr ? '، ' : ', '), 'success');
    }

    dismissResearchPrompts();

    // Navigate only when the user created exactly one new study (preserves the
    // old single-record UX). Otherwise stay on the current page — opening N
    // tabs or jumping to a random one would be worse than nothing.
    if (createdCount === 1 && appendedCount === 0) {
      navigate(`/model/${researchModel.name}/${createdStudyIds[0]}`);
    }
  };

  // Per-draft view of the current picks, so the "add to existing" dropdown on
  // any row can show sibling drafts. A draft is defined by a row with
  // kind='new'; its label is the user-typed `draftName` (if any) or the auto
  // label built from the projects currently flowing into it.
  const drafts = useMemo(() => {
    const out: Record<string, { name?: string; projectNames: string[] }> = {};
    for (const q of queue) {
      const pick = picks[q.id];
      if (pick?.kind === 'new') {
        out[q.id] = { name: pick.draftName, projectNames: [q.displayName || '—'] };
      }
    }
    for (const q of queue) {
      const pick = picks[q.id];
      if (pick?.kind === 'existing' && pick.target?.startsWith('draft:')) {
        const draftId = pick.target.slice('draft:'.length);
        if (out[draftId]) out[draftId].projectNames.push(q.displayName || '—');
      }
    }
    return out;
  }, [queue, picks]);

  if (queue.length === 0 || !researchModel || !allProjectsModel) {
    return null;
  }

  const allProjectsOptions = records[allProjectsModel.id] ?? [];

  return (
    <Modal
      open
      onClose={close}
      title={
        queue.length === 1
          ? (isAr ? 'ربط المشروع بدراسة' : 'Link project to a study')
          : (isAr ? `ربط ${queue.length} مشروع بدراسات` : `Link ${queue.length} projects to studies`)
      }
      maxWidth="max-w-3xl"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {isAr ? 'لاحقاً' : 'Later'}
          </Button>
          <Button onClick={handleApply}>
            {isAr ? 'تطبيق' : 'Apply'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-start gap-2 p-3 rounded-lg bg-copper/5 border border-copper/20">
          <Link2 size={16} className="text-copper mt-0.5 shrink-0" />
          <p className="text-sm text-charcoal">
            {queue.length === 1
              ? (isAr
                ? <>تمت إضافة المشروع أدناه إلى المشاريع المستهدفة. اختر كيف تريد ربطه بدراسة.</>
                : <>The project below was added to Targeted Projects. Pick how to link it to a study.</>)
              : (isAr
                ? <>تمت إضافة <span className="font-bold">{queue.length}</span> مشروع إلى المشاريع المستهدفة. اختر لكل مشروع كيف تريد ربطه بدراسة.</>
                : <><span className="font-bold">{queue.length}</span> projects were added to Targeted Projects. Pick how to link each one.</>)}
          </p>
        </div>

        <div className="max-h-[min(60vh,480px)] overflow-y-auto space-y-3 pr-1">
          {queue.map((q) => {
            const pick = picks[q.id] ?? ({ kind: 'new' } as Pick);
            const manualId =
              'manualProjectId' in pick && pick.manualProjectId ? pick.manualProjectId : '';
            const effectiveProjectId = q.linked?.id ?? manualId;
            return (
              <div
                key={q.id}
                className="rounded-xl border border-sand/50 bg-white p-3 space-y-2"
              >
                <div className="flex items-center gap-2">
                  <FileSearch size={16} className="text-copper shrink-0" />
                  <span className="text-sm font-bold text-charcoal flex-1 truncate">
                    {q.displayName || (isAr ? '(بدون اسم)' : '(unnamed)')}
                  </span>
                  {q.linked ? (
                    <span className="text-[10px] font-bold text-copper/70 bg-copper/10 px-2 py-0.5 rounded-full">
                      {isAr ? 'مطابقة تلقائية' : 'auto-matched'}
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold text-red-500 bg-red-50 px-2 py-0.5 rounded-full">
                      {isAr ? 'اختيار يدوي' : 'pick manually'}
                    </span>
                  )}
                </div>

                {/* Manual picker shown when id resolution failed. Persists on the row's pick. */}
                {!q.linked && (
                  <select
                    value={manualId}
                    onChange={(e) => setPick(q.id, { manualProjectId: e.target.value } as Partial<Pick>)}
                    className="form-input text-sm"
                  >
                    <option value="">— {isAr ? 'اختر المشروع المطابق' : 'Select matching project'} —</option>
                    {allProjectsOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {typeof p.data.project_name === 'string' ? (p.data.project_name as string) : p.id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                )}

                <div className="flex flex-col gap-1.5">
                  <label className="flex items-start gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name={`pick-${q.id}`}
                      checked={pick.kind === 'new'}
                      onChange={() => setPick(q.id, { kind: 'new' })}
                      className="accent-copper mt-1"
                    />
                    <Plus size={14} className="text-copper/60 mt-1" />
                    <div className="flex-1 flex items-center gap-2 flex-wrap">
                      <span className="text-charcoal">
                        {isAr ? 'إنشاء دراسة جديدة' : 'Create a new study'}
                      </span>
                      {pick.kind === 'new' && (
                        <input
                          type="text"
                          value={pick.draftName ?? ''}
                          onChange={(e) => setPick(q.id, { draftName: e.target.value } as Partial<Pick>)}
                          placeholder={isAr ? 'اسم الدراسة (اختياري)' : 'Study name (optional)'}
                          className="form-input text-sm flex-1 min-w-[180px]"
                          onClick={(e) => e.stopPropagation()}
                        />
                      )}
                    </div>
                  </label>

                  {(() => {
                    // Drafts from sibling rows that picked "Create new" (excluding this row).
                    const siblingDrafts = Object.entries(drafts).filter(([id]) => id !== q.id);
                    const hasDrafts = siblingDrafts.length > 0;
                    const hasSaved = researchRecords.length > 0;
                    const canPickExisting = hasDrafts || hasSaved;
                    return (
                      <label className="flex items-start gap-2 text-sm cursor-pointer">
                        <input
                          type="radio"
                          name={`pick-${q.id}`}
                          checked={pick.kind === 'existing'}
                          onChange={() => setPick(q.id, { kind: 'existing' })}
                          className="accent-copper mt-1"
                          disabled={!canPickExisting}
                        />
                        <Link2 size={14} className="text-copper/60 mt-1" />
                        <div className="flex-1 flex items-center gap-2 flex-wrap">
                          <span className={`text-charcoal ${!canPickExisting ? 'opacity-40' : ''}`}>
                            {isAr ? 'إضافة إلى دراسة' : 'Add to a study'}
                          </span>
                          {pick.kind === 'existing' && (
                            <select
                              value={pick.target}
                              onChange={(e) => setPick(q.id, { target: e.target.value } as Partial<Pick>)}
                              className="form-input text-sm flex-1 min-w-[200px]"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <option value="">— {isAr ? 'اختر دراسة' : 'Select a study'} —</option>
                              {hasDrafts && (
                                <optgroup label={isAr ? 'دراسات جديدة في هذا النموذج' : 'New drafts in this batch'}>
                                  {siblingDrafts.map(([id, d]) => {
                                    const label = d.name && d.name.trim()
                                      ? d.name
                                      : (d.projectNames.length > 1
                                        ? `${d.projectNames[0]} +${d.projectNames.length - 1}`
                                        : d.projectNames[0] ?? '—');
                                    return (
                                      <option key={id} value={`draft:${id}`}>
                                        {label}
                                      </option>
                                    );
                                  })}
                                </optgroup>
                              )}
                              {hasSaved && (
                                <optgroup label={isAr ? 'دراسات محفوظة' : 'Saved studies'}>
                                  {researchRecords.map((r) => (
                                    <option key={r.id} value={`study:${r.id}`}>
                                      {resolveResearchLabel(r, researchModel, allProjectsOptions)}
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                            </select>
                          )}
                        </div>
                      </label>
                    );
                  })()}

                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="radio"
                      name={`pick-${q.id}`}
                      checked={pick.kind === 'skip'}
                      onChange={() => setPick(q.id, { kind: 'skip' })}
                      className="accent-copper"
                    />
                    <span className="text-charcoal/60">
                      {isAr ? 'تخطي هذا المشروع' : 'Skip this project'}
                    </span>
                  </label>
                </div>

                {!effectiveProjectId && pick.kind !== 'skip' && (
                  <p className="text-[11px] text-red-500">
                    {isAr
                      ? 'اختر المشروع المطابق من القائمة أعلاه قبل التطبيق.'
                      : 'Pick the matching project from the list above before applying.'}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

// --- Helpers ---

function resolveLinkedProjectRecord(
  targeted: AppRecord,
  tpModel: AppModel,
  allProjectsRecords: AppRecord[],
  allProjectsModel: AppModel,
): AppRecord | null {
  // 1. Walk Targeted Projects lookup fields pointing at all_projects.
  const lookupFields = tpModel.schema.sections
    .flatMap((s) => s.fields)
    .filter((f) => f.type === 'lookup' && f.lookup_model_id === allProjectsModel.id);
  for (const f of lookupFields) {
    const v = targeted.data[f.name];
    let id: string | null = null;
    if (Array.isArray(v)) {
      const first = (v as unknown[]).find((x): x is string => typeof x === 'string' && !!x);
      if (first) id = first;
    } else if (typeof v === 'string' && v) {
      id = v;
    }
    if (id) {
      const match = allProjectsRecords.find((r) => r.id === id);
      if (match) return match;
    }
  }

  // 2. Legacy fallback: exact-name text match.
  const textFields = tpModel.schema.sections
    .flatMap((s) => s.fields)
    .filter((f) => f.type === 'text');
  for (const f of textFields) {
    const v = targeted.data[f.name];
    if (typeof v !== 'string' || !v) continue;
    const needle = v.trim().toLowerCase();
    if (!needle) continue;
    const match = allProjectsRecords.find((r) => {
      const pn = r.data.project_name;
      return typeof pn === 'string' && pn.trim().toLowerCase() === needle;
    });
    if (match) return match;
  }
  return null;
}

function resolveDisplayName(targeted: AppRecord, linked: AppRecord | null): string {
  if (linked) {
    const v = linked.data.project_name;
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  for (const v of Object.values(targeted.data)) {
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function resolveResearchLabel(
  r: AppRecord,
  researchModel: AppModel,
  allProjectsRecords: AppRecord[],
): string {
  const fields = researchModel.schema.sections.flatMap((s) => s.fields);
  const titleId = researchModel.card_config?.title_field_id;
  const titleField = titleId ? fields.find((f) => f.id === titleId) : null;
  if (titleField) {
    const v = r.data[titleField.name];
    if (Array.isArray(v) && v.length > 0) {
      const linked = (v as unknown[])
        .filter((id): id is string => typeof id === 'string')
        .map((id) => {
          const rec = allProjectsRecords.find((p) => p.id === id);
          const name = rec?.data.project_name;
          return typeof name === 'string' ? name : id.slice(0, 6);
        });
      if (linked.length > 0) {
        return linked.length > 1 ? `${linked[0]} +${linked.length - 1}` : linked[0]!;
      }
    }
    if (typeof v === 'string' || typeof v === 'number') return String(v);
  }
  const autoIdField = fields.find((f) => f.type === 'auto_id');
  if (autoIdField) {
    const v = r.data[autoIdField.name];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return `#${r.id.slice(0, 6)}`;
}
