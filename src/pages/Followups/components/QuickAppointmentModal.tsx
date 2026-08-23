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
import { useAppStore } from '@/stores/appStore';
import type { AppRecord, ModelField } from '@/types';

const APPT_FIELDS = ['project_id', 'appointment_date'] as const;

interface QuickAppointmentModalProps {
  clientId: string | null;
  phone: string | null;
  salesRep: unknown;
  followupId: string;
  onClose: () => void;
  onSaved: (appointmentId: string) => void;
}

export default function QuickAppointmentModal({ clientId, phone, salesRep, followupId, onClose, onSaved }: QuickAppointmentModalProps) {
  const { models, saveRecord, addToast, language } = useAppStore();
  const isAr = language === 'ar';
  const apptModel = models.find((m) => m.name === 'appointments');
  const recordId = useMemo(() => uuid(), []);

  const [data, setData] = useState<Record<string, unknown>>(() => {
    const p: Record<string, unknown> = {
      appointment_date: new Date().toISOString(),
      sales_rep: salesRep,
      source_followup_id: followupId,
    };
    if (clientId) p.client_id = clientId;
    if (phone) p.phone_number = phone;
    return p;
  });
  const [saving, setSaving] = useState(false);

  const fields: ModelField[] = useMemo(() => {
    if (!apptModel) return [];
    const all = apptModel.schema.sections.flatMap((s) => s.fields);
    return APPT_FIELDS.map((slug) => all.find((f) => f.name === slug)).filter((f): f is ModelField => !!f);
  }, [apptModel]);

  if (!apptModel) return null;

  const setField = (slug: string, value: unknown) => setData((d) => ({ ...d, [slug]: value }));

  const save = async () => {
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
    <Modal open onClose={onClose} title={isAr ? 'حجز موعد' : 'Book an appointment'} maxWidth="max-w-lg">
      <div className="space-y-4">
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
  );
}
