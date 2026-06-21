import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, Save, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import DynamicField from '@/pages/Records/components/DynamicField';
import type { AppRecord, ModelField } from '@/types';

interface PreferenceSummaryProps {
  clientId: string | null;
  /** Opens the full client record in a modal (which has an "open full page" button). */
  onEditFull: () => void;
  /**
   * Controlled mode: when BOTH `draft` and `onFieldChange` are supplied, the
   * preference edit buffer is owned by the parent (the Follow-up Workspace lifts
   * it so the Sales Assistant side panel can read the same unsaved draft). When
   * omitted, the component keeps its own internal buffer (standalone behavior).
   */
  draft?: Record<string, unknown>;
  onFieldChange?: (slug: string, value: unknown) => void;
}

// The five preference fields the rep edits inline, in display order. Always
// shown (even when empty) so the rep can fill them in without leaving the
// Workspace — budget renders as the new dropdown range, the rest as pickers.
const PREF_SLUGS = ['preferred_unit_type', 'budget', 'preferred_city', 'preferred_direction', 'preferred_neighborhoods'] as const;

/** Inline-editable client preferences — unit type, budget, city, direction, district. */
export default function PreferenceSummary({ clientId, onEditFull, draft: draftProp, onFieldChange }: PreferenceSummaryProps) {
  const { models, records, language, saveRecord, addToast } = useAppStore();
  const isAr = language === 'ar';

  const clientsModel = models.find((m) => m.name === 'clients');
  const clientRec = clientsModel && clientId
    ? (records[clientsModel.id] ?? []).find((r) => r.id === clientId) ?? null
    : null;

  const allFields = clientsModel ? clientsModel.schema.sections.flatMap((s) => s.fields) : [];
  const fields: ModelField[] = PREF_SLUGS
    .map((slug) => allFields.find((f) => f.name === slug))
    .filter((f): f is ModelField => !!f);

  // Controlled when the parent owns the draft (Workspace lifts it so the
  // assistant panel reads the same unsaved edits). Otherwise keep an internal
  // buffer with the original seed-once-per-client behavior.
  const controlled = draftProp !== undefined && onFieldChange !== undefined;

  // Internal edit buffer (uncontrolled mode). Seeded from the client record on
  // mount, when the viewed client changes, and when the record first loads (null
  // → present). NOT re-seeded on later same-client updates, so in-progress edits
  // survive a realtime echo; a stale base is caught at save time via expectedVersion.
  const [internalDraft, setInternalDraft] = useState<Record<string, unknown>>(() => ({ ...(clientRec?.data ?? {}) }));
  const seeded = useRef<string | null>(null);
  useEffect(() => {
    if (controlled) return; // parent owns seeding
    if (clientRec && seeded.current !== clientId) {
      seeded.current = clientId;
      setInternalDraft({ ...clientRec.data });
    }
  }, [clientId, clientRec, controlled]);

  const draft = controlled ? draftProp! : internalDraft;

  const [saving, setSaving] = useState(false);

  if (!clientsModel || !clientId || !clientRec) return null;

  const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const dirty = PREF_SLUGS.some((slug) => !eq(draft[slug], clientRec.data[slug]));

  const setField = (slug: string, value: unknown) =>
    controlled ? onFieldChange!(slug, value) : setInternalDraft((d) => ({ ...d, [slug]: value }));

  const save = async () => {
    const base = clientRec; // freshest copy from the store
    const patch: Record<string, unknown> = {};
    PREF_SLUGS.forEach((slug) => { patch[slug] = draft[slug]; });
    setSaving(true);
    const next: AppRecord = { ...base, data: { ...base.data, ...patch }, updated_at: new Date().toISOString() };
    const res = await saveRecord(next, { expectedVersion: base.version ?? null });
    setSaving(false);
    if (res.status === 'conflict') {
      addToast(isAr ? 'تم تعديل بيانات العميل في مكان آخر — أعد التحميل.' : 'Client was edited elsewhere — reload before saving.', 'error');
      return;
    }
    addToast(isAr ? 'تم حفظ التفضيلات' : 'Preferences saved', 'success');
  };

  return (
    <section className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-chocolate">{isAr ? 'تفضيلات العميل' : 'Preferences'}</h2>
        <button type="button" onClick={onEditFull} className="inline-flex items-center gap-1 text-xs font-semibold text-copper hover:underline">
          <SlidersHorizontal size={13} /> {isAr ? 'تعديل التفضيلات الكاملة' : 'Edit Full Preferences'}
        </button>
      </div>
      <div className="space-y-3">
        {fields.map((field) => (
          <div key={field.id}>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">
              {isAr ? field.label_ar : field.label_en}
            </label>
            <DynamicField
              field={field}
              value={draft[field.name]}
              onChange={(v) => setField(field.name, v)}
              recordData={draft}
              compact
              modelId={clientsModel.id}
              recordId={clientId}
            />
          </div>
        ))}
      </div>
      {dirty && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-3 py-1.5 text-xs font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            {isAr ? 'حفظ التفضيلات' : 'Save preferences'}
          </button>
        </div>
      )}
    </section>
  );
}
