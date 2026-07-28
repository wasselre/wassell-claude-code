/**
 * إدارة التسويق — Internal Marketing Management (execution).
 *
 * Sibling to, and deliberately separate from, /marketing-intelligence
 * (ذكاء التسويق), which watches COMPETITORS. This page runs OUR OWN pipeline:
 * strategy → campaign → content → production → approval → schedule → publish →
 * performance → CRM outcome.
 *
 * Everything here is a real record. The status machine, version locking, task
 * dependencies and role capabilities are all enforced in the DATABASE — when
 * this UI shows an error it is repeating what Postgres refused, not simulating
 * a rule. A 403 means the caller's marketing role genuinely cannot do it.
 *
 * Honest states throughout: a metric that was never recorded renders "—", not 0.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import {
  ClipboardList, RefreshCw, AlertTriangle, ArrowLeft, Clock,
  CheckCircle2, Send, Layers, Target, CalendarDays, Image as ImageIcon,
  BadgeCheck, BarChart3, Clapperboard, CalendarPlus, Link as LinkIcon,
  Compass, Boxes, ClipboardCheck,
} from 'lucide-react';
import CampaignsTab from './components/CampaignsTab';
import { ApprovalsTab, PublishingTab, PerformanceTab } from './components/QueueTabs';
import { CalendarTab, AssetsTab } from './components/PlanningTabs';
import { SceneEditor, SlideEditor } from './components/ProductionEditor';
import { ContentFields, VersionWriter } from './components/ContentEditor';
import { ContentSummary, ContentResults } from './components/ContentSummary';
import { StrategyPlanningTab, PortfolioTab, ReviewsTab } from './components/PlanningV2';
import { ContentBoard, ContentDetail as ContentDetailView } from './components/content/ContentModule';
import { CapacityView } from './components/CapacityView';
import { SectionBoundary } from './components/SectionBoundary';
import { ContentContextPanel } from './components/ContentContextPanel';
import { PLATFORM_LABEL, ASSET_TYPE_LABEL, lbl } from '@/lib/marketingMgmt/labels';
// Generic presentation primitives shared with the intelligence page — importing
// rather than duplicating; they carry no intelligence-specific types.
import { Section, Stat, CaveatStrip, EmptyHint, Spinner, fmtDate } from '@/pages/MarketingIntelligence/components/shared';
import {
  fetchOverview, generateAlerts, fetchContentList, fetchContentDetail,
  transitionContent, updateTask, savePublication, fetchAssets, linkAsset,
  STATUS_LABEL, PLATFORMS,
  type MgmtOverview, type ContentItem, type ContentDetail, type ContentStatus,
} from '@/lib/marketingMgmt/client';

type Tab = 'overview' | 'strategy' | 'portfolio' | 'campaigns' | 'content' | 'calendar'
  | 'production' | 'assets' | 'publishing' | 'approvals' | 'performance' | 'reviews';

/** Section nav. At module scope so the error boundary can name the section that
 *  failed from the SAME source the tab bar renders from — a second copy of these
 *  labels would drift the moment a section is renamed. */
const NAV = [
  ['overview', ClipboardList, 'نظرة عامة', 'Overview'],
  ['strategy', Compass, 'الاستراتيجية والتخطيط', 'Strategy & Planning'],
  ['portfolio', Boxes, 'المحفظة', 'Portfolio'],
  ['campaigns', Target, 'الحملات', 'Campaigns'],
  ['content', Layers, 'المحتوى', 'Content'],
  ['calendar', CalendarDays, 'التقويم', 'Calendar'],
  ['production', Clapperboard, 'الإنتاج', 'Production'],
  ['assets', ImageIcon, 'المواد الخام', 'Raw Assets'],
  ['publishing', Send, 'النشر', 'Publishing'],
  ['approvals', BadgeCheck, 'الاعتمادات', 'Approvals'],
  ['performance', BarChart3, 'الأداء', 'Performance'],
  ['reviews', ClipboardCheck, 'المراجعات', 'Reviews'],
] as const;

export default function MarketingManagementPage() {
  const { language, addToast } = useAppStore();
  const isAr = language === 'ar';

  const [tab, setTab] = useState<Tab>('overview');
  const [ov, setOv] = useState<MgmtOverview | null>(null);
  const [content, setContent] = useState<ContentItem[]>([]);
  const [detail, setDetail] = useState<ContentDetail | null>(null);
  /** The canonical content module owns its own selection; the legacy
   *  `detail` above still serves the production/calendar tabs. */
  const [contentId, setContentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true); setError(null);
    Promise.all([fetchOverview(12), fetchContentList({ limit: 300 })])
      .then(([o, c]) => { setOv(o.overview); setContent(c.content); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  /** Merge a field-level update without refetching. content_detail runs eleven
   *  parallel queries; doing that on every blur is what made typing feel like
   *  the page kept reloading. */
  const patchItem = useCallback((item: ContentItem) => {
    setDetail((d) => (d && d.item.id === item.id ? { ...d, item } : d));
  }, []);

  const openItem = async (id: string) => {
    setBusy(true);
    try { setDetail(await fetchContentDetail(id)); }
    catch (e) { addToast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setBusy(false); }
  };

  const move = async (id: string, to: ContentStatus) => {
    setBusy(true);
    try {
      await transitionContent(id, to);
      addToast(isAr ? 'تم تحديث الحالة' : 'Status updated', 'success');
      load(); if (detail?.item.id === id) await openItem(id);
    } catch (e) {
      // The DB rejected it (invalid jump / missing capability) — say exactly that.
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); }
  };


  const completeTask = async (taskId: string) => {
    setBusy(true);
    try {
      await updateTask(taskId, { status: 'completed' });
      if (detail) await openItem(detail.item.id);
    } catch (e) { addToast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setBusy(false); }
  };

  const runAlerts = async () => {
    setBusy(true);
    try {
      const r = await generateAlerts();
      const n = r.rules.reduce((a, x) => a + (x.emitted ?? 0), 0);
      addToast(isAr ? `تم توليد ${n} تنبيه` : `${n} alerts generated`, 'success');
      load();
    } catch (e) { addToast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setBusy(false); }
  };

  // Board cards need a project name and an owner name; both come from data the
  const inProduction = useMemo(
    () => content.filter((c) => ['approved_for_production','raw_assets_required','recording',
      'designing','editing','internal_review','revision_requested'].includes(c.status)),
    [content]);

  const k = ov?.kpis;
  const money = (v: number | null | undefined) =>
    v === null || v === undefined ? null : `${Math.round(v).toLocaleString()} ${isAr ? 'ر.س' : 'SAR'}`;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-copper/10 text-copper">
            <ClipboardList className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-lg font-bold text-charcoal">{isAr ? 'إدارة التسويق' : 'Marketing Management'}</h1>
            <p className="text-[12px] text-charcoal/50">
              {isAr ? 'من الفكرة إلى النشر إلى النتيجة' : 'From idea to publication to outcome'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={runAlerts} disabled={busy}>
            <AlertTriangle className="h-4 w-4" />{isAr ? 'فحص التنبيهات' : 'Run alerts'}
          </Button>
          <Button variant="secondary" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />{isAr ? 'تحديث' : 'Refresh'}
          </Button>
        </div>
      </header>

      {error && <CaveatStrip>{isAr ? 'تعذّر التحميل: ' : 'Failed to load: '}{error}</CaveatStrip>}

      <nav className="flex flex-wrap items-center gap-1.5">
        {NAV.map(
          ([id, Icon, ar, en]) => {
            const active = tab === id;
            return (
              <button key={id} type="button" onClick={() => { setTab(id as Tab); setDetail(null); }}
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[13px] font-medium transition ${
                  active ? 'border-copper bg-copper text-white'
                         : 'border-sand/60 bg-white text-charcoal/70 hover:border-copper/40 hover:text-charcoal'}`}>
                <Icon className="h-3.5 w-3.5" />{isAr ? ar : en}
                {id === 'content' && <span className={active ? 'text-white/70' : 'text-charcoal/35'}>{content.length}</span>}
              </button>
            );
          })}
      </nav>

      {loading && !ov ? <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} /> : (
        // One failing section must not blank the page. Keyed by tab, so leaving a
        // broken section and returning retries it instead of showing a stale error.
        <SectionBoundary isAr={isAr} resetKey={tab}
          label={(NAV.find(([id]) => id === tab)?.[isAr ? 2 : 3] as string) ?? tab}>
          {tab === 'overview' && k && ov && (
            <>
              <Section title={isAr ? 'مؤشرات هذا الشهر' : 'This month'}
                subtitle={isAr ? 'كل رقم هنا عدّ فعلي من قاعدة البيانات' : 'Every number is a real database count'}
                right={<span className="text-[11.5px] text-charcoal/40">{fmtDate(ov.generated_at, isAr)}</span>}>
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
                  <Stat label={isAr ? 'مخطط' : 'Planned'} value={k.planned_this_month} />
                  <Stat label={isAr ? 'قيد الإنتاج' : 'In production'} value={k.in_production} />
                  <Stat label={isAr ? 'بانتظار الاعتماد' : 'Awaiting approval'} value={k.awaiting_approval}
                        tone={k.awaiting_approval > 0 ? 'warn' : 'default'} />
                  <Stat label={isAr ? 'جاهز للنشر' : 'Ready'} value={k.ready_to_publish} />
                  <Stat label={isAr ? 'مجدول' : 'Scheduled'} value={k.scheduled} />
                  <Stat label={isAr ? 'نُشر' : 'Published'} value={k.published_this_month} />
                  <Stat label={isAr ? 'متأخر' : 'Late'} value={k.late} tone={k.late > 0 ? 'warn' : 'default'} />
                  <Stat label={isAr ? 'محجوب' : 'Blocked'} value={k.blocked} tone={k.blocked > 0 ? 'warn' : 'default'} />
                  <Stat label={isAr ? 'حملات عضوية' : 'Organic campaigns'} value={k.active_organic_campaigns} />
                  <Stat label={isAr ? 'حملات مدفوعة' : 'Paid campaigns'} value={k.active_paid_campaigns} />
                  <Stat label={isAr ? 'عملاء محتملون' : 'Leads'} value={k.leads_attributed} />
                  <Stat label={isAr ? 'إيراد منسوب' : 'Revenue'} value={money(k.revenue_attributed)}
                        hint={isAr ? 'المسجَّل فقط' : 'recorded only'} tone="muted" />
                </div>
                <div className="mt-3">
                  <CaveatStrip>{isAr ? (ov.coverage.note_ar ?? ov.coverage.note) : ov.coverage.note}</CaveatStrip>
                </div>
              </Section>

              {ov.alerts.length > 0 && (
                <Section title={isAr ? 'تنبيهات تشغيلية' : 'Operational alerts'}>
                  <ul className="space-y-2">
                    {ov.alerts.map((a) => (
                      <li key={a.id} className="flex items-start gap-3 rounded-xl border border-sand/50 bg-white px-4 py-3">
                        <span className={`mt-0.5 inline-flex shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          a.severity === 'critical' ? 'border-red-200 bg-red-50 text-red-700'
                          : a.severity === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-800'
                          : 'border-sky-200 bg-sky-50 text-sky-700'}`}>
                          {a.severity === 'critical' ? (isAr ? 'حرج' : 'Critical') : a.severity === 'warning' ? (isAr ? 'تنبيه' : 'Warning') : (isAr ? 'معلومة' : 'Info')}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium text-charcoal">{isAr ? a.title_ar : a.title_en}</div>
                          <div className="mt-0.5 text-[11px] text-charcoal/45">{a.kind} · {fmtDate(a.generated_at, isAr)}</div>
                        </div>
                        {a.target_type === 'content_item' && (
                          <button type="button" onClick={() => { setTab('content'); void openItem(a.target_id); }}
                            className="shrink-0 text-[12px] font-medium text-copper hover:underline">
                            {isAr ? 'فتح' : 'Open'}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              <div className="grid gap-4 lg:grid-cols-2">
                <Section title={isAr ? 'متأخر' : 'Overdue'}>
                  {ov.overdue.length === 0 ? <EmptyHint>{isAr ? 'لا يوجد متأخر' : 'Nothing overdue'}</EmptyHint> : (
                    <ul className="divide-y divide-sand/40">
                      {ov.overdue.map((o) => (
                        <li key={o.id}>
                          <button type="button" onClick={() => { setTab('content'); void openItem(o.id); }}
                            className="flex w-full items-center justify-between gap-2 py-2.5 text-start hover:bg-cream-light">
                            <span className="min-w-0 truncate text-[13px] text-charcoal">{o.content_number} · {o.title}</span>
                            <span className="shrink-0 text-[11.5px] text-amber-700">
                              {isAr ? `${o.days_late} يوم` : `${o.days_late}d late`}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>

                <Section title={isAr ? 'طابور الاعتماد' : 'Approval queue'}>
                  {ov.approval_queue.length === 0 ? <EmptyHint>{isAr ? 'لا شيء بانتظار الاعتماد' : 'Nothing awaiting approval'}</EmptyHint> : (
                    <ul className="divide-y divide-sand/40">
                      {ov.approval_queue.map((a) => (
                        <li key={a.id} className="flex items-center justify-between gap-2 py-2.5">
                          <span className="min-w-0 truncate text-[13px] text-charcoal">{a.content_number ?? '—'} · {a.title ?? a.stage}</span>
                          <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-charcoal/50">
                            <Clock className="h-3 w-3" />{a.hours_waiting}h
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>

                <Section title={isAr ? 'طابور النشر' : 'Publishing queue'}>
                  {ov.publishing_queue.length === 0 ? <EmptyHint>{isAr ? 'لا نشر مجدول' : 'Nothing scheduled'}</EmptyHint> : (
                    <ul className="divide-y divide-sand/40">
                      {ov.publishing_queue.map((p) => (
                        <li key={p.id} className="flex items-center justify-between gap-2 py-2.5">
                          <span className="min-w-0 truncate text-[13px] text-charcoal">{p.title}</span>
                          <span className="flex shrink-0 items-center gap-2 text-[11.5px]">
                            <span className="capitalize text-charcoal/50">{p.platform}</span>
                            {!p.has_approved_version && (
                              <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-red-700">
                                {isAr ? 'بلا نسخة معتمدة' : 'no approved version'}
                              </span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>

                <Section title={isAr ? 'نُشر مؤخراً' : 'Recently published'}>
                  {ov.recently_published.length === 0 ? <EmptyHint>{isAr ? 'لا يوجد' : 'None yet'}</EmptyHint> : (
                    <ul className="divide-y divide-sand/40">
                      {ov.recently_published.map((p) => (
                        <li key={p.id} className="flex items-center justify-between gap-2 py-2.5">
                          <span className="min-w-0 truncate text-[13px] text-charcoal">{p.title}</span>
                          <span className="shrink-0 text-[11.5px] text-charcoal/50">
                            {p.has_performance ? (isAr ? 'له أداء' : 'has data')
                                                : <span className="text-amber-700">{isAr ? 'بلا بيانات أداء' : 'no performance data'}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              </div>
            </>
          )}

          {tab === 'campaigns' && (
            <CampaignsTab isAr={isAr} onOpenContent={(id) => { setTab('content'); void openItem(id); }}
              onGoToPortfolio={() => setTab('portfolio')} />
          )}
          {tab === 'calendar' && (
            <div className="space-y-4">
              {/* Capacity sits above the month grid: the calendar is where slots
                  are decided, so the arithmetic that constrains them belongs here
                  rather than inside any one campaign. */}
              <CapacityView isAr={isAr} onError={(m: string) => addToast(m, 'error')}
                onToast={(m: string) => addToast(m, 'success')} />
              <CalendarTab isAr={isAr} onError={(m: string) => addToast(m, 'error')}
                onOpenContent={(id) => { setTab('content'); void openItem(id); }} />
            </div>
          )}
          {tab === 'strategy' && (
            <StrategyPlanningTab isAr={isAr} onError={(m: string) => addToast(m, 'error')}
              onToast={(m: string) => addToast(m, 'success')} />
          )}
          {tab === 'portfolio' && (
            <PortfolioTab isAr={isAr} onError={(m: string) => addToast(m, 'error')}
              onToast={(m: string) => addToast(m, 'success')} />
          )}
          {tab === 'reviews' && (
            <ReviewsTab isAr={isAr} onError={(m: string) => addToast(m, 'error')}
              onToast={(m: string) => addToast(m, 'success')} />
          )}
          {tab === 'assets' && <AssetsTab isAr={isAr} onError={(m: string) => addToast(m, 'error')} />}
          {tab === 'publishing' && <PublishingTab isAr={isAr} onError={(m: string) => addToast(m, 'error')} />}
          {tab === 'approvals' && <ApprovalsTab isAr={isAr} onError={(m: string) => addToast(m, 'error')} />}
          {tab === 'performance' && <PerformanceTab isAr={isAr} onError={(m: string) => addToast(m, 'error')} />}

          {tab === 'production' && (
            detail ? (
              <ContentDetailPanel detail={detail} isAr={isAr} busy={busy}
                onBack={() => setDetail(null)} onMove={move} onCompleteTask={completeTask}
                onChanged={() => { void openItem(detail.item.id); }}
                onItemPatched={patchItem}
                onError={(m: string) => addToast(m, 'error')} />
            ) : (
              <Section title={isAr ? 'الإنتاج' : 'Production'}
                subtitle={isAr ? 'اختر عملاً قيد الإنتاج لتحرير مشاهده أو شرائحه' : 'Pick an in-production item to edit its scenes or slides'}>
                {inProduction.length === 0 ? (
                  <EmptyHint>{isAr ? 'لا شيء قيد الإنتاج حالياً' : 'Nothing in production right now'}</EmptyHint>
                ) : (
                  <ul className="divide-y divide-sand/40">
                    {inProduction.map((c) => (
                      <li key={c.id}>
                        <button type="button" onClick={() => void openItem(c.id)}
                          className="flex w-full items-center justify-between gap-2 py-2.5 text-start hover:bg-cream-light">
                          <span className="min-w-0 truncate text-[13px] text-charcoal">{c.content_number} · {c.title}</span>
                          <span className="shrink-0 text-[11.5px] text-charcoal/50">
                            {isAr ? STATUS_LABEL[c.status].ar : STATUS_LABEL[c.status].en}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            )
          )}

          {/* The canonical content module: one board, one detail surface, one
              service layer. Everything below the brief is per-deliverable. */}
          {tab === 'content' && (
            contentId ? (
              <ContentDetailView id={contentId} isAr={isAr}
                onBack={() => setContentId(null)}
                onError={(m: string) => addToast(m, 'error')}
                onToast={(m: string) => addToast(m, 'success')}
                onChanged={() => {}} />
            ) : (
              <ContentBoard isAr={isAr} onOpen={setContentId}
                onError={(m: string) => addToast(m, 'error')}
                onToast={(m: string) => addToast(m, 'success')} />
            )
          )}
        </SectionBoundary>
      )}
    </div>
  );
}

type DetailTab = 'overview' | 'write' | 'produce' | 'tasks' | 'publish';

function ContentDetailPanel({
  detail, isAr, busy, onBack, onMove, onCompleteTask, onChanged, onItemPatched, onError,
}: {
  detail: ContentDetail; isAr: boolean; busy: boolean;
  onBack: () => void; onMove: (id: string, to: ContentStatus) => void; onCompleteTask: (id: string) => void;
  /** Structural change — a version, scene, publication or link was added, so the
   *  whole detail is refetched. */
  onChanged: () => void;
  /** A FIELD changed. The updated row is merged in place: refetching
   *  content_detail on every blur fires eleven queries and re-renders the panel
   *  mid-typing, which is what made the form feel like it kept reloading. */
  onItemPatched: (item: ContentItem) => void;
  onError: (m: string) => void;
}) {
  const i = detail.item;
  const [sub, setSub] = useState<DetailTab>('overview');
  // One central content entity, different production surface by type — this is
  // the specialisation point, NOT a second parallel system for video vs posts.
  const isVideo = ['reel','tiktok_video','snapchat_video','long_form_video','paid_video_ad',
    'property_tour','drone_video','presenter_video','ai_video','motion_graphics'].includes(i.content_type);
  const isCarousel = ['carousel','static_image','infographic','paid_image_ad'].includes(i.content_type);
  const openTasks = detail.tasks.filter((t) => t.status !== 'completed').length;

  // The panel used to be one endless scroll: header, 17 status chips, 20 fields,
  // versions, scenes, checklist, history, publications. Same content, grouped by
  // the job you came to do, so the part you want is never five screens down.
  const SUBTABS: Array<[DetailTab, string, string, number | null]> = [
    ['overview', 'نظرة', 'Overview', null],
    ['write',    'الكتابة', 'Write', detail.versions.length || null],
    ['produce',  'الإنتاج', 'Produce', (isVideo ? detail.scenes.length : detail.slides.length) || null],
    ['tasks',    'المهام', 'Tasks', openTasks || null],
    ['publish',  'النشر والنتيجة', 'Publish & results', detail.publications.length || null],
  ];

  return (
    <div className="space-y-4">
      <Button variant="secondary" onClick={onBack}>
        <ArrowLeft className={`h-4 w-4 ${isAr ? 'rotate-180' : ''}`} />{isAr ? 'رجوع' : 'Back'}
      </Button>

      <ContentSummary detail={detail} isAr={isAr} busy={busy} onMove={onMove} onError={onError} />

      <div className="flex flex-wrap gap-1.5 border-b border-sand/50 pb-2">
        {SUBTABS.map(([key, ar, en, count]) => (
          <button key={key} type="button" onClick={() => setSub(key)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] transition-colors ${
              sub === key ? 'bg-copper text-white' : 'text-charcoal/60 hover:bg-cream-light hover:text-charcoal'}`}>
            {isAr ? ar : en}
            {count != null && (
              <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${
                sub === key ? 'bg-white/25' : 'bg-charcoal/10'}`}>{count}</span>
            )}
          </button>
        ))}
      </div>

      {sub === 'overview' && (
        <div className="space-y-3">
          {/* Strategic context first: it is what the approval gate checks, so
              seeing it before the creative fields is the difference between
              filling it in and discovering it as a rejection. */}
          <ContentContextPanel item={i} isAr={isAr} onSaved={onItemPatched} onError={onError} />
          <ContentFields item={i} assets={detail.assets} isAr={isAr} onSaved={onItemPatched} onError={onError} />
        </div>
      )}

      {sub === 'write' && (
        <VersionWriter item={i} versions={detail.versions} isAr={isAr}
          onChanged={onChanged} onError={onError} />
      )}

      {sub === 'produce' && (
        <div className="space-y-4">
          {isVideo && (
            <SceneEditor contentItemId={i.id} scenes={detail.scenes} isAr={isAr}
              onChanged={onChanged} onError={onError} />
          )}
          {isCarousel && (
            <SlideEditor contentItemId={i.id} slides={detail.slides} isAr={isAr}
              onChanged={onChanged} onError={onError} />
          )}
          {!isVideo && !isCarousel && (
            <Section title={isAr ? 'الإنتاج' : 'Production'}>
              <EmptyHint>
                {isAr ? 'هذا النوع لا يحتاج مشاهد أو شرائح.' : 'This content type needs neither scenes nor slides.'}
              </EmptyHint>
            </Section>
          )}
          <LinkedAssets detail={detail} isAr={isAr} onChanged={onChanged} onError={onError} />
        </div>
      )}

      {sub === 'tasks' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title={isAr ? 'قائمة الإنتاج' : 'Production checklist'}>
            {detail.tasks.length === 0 ? <EmptyHint>{isAr ? 'لا مهام' : 'No tasks'}</EmptyHint> : (
              <ul className="divide-y divide-sand/40">
                {detail.tasks.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <CheckCircle2 className={`h-4 w-4 shrink-0 ${t.status === 'completed' ? 'text-emerald-600' : 'text-charcoal/20'}`} />
                      <span className={`truncate text-[12.5px] ${t.status === 'completed' ? 'text-charcoal/40 line-through' : 'text-charcoal'}`}>{t.title}</span>
                    </span>
                    {t.status === 'blocked' ? (
                      <span className="shrink-0 text-[11px] text-amber-700">{isAr ? 'محجوب' : 'blocked'}</span>
                    ) : t.status !== 'completed' ? (
                      <button type="button" disabled={busy} onClick={() => onCompleteTask(t.id)}
                        className="shrink-0 text-[11.5px] font-medium text-copper hover:underline disabled:opacity-40">
                        {isAr ? 'إنهاء' : 'Complete'}
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title={isAr ? 'سجل الحالة' : 'Status history'}
            subtitle={isAr ? 'غير قابل للتعديل' : 'Append-only'}>
            {detail.history.length === 0 ? <EmptyHint>—</EmptyHint> : (
              <ul className="divide-y divide-sand/40">
                {detail.history.slice(0, 12).map((h) => (
                  <li key={h.id} className="flex items-center justify-between gap-2 py-2 text-[12px]">
                    <span className="text-charcoal/75">
                      {h.from_status ? `${isAr ? STATUS_LABEL[h.from_status as ContentStatus]?.ar : STATUS_LABEL[h.from_status as ContentStatus]?.en} → ` : ''}
                      {isAr ? STATUS_LABEL[h.to_status as ContentStatus]?.ar : STATUS_LABEL[h.to_status as ContentStatus]?.en}
                    </span>
                    <span className="shrink-0 text-[11px] text-charcoal/40">{fmtDate(h.changed_at, isAr)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}

      {sub === 'publish' && (
        <div className="space-y-4">
          <ScheduleForm detail={detail} isAr={isAr} onChanged={onChanged} onError={onError} />
          <ContentResults detail={detail} isAr={isAr} />
        </div>
      )}
    </div>
  );
}

/**
 * Scheduling — the step that did not exist.
 *
 * Nothing in the app created a publication: the Publishing tab could only mark
 * an EXISTING row published, so approved → scheduled → published was a chain
 * with no first link, and the Calendar and Performance tabs depended on rows
 * that could never appear. publication_save already inserted when given no id;
 * only the UI was missing.
 */
function ScheduleForm({ detail, isAr, onChanged, onError }: {
  detail: ContentDetail; isAr: boolean; onChanged: () => void; onError: (m: string) => void;
}) {
  const i = detail.item;
  const targeted = (i.mkt_content_platforms ?? []).map((p) => p.platform);
  const [platform, setPlatform] = useState<string>(targeted[0] ?? 'instagram');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);

  const scheduled = new Set(detail.publications.map((p) => p.platform));
  const remaining = (targeted.length ? targeted : [...PLATFORMS]).filter((p) => !scheduled.has(p));

  const submit = async () => {
    setBusy(true);
    try {
      await savePublication({
        content_item_id: i.id,
        platform,
        status: when ? 'scheduled' : 'draft',
        scheduled_for: when ? new Date(when).toISOString() : null,
        caption: i.caption ?? null,
      });
      setWhen(''); onChanged();
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const field = 'rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] focus:border-copper focus:outline-none';

  return (
    <Section title={isAr ? 'جدولة النشر' : 'Schedule a publication'}
      subtitle={isAr ? 'ينشئ صفاً لكل منصة — النشر نفسه يدوي'
                     : 'Creates one row per platform — the posting itself is manual'}>
      {targeted.length === 0 && (
        <div className="mb-2.5">
          <CaveatStrip>
            {isAr ? 'لم تُحدَّد منصات مستهدفة لهذا المحتوى — اخترها من «التوجيه التسويقي» أو اختر منصة يدوياً هنا.'
                  : 'No target platforms set on this content — pick them under Marketing direction, or choose one manually here.'}
          </CaveatStrip>
        </div>
      )}
      {remaining.length === 0 ? (
        <EmptyHint>{isAr ? 'كل المنصات المستهدفة مجدولة' : 'Every target platform is scheduled'}</EmptyHint>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-charcoal/55">{isAr ? 'المنصة' : 'Platform'}</span>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className={field}>
              {remaining.map((p) => <option key={p} value={p}>{lbl(PLATFORM_LABEL, p, isAr)}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-charcoal/55">
              {isAr ? 'موعد النشر (اختياري)' : 'Publish at (optional)'}
            </span>
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={field} />
          </label>
          <Button onClick={submit} disabled={busy}>
            <CalendarPlus className="h-4 w-4" />
            {when ? (isAr ? 'جدولة' : 'Schedule') : (isAr ? 'إضافة كمسودة' : 'Add as draft')}
          </Button>
        </div>
      )}
    </Section>
  );
}

/**
 * Linked raw material. content_detail already returned this on every open and
 * nothing rendered it, so the asset library was a library nothing borrowed from.
 */
function LinkedAssets({ detail, isAr, onChanged, onError }: {
  detail: ContentDetail; isAr: boolean; onChanged: () => void; onError: (m: string) => void;
}) {
  const [all, setAll] = useState<Array<Record<string, unknown>>>([]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const linked = new Set(detail.assets.map((a) => a.asset_id));

  useEffect(() => {
    fetchAssets({ limit: 200 }).then((r) => setAll(r.assets)).catch(() => {});
  }, []);

  const attach = async () => {
    if (!pick) return;
    setBusy(true);
    try { await linkAsset(pick, 'content_item', detail.item.id); setPick(''); onChanged(); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const available = all.filter((a) => !linked.has(String(a.id)));

  return (
    <Section title={isAr ? 'المواد المرتبطة' : 'Linked assets'}
      subtitle={isAr ? 'من مكتبة المواد الخام — الملف واحد ويُستخدم في أكثر من مكان'
                     : 'From the raw asset library — one file, reused in many places'}>
      {detail.assets.length === 0 ? (
        <EmptyHint>{isAr ? 'لا مواد مرتبطة بعد' : 'No assets linked yet'}</EmptyHint>
      ) : (
        <ul className="divide-y divide-sand/40">
          {detail.assets.map((a) => {
            const raw = a.mkt_raw_assets ?? {};
            const isFinal = detail.item.final_asset_id === a.asset_id;
            return (
              <li key={a.asset_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[12.5px]">
                <span className="flex min-w-0 items-center gap-2">
                  <ImageIcon className="h-3.5 w-3.5 shrink-0 text-charcoal/30" />
                  <span className="truncate text-charcoal">{String(raw.asset_name ?? a.asset_id)}</span>
                  {isFinal && (
                    <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">
                      {isAr ? 'الملف النهائي' : 'final'}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[11px] text-charcoal/45">
                  {lbl(ASSET_TYPE_LABEL, String(raw.asset_type ?? ''), isAr)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-sand/40 pt-3">
        <select value={pick} onChange={(e) => setPick(e.target.value)}
          className="min-w-[200px] flex-1 rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] focus:border-copper focus:outline-none">
          <option value="">{isAr ? '— اختر مادة لربطها —' : '— pick an asset to link —'}</option>
          {available.map((a) => (
            <option key={String(a.id)} value={String(a.id)}>
              {String(a.asset_name ?? a.id)} · {lbl(ASSET_TYPE_LABEL, String(a.asset_type ?? ''), isAr)}
            </option>
          ))}
        </select>
        <Button onClick={attach} disabled={busy || !pick}>
          <LinkIcon className="h-4 w-4" />{isAr ? 'ربط' : 'Link'}
        </Button>
      </div>
    </Section>
  );
}
