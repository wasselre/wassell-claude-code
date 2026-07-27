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
  ClipboardList, RefreshCw, AlertTriangle, Plus, Search, ArrowLeft, Clock,
  CheckCircle2, Send, Layers, Target, CalendarDays, Image as ImageIcon,
  BadgeCheck, BarChart3, Clapperboard,
} from 'lucide-react';
import CampaignsTab from './components/CampaignsTab';
import { ApprovalsTab, PublishingTab, PerformanceTab } from './components/QueueTabs';
import { CalendarTab, AssetsTab } from './components/PlanningTabs';
import { SceneEditor, SlideEditor } from './components/ProductionEditor';
// Generic presentation primitives shared with the intelligence page — importing
// rather than duplicating; they carry no intelligence-specific types.
import { Section, Stat, CaveatStrip, EmptyHint, Spinner, fmtDate } from '@/pages/MarketingIntelligence/components/shared';
import {
  fetchOverview, generateAlerts, fetchContentList, fetchContentDetail,
  createContent, transitionContent, updateTask,
  CONTENT_STATUSES, STATUS_LABEL, CONTENT_TYPES,
  type MgmtOverview, type ContentItem, type ContentDetail, type ContentStatus, type ContentType,
} from '@/lib/marketingMgmt/client';

type Tab = 'overview' | 'campaigns' | 'content' | 'calendar' | 'production'
  | 'assets' | 'publishing' | 'approvals' | 'performance';

/** Board columns: the production spine, not all 18 states (terminal and
 *  exception states are reachable from the item itself). */
const BOARD: ContentStatus[] = ['idea','brief','writing','awaiting_script_approval',
  'approved_for_production','recording','designing','editing','internal_review',
  'awaiting_final_approval','approved','ready_to_publish','scheduled','published'];

export default function MarketingManagementPage() {
  const { language, addToast } = useAppStore();
  const isAr = language === 'ar';

  const [tab, setTab] = useState<Tab>('overview');
  const [ov, setOv] = useState<MgmtOverview | null>(null);
  const [content, setContent] = useState<ContentItem[]>([]);
  const [detail, setDetail] = useState<ContentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newType, setNewType] = useState<ContentType>('reel');

  const load = useCallback(() => {
    setLoading(true); setError(null);
    Promise.all([fetchOverview(12), fetchContentList({ limit: 300 })])
      .then(([o, c]) => { setOv(o.overview); setContent(c.content); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

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

  const create = async () => {
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      const r = await createContent(newTitle.trim(), newType);
      addToast(isAr ? `تم الإنشاء مع ${r.tasks_generated} مهمة` : `Created with ${r.tasks_generated} tasks`, 'success');
      setCreating(false); setNewTitle(''); load(); await openItem(r.item.id);
    } catch (e) { addToast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setBusy(false); }
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

  const inProduction = useMemo(
    () => content.filter((c) => ['approved_for_production','raw_assets_required','recording',
      'designing','editing','internal_review','revision_requested'].includes(c.status)),
    [content]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? content.filter((c) => c.title.toLowerCase().includes(q) || c.content_number.toLowerCase().includes(q)) : content;
  }, [content, query]);

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
        {([
          ['overview', ClipboardList, 'نظرة عامة', 'Overview'],
          ['campaigns', Target, 'الحملات', 'Campaigns'],
          ['content', Layers, 'المحتوى', 'Content'],
          ['calendar', CalendarDays, 'التقويم', 'Calendar'],
          ['production', Clapperboard, 'الإنتاج', 'Production'],
          ['assets', ImageIcon, 'المواد الخام', 'Raw Assets'],
          ['publishing', Send, 'النشر', 'Publishing'],
          ['approvals', BadgeCheck, 'الاعتمادات', 'Approvals'],
          ['performance', BarChart3, 'الأداء', 'Performance'],
        ] as const).map(
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
        <>
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
                <div className="mt-3"><CaveatStrip>{ov.coverage.note}</CaveatStrip></div>
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
            <CampaignsTab isAr={isAr} onOpenContent={(id) => { setTab('content'); void openItem(id); }} />
          )}
          {tab === 'calendar' && (
            <CalendarTab isAr={isAr} onError={(m: string) => addToast(m, 'error')}
              onOpenContent={(id) => { setTab('content'); void openItem(id); }} />
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

          {tab === 'content' && (
            detail ? (
              <ContentDetailPanel detail={detail} isAr={isAr} busy={busy}
                onBack={() => setDetail(null)} onMove={move} onCompleteTask={completeTask}
                onChanged={() => { void openItem(detail.item.id); }}
                onError={(m: string) => addToast(m, 'error')} />
            ) : (
              <Section title={isAr ? 'لوحة المحتوى' : 'Content board'}
                right={
                  <Button onClick={() => setCreating((v) => !v)}>
                    <Plus className="h-4 w-4" />{isAr ? 'محتوى جديد' : 'New content'}
                  </Button>
                }>
                {creating && (
                  <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-copper/30 bg-copper/5 p-3">
                    <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
                      placeholder={isAr ? 'عنوان المحتوى' : 'Content title'}
                      className="min-w-[200px] flex-1 rounded-lg border border-sand/60 bg-white px-3 py-1.5 text-[13px] focus:border-copper focus:outline-none" />
                    <select value={newType} onChange={(e) => setNewType(e.target.value as ContentType)}
                      className="rounded-lg border border-sand/60 bg-white px-3 py-1.5 text-[13px]">
                      {CONTENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <Button onClick={create} disabled={busy || !newTitle.trim()}>{isAr ? 'إنشاء' : 'Create'}</Button>
                  </div>
                )}
                <div className="relative mb-3">
                  <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal/30 start-3" />
                  <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                    placeholder={isAr ? 'بحث…' : 'Search…'}
                    className="w-full rounded-xl border border-sand/60 bg-white py-2 text-[13px] focus:border-copper focus:outline-none ps-9 pe-3" />
                </div>
                {filtered.length === 0 ? (
                  <EmptyHint>{isAr ? 'لا يوجد محتوى بعد — ابدأ بإنشاء واحد' : 'No content yet — create one to begin'}</EmptyHint>
                ) : (
                  <div className="overflow-x-auto">
                    <div className="flex gap-3 pb-2" style={{ minWidth: 'min-content' }}>
                      {BOARD.map((st) => {
                        const col = filtered.filter((c) => c.status === st);
                        if (col.length === 0) return null;
                        return (
                          <div key={st} className="w-56 shrink-0">
                            <div className="mb-2 flex items-center justify-between px-1">
                              <span className="text-[11.5px] font-semibold text-charcoal/70">
                                {isAr ? STATUS_LABEL[st].ar : STATUS_LABEL[st].en}
                              </span>
                              <span className="text-[11px] tabular-nums text-charcoal/40">{col.length}</span>
                            </div>
                            <ul className="space-y-2">
                              {col.map((c) => (
                                <li key={c.id}>
                                  <button type="button" onClick={() => void openItem(c.id)}
                                    className="w-full rounded-xl border border-sand/50 bg-white p-2.5 text-start hover:border-copper/40">
                                    <div className="text-[12.5px] font-medium text-charcoal line-clamp-2">{c.title}</div>
                                    <div className="mt-1 flex items-center justify-between text-[10.5px] text-charcoal/45">
                                      <span>{c.content_number}</span>
                                      <span>{c.due_date ? fmtDate(c.due_date, isAr) : '—'}</span>
                                    </div>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </Section>
            )
          )}
        </>
      )}
    </div>
  );
}

function ContentDetailPanel({
  detail, isAr, busy, onBack, onMove, onCompleteTask, onChanged, onError,
}: {
  detail: ContentDetail; isAr: boolean; busy: boolean;
  onBack: () => void; onMove: (id: string, to: ContentStatus) => void; onCompleteTask: (id: string) => void;
  onChanged: () => void; onError: (m: string) => void;
}) {
  const i = detail.item;
  // One central content entity, different production surface by type — this is
  // the specialisation point, NOT a second parallel system for video vs posts.
  const isVideo = ['reel','tiktok_video','snapchat_video','long_form_video','paid_video_ad',
    'property_tour','drone_video','presenter_video','ai_video','motion_graphics'].includes(i.content_type);
  const isCarousel = ['carousel','static_image','infographic','paid_image_ad'].includes(i.content_type);
  const done = detail.tasks.filter((t) => t.status === 'completed').length;
  return (
    <div className="space-y-4">
      <Button variant="secondary" onClick={onBack}>
        <ArrowLeft className={`h-4 w-4 ${isAr ? 'rotate-180' : ''}`} />{isAr ? 'رجوع' : 'Back'}
      </Button>

      <Section title={`${i.content_number} · ${i.title}`}
        subtitle={`${i.content_type} · ${isAr ? STATUS_LABEL[i.status].ar : STATUS_LABEL[i.status].en}`}>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat label={isAr ? 'المهام' : 'Tasks'} value={`${done}/${detail.tasks.length}`} />
          <Stat label={isAr ? 'النسخ' : 'Versions'} value={detail.versions.length} />
          <Stat label={isAr ? 'المنشورات' : 'Publications'} value={detail.publications.length} />
          <Stat label={isAr ? 'الاستحقاق' : 'Due'} value={i.due_date ? fmtDate(i.due_date, isAr) : null} />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {CONTENT_STATUSES.filter((s) => s !== i.status).slice(0, 18).map((s) => (
            <button key={s} type="button" disabled={busy} onClick={() => onMove(i.id, s)}
              className="rounded-lg border border-sand/60 bg-white px-2 py-1 text-[11px] text-charcoal/70 hover:border-copper/50 hover:text-charcoal disabled:opacity-40">
              → {isAr ? STATUS_LABEL[s].ar : STATUS_LABEL[s].en}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-charcoal/45">
          {isAr ? 'الانتقالات غير المسموحة سترفضها قاعدة البيانات.' : 'Invalid transitions are rejected by the database.'}
        </p>
      </Section>

      {isVideo && (
        <SceneEditor contentItemId={i.id} scenes={detail.scenes} isAr={isAr}
          onChanged={onChanged} onError={onError} />
      )}
      {isCarousel && (
        <SlideEditor contentItemId={i.id} slides={detail.slides} isAr={isAr}
          onChanged={onChanged} onError={onError} />
      )}

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

        <Section title={isAr ? 'النسخ' : 'Versions'}>
          {detail.versions.length === 0 ? <EmptyHint>{isAr ? 'لا نسخ بعد' : 'No versions yet'}</EmptyHint> : (
            <ul className="divide-y divide-sand/40">
              {detail.versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-2 py-2 text-[12.5px]">
                  <span className="text-charcoal/80">{v.version_type} v{v.version_number}</span>
                  <span className="flex shrink-0 items-center gap-2 text-[11px]">
                    <span className="text-charcoal/50">{v.approval_state}</span>
                    {v.is_locked && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-emerald-700">{isAr ? 'مقفل' : 'locked'}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={isAr ? 'النشر' : 'Publications'}>
          {detail.publications.length === 0 ? <EmptyHint>{isAr ? 'لم يُجدول بعد' : 'Not scheduled yet'}</EmptyHint> : (
            <ul className="divide-y divide-sand/40">
              {detail.publications.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 py-2 text-[12.5px]">
                  <span className="flex items-center gap-1.5 capitalize text-charcoal/80"><Send className="h-3 w-3" />{p.platform}</span>
                  <span className="shrink-0 text-[11px] text-charcoal/50">
                    {p.status} · {p.published_at ? fmtDate(p.published_at, isAr) : p.scheduled_for ? fmtDate(p.scheduled_for, isAr) : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
