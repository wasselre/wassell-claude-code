/**
 * Settings → Workflows — design screen 17, rebuilt over the CANONICAL row.
 *
 * The deliberately CONSTRAINED editor: steps can be added, reordered and
 * re-roled, and every step has a fixed set of switches — nine actions, not
 * ninety. Steps point at ROLES, never people; swapping who fills a role is one
 * change on the Roles page, not fourteen edits here.
 *
 * Saving calls `workflow_save` on the canonical workflow row; the DB trigger
 * snapshots a new version and the response's `version_no` is surfaced. The
 * truthful freezing rule from the design: in-flight records keep the pinned
 * version they started with — only NEW records pick up the saved path.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DndContext, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAppStore } from '@/stores/appStore';
import {
  MosPathRole, ROLE_LABELS, StepDef, WorkflowDef, saveWorkflow,
} from '@/lib/marketingOS/client';
import { Empty, PageHead, Pill } from './kit';
import { IconBack, IconForward, IconPlus } from './icons';
import { num } from '../lib/format';
import { roleAvatarClass, initial } from '../lib/format';

const PATH_ROLES: MosPathRole[] = ['writer', 'montage', 'ops_supervisor', 'marketing_manager', 'ceo'];

const APPROVAL_KINDS: Array<{ key: NonNullable<StepDef['approval_kind']>; ar: string; en: string }> = [
  { key: 'creative', ar: 'اعتماد إبداعي', en: 'Creative approval' },
  { key: 'process',  ar: 'اعتماد إجرائي', en: 'Process approval' },
  { key: 'budget',   ar: 'توقيع ميزانية', en: 'Budget signature' },
];

const Grip = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M8 6h8M8 12h8M8 18h8" /></svg>
);

/* ── copy helpers ─────────────────────────────────────────────────── */

function roleLabel(role: string, isAr: boolean): string {
  const l = ROLE_LABELS[role as MosPathRole];
  return l ? (isAr ? l.ar : l.en) : role;
}

/** «يومان بعد الفتح» — the collapsed row's due cell, in the mockup's shape. */
function dueLabel(n: number, isAr: boolean): string {
  if (!isAr) return `${n} ${n === 1 ? 'day' : 'days'} after opening`;
  if (n === 1) return 'يوم واحد بعد الفتح';
  if (n === 2) return 'يومان بعد الفتح';
  if (n >= 3 && n <= 10) return `${num(n, true)} أيام`;
  return `${num(n, true)} يومًا`;
}

function uniqueKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

/* ── the «ثم» consequence preview — derived, never stored ─────────── */

function ConsequenceLines({ steps, index, isAr }: { steps: StepDef[]; index: number; isAr: boolean }) {
  const step = steps[index];
  const next = steps[index + 1];
  const prev = steps[index - 1];
  // noUncheckedIndexedAccess: index always valid at call sites, but guard anyway.
  if (!step) return null;
  const nextLine = next
    ? (isAr
      ? <>تُفتح الخطوة {num(index + 2, true)} <b>{next.label_ar}</b> · يُشعر {roleLabel(next.role_key, true)}</>
      : <>step {index + 2} <b>{next.label_en}</b> opens · {roleLabel(next.role_key, false)} is notified</>)
    : (isAr ? <>يكتمل المسار · يُغلق السجل</> : <>the path completes · the record closes</>);

  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
      <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'ثم' : 'Then'}</div>
      {step.is_approval ? (
        <>
          <div className="rule">
            <span className="arw">{isAr ? 'عند الاعتماد ←' : 'On approve ←'}</span>
            <span>{nextLine}</span>
          </div>
          <div className="rule">
            <span className="arw">{isAr ? 'عند التعديل ←' : 'On changes ←'}</span>
            <span>
              {prev
                ? (isAr
                  ? <>العودة للخطوة {num(index, true)} <b>{prev.label_ar}</b>{step.creates_revision && ' · تُنشأ مهمة تعديل'} · يُشعر {roleLabel(prev.role_key, true)}</>
                  : <>back to step {index} <b>{prev.label_en}</b>{step.creates_revision && ' · a revision task is created'} · {roleLabel(prev.role_key, false)} is notified</>)
                : (isAr
                  ? <>تبقى المهمة عند هذه الخطوة{step.creates_revision && ' · تُنشأ مهمة تعديل'}</>
                  : <>the task stays on this step{step.creates_revision && ' · a revision task is created'}</>)}
            </span>
          </div>
        </>
      ) : (
        <div className="rule">
          <span className="arw">{isAr ? 'عند الإرسال ←' : 'On submit ←'}</span>
          <span>{nextLine}</span>
        </div>
      )}
    </div>
  );
}

/* ── chip editor for required_fields / required_files ─────────────── */

function ChipList({
  values, addLabel, isAr, onChange,
}: {
  values: string[];
  addLabel: string;
  isAr: boolean;
  onChange: (next: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const commit = (): void => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
    setAdding(false);
  };
  return (
    <>
      {values.map((v) => (
        <span key={v} className="fbtn on">
          {v}
          <button
            type="button"
            className="x"
            style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit', color: 'inherit' }}
            aria-label={isAr ? `إزالة ${v}` : `Remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
          >
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <input
          className="se-chip-inp"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { setDraft(''); setAdding(false); }
          }}
        />
      ) : (
        <button type="button" className="fbtn" style={{ borderStyle: 'dashed' }} onClick={() => setAdding(true)}>
          {addLabel}
        </button>
      )}
    </>
  );
}

/* ── one sortable step ────────────────────────────────────────────── */

function StepRow({
  step, index, steps, expanded, canManage, isAr,
  onOpen, onChange, onDelete, onDuplicate,
}: {
  step: StepDef;
  index: number;
  steps: StepDef[];
  expanded: boolean;
  canManage: boolean;
  isAr: boolean;
  onOpen: () => void;
  onChange: (next: StepDef) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: step.key, disabled: !canManage });

  const flag = (label: string, on: boolean, toggle: () => void): JSX.Element => (
    <button
      type="button"
      className={`fbtn${on ? ' on' : ''}`}
      disabled={!canManage}
      onClick={toggle}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={setNodeRef}
      className={`wstep${expanded ? ' exp' : ''}`}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : undefined,
        zIndex: isDragging ? 5 : undefined,
        position: 'relative',
      }}
    >
      <span className="hn" {...attributes} {...listeners} aria-label={isAr ? 'اسحب لإعادة الترتيب' : 'Drag to reorder'}>
        <Grip />
      </span>
      <span className="n2">{num(index + 1, isAr)}</span>
      <div className="bd2">
        {!expanded && (
          <button type="button" className="se-step-open" onClick={onOpen}>
            <div className="nm3">{isAr ? step.label_ar : step.label_en}</div>
            <div className="rowx">
              <div className="cell">
                <div className="k2">{isAr ? 'الدور' : 'Role'}</div>
                <div className="v2">{roleLabel(step.role_key, isAr)}</div>
              </div>
              <div className="cell">
                <div className="k2">{isAr ? 'الاستحقاق' : 'Due'}</div>
                <div className="v2">{dueLabel(step.due_days, isAr)}</div>
              </div>
              <div className="cell">
                <div className="k2">{isAr ? 'الاعتماد' : 'Approval'}</div>
                <div className="v2" style={step.is_approval ? undefined : { color: 'var(--mute)' }}>
                  {step.is_approval
                    ? (isAr ? 'اعتماد / طلب تعديلات' : 'Approve / request changes')
                    : (isAr ? 'لا يوجد — إرسال فقط' : 'None — submit only')}
                </div>
              </div>
              <div className="cell">
                <div className="k2">{isAr ? 'مطلوب' : 'Required'}</div>
                <div className="v2">
                  {step.required_fields.length + step.required_files.length > 0
                    ? [...step.required_fields, ...step.required_files].join(isAr ? '، ' : ', ')
                    : '—'}
                </div>
              </div>
            </div>
          </button>
        )}

        {expanded && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
              <div className="nm3">{isAr ? step.label_ar : step.label_en}</div>
              <Pill tone="now">{isAr ? 'قيد التعديل' : 'Editing'}</Pill>
              {canManage && (
                <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 7 }}>
                  <button type="button" className="btn btn-sm" onClick={onDuplicate}>
                    {isAr ? 'نسخ الخطوة' : 'Duplicate step'}
                  </button>
                  <button type="button" className="btn btn-d btn-sm" onClick={onDelete}>
                    {isAr ? 'حذف الخطوة' : 'Delete step'}
                  </button>
                </span>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13, marginTop: 13 }}>
              <div>
                <div className="lbl" style={{ marginBottom: 5 }}>{isAr ? 'الاسم بالعربية' : 'Arabic label'}</div>
                <input
                  className="inp"
                  value={step.label_ar}
                  disabled={!canManage}
                  onChange={(e) => onChange({ ...step, label_ar: e.target.value })}
                />
              </div>
              <div>
                <div className="lbl" style={{ marginBottom: 5 }}>{isAr ? 'الاسم بالإنجليزية' : 'English label'}</div>
                <input
                  className="inp"
                  dir="ltr"
                  value={step.label_en}
                  disabled={!canManage}
                  onChange={(e) => onChange({ ...step, label_en: e.target.value })}
                />
              </div>
              <div>
                <div className="lbl" style={{ marginBottom: 5 }}>{isAr ? 'الدور المسؤول' : 'Owning role'}</div>
                <select
                  className="inp"
                  value={step.role_key}
                  disabled={!canManage}
                  onChange={(e) => onChange({ ...step, role_key: e.target.value as MosPathRole })}
                >
                  {PATH_ROLES.map((r) => (
                    <option key={r} value={r}>{roleLabel(r, isAr)}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="lbl" style={{ marginBottom: 5 }}>{isAr ? 'الاستحقاق بالأيام' : 'Days allowed'}</div>
                <input
                  className="inp"
                  inputMode="numeric"
                  value={step.due_days}
                  disabled={!canManage}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    onChange({ ...step, due_days: Number.isFinite(n) && n > 0 ? Math.floor(n) : 1 });
                  }}
                />
              </div>
            </div>

            <div style={{ marginTop: 13 }}>
              <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'هذه الخطوة اعتماد' : 'This step is an approval'}</div>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                {flag(
                  isAr ? 'اعتماد / طلب تعديلات' : 'Approve / request changes',
                  step.is_approval,
                  () => onChange({
                    ...step,
                    is_approval: !step.is_approval,
                    approval_kind: !step.is_approval ? (step.approval_kind ?? 'creative') : null,
                  }),
                )}
                {flag(
                  isAr ? 'ملاحظة إلزامية عند الرفض' : 'Note required on reject',
                  step.require_note_on_reject,
                  () => onChange({ ...step, require_note_on_reject: !step.require_note_on_reject }),
                )}
                {flag(
                  isAr ? 'الرفض يُنشئ مهمة تعديل' : 'Reject creates a revision task',
                  step.creates_revision,
                  () => onChange({ ...step, creates_revision: !step.creates_revision }),
                )}
              </div>
              {step.is_approval && (
                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 7 }}>
                  {APPROVAL_KINDS.map((k) => (
                    <button
                      key={k.key}
                      type="button"
                      className={`fbtn${step.approval_kind === k.key ? ' on' : ''}`}
                      disabled={!canManage}
                      onClick={() => onChange({ ...step, approval_kind: k.key })}
                    >
                      {isAr ? k.ar : k.en}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div style={{ marginTop: 13 }}>
              <div className="lbl" style={{ marginBottom: 6 }}>
                {isAr ? 'المطلوب قبل الاعتماد' : 'Required before approval'}
              </div>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center' }}>
                <ChipList
                  values={step.required_fields}
                  addLabel={isAr ? '+ حقل' : '+ field'}
                  isAr={isAr}
                  onChange={(next) => onChange({ ...step, required_fields: next })}
                />
                <ChipList
                  values={step.required_files}
                  addLabel={isAr ? '+ ملف' : '+ file'}
                  isAr={isAr}
                  onChange={(next) => onChange({ ...step, required_files: next })}
                />
              </div>
            </div>

            <ConsequenceLines steps={steps} index={index} isAr={isAr} />

            <div style={{ marginTop: 12 }}>
              <button type="button" className="btn btn-sm" onClick={onOpen}>
                {isAr ? 'إغلاق المحرر' : 'Close editor'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── the page ─────────────────────────────────────────────────────── */

export default function SettingsWorkflows({
  workflows, canManage, isAr, onWorkflow,
}: {
  workflows: WorkflowDef[];
  canManage: boolean;
  isAr: boolean;
  onWorkflow: (saved: WorkflowDef) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const [selectedId, setSelectedId] = useState<string | null>(workflows[0]?.id ?? null);
  const selected = useMemo(
    () => workflows.find((w) => w.id === selectedId) ?? workflows[0] ?? null,
    [workflows, selectedId],
  );

  // The draft: the steps being edited, reset whenever the selection changes.
  const [draft, setDraft] = useState<StepDef[]>(() => selected?.steps.map((s) => ({ ...s })) ?? []);
  const [draftOf, setDraftOf] = useState<string | null>(selected?.id ?? null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = useMemo(
    () => selected !== null && JSON.stringify(draft) !== JSON.stringify(selected.steps),
    [draft, selected],
  );

  // Selection changed under us (picker click or fresh save response).
  if (selected && draftOf !== selected.id) {
    setDraftOf(selected.id);
    setDraft(selected.steps.map((s) => ({ ...s })));
    setExpandedKey(null);
  }

  if (!selected) {
    return (
      <>
        <PageHead
          title={isAr ? 'مسارات العمل' : 'Workflows'}
          crumb={
            <button type="button" onClick={() => navigate('/m/settings')}>
              <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
            </button>
          }
        />
        <div className="body"><Empty title={isAr ? 'لا مسارات' : 'No workflows'} /></div>
      </>
    );
  }

  const pick = (id: string): void => {
    if (id === selected.id) return;
    if (dirty && !window.confirm(isAr
      ? 'لديك تغييرات غير محفوظة على هذا المسار — تجاهلها؟'
      : 'You have unsaved changes on this path — discard them?')) return;
    setSelectedId(id);
  };

  const patchStep = (key: string, next: StepDef): void => {
    setDraft((ds) => ds.map((s) => (s.key === key ? next : s)));
    if (next.key !== key && expandedKey === key) setExpandedKey(next.key);
  };

  const addStep = (): void => {
    const taken = new Set(draft.map((s) => s.key));
    const key = uniqueKey(`step_${draft.length + 1}`, taken);
    const next: StepDef = {
      key,
      label_ar: 'خطوة جديدة',
      label_en: 'New step',
      role_key: 'writer',
      due_days: 2,
      is_approval: false,
      approval_kind: null,
      require_note_on_reject: false,
      creates_revision: false,
      required_fields: [],
      required_files: [],
    };
    setDraft((ds) => [...ds, next]);
    setExpandedKey(key);
  };

  const duplicateStep = (key: string): void => {
    setDraft((ds) => {
      const at = ds.findIndex((s) => s.key === key);
      if (at < 0) return ds;
      const taken = new Set(ds.map((s) => s.key));
      const src = ds[at];
      if (!src) return ds;
      const copy: StepDef = { ...src, key: uniqueKey(`${src.key}_copy`, taken) };
      const next = [...ds];
      next.splice(at + 1, 0, copy);
      return next;
    });
  };

  const deleteStep = (key: string): void => {
    setDraft((ds) => ds.filter((s) => s.key !== key));
    if (expandedKey === key) setExpandedKey(null);
  };

  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setDraft((ds) => {
      const from = ds.findIndex((s) => s.key === active.id);
      const to = ds.findIndex((s) => s.key === over.id);
      return from >= 0 && to >= 0 ? arrayMove(ds, from, to) : ds;
    });
  };

  const save = async (asCopy: boolean): Promise<void> => {
    for (const s of draft) {
      if (!s.label_ar.trim() || !s.label_en.trim()) {
        addToast(isAr ? 'كل خطوة تحتاج اسمًا بالعربية والإنجليزية.' : 'Every step needs both labels.', 'error');
        return;
      }
    }
    if (draft.length === 0) {
      addToast(isAr ? 'المسار يحتاج خطوة واحدة على الأقل.' : 'A path needs at least one step.', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await saveWorkflow({
        ...(asCopy ? {} : { id: selected.id }),
        label_ar: asCopy ? `${selected.label_ar} — نسخة` : selected.label_ar,
        label_en: asCopy ? `${selected.label_en} (copy)` : selected.label_en,
        is_active: selected.is_active,
        steps: draft,
      });
      onWorkflow(res.workflow);
      if (asCopy) {
        setSelectedId(res.workflow.id);
      } else {
        // Re-seed the draft from the server's shape so `dirty` compares equal —
        // the server may normalize key order inside each step object.
        setDraft(res.workflow.steps.map((s) => ({ ...s })));
      }
      addToast(
        isAr
          ? `حُفظ المسار — الإصدار ${num(res.version_no, true)}. السجلات الجارية تحتفظ بإصدارها.`
          : `Path saved — version ${res.version_no}. In-flight records keep their pinned version.`,
        'success',
      );
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead
        title={isAr ? selected.label_ar : selected.label_en}
        sub={
          isAr
            ? `${num(draft.length, true)} خطوات · الإصدار ${num(selected.current_version_no, true)}${dirty ? ' · تغييرات غير محفوظة' : ''}`
            : `${draft.length} steps · version ${selected.current_version_no}${dirty ? ' · unsaved changes' : ''}`
        }
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
            <span className="sep"> / </span>
            {isAr ? 'مسارات العمل' : 'Workflows'}
          </button>
        }
      >
        {canManage && (
          <>
            <button type="button" className="btn btn-d" disabled={busy} onClick={() => void save(true)}>
              {isAr ? 'نسخ' : 'Duplicate'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={addStep}>
              <IconPlus />
              {isAr ? 'إضافة خطوة' : 'Add a step'}
            </button>
            <button type="button" className="btn btn-p" disabled={busy || !dirty} onClick={() => void save(false)}>
              {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ التغييرات' : 'Save changes'}
            </button>
          </>
        )}
      </PageHead>

      <div className="body">
        {workflows.length > 1 && (
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginBottom: 14 }}>
            {workflows.map((w) => (
              <button
                key={w.id}
                type="button"
                className={`fbtn${w.id === selected.id ? ' on' : ''}`}
                onClick={() => pick(w.id)}
              >
                {isAr ? w.label_ar : w.label_en}
                <span style={{ color: 'var(--mute)', marginInlineStart: 5 }}>{num(w.steps.length, isAr)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="se-wf-grid">
          <div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={draft.map((s) => s.key)} strategy={verticalListSortingStrategy}>
                {draft.map((s, i) => (
                  <StepRow
                    key={s.key}
                    step={s}
                    index={i}
                    steps={draft}
                    expanded={expandedKey === s.key}
                    canManage={canManage}
                    isAr={isAr}
                    onOpen={() => setExpandedKey(expandedKey === s.key ? null : s.key)}
                    onChange={(next) => patchStep(s.key, next)}
                    onDelete={() => deleteStep(s.key)}
                    onDuplicate={() => duplicateStep(s.key)}
                  />
                ))}
              </SortableContext>
            </DndContext>
            {draft.length === 0 && (
              <Empty title={isAr ? 'لا خطوات بعد' : 'No steps yet'} />
            )}
          </div>

          <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
            <div className="card">
              <div className="card-h"><h4>{isAr ? 'ماذا تستطيع الخطوة أن تفعل' : 'What a step can do'}</h4></div>
              <div className="card-b" style={{ fontSize: 12, lineHeight: 1.95, color: 'var(--ink-2)' }}>
                {isAr
                  ? 'إنشاء مهمة · إسناد دور · اشتراط حقول · اشتراط ملفات · طلب اعتماد · إرسال إشعار · انتظار تاريخ · الانتقال لخطوة · الجدولة أو النشر.'
                  : 'Open a task · assign a role · require fields · require files · ask for approval · send a notification · wait for a date · move to a step · schedule or publish.'}
                <div style={{ marginTop: 11, paddingTop: 10, borderTop: '1px solid var(--line-soft)', color: 'var(--mute)' }}>
                  {isAr
                    ? 'تسعة إجراءات، عمدًا. وما يتجاوزها ينتمي لمحرك مسارات العمل الموجود أصلًا في النظام، لا لمحرك ثانٍ يُبنى هنا.'
                    : 'Nine actions, deliberately. Anything beyond them belongs to the workflow engine the system already has — not to a second engine built here.'}
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-h">
                <h4>{isAr ? 'الأدوار' : 'Roles'}</h4>
                <span className="r">{num(PATH_ROLES.length, isAr)}</span>
              </div>
              <div className="card-b" style={{ display: 'grid', gap: 8, fontSize: 12 }}>
                {([
                  ['ceo', 'لا يعتمد محتوى', 'approves no content'],
                  ['marketing_manager', 'يعتمد الإبداع', 'approves creative'],
                  ['ops_supervisor', 'يعتمد الإجراءات', 'approves process'],
                  ['writer', 'ينتج', 'produces'],
                  ['montage', 'ينتج', 'produces'],
                ] as Array<[MosPathRole, string, string]>).map(([r, ar, en]) => (
                  <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className={`av ${roleAvatarClass(r)}`}>{initial(roleLabel(r, isAr))}</span>
                    {roleLabel(r, isAr)}
                    <span style={{ marginInlineStart: 'auto', color: 'var(--mute)' }}>{isAr ? ar : en}</span>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 5, paddingTop: 9, borderTop: '1px solid var(--line-soft)', lineHeight: 1.75 }}>
                  {isAr
                    ? 'الخطوات تشير إلى أدوار لا أشخاص. استبدال من يشغل دورًا تغيير واحد في صفحة الأدوار، لا أربعة عشر.'
                    : 'Steps point at roles, not people. Replacing who fills a role is one change on the Roles page, not fourteen.'}
                </div>
              </div>
            </div>

            <div style={{
              background: 'color-mix(in srgb, var(--gold) 14%, transparent)',
              border: '1px solid color-mix(in srgb, var(--gold) 40%, transparent)',
              borderRadius: 9,
              padding: '12px 13px',
              fontSize: 12,
              lineHeight: 1.85,
              color: 'var(--ink-2)',
            }}>
              <b style={{ fontWeight: 700 }}>
                {isAr ? 'الحفظ يؤثر على السجلات الجديدة فقط' : 'Saving affects new records only'}
              </b>
              {isAr
                ? ' — وما هو جارٍ يحتفظ بالخطوات التي بدأ بها.'
                : ' — anything already in flight keeps the steps it started with.'}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
