/**
 * «الطلبات غير المجابة» — the Sales Workspace tab for clients we could not match.
 *
 * A request is born from the «طلب غير مجاب» follow-up outcome, the Client
 * Options «لم نجد ما يناسبه» button, or Tools → «تسجيل طلب غير مجاب». This tab
 * is where they are WORKED: the unmet-demand picture (what clients ask for that
 * we lack), every open request, and — inside a request — sending it to the
 * real-estate offices of the requested districts and saving what they offer.
 *
 * Scope: reps see requests for their own clients (client owner) or assigned to
 * them; managers/admins see all with a mine/all switch — same rule as My Clients.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Inbox, CheckCircle2, UserX, AlarmClock, Settings2, Radio, Plus } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin, usePermission } from '@/hooks/usePermission';
import Button from '@/components/ui/Button';
import type { AppRecord } from '@/types';
import { fetchLineStatus, fetchOutreach, type LineStatus, type OutreachRow } from '@/lib/officeOutreach/client';
import { describeAsk, formatAmountAr } from '@/lib/officeOutreach/message';
import {
  clientOf, daysSince, firstId, isOpenRequest, ownerIdOf, requestFacts,
} from './requestData';
import RequestDetailModal from './RequestDetailModal';
import OutreachSettingsModal from './OutreachSettingsModal';
import LogRequestFlow from './LogRequestFlow';

const L = (isAr: boolean) => (ar: string, en: string) => (isAr ? ar : en);

export default function UnansweredRequestsSection() {
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const isAr = useAppStore((s) => s.language) === 'ar';
  const t = L(isAr);
  const isManager = useIsAdmin();
  const requestsModelId = models.find((m) => m.name === 'unanswered_requests')?.id ?? '';
  const canLog = usePermission(requestsModelId, 'create');

  const [scope, setScope] = useState<'mine' | 'all'>(isManager ? 'all' : 'mine');
  const [statusFilter, setStatusFilter] = useState<'open' | 'closed' | 'all'>('open');
  // ?request=<id> reopens a request — the record forms opened from a request
  // return here with it (RequestDetailModal passes state.backTo).
  const [searchParams, setSearchParams] = useSearchParams();
  const [openRequestId, setOpenRequestId] = useState<string | null>(() => searchParams.get('request'));
  const closeRequest = () => {
    setOpenRequestId(null);
    if (searchParams.has('request')) {
      const next = new URLSearchParams(searchParams);
      next.delete('request');
      setSearchParams(next, { replace: true });
    }
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [line, setLine] = useState<LineStatus | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);
  const [outreach, setOutreach] = useState<OutreachRow[]>([]);

  const requestsModel = models.find((m) => m.name === 'unanswered_requests') ?? null;
  const clientsModel = models.find((m) => m.name === 'clients') ?? null;
  const tasksModel = models.find((m) => m.name === 'sales_tasks') ?? null;
  const statusField = useMemo(
    () => requestsModel?.schema.sections.flatMap((s) => s.fields).find((f) => f.name === 'request_status') ?? null,
    [requestsModel],
  );

  const clientsById = useMemo(
    () => new Map((clientsModel ? records[clientsModel.id] ?? [] : []).map((r) => [r.id, r])),
    [clientsModel, records],
  );

  // Requests in scope.
  const allRequests = useMemo(() => {
    if (!requestsModel) return [];
    const rows = records[requestsModel.id] ?? [];
    const mine = (r: AppRecord) => {
      const d = r.data as Record<string, unknown>;
      if (ownerIdOf(d.assigned_to) === currentUserId || r.created_by_user_id === currentUserId) return true;
      const client = clientOf(r, clientsById);
      return !!client && ownerIdOf((client.data as Record<string, unknown>).client_owner) === currentUserId;
    };
    const scoped = !isManager || scope === 'mine' ? rows.filter(mine) : rows;
    return scoped.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }, [requestsModel, records, isManager, scope, currentUserId, clientsById]);

  const visible = useMemo(() => allRequests.filter((r) =>
    statusFilter === 'all' ? true : statusFilter === 'open' ? isOpenRequest(r) : !isOpenRequest(r)), [allRequests, statusFilter]);

  // Search tasks per request (the open one = the next search due).
  const openTaskByRequest = useMemo(() => {
    const map = new Map<string, AppRecord>();
    for (const task of tasksModel ? records[tasksModel.id] ?? [] : []) {
      const d = task.data as Record<string, unknown>;
      const st = typeof d.task_status === 'string' && d.task_status ? d.task_status : 'open';
      if (st !== 'open' && st !== 'in_progress') continue;
      const rid = firstId(d.request_id);
      if (!rid) continue;
      const prev = map.get(rid);
      const due = (x: AppRecord) => Date.parse(String((x.data as Record<string, unknown>).due_date ?? '')) || Infinity;
      if (!prev || due(task) < due(prev)) map.set(rid, task);
    }
    return map;
  }, [tasksModel, records]);

  const refreshLine = useCallback(async () => {
    const res = await fetchLineStatus();
    if (res.error !== null) { console.error('[requests] line status failed:', res.error); setLineError(res.error); return; }
    setLineError(null);
    setLine(res.data);
  }, []);

  const requestIdsKey = allRequests.map((r) => r.id).join(',');
  const refreshOutreach = useCallback(async () => {
    const ids = requestIdsKey ? requestIdsKey.split(',') : [];
    const res = await fetchOutreach(ids);
    if (res.error !== null) { console.error('[requests] outreach load failed:', res.error); return; }
    setOutreach(res.data);
  }, [requestIdsKey]);

  useEffect(() => { void refreshLine(); }, [refreshLine]);
  useEffect(() => { void refreshOutreach(); }, [refreshOutreach]);

  const outreachByRequest = useMemo(() => {
    const map = new Map<string, OutreachRow[]>();
    for (const o of outreach) map.set(o.request_id, [...(map.get(o.request_id) ?? []), o]);
    return map;
  }, [outreach]);

  // ── Cards ──
  const now = Date.now();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const counts = useMemo(() => {
    let open = 0, foundMonth = 0, dropped = 0, overdue = 0;
    for (const r of allRequests) {
      const d = r.data as Record<string, unknown>;
      const st = String(d.request_status ?? 'received');
      if (isOpenRequest(r)) open++;
      if (st === 'fulfilled' && Date.parse(String(d.closed_at ?? r.updated_at)) >= monthStart) foundMonth++;
      if (st === 'client_dropped') dropped++;
      const task = openTaskByRequest.get(r.id);
      const due = task ? Date.parse(String((task.data as Record<string, unknown>).due_date ?? '')) : NaN;
      if (isOpenRequest(r) && Number.isFinite(due) && due < now) overdue++;
    }
    return { open, foundMonth, dropped, overdue };
  }, [allRequests, openTaskByRequest, monthStart, now]);

  // ── Unmet demand (open requests) ──
  const store = useMemo(() => ({ models, records }), [models, records]);
  const demand = useMemo(() => {
    const places = new Map<string, number>();
    const types = new Map<string, number>();
    const budgets = new Map<string, number>();
    for (const r of allRequests.filter(isOpenRequest)) {
      const f = requestFacts(r, clientOf(r, clientsById), store);
      for (const p of new Set(f.places)) places.set(p, (places.get(p) ?? 0) + 1);
      for (const ty of new Set(f.unitTypes)) types.set(ty, (types.get(ty) ?? 0) + 1);
      const b = f.budgetMax ?? f.budgetMin;
      if (b) {
        const bucket = b <= 1_000_000 ? t('حتى مليون', 'Up to 1M') : b <= 2_000_000 ? t('1–2 مليون', '1–2M')
          : b <= 3_000_000 ? t('2–3 مليون', '2–3M') : t('أكثر من 3 مليون', 'Over 3M');
        budgets.set(bucket, (budgets.get(bucket) ?? 0) + 1);
      }
    }
    const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    return { places: top(places), types: top(types), budgets: top(budgets) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRequests, clientsById, store, isAr]);

  const statusLabel = (value: string) => {
    const opt = statusField?.options?.find((o) => o.value === value);
    return opt ? { text: isAr ? opt.label_ar : opt.label_en, color: opt.color ?? '#6B7280' } : { text: value, color: '#6B7280' };
  };

  if (!requestsModel) {
    return <div className="card p-8 text-center text-sm text-charcoal/50">{t('نموذج الطلبات غير المجابة غير متاح.', 'The unanswered-requests model is not available.')}</div>;
  }

  const lineBadge = (() => {
    if (lineError) return { text: t('تعذّر قراءة حالة خط المكاتب', 'Could not read the office line status'), cls: 'bg-red-50 text-red-700' };
    if (!line) return null;
    if (!line.device_id || !line.line_active || !line.line_started_on) return { text: t('خط المكاتب غير مضبوط — الإرسال متوقف', 'Office line not set — sending is off'), cls: 'bg-amber-50 text-amber-800' };
    if (line.paused_until && Date.parse(line.paused_until) > now) return { text: t('الإرسال موقوف مؤقتاً (قيد واتساب)', 'Sending paused (WhatsApp restriction)'), cls: 'bg-red-50 text-red-700' };
    if (line.warming_up) return { text: t(`تهيئة الرقم — يبدأ الإرسال في اليوم ${line.next_step_day ?? 4}`, `Line warming up — sending starts on day ${line.next_step_day ?? 4}`), cls: 'bg-amber-50 text-amber-800' };
    return { text: t(`خط المكاتب جاهز · حتى ${line.per_day} مكتب يومياً`, `Office line ready · up to ${line.per_day} offices/day`), cls: 'bg-emerald-50 text-emerald-700' };
  })();

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex flex-wrap items-center gap-2">
        {lineBadge && (
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${lineBadge.cls}`}>
            <Radio size={13} /> {lineBadge.text}
          </span>
        )}
        <div className="ms-auto flex items-center gap-2">
          {isManager && (
            <div className="flex rounded-lg border border-sand/60 bg-white p-0.5 text-xs">
              {(['mine', 'all'] as const).map((s) => (
                <button key={s} type="button" onClick={() => setScope(s)}
                  className={`rounded-md px-2.5 py-1 font-semibold ${scope === s ? 'bg-copper text-white' : 'text-charcoal/60'}`}>
                  {s === 'mine' ? t('طلباتي', 'Mine') : t('كل الطلبات', 'All')}
                </button>
              ))}
            </div>
          )}
          {isManager && (
            <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => setSettingsOpen(true)}>
              <Settings2 size={14} /> {t('إعدادات الإرسال', 'Sending settings')}
            </Button>
          )}
          {canLog && (
            <Button className="px-3 py-1.5 text-xs" onClick={() => setLogOpen(true)}>
              <Plus size={14} /> {t('تسجيل طلب غير مجاب', 'Log an unanswered request')}
            </Button>
          )}
        </div>
      </div>

      {/* Cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { icon: Inbox, label: t('طلبات مفتوحة', 'Open requests'), value: counts.open, color: 'text-copper' },
          { icon: CheckCircle2, label: t('وُجد لها خيار هذا الشهر', 'Found this month'), value: counts.foundMonth, color: 'text-emerald-600' },
          { icon: UserX, label: t('انسحب العميل', 'Client dropped'), value: counts.dropped, color: 'text-terracotta' },
          { icon: AlarmClock, label: t('بحث متأخر', 'Overdue searches'), value: counts.overdue, color: counts.overdue > 0 ? 'text-red-600' : 'text-charcoal/50' },
        ].map((c) => (
          <div key={c.label} className="card rounded-2xl p-4">
            <div className="flex items-center gap-2 text-xs text-charcoal/60"><c.icon size={15} className={c.color} />{c.label}</div>
            <div className={`mt-1 text-2xl font-bold ${c.color}`}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Unmet demand */}
      {counts.open > 0 && (
        <section className="card rounded-2xl p-4">
          <h3 className="mb-1 text-sm font-bold text-chocolate">{t('الطلب غير المُلبّى', 'Unmet demand')}</h3>
          <p className="mb-3 text-xs text-charcoal/55">{t('ما يطلبه العملاء ولا نملكه الآن — هذا ما نحتاج أن نوفّره.', 'What clients ask for that we do not have — what we need to source.')}</p>
          <div className="grid gap-3 md:grid-cols-3">
            {[
              { title: t('المناطق', 'Areas'), rows: demand.places },
              { title: t('نوع الوحدة', 'Unit type'), rows: demand.types },
              { title: t('الميزانية', 'Budget'), rows: demand.budgets },
            ].map((g) => (
              <div key={g.title}>
                <div className="mb-1.5 text-xs font-semibold text-charcoal/60">{g.title}</div>
                {g.rows.length === 0 ? <div className="text-xs text-charcoal/40">—</div> : (
                  <div className="flex flex-wrap gap-1.5">
                    {g.rows.map(([k, n]) => (
                      <span key={k} className="rounded-full border border-sand/60 bg-cream-light px-2.5 py-0.5 text-xs text-charcoal">
                        {k} <b className="text-copper">{n}</b>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Filter */}
      <div className="flex gap-1 border-b border-sand/50 text-sm">
        {([['open', t('مفتوحة', 'Open')], ['closed', t('مغلقة', 'Closed')], ['all', t('الكل', 'All')]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setStatusFilter(k)}
            className={`-mb-px border-b-2 px-3 py-2 font-medium ${statusFilter === k ? 'border-copper text-copper' : 'border-transparent text-charcoal/50'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* List */}
      {visible.length === 0 ? (
        <div className="card rounded-2xl p-8 text-center text-sm text-charcoal/55">
          {statusFilter === 'open'
            ? t('لا توجد طلبات مفتوحة. عندما لا نجد ما يناسب عميلاً سجّل «طلب غير مجاب» — من نتيجة المتابعة، أو «لم نجد ما يناسبه» في خيارات العميل، أو من «أدوات».',
                'No open requests. When nothing fits a client, record an «Unanswered Request» — from a follow-up result, «Nothing fits» on the client\'s options, or Tools.')
            : t('لا توجد طلبات هنا.', 'No requests here.')}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((r) => {
            const d = r.data as Record<string, unknown>;
            const client = clientOf(r, clientsById);
            const cd = (client?.data ?? {}) as Record<string, unknown>;
            const facts = requestFacts(r, client, store);
            const st = statusLabel(String(d.request_status ?? 'received'));
            const task = openTaskByRequest.get(r.id);
            const due = task ? Date.parse(String((task.data as Record<string, unknown>).due_date ?? '')) : NaN;
            const oo = outreachByRequest.get(r.id) ?? [];
            const sent = oo.filter((o) => o.status === 'sent').length;
            const queued = oo.filter((o) => o.status === 'queued').length;
            const replied = oo.filter((o) => o.replied_at).length;
            const age = daysSince(r.created_at);
            const budget = facts.budgetMax ?? facts.budgetMin;
            return (
              <button key={r.id} type="button" onClick={() => setOpenRequestId(r.id)}
                className="card flex w-full flex-col gap-1.5 rounded-2xl p-4 text-start transition hover:border-copper/40 hover:shadow-md">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-bold text-charcoal">{typeof cd.client_name === 'string' && cd.client_name ? cd.client_name : t('عميل', 'Client')}</span>
                  <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-white" style={{ backgroundColor: st.color }}>{st.text}</span>
                  {age !== null && <span className="text-xs text-charcoal/45">{t(`منذ ${age} يوم`, `${age} days open`)}</span>}
                  {Number.isFinite(due) && isOpenRequest(r) && (
                    <span className={`text-xs ${due < now ? 'font-semibold text-red-600' : 'text-charcoal/50'}`}>
                      {t('البحث التالي:', 'Next search:')} {new Date(due).toLocaleDateString(isAr ? 'ar-SA-u-nu-latn' : 'en-GB')}
                    </span>
                  )}
                </div>
                <div className="text-sm text-charcoal/80">{describeAsk(facts)}</div>
                {typeof d.request_notes === 'string' && d.request_notes.trim() && (
                  <div className="line-clamp-2 text-xs text-charcoal/55">«{d.request_notes.trim()}»</div>
                )}
                <div className="flex flex-wrap gap-3 text-xs text-charcoal/55">
                  {budget ? <span>{t('الميزانية', 'Budget')} {formatAmountAr(budget)}</span> : null}
                  {(sent + queued) > 0 && (
                    <span>{t(`المكاتب: أُرسل ${sent} · مجدول ${queued} · ردّ ${replied}`, `Offices: sent ${sent} · queued ${queued} · replied ${replied}`)}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {openRequestId && (
        <RequestDetailModal
          requestId={openRequestId}
          line={line}
          onClose={() => { closeRequest(); void refreshOutreach(); void refreshLine(); }}
          onOutreachChanged={() => { void refreshOutreach(); void refreshLine(); }}
        />
      )}
      {settingsOpen && (
        <OutreachSettingsModal
          line={line}
          onClose={() => setSettingsOpen(false)}
          onSaved={(s) => setLine(s)}
        />
      )}
      {logOpen && <LogRequestFlow onClose={() => setLogOpen(false)} />}
    </div>
  );
}
