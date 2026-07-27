/**
 * Market Intelligence — a brokerage command center built on the deterministic
 * benchmark precompute layer (market_benchmarks / market_demand_supply_benchmarks).
 *
 * ZERO AI in any number here. Every figure is a precomputed aggregate or a
 * DB-filtered scan. Asking prices are framed as "current asking market", never
 * "market value". Confidence + duplicate risk are surfaced, not buried.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { LineChart, RefreshCw, Building2, Users, MapPin, ShieldCheck, AlertTriangle } from 'lucide-react';
import { fetchOverview, recomputeBenchmarks } from '@/lib/market/client';
import { resolveEffectiveProfile } from '@/lib/permissions';
import type { MarketOverview } from '@/lib/market/types';
import MapTab from './components/MapTab';
import BenchmarkTab from './components/BenchmarkTab';
import DemandSupplyTab from './components/DemandSupplyTab';
import OpportunitiesTab from './components/OpportunitiesTab';
import PricingTab from './components/PricingTab';
import { CaveatStrip } from './components/shared';

type Tab = 'overview' | 'map' | 'benchmarks' | 'demand' | 'opportunities' | 'pricing';

export default function MarketIntelligencePage() {
  const { t } = useTranslation();
  const { language, currentUserId, users, profiles, previewProfileId, addToast } = useAppStore();
  const isAr = language === 'ar';
  const currentUser = users.find((u) => u.id === currentUserId);
  // Preview-aware: honors the "view app as" override for granted users.
  const currentProfile = resolveEffectiveProfile(currentUser, profiles, previewProfileId);
  const isAdmin = !!currentProfile?.is_admin;

  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<MarketOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);

  const loadOverview = () => {
    setLoading(true);
    setError(null);
    fetchOverview()
      .then(setOverview)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(loadOverview, []);

  const onRecompute = async () => {
    setRecomputing(true);
    try {
      const r = await recomputeBenchmarks();
      addToast(isAr ? `تم التحديث (${r.benchmark_segments} شريحة)` : `Recomputed (${r.benchmark_segments} segments)`, 'success');
      loadOverview();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setRecomputing(false);
    }
  };

  const tabs: { id: Tab; label: string }[] = useMemo(() => [
    { id: 'overview', label: isAr ? 'نظرة عامة' : 'Overview' },
    { id: 'map', label: isAr ? 'الخريطة' : 'Map' },
    { id: 'benchmarks', label: isAr ? 'مؤشرات الأسعار' : 'Benchmarks' },
    { id: 'demand', label: isAr ? 'الطلب والعرض' : 'Demand × Supply' },
    { id: 'opportunities', label: isAr ? 'الفرص' : 'Opportunities' },
    { id: 'pricing', label: isAr ? 'تسعير مشاريعنا' : 'Our Pricing' },
  ], [isAr]);

  return (
    <div className="mx-auto max-w-7xl p-6">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-copper/15 text-copper"><LineChart size={22} /></span>
          <div>
            <h1 className="text-xl font-bold text-charcoal">{isAr ? 'ذكاء السوق' : 'Market Intelligence'}</h1>
            <p className="text-[13px] text-charcoal/55">
              {overview?.snapshot_date
                ? (isAr ? `لقطة السوق: ${overview.snapshot_date}` : `Snapshot: ${overview.snapshot_date}`)
                : (isAr ? 'لا توجد لقطة بعد' : 'No snapshot yet')}
            </p>
          </div>
        </div>
        {isAdmin && (
          <Button variant="secondary" onClick={onRecompute} disabled={recomputing}>
            <RefreshCw size={15} className={recomputing ? 'animate-spin' : ''} />
            {isAr ? 'إعادة حساب المؤشرات' : 'Recompute'}
          </Button>
        )}
      </div>

      <CaveatStrip>
        {isAr
          ? 'الأرقام مبنية على الأسعار المعروضة حالياً (وليست أسعار صفقات فعلية)، وقد تتضمن إعلانات مكررة. نطاقات إرشادية — القوائم الخارجية تحتاج تحقق قبل العرض.'
          : 'Figures are based on current asking prices (not actual transaction prices) and may include duplicate ads. Indicative ranges — external listings require verification before offering.'}
      </CaveatStrip>

      {/* Tabs */}
      <div className="mt-5 mb-4 flex flex-wrap gap-2 border-b border-sand/30">
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-bold transition-colors ${
              tab === tb.id ? 'border-copper text-copper' : 'border-transparent text-charcoal/50 hover:text-charcoal'
            }`}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {error && <CaveatStrip>{error}</CaveatStrip>}

      {tab === 'overview' && <OverviewCards overview={overview} loading={loading} isAr={isAr} t={t} />}
      {tab === 'map' && <MapTab isAr={isAr} />}
      {tab === 'benchmarks' && <BenchmarkTab isAr={isAr} />}
      {tab === 'demand' && <DemandSupplyTab isAr={isAr} />}
      {tab === 'opportunities' && <OpportunitiesTab isAr={isAr} />}
      {tab === 'pricing' && <PricingTab isAr={isAr} />}
    </div>
  );
}

function OverviewCards({ overview, loading, isAr }: { overview: MarketOverview | null; loading: boolean; isAr: boolean; t: (k: string) => string }) {
  if (loading) return <div className="py-16 text-center text-charcoal/40">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>;
  if (!overview || !overview.snapshot_date) {
    return (
      <div className="card p-8 text-center text-charcoal/50">
        {isAr ? 'لا توجد بيانات مؤشرات بعد. اطلب من المشرف إعادة حساب المؤشرات.' : 'No benchmark data yet. Ask an admin to recompute.'}
      </div>
    );
  }
  const o = overview;
  const nf = (n: number) => n.toLocaleString('en-US');
  const cards: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: string }[] = [
    { icon: <Building2 size={18} />, label: isAr ? 'إعلانات السوق النشطة' : 'Active market listings', value: nf(o.total_active_listings), sub: isAr ? `${nf(o.listings_with_price_area)} بسعر ومساحة` : `${nf(o.listings_with_price_area)} with price + area` },
    { icon: <MapPin size={18} />, label: isAr ? 'أحياء مغطاة' : 'Districts covered', value: nf(o.districts_covered) },
    { icon: <Users size={18} />, label: isAr ? 'طلب العملاء النشط' : 'Active client demand', value: nf(o.active_client_demand), sub: isAr ? '(حسب الأحياء)' : '(by district)' },
    { icon: <LineChart size={18} />, label: isAr ? 'شرائح المؤشرات' : 'Benchmark segments', value: nf(o.benchmark_segments) },
    { icon: <AlertTriangle size={18} />, label: isAr ? 'فجوات في المخزون' : 'Verified supply gaps', value: nf(o.verified_supply_gaps), sub: isAr ? 'طلب بلا مخزون لدينا' : 'demand, no Wassel supply', tone: 'warn' },
    { icon: <ShieldCheck size={18} />, label: isAr ? 'أحياء عالية الفرص' : 'High-opportunity districts', value: nf(o.high_opportunity_districts), tone: 'good' },
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {cards.map((c, i) => (
          <div key={i} className={`card p-4 ${c.tone === 'warn' ? 'ring-1 ring-amber-200' : c.tone === 'good' ? 'ring-1 ring-emerald-200' : ''}`}>
            <div className="mb-2 flex items-center gap-2 text-charcoal/50">{c.icon}</div>
            <div className="text-2xl font-bold text-charcoal">{c.value}</div>
            <div className="mt-1 text-[12px] font-semibold text-charcoal/60">{c.label}</div>
            {c.sub && <div className="mt-0.5 text-[11px] text-charcoal/40">{c.sub}</div>}
          </div>
        ))}
      </div>
      <div className="card p-4">
        <div className="mb-2 text-sm font-bold text-charcoal">{isAr ? 'ثقة المؤشرات' : 'Benchmark confidence'}</div>
        <div className="flex gap-4 text-sm">
          <span className="text-emerald-700">● {isAr ? 'مرتفعة' : 'High'}: <b>{o.confidence_counts.high}</b></span>
          <span className="text-amber-700">● {isAr ? 'متوسطة' : 'Medium'}: <b>{o.confidence_counts.medium}</b></span>
          <span className="text-rose-700">● {isAr ? 'منخفضة' : 'Low'}: <b>{o.confidence_counts.low}</b></span>
        </div>
        <div className="mt-3 text-[12px] text-charcoal/50">
          {o.has_transaction_data
            ? (isAr ? 'تتوفر بيانات صفقات فعلية لبعض الشرائح.' : 'Transaction data available for some segments.')
            : (isAr ? 'لا تتوفر بيانات صفقات فعلية بعد — المؤشرات مبنية على الأسعار المعروضة فقط.' : 'No transaction data yet — benchmarks are asking-only.')}
        </div>
      </div>
    </div>
  );
}
