// Minimal "Record a Visit" form — only the three fields a rep needs when a client
// reports they visited: date, project, and result (the visit rating). Creates a
// `visits` record via saveRecord (which fires the Visit → After-Visit workflow the
// same as the full form), linked back to this follow-up via source_followup_id.

import { useMemo, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { MapPin, Loader2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import DynamicField from '@/pages/Records/components/DynamicField';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord, ModelField } from '@/types';

// The three fields a rep needs: project visited · date · result (the
// `visit_result` dropdown — Interested / Considering / Not interested / Reserved).
const VISIT_FIELDS = ['project_id', 'scheduled_datetime', 'visit_result'] as const;

interface QuickVisitModalProps {
  clientId: string | null;
  clientName: string | null;
  phone: string | null;
  salesRep: unknown;
  /** Source follow-up to link back to. Null when recorded outside a follow-up
      (e.g. straight from a chat) — no `source_followup_id` is then stamped. */
  followupId: string | null;
  onClose: () => void;
  onSaved?: (visitId: string) => void;
}

export default function QuickVisitModal({ clientId, clientName, phone, salesRep, followupId, onClose, onSaved }: QuickVisitModalProps) {
  const { models, saveRecord, addToast, language, currentUserId } = useAppStore();
  const isAr = language === 'ar';
  const visitsModel = models.find((m) => m.name === 'visits');
  const recordId = useMemo(() => uuid(), []);

  const [data, setData] = useState<Record<string, unknown>>(() => {
    const p: Record<string, unknown> = {
      scheduled_datetime: new Date().toISOString(),
      sales_representative: salesRep ?? currentUserId ?? undefined,
    };
    if (followupId) p.source_followup_id = followupId;
    if (clientId) p.client_id = clientId;
    if (clientName) p.name = clientName;
    if (phone) p.phone = phone;
    return p;
  });
  const [saving, setSaving] = useState(false);

  const fields: ModelField[] = useMemo(() => {
    if (!visitsModel) return [];
    const all = visitsModel.schema.sections.flatMap((s) => s.fields);
    return VISIT_FIELDS.map((slug) => all.find((f) => f.name === slug)).filter((f): f is ModelField => !!f);
  }, [visitsModel]);

  if (!visitsModel) return null;

  const setField = (slug: string, value: unknown) => setData((d) => ({ ...d, [slug]: value }));

  const save = async () => {
    setSaving(true);
    const now = new Date().toISOString();
    const rec: AppRecord = { id: recordId, model_id: visitsModel.id, data, created_at: now, updated_at: now };
    const res = await saveRecord(rec, { expectedVersion: null });
    setSaving(false);
    if (res.status === 'conflict') {
      addToast(isAr ? 'تعذّر الحفظ — أعد المحاولة' : 'Could not save — try again', 'error');
      return;
    }
    addToast(isAr ? 'تم تسجيل الزيارة' : 'Visit recorded', 'success');
    onSaved?.(recordId);
    onClose();
  };

  return (
    <Modal open onClose={onClose} title={isAr ? 'تسجيل زيارة' : 'Record a visit'} maxWidth="max-w-lg">
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
              modelId={visitsModel.id}
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
            {saving ? <Loader2 size={15} className="animate-spin" /> : <MapPin size={15} />}
            {isAr ? 'حفظ الزيارة' : 'Save visit'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
