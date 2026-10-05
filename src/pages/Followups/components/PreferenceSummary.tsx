import { useEffect, useMemo, useRef, useState } from 'react';
import { SlidersHorizontal, Loader2, Sparkles, Lock, Check, ChevronDown, ChevronUp, Wand2, AlertTriangle, MapPin, ListChecks, Settings2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import DynamicField from '@/pages/Records/components/DynamicField';
import PreferenceProfileBar from '@/components/PreferenceProfileBar';
import { preferencesDirty, saveClientPreferences } from '@/lib/clients/preferences';
import { readPrefsFromText } from '@/lib/clientPrefs/fromText';
import type { ExtractionInput, FieldMeta } from '@/lib/salesProcess/qualificationDraft';
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
  /** Per-field provenance from the qualification draft (controlled mode). An
   *  AI-filled field is outlined and tagged «filled by AI — review» until the rep
   *  edits or accepts it (both stamp rep_edited). */
  meta?: Record<string, FieldMeta>;
  /** Apply the rep's free-text note (read by AI) to the draft — the Workspace
   *  passes the qualification session's `applyRepText`. Absent ⇒ the free-text
   *  box writes the values straight into the panel's own buffer. */
  onApplyRepText?: (extraction: ExtractionInput) => void;
}

// ── The field layout (operator, 2026-10-05) ──────────────────────────────────
// 1. Geographic preferences — the location field (city cascade + places).
// 2. Basic preferences — unit type, bedrooms, budget, purchase goal.
// 3. Advanced (collapsed) — everything else the matcher can use.
// Unit age (preferred_max_unit_age) is HIDDEN: not shown, not part of the
// autosave patch, so a stored value is left untouched. Slugs missing from the
// live clients model are skipped.
const GEO_SLUGS = ['location'] as const;
const BASIC_SLUGS = ['preferred_unit_type', 'preferred_bedrooms', 'budget', 'purchase_objective'] as const;
const ADVANCED_SLUGS = ['preferred_readiness', 'preferred_area', 'preferred_amenities', 'preference_notes'] as const;
const PREF_SLUGS = [...GEO_SLUGS, ...BASIC_SLUGS, ...ADVANCED_SLUGS] as const;

/** Riyadh — the default city when a client has none (operator, 2026-10-05).
 *  The same country / region / city record ids 124 clients already carry. */
const RIYADH_LOCATION = {
  country: ['d15a0003-0000-4000-8000-000000000001'],
  region: ['9c0c7a82-738d-6456-2101-b7226cc84e20'],
  city: ['44254a38-ce40-938f-17b7-55814a44e45c'],
};

const AUTOSAVE_MS = 900;

/** The provenance key for a field: places live in `location_items`, not `location`. */
const metaKeyOf = (slug: string) => (slug === 'location' ? 'location_items' : slug);
const isAiMeta = (m: FieldMeta | undefined) => m?.provenance === 'ai_filled' || m?.provenance === 'ai_changed';

/** Provenance tag next to a field label. Returns null for saved/untouched. */
function ProvenanceBadge({ meta, isAr, onAccept }: { meta: FieldMeta | undefined; isAr: boolean; onAccept: () => void }) {
  if (!meta || meta.provenance === 'saved') return null;
  if (meta.provenance === 'rep_edited') {
    return <span className="inline-flex items-center gap-0.5 text-[10px] text-charcoal/50" title={isAr ? 'عدّلته يدويًا' : 'You edited this'}><Lock size={10} /></span>;
  }
  const amber = meta.provenance === 'ai_changed';
  const color = amber ? '#B7791F' : '#047857';
  const label = amber
    ? (isAr ? 'غيّره الذكاء الاصطناعي — راجعه' : 'Changed by AI — review')
    : (isAr ? 'عبّأه الذكاء الاصطناعي — راجعه' : 'Filled by AI — review');
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-center gap-0.5 text-[10px] font-bold" style={{ color }} title={meta.aiQuote ?? undefined}>
        <Sparkles size={10} /> {label}
      </span>
      <button type="button" onClick={onAccept}
        className="inline-flex items-center gap-0.5 rounded-md border border-current px-1.5 py-px text-[10px] font-bold transition hover:bg-white"
        style={{ color }} title={isAr ? 'القيمة صحيحة' : 'The value is right'}>
        <Check size={10} /> {isAr ? 'صحيح' : 'OK'}
      </button>
    </span>
  );
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 border-b border-sand/40 pb-1.5 text-xs font-bold text-chocolate">
      <span className="text-copper">{icon}</span>{children}
    </div>
  );
}

/** Inline-editable client preferences, saved automatically as the rep types. */
export default function PreferenceSummary({ clientId, onEditFull, draft: draftProp, onFieldChange, meta, onApplyRepText }: PreferenceSummaryProps) {
  const { models, records, language, saveRecord, addToast } = useAppStore();
  const isAr = language === 'ar';
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const clientsModel = models.find((m) => m.name === 'clients');
  const clientRec = clientsModel && clientId
    ? (records[clientsModel.id] ?? []).find((r) => r.id === clientId) ?? null
    : null;

  const allFields = clientsModel ? clientsModel.schema.sections.flatMap((s) => s.fields) : [];
  const fieldsOf = (slugs: readonly string[]): ModelField[] => slugs
    .map((slug) => allFields.find((f) => f.name === slug))
    .filter((f): f is ModelField => !!f);

  // Controlled when the parent owns the draft (Workspace lifts it so the
  // assistant panel reads the same unsaved edits). Otherwise keep an internal
  // buffer with the original seed-once-per-client behavior.
  const controlled = draftProp !== undefined && onFieldChange !== undefined;

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
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const setField = (slug: string, value: unknown) =>
    controlled ? onFieldChange!(slug, value) : setInternalDraft((d) => ({ ...d, [slug]: value }));

  // ── Riyadh by default ──────────────────────────────────────────────────────
  const defaultedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!clientRec || !clientId || defaultedFor.current === clientId) return;
    defaultedFor.current = clientId;
    const loc = draftRef.current.location;
    const obj = loc && typeof loc === 'object' && !Array.isArray(loc) ? (loc as Record<string, unknown>) : {};
    const hasCity = Array.isArray(obj.city) ? obj.city.length > 0 : typeof obj.city === 'string' && !!obj.city;
    if (!hasCity) setField('location', { ...obj, ...RIYADH_LOCATION });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, clientRec]);

  // ── Autosave: every change is saved a moment after the rep stops typing ────
  // The version we write against only moves forward: our own saves bump it
  // (nextVersion), and a newer version arriving over realtime is adopted.
  const versionRef = useRef<number | null>(null);
  useEffect(() => {
    const v = clientRec?.version ?? null;
    if (v !== null && (versionRef.current === null || v > versionRef.current)) versionRef.current = v;
  }, [clientRec?.version]);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const savingRef = useRef(false);
  const [retryTick, setRetryTick] = useState(0);
  const draftKey = JSON.stringify([...PREF_SLUGS, 'location_items', 'preference_constraints'].map((s) => draft[s] ?? null));
  const dirty = clientRec ? preferencesDirty(clientRec.data, draft, PREF_SLUGS) : false;

  useEffect(() => {
    if (!clientRec || !dirty) return;
    const t = setTimeout(async () => {
      if (savingRef.current) { setRetryTick((n) => n + 1); return; } // one in flight — try again after it
      savingRef.current = true;
      setSaveState('saving');
      // The freshest copy from the store (an echo may have landed since render).
      const st = useAppStore.getState();
      const cm = st.models.find((m) => m.name === 'clients');
      const fresh = cm ? (st.records[cm.id] ?? []).find((r) => r.id === clientRec.id) ?? clientRec : clientRec;
      const res = await saveClientPreferences({
        client: fresh,
        draft: draftRef.current,
        slugs: PREF_SLUGS,
        saveRecord,
        expectedVersion: versionRef.current ?? fresh.version ?? null,
        isAr,
      });
      savingRef.current = false;
      if (res.ok) {
        if (res.nextVersion != null) versionRef.current = res.nextVersion;
        setSaveState('saved');
      } else {
        // A conflict is surfaced loudly and autosave pauses until the next edit
        // (retrying a stale version would only conflict again).
        setSaveState('error');
        addToast(res.message, res.tone);
      }
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, dirty, retryTick]);

  // ── Free text → fields ─────────────────────────────────────────────────────
  const [freeText, setFreeText] = useState('');
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [lastRead, setLastRead] = useState<{ fields: number; places: string[]; notPlaced: string[] } | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const fillFromText = async () => {
    const text = freeText.trim();
    if (!text || reading) return;
    setReading(true);
    setReadError(null);
    try {
      const r = await readPrefsFromText(text, clientId);
      const suggestions: ExtractionInput['suggestions'] = { ...r.suggestions };
      if (r.location_items.length) suggestions.location_items = { value: r.location_items, quote: text, confidence: 90 };
      if (onApplyRepText) {
        onApplyRepText({ suggestions });
      } else {
        // No qualification session: write the values straight into the buffer.
        setInternalDraft((d) => {
          const next = { ...d };
          for (const [slug, s] of Object.entries(suggestions)) {
            if (slug === 'location_items') {
              const cur = Array.isArray(d.location_items) ? d.location_items : [];
              next.location_items = [...cur, ...(s.value as unknown[])];
            } else next[slug] = s.value;
          }
          return next;
        });
      }
      const n = Object.keys(r.suggestions).length + (r.location_items.length ? 1 : 0);
      setLastRead({ fields: n, places: r.understood_places, notPlaced: r.not_placed ?? [] });
      // Advanced fields the note filled must be visible to be reviewed.
      if (ADVANCED_SLUGS.some((s) => s in r.suggestions)) setAdvancedOpen(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[PreferenceSummary] free-text fill failed:', msg);
      setReadError(msg);
    } finally {
      setReading(false);
    }
  };

  const aiCount = useMemo(
    () => PREF_SLUGS.filter((s) => isAiMeta(meta?.[metaKeyOf(s)])).length,
    [meta],
  );

  if (!clientsModel || !clientId || !clientRec) return null;

  const renderField = (field: ModelField) => {
    const fullWidth = field.type === 'location' || field.type === 'textarea' || field.name === 'preference_notes';
    const m = meta?.[metaKeyOf(field.name)];
    const ai = isAiMeta(m);
    const ring = ai ? (m!.provenance === 'ai_changed' ? 'ring-2 ring-amber-300 bg-amber-50/50' : 'ring-2 ring-emerald-300 bg-emerald-50/50') : '';
    // «OK» = the rep accepts the AI value: re-set it as their own (rep_edited).
    const accept = () => {
      const key = metaKeyOf(field.name);
      setField(key, draftRef.current[key]);
    };
    return (
      <div key={field.id} className={`${fullWidth ? 'sm:col-span-2' : ''} rounded-lg ${ai ? `p-1.5 ${ring}` : ''}`}>
        <label className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-charcoal/60">
          <span>{isAr ? field.label_ar : field.label_en}</span>
          <ProvenanceBadge meta={m} isAr={isAr} onAccept={accept} />
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
  };

  const geoFields = fieldsOf(GEO_SLUGS);
  const basicFields = fieldsOf(BASIC_SLUGS);
  const advancedFields = fieldsOf(ADVANCED_SLUGS);
  const advancedAi = ADVANCED_SLUGS.some((s) => isAiMeta(meta?.[s]));

  return (
    <section className="card p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold text-chocolate">{L('تفضيلات العميل', 'Preferences')}</h2>
        <div className="flex items-center gap-3">
          <span className="text-[11px] font-semibold" aria-live="polite">
            {saveState === 'saving' && <span className="inline-flex items-center gap-1 text-charcoal/50"><Loader2 size={11} className="animate-spin" />{L('جارٍ الحفظ…', 'Saving…')}</span>}
            {saveState === 'saved' && !dirty && <span className="inline-flex items-center gap-1 text-emerald-700"><Check size={11} />{L('حُفظ تلقائياً', 'Saved automatically')}</span>}
            {saveState === 'error' && <span className="inline-flex items-center gap-1 text-red-600"><AlertTriangle size={11} />{L('لم يُحفظ', 'Not saved')}</span>}
          </span>
          <button type="button" onClick={onEditFull} className="inline-flex items-center gap-1 text-xs font-semibold text-copper hover:underline">
            <SlidersHorizontal size={13} /> {L('تعديل التفضيلات الكاملة', 'Edit Full Preferences')}
          </button>
        </div>
      </div>
      <PreferenceProfileBar
        client={clientRec}
        draft={draft}
        clientsModel={clientsModel}
        expectedVersion={clientRec.version ?? null}
        isAr={isAr}
        onApplied={(flat) => {
          if (!flat) return;
          if (controlled) Object.entries(flat).forEach(([k, v]) => onFieldChange!(k, v));
          else setInternalDraft((d) => ({ ...d, ...flat }));
        }}
      />

      {/* Free text → fields. The rep can type what the client said OR fill the
          fields below; whatever the AI fills is outlined for review. */}
      <div className="mb-4 rounded-xl border border-copper/30 bg-copper/5 p-3">
        <label className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-chocolate">
          <Wand2 size={13} className="text-copper" />
          {L('اكتب طلب العميل بكلماتك — نعبّئ الحقول لك', "Type the client's request in your words — we fill the fields")}
        </label>
        <div className="flex items-start gap-2">
          <textarea
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void fillFromText(); } }}
            rows={2}
            maxLength={2000}
            placeholder={L('مثال: يبي فيلا ٥ غرف شمال الرياض قريب من مترو، الميزانية بحدود ٣ مليون، للسكن، جاهزة', 'e.g. wants a 5-bedroom villa in north Riyadh near a metro, budget around 3M, to live in, ready')}
            className="min-w-0 flex-1 resize-none rounded-lg border border-sand bg-white px-3 py-2 text-sm text-charcoal placeholder:text-charcoal/40 focus:border-copper focus:outline-none focus:ring-1 focus:ring-copper"
          />
          <button type="button" onClick={() => void fillFromText()} disabled={reading || !freeText.trim()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-copper px-3 py-2 text-xs font-bold text-white transition hover:bg-terracotta disabled:opacity-50">
            {reading ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
            {L('عبّئ الحقول', 'Fill the fields')}
          </button>
        </div>
        {reading && <p className="mt-1.5 text-[11px] text-charcoal/55">{L('نقرأ النص ونحدد الأماكن على الخريطة — قد يستغرق حتى ٢٠ ثانية…', 'Reading the text and placing it on the map — this can take up to 20 seconds…')}</p>}
        {readError && <p className="mt-1.5 flex items-center gap-1 text-[11px] text-red-600"><AlertTriangle size={11} />{L('تعذّرت قراءة النص: ', 'Could not read the text: ')}{readError}</p>}
        {lastRead && !reading && !readError && (
          <p className="mt-1.5 text-[11px] text-charcoal/60">
            {lastRead.fields === 0
              ? L('لم نجد في النص تفضيلات نعبّئها.', 'Nothing in the text maps to a field.')
              : L(`عُبّئ ${lastRead.fields} حقل — الحقول المحددة بالأخضر للمراجعة.`, `${lastRead.fields} field(s) filled — the outlined fields are for you to review.`)}
            {lastRead.places.length > 0 && ` ${L('الأماكن:', 'Places:')} ${lastRead.places.join('، ')}`}
          </p>
        )}
        {lastRead && !reading && !readError && lastRead.notPlaced.length > 0 && (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-700">
            <AlertTriangle size={11} />
            {L(`لم نستطع تحديده على الخريطة: ${lastRead.notPlaced.join('، ')} — أضفه من «إضافة عنصر» أو الخريطة.`, `Couldn't place on the map: ${lastRead.notPlaced.join(', ')} — add it with «Add element» or the map.`)}
          </p>
        )}
        {aiCount > 0 && (
          <p className="mt-1 text-[11px] font-semibold text-emerald-700">
            <Sparkles size={10} className="inline" /> {L(`${aiCount} حقول عبّأها الذكاء الاصطناعي بانتظار مراجعتك`, `${aiCount} AI-filled field(s) waiting for your review`)}
          </p>
        )}
      </div>

      {/* 1. Geographic preferences */}
      {geoFields.length > 0 && (
        <div className="mb-4">
          <SectionTitle icon={<MapPin size={13} />}>{L('التفضيلات الجغرافية', 'Geographic preferences')}</SectionTitle>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">{geoFields.map(renderField)}</div>
        </div>
      )}

      {/* 2. Basic preferences */}
      {basicFields.length > 0 && (
        <div className="mb-4">
          <SectionTitle icon={<ListChecks size={13} />}>{L('التفضيلات الأساسية', 'Basic preferences')}</SectionTitle>
          <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">{basicFields.map(renderField)}</div>
        </div>
      )}

      {/* 3. Advanced — collapsed */}
      {advancedFields.length > 0 && (
        <div>
          <button type="button" onClick={() => setAdvancedOpen((v) => !v)}
            className="flex w-full items-center justify-between rounded-lg border border-sand/60 bg-cream-light px-3 py-2 text-xs font-bold text-chocolate transition hover:bg-cream">
            <span className="inline-flex items-center gap-1.5">
              <Settings2 size={13} className="text-copper" />{L('متقدم', 'Advanced')}
              {advancedAi && !advancedOpen && <span className="text-[10px] font-semibold text-emerald-700"><Sparkles size={10} className="inline" /> {L('فيه حقول للمراجعة', 'has fields to review')}</span>}
            </span>
            {advancedOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          {advancedOpen && (
            <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">{advancedFields.map(renderField)}</div>
          )}
        </div>
      )}
    </section>
  );
}
