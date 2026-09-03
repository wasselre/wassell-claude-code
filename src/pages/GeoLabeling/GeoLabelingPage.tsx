import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { Loader2, MapPin, ShieldCheck, Download, Eye, EyeOff } from 'lucide-react';
import FieldControl from './components/FieldControl';
import AdjudicationPanel from './components/AdjudicationPanel';
import {
  listSubjects, submitLabel, exportGold,
  type ListSubjectsResult, type EnrichedSubject, type LabelRole,
} from './lib/client';

/**
 * Geography Understanding — the gold-set LABELING INSTRUMENT workspace.
 *
 * Role-aware, blind-before-adjudication. The server resolves the caller's role on
 * the batch and serves only the subjects + fields that role owns, with the
 * conversation context already PII-redacted for that role:
 *   meaning       → LocationMention (Evidence/Relation/Checkpoint) fields, text-first.
 *   geo_operator  → Anchor resolution/geometry truth, coordinates/pins pseudonymized.
 *   adjudicator   → κ + confusion + surviving disagreements → the canonical answer.
 *
 * Every field renders from its server-served ontology FieldDescriptor — exact enum
 * values + the unknown / insufficient_context / must_confirm escapes — so the form
 * can never drift from the schema. Bilingual + RTL, Wassel design.
 */
const ROLE_LABEL: Record<LabelRole, { ar: string; en: string }> = {
  meaning: { ar: 'مُقيّم المعنى', en: 'Meaning annotator' },
  geo_operator: { ar: 'مُشغّل جغرافي', en: 'Geo operator' },
  adjudicator: { ar: 'مُحكّم', en: 'Adjudicator' },
};

export default function GeoLabelingPage() {
  const language = useAppStore((s) => s.language);
  const addToast = useAppStore((s) => s.addToast);
  const isAr = language === 'ar';

  const [params, setParams] = useSearchParams();
  const [batchId, setBatchId] = useState(params.get('batch') ?? '');
  const [data, setData] = useState<ListSubjectsResult | null>(null);
  const [loading, setLoading] = useState(false);

  const toast = useCallback((msg: string, kind: 'success' | 'error') => {
    addToast(msg, kind === 'success' ? 'success' : 'error');
  }, [addToast]);

  const load = useCallback(async (id: string) => {
    if (!id.trim()) return;
    setLoading(true);
    try {
      const res = await listSubjects(id.trim());
      setData(res);
      setParams({ batch: id.trim() }, { replace: true });
    } catch (e) {
      setData(null);
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setLoading(false); }
  }, [setParams, toast]);

  const doExport = async () => {
    try {
      const out = await exportGold(false);
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `geo-pref-gold-export-${Date.now()}.json`;
      a.click(); URL.revokeObjectURL(url);
      toast(isAr ? 'تم تصدير الذهبي (DEV فقط)' : 'gold exported (DEV only)', 'success');
    } catch (e) { toast(e instanceof Error ? e.message : String(e), 'error'); }
  };

  return (
    <div className="mx-auto max-w-4xl p-4" dir={isAr ? 'rtl' : 'ltr'}>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MapPin className="text-copper" size={22} />
          <div>
            <h1 className="text-lg font-bold text-charcoal">
              {isAr ? 'أداة تسمية الفهم الجغرافي' : 'Geography Understanding — labeling'}
            </h1>
            <p className="text-[11px] text-charcoal/50">
              {isAr ? 'مجموعة ذهبية — تسمية عمياء ثم تحكيم' : 'gold set — blind labeling then adjudication'}
            </p>
          </div>
        </div>
        <Button variant="secondary" className="!py-1.5 !text-xs" onClick={doExport}>
          <Download size={14} /> {isAr ? 'تصدير الذهبي' : 'Export gold'}
        </Button>
      </header>

      {/* Batch loader */}
      <div className="card mb-4 flex flex-wrap items-center gap-2 p-3">
        <input
          value={batchId}
          onChange={(e) => setBatchId(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(batchId); }}
          placeholder={isAr ? 'معرّف الدفعة (batch id)…' : 'batch id…'}
          className="min-w-[16rem] flex-1 rounded-lg border border-sand/50 bg-cream/30 px-3 py-1.5 text-sm text-charcoal focus:border-copper focus:outline-none"
        />
        <Button className="!py-1.5 !text-sm" onClick={() => load(batchId)} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" size={15} /> : (isAr ? 'تحميل' : 'Load')}
        </Button>
      </div>

      {data && (
        <>
          {/* Batch + role banner */}
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-sand/40 bg-white p-3">
            <span className="text-sm font-bold text-charcoal">{data.batch.label}</span>
            <span className="rounded-full bg-charcoal/5 px-2 py-0.5 text-[11px] font-semibold text-charcoal/60">{data.batch.split}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-copper/10 px-2 py-0.5 text-[11px] font-bold text-copper">
              <ShieldCheck size={12} /> {isAr ? ROLE_LABEL[data.role].ar : ROLE_LABEL[data.role].en}
            </span>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${data.batch.adjudication_open ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
              {data.batch.adjudication_open ? <Eye size={12} /> : <EyeOff size={12} />}
              {data.batch.adjudication_open ? (isAr ? 'التحكيم مفتوح' : 'adjudication open') : (isAr ? 'جولة عمياء' : 'blind round')}
            </span>
            {data.batch.frozen && (
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-bold text-red-700">{isAr ? 'مُجمّد' : 'frozen'}</span>
            )}
          </div>

          {data.role === 'adjudicator'
            ? <AdjudicationPanel batchId={data.batch.id} subjects={data.subjects} isAr={isAr} onToast={toast} />
            : <SubjectList data={data} isAr={isAr} onToast={toast} />}
        </>
      )}

      {!data && !loading && (
        <div className="rounded-xl border border-dashed border-sand/50 bg-cream/20 px-4 py-10 text-center text-sm text-charcoal/40">
          {isAr ? 'أدخل معرّف دفعة للبدء.' : 'Enter a batch id to begin.'}
        </div>
      )}
    </div>
  );
}

/** The blind-labeling surface for meaning / geo_operator roles. */
function SubjectList({
  data, isAr, onToast,
}: {
  data: ListSubjectsResult;
  isAr: boolean;
  onToast: (msg: string, kind: 'success' | 'error') => void;
}) {
  return (
    <div className="space-y-4">
      {data.subjects.length === 0 && (
        <p className="rounded-xl border border-dashed border-sand/50 bg-cream/20 px-4 py-8 text-center text-sm text-charcoal/40">
          {isAr ? 'لا توجد مواضيع مُسندة لدورك في هذه الدفعة.' : 'no subjects assigned to your role in this batch.'}
        </p>
      )}
      {data.subjects.map((s) => (
        <SubjectCard key={s.subject.subject_ref} batchId={data.batch.id} role={data.role} subject={s} isAr={isAr} onToast={onToast} />
      ))}
    </div>
  );
}

function SubjectCard({
  batchId, role, subject, isAr, onToast,
}: {
  batchId: string;
  role: LabelRole;
  subject: EnrichedSubject;
  isAr: boolean;
  onToast: (msg: string, kind: 'success' | 'error') => void;
}) {
  const initial: Record<string, string | null> = {};
  for (const l of subject.my_labels) initial[l.field] = l.value;
  const [values, setValues] = useState<Record<string, string | null>>(initial);
  const [saving, setSaving] = useState<string | null>(null);

  const setField = async (field: string, value: string | null) => {
    setValues((v) => ({ ...v, [field]: value }));
    setSaving(field);
    try {
      await submitLabel({
        batch_id: batchId, subject_kind: subject.subject.subject_kind,
        subject_ref: subject.subject.subject_ref, field, value, role,
      });
    } catch (e) { onToast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setSaving(null); }
  };

  return (
    <div className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-charcoal/5 px-2 py-0.5 text-[11px] font-bold text-charcoal/60">{subject.subject.subject_kind}</span>
          <code className="text-[11px] text-charcoal/40">{subject.subject.subject_ref}</code>
        </div>
        {saving && <span className="flex items-center gap-1 text-[11px] text-charcoal/40"><Loader2 className="animate-spin" size={12} />{isAr ? 'حفظ…' : 'saving…'}</span>}
      </div>

      {/* PII-redacted context */}
      <details className="mb-3 rounded-lg border border-sand/40 bg-cream/20 p-2">
        <summary className="cursor-pointer text-[11px] font-semibold text-charcoal/60">{isAr ? 'السياق (منقّح)' : 'context (redacted)'}</summary>
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] text-charcoal/70" dir="ltr">
          {JSON.stringify(subject.context, null, 2)}
        </pre>
      </details>

      <div className="grid gap-2 sm:grid-cols-2">
        {subject.fields.map((d) => (
          <FieldControl
            key={d.field}
            descriptor={d}
            value={values[`${d.entity}.${d.field}`] ?? values[d.field] ?? null}
            isAr={isAr}
            onChange={(v) => setField(`${d.entity}.${d.field}`, v)}
          />
        ))}
      </div>
    </div>
  );
}
