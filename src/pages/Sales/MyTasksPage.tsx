import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Phone, MessageCircle, Plus, Sparkles, FolderKanban, Hourglass, CalendarDays, AlertTriangle, Bot, CheckCheck } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import { useIsAdmin, usePermission } from '@/hooks/usePermission';
import { isRetiredModel } from '@/lib/featureFlags';
import { useClientWhatsApp } from '@/pages/Clients/lib/useClientWhatsApp';
import { useAiNotifications } from './lib/useAiNotifications';
import {
  buildFollowupTasks, buildWaitingTasks, tasksForRep, byPriority, priorityTier, isWaitingForCustomer,
  type FollowupChannel, type FollowupTask,
} from './lib/myWork';
import FollowupTaskCard from './components/FollowupTaskCard';

type Section = 'actions' | 'waiting' | 'appointments' | 'ai_notifications' | 'preferences' | 'other';
type ApptBucket = 'today' | 'tomorrow' | 'future' | 'last7' | 'older' | 'no_show';

function ownerIdOf(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const x of v) {
      const id = ownerIdOf(x);
      if (id) return id;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const id = o.user_id ?? o.id;
    return typeof id === 'string' && id ? id : null;
  }
  return typeof v === 'string' && v ? v : null;
}

function firstId(v: unknown): string | null {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null;
  return typeof v === 'string' ? v : null;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const RETURN_TO = '/sales/my-tasks';
const DAY_MS = 24 * 60 * 60 * 1000;

const APPT_STATUS_STYLE: Record<string, string> = {
  scheduled: 'bg-sand/50 text-charcoal',
  confirmed: 'bg-[#10B981]/15 text-[#0f7a52]',
  rescheduled: 'bg-gold/20 text-[#8a6a2f]',
  completed: 'bg-[#10B981]/15 text-[#0f7a52]',
  no_show: 'bg-terracotta text-white',
  cancelled: 'bg-charcoal/10 text-charcoal/60',
};

// AI-notification severity → start-edge stripe + badge (mirrors the task-tier
// stripe idea). warning = a complaint / stop-contact; action = a human must do
// something; info = FYI.
const AI_SEVERITY: Record<'info' | 'action' | 'warning', { stripe: string; badge: string; ar: string; en: string }> = {
  warning: { stripe: '#B5462F', badge: 'bg-terracotta text-white', ar: 'تنبيه', en: 'Warning' },
  action: { stripe: '#B8734F', badge: 'bg-copper text-white', ar: 'إجراء', en: 'Action' },
  info: { stripe: '#C09B5F', badge: 'bg-sand/60 text-charcoal', ar: 'معلومة', en: 'Info' },
};

/**
 * My Tasks — the sales rep's daily work surface (redesigned 2026-07-21,
 * sales-process improvement plan Workstream B):
 *  - Actions: ONE priority-stacked list (hot lead → replied → overdue → today
 *    → quiet), each card striped by urgency. Waiting-on-customer tasks are
 *    excluded — they live in their own tab.
 *  - Waiting for customer: WhatsApp tasks parked with the client (the ball is
 *    theirs); they come back to Actions on reply or on the 24h silence nudge.
 *  - Appointments: Today / Tomorrow / Future / No-shows.
 *  - Plus the existing Incomplete Preferences placeholder and Other Tasks.
 */
export default function MyTasksPage() {
  const navigate = useNavigate();
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const users = useAppStore((s) => s.users);
  const language = useAppStore((s) => s.language);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const initialized = useAppStore((s) => s.initialized);
  const isManager = useIsAdmin();
  const isAr = language === 'ar';

  const { openWhatsApp, whatsAppModals } = useClientWhatsApp();
  const {
    notifications: aiNotifs, unreadCount: aiUnread, loading: aiLoading,
    markRead: markNotifRead, markAllRead: markAllNotifsRead,
  } = useAiNotifications();

  const [section, setSection] = useState<Section>('actions');
  const [channel, setChannel] = useState<FollowupChannel | 'all'>('all');
  const [apptBucket, setApptBucket] = useState<ApptBucket>('today');
  const [showAll, setShowAll] = useState(false); // manager-only: include all reps

  const now = Date.now();

  const followupsModel = models.find((m) => m.name === 'followups');
  const clientsModel = models.find((m) => m.name === 'clients');
  const appointmentsModel = models.find((m) => m.name === 'appointments');
  const tasksModel = models.find((m) => m.name === 'tasks');
  const canCreateTask = usePermission(tasksModel?.id ?? '', 'create');

  // Whole records (not just `data`) — the hot-lead rule needs the client's
  // own `created_at` to tell a brand-new lead from a stale 'جديد' backlog one.
  const clientsById = useMemo(() => {
    const clients = clientsModel ? records[clientsModel.id] ?? [] : [];
    return new Map(clients.map((c) => [c.id, c]));
  }, [clientsModel, records]);

  // Actions = actionable tasks (today/late + replied promotions), minus the
  // ones parked with the customer, sorted by the priority stack.
  const actionTasks: FollowupTask[] = useMemo(() => {
    const followups = followupsModel ? records[followupsModel.id] ?? [] : [];
    const all = buildFollowupTasks(followups, clientsById, now);
    const scoped = isManager && showAll ? all : tasksForRep(all, currentUserId);
    return scoped.filter((t) => !isWaitingForCustomer(t)).sort(byPriority(now));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followupsModel, records, clientsById, currentUserId, isManager, showAll]);

  // Waiting for customer — parked WhatsApp tasks, any day bucket.
  const waitingTasks: FollowupTask[] = useMemo(() => {
    const followups = followupsModel ? records[followupsModel.id] ?? [] : [];
    const all = buildWaitingTasks(followups, clientsById, now);
    return isManager && showAll ? all : tasksForRep(all, currentUserId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followupsModel, records, clientsById, currentUserId, isManager, showAll]);

  const channelTasks = channel === 'all' ? actionTasks : actionTasks.filter((t) => t.channel === channel);
  const callCount = actionTasks.filter((t) => t.channel === 'call').length;
  const waCount = actionTasks.filter((t) => t.channel === 'whatsapp').length;

  // Appointments, bucketed by calendar day + the No-shows worklist.
  // Past un-updated appointments split by recency (user request 2026-07-21):
  // today / tomorrow / future / last-7-days / older, so a stale backlog from
  // months ago never buries today's real schedule.
  const appointments = useMemo(() => {
    const empty: Record<ApptBucket, AppRecord[]> = { today: [], tomorrow: [], future: [], last7: [], older: [], no_show: [] };
    if (!appointmentsModel) return empty;
    const rows = (records[appointmentsModel.id] ?? [])
      .filter((r) => {
        if (isManager && showAll) return true;
        const rep = firstId((r.data as Record<string, unknown>).sales_rep);
        return !rep || rep === currentUserId;
      });
    const t0 = startOfDay(now);
    const out: Record<ApptBucket, AppRecord[]> = { today: [], tomorrow: [], future: [], last7: [], older: [], no_show: [] };
    for (const r of rows) {
      const d = r.data as Record<string, unknown>;
      const status = typeof d.appointment_status === 'string' && d.appointment_status ? d.appointment_status : 'scheduled';
      if (status === 'no_show') { out.no_show.push(r); continue; }
      if (status === 'completed' || status === 'cancelled') continue;
      const at = typeof d.appointment_date === 'string' ? Date.parse(d.appointment_date) : NaN;
      if (Number.isNaN(at)) continue;
      const day = startOfDay(at);
      if (day === t0) out.today.push(r);
      else if (day === t0 + DAY_MS) out.tomorrow.push(r);
      else if (day > t0) out.future.push(r);
      else if (day >= t0 - 7 * DAY_MS) out.last7.push(r);
      else out.older.push(r);
    }
    const byDate = (a: AppRecord, b: AppRecord) => {
      const av = typeof a.data.appointment_date === 'string' ? Date.parse(a.data.appointment_date) : 0;
      const bv = typeof b.data.appointment_date === 'string' ? Date.parse(b.data.appointment_date) : 0;
      return av - bv;
    };
    // Past buckets: most recent first (the freshest miss is the most actionable).
    const byDateDesc = (a: AppRecord, b: AppRecord) => byDate(b, a);
    out.today.sort(byDate); out.tomorrow.sort(byDate); out.future.sort(byDate);
    out.last7.sort(byDateDesc); out.older.sort(byDateDesc); out.no_show.sort(byDateDesc);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appointmentsModel, records, currentUserId, isManager, showAll]);

  // Other Tasks — the rep's open tasks from the Tasks model.
  const otherTasks = useMemo(() => {
    if (!tasksModel) return [];
    const rows = records[tasksModel.id] ?? [];
    return rows
      .filter((r) => {
        const d = r.data as Record<string, unknown>;
        const done = d.completed === true || d.task_status === 'completed' || d.task_status === 'approved';
        if (done) return false;
        if (isManager && showAll) return true;
        return ownerIdOf(d.responsible_officer) === currentUserId || r.created_by_user_id === currentUserId;
      })
      .slice()
      .sort((a, b) => {
        const av = typeof a.data.task_date === 'string' ? Date.parse(a.data.task_date) : Infinity;
        const bv = typeof b.data.task_date === 'string' ? Date.parse(b.data.task_date) : Infinity;
        return av - bv;
      });
  }, [tasksModel, records, currentUserId, isManager, showAll]);

  const userName = (id: string | null) => {
    if (!id) return '';
    const u = users.find((x) => x.id === id);
    return u ? (isAr ? u.name_ar : u.name_en) || u.email || '' : '';
  };

  // Localize a task_status slug via the Tasks model's own dropdown options.
  const taskStatusLabel = (value: string | null): string | null => {
    if (!value) return null;
    const field = tasksModel?.schema.sections.flatMap((s) => s.fields).find((f) => f.name === 'task_status');
    const opt = field?.options?.find((o) => o.value === value);
    return opt ? (isAr ? opt.label_ar : opt.label_en) || value : value;
  };

  const apptStatusLabel = (value: string): string => {
    const field = appointmentsModel?.schema.sections.flatMap((s) => s.fields).find((f) => f.name === 'appointment_status');
    const opt = field?.options?.find((o) => o.value === value);
    return opt ? (isAr ? opt.label_ar : opt.label_en) || value : value;
  };

  const ALL_SECTIONS: { id: Section; label: { ar: string; en: string }; count?: number; danger?: boolean }[] = [
    // «ملعبك / ملعب العميل» — the ball is either in YOUR court or the client's.
    // One metaphor across both tabs (user-chosen naming, 2026-07-21).
    { id: 'actions', label: { ar: 'ملعبك', en: 'Your court' }, count: actionTasks.length, danger: actionTasks.some((t) => priorityTier(t, now) <= 2) },
    { id: 'waiting', label: { ar: 'ملعب العميل', en: "Client's court" }, count: waitingTasks.length },
    // Section badge counts only the LIVE schedule (today + tomorrow + future +
    // no-shows) — the stale past buckets shouldn't inflate the headline number.
    { id: 'appointments', label: { ar: 'المواعيد', en: 'Appointments' }, count: appointments.today.length + appointments.tomorrow.length + appointments.future.length + appointments.no_show.length },
    { id: 'ai_notifications', label: { ar: 'إشعارات الذكاء', en: 'AI notifications' }, count: aiUnread, danger: aiNotifs.some((n) => !n.read_at && n.severity === 'warning') },
    { id: 'preferences', label: { ar: 'تفضيلات ناقصة', en: 'Incomplete Preferences' } },
    { id: 'other', label: { ar: 'مهام أخرى', en: 'Other Tasks' }, count: otherTasks.length },
  ];
  // The Other Tasks tab is backed by the `tasks` model — drop it entirely
  // when that model is archived (ARCHIVED_MODULE_MODELS) so the tab's "new
  // task" button can't route into the archived-section notice.
  const SECTIONS = ALL_SECTIONS.filter((s) => s.id !== 'other' || !isRetiredModel('tasks'));

  if (!initialized) {
    return <div className="p-6 text-sm text-charcoal/50">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>;
  }

  const channelChip = (id: FollowupChannel | 'all', label: string, icon: React.ReactNode, count: number, activeCls: string) => (
    <button
      type="button"
      onClick={() => setChannel(id)}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-bold transition ${
        channel === id ? activeCls : 'bg-white text-charcoal/70 hover:bg-cream'
      }`}
    >
      {icon} {label}
      <span className={`rounded-full px-1.5 text-xs ${channel === id ? 'bg-white/25' : 'bg-sand/60'}`}>{count}</span>
    </button>
  );

  const renderActions = () => (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {channelChip('all', isAr ? 'الكل' : 'All', <ClipboardList size={14} />, actionTasks.length, 'bg-copper text-white')}
        {channelChip('call', isAr ? 'مكالمات' : 'Calls', <Phone size={14} />, callCount, 'bg-copper text-white')}
        {channelChip('whatsapp', isAr ? 'محادثات' : 'Conversations', <MessageCircle size={14} />, waCount, 'bg-[#25D366] text-white')}
      </div>
      {channelTasks.length === 0 ? (
        <p className="rounded-2xl bg-cream p-5 text-center text-sm text-charcoal/60">
          {isAr ? 'لا توجد إجراءات مطلوبة الآن — كل شيء تحت السيطرة.' : 'Nothing needs you right now — all clear.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {channelTasks.map((t) => (
            <FollowupTaskCard
              key={t.followupId}
              task={t}
              tier={priorityTier(t, now)}
              isAr={isAr}
              returnTo={RETURN_TO}
              navigate={navigate}
              onWhatsApp={(id, phone) => id && openWhatsApp(id, phone)}
            />
          ))}
        </ul>
      )}
    </>
  );

  const renderWaiting = () => (
    <>
      <p className="mb-4 rounded-xl bg-[#D97706]/10 px-4 py-2.5 text-xs text-[#8a5a10]">
        {isAr
          ? 'الكرة الآن في ملعب العميل. تعود المهمة إلى «ملعبك» تلقائيًا عند رد العميل أو بعد ٢٤ ساعة صمت.'
          : "The ball is in the client's court. A task returns to Your court automatically when they reply or after 24h of silence."}
      </p>
      {waitingTasks.length === 0 ? (
        <p className="rounded-2xl bg-cream p-5 text-center text-sm text-charcoal/60">
          {isAr ? 'لا توجد محادثات بانتظار رد العميل.' : 'No conversations waiting on a customer.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {waitingTasks.map((t) => (
            <FollowupTaskCard
              key={t.followupId}
              task={t}
              isAr={isAr}
              returnTo={RETURN_TO}
              navigate={navigate}
              onWhatsApp={(id, phone) => id && openWhatsApp(id, phone)}
            />
          ))}
        </ul>
      )}
    </>
  );

  const APPT_TABS: { id: ApptBucket; label: { ar: string; en: string }; danger?: boolean }[] = [
    { id: 'today', label: { ar: 'اليوم', en: 'Today' } },
    { id: 'tomorrow', label: { ar: 'غدًا', en: 'Tomorrow' } },
    { id: 'future', label: { ar: 'قادمة', en: 'Future' } },
    { id: 'last7', label: { ar: 'آخر ٧ أيام', en: 'Last 7 days' } },
    { id: 'older', label: { ar: 'ماضية', en: 'Older' } },
    { id: 'no_show', label: { ar: 'لم يحضروا', en: 'No-shows' }, danger: true },
  ];

  const renderAppointments = () => {
    const rows = appointments[apptBucket];
    return (
      <>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {APPT_TABS.map((t) => {
            const on = apptBucket === t.id;
            const count = appointments[t.id].length;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setApptBucket(t.id)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-bold transition ${
                  on ? (t.danger ? 'bg-terracotta text-white' : 'bg-copper text-white') : 'bg-white text-charcoal/70 hover:bg-cream'
                }`}
              >
                {t.danger && <AlertTriangle size={13} />}
                {isAr ? t.label.ar : t.label.en}
                <span className={`rounded-full px-1.5 text-xs ${on ? 'bg-white/25' : 'bg-sand/60'}`}>{count}</span>
              </button>
            );
          })}
        </div>
        {(apptBucket === 'last7' || apptBucket === 'older') && rows.length > 0 && (
          <p className="mb-3 rounded-xl bg-sand/30 px-4 py-2 text-xs text-charcoal/60">
            {isAr
              ? 'مواعيد فائتة لم تُحدَّث حالتها — سجّل زيارة أو حدّث الموعد (تمت / لم يحضر / أُلغيت).'
              : 'Past appointments never updated — record a visit or set their status (completed / no-show / cancelled).'}
          </p>
        )}
        {rows.length === 0 ? (
          <p className="rounded-2xl bg-cream p-5 text-center text-sm text-charcoal/60">
            {apptBucket === 'no_show'
              ? isAr ? 'لا توجد مواعيد لم يحضرها العملاء. ممتاز!' : 'No missed appointments. Great!'
              : isAr ? 'لا توجد مواعيد في هذه الفترة.' : 'No appointments in this window.'}
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((r) => {
              const d = r.data as Record<string, unknown>;
              const clientId = firstId(d.client_id);
              const client = clientId ? clientsById.get(clientId)?.data as Record<string, unknown> | undefined : undefined;
              const name = (typeof client?.client_name === 'string' && client.client_name)
                || (typeof d.client_name === 'string' && d.client_name) || (isAr ? 'عميل' : 'Client');
              const phone = (typeof client?.phone_number === 'string' && client.phone_number)
                || (typeof d.phone_number === 'string' && d.phone_number) || '';
              const at = typeof d.appointment_date === 'string' ? new Date(d.appointment_date) : null;
              const status = typeof d.appointment_status === 'string' && d.appointment_status ? d.appointment_status : 'scheduled';
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/model/appointments/${r.id}?returnTo=${encodeURIComponent(RETURN_TO)}`)}
                    className="card flex w-full flex-wrap items-center justify-between gap-3 p-4 text-start transition-colors hover:bg-cream/60"
                    style={{ borderInlineStartWidth: 4, borderInlineStartColor: status === 'no_show' ? '#B5462F' : status === 'confirmed' ? '#10B981' : '#B8734F' }}
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-2">
                        <CalendarDays size={15} className="shrink-0 text-copper" />
                        <span className="truncate font-bold text-chocolate">{name}</span>
                        <span dir="ltr" className="text-sm text-terracotta">{phone}</span>
                      </span>
                      <span className="mt-1 block text-xs text-charcoal/60">
                        {at && !Number.isNaN(at.getTime())
                          ? at.toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'full', timeStyle: 'short' })
                          : isAr ? 'بدون تاريخ' : 'No date'}
                      </span>
                    </span>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${APPT_STATUS_STYLE[status] ?? 'bg-sand/50 text-charcoal'}`}>
                      {apptStatusLabel(status)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  };

  const renderAiNotifications = () => (
    <>
      <div className="mb-4 flex items-center justify-between gap-2">
        <p className="text-xs text-charcoal/60">
          {isAr ? 'إشعارات من الوكيل الذكي على واتساب — يرسلها عند تحويل المحادثة لك أو عند الحاجة لتدخّلك.' : 'Notifications from the WhatsApp AI agent — sent when it hands a chat to you or needs your attention.'}
        </p>
        {aiUnread > 0 && (
          <button
            type="button"
            onClick={() => void markAllNotifsRead()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-charcoal/70 transition-colors hover:bg-cream"
          >
            <CheckCheck size={14} /> {isAr ? 'تعليم الكل كمقروء' : 'Mark all read'}
          </button>
        )}
      </div>
      {aiLoading ? (
        <p className="rounded-2xl bg-cream p-5 text-center text-sm text-charcoal/60">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</p>
      ) : aiNotifs.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 p-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-copper/10 text-copper">
            <Bot size={24} />
          </span>
          <h2 className="text-lg font-bold text-chocolate">{isAr ? 'لا توجد إشعارات' : 'No notifications'}</h2>
          <p className="max-w-md text-sm text-charcoal/60">
            {isAr ? 'عندما يرد الوكيل الذكي على عميل ويحتاج تدخّلك، سيظهر الإشعار هنا.' : 'When the AI agent replies to a customer and needs your attention, its notification appears here.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {aiNotifs.map((n) => {
            const sev = AI_SEVERITY[n.severity] ?? AI_SEVERITY.info;
            const unread = !n.read_at;
            return (
              <li key={n.id}>
                <div
                  className={`card p-4 transition-opacity ${unread ? '' : 'opacity-70'}`}
                  style={{ borderInlineStartWidth: 4, borderInlineStartColor: sev.stripe }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${sev.badge}`}>{isAr ? sev.ar : sev.en}</span>
                    {unread && <span className="h-2 w-2 rounded-full bg-copper" title={isAr ? 'غير مقروء' : 'Unread'} />}
                    {n.title && <span className="font-bold text-chocolate">{n.title}</span>}
                    <span className="ms-auto text-xs text-charcoal/50">
                      {new Date(n.created_at).toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                    </span>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm text-charcoal">{n.body}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {n.chat_record_id && (
                      <button
                        type="button"
                        onClick={() => { void markNotifRead(n.id); navigate(`/model/chats/${n.chat_record_id}`); }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-[#25D366] px-3 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90"
                      >
                        <MessageCircle size={14} /> {isAr ? 'فتح المحادثة' : 'Open chat'}
                      </button>
                    )}
                    {unread && (
                      <button
                        type="button"
                        onClick={() => void markNotifRead(n.id)}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-charcoal/70 transition-colors hover:bg-cream"
                      >
                        <CheckCheck size={14} /> {isAr ? 'مقروء' : 'Mark read'}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      {whatsAppModals}
      <header className="mb-5 flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-copper/10 text-copper">
          <ClipboardList size={22} />
        </span>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-chocolate">{isAr ? 'مهامي' : 'My Tasks'}</h1>
          <p className="text-sm text-charcoal/60">{isAr ? 'قائمة عملك اليومية' : 'Your daily work list'}</p>
        </div>
        {isManager && (
          <label className="inline-flex items-center gap-2 text-xs font-semibold text-charcoal/60">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-copper" />
            {isAr ? 'كل المندوبين' : 'All reps'}
          </label>
        )}
      </header>

      {/* Section tabs */}
      <nav className="mb-5 flex flex-wrap gap-x-5 gap-y-1 border-b border-sand">
        {SECTIONS.map((s) => {
          const on = section === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-1 py-2.5 text-sm transition-colors ${
                on ? 'border-copper font-bold text-copper' : 'border-transparent text-charcoal hover:text-terracotta'
              }`}
            >
              {s.id === 'waiting' && <Hourglass size={13} className="text-[#D97706]" />}
              {s.id === 'appointments' && <CalendarDays size={13} />}
              {s.id === 'ai_notifications' && <Bot size={13} className="text-copper" />}
              {isAr ? s.label.ar : s.label.en}
              {s.count != null && s.count > 0 && (
                <span className={`rounded-full px-1.5 py-0.5 text-xs font-bold ${s.danger ? 'bg-terracotta text-white' : 'bg-sand text-charcoal'}`}>{s.count}</span>
              )}
            </button>
          );
        })}
      </nav>

      {section === 'actions' && renderActions()}
      {section === 'waiting' && renderWaiting()}
      {section === 'appointments' && renderAppointments()}
      {section === 'ai_notifications' && renderAiNotifications()}

      {section === 'preferences' && (
        <div className="card flex flex-col items-center gap-3 p-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-gold/15 text-gold">
            <Sparkles size={24} />
          </span>
          <h2 className="text-lg font-bold text-chocolate">{isAr ? 'تفضيلات العملاء الناقصة' : 'Incomplete Client Preferences'}</h2>
          <p className="max-w-md text-sm text-charcoal/60">
            {isAr
              ? 'ستظهر هنا لاحقًا مهام العملاء الذين تنقص بياناتهم التفضيلية (الميزانية، نوع الوحدة، الموقع المفضل…). هذه الميزة قيد الإعداد.'
              : 'Tasks for clients whose preferences are missing or incomplete (budget, unit type, preferred location…) will appear here. This feature is coming soon.'}
          </p>
        </div>
      )}

      {section === 'other' && (
        <>
          <div className="mb-4 flex items-center justify-between">
            <span className="text-sm font-medium text-charcoal/70">{otherTasks.length}</span>
            {tasksModel && canCreateTask && (
              <button
                type="button"
                onClick={() => navigate('/model/tasks/new')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-3 py-1.5 text-sm font-bold text-white transition-colors hover:bg-terracotta"
              >
                <Plus size={15} /> {isAr ? 'مهمة جديدة' : 'New task'}
              </button>
            )}
          </div>
          {!tasksModel ? (
            <p className="rounded-2xl bg-cream p-5 text-center text-sm text-charcoal/60">{isAr ? 'نموذج المهام غير متاح.' : 'Tasks model unavailable.'}</p>
          ) : otherTasks.length === 0 ? (
            <p className="rounded-2xl bg-cream p-5 text-center text-sm text-charcoal/60">{isAr ? 'لا توجد مهام أخرى مفتوحة.' : 'No other open tasks.'}</p>
          ) : (
            <ul className="space-y-3">
              {otherTasks.map((r) => {
                const d = r.data as Record<string, unknown>;
                const title = typeof d.task === 'string' && d.task ? d.task : isAr ? 'مهمة' : 'Task';
                const dateISO = typeof d.task_date === 'string' ? d.task_date : null;
                const status = typeof d.task_status === 'string' ? d.task_status : null;
                const responsible = userName(ownerIdOf(d.responsible_officer));
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => navigate(`/model/tasks/${r.id}`)}
                      className="card flex w-full items-center justify-between gap-3 p-4 text-start transition-colors hover:bg-cream/60"
                    >
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <FolderKanban size={15} className="shrink-0 text-copper" />
                          <span className="truncate font-bold text-chocolate">{title}</span>
                        </span>
                        <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-charcoal/60">
                          {dateISO && <span>{new Date(dateISO).toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'short', timeStyle: 'short' })}</span>}
                          {responsible && <span>{isAr ? 'المسؤول: ' : 'Owner: '}{responsible}</span>}
                        </span>
                      </span>
                      {status && <span className="shrink-0 rounded-full bg-sand/50 px-2 py-0.5 text-xs font-bold text-charcoal">{taskStatusLabel(status)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
