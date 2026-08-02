/**
 * Settings → Content types — design screen 27, rebuilt.
 *
 * The screen that proves the central idea: a type is a ROW — a name, a
 * workflow, a set of writing fields, a ref prefix. Adding «كتيّب» next year is
 * filling this form, not building a module. If this screen is right, the
 * system stops needing a programmer to grow.
 *
 * Two rules the design is absolute about, kept here:
 *   1. Deleting a FIELD hides it (is_hidden) — existing records keep data.
 *   2. Deleting a TYPE deactivates it (is_active=false) — never a hard delete.
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
  FIELD_KIND_LABELS, MosContentType, MosFieldDef, MosFieldKind, WorkflowDef,
  fieldSchemaEntries, saveContentType,
} from '@/lib/marketingOS/client';
import { Field, PageHead } from './kit';
import { IconBack, IconForward, kindIcon } from './icons';
import { num } from '../lib/format';

const KINDS = Object.keys(FIELD_KIND_LABELS) as MosFieldKind[];

// NOTE: workflow list source switches to canonical role_path rows when the engine API lands
const workflowOptions = (workflows: WorkflowDef[]) =>
  workflows.map((w) => ({ id: w.id, label_ar: w.label_ar, label_en: w.label_en, stages: w.steps.length }));

const Grip = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M8 6h8M8 12h8M8 18h8" /></svg>
);

/* ------------------------------------------------------------------ */
/* one draggable field row                                              */
/* ------------------------------------------------------------------ */

function FieldRow({
  field, isAr, onChange, onHide,
}: {
  field: MosFieldDef;
  isAr: boolean;
  onChange: (next: MosFieldDef) => void;
  onHide: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.key });
  return (
    <div
      ref={setNodeRef}
      className="wstep s27-field"
      style={{
        padding: '9px 12px',
        margin: 0,
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
      <div className="bd2" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <input
          className="s27-fname"
          value={field.label_ar}
          placeholder={isAr ? 'اسم الحقل' : 'Field name'}
          onChange={(e) => onChange({ ...field, label_ar: e.target.value })}
        />
        <input
          className="s27-fname en ltr"
          value={field.label_en}
          placeholder="English name"
          onChange={(e) => onChange({ ...field, label_en: e.target.value })}
        />
        <select
          className="s27-fkind"
          value={field.kind}
          onChange={(e) => onChange({ ...field, kind: e.target.value as MosFieldKind })}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>{isAr ? FIELD_KIND_LABELS[k].ar : FIELD_KIND_LABELS[k].en}</option>
          ))}
        </select>
        <button
          type="button"
          className={`fbtn${field.required ? ' on' : ''}`}
          onClick={() => onChange({ ...field, required: !field.required })}
        >
          {isAr ? 'مطلوب' : 'Required'}
        </button>
      </div>
      <button type="button" className="btn btn-d btn-sm" onClick={onHide}>
        {isAr ? 'حذف' : 'Delete'}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* the section                                                          */
/* ------------------------------------------------------------------ */

export default function SettingsContentTypes({
  types, workflows, canManage, isAr, onTypes,
}: {
  types: MosContentType[];
  workflows: WorkflowDef[];
  canManage: boolean;
  isAr: boolean;
  onTypes: (types: MosContentType[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // NOTE: workflow list source switches to canonical role_path rows when the engine API lands
  const wfOptions = useMemo(() => workflowOptions(workflows), [workflows]);
  const wfById = useMemo(() => new Map(workflows.map((w) => [w.id, w])), [workflows]);

  /* The editor. `null` id = the mockup's default: the first type is open. */
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const effectiveId = editingId ?? types[0]?.id ?? null;
  const editingType = effectiveId === 'new' ? null : types.find((t) => t.id === effectiveId) ?? null;
  const editorOpen = effectiveId !== null;

  /* ── editor draft ── */
  const [draftKey, setDraftKey] = useState('');
  const [draftAr, setDraftAr] = useState('');
  const [draftEn, setDraftEn] = useState('');
  const [draftPrefix, setDraftPrefix] = useState('');
  const [draftWf, setDraftWf] = useState('');
  const [draftFields, setDraftFields] = useState<MosFieldDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | 'new' | null>(null);

  // Load the draft when the edited type changes. Done in render-guard state
  // (not an effect) so the switch is atomic with the selection click.
  if (editorOpen && loadedFor !== effectiveId) {
    setLoadedFor(effectiveId);
    setDraftKey(editingType?.key ?? '');
    setDraftAr(editingType?.label_ar ?? '');
    setDraftEn(editingType?.label_en ?? '');
    setDraftPrefix(editingType?.prefix ?? '');
    setDraftWf(editingType?.workflow_id ?? '');
    setDraftFields(fieldSchemaEntries(editingType?.field_schema ?? []));
  }

  const visible = draftFields.filter((f) => !f.is_hidden);
  const hidden = draftFields.filter((f) => f.is_hidden);

  const patchField = (key: string, next: MosFieldDef): void =>
    setDraftFields((fs) => fs.map((f) => (f.key === key ? next : f)));
  const hideField = (key: string): void =>
    setDraftFields((fs) => fs.map((f) => (f.key === key ? { ...f, is_hidden: true } : f)));
  const restoreField = (key: string): void =>
    setDraftFields((fs) => fs.map((f) => (f.key === key ? { ...f, is_hidden: false } : f)));

  const addField = (): void => {
    let i = draftFields.length + 1;
    while (draftFields.some((f) => f.key === `field_${i}`)) i += 1;
    setDraftFields((fs) => [
      ...fs,
      { key: `field_${i}`, label_ar: '', label_en: '', kind: 'short', required: false },
    ]);
  };

  const onDragEnd = (e: DragEndEvent): void => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setDraftFields((fs) => {
      const from = fs.findIndex((f) => f.key === active.id);
      const to = fs.findIndex((f) => f.key === over.id);
      return from >= 0 && to >= 0 ? arrayMove(fs, from, to) : fs;
    });
  };

  const openNew = (): void => {
    setEditingId('new');
  };

  const save = async (): Promise<void> => {
    if (!draftAr.trim() || !draftEn.trim() || !draftPrefix.trim() || (effectiveId === 'new' && !draftKey.trim())) {
      addToast(
        isAr ? 'الاسمان والبادئة (والمفتاح لنوع جديد) إلزامية.' : 'Both labels and the prefix (and the key for a new type) are required.',
        'error',
      );
      return;
    }
    setBusy(true);
    try {
      const res = await saveContentType({
        id: editingType?.id,
        key: (editingType?.key ?? draftKey).trim(),
        label_ar: draftAr.trim(),
        label_en: draftEn.trim(),
        prefix: draftPrefix.trim(),
        workflow_id: draftWf || null,
        field_schema: draftFields,
        is_active: editingType?.is_active ?? true,
        ...(effectiveId === 'new'
          ? { sort_order: Math.max(0, ...types.map((t) => t.sort_order)) + 1 }
          : {}),
      });
      onTypes(res.content_types);
      addToast(isAr ? 'حُفظ النوع.' : 'Type saved.', 'success');
      if (effectiveId === 'new') {
        const created = res.content_types.find((t) => t.key === draftKey.trim());
        setEditingId(created?.id ?? null);
      }
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Deactivating a type is hide-not-erase: is_active flips, the row stays. */
  const toggleActive = async (t: MosContentType): Promise<void> => {
    try {
      const res = await saveContentType({ id: t.id, is_active: !t.is_active });
      onTypes(res.content_types);
      addToast(
        t.is_active
          ? (isAr ? 'أُوقف النوع — سجلاته وبياناته كما هي.' : 'Type deactivated — its records and data are untouched.')
          : (isAr ? 'أُعيد تفعيل النوع.' : 'Type reactivated.'),
        'success',
      );
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const fieldsOf = (t: MosContentType): MosFieldDef[] =>
    fieldSchemaEntries(t.field_schema).filter((f) => !f.is_hidden);

  return (
    <>
      <PageHead
        title={isAr ? 'أنواع المحتوى' : 'Content types'}
        sub={isAr
          ? `${num(types.length, true)} أنواع · كل نوع مرتبط بمسار واحد ومجموعة حقول واحدة`
          : `${types.length} types · each bound to one workflow and one set of fields`}
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      >
        {canManage && (
          <button type="button" className="btn btn-p" onClick={openNew}>
            {isAr ? 'إضافة نوع' : 'Add a type'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {/* ── the type table ── */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 44 }} />
                  <th style={{ width: 120 }}>{isAr ? 'النوع' : 'Type'}</th>
                  <th style={{ width: 66 }}>{isAr ? 'البادئة' : 'Prefix'}</th>
                  <th style={{ width: 184 }}>{isAr ? 'مسار العمل' : 'Workflow'}</th>
                  <th>{isAr ? 'الحقول التي تظهر' : 'Fields that appear'}</th>
                  <th className="num" style={{ width: 74 }}>{isAr ? 'الحقول' : 'Fields'}</th>
                  <th style={{ width: 60 }}>{isAr ? 'نشط' : 'Active'}</th>
                  <th style={{ width: 70 }} />
                </tr>
              </thead>
              <tbody>
                {types.map((t) => {
                  const w = t.workflow_id ? wfById.get(t.workflow_id) : undefined;
                  const Icon = kindIcon(t.key);
                  const visibleFields = fieldsOf(t);
                  const isEditing = effectiveId === t.id;
                  return (
                    <tr key={t.id} className={isEditing ? 'hl' : undefined} style={t.is_active ? undefined : { opacity: 0.55 }}>
                      <td><span className="kind"><Icon /></span></td>
                      <td className="ttl">
                        {isAr ? t.label_ar : t.label_en}
                        <div style={{ fontSize: 11, color: 'var(--mute)', fontWeight: 400 }}>
                          {isAr ? t.label_en : t.label_ar}
                        </div>
                      </td>
                      <td className="id">{t.prefix}</td>
                      <td>
                        {w
                          ? `${isAr ? w.label_ar : w.label_en} · ${isAr
                              ? `${num(w.steps.length, true)} مراحل`
                              : `${w.steps.length} stages`}`
                          : '—'}
                      </td>
                      <td style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>
                        {visibleFields.map((f) => (isAr ? f.label_ar : f.label_en) || f.key).join(' · ') || '—'}
                      </td>
                      <td className="num">{num(visibleFields.length, isAr)}</td>
                      <td>
                        <button
                          type="button"
                          className={`sw${t.is_active ? ' on' : ''}`}
                          disabled={!canManage}
                          aria-label={isAr ? 'تفعيل النوع' : 'Toggle the type'}
                          onClick={() => void toggleActive(t)}
                        />
                      </td>
                      <td>
                        <button type="button" className="btn btn-sm" onClick={() => setEditingId(t.id)}>
                          {isAr ? 'تعديل' : 'Edit'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── the editor + the side column ── */}
        {editorOpen && (
          <div className="grid s27-grid">
            <div className="card">
              <div className="card-h">
                <h4>
                  {editingType
                    ? `${isAr ? 'تعديل' : 'Edit'} · ${isAr ? editingType.label_ar : editingType.label_en}`
                    : (isAr ? 'نوع جديد' : 'New type')}
                </h4>
                <span className="pill p-now" style={{ marginInlineStart: 'auto' }}>
                  {isAr ? `${num(visible.length, true)} حقول` : `${visible.length} fields`}
                </span>
              </div>
              <div className="card-b">
                <div className="s27-head-grid">
                  <div>
                    <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'الاسم' : 'Name'}</div>
                    <input className="inp" style={{ fontSize: 12.5 }} value={draftAr} onChange={(e) => setDraftAr(e.target.value)} />
                  </div>
                  <div>
                    <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'الاسم بالإنجليزية' : 'English name'}</div>
                    <input className="inp ltr" style={{ fontSize: 12.5 }} value={draftEn} onChange={(e) => setDraftEn(e.target.value)} />
                  </div>
                  <div>
                    <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'بادئة الرقم' : 'Ref prefix'}</div>
                    <input className="inp ltr" style={{ fontSize: 12.5 }} value={draftPrefix} onChange={(e) => setDraftPrefix(e.target.value)} />
                  </div>
                  <div>
                    <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'مسار العمل' : 'Workflow'}</div>
                    <select className="inp" style={{ fontSize: 12.5 }} value={draftWf} onChange={(e) => setDraftWf(e.target.value)}>
                      <option value="">{isAr ? 'بلا مسار' : 'No workflow'}</option>
                      {wfOptions.map((w) => (
                        <option key={w.id} value={w.id}>{isAr ? w.label_ar : w.label_en}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {effectiveId === 'new' && (
                  <div style={{ marginBottom: 16, maxWidth: 260 }}>
                    <Field label={isAr ? 'المفتاح' : 'Key'} hint="snake_case">
                      <input className="inp ltr" value={draftKey} onChange={(e) => setDraftKey(e.target.value)} />
                    </Field>
                  </div>
                )}

                <div className="lbl" style={{ marginBottom: 8 }}>
                  {isAr ? 'الحقول في تبويب المحتوى · اسحب لإعادة الترتيب' : 'The fields on the Content tab · drag to reorder'}
                </div>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                  <SortableContext items={visible.map((f) => f.key)} strategy={verticalListSortingStrategy}>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {visible.map((f) => (
                        <FieldRow
                          key={f.key}
                          field={f}
                          isAr={isAr}
                          onChange={(next) => patchField(f.key, next)}
                          onHide={() => hideField(f.key)}
                        />
                      ))}
                      <button type="button" className="wstep s27-add" onClick={addField}>
                        <span className="n2" style={{ borderRadius: '50%' }}>+</span>
                        <div className="bd2" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 12.5, color: 'var(--mute)' }}>
                            {isAr
                              ? 'إضافة حقل — نص قصير، نص طويل، جدول، اختيار، تاريخ، رقم، ملف'
                              : 'Add a field — short text, long text, table, choice, date, number, file'}
                          </span>
                        </div>
                      </button>
                    </div>
                  </SortableContext>
                </DndContext>

                {hidden.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div className="lbl" style={{ marginBottom: 6 }}>
                      {isAr ? 'مخفية — بياناتها محفوظة في السجلات القائمة' : 'Hidden — their data stays on existing records'}
                    </div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {hidden.map((f) => (
                        <div key={f.key} className="wstep s27-hidden" style={{ padding: '7px 12px', margin: 0 }}>
                          <div className="bd2" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ fontSize: 12.5, fontWeight: 700, width: 140 }}>
                              {(isAr ? f.label_ar : f.label_en) || f.key}
                            </span>
                            <span className="tag tag-t">{isAr ? FIELD_KIND_LABELS[f.kind].ar : FIELD_KIND_LABELS[f.kind].en}</span>
                          </div>
                          <button type="button" className="btn btn-sm" onClick={() => restoreField(f.key)}>
                            {isAr ? 'استعادة' : 'Restore'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
                  <button type="button" className="btn btn-p" onClick={() => void save()} disabled={busy || !canManage}>
                    {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
                  </button>
                  {editingType && (
                    <button type="button" className="btn" onClick={() => setEditingId(types[0]?.id ?? null)} disabled={busy}>
                      {isAr ? 'إغلاق' : 'Close'}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
              {/* The «إضافة نوع لاحقًا» card — verbatim from s27.html. */}
              <div className="card">
                <div className="card-h"><h4>{isAr ? 'إضافة نوع لاحقًا' : 'Adding a type later'}</h4></div>
                <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
                  {isAr ? (
                    <>
                      <div>
                        <b style={{ fontWeight: 700 }}>الكتيّب</b> سيكون: البادئة <b className="ltr">B-</b>، ومسار المنشور القياسي،
                        وحقول لعدد الصفحات والنص لكل صفحة ومواصفات الطباعة.
                      </div>
                      <div style={{ marginTop: 10 }}>
                        وسيظهر في جدول المحتوى واللوحة والتقويم وكل التصفيات <b>فورًا</b> — بلا صفحة جديدة، ولا ترحيل، ولا مبرمج.
                      </div>
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line-soft)', color: 'var(--mute)' }}>
                        هذا هو العائد الكامل لرفض بناء وحدتين منفصلتين للمنشورات والفيديوهات.
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <b style={{ fontWeight: 700 }}>The booklet</b> will be: the prefix <b className="ltr">B-</b>, the
                        standard post workflow, and fields for page count, per-page copy and print specs.
                      </div>
                      <div style={{ marginTop: 10 }}>
                        And it appears in the content table, the board, the calendar and every filter <b>at
                        once</b> — no new page, no migration, no programmer.
                      </div>
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line-soft)', color: 'var(--mute)' }}>
                        That is the whole payoff for refusing to build two separate modules for posts and videos.
                      </div>
                    </>
                  )}
                </div>
              </div>
              {/* «حذف الحقل محمي» — verbatim from s27.html. */}
              <div className="s26-note" style={{ marginTop: 0, padding: '12px 13px', fontSize: 12, lineHeight: 1.85 }}>
                {isAr ? (
                  <>
                    <b style={{ fontWeight: 700 }}>حذف الحقل محمي.</b> أربعة عشر سجل فيديو تحتفظ ببيانات في «المشاهد».
                    الحذف يُخفي الحقل عن السجلات الجديدة ويُبقي البيانات القائمة قابلة للقراءة بدل مسحها.
                  </>
                ) : (
                  <>
                    <b style={{ fontWeight: 700 }}>Deleting a field is protected.</b> Fourteen video records hold data in
                    “Scenes”. Deleting hides the field from new records and keeps the existing data readable instead of
                    erasing it.
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
