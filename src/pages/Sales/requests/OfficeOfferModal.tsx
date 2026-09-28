/**
 * «إضافة عرض من مكتب» — save what an office offered for an unanswered request.
 *
 * Five shapes, all stored as ORDINARY records so they flow into client options,
 * the units table and the finder like any other stock:
 *   1. unit_in_project — a unit inside a project we already have;
 *   2. project         — a new project (no units yet);
 *   3. project_unit    — a new project + one unit;
 *   4. project_units   — a new project + a list of units;
 *   5. office_unit     — a standalone unit with NO project (unit_source='office',
 *                        its own office_unit_location).
 * Every record carries source_office_id + source_request_id. Each unit (or the
 * project, when there is no unit) is added to the client's options through the
 * SAME engine as the Finder / chat (saveUnitToClient / saveProjectToClient), and
 * the request moves to «تم حصر العروض» with a history line.
 */
import { useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import DynamicField from '@/pages/Records/components/DynamicField';
import { useAppStore } from '@/stores/appStore';
import { usePermission } from '@/hooks/usePermission';
import { saveProjectToClient, saveUnitToClient } from '@/lib/matching/saveUnitOption';
import type { AppModel, AppRecord, ModelField } from '@/types';
import type { OutreachRow } from '@/lib/officeOutreach/client';

type Kind = 'unit_in_project' | 'project' | 'project_unit' | 'project_units' | 'office_unit';

const KINDS: { id: Kind; ar: string; en: string; hintAr: string; hintEn: string }[] = [
  { id: 'unit_in_project', ar: 'وحدة في مشروع موجود', en: 'Unit in an existing project', hintAr: 'المكتب يعرض وحدة في مشروع عندنا في النظام', hintEn: 'The office offers a unit in a project we already have' },
  { id: 'project', ar: 'مشروع', en: 'Project', hintAr: 'مشروع جديد بدون تفاصيل وحدات', hintEn: 'A new project, no unit details' },
  { id: 'project_unit', ar: 'مشروع + وحدة', en: 'Project + unit', hintAr: 'مشروع جديد ووحدة واحدة فيه', hintEn: 'A new project and one unit in it' },
  { id: 'project_units', ar: 'مشروع + قائمة وحدات', en: 'Project + unit list', hintAr: 'مشروع جديد وعدة وحدات', hintEn: 'A new project and several units' },
  { id: 'office_unit', ar: 'وحدة مستقلة من مكتب', en: 'Standalone office unit', hintAr: 'وحدة ليست ضمن مشروع — نوعها «وحدة من مكتب»', hintEn: 'A unit that is not in any project — type «Office unit»' },
];

const PROJECT_FIELDS = ['project_name', 'project_type', 'unit_types', 'location'];
const UNIT_FIELDS = ['unit_type', 'bedrooms', 'unit_area', 'total_price', 'floor', 'notes'];

const needsProject = (k: Kind) => k === 'project' || k === 'project_unit' || k === 'project_units';
const needsUnits = (k: Kind) => k !== 'project';

function fieldsOf(model: AppModel | undefined, names: string[]): ModelField[] {
  if (!model) return [];
  const all = model.schema.sections.flatMap((s) => s.fields);
  return names.map((n) => all.find((f) => f.name === n)).filter((f): f is ModelField => !!f);
}

interface Props {
  request: AppRecord;
  clientId: string;
  outreach: OutreachRow[];
  initialOfficeId: string | null;
  onClose: () => void;
}

export default function OfficeOfferModal({ request, clientId, outreach, initialOfficeId, onClose }: Props) {
  const models = useAppStore((s) => s.models);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const isAr = useAppStore((s) => s.language) === 'ar';
  const t = (ar: string, en: string) => (isAr ? ar : en);

  const unitsModel = models.find((m) => m.name === 'units');
  const projectsModel = models.find((m) => m.name === 'all_projects');
  const requestsModel = models.find((m) => m.name === 'unanswered_requests');
  const canUnit = usePermission(unitsModel?.id ?? '', 'create');
  const canProject = usePermission(projectsModel?.id ?? '', 'create');

  const offices = useMemo(() => {
    const seen = new Map<string, string>();
    for (const o of outreach) if (!seen.has(o.office_id)) seen.set(o.office_id, o.office_name ?? `+${o.office_phone}`);
    return [...seen.entries()];
  }, [outreach]);

  const [kind, setKind] = useState<Kind>('project_unit');
  const [officeId, setOfficeId] = useState<string>(initialOfficeId ?? offices[0]?.[0] ?? '');
  const [projectId] = useState(() => uuid());
  const [project, setProject] = useState<Record<string, unknown>>({});
  const [existingProject, setExistingProject] = useState<Record<string, unknown>>({});
  const [units, setUnits] = useState<{ id: string; data: Record<string, unknown> }[]>(() => [{ id: uuid(), data: {} }]);
  const [saving, setSaving] = useState(false);

  const projectFields = useMemo(() => fieldsOf(projectsModel, PROJECT_FIELDS), [projectsModel]);
  const unitFields = useMemo(() => fieldsOf(unitsModel, UNIT_FIELDS), [unitsModel]);
  const unitProjectField = useMemo(() => fieldsOf(unitsModel, ['project_id'])[0], [unitsModel]);
  const officeLocationField = useMemo(() => fieldsOf(unitsModel, ['office_unit_location'])[0], [unitsModel]);

  const allowed = (k: Kind) => (needsProject(k) ? canProject : true) && (needsUnits(k) ? canUnit : true);
  const visibleUnits = kind === 'project_units' ? units : units.slice(0, 1);

  const setUnitField = (id: string, slug: string, value: unknown) =>
    setUnits((prev) => prev.map((u) => (u.id === id ? { ...u, data: { ...u.data, [slug]: value } } : u)));

  const validate = (): string | null => {
    if (!allowed(kind)) return t('ليست لديك صلاحية إنشاء هذا النوع.', 'You are not allowed to create this.');
    if (needsProject(kind) && !(typeof project.project_name === 'string' && project.project_name.trim())) return t('اكتب اسم المشروع.', 'Enter the project name.');
    if (kind === 'unit_in_project' && !existingProject.project_id) return t('اختر المشروع.', 'Pick the project.');
    if (needsUnits(kind) && visibleUnits.some((u) => !u.data.unit_type)) return t('حدّد نوع كل وحدة.', 'Set the type of every unit.');
    return null;
  };

  const officeName = offices.find(([id]) => id === officeId)?.[1] ?? null;

  const save = async () => {
    const problem = validate();
    if (problem) { addToast(problem, 'error'); return; }
    if (!unitsModel || !projectsModel || !requestsModel) return;
    setSaving(true);
    const now = new Date().toISOString();
    const source: Record<string, unknown> = { source_request_id: request.id };
    if (officeId) source.source_office_id = officeId;
    const ok = (s: string) => s === 'saved' || s === 'queued';
    try {
      // 1. the project (new) or the chosen existing one
      let projRec: AppRecord | null = null;
      let linkProjectId: string | null = null;
      if (needsProject(kind)) {
        projRec = { id: projectId, model_id: projectsModel.id, data: { ...project, ...source }, created_at: now, updated_at: now };
        const res = await saveRecord(projRec, { expectedVersion: null });
        if (!ok(res.status)) throw new Error('project save failed');
        linkProjectId = projectId;
      } else if (kind === 'unit_in_project') {
        const v = existingProject.project_id;
        linkProjectId = Array.isArray(v) ? String(v[0]) : String(v);
      }

      // 2. the units
      const savedUnits: AppRecord[] = [];
      if (needsUnits(kind)) {
        for (const u of visibleUnits) {
          const data: Record<string, unknown> = {
            ...u.data, ...source,
            unit_status: 'available',
            unit_source: kind === 'office_unit' ? 'office' : 'project',
          };
          if (linkProjectId && kind !== 'office_unit') data.project_id = linkProjectId;
          const rec: AppRecord = { id: u.id, model_id: unitsModel.id, data, created_at: now, updated_at: now };
          const res = await saveRecord(rec, { expectedVersion: null });
          if (!ok(res.status)) throw new Error('unit save failed');
          savedUnits.push(rec);
        }
      }

      // 3. the client's options (units carry their parent project with them).
      // Each result is checked: a refused or failed option write must not be
      // reported as "added to the client's options".
      const latest = useAppStore.getState().records;
      const optionProblems: string[] = [];
      for (const u of savedUnits) {
        const rec = (latest[unitsModel.id] ?? []).find((r) => r.id === u.id) ?? u;
        const r = await saveUnitToClient(clientId, rec, 'manual');
        if (!r.unit.ok) optionProblems.push(r.unit.reason ?? r.unit.outcome);
        if (r.project && !r.project.ok) optionProblems.push(r.project.reason ?? r.project.outcome);
      }
      if (savedUnits.length === 0 && projRec) {
        const rec = (latest[projectsModel.id] ?? []).find((r) => r.id === projRec!.id) ?? projRec;
        const r = await saveProjectToClient(clientId, rec, 'manual');
        if (!r.ok) optionProblems.push(r.reason ?? r.outcome);
      }
      if (optionProblems.length > 0) console.error('[office offer] client option writes failed:', optionProblems);

      // 4. the request: status + history line
      const rd = request.data as Record<string, unknown>;
      const status = String(rd.request_status ?? 'received');
      const kindLabel = KINDS.find((k) => k.id === kind)!;
      const summary = [
        isAr ? kindLabel.ar : kindLabel.en,
        typeof project.project_name === 'string' ? project.project_name : null,
        savedUnits.length > 1 ? t(`${savedUnits.length} وحدات`, `${savedUnits.length} units`) : null,
      ].filter(Boolean).join(' — ');
      const updates = Array.isArray(rd.request_updates) ? rd.request_updates : [];
      const nextData: Record<string, unknown> = {
        ...rd,
        request_status: ['received', 'offices_selected', 'offices_contacted'].includes(status) ? 'offers_identified' : status,
        request_updates: [...updates, {
          id: uuid(),
          text: t(`عرض من ${officeName ?? 'مكتب'}: ${summary}`, `Offer from ${officeName ?? 'an office'}: ${summary}`),
          author_id: currentUserId,
          created_at: now,
        }],
      };
      const reqRes = await saveRecord({ ...request, data: nextData, updated_at: now }, { expectedVersion: null });
      if (!ok(reqRes.status)) {
        // The offer itself is saved; only the request's status line failed.
        addToast(t('حُفظ العرض لكن تعذّر تحديث حالة الطلب — حدّث الصفحة.', 'Offer saved, but the request status could not be updated — reload.'), 'error');
      } else if (optionProblems.length > 0) {
        addToast(t('حُفظ العرض، لكن لم يُضف لخيارات العميل — أضفه من تبويب الخيارات.', 'Offer saved, but it was not added to the client\'s options — add it from the Options tab.'), 'error');
      } else {
        addToast(t('تم حفظ العرض وإضافته لخيارات العميل', 'Offer saved and added to the client\'s options'), 'success');
      }
      onClose();
    } catch (err) {
      console.error('[office offer] save failed:', err);
      addToast(t('تعذّر حفظ العرض — لم يُحفظ ما بعد الخطوة الفاشلة. حاول مجدداً.', 'Could not save the offer — nothing after the failed step was saved. Try again.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const renderField = (field: ModelField, value: unknown, onChange: (v: unknown) => void, data: Record<string, unknown>, model: AppModel | undefined, recordId: string, onPatch?: (p: Record<string, unknown>) => void) => (
    <div key={field.id} className={field.type === 'location' || field.name === 'notes' || field.name === 'project_name' ? 'md:col-span-2' : ''}>
      <label className="mb-1 block text-xs font-semibold text-charcoal/60">{isAr ? field.label_ar : field.label_en}</label>
      <DynamicField field={field} value={value} onChange={onChange} recordData={data} compact modelId={model?.id} recordId={recordId}
        onPatch={onPatch ?? ((p) => { if (field.name in p) onChange(p[field.name]); })} />
    </div>
  );

  return (
    <Modal open onClose={onClose} title={t('إضافة عرض من مكتب', 'Add an office offering')} maxWidth="max-w-2xl">
      <div className="space-y-4">
        {/* office */}
        <div>
          <label className="mb-1 block text-xs font-semibold text-charcoal/60">{t('المكتب', 'Office')}</label>
          <select value={officeId} onChange={(e) => setOfficeId(e.target.value)} className="form-input w-full text-sm">
            <option value="">{t('بدون مكتب محدد', 'No specific office')}</option>
            {offices.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </div>

        {/* kind */}
        <div className="grid gap-2 sm:grid-cols-2">
          {KINDS.map((k) => (
            <button key={k.id} type="button" disabled={!allowed(k.id)} onClick={() => setKind(k.id)}
              className={`rounded-xl border p-3 text-start transition ${kind === k.id ? 'border-copper bg-copper/5 ring-1 ring-copper/30' : 'border-sand/60 bg-white hover:border-copper/40'} disabled:opacity-40`}>
              <div className="text-sm font-bold text-charcoal">{isAr ? k.ar : k.en}</div>
              <div className="text-xs text-charcoal/55">{isAr ? k.hintAr : k.hintEn}</div>
            </button>
          ))}
        </div>

        {/* existing project */}
        {kind === 'unit_in_project' && unitProjectField && (
          <div className="grid gap-3 md:grid-cols-2">
            {renderField(unitProjectField, existingProject.project_id, (v) => setExistingProject({ project_id: v }), existingProject, unitsModel, units[0]?.id ?? projectId)}
          </div>
        )}

        {/* new project */}
        {needsProject(kind) && (
          <div className="rounded-xl border border-sand/60 p-3">
            <div className="mb-2 text-sm font-bold text-chocolate">{t('المشروع', 'Project')}</div>
            <div className="grid gap-3 md:grid-cols-2">
              {projectFields.map((f) => renderField(f, project[f.name], (v) => setProject((p) => ({ ...p, [f.name]: v })), project, projectsModel, projectId,
                (patch) => setProject((p) => ({ ...p, ...patch }))))}
            </div>
          </div>
        )}

        {/* units */}
        {needsUnits(kind) && visibleUnits.map((u, i) => (
          <div key={u.id} className="rounded-xl border border-sand/60 p-3">
            <div className="mb-2 flex items-center text-sm font-bold text-chocolate">
              {kind === 'office_unit' ? t('وحدة المكتب', 'Office unit') : kind === 'project_units' ? t(`الوحدة ${i + 1}`, `Unit ${i + 1}`) : t('الوحدة', 'Unit')}
              {kind === 'project_units' && units.length > 1 && (
                <button type="button" onClick={() => setUnits((prev) => prev.filter((x) => x.id !== u.id))} className="ms-auto text-charcoal/40 hover:text-red-600" aria-label={t('حذف الوحدة', 'Remove unit')}>
                  <Trash2 size={15} />
                </button>
              )}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {unitFields.map((f) => renderField(f, u.data[f.name], (v) => setUnitField(u.id, f.name, v), u.data, unitsModel, u.id,
                (patch) => Object.entries(patch).forEach(([k, v]) => setUnitField(u.id, k, v))))}
              {kind === 'office_unit' && officeLocationField && renderField(officeLocationField, u.data.office_unit_location,
                (v) => setUnitField(u.id, 'office_unit_location', v), u.data, unitsModel, u.id,
                (patch) => Object.entries(patch).forEach(([k, v]) => setUnitField(u.id, k, v)))}
            </div>
          </div>
        ))}
        {kind === 'project_units' && (
          <button type="button" onClick={() => setUnits((prev) => [...prev, { id: uuid(), data: {} }])}
            className="inline-flex items-center gap-1 text-sm font-semibold text-copper hover:underline">
            <Plus size={14} /> {t('إضافة وحدة أخرى', 'Add another unit')}
          </button>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={saving} className="px-4 py-2 text-sm">{t('إلغاء', 'Cancel')}</Button>
          <Button onClick={() => void save()} disabled={saving} className="px-4 py-2 text-sm">
            {saving && <Loader2 size={15} className="animate-spin" />} {t('حفظ العرض', 'Save offering')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
