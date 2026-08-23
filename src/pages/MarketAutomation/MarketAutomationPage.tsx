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
const keyOf = (r: FieldStatus) => `${r.platform}|${r.source_path}`;

// Status filter chips (raw tab). 'all' + 'review_required' (folds null) + real statuses.
const FILTERS: { id: string; ar: string; en: string }[] = [
  { id: 'all', ar: 'الكل', en: 'All' },
  { id: 'review_required', ar: 'بحاجة لقرار', en: 'Needs decision' },
  { id: 'mapped_existing_field', ar: 'مطابقة', en: 'Mapped' },
  { id: 'candidate_new_field', ar: 'جديدة', en: 'New' },
  { id: 'reviewed_source_specific', ar: 'خاصة بالمنصة', en: 'Platform-specific' },
  { id: 'intentionally_ignored', ar: 'متجاهلة', en: 'Ignored' },
  { id: 'technical_excluded', ar: 'مستبعدة', en: 'Excluded' },
];

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
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  // Navigation snapshot for the Save & Next flow: the ordered keys the drawer walks.
  const [navKeys, setNavKeys] = useState<string[]>([]);
  const [navIndex, setNavIndex] = useState(-1);
  // Session gamification: XP + streak earned reviewing in THIS sitting.
  const [sessionXp, setSessionXp] = useState(0);
  const [sessionCount, setSessionCount] = useState(0);

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

  // Rows the table actually shows: base list (all vs needs-decision) narrowed by the
  // search box and (on the raw tab) the status chip.
  const visibleRows = useMemo(() => {
    const base = tab === 'decisions' ? queue : scoped;
    const q = search.trim().toLowerCase();
    return base.filter((r) => {
      if (tab === 'raw' && statusFilter !== 'all') {
        if (statusFilter === 'review_required' ? !isUndecided(r.authoritative_status) : r.authoritative_status !== statusFilter) return false;
      }
      if (!q) return true;
      const wl = r.canonical_field ? labels[r.canonical_field] : undefined;
      return (
        r.source_path.toLowerCase().includes(q) ||
        (r.source_label ?? '').toLowerCase().includes(q) ||
        (r.canonical_field ?? '').toLowerCase().includes(q) ||
        (wl?.ar ?? '').toLowerCase().includes(q) ||
        (wl?.en ?? '').toLowerCase().includes(q)
      );
    });
  }, [tab, queue, scoped, search, statusFilter, labels]);

  // Open the drawer on a row AND snapshot the current ordered list for Save & Next.
  const openDecision = (row: FieldStatus) => {
    const keys = visibleRows.map(keyOf);
    setNavKeys(keys);
    setNavIndex(keys.indexOf(keyOf(row)));
    setDeciding(row);
  };
  // Optimistic in-place update after a decision — no full reload, so the table keeps
  // its scroll position and the drawer can advance smoothly.
  const patchRow = (patch: Partial<FieldStatus> & { platform: string; source_path: string }) =>
    setRows((prev) => prev.map((r) => (keyOf(r) === `${patch.platform}|${patch.source_path}` ? { ...r, ...patch } : r)));
  // A decision landed: update the row in place AND award session XP. Returns the
  // points earned so the review screen can celebrate it.
  const handleDecided = (patch: Partial<FieldStatus> & { platform: string; source_path: string }) => {
    patchRow(patch);
    const gain = 10 + (patch.authoritative_status === 'mapped_existing_field' || patch.authoritative_status === 'candidate_new_field' ? 5 : 0);
    setSessionXp((x) => x + gain);
    setSessionCount((c) => c + 1);
    return gain;
  };
  const hasNext = navIndex >= 0 && navIndex + 1 < navKeys.length;
  const hasPrev = navIndex > 0;
  const goNext = () => {
    const next = rows.find((r) => keyOf(r) === navKeys[navIndex + 1]);
    if (next) { setNavIndex(navIndex + 1); setDeciding(next); }
    else setDeciding(null);
  };
  const goPrev = () => {
    const prev = rows.find((r) => keyOf(r) === navKeys[navIndex - 1]);
    if (prev) { setNavIndex(navIndex - 1); setDeciding(prev); }
  };

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
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={isAr ? 'ابحث في المسار أو الاسم أو الحقل…' : 'Search path, label, or target…'}
              className="form-input py-1.5 text-sm flex-1 min-w-[220px] max-w-sm"
            />
            {tab === 'raw' && (
              <div className="flex flex-wrap gap-1">
                {FILTERS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setStatusFilter(f.id)}
                    className={`text-[12px] px-2.5 py-1 rounded-full border ${statusFilter === f.id ? 'border-copper bg-copper/10 text-copper font-medium' : 'border-sand/50 text-charcoal/55 hover:bg-sand/10'}`}>
                    {isAr ? f.ar : f.en}
                  </button>
                ))}
              </div>
            )}
            <span className="text-[12px] text-charcoal/40 ms-auto">
              {visibleRows.length} {isAr ? 'حقل' : 'fields'}
            </span>
          </div>
          <FieldTable rows={visibleRows} isAr={isAr} labels={labels} emptyDecisions={tab === 'decisions'} onDecide={openDecision} />
        </>
      )}

      {!loading && tab === 'publish' && <PublishControl rows={scoped} isAr={isAr} labels={labels} />}

      {!loading && tab === 'health' && <HealthTab summary={summary} isAr={isAr} />}

      {deciding && (
        <DecisionPanel key={keyOf(deciding)} field={deciding} targetFields={targetFields} targetTypes={targetTypes} targetLabels={labels} isAr={isAr}
          hasNext={hasNext} hasPrev={hasPrev} position={navIndex >= 0 ? { at: navIndex + 1, of: navKeys.length } : null}
          xp={sessionXp} streak={sessionCount} decided={summary.total - summary.needsReview} total={summary.total} needsReview={summary.needsReview}
          onClose={() => setDeciding(null)} onDecided={handleDecided} onNext={goNext} onPrev={goPrev} />
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
