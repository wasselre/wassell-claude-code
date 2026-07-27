/**
 * Marketing Intelligence — what competitors are marketing, where, and saying what.
 *
 * NOT to be confused with the sibling "Market Intelligence" page (/market-intelligence),
 * which analyses LISTING data (asking prices, supply, demand). This page analyses
 * COMPETITOR MARKETING: their posts, ads, creatives and the facts extracted from them.
 * Arabic keeps them clearly apart: ذكاء التسويق here vs ذكاء السوق there.
 *
 * ZERO AI in any number on this page. Facts come from DB-trigger extraction over
 * captions/transcripts/OCR; insights come from seven deterministic rules; every
 * rollup is a SQL count. The only model involvement anywhere upstream is reading
 * text out of images, and its output is stored as evidence, not as a conclusion.
 *
 * The coverage strip at the top is not decoration — it is the denominator for
 * every number below it, and it stays visible.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import { Radar, RefreshCw, Search, Bell, FolderOpen, Building2, ArrowLeft } from 'lucide-react';
import { fetchIntelligenceIndex, dismissInsight, type IntelligenceIndex } from '@/lib/marketing/client';
import InsightsFeed from './components/InsightsFeed';
import ProjectPanel from './components/ProjectPanel';
import OrganizationPanel from './components/OrganizationPanel';
import { Section, Stat, CaveatStrip, EmptyHint, Spinner, ShownOf, fmtDate, fmtPrice } from './components/shared';

type Tab = 'insights' | 'projects' | 'organizations';

export default function MarketingIntelligencePage() {
  const { language, addToast } = useAppStore();
  const isAr = language === 'ar';

  const [tab, setTab] = useState<Tab>('insights');
  const [index, setIndex] = useState<IntelligenceIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchIntelligenceIndex(60)
      .then((r) => setIndex(r.index))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDismiss = async (id: string) => {
    try {
      await dismissInsight(id, true);
      setIndex((prev) => prev && ({
        ...prev,
        insights: {
          ...prev.insights,
          rows: prev.insights.rows.filter((r) => r.id !== id),
          shown: prev.insights.shown - 1,
          total: prev.insights.total - 1,
        },
      }));
    } catch (e) {
      addToast(isAr ? 'تعذّر إخفاء التنبيه' : 'Could not dismiss insight', 'error');
      throw e;
    }
  };

  const openProject = (id: string) => { setProjectId(id); setOrgId(null); setTab('projects'); };
  const openOrg = (id: string) => { setOrgId(id); setProjectId(null); setTab('organizations'); };

  const projects = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = index?.projects.rows ?? [];
    return q ? rows.filter((p) => (p.name ?? '').toLowerCase().includes(q) || (p.city ?? '').toLowerCase().includes(q)) : rows;
  }, [index, query]);

  const organizations = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = index?.organizations.rows ?? [];
    return q ? rows.filter((o) => (o.name ?? '').toLowerCase().includes(q) || (o.name_en ?? '').toLowerCase().includes(q)) : rows;
  }, [index, query]);

  const cov = index?.coverage;

  const TABS: Array<{ id: Tab; icon: typeof Bell; ar: string; en: string; count?: number }> = [
    { id: 'insights', icon: Bell, ar: 'التنبيهات', en: 'Insights', count: index?.insights.total },
    { id: 'projects', icon: FolderOpen, ar: 'المشاريع', en: 'Projects', count: index?.projects.total },
    { id: 'organizations', icon: Building2, ar: 'المنشآت', en: 'Organizations', count: index?.organizations.total },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-copper/10 text-copper">
            <Radar className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-bold text-charcoal">{isAr ? 'ذكاء التسويق' : 'Marketing Intelligence'}</h1>
            <p className="text-[12px] text-charcoal/50">
              {isAr ? 'ماذا يسوّق المنافسون، وأين، وبأي رسالة' : 'What competitors market, where, and with what message'}
            </p>
          </div>
        </div>
        <Button variant="secondary" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          {isAr ? 'تحديث' : 'Refresh'}
        </Button>
      </header>

      {error && <CaveatStrip>{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error}</CaveatStrip>}

      {cov && (
        <Section
          title={isAr ? 'نطاق التغطية' : 'Coverage'}
          subtitle={isAr
            ? 'المقام لكل رقم في هذه الصفحة — اقرأه أولاً'
            : 'The denominator for every number on this page — read it first'}
          right={index && <span className="text-[11.5px] text-charcoal/40">{fmtDate(index.generated_at, isAr)}</span>}
        >
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label={isAr ? 'منشورات مجمّعة' : 'Posts collected'} value={cov.posts_total} />
            <Stat label={isAr ? 'حقائق مستخرجة' : 'Facts extracted'} value={cov.facts_total} />
            <Stat
              label={isAr ? 'بانتظار الإسناد' : 'Awaiting attribution'}
              value={cov.posts_awaiting_intelligence}
              tone={cov.posts_awaiting_intelligence > 0 ? 'warn' : 'default'}
              hint={isAr ? 'الحقائق مستخرجة — ينقص قرار المشروع' : 'facts extracted — project decision pending'}
            />
            <Stat label={isAr ? 'بدون قراءة صور' : 'Without OCR'} value={cov.posts_without_ocr} tone="muted" />
            <Stat label={isAr ? 'إسناد مؤكد' : 'Confirmed attributions'} value={cov.attribution.confirmed} />
            <Stat
              label={isAr ? 'إسناد مرشّح' : 'Speculative'}
              value={cov.attribution.speculative}
              tone="muted"
              hint={isAr ? 'غير محتسب في أي رقم' : 'excluded from every count'}
            />
          </div>
          <div className="mt-3"><CaveatStrip>{isAr ? (cov.note_ar ?? cov.note) : cov.note}</CaveatStrip></div>
        </Section>
      )}

      <nav className="flex flex-wrap items-center gap-1.5">
        {TABS.map((tb) => {
          const active = tab === tb.id;
          const Icon = tb.icon;
          return (
            <button
              key={tb.id}
              type="button"
              onClick={() => { setTab(tb.id); setProjectId(null); setOrgId(null); }}
              className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[13px] font-medium transition ${
                active
                  ? 'border-copper bg-copper text-white'
                  : 'border-sand/60 bg-white text-charcoal/70 hover:border-copper/40 hover:text-charcoal'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {isAr ? tb.ar : tb.en}
              {typeof tb.count === 'number' && (
                <span className={`tabular-nums ${active ? 'text-white/70' : 'text-charcoal/35'}`}>{tb.count}</span>
              )}
            </button>
          );
        })}
      </nav>

      {loading && !index ? (
        <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />
      ) : (
        <>
          {tab === 'insights' && index && (
            <Section
              title={isAr ? 'ما الذي تغيّر' : 'What changed'}
              subtitle={isAr
                ? 'سبع قواعد حتمية على دورة العمليات — لا استنتاج نموذجي'
                : 'Seven deterministic rules on the ops cadence — no model inference'}
              right={<ShownOf shown={index.insights.shown} total={index.insights.total} isAr={isAr} />}
            >
              <InsightsFeed
                rows={index.insights.rows}
                isAr={isAr}
                onDismiss={handleDismiss}
                onOpenProject={openProject}
                onOpenOrganization={openOrg}
              />
            </Section>
          )}

          {tab === 'projects' && (
            projectId ? (
              <div className="space-y-3">
                <Button variant="secondary" onClick={() => setProjectId(null)}>
                  <ArrowLeft className={`h-4 w-4 ${isAr ? 'rotate-180' : ''}`} />
                  {isAr ? 'كل المشاريع' : 'All projects'}
                </Button>
                <ProjectPanel projectId={projectId} isAr={isAr} />
              </div>
            ) : (
              <Section
                title={isAr ? 'المشاريع المرصودة' : 'Observed projects'}
                right={index && <ShownOf shown={index.projects.shown} total={index.projects.total} isAr={isAr} />}
              >
                <SearchBox value={query} onChange={setQuery} isAr={isAr} />
                {projects.length === 0 ? (
                  <EmptyHint>{isAr ? 'لا توجد نتائج' : 'No matches'}</EmptyHint>
                ) : (
                  <ul className="divide-y divide-sand/40">
                    {projects.map((p) => {
                      const lo = fmtPrice(p.min_advertised_price);
                      const hi = fmtPrice(p.max_advertised_price);
                      return (
                        <li key={p.project_id}>
                          <button
                            type="button"
                            onClick={() => setProjectId(p.project_id)}
                            className="flex w-full flex-wrap items-center justify-between gap-2 py-2.5 text-start hover:bg-cream-light"
                          >
                            <div className="min-w-0">
                              <span className="text-[13px] font-medium text-charcoal">{p.name ?? '—'}</span>
                              {p.city && <span className="ms-2 text-[11px] text-charcoal/40">{p.city}</span>}
                            </div>
                            <div className="flex items-center gap-3 text-[11.5px] tabular-nums text-charcoal/50">
                              <span>{p.post_count} {isAr ? 'مؤكد' : 'confirmed'}</span>
                              <span className="text-charcoal/30">{p.candidate_post_count} {isAr ? 'مرشّح' : 'spec.'}</span>
                              <span>{p.fact_count} {isAr ? 'حقيقة' : 'facts'}</span>
                              {lo && <span className="text-charcoal/70">{hi && hi !== lo ? `${lo}–${hi}` : lo}</span>}
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Section>
            )
          )}

          {tab === 'organizations' && (
            orgId ? (
              <div className="space-y-3">
                <Button variant="secondary" onClick={() => setOrgId(null)}>
                  <ArrowLeft className={`h-4 w-4 ${isAr ? 'rotate-180' : ''}`} />
                  {isAr ? 'كل المنشآت' : 'All organizations'}
                </Button>
                <OrganizationPanel organizationId={orgId} isAr={isAr} onOpenProject={openProject} />
              </div>
            ) : (
              <Section
                title={isAr ? 'المنشآت المرصودة' : 'Observed organizations'}
                subtitle={isAr
                  ? 'مطوّرون وشركات تسويق — الدور يُقرأ لكل مشروع على حدة'
                  : 'Developers and marketing companies — role is read per project'}
                right={index && <ShownOf shown={index.organizations.shown} total={index.organizations.total} isAr={isAr} />}
              >
                <SearchBox value={query} onChange={setQuery} isAr={isAr} />
                {organizations.length === 0 ? (
                  <EmptyHint>{isAr ? 'لا توجد نتائج' : 'No matches'}</EmptyHint>
                ) : (
                  <ul className="divide-y divide-sand/40">
                    {organizations.map((o) => (
                      <li key={o.organization_id}>
                        <button
                          type="button"
                          onClick={() => setOrgId(o.organization_id)}
                          className="flex w-full flex-wrap items-center justify-between gap-2 py-2.5 text-start hover:bg-cream-light"
                        >
                          <div className="min-w-0">
                            <span className="text-[13px] font-medium text-charcoal">{o.name ?? '—'}</span>
                            {o.hq_city && <span className="ms-2 text-[11px] text-charcoal/40">{o.hq_city}</span>}
                          </div>
                          <div className="flex items-center gap-3 text-[11.5px] tabular-nums text-charcoal/50">
                            <span>{o.project_count} {isAr ? 'مشروع' : 'projects'}</span>
                            <span>{o.post_count} {isAr ? 'منشور' : 'posts'}</span>
                            <span className={o.fact_count === 0 ? 'text-charcoal/25' : ''}>
                              {o.fact_count} {isAr ? 'حقيقة' : 'facts'}
                            </span>
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            )
          )}
        </>
      )}
    </div>
  );
}

function SearchBox({ value, onChange, isAr }: { value: string; onChange: (v: string) => void; isAr: boolean }) {
  return (
    <div className="relative mb-3">
      <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal/30 start-3" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={isAr ? 'بحث…' : 'Search…'}
        className="w-full rounded-xl border border-sand/60 bg-white py-2 text-[13px] text-charcoal placeholder:text-charcoal/35 focus:border-copper focus:outline-none focus:ring-1 focus:ring-copper/30 ps-9 pe-3"
      />
    </div>
  );
}
