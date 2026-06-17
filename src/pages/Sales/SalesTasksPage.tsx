import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { Phone, MessageCircle, AlertTriangle, ClipboardList } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { telUrl, whatsappUrl } from '@/lib/phone';
import { getFollowUpTypeConfig } from '@/lib/salesProcess';
import type { AppRecord } from '@/types';
import {
  buildQueueItems,
  bucketize,
  computeNoNextAction,
  QUEUE_VIEW_ORDER,
  QUEUE_VIEW_LABELS,
  type QueueViewId,
  type QueueItem,
} from './lib/queueViews';

/** The daily sales work surface — follow-up tasks bucketed into views + the
 *  "active clients with no next action" health audit. Sourced in-memory from
 *  the store (small, realtime-reactive); SLA computed live. */
export default function SalesTasksPage() {
  const { models, records, language, currentUserId, users } = useAppStore();
  const isAr = language === 'ar';
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const qv = searchParams.get('view');
  const [view, setView] = useState<QueueViewId>(
    qv && (QUEUE_VIEW_ORDER as string[]).includes(qv) ? (qv as QueueViewId) : 'my_tasks',
  );
  const [sortDir, setSortDir] = useState<'newest' | 'oldest'>('newest');
  const [filterRep, setFilterRep] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterStage, setFilterStage] = useState('');

  const now = Date.now();
  const followupsModel = models.find((m) => m.name === 'followups');
  const clientsModel = models.find((m) => m.name === 'clients');

  const { buckets, noNextAction } = useMemo(() => {
    const followups: AppRecord[] = followupsModel ? records[followupsModel.id] ?? [] : [];
    const clients: AppRecord[] = clientsModel ? records[clientsModel.id] ?? [] : [];
    const clientsById = new Map(clients.map((c) => [c.id, c.data]));
    const built = buildQueueItems(followups, clientsById, now);
    return {
      buckets: bucketize(built, currentUserId ?? null, now),
      noNextAction: computeNoNextAction(clients, followups),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followupsModel, clientsModel, records, currentUserId]);

  const count = (id: QueueViewId): number => (id === 'no_next_action' ? noNextAction.length : buckets[id].length);
  const repName = (id: string | null) => {
    if (!id) return '';
    const u = users.find((x) => x.id === id);
    return u ? ((isAr ? u.name_ar : u.name_en) || u.email || '') : '';
  };
  const fmt = (iso: string | null) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
  };

  // Triage: filter + sort the active view's items.
  const viewItems: QueueItem[] = view === 'no_next_action' ? [] : buckets[view];
  const repOptions = [...new Set(viewItems.map((i) => i.salesRep).filter(Boolean))] as string[];
  const typeOptions = [...new Set(viewItems.map((i) => i.typeKey).filter(Boolean))] as string[];
  const stageOptions = [...new Set(viewItems.map((i) => i.clientStage).filter(Boolean))] as string[];
  const displayItems = viewItems
    .filter((i) => !filterRep || i.salesRep === filterRep)
    .filter((i) => !filterType || i.typeKey === filterType)
    .filter((i) => !filterStage || i.clientStage === filterStage)
    .slice()
    .sort((a, b) => {
      const av = a.scheduledISO ? new Date(a.scheduledISO).getTime() : 0;
      const bv = b.scheduledISO ? new Date(b.scheduledISO).getTime() : 0;
      return sortDir === 'newest' ? bv - av : av - bv;
    });
  const selectCls = 'rounded-lg border border-sand bg-white px-3 py-1.5 text-sm font-bold text-charcoal transition-colors hover:border-copper focus:border-copper focus:outline-none';

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-5 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-copper/10 text-copper">
          <ClipboardList size={22} />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-chocolate">{isAr ? 'مهام المبيعات' : 'Sales Tasks'}</h1>
          <p className="text-sm text-charcoal/60">{isAr ? 'قائمة متابعاتك اليومية' : 'Your daily follow-up list'}</p>
        </div>
      </header>

      {/* health banner */}
      {noNextAction.length > 0 && view !== 'no_next_action' && (
        <button
          type="button"
          onClick={() => setView('no_next_action')}
          className="mb-4 flex w-full items-center gap-3 rounded-lg border border-gold bg-cream px-4 py-3 text-start text-sm font-medium text-terracotta transition-colors hover:bg-cream/70"
        >
          <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-terracotta px-1.5 text-xs font-bold text-white">
            {noNextAction.length}
          </span>
          <AlertTriangle size={16} className="shrink-0" />
          {isAr
            ? `${noNextAction.length} عميل نشط بدون إجراء تالٍ — يجب أن يكون صفرًا`
            : `${noNextAction.length} active clients with no next action — should be zero`}
        </button>
      )}

      {/* tabs */}
      <nav className="mb-5 flex flex-wrap gap-x-5 gap-y-1 border-b border-sand">
        {QUEUE_VIEW_ORDER.map((id) => {
          const on = view === id;
          const n = count(id);
          const danger = id === 'no_next_action' || id === 'overdue';
          return (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-1 py-2.5 text-sm transition-colors ${on ? 'border-copper font-bold text-copper' : 'border-transparent text-charcoal hover:text-terracotta'}`}
            >
              {isAr ? QUEUE_VIEW_LABELS[id].ar : QUEUE_VIEW_LABELS[id].en}
              {n > 0 && (
                <span className={`rounded-full px-1.5 py-0.5 text-xs font-bold ${danger && n > 0 ? 'bg-terracotta text-white' : 'bg-sand text-charcoal'}`}>{n}</span>
              )}
            </button>
          );
        })}
      </nav>

      {view === 'no_next_action' ? (
        <>
          <p className="mb-4 rounded-lg bg-cream p-3 text-sm text-charcoal">
            {isAr
              ? 'العملاء النشطون (ليسوا في «غير مؤهل» أو «خاسر» أو «مغلق ناجح») الذين ليس لديهم متابعة مفتوحة. الهدف: صفر.'
              : 'Active clients (not Unqualified / Lost / Closed Won) with no open follow-up. Target: zero.'}
          </p>
          {noNextAction.length === 0 ? (
            <p className="rounded-2xl bg-[#10B981]/10 p-5 text-center font-medium text-[#10B981]">{isAr ? 'كل العملاء النشطين لديهم إجراء تالٍ ✓' : 'Every active client has a next action ✓'}</p>
          ) : (
            <ul className="space-y-3">
              {noNextAction.map((r) => (
                <li key={r.clientId}>
                  <button type="button" onClick={() => navigate(`/model/clients/${r.clientId}`)} className="card flex w-full items-center justify-between p-4 text-start transition-colors hover:bg-cream/60">
                    <span>
                      <span className="font-bold text-chocolate">{r.clientName || (isAr ? 'عميل' : 'Client')}</span>
                      <span dir="ltr" className="ms-2 text-sm text-terracotta">{r.phone}</span>
                    </span>
                    <span className="text-sm text-terracotta">{r.stage}{r.status ? ` · ${r.status}` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          {/* triage controls — sort + filter by rep / type / stage */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-charcoal/70">{displayItems.length}</span>
            <div className="ms-auto flex flex-wrap items-center gap-2">
              <select className={selectCls} value={sortDir} onChange={(e) => setSortDir(e.target.value as 'newest' | 'oldest')}>
                <option value="newest">{isAr ? 'الأحدث أولاً' : 'Newest first'}</option>
                <option value="oldest">{isAr ? 'الأقدم أولاً' : 'Oldest first'}</option>
              </select>
              {repOptions.length > 0 && (
                <select className={selectCls} value={filterRep} onChange={(e) => setFilterRep(e.target.value)}>
                  <option value="">{isAr ? 'كل المندوبين' : 'All reps'}</option>
                  {repOptions.map((r) => <option key={r} value={r}>{repName(r)}</option>)}
                </select>
              )}
              {typeOptions.length > 0 && (
                <select className={selectCls} value={filterType} onChange={(e) => setFilterType(e.target.value)}>
                  <option value="">{isAr ? 'كل الأنواع' : 'All types'}</option>
                  {typeOptions.map((tk) => { const c = getFollowUpTypeConfig(tk); return <option key={tk} value={tk}>{c ? (isAr ? c.label_ar : c.label_en) : tk}</option>; })}
                </select>
              )}
              {stageOptions.length > 0 && (
                <select className={selectCls} value={filterStage} onChange={(e) => setFilterStage(e.target.value)}>
                  <option value="">{isAr ? 'كل المراحل' : 'All stages'}</option>
                  {stageOptions.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              )}
              {(filterRep || filterType || filterStage) && (
                <button type="button" onClick={() => { setFilterRep(''); setFilterType(''); setFilterStage(''); }} className="text-sm font-bold text-copper hover:underline">{isAr ? 'مسح' : 'Clear'}</button>
              )}
            </div>
          </div>
          <QueueList items={displayItems} isAr={isAr} fmt={fmt} repName={repName} navigate={navigate} returnTo={location.pathname + location.search} />
        </>
      )}
    </div>
  );
}

function QueueList({
  items, isAr, fmt, repName, navigate, returnTo,
}: {
  items: QueueItem[];
  isAr: boolean;
  fmt: (iso: string | null) => string;
  repName: (id: string | null) => string;
  navigate: (to: string) => void;
  /** Current Sales Tasks URL — passed to the follow-up so completing it returns here. */
  returnTo: string;
}) {
  if (items.length === 0) {
    return <p className="rounded-2xl bg-cream p-5 text-center text-terracotta">{isAr ? 'لا توجد مهام' : 'No tasks'}</p>;
  }
  return (
    <ul className="space-y-3">
      {items.map((i) => {
        const cfg = getFollowUpTypeConfig(i.typeKey);
        const objective = cfg ? (isAr ? cfg.objective_ar : cfg.objective_en) : '';
        const typeLabel = cfg ? (isAr ? cfg.label_ar : cfg.label_en) : (i.typeKey ?? '');
        const tel = telUrl(i.phone);
        const wa = whatsappUrl(i.phone);
        const channel = cfg?.primary_channel ?? 'call';
        return (
          <li
            key={i.followupId}
            className={`card overflow-hidden p-0 ${i.sla === 'overdue' ? 'border-terracotta' : ''}`}
            style={i.sla === 'overdue' ? { borderInlineStartWidth: '3px', borderInlineStartColor: '#8E4E3A' } : undefined}
          >
            <div className="flex flex-wrap items-stretch justify-between gap-3 p-4">
              <div className="flex shrink-0 items-center">
                {channel === 'whatsapp'
                  ? wa && <a href={wa} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-[#25D366] px-4 py-2.5 text-sm font-bold text-white transition-opacity hover:opacity-90" title="WhatsApp"><MessageCircle size={16} /> {isAr ? 'واتساب' : 'WhatsApp'}</a>
                  : tel && <a href={tel} className="inline-flex items-center gap-2 rounded-lg bg-copper px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-terracotta" title="Call"><Phone size={16} /> {isAr ? 'اتصال' : 'Call'}</a>}
              </div>
              <button type="button" onClick={() => navigate(`/model/followups/${i.followupId}?returnTo=${encodeURIComponent(returnTo)}`)} className="flex-1 text-start">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-chocolate">{i.clientName || (isAr ? 'عميل' : 'Client')}</span>
                  <span dir="ltr" className="text-sm text-terracotta">{i.phone}</span>
                  {i.sla === 'overdue' && <span className="inline-flex items-center gap-1 rounded-full bg-terracotta px-2 py-0.5 text-xs font-bold text-white"><AlertTriangle size={11} /> {isAr ? 'متأخرة' : 'Overdue'}</span>}
                  {(i.priority === 'high' || i.priority === 'urgent') && <span className="rounded-full bg-gold px-2 py-0.5 text-xs font-bold text-white">{i.priority}</span>}
                </div>
                <div className="mt-1 text-sm text-charcoal">
                  <span className="font-bold text-copper">{typeLabel}</span>
                  {objective ? ` — ${objective}` : ''}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-charcoal/70">
                  {i.scheduledISO && <span>{isAr ? 'الاستحقاق: ' : 'Due: '}{fmt(i.scheduledISO)}</span>}
                  {i.attempt != null && <span>{isAr ? `المحاولة ${i.attempt}` : `Attempt ${i.attempt}`}</span>}
                  {i.clientStage && <span>{isAr ? 'المرحلة: ' : 'Stage: '}{i.clientStage}</span>}
                  {i.clientStatus && <span>{isAr ? 'الحالة: ' : 'Status: '}{i.clientStatus}</span>}
                  {repName(i.salesRep) && <span>{isAr ? 'المسؤول: ' : 'Rep: '}{repName(i.salesRep)}</span>}
                </div>
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
