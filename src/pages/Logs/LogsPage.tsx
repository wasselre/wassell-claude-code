/**
 * Unified activity log page — single timeline that shows everything happening
 * in the app: sign-ins, record CRUD + opens, workflow runs, AI agent turns +
 * tool calls (with full input/output payloads), API hits, webhook receipts,
 * and system events.
 *
 * Data lives in `public.activity_log` and is loaded by the store. Workflow
 * events deep-link to /workflow/logs/:runId via the workflow_run_id column;
 * everything else expands inline in the right-pane detail panel.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  ScrollText,
  RefreshCw,
  Trash2,
  Search,
  ChevronRight,
  LogIn,
  LogOut,
  FilePlus,
  FileEdit,
  Eye,
  Zap,
  Bot,
  Server,
  Webhook,
  Settings as SettingsIcon,
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
  Code2,
  FolderOpen,
} from 'lucide-react';
import type { ActivityLogEntry, ActivityLogCategory, ActivityLogStatus } from '@/types';

type CategoryFilter = 'all' | ActivityLogCategory;

const CATEGORY_META: Record<ActivityLogCategory, { ar: string; en: string; bg: string; fg: string; Icon: typeof ScrollText }> = {
  auth:     { ar: 'تسجيل الدخول',     en: 'Auth',         bg: 'bg-indigo-50',  fg: 'text-indigo-700',  Icon: LogIn },
  record:   { ar: 'السجلات',          en: 'Records',      bg: 'bg-emerald-50', fg: 'text-emerald-700', Icon: FilePlus },
  workflow: { ar: 'سير العمل',        en: 'Workflows',    bg: 'bg-amber-50',   fg: 'text-amber-700',   Icon: Zap },
  ai_agent: { ar: 'وكيل الذكاء',      en: 'AI Agent',     bg: 'bg-purple-50',  fg: 'text-purple-700',  Icon: Bot },
  api:      { ar: 'واجهات API',       en: 'API',          bg: 'bg-sky-50',     fg: 'text-sky-700',     Icon: Server },
  webhook:  { ar: 'Webhooks',         en: 'Webhooks',     bg: 'bg-rose-50',    fg: 'text-rose-700',    Icon: Webhook },
  system:   { ar: 'النظام',           en: 'System',       bg: 'bg-charcoal/5', fg: 'text-charcoal/70', Icon: SettingsIcon },
  file:     { ar: 'الملفات',          en: 'Files',        bg: 'bg-copper/10',  fg: 'text-copper',      Icon: FolderOpen },
};

const STATUS_META: Record<ActivityLogStatus, { dot: string; fg: string; ar: string; en: string; Icon: typeof CheckCircle2 }> = {
  success: { dot: 'bg-emerald-500', fg: 'text-emerald-700', ar: 'نجح',   en: 'Success', Icon: CheckCircle2 },
  error:   { dot: 'bg-red-500',     fg: 'text-red-700',     ar: 'خطأ',   en: 'Error',   Icon: XCircle },
  warning: { dot: 'bg-amber-500',   fg: 'text-amber-700',   ar: 'تحذير', en: 'Warning', Icon: AlertTriangle },
  info:    { dot: 'bg-charcoal/40', fg: 'text-charcoal/60', ar: 'معلومة', en: 'Info',   Icon: Info },
};

function eventIcon(entry: ActivityLogEntry) {
  if (entry.category === 'auth') return entry.event_type === 'sign_in' ? LogIn : LogOut;
  if (entry.category === 'record') {
    if (entry.event_type === 'create') return FilePlus;
    if (entry.event_type === 'update') return FileEdit;
    if (entry.event_type === 'delete') return Trash2;
    if (entry.event_type === 'open') return Eye;
  }
  return CATEGORY_META[entry.category].Icon;
}

export default function LogsPage() {
  const navigate = useNavigate();
  const { activityLog, users, models, language, loadActivityLog, deleteActivityLog, clearActivityLog, addToast } = useAppStore();
  const isAr = language === 'ar';

  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ActivityLogStatus>('all');
  const [userFilter, setUserFilter] = useState<string>('all');
  const [modelFilter, setModelFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Reload from Supabase on mount so the admin sees the most recent 500
  // entries even if the in-memory cap (200) was reached during the session.
  useEffect(() => {
    void loadActivityLog(500);
  }, [loadActivityLog]);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await loadActivityLog(500);
    } finally {
      setRefreshing(false);
    }
  };

  const filtered = useMemo(() => {
    return activityLog.filter((e) => {
      if (categoryFilter !== 'all' && e.category !== categoryFilter) return false;
      if (statusFilter !== 'all' && e.status !== statusFilter) return false;
      if (userFilter !== 'all') {
        if (userFilter === '__system__') {
          if (e.actor_user_id) return false;
        } else if (e.actor_user_id !== userFilter) return false;
      }
      if (modelFilter !== 'all' && e.target_model_id !== modelFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = [
          e.summary_ar,
          e.summary_en,
          e.actor_email ?? '',
          e.target_label ?? '',
          e.event_type,
          e.error ?? '',
          JSON.stringify(e.details ?? {}),
        ].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [activityLog, categoryFilter, statusFilter, userFilter, modelFilter, search]);

  const stats = useMemo(() => {
    const out = { total: activityLog.length, auth: 0, record: 0, workflow: 0, ai_agent: 0, api: 0, webhook: 0, system: 0, file: 0 };
    for (const e of activityLog) out[e.category]++;
    return out;
  }, [activityLog]);

  // Auto-select the first row when filters change.
  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
    } else if (!filtered.some((e) => e.id === selectedId)) {
      const first = filtered[0];
      if (first) setSelectedId(first.id);
    }
  }, [filtered, selectedId]);

  const selected = useMemo(
    () => filtered.find((e) => e.id === selectedId) ?? null,
    [filtered, selectedId],
  );

  const userLabel = (id?: string | null, fallbackEmail?: string | null) => {
    if (!id && !fallbackEmail) return isAr ? 'النظام' : 'System';
    if (id) {
      const u = users.find((x) => x.id === id);
      if (u) return isAr ? u.name_ar : u.name_en;
    }
    return fallbackEmail ?? (isAr ? 'مستخدم محذوف' : 'Deleted user');
  };

  const onClearAll = () => {
    if (!activityLog.length) return;
    const msg = isAr
      ? 'حذف جميع سجلات النشاط المعروضة؟ السجلات الأقدم في Supabase تبقى.'
      : 'Delete all visible activity log entries? Older Supabase rows remain.';
    if (!confirm(msg)) return;
    clearActivityLog();
    addToast(isAr ? 'تم الحذف' : 'Deleted', 'success');
  };

  const onDeleteSelected = () => {
    if (!selected) return;
    deleteActivityLog(selected.id);
    setSelectedId(null);
  };

  return (
    <div className="logs-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-charcoal/5 flex items-center justify-center">
            <ScrollText size={22} className="text-charcoal/60" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-chocolate">
              {isAr ? 'سجل النشاط' : 'Activity Log'}
            </h1>
            <p className="text-xs text-charcoal/40">
              {isAr
                ? 'كل ما يحدث في التطبيق — تسجيل الدخول، السجلات، سير العمل، وكيل الذكاء، API، Webhooks'
                : 'Everything happening in the app — sign-ins, records, workflows, AI agent, APIs, webhooks'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            className="p-2.5 rounded-xl hover:bg-cream text-charcoal/40 hover:text-charcoal disabled:opacity-40"
            title={isAr ? 'تحديث' : 'Refresh'}
            disabled={refreshing}
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={onClearAll}
            disabled={!activityLog.length}
            className="pill border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 size={14} />
            {isAr ? 'مسح الكل' : 'Clear all'}
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 mb-4">
        <CategoryStat label={isAr ? 'الإجمالي' : 'Total'} value={stats.total} bg="bg-charcoal/5" fg="text-charcoal" Icon={ScrollText} onClick={() => setCategoryFilter('all')} active={categoryFilter === 'all'} />
        {(Object.keys(CATEGORY_META) as ActivityLogCategory[]).map((cat) => {
          const meta = CATEGORY_META[cat];
          return (
            <CategoryStat
              key={cat}
              label={isAr ? meta.ar : meta.en}
              value={stats[cat]}
              bg={meta.bg}
              fg={meta.fg}
              Icon={meta.Icon}
              onClick={() => setCategoryFilter(cat)}
              active={categoryFilter === cat}
            />
          );
        })}
      </div>

      {/* Filters */}
      <div className="card p-3 mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-[220px]">
          <Search size={14} className="text-charcoal/30" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isAr ? 'بحث (ملخص، مستخدم، تفاصيل...)' : 'Search (summary, user, details...)'}
            className="form-input text-sm flex-1 border-0 focus:ring-0"
          />
        </div>

        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | ActivityLogStatus)} className="form-input text-sm">
          <option value="all">{isAr ? 'كل الحالات' : 'All statuses'}</option>
          {(Object.keys(STATUS_META) as ActivityLogStatus[]).map((s) => (
            <option key={s} value={s}>{isAr ? STATUS_META[s].ar : STATUS_META[s].en}</option>
          ))}
        </select>

        <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} className="form-input text-sm">
          <option value="all">{isAr ? 'كل المستخدمين' : 'All users'}</option>
          <option value="__system__">{isAr ? 'النظام' : 'System / unattributed'}</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{isAr ? u.name_ar : u.name_en}</option>
          ))}
        </select>

        <select value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} className="form-input text-sm">
          <option value="all">{isAr ? 'كل النماذج' : 'All models'}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>{isAr ? m.label_ar : m.label_en}</option>
          ))}
        </select>
      </div>

      {/* Two-pane: timeline list + detail panel */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.2fr] gap-4">
        {/* List */}
        <div className="card p-2 max-h-[calc(100vh-280px)] overflow-y-auto">
          {activityLog.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-charcoal/30">
              <ScrollText size={48} className="mb-4" />
              <p className="text-lg font-bold">{isAr ? 'لا توجد سجلات بعد' : 'No activity yet'}</p>
              <p className="text-sm">{isAr ? 'ستظهر السجلات هنا تلقائياً.' : 'Activity will appear here automatically.'}</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-charcoal/40 text-sm">
              {isAr ? 'لا نتائج مطابقة للفلاتر الحالية' : 'No entries match the current filters'}
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map((entry) => (
                <LogRow
                  key={entry.id}
                  entry={entry}
                  isAr={isAr}
                  selected={entry.id === selectedId}
                  onClick={() => setSelectedId(entry.id)}
                  userLabel={userLabel(entry.actor_user_id, entry.actor_email)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        <div className="card p-4 max-h-[calc(100vh-280px)] overflow-y-auto">
          {selected ? (
            <LogDetail
              entry={selected}
              isAr={isAr}
              userLabel={userLabel(selected.actor_user_id, selected.actor_email)}
              onDelete={onDeleteSelected}
              onWorkflowRunOpen={(runId) => navigate(`/workflow/logs/${runId}`)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-charcoal/30">
              <Code2 size={40} className="mb-3" />
              <p className="text-sm">{isAr ? 'اختر إدخالاً من القائمة لعرض التفاصيل.' : 'Pick an entry from the list to see details.'}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CategoryStat({
  label, value, bg, fg, Icon, active, onClick,
}: {
  label: string;
  value: number;
  bg: string;
  fg: string;
  Icon: typeof ScrollText;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`card p-3 text-start transition-all ${active ? 'ring-2 ring-copper border-copper' : 'hover:border-copper/30'}`}
    >
      <div className="flex items-center gap-2 mb-1">
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${bg}`}>
          <Icon size={14} className={fg} />
        </div>
        <div className="text-xs font-bold text-charcoal/60 truncate">{label}</div>
      </div>
      <div className="text-xl font-bold text-charcoal">{value}</div>
    </button>
  );
}

function LogRow({
  entry, isAr, selected, onClick, userLabel,
}: {
  entry: ActivityLogEntry;
  isAr: boolean;
  selected: boolean;
  onClick: () => void;
  userLabel: string;
}) {
  const meta = CATEGORY_META[entry.category];
  const Icon = eventIcon(entry);
  const statusMeta = entry.status ? STATUS_META[entry.status] : null;
  const when = new Date(entry.created_at);

  return (
    <button
      onClick={onClick}
      className={`w-full text-start p-3 rounded-xl flex items-start gap-3 border transition-colors ${
        selected ? 'border-copper bg-copper/5' : 'border-transparent hover:bg-cream/50'
      }`}
    >
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${meta.bg}`}>
        <Icon size={16} className={meta.fg} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${meta.bg} ${meta.fg}`}>
            {isAr ? meta.ar : meta.en}
          </span>
          {statusMeta && (
            <span className={`w-2 h-2 rounded-full ${statusMeta.dot}`} title={isAr ? statusMeta.ar : statusMeta.en} />
          )}
          <span className="text-[11px] text-charcoal/40 font-bold uppercase tracking-wide">{entry.event_type}</span>
        </div>
        <div className="text-sm text-charcoal mt-0.5 truncate">
          {isAr ? entry.summary_ar : entry.summary_en}
        </div>
        <div className="text-[11px] text-charcoal/40 mt-0.5 flex items-center gap-2 flex-wrap">
          <span>{userLabel}</span>
          <span>·</span>
          <span>{when.toLocaleString(isAr ? 'ar-SA' : 'en-US')}</span>
          <span>·</span>
          <span>{formatRelative(when, isAr)}</span>
          {typeof entry.duration_ms === 'number' && (
            <>
              <span>·</span>
              <span>{entry.duration_ms}ms</span>
            </>
          )}
        </div>
      </div>
      <ChevronRight size={14} className="text-charcoal/20 shrink-0 rtl:rotate-180 mt-2" />
    </button>
  );
}

function LogDetail({
  entry, isAr, userLabel, onDelete, onWorkflowRunOpen,
}: {
  entry: ActivityLogEntry;
  isAr: boolean;
  userLabel: string;
  onDelete: () => void;
  onWorkflowRunOpen: (runId: string) => void;
}) {
  const meta = CATEGORY_META[entry.category];
  const Icon = eventIcon(entry);
  const statusMeta = entry.status ? STATUS_META[entry.status] : null;
  const when = new Date(entry.created_at);

  return (
    <div>
      {/* Detail header */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${meta.bg}`}>
            <Icon size={20} className={meta.fg} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-[11px] px-2 py-0.5 rounded-md font-bold ${meta.bg} ${meta.fg}`}>
                {isAr ? meta.ar : meta.en}
              </span>
              <span className="text-[11px] text-charcoal/50 font-bold uppercase tracking-wide">{entry.event_type}</span>
              {statusMeta && (
                <span className={`text-[11px] flex items-center gap-1 ${statusMeta.fg}`}>
                  <statusMeta.Icon size={12} />
                  {isAr ? statusMeta.ar : statusMeta.en}
                </span>
              )}
            </div>
            <h2 className="text-base font-bold text-charcoal mt-1">
              {isAr ? entry.summary_ar : entry.summary_en}
            </h2>
          </div>
        </div>
        <button
          onClick={onDelete}
          className="p-2 rounded-lg hover:bg-red-50 text-charcoal/30 hover:text-red-600 shrink-0"
          title={isAr ? 'حذف هذا السجل' : 'Delete this entry'}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-3 mb-4 text-xs">
        <DetailField label={isAr ? 'متى' : 'When'} value={when.toLocaleString(isAr ? 'ar-SA' : 'en-US')} />
        <DetailField label={isAr ? 'منذ' : 'Ago'} value={formatRelative(when, isAr)} />
        <DetailField label={isAr ? 'الفاعل' : 'Actor'} value={userLabel} />
        <DetailField label={isAr ? 'البريد' : 'Email'} value={entry.actor_email ?? '—'} mono />
        {entry.target_label && (
          <DetailField label={isAr ? 'الهدف' : 'Target'} value={entry.target_label} />
        )}
        {typeof entry.duration_ms === 'number' && (
          <DetailField label={isAr ? 'المدة' : 'Duration'} value={`${entry.duration_ms}ms`} />
        )}
        {entry.target_record_id && (
          <DetailField label={isAr ? 'معرف السجل' : 'Record ID'} value={entry.target_record_id} mono />
        )}
        {entry.target_model_id && (
          <DetailField label={isAr ? 'معرف النموذج' : 'Model ID'} value={entry.target_model_id} mono />
        )}
      </div>

      {/* Workflow deep-link */}
      {entry.category === 'workflow' && entry.workflow_run_id && (
        <button
          onClick={() => onWorkflowRunOpen(entry.workflow_run_id!)}
          className="pill border-amber-200 text-amber-700 hover:bg-amber-50 mb-4"
        >
          <Zap size={12} />
          {isAr ? 'فتح تفاصيل تنفيذ سير العمل' : 'Open workflow run detail'}
          <ChevronRight size={12} className="rtl:rotate-180" />
        </button>
      )}

      {/* Error block */}
      {entry.error && (
        <div className="card p-3 mb-4 bg-red-50 border-red-200">
          <div className="text-[11px] font-bold text-red-700 uppercase tracking-wide mb-1">
            {isAr ? 'الخطأ' : 'Error'}
          </div>
          <div className="text-sm font-mono text-red-900 whitespace-pre-wrap break-all">{entry.error}</div>
        </div>
      )}

      {/* Specialized renderers per category */}
      {entry.category === 'ai_agent' && (
        <AiAgentDetail entry={entry} isAr={isAr} />
      )}
      {entry.category === 'record' && entry.event_type === 'update' && (
        <RecordDiffDetail entry={entry} isAr={isAr} />
      )}

      {/* Raw details JSON — always shown last for full transparency */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] font-bold text-charcoal/50 uppercase tracking-wide">
            {isAr ? 'البيانات الكاملة' : 'Full payload'}
          </div>
        </div>
        <pre className="card p-3 bg-charcoal/[0.02] text-[11px] font-mono whitespace-pre-wrap break-words text-charcoal/80 overflow-x-auto max-h-96 overflow-y-auto">
{JSON.stringify(entry.details, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function AiAgentDetail({ entry, isAr }: { entry: ActivityLogEntry; isAr: boolean }) {
  const details = entry.details as {
    iteration?: number;
    stop_reason?: string;
    message_count?: number;
    tool_calls?: Array<{ name: string; input: unknown; result: string; duration_ms: number; error?: string }>;
  };
  const toolCalls = details.tool_calls ?? [];

  return (
    <div className="mb-4">
      <div className="text-[11px] font-bold text-charcoal/50 uppercase tracking-wide mb-2">
        {isAr ? 'جولة الوكيل' : 'Agent turn'}
      </div>
      <div className="grid grid-cols-3 gap-2 mb-3 text-xs">
        <DetailField label={isAr ? 'التكرار' : 'Iteration'} value={String(details.iteration ?? 0)} />
        <DetailField label={isAr ? 'سبب التوقف' : 'Stop reason'} value={details.stop_reason ?? '—'} />
        <DetailField label={isAr ? 'عدد الرسائل' : 'Messages'} value={String(details.message_count ?? 0)} />
      </div>
      {toolCalls.length > 0 && (
        <div className="space-y-3">
          <div className="text-[11px] font-bold text-charcoal/50 uppercase tracking-wide">
            {isAr ? `استدعاءات الأدوات (${toolCalls.length})` : `Tool calls (${toolCalls.length})`}
          </div>
          {toolCalls.map((tc, idx) => (
            <div key={idx} className="card p-3 bg-purple-50/40 border-purple-200/60">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Bot size={14} className="text-purple-700" />
                  <span className="text-sm font-bold text-purple-900">{tc.name}</span>
                </div>
                <span className="text-[11px] text-charcoal/50 font-mono">{tc.duration_ms}ms</span>
              </div>
              <div className="text-[11px] font-bold text-charcoal/50 uppercase mb-1">
                {isAr ? 'الإدخال' : 'Input'}
              </div>
              <pre className="text-[11px] font-mono bg-white/60 p-2 rounded mb-2 whitespace-pre-wrap break-words overflow-x-auto">
{JSON.stringify(tc.input, null, 2)}
              </pre>
              <div className="text-[11px] font-bold text-charcoal/50 uppercase mb-1">
                {isAr ? 'النتيجة' : 'Result'}
              </div>
              <pre className="text-[11px] font-mono bg-white/60 p-2 rounded whitespace-pre-wrap break-words overflow-x-auto max-h-64 overflow-y-auto">
{tc.result}
              </pre>
              {tc.error && (
                <div className="text-[11px] font-mono text-red-700 mt-2">Error: {tc.error}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecordDiffDetail({ entry, isAr }: { entry: ActivityLogEntry; isAr: boolean }) {
  const details = entry.details as {
    changed_fields?: Record<string, { before: unknown; after: unknown }>;
  };
  const diff = details.changed_fields ?? {};
  const keys = Object.keys(diff);
  if (keys.length === 0) return null;

  return (
    <div className="mb-4">
      <div className="text-[11px] font-bold text-charcoal/50 uppercase tracking-wide mb-2">
        {isAr ? `الحقول المعدّلة (${keys.length})` : `Changed fields (${keys.length})`}
      </div>
      <div className="space-y-2">
        {keys.map((key) => {
          const change = diff[key];
          if (!change) return null;
          return (
            <div key={key} className="card p-3 bg-emerald-50/30 border-emerald-200/40">
              <div className="text-xs font-bold text-charcoal mb-2 font-mono">{key}</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] font-bold text-red-700 uppercase mb-1">{isAr ? 'قبل' : 'Before'}</div>
                  <pre className="text-[11px] font-mono bg-white/60 p-2 rounded whitespace-pre-wrap break-words">
{JSON.stringify(change.before, null, 2)}
                  </pre>
                </div>
                <div>
                  <div className="text-[10px] font-bold text-emerald-700 uppercase mb-1">{isAr ? 'بعد' : 'After'}</div>
                  <pre className="text-[11px] font-mono bg-white/60 p-2 rounded whitespace-pre-wrap break-words">
{JSON.stringify(change.after, null, 2)}
                  </pre>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] font-bold text-charcoal/50 uppercase tracking-wide mb-0.5">{label}</div>
      <div className={`text-sm text-charcoal break-all ${mono ? 'font-mono text-xs' : ''}`}>{value}</div>
    </div>
  );
}

function formatRelative(d: Date, isAr: boolean): string {
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return isAr ? `قبل ${s} ث` : `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return isAr ? `قبل ${m} د` : `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return isAr ? `قبل ${h} س` : `${h}h ago`;
  const day = Math.floor(h / 24);
  return isAr ? `قبل ${day} يوم` : `${day}d ago`;
}
