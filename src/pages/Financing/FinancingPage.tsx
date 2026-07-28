/**
 * The financing module's home surface.
 *
 * Four tabs, one per job a user actually comes here to do:
 *   Dashboard  — what needs attention, and whether the data behind it is sound
 *   Scenarios  — the customer work
 *   Products   — what the market publishes, as WE hold it
 *   Data admin — governance of that reference data (admin only)
 *
 * The data-health strip on the dashboard is deliberately prominent: a rep about
 * to quote a customer should be able to see, without asking, that 4 of 21
 * products carry pricing and that one benchmark is years stale.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Building2,
  Calculator,
  Database,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import {
  RESULT_STATUS_LABEL,
  financingApi,
  formatMonths,
  formatPct,
  formatSar,
  type DashboardResponse,
} from '@/lib/financing/client';
import type { EngineResult, ResultStatus } from '@/lib/financing/types';
import ScenarioWizard from './components/ScenarioWizard';
import ResultsView from './components/ResultsView';
import { ConfidenceChip, RateBasisChip, StaleChip, StatusChip } from './components/StatusChips';

type Tab = 'dashboard' | 'scenarios' | 'products' | 'admin';
type View = { mode: 'list' } | { mode: 'wizard'; scenarioId: string | null } | { mode: 'results'; scenarioId: string };

export default function FinancingPage() {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const addToast = useAppStore((s) => s.addToast);
  const isAdmin = useAppStore((s) => {
    const user = s.users.find((u) => u.id === s.currentUserId);
    return s.profiles.find((p) => p.id === user?.profile_id)?.is_admin === true;
  });
  const t = useCallback((ar: string, en: string) => (isAr ? ar : en), [isAr]);

  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>('dashboard');
  const [view, setView] = useState<View>({ mode: 'list' });
  const [loading, setLoading] = useState(true);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [scenarios, setScenarios] = useState<Array<Record<string, unknown>>>([]);
  const [reference, setReference] = useState<Record<string, unknown> | null>(null);
  const [adminData, setAdminData] = useState<Record<string, unknown> | null>(null);
  const [scenarioBundle, setScenarioBundle] = useState<Record<string, unknown> | null>(null);
  const [result, setResult] = useState<EngineResult | null>(null);
  const [busy, setBusy] = useState(false);

  // Deep-link entry from a client / project / unit page.
  const prefillClient = searchParams.get('client') ?? undefined;
  const prefillProject = searchParams.get('project') ?? undefined;
  const prefillUnit = searchParams.get('unit') ?? undefined;
  const deepLinkScenario = searchParams.get('scenario') ?? undefined;

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const data = await financingApi.dashboard();
      setDashboard(data);
      setScenarios(data.scenarios);
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  const openScenario = useCallback(
    async (scenarioId: string) => {
      setBusy(true);
      try {
        const bundle = await financingApi.scenarioGet(scenarioId);
        setScenarioBundle(bundle);
        const snapshot = bundle.latest_snapshot as EngineResult | null;
        setResult(snapshot);
        setView(snapshot ? { mode: 'results', scenarioId } : { mode: 'wizard', scenarioId });
      } catch (err) {
        addToast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        setBusy(false);
      }
    },
    [addToast],
  );

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  useEffect(() => {
    if (deepLinkScenario) void openScenario(deepLinkScenario);
    else if (prefillClient || prefillProject || prefillUnit) setView({ mode: 'wizard', scenarioId: null });
  }, [deepLinkScenario, prefillClient, prefillProject, prefillUnit, openScenario]);

  useEffect(() => {
    if (tab === 'products' && !reference) {
      void financingApi
        .reference()
        .then(setReference)
        .catch((err: unknown) => addToast(err instanceof Error ? err.message : String(err), 'error'));
    }
    if (tab === 'admin' && !adminData) {
      void financingApi
        .adminData()
        .then(setAdminData)
        .catch((err: unknown) => addToast(err instanceof Error ? err.message : String(err), 'error'));
    }
  }, [tab, reference, adminData, addToast]);

  async function handleCalculated(scenarioId: string) {
    const bundle = await financingApi.scenarioGet(scenarioId);
    setScenarioBundle(bundle);
    setResult(bundle.latest_snapshot as EngineResult);
    setView({ mode: 'results', scenarioId });
    void loadDashboard();
  }

  async function recalculate(scenarioId: string) {
    setBusy(true);
    try {
      const res = await financingApi.calculate(scenarioId, 'full');
      setResult(res.result);
      addToast(t('تم تحديث الاحتساب', 'Calculation refreshed'), 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function convert(scenarioId: string) {
    setBusy(true);
    try {
      const res = await financingApi.convertToCase(scenarioId, result?.selected?.product.id);
      addToast(
        t(
          `تم إنشاء ملف التمويل${res.required_documents.length ? ` — ${res.required_documents.length} مستند مطلوب` : ''}`,
          `Financing case created${res.required_documents.length ? ` — ${res.required_documents.length} documents required` : ''}`,
        ),
        'success',
      );
      void loadDashboard();
    } catch (err) {
      // The consent gate lands here as a 409 with an explanatory sentence.
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  const health = dashboard?.health;

  // ── Scenario detail views take over the whole page ─────────────────────
  if (view.mode === 'wizard') {
    return (
      <div className="mx-auto max-w-6xl p-4 sm:p-6" dir={isAr ? 'rtl' : 'ltr'}>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-bold text-charcoal">{t('حاسبة التمويل العقاري', 'Real estate financing calculator')}</h1>
          <Button variant="secondary" onClick={() => { setView({ mode: 'list' }); setSearchParams({}); }}>
            {t('رجوع', 'Back')}
          </Button>
        </div>
        <ScenarioWizard
          scenarioId={view.scenarioId}
          initial={scenarioBundle ?? undefined}
          prefill={{
            client_record_id: prefillClient,
            project_record_id: prefillProject,
            unit_record_id: prefillUnit,
          }}
          onSaved={() => void loadDashboard()}
          onCalculated={handleCalculated}
        />
      </div>
    );
  }

  if (view.mode === 'results' && result) {
    const scenario = (scenarioBundle?.scenario ?? {}) as Record<string, unknown>;
    return (
      <div className="mx-auto max-w-6xl p-4 sm:p-6" dir={isAr ? 'rtl' : 'ltr'}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold text-charcoal">
              {String(scenario.title ?? t('نتيجة التمويل', 'Financing result'))}
            </h1>
            <p className="text-xs text-charcoal/50">
              {t('سيناريو رقم', 'Scenario')} #{String(scenario.scenario_number ?? '')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setView({ mode: 'wizard', scenarioId: view.scenarioId })}>
              {t('تعديل المدخلات', 'Edit inputs')}
            </Button>
            <Button variant="secondary" onClick={() => void recalculate(view.scenarioId)} disabled={busy}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              {t('إعادة الاحتساب', 'Recalculate')}
            </Button>
            <Button
              variant="secondary"
              onClick={async () => {
                const res = await financingApi.scenarioDuplicate(view.scenarioId);
                addToast(t('تم إنشاء نسخة', 'Duplicated'), 'success');
                void openScenario(res.scenario_id);
              }}
            >
              {t('نسخ للمقارنة', 'Duplicate')}
            </Button>
            <Button onClick={() => void convert(view.scenarioId)} disabled={busy}>
              <FileText size={15} />
              {t('تحويل إلى ملف تمويل', 'Convert to financing case')}
            </Button>
            <Button variant="secondary" onClick={() => { setView({ mode: 'list' }); setSearchParams({}); }}>
              {t('رجوع', 'Back')}
            </Button>
          </div>
        </div>

        {/* Consent state — the gate on conversion, stated up front. */}
        {scenario.consent_to_share_with_provider !== true && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
            <div className="flex items-center gap-2">
              <ShieldCheck size={15} />
              {t(
                'لم تُسجَّل موافقة العميل على مشاركة بياناته المالية مع جهة تمويل. التحويل إلى ملف تمويل يتطلب هذه الموافقة.',
                'Customer consent to share financial data with a provider has not been recorded. Converting to a financing case requires it.',
              )}
            </div>
            <Button
              variant="secondary"
              onClick={async () => {
                await financingApi.recordConsent(view.scenarioId, true);
                await openScenario(view.scenarioId);
                addToast(t('تم تسجيل الموافقة', 'Consent recorded'), 'success');
              }}
            >
              {t('تسجيل الموافقة', 'Record consent')}
            </Button>
          </div>
        )}

        <ResultsView result={result} />
      </div>
    );
  }

  // ── Main tabbed surface ────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-charcoal">
            <Calculator size={20} className="text-copper" />
            {t('التمويل العقاري', 'Real estate financing')}
          </h1>
          <p className="text-xs text-charcoal/50">
            {t(
              'حاسبة استرشادية مبنية على بيانات رسمية منشورة — ليست موافقة تمويلية',
              'Indicative calculator built on officially published data — not a financing approval',
            )}
          </p>
        </div>
        <Button onClick={() => { setScenarioBundle(null); setResult(null); setView({ mode: 'wizard', scenarioId: null }); }}>
          <Plus size={15} /> {t('سيناريو جديد', 'New scenario')}
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {([
          ['dashboard', t('لوحة المتابعة', 'Dashboard'), Activity],
          ['scenarios', t('السيناريوهات', 'Scenarios'), FileText],
          ['products', t('المنتجات التمويلية', 'Financing products'), Building2],
          ...(isAdmin ? [['admin', t('إدارة البيانات', 'Data administration'), Database] as const] : []),
        ] as Array<[Tab, string, typeof Activity]>).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold transition-colors ${
              tab === id ? 'bg-copper text-white' : 'bg-white text-charcoal/60 hover:bg-cream'
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-charcoal/50">
          <Loader2 size={18} className="animate-spin" /> {t('جارٍ التحميل…', 'Loading…')}
        </div>
      )}

      {/* ── Dashboard ────────────────────────────────────────────────── */}
      {!loading && tab === 'dashboard' && dashboard && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {[
              [t('منتجات نشطة', 'Active products'), String(health?.active_products ?? 0), null],
              [t('منتجات بتسعير منشور', 'With published pricing'), `${health?.products_with_pricing ?? 0} (${health?.pricing_coverage_pct ?? 0}%)`, (health?.pricing_coverage_pct ?? 0) < 50 ? 'warn' : null],
              [t('تسعير قديم', 'Stale pricing'), String(health?.stale_pricing ?? 0), (health?.stale_pricing ?? 0) > 0 ? 'warn' : null],
              [t('ملاحظات جودة مفتوحة', 'Open data issues'), String(health?.open_issues ?? 0), (health?.open_issues ?? 0) > 0 ? 'warn' : null],
              [t('سيناريوهات', 'Scenarios'), String(scenarios.length), null],
            ].map(([label, value, tone]) => (
              <div key={label as string} className={`rounded-xl border p-4 ${tone === 'warn' ? 'border-amber-200 bg-amber-50' : 'border-sand/30 bg-white'}`}>
                <div className="text-[11px] font-bold uppercase tracking-wide text-charcoal/50">{label}</div>
                <div className={`mt-1 text-2xl font-bold ${tone === 'warn' ? 'text-amber-700' : 'text-charcoal'}`}>{value}</div>
              </div>
            ))}
          </div>

          {(health?.pricing_coverage_pct ?? 100) < 50 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900">
              <div className="mb-1 flex items-center gap-2 font-bold">
                <AlertTriangle size={14} />
                {t('تغطية التسعير محدودة', 'Limited pricing coverage')}
              </div>
              {t(
                'معظم البنوك السعودية لا تنشر أسعار الربح التعاقدية علنًا. المنتجات بدون تسعير منشور تظهر كـ "بيانات المنتج غير متوفرة" ولا يُحتسب لها قسط — وهذا مقصود، لأن اشتقاق قسط من رقم تسويقي يعطي دقة زائفة.',
                'Most Saudi banks do not publish contractual profit rates. Products without published pricing appear as "product data unavailable" and get NO installment — deliberately, because deriving one from a marketing figure manufactures false precision.',
              )}
            </div>
          )}

          <div className="card p-5">
            <h2 className="mb-3 font-bold text-charcoal">{t('أحدث السيناريوهات', 'Recent scenarios')}</h2>
            <ScenarioTable scenarios={scenarios} onOpen={openScenario} isAr={isAr} />
          </div>

          {dashboard.issues.length > 0 && (
            <div className="card p-5">
              <h2 className="mb-3 font-bold text-charcoal">{t('صحة البيانات المرجعية', 'Reference-data health')}</h2>
              <div className="space-y-1.5">
                {dashboard.issues.slice(0, 15).map((i) => (
                  <div
                    key={i.id}
                    className={`rounded-lg border p-2.5 text-xs ${
                      i.severity === 'error'
                        ? 'border-red-200 bg-red-50 text-red-800'
                        : i.severity === 'warning'
                          ? 'border-amber-200 bg-amber-50 text-amber-800'
                          : 'border-sand/30 bg-cream/40 text-charcoal/70'
                    }`}
                  >
                    <span className="font-bold">{i.issue_type}</span> — {isAr ? (i.message_ar ?? i.message_en) : i.message_en}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Scenarios ────────────────────────────────────────────────── */}
      {!loading && tab === 'scenarios' && (
        <div className="card p-5">
          <ScenarioTable scenarios={scenarios} onOpen={openScenario} isAr={isAr} />
        </div>
      )}

      {/* ── Products ─────────────────────────────────────────────────── */}
      {!loading && tab === 'products' && (
        <div className="card p-5">
          {!reference ? (
            <div className="flex items-center gap-2 py-8 text-charcoal/50">
              <Loader2 size={16} className="animate-spin" /> {t('جارٍ التحميل…', 'Loading…')}
            </div>
          ) : (
            <ProductTable reference={reference} isAr={isAr} />
          )}
        </div>
      )}

      {/* ── Admin ────────────────────────────────────────────────────── */}
      {!loading && tab === 'admin' && isAdmin && (
        <AdminPanel data={adminData} isAr={isAr} onRefresh={() => financingApi.adminData().then(setAdminData)} />
      )}
    </div>
  );
}

function ScenarioTable({
  scenarios,
  onOpen,
  isAr,
}: {
  scenarios: Array<Record<string, unknown>>;
  onOpen: (id: string) => void;
  isAr: boolean;
}) {
  const t = (ar: string, en: string) => (isAr ? ar : en);
  if (scenarios.length === 0) {
    return <p className="py-8 text-center text-sm text-charcoal/50">{t('لا توجد سيناريوهات بعد', 'No scenarios yet')}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[700px] text-xs">
        <thead>
          <tr className="border-b border-sand/30 text-charcoal/50">
            <th className="p-2 text-start">#</th>
            <th className="p-2 text-start">{t('العنوان', 'Title')}</th>
            <th className="p-2 text-start">{t('الحالة', 'Status')}</th>
            <th className="p-2 text-start">{t('مفضل', 'Preferred')}</th>
            <th className="p-2 text-start">{t('آخر تحديث', 'Updated')}</th>
          </tr>
        </thead>
        <tbody>
          {scenarios.map((s) => (
            <tr
              key={String(s.id)}
              className="cursor-pointer border-b border-sand/10 hover:bg-cream/40"
              onClick={() => onOpen(String(s.id))}
            >
              <td className="p-2 text-charcoal/60">{String(s.scenario_number ?? '')}</td>
              <td className="p-2 font-medium text-charcoal">{String(s.title ?? t('بدون عنوان', 'Untitled'))}</td>
              <td className="p-2 text-charcoal/70">{String(s.status ?? '')}</td>
              <td className="p-2">{s.is_preferred ? '★' : ''}</td>
              <td className="p-2 text-charcoal/50">{String(s.updated_at ?? '').slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProductTable({ reference, isAr }: { reference: Record<string, unknown>; isAr: boolean }) {
  const t = (ar: string, en: string) => (isAr ? ar : en);
  const products = (reference.products ?? []) as Array<Record<string, unknown>>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1000px] text-xs">
        <thead>
          <tr className="border-b border-sand/30 text-charcoal/50">
            <th className="p-2 text-start">{t('الممول', 'Provider')}</th>
            <th className="p-2 text-start">{t('المنتج', 'Product')}</th>
            <th className="p-2 text-start">{t('الفئة', 'Category')}</th>
            <th className="p-2 text-end">{t('أدنى راتب', 'Min salary')}</th>
            <th className="p-2 text-end">{t('أقصى مبلغ', 'Max amount')}</th>
            <th className="p-2 text-end">{t('أقصى مدة', 'Max term')}</th>
            <th className="p-2 text-start">{t('التسعير المنشور', 'Published pricing')}</th>
            <th className="p-2 text-start">{t('المصدر', 'Source')}</th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => {
            const v = p.version as Record<string, unknown> | null;
            const r = p.rate as Record<string, unknown> | null;
            const provider = p.provider as Record<string, unknown>;
            return (
              <tr key={String(p.id)} className="border-b border-sand/10">
                <td className="p-2 font-medium text-charcoal">{String(isAr ? provider.name_ar : provider.name_en)}</td>
                <td className="p-2 text-charcoal/80">{String(isAr ? p.name_ar : p.name_en)}</td>
                <td className="p-2 text-charcoal/60">{String(p.category)}</td>
                <td className="p-2 text-end text-charcoal/70">{v?.min_salary ? formatSar(Number(v.min_salary), isAr) : '—'}</td>
                <td className="p-2 text-end text-charcoal/70">{v?.max_amount ? formatSar(Number(v.max_amount), isAr) : '—'}</td>
                <td className="p-2 text-end text-charcoal/70">{v?.max_term_months ? formatMonths(Number(v.max_term_months), isAr) : '—'}</td>
                <td className="p-2">
                  {r ? (
                    <div className="flex flex-col gap-1">
                      <span className="font-bold text-charcoal">
                        {r.contractual_rate_pct
                          ? formatPct(Number(r.contractual_rate_pct), isAr)
                          : r.published_apr_pct
                            ? `${t('نسبة سنوية', 'APR')} ${formatPct(Number(r.published_apr_pct), isAr)}`
                            : '—'}
                      </span>
                      <RateBasisChip
                        basis={
                          r.rate_disclosure_type === 'exact_rate'
                            ? 'contractual'
                            : r.rate_disclosure_type === 'representative_example'
                              ? 'example'
                              : r.rate_disclosure_type === 'published_range'
                                ? 'range_midpoint'
                                : 'starting_from'
                        }
                      />
                    </div>
                  ) : (
                    <span className="text-charcoal/40">{t('غير منشور', 'Not published')}</span>
                  )}
                </td>
                <td className="p-2">
                  {p.official_url ? (
                    <a href={String(p.official_url)} target="_blank" rel="noreferrer" className="text-copper hover:underline">
                      {t('الصفحة الرسمية', 'Official page')}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AdminPanel({
  data,
  isAr,
  onRefresh,
}: {
  data: Record<string, unknown> | null;
  isAr: boolean;
  onRefresh: () => void;
}) {
  const t = (ar: string, en: string) => (isAr ? ar : en);
  const addToast = useAppStore((s) => s.addToast);
  const [note, setNote] = useState('');
  if (!data) {
    return (
      <div className="card flex items-center gap-2 p-8 text-charcoal/50">
        <Loader2 size={16} className="animate-spin" /> {t('جارٍ التحميل…', 'Loading…')}
      </div>
    );
  }
  const issues = (data.issues ?? []) as Array<Record<string, unknown>>;
  const reviews = (data.reviews ?? []) as Array<Record<string, unknown>>;
  const runs = (data.runs ?? []) as Array<Record<string, unknown>>;
  const sources = (data.sources ?? []) as Array<Record<string, unknown>>;
  const ruleVersions = (data.rule_versions ?? []) as Array<Record<string, unknown>>;

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <h2 className="mb-3 font-bold text-charcoal">{t('القواعد التنظيمية المطبقة', 'Regulatory rules in force')}</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] text-xs">
            <thead>
              <tr className="border-b border-sand/30 text-charcoal/50">
                <th className="p-2 text-start">{t('القاعدة', 'Rule')}</th>
                <th className="p-2 text-start">{t('الجهة', 'Authority')}</th>
                <th className="p-2 text-start">{t('سارية من', 'Effective from')}</th>
                <th className="p-2 text-start">{t('سارية حتى', 'Effective to')}</th>
                <th className="p-2 text-start">{t('المرجع', 'Citation')}</th>
              </tr>
            </thead>
            <tbody>
              {ruleVersions.map((v) => {
                const rule = v.fin_regulatory_rules as Record<string, unknown> | undefined;
                return (
                  <tr key={String(v.id)} className={`border-b border-sand/10 ${v.effective_to ? 'opacity-50' : ''}`}>
                    <td className="p-2 font-medium text-charcoal">{String(isAr ? rule?.label_ar : rule?.label_en)}</td>
                    <td className="p-2 text-charcoal/60">{String(rule?.authority ?? '')}</td>
                    <td className="p-2 text-charcoal/60">{String(v.effective_from ?? '')}</td>
                    <td className="p-2 text-charcoal/60">{String(v.effective_to ?? t('سارية', 'in force'))}</td>
                    <td className="p-2 text-[11px] text-charcoal/50">
                      <a href={String(v.source_url)} target="_blank" rel="noreferrer" className="hover:text-copper hover:underline">
                        {String(v.citation_ref ?? v.source_url ?? '')}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card p-5">
        <h2 className="mb-3 font-bold text-charcoal">{t('المصادر الرسمية', 'Official sources')}</h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {sources.map((s) => (
            <a
              key={String(s.id)}
              href={String(s.url)}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-sand/30 p-2.5 text-xs hover:border-copper/40"
            >
              <div className="font-bold text-charcoal">{String(s.publisher)}</div>
              <div className="text-charcoal/60">{String(s.title_en)}</div>
              <div className="mt-1 text-[10px] text-charcoal/40">
                {t('رتبة المصدر', 'Authority rank')} {String(s.authority_rank)} · {t('صلاحية', 'freshness')} {String(s.freshness_days)}d
              </div>
            </a>
          ))}
        </div>
      </div>

      {reviews.length > 0 && (
        <div className="card p-5">
          <h2 className="mb-3 font-bold text-charcoal">{t('تغييرات بانتظار المراجعة', 'Changes awaiting review')}</h2>
          <p className="mb-3 text-xs text-charcoal/55">
            {t(
              'كل قرار يدوي يتطلب سببًا مكتوبًا ويحفظ القيمة الأصلية دون حذفها.',
              'Every manual decision requires a written reason and preserves the original extracted value.',
            )}
          </p>
          <input
            className="mb-3 w-full rounded-lg border border-sand/40 px-3 py-2 text-sm"
            placeholder={t('سبب القرار (مطلوب)', 'Reason for the decision (required)')}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {reviews.map((r) => (
            <div key={String(r.id)} className="mb-2 rounded-lg border border-sand/30 p-3 text-xs">
              <div className="font-bold text-charcoal">
                {String(r.entity_type)} — {String(r.change_kind)}
              </div>
              <div className="text-charcoal/60">{String(r.diff_summary ?? '')}</div>
              <div className="mt-2 flex gap-2">
                {(['approved', 'rejected'] as const).map((decision) => (
                  <Button
                    key={decision}
                    variant={decision === 'approved' ? 'primary' : 'secondary'}
                    onClick={async () => {
                      if (!note.trim()) {
                        addToast(t('السبب مطلوب', 'A reason is required'), 'error');
                        return;
                      }
                      try {
                        await financingApi.adminReviewDecide(String(r.id), decision, note);
                        setNote('');
                        onRefresh();
                      } catch (err) {
                        addToast(err instanceof Error ? err.message : String(err), 'error');
                      }
                    }}
                  >
                    {decision === 'approved' ? t('اعتماد', 'Approve') : t('رفض', 'Reject')}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card p-5">
        <h2 className="mb-3 font-bold text-charcoal">{t('ملاحظات جودة البيانات', 'Data-quality issues')}</h2>
        <div className="space-y-1.5">
          {issues.slice(0, 40).map((i) => (
            <div key={String(i.id)} className="flex items-start justify-between gap-3 rounded-lg border border-sand/30 p-2.5 text-xs">
              <div>
                <span className={`font-bold ${i.severity === 'error' ? 'text-red-600' : i.severity === 'warning' ? 'text-amber-600' : 'text-charcoal/60'}`}>
                  {String(i.issue_type)}
                </span>
                <span className="text-charcoal/70"> — {String(isAr ? (i.message_ar ?? i.message_en) : i.message_en)}</span>
              </div>
              {i.status === 'open' && (
                <button
                  type="button"
                  className="shrink-0 text-charcoal/50 hover:text-copper"
                  onClick={async () => {
                    try {
                      await financingApi.adminIssueUpdate(String(i.id), 'acknowledged');
                      onRefresh();
                    } catch (err) {
                      addToast(err instanceof Error ? err.message : String(err), 'error');
                    }
                  }}
                >
                  {t('إقرار', 'Acknowledge')}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="card p-5">
        <h2 className="mb-3 font-bold text-charcoal">{t('عمليات تحديث البيانات', 'Data refresh runs')}</h2>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-sand/30 text-charcoal/50">
              <th className="p-2 text-start">{t('البدء', 'Started')}</th>
              <th className="p-2 text-start">{t('الحالة', 'Status')}</th>
              <th className="p-2 text-end">{t('مصادر ناجحة', 'Sources OK')}</th>
              <th className="p-2 text-end">{t('محجوبة', 'Blocked')}</th>
              <th className="p-2 text-end">{t('فاشلة', 'Failed')}</th>
              <th className="p-2 text-end">{t('نسخ جديدة', 'Versions created')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={String(r.id)} className="border-b border-sand/10">
                <td className="p-2 text-charcoal/70">{String(r.started_at ?? '').slice(0, 19).replace('T', ' ')}</td>
                <td className="p-2 text-charcoal/70">{String(r.status)}</td>
                <td className="p-2 text-end text-charcoal/70">{String(r.sources_ok)}</td>
                <td className="p-2 text-end text-amber-600">{String(r.sources_blocked)}</td>
                <td className="p-2 text-end text-red-600">{String(r.sources_failed)}</td>
                <td className="p-2 text-end text-charcoal/70">{String(r.versions_created)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-[11px] leading-relaxed text-charcoal/45">
          {t(
            'التحديث يُشغَّل عبر: npm run financing:refresh — يجلب المصادر بالتوازي ثم يقارن ويُنشئ نسخة جديدة فقط عند تغير فعلي.',
            'Refresh runs via: npm run financing:refresh — fetches every source in parallel, then diffs and creates a new version only on a real change.',
          )}
        </p>
      </div>
    </div>
  );
}

/** Re-exported so the results page and the dashboard share one status vocabulary. */
export { RESULT_STATUS_LABEL };
export type { ResultStatus };
export { StatusChip, ConfidenceChip, StaleChip };
