// Minimal "Book an appointment" form — only the project and the date/time. The
// client, phone, sales rep and source follow-up are prefilled (hidden). Creates an
// `appointments` record via saveRecord (firing the appointment workflows the same
// as the full form), and reports the new id so the workspace can link it to the
// follow-up.

import { useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { CalendarPlus, Loader2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import DynamicField from '@/pages/Records/components/DynamicField';
import ClientSearch, { type PickedToolClient } from '@/pages/Sales/components/ClientSearch';
import { useProjectUnitsPicker, ProjectUnitsSummaryButton } from '@/pages/Records/components/ProjectUnitsPicker';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord, ModelField } from '@/types';

// Project + units are one control (ProjectUnitsSummaryButton → the chat's
// Projects & Units browser); only the date is a plain field.
const APPT_FIELDS = ['appointment_date'] as const;

interface QuickAppointmentModalProps {
  clientId: string | null;
  phone: string | null;
  salesRep: unknown;
  /** Source follow-up to link back to. Null when booked outside a follow-up
      (e.g. straight from a chat) — no `source_followup_id` is then stamped. */
  followupId: string | null;
  onClose: () => void;
  onSaved: (appointmentId: string) => void;
  /** Opened from the Sales Workspace Tools menu, where no client is in context:
   *  show a client search first and require a client before saving. */
  pickClient?: boolean;
}

export default function QuickAppointmentModal({ clientId, phone, salesRep, followupId, onClose, onSaved, pickClient = false }: QuickAppointmentModalProps) {
  const { models, saveRecord, addToast, language } = useAppStore();
  const isAr = language === 'ar';
  const apptModel = models.find((m) => m.name === 'appointments');
  const recordId = useMemo(() => uuid(), []);

  const [data, setData] = useState<Record<string, unknown>>(() => {
    const p: Record<string, unknown> = {
      appointment_date: new Date().toISOString(),
      sales_rep: salesRep,
    };
    if (followupId) p.source_followup_id = followupId;
    if (clientId) p.client_id = clientId;
    if (phone) p.phone_number = phone;
    return p;
  });
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<PickedToolClient | null>(null);
  // Tools flow: the chosen client fills the same hidden fields the chat flow
  // prefills (client link, name, phone).
  const pickClientRecord = (c: PickedToolClient) => {
    setPicked(c);
    setData((d) => ({ ...d, client_id: c.id, client_name: c.name || undefined, phone_number: c.phone ?? undefined }));
  };

  const fields: ModelField[] = useMemo(() => {
    if (!apptModel) return [];
    const all = apptModel.schema.sections.flatMap((s) => s.fields);
    return APPT_FIELDS.map((slug) => all.find((f) => f.name === slug)).filter((f): f is ModelField => !!f);
  }, [apptModel]);

  // Project + units are chosen in the chat's Projects & Units browser (pick mode)
  // instead of the plain lookup + unit-card fields.
  const projectField = useMemo(
    () => apptModel?.schema.sections.flatMap((s) => s.fields).find((f) => f.name === 'project_id'),
    [apptModel],
  );
  const picker = useProjectUnitsPicker({
    projectLookupModelId: projectField?.lookup_model_id,
    projectValue: data.project_id,
    unitIds: Array.isArray(data.units) ? (data.units as string[]) : [],
    withUnits: true,
    onChange: ({ projectValue, unitIds }) => setData((d) => ({ ...d, project_id: projectValue, units: unitIds })),
  });

  if (!apptModel) return null;

  const setField = (slug: string, value: unknown) => setData((d) => ({ ...d, [slug]: value }));

  const save = async () => {
    if (pickClient && !picked) {
      addToast(isAr ? 'اختر العميل أولاً' : 'Pick the client first', 'error');
      return;
    }
    if (!data.appointment_date) {
      addToast(isAr ? 'اختر تاريخ ووقت الموعد' : 'Pick the appointment date and time', 'error');
      return;
    }
    setSaving(true);
    const now = new Date().toISOString();
    const rec: AppRecord = { id: recordId, model_id: apptModel.id, data, created_at: now, updated_at: now };
    const res = await saveRecord(rec, { expectedVersion: null });
    setSaving(false);
    if (res.status === 'conflict') {
      addToast(isAr ? 'تعذّر الحفظ — أعد المحاولة' : 'Could not save — try again', 'error');
      return;
    }
    onSaved(recordId);
  };

  return (
    <>
    {!picker.open && (
    <Modal open onClose={onClose} title={isAr ? 'حجز موعد' : 'Book an appointment'} maxWidth="max-w-lg">
      <div className="space-y-4">
        {pickClient && (
          <div>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">{isAr ? 'العميل' : 'Client'}</label>
            {picked ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-sand bg-cream-light px-3 py-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-semibold text-charcoal">{picked.name || (isAr ? 'عميل بلا اسم' : 'Unnamed client')}</span>
                  {picked.phone && <span className="shrink-0 text-xs text-charcoal/50" dir="ltr">{picked.phone}</span>}
                </span>
                <button type="button" onClick={() => setPicked(null)} className="shrink-0 text-xs font-semibold text-copper hover:underline">
                  {isAr ? 'تغيير' : 'Change'}
                </button>
              </div>
            ) : (
              <ClientSearch onPick={pickClientRecord} />
            )}
          </div>
        )}
        <div>
          <label className="mb-1 block text-xs font-semibold text-charcoal/60">{isAr ? 'المشروع والوحدات' : 'Project & units'}</label>
          <ProjectUnitsSummaryButton picker={picker} />
        </div>
        {fields.map((field) => (
          <div key={field.id}>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">
              {isAr ? field.label_ar : field.label_en}
            </label>
            <DynamicField
              field={field}
              value={data[field.name]}
              onChange={(v) => setField(field.name, v)}
              recordData={data}
              compact
              modelId={apptModel.id}
              recordId={recordId}
              onPatch={(patch) => Object.entries(patch).forEach(([k, v]) => setField(k, v))}
            />
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-semibold text-charcoal/70 hover:bg-cream">
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-4 py-2 text-sm font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <CalendarPlus size={15} />}
            {isAr ? 'حفظ الموعد' : 'Save appointment'}
          </button>
        </div>
      </div>
    </Modal>
    )}
    {picker.browser}
    </>
  );
}
