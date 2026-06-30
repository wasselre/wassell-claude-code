import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClipboardList, Phone, MessageCircle, Plus, Sparkles, FolderKanban } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin, usePermission } from '@/hooks/usePermission';
import { useClientWhatsApp } from '@/pages/Clients/lib/useClientWhatsApp';
import { buildFollowupTasks, tasksForRep, type FollowupChannel, type FollowupTask } from './lib/myWork';
import FollowupTaskCard from './components/FollowupTaskCard';

type Section = 'today' | 'late' | 'preferences' | 'other';

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

const RETURN_TO = '/sales/my-tasks';

/**
 * My Tasks — the sales rep's daily work surface. Four sections: today's
 * follow-ups, late follow-ups (each split into Calls vs Conversations),
 * a placeholder for incomplete-preference tasks, and the rep's other Tasks.
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

  const [section, setSection] = useState<Section>('today');
  const [channel, setChannel] = useState<FollowupChannel>('call');
  const [showAll, setShowAll] = useState(false); // manager-only: include all reps

  const now = Date.now();

  const followupsModel = models.find((m) => m.name === 'followups');
  const clientsModel = models.find((m) => m.name === 'clients');
  const tasksModel = models.find((m) => m.name === 'tasks');
  const canCreateTask = usePermission(tasksModel?.id ?? '', 'create');

  // Build the actionable follow-up tasks (today + late), scoped to the rep.
  const followupTasks: FollowupTask[] = useMemo(() => {
    const followups = followupsModel ? records[followupsModel.id] ?? [] : [];
    const clients = clientsModel ? records[clientsModel.id] ?? [] : [];
    const clientsById = new Map(clients.map((c) => [c.id, c.data as Record<string, unknown>]));
    const all = buildFollowupTasks(followups, clientsById, now);
    return isManager && showAll ? all : tasksForRep(all, currentUserId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followupsModel, clientsModel, records, currentUserId, isManager, showAll]);

  const today = useMemo(() => followupTasks.filter((t) => t.bucket === 'today'), [followupTasks]);
  const late = useMemo(() => followupTasks.filter((t) => t.bucket === 'late'), [followupTasks]);

  const bySchedule = (a: FollowupTask, b: FollowupTask) => {
    const av = a.scheduledISO ? Date.parse(a.scheduledISO) : 0;
    const bv = b.scheduledISO ? Date.parse(b.scheduledISO) : 0;
    return av - bv;
  };
  const sectionTasks = section === 'today' ? today : late;
  const channelTasks = sectionTasks.filter((t) => t.channel === channel).slice().sort(bySchedule);
  const callCount = sectionTasks.filter((t) => t.channel === 'call').length;
  const waCount = sectionTasks.filter((t) => t.channel === 'whatsapp').length;

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

  const SECTIONS: { id: Section; label: { ar: string; en: string }; count?: number }[] = [
    { id: 'today', label: { ar: 'متابعات اليوم', en: "Today's Follow-ups" }, count: today.length },
    { id: 'late', label: { ar: 'متابعات متأخرة', en: 'Late Follow-ups' }, count: late.length },
    { id: 'preferences', label: { ar: 'تفضيلات ناقصة', en: 'Incomplete Preferences' } },
    { id: 'other', label: { ar: 'مهام أخرى', en: 'Other Tasks' }, count: otherTasks.length },
  ];

  if (!initialized) {
    return <div className="p-6 text-sm text-charcoal/50">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>;
  }

  const renderChannelTabs = () => (
    <div className="mb-4 flex items-center gap-2">
      <button
        type="button"
        onClick={() => setChannel('call')}
        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-bold transition ${
          channel === 'call' ? 'bg-copper text-white' : 'bg-white text-charcoal/70 hover:bg-cream'
        }`}
      >
        <Phone size={14} /> {isAr ? 'مكالمات' : 'Calls'}
        <span className={`rounded-full px-1.5 text-xs ${channel === 'call' ? 'bg-white/25' : 'bg-sand/60'}`}>{callCount}</span>
      </button>
      <button
        type="button"
        onClick={() => setChannel('whatsapp')}
        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-bold transition ${
          channel === 'whatsapp' ? 'bg-[#25D366] text-white' : 'bg-white text-charcoal/70 hover:bg-cream'
        }`}
      >
        <MessageCircle size={14} /> {isAr ? 'محادثات' : 'Conversations'}
        <span className={`rounded-full px-1.5 text-xs ${channel === 'whatsapp' ? 'bg-white/25' : 'bg-sand/60'}`}>{waCount}</span>
      </button>
    </div>
  );

  const renderFollowups = () => (
    <>
      {renderChannelTabs()}
      {channelTasks.length === 0 ? (
        <p className="rounded-2xl bg-cream p-5 text-center text-sm text-charcoal/60">
          {section === 'today'
            ? isAr ? 'لا توجد متابعات لهذا اليوم في هذه القناة.' : 'No follow-ups for today in this channel.'
            : isAr ? 'لا توجد متابعات متأخرة في هذه القناة.' : 'No late follow-ups in this channel.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {channelTasks.map((t) => (
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
          const danger = s.id === 'late';
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-1 py-2.5 text-sm transition-colors ${
                on ? 'border-copper font-bold text-copper' : 'border-transparent text-charcoal hover:text-terracotta'
              }`}
            >
              {isAr ? s.label.ar : s.label.en}
              {s.count != null && s.count > 0 && (
                <span className={`rounded-full px-1.5 py-0.5 text-xs font-bold ${danger ? 'bg-terracotta text-white' : 'bg-sand text-charcoal'}`}>{s.count}</span>
              )}
            </button>
          );
        })}
      </nav>

      {(section === 'today' || section === 'late') && renderFollowups()}

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
