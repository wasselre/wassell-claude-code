import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, Save, Loader2, Sparkles, Lock } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import DynamicField from '@/pages/Records/components/DynamicField';
import { preferencesDirty, saveClientPreferences } from '@/lib/clients/preferences';
import type { FieldMeta } from '@/lib/salesProcess/qualificationDraft';
import type { ModelField } from '@/types';

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
  /** Per-field provenance from the qualification draft (controlled mode). Renders a
   *  small badge: AI-filled (green) / AI-changed-needs-review (amber) / rep-edited
   *  (locked). Empty until live capture fills the draft (Phase 4). */
  meta?: Record<string, FieldMeta>;
}

/** Small provenance chip next to a field label. Returns null for saved/untouched. */
function ProvenanceBadge({ meta, isAr }: { meta: FieldMeta | undefined; isAr: boolean }) {
  if (!meta || meta.provenance === 'saved') return null;
  if (meta.provenance === 'rep_edited') {
    return <span className="inline-flex items-center gap-0.5 text-[10px] text-charcoal/50" title={isAr ? 'عدّلته يدويًا' : 'You edited this'}><Lock size={10} /></span>;
  }
  const amber = meta.provenance === 'ai_changed';
  const color = amber ? '#C09B5F' : '#10B981';
  const label = amber ? (isAr ? 'تغيّر — للمراجعة' : 'Changed — review') : (isAr ? 'من المكالمة' : 'From the call');
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold" style={{ color }} title={meta.aiQuote ?? undefined}>
      <Sparkles size={10} /> {label}
    </span>
  );
}

// The preference fields the rep edits inline, in display order. Always shown
// (even when empty) so the rep can fill them in without leaving the Workspace.
// Geography is the single `location` field (the country → region → city → district
// cascade) — there are no separate preferred_cities / preferred_districts fields.
// budget + preferred_bedrooms render as min/max ranges, unit_type/purchase_objective
// as multiselect, preference_notes as a textarea. Slugs missing from the live model
// are skipped. Mirrors the Finder's editable set (unit age + amenities included) so
// the Workspace captures every preference the matching engine can use.
const PREF_SLUGS = ['location', 'preferred_unit_type', 'preferred_max_unit_age', 'preferred_area', 'preferred_bedrooms', 'budget', 'preferred_amenities', 'purchase_objective', 'preference_notes'] as const;

/** Inline-editable client preferences — unit type, budget, location, direction. */
export default function PreferenceSummary({ clientId, onEditFull, draft: draftProp, onFieldChange, meta }: PreferenceSummaryProps) {
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

  // location_items (district + geo-element preferences) and preference_constraints
  // (per-field strictness bands) ride inside other fields (ClientLocationField /
  // the band control) rather than being PREF_SLUGS — the shared helper tracks and
  // persists them alongside the slugs.
  const dirty = preferencesDirty(clientRec.data, draft, PREF_SLUGS);

  const setField = (slug: string, value: unknown) =>
    controlled ? onFieldChange!(slug, value) : setInternalDraft((d) => ({ ...d, [slug]: value }));

  const save = async () => {
    setSaving(true);
    const res = await saveClientPreferences({
      client: clientRec, // freshest copy from the store
      draft,
      slugs: PREF_SLUGS,
      saveRecord,
      expectedVersion: clientRec.version ?? null,
      isAr,
    });
    setSaving(false);
    addToast(res.message, res.tone);
  };

  return (
    <section className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-chocolate">{isAr ? 'تفضيلات العميل' : 'Preferences'}</h2>
        <button type="button" onClick={onEditFull} className="inline-flex items-center gap-1 text-xs font-semibold text-copper hover:underline">
          <SlidersHorizontal size={13} /> {isAr ? 'تعديل التفضيلات الكاملة' : 'Edit Full Preferences'}
        </button>
      </div>
      {/* Two fields per row (each smaller) so the list stays short. Wide fields —
          the location cascade and free-text notes — span the full width. */}
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
        {fields.map((field) => {
          const fullWidth = field.type === 'location' || field.type === 'textarea' || field.name === 'preference_notes';
          return (
            <div key={field.id} className={fullWidth ? 'sm:col-span-2' : ''}>
              <label className="mb-1 flex items-center justify-between gap-2 text-xs font-semibold text-charcoal/60">
                <span>{isAr ? field.label_ar : field.label_en}</span>
                <ProvenanceBadge meta={meta?.[field.name]} isAr={isAr} />
              </label>
              <DynamicField
                field={field}
                value={draft[field.name]}
                onChange={(v) => setField(field.name, v)}
                recordData={draft}
                compact
                modelId={clientsModel.id}
                recordId={clientId}
                onPatch={(patch) => Object.entries(patch).forEach(([k, v]) => setField(k, v))}
              />
            </div>
          );
        })}
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
