/**
 * Market Listings Automation — the operator cockpit for the ingest pipeline.
 * See raw evidence, what each field mapped to, and the health of the data. You
 * decide here; you never author extractor/adapter code here. Phase 1: read-only
 * observability (Raw Evidence + Decision queue + Health) over the Gate A tables.
 * Decision WRITES + publish control come in later phases.
 * Spec: docs/market-ingest/automation-section-spec.md
 */
import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { RefreshCw, Database, ListChecks, Activity, AlertTriangle, UploadCloud } from 'lucide-react';
import Button from '@/components/ui/Button';
import { fetchFieldStatus, fetchTargetFields, fetchTargetFieldTypes, fetchTargetLabels, summarize, exampleList, type CoerceClass, type FieldStatus } from '@/lib/marketAutomation/client';
import DecisionPanel from './components/DecisionPanel';
import PublishControl from './components/PublishControl';

type Tab = 'raw' | 'decisions' | 'health' | 'publish';

const STATUS_META: Record<string, { ar: string; en: string; cls: string }> = {
  mapped_existing_field: { ar: 'مطابق لحقل قائم', en: 'Mapped', cls: 'bg-emerald-100 text-emerald-800' },
  candidate_new_field: { ar: 'حقل جديد مقترح', en: 'New field', cls: 'bg-amber-100 text-amber-800' },
  reviewed_source_specific: { ar: 'خاص بالمنصة', en: 'Platform-specific', cls: 'bg-slate-100 text-slate-700' },
  kept_in_extras: { ar: 'تفاصيل إضافية', en: 'Kept in extras', cls: 'bg-slate-100 text-slate-700' },
  intentionally_ignored: { ar: 'مُتجاهل', en: 'Ignored', cls: 'bg-gray-100 text-gray-500' },
  technical_excluded: { ar: 'مستبعد تقنيًا', en: 'Excluded', cls: 'bg-gray-100 text-gray-500' },
  review_required: { ar: 'بحاجة لقرار', en: 'Needs decision', cls: 'bg-rose-100 text-rose-700' },
};
function statusMeta(s: string | null) {
  return STATUS_META[s ?? ''] ?? { ar: 'بحاجة لقرار', en: 'Undecided', cls: 'bg-rose-100 text-rose-700' };
}
const isUndecided = (s: string | null) => !s || s === 'review_required';

export default function MarketAutomationPage() {
  const { language } = useAppStore();
  const isAr = language === 'ar';

  const [rows, setRows] = useState<FieldStatus[]>([]);
  const [targetFields, setTargetFields] = useState<string[]>([]);
  const [targetTypes, setTargetTypes] = useState<Record<string, CoerceClass>>({});
  const [labels, setLabels] = useState<Record<string, { ar: string; en: string }>>({});
  const [deciding, setDeciding] = useState<FieldStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('raw');
  const [platform, setPlatform] = useState<string>('all');

  const load = () => {
    setLoading(true);
    setError(null);
    fetchFieldStatus()
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  useEffect(() => { fetchTargetFields().then(setTargetFields).catch(() => {}); }, []);
  useEffect(() => { fetchTargetFieldTypes().then(setTargetTypes).catch(() => {}); }, []);
  useEffect(() => { fetchTargetLabels().then(setLabels).catch(() => {}); }, []);

  const platforms = useMemo(() => Array.from(new Set(rows.map((r) => r.platform))).sort(), [rows]);
  const scoped = useMemo(() => (platform === 'all' ? rows : rows.filter((r) => r.platform === platform)), [rows, platform]);
  const summary = useMemo(() => summarize(scoped), [scoped]);
  const queue = useMemo(() => scoped.filter((r) => isUndecided(r.authoritative_status)), [scoped]);

  const tabs: { id: Tab; ar: string; en: string; icon: typeof Database }[] = [
    { id: 'raw', ar: 'البيانات الخام', en: 'Raw Evidence', icon: Database },
    { id: 'decisions', ar: 'قرارات الحقول', en: 'Field Decisions', icon: ListChecks },
    { id: 'publish', ar: 'الإصدار', en: 'Publish', icon: UploadCloud },
    { id: 'health', ar: 'صحة البيانات', en: 'Data Health', icon: Activity },
  ];

  return (
    <div className="p-6 max-w-[1400px] mx-auto" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold text-charcoal">{isAr ? 'أتمتة إعلانات السوق' : 'Market Listings Automation'}</h1>
          <p className="text-sm text-charcoal/50 mt-1 max-w-2xl">
            {isAr
              ? 'راقب البيانات الخام، وما طابقته، وصحة البيانات. القرارات تُتخذ هنا؛ بناء المستخرِج والمحوِّل يتم في الكود.'
              : 'See the raw extracted data, what it mapped to, and data health. Decisions are made here; the extractor/adapter are built in code.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="form-input py-1.5 text-sm">
            <option value="all">{isAr ? 'كل المنصات' : 'All platforms'}</option>
            {platforms.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <Button variant="secondary" onClick={load} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* health strip */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-5">
        {[
          { k: 'total', ar: 'إجمالي الحقول', en: 'Observed fields', v: summary.total, cls: 'text-charcoal' },
          { k: 'mapped', ar: 'مطابقة', en: 'Mapped', v: summary.mapped, cls: 'text-emerald-700' },
          { k: 'new', ar: 'جديدة', en: 'New', v: summary.candidateNew, cls: 'text-amber-700' },
          { k: 'kept', ar: 'خاصة/إضافية', en: 'Kept', v: summary.keptOrSourceSpecific, cls: 'text-slate-700' },
          { k: 'ignored', ar: 'متجاهلة', en: 'Ignored', v: summary.ignored, cls: 'text-gray-500' },
          { k: 'queue', ar: 'بحاجة لقرار', en: 'Needs decision', v: summary.needsReview, cls: 'text-rose-700' },
        ].map((c) => (
          <div key={c.k} className="bg-white border border-sand/40 rounded-xl px-4 py-3">
            <div className={`text-2xl font-bold ${c.cls}`}>{c.v}</div>
            <div className="text-[11px] text-charcoal/50 mt-0.5">{isAr ? c.ar : c.en}</div>
          </div>
        ))}
      </div>

      {/* tabs */}
      <div className="flex gap-1 border-b border-sand/40 mb-4">
        {tabs.map((tb) => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm rounded-t-lg -mb-px border-b-2 ${tab === tb.id ? 'border-copper text-copper font-medium' : 'border-transparent text-charcoal/50 hover:text-charcoal'}`}>
            <tb.icon className="w-4 h-4" />{isAr ? tb.ar : tb.en}
            {tb.id === 'decisions' && summary.needsReview > 0 && (
              <span className="ml-1 bg-rose-100 text-rose-700 text-[10px] px-1.5 rounded-full">{summary.needsReview}</span>
            )}
          </button>
        ))}
      </div>

      {error && <div className="flex items-center gap-2 text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mb-4 text-sm"><AlertTriangle className="w-4 h-4" />{error}</div>}
      {loading && <div className="text-charcoal/40 py-10 text-center">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>}

      {!loading && (tab === 'raw' || tab === 'decisions') && (
        <FieldTable rows={tab === 'decisions' ? queue : scoped} isAr={isAr} labels={labels} emptyDecisions={tab === 'decisions'} onDecide={setDeciding} />
      )}

      {!loading && tab === 'publish' && <PublishControl rows={scoped} isAr={isAr} labels={labels} />}

      {!loading && tab === 'health' && <HealthTab summary={summary} isAr={isAr} />}

      {deciding && (
        <DecisionPanel field={deciding} targetFields={targetFields} targetTypes={targetTypes} targetLabels={labels} isAr={isAr}
          onClose={() => setDeciding(null)} onSaved={load} />
      )}
    </div>
  );
}

function FieldTable({ rows, isAr, labels, emptyDecisions, onDecide }: { rows: FieldStatus[]; isAr: boolean; labels: Record<string, { ar: string; en: string }>; emptyDecisions?: boolean; onDecide: (f: FieldStatus) => void }) {
  if (rows.length === 0) {
    return <div className="text-charcoal/40 py-10 text-center">{emptyDecisions ? (isAr ? 'لا حقول بانتظار قرار — كل شيء تمت مراجعته.' : 'No fields awaiting a decision — all reviewed.') : (isAr ? 'لا توجد حقول بعد. شغّل المستخرِج على عيّنة أولاً.' : 'No fields yet. Run the extractor over a sample first.')}</div>;
  }
  return (
    <div className="overflow-x-auto border border-sand/40 rounded-xl bg-white">
      <table className="w-full text-sm">
        <thead className="text-[11px] uppercase text-charcoal/40 border-b border-sand/40">
          <tr>
            {[isAr ? 'المسار' : 'field', isAr ? 'أمثلة' : 'examples', isAr ? 'النوع' : 'type', isAr ? 'القسم' : 'section', isAr ? 'التكرار' : 'seen', isAr ? 'الحالة' : 'status', isAr ? '→ حقل وصل' : '→ Wassell'].map((h) => (
              <th key={h} className="text-start font-medium px-3 py-2 whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const m = statusMeta(r.authoritative_status);
            const wLbl = r.canonical_field ? labels[r.canonical_field] : undefined;
            // Arabic name of the platform field: the field's own curated Arabic name
            // (source_label), else the mapped Wassell field's Arabic label.
            const platAr = r.source_label ?? wLbl?.ar ?? null;
            return (
              <tr key={r.platform + r.source_path} onClick={() => onDecide(r)}
                title={isAr ? 'اضغط لاتخاذ قرار' : 'Click to decide'}
                className="border-b border-sand/20 last:border-0 hover:bg-copper/5 cursor-pointer">
                <td className="px-3 py-2 align-top">
                  {platAr && <div className="text-[13px] text-charcoal">{platAr}</div>}
                  <div className={`font-mono ${platAr ? 'text-[11px] text-charcoal/45' : 'text-[12px] text-charcoal'}`}>{r.source_path}</div>
                </td>
                <td className="px-3 py-2 align-top max-w-[280px]">
                  <div className="flex flex-wrap gap-1">
                    {exampleList(r.example_values).map((ex, i) => (
                      <span key={i} className="bg-sand/15 text-charcoal/70 text-[11px] px-1.5 py-0.5 rounded truncate max-w-[130px]">{ex}</span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 align-top text-[12px] text-charcoal/60 whitespace-nowrap">{r.raw_data_type ?? '—'}</td>
                <td className="px-3 py-2 align-top text-[12px] text-charcoal/50 whitespace-nowrap">{r.page_section ?? '—'}</td>
                <td className="px-3 py-2 align-top text-[12px] text-charcoal/50">{r.occurrence_count ?? '—'}</td>
                <td className="px-3 py-2 align-top"><span className={`text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap ${m.cls}`}>{isAr ? m.ar : m.en}</span></td>
                <td className="px-3 py-2 align-top whitespace-nowrap">
                  {r.canonical_field ? (
                    <>
                      <div className="text-[13px] text-charcoal">{wLbl?.ar ?? r.canonical_field}</div>
                      {wLbl && <div className="font-mono text-[11px] text-charcoal/45">{r.canonical_field}</div>}
                    </>
                  ) : <span className="text-[12px] text-charcoal/40">—</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HealthTab({ summary, isAr }: { summary: ReturnType<typeof summarize>; isAr: boolean }) {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="bg-white border border-sand/40 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-charcoal mb-3">{isAr ? 'الحقول حسب المنصة' : 'Fields by platform'}</h3>
        {Object.entries(summary.byPlatform).map(([p, n]) => (
          <div key={p} className="flex justify-between py-1.5 border-b border-sand/20 last:border-0 text-sm">
            <span className="text-charcoal/70">{p}</span><span className="font-medium">{n}</span>
          </div>
        ))}
      </div>
      <div className="bg-white border border-sand/40 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-charcoal mb-3">{isAr ? 'توزيع القرارات' : 'Decision breakdown'}</h3>
        {[
          ['mapped', isAr ? 'مطابقة لحقل قائم' : 'Mapped to existing', summary.mapped, 'text-emerald-700'],
          ['new', isAr ? 'حقول جديدة مقترحة' : 'Candidate new fields', summary.candidateNew, 'text-amber-700'],
          ['kept', isAr ? 'خاصة بالمنصة/إضافية' : 'Platform / extras', summary.keptOrSourceSpecific, 'text-slate-700'],
          ['ignored', isAr ? 'متجاهلة' : 'Ignored', summary.ignored, 'text-gray-500'],
          ['queue', isAr ? 'بحاجة لقرار' : 'Awaiting decision', summary.needsReview, 'text-rose-700'],
        ].map(([k, label, v, cls]) => (
          <div key={k as string} className="flex justify-between py-1.5 border-b border-sand/20 last:border-0 text-sm">
            <span className="text-charcoal/70">{label as string}</span><span className={`font-medium ${cls as string}`}>{v as number}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
