import { useRef, useState } from 'react';
import { Save, Loader2, Lock } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useRecordDraft } from '@/hooks/useRecordDraft';
import DynamicField from '@/pages/Records/components/DynamicField';
import DynamicCell from '@/pages/Records/components/DynamicCell';
import { preferencesDirty, saveClientPreferences } from '@/lib/clients/preferences';
import type { AppModel, AppRecord, ModelField } from '@/types';
import { PREFERENCE_EDIT_SLUGS, isDerivedReadOnly, allFields } from '../../lib/clientView';

interface PreferencesTabProps {
  client: AppRecord;
  clientsModel: AppModel;
  isAr: boolean;
  canEdit: boolean;
}

const FULL_WIDTH_TYPES = new Set(['textarea', 'notes', 'location', 'lookup', 'unit_picker', 'multiselect']);

/**
 * Editable client preferences. Reuses the generic DynamicField (so lookups use
 * the correct, schema-bound pickers — preferred_projects → all_projects and
 * preferred_market_listings → market_listings can never cross-pollute) and the
 * versioned saveRecord path (optimistic concurrency, pending-sync queue).
 *
 * Derived/trigger-maintained fields are NEVER rendered here — guarded twice:
 * the slug list excludes them, and `isDerivedReadOnly` is asserted defensively.
 */
export default function PreferencesTab({ client, clientsModel, isAr, canEdit }: PreferencesTabProps) {
  const saveRecord = useAppStore((s) => s.saveRecord);
  const addToast = useAppStore((s) => s.addToast);
  const records = useAppStore((s) => s.records);

  const { draft, patchDraft } = useRecordDraft(client);
  const [saving, setSaving] = useState(false);

  // Version snapshot for optimistic concurrency (mirrors RecordFormPage / PreferenceSummary).
  const versionRef = useRef<{ id: string; version: number | null } | null>(null);
  if (versionRef.current?.id !== client.id) {
    versionRef.current = { id: client.id, version: client.version ?? null };
  }

  const fields: ModelField[] = PREFERENCE_EDIT_SLUGS
    .filter((slug) => !isDerivedReadOnly(slug)) // defensive: never edit a derived field
    .map((slug) => allFields(clientsModel).find((f) => f.name === slug))
    .filter((f): f is ModelField => !!f);

  // The detailed location preferences (clients.data.location_items) and the
  // per-field strictness bands (preference_constraints) live INSIDE other fields
  // (ClientLocationField / the band control, both rendered by DynamicField and
  // written via the onPatch sibling-writer below). The shared helper carries them
  // alongside the field patch on the same versioned save.
  const slugs = fields.map((f) => f.name);
  const dirty = preferencesDirty(client.data, draft, slugs);

  const save = async () => {
    setSaving(true);
    const res = await saveClientPreferences({
      client,
      draft,
      slugs,
      saveRecord,
      expectedVersion: versionRef.current?.version ?? null,
      isAr,
    });
    setSaving(false);
    // Adopt the bumped version so a second edit in the same mount doesn't self-conflict.
    if (res.ok && versionRef.current) versionRef.current = { id: client.id, version: res.nextVersion };
    addToast(res.message, res.tone);
  };

  if (fields.length === 0) {
    return <p className="card p-6 text-sm text-charcoal/50">{isAr ? 'لا توجد حقول تفضيلات في النموذج.' : 'No preference fields on this model.'}</p>;
  }

  return (
    <section className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-bold text-chocolate">{isAr ? 'تفضيلات العميل' : 'Client preferences'}</h3>
        {!canEdit && (
          <span className="inline-flex items-center gap-1 text-xs font-semibold text-charcoal/50">
            <Lock size={13} /> {isAr ? 'عرض فقط' : 'Read-only'}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map((field) => (
          <div key={field.id} className={FULL_WIDTH_TYPES.has(field.type) ? 'sm:col-span-2' : ''}>
            <label className="mb-1 block text-xs font-semibold text-charcoal/60">
              {isAr ? field.label_ar : field.label_en}
            </label>
            {canEdit ? (
              <DynamicField
                field={field}
                value={draft[field.name]}
                onChange={(v) => patchDraft({ [field.name]: v })}
                recordData={draft}
                modelId={clientsModel.id}
                recordId={client.id}
                onPatch={patchDraft}
              />
            ) : (
              <div className="form-input min-h-[2.5rem] bg-cream/40">
                <DynamicCell field={field} value={client.data[field.name]} allRecords={records} recordData={client.data} recordId={client.id} />
              </div>
            )}
          </div>
        ))}
      </div>

      {canEdit && dirty && (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-4 py-2 text-sm font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
            {isAr ? 'حفظ التفضيلات' : 'Save preferences'}
          </button>
        </div>
      )}
    </section>
  );
}
