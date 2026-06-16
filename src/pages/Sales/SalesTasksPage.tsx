import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
  const selectCls = 'rounded-lg border border-[#D4B896] bg-white px-2 py-1 text-sm text-[#4A4E54]';

  return (
    <div className="mx-auto max-w-6xl p-4">
      <header className="mb-4 flex items-center gap-2">
        <ClipboardList className="text-[#B8734F]" />
        <h1 className="text-xl font-bold text-[#4A2C2A]">{isAr ? 'مهام المبيعات' : 'Sales Tasks'}</h1>
      </header>

      {/* health banner */}
      {noNextAction.length > 0 && view !== 'no_next_action' && (
        <button
          type="button"
          onClick={() => setView('no_next_action')}
          className="mb-3 flex w-full items-center gap-2 rounded-lg border border-[#8E4E3A] bg-[#8E4E3A]/10 px-3 py-2 text-start text-sm text-[#8E4E3A]"
        >
          <AlertTriangle size={16} />
          {isAr
            ? `${noNextAction.length} عميل نشط بدون إجراء تالٍ — يجب أن يكون صفرًا`
            : `${noNextAction.length} active clients with no next action — should be zero`}
        </button>
      )}

      {/* tabs */}
      <nav className="mb-4 flex flex-wrap gap-1 border-b border-[#D4B896]">
        {QUEUE_VIEW_ORDER.map((id) => {
          const on = view === id;
          const n = count(id);
          const danger = id === 'no_next_action' || id === 'overdue';
          return (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${on ? 'border-[#B8734F] font-semibold text-[#B8734F]' : 'border-transparent text-[#4A4E54] hover:text-[#8E4E3A]'}`}
            >
              {isAr ? QUEUE_VIEW_LABELS[id].ar : QUEUE_VIEW_LABELS[id].en}
              {n > 0 && (
                <span className={`ms-1 rounded-full px-1.5 py-0.5 text-xs ${danger && n > 0 ? 'bg-[#8E4E3A] text-white' : 'bg-[#F5EDE0] text-[#4A4E54]'}`}>{n}</span>
              )}
            </button>
          );
        })}
      </nav>

      {view === 'no_next_action' ? (
        <>
          <p className="mb-3 rounded-lg bg-[#F5EDE0] p-2 text-sm text-[#4A4E54]">
            {isAr
              ? 'العملاء النشطون (ليسوا في «غير مؤهل» أو «خاسر» أو «مغلق ناجح») الذين ليس لديهم متابعة مفتوحة. الهدف: صفر.'
              : 'Active clients (not Unqualified / Lost / Closed Won) with no open follow-up. Target: zero.'}
          </p>
          {noNextAction.length === 0 ? (
            <p className="rounded-lg bg-[#10B981]/10 p-4 text-center text-[#10B981]">{isAr ? 'كل العملاء النشطين لديهم إجراء تالٍ ✓' : 'Every active client has a next action ✓'}</p>
          ) : (
            <ul className="space-y-2">
              {noNextAction.map((r) => (
                <li key={r.clientId}>
                  <button type="button" onClick={() => navigate(`/model/clients/${r.clientId}`)} className="flex w-full items-center justify-between rounded-lg border border-[#D4B896] bg-white p-3 text-start hover:bg-[#F5EDE0]">
                    <span>
                      <span className="font-semibold text-[#4A4E54]">{r.clientName || (isAr ? 'عميل' : 'Client')}</span>
                      <span dir="ltr" className="ms-2 text-sm text-[#8E4E3A]">{r.phone}</span>
                    </span>
                    <span className="text-sm text-[#8E4E3A]">{r.stage}{r.status ? ` · ${r.status}` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          {/* triage controls — sort + filter by rep / type / stage */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
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
              <button type="button" onClick={() => { setFilterRep(''); setFilterType(''); setFilterStage(''); }} className="text-sm text-[#B8734F] hover:underline">{isAr ? 'مسح' : 'Clear'}</button>
            )}
            <span className="ms-auto text-sm text-[#8E4E3A]">{displayItems.length}</span>
          </div>
          <QueueList items={displayItems} isAr={isAr} fmt={fmt} repName={repName} navigate={navigate} />
        </>
      )}
    </div>
  );
}

function QueueList({
  items, isAr, fmt, repName, navigate,
}: {
  items: QueueItem[];
  isAr: boolean;
  fmt: (iso: string | null) => string;
  repName: (id: string | null) => string;
  navigate: (to: string) => void;
}) {
  if (items.length === 0) {
    return <p className="rounded-lg bg-[#F5EDE0] p-4 text-center text-[#8E4E3A]">{isAr ? 'لا توجد مهام' : 'No tasks'}</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((i) => {
        const cfg = getFollowUpTypeConfig(i.typeKey);
        const objective = cfg ? (isAr ? cfg.objective_ar : cfg.objective_en) : '';
        const typeLabel = cfg ? (isAr ? cfg.label_ar : cfg.label_en) : (i.typeKey ?? '');
        const tel = telUrl(i.phone);
        const wa = whatsappUrl(i.phone);
        const channel = cfg?.primary_channel ?? 'call';
        return (
          <li key={i.followupId} className="rounded-lg border border-[#D4B896] bg-white p-3" style={i.sla === 'overdue' ? { borderInlineStart: '3px solid #8E4E3A' } : undefined}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <button type="button" onClick={() => navigate(`/model/followups/${i.followupId}`)} className="flex-1 text-start">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[#4A4E54]">{i.clientName || (isAr ? 'عميل' : 'Client')}</span>
                  <span dir="ltr" className="text-sm text-[#8E4E3A]">{i.phone}</span>
                  {i.sla === 'overdue' && <span className="inline-flex items-center gap-1 rounded-full bg-[#8E4E3A] px-1.5 py-0.5 text-xs text-white"><AlertTriangle size={11} /> {isAr ? 'متأخرة' : 'Overdue'}</span>}
                  {(i.priority === 'high' || i.priority === 'urgent') && <span className="rounded-full bg-[#C09B5F] px-1.5 py-0.5 text-xs text-white">{i.priority}</span>}
                </div>
                <div className="mt-0.5 text-sm text-[#8E4E3A]">
                  <span className="font-medium text-[#B8734F]">{typeLabel}</span>
                  {objective ? ` — ${objective}` : ''}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[#8E4E3A]">
                  {i.scheduledISO && <span>{isAr ? 'الاستحقاق: ' : 'Due: '}{fmt(i.scheduledISO)}</span>}
                  {i.attempt != null && <span>{isAr ? `المحاولة ${i.attempt}` : `Attempt ${i.attempt}`}</span>}
                  {i.clientStage && <span>{isAr ? 'المرحلة: ' : 'Stage: '}{i.clientStage}</span>}
                  {i.clientStatus && <span>{isAr ? 'الحالة: ' : 'Status: '}{i.clientStatus}</span>}
                  {repName(i.salesRep) && <span>{isAr ? 'المسؤول: ' : 'Rep: '}{repName(i.salesRep)}</span>}
                </div>
              </button>
              <div className="flex shrink-0 items-center gap-1">
                {channel === 'whatsapp'
                  ? wa && <a href={wa} target="_blank" rel="noreferrer" className="rounded-lg bg-[#25D366] p-2 text-white hover:opacity-90" title="WhatsApp"><MessageCircle size={16} /></a>
                  : tel && <a href={tel} className="rounded-lg bg-[#B8734F] p-2 text-white hover:bg-[#8E4E3A]" title="Call"><Phone size={16} /></a>}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
