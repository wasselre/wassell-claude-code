import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { ScrollText, ChevronRight, Trash2, RefreshCw, Search } from 'lucide-react';
import type { WorkflowRun, WorkflowRunStatus } from '@/types';

type StatusFilter = 'all' | WorkflowRunStatus;

const STATUS_META: Record<WorkflowRunStatus, { ar: string; en: string; dotClass: string; textClass: string; bgClass: string }> = {
  success:          { ar: 'نجح',         en: 'Success',        dotClass: 'bg-emerald-500',  textClass: 'text-emerald-700',  bgClass: 'bg-emerald-50' },
  partial_success:  { ar: 'نجح جزئياً',   en: 'Partial',        dotClass: 'bg-amber-500',    textClass: 'text-amber-700',    bgClass: 'bg-amber-50' },
  skipped:          { ar: 'تخطّى',        en: 'Skipped',        dotClass: 'bg-charcoal/30',  textClass: 'text-charcoal/50',  bgClass: 'bg-charcoal/5' },
  failed:           { ar: 'فشل',          en: 'Failed',         dotClass: 'bg-red-500',      textClass: 'text-red-700',      bgClass: 'bg-red-50' },
  depth_exceeded:   { ar: 'تجاوز العمق',  en: 'Depth limit',    dotClass: 'bg-purple-500',   textClass: 'text-purple-700',   bgClass: 'bg-purple-50' },
};

const EVENT_LABELS: Record<string, { ar: string; en: string }> = {
  create: { ar: 'إنشاء', en: 'Create' },
  update: { ar: 'تحديث', en: 'Update' },
  delete: { ar: 'حذف',   en: 'Delete' },
};

export default function WorkflowLogsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { workflowRuns, workflows, models, users, language, clearWorkflowRuns, addToast } = useAppStore();
  const isAr = language === 'ar';

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [workflowFilter, setWorkflowFilter] = useState<string>('all');
  const [modelFilter, setModelFilter] = useState<string>('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    return workflowRuns.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (workflowFilter !== 'all' && r.workflow_id !== workflowFilter) return false;
      if (modelFilter !== 'all' && r.trigger_model_id !== modelFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const hay = [
          r.workflow_label_ar, r.workflow_label_en,
          r.trigger_record_id,
          r.error,
          JSON.stringify(r.trigger_record_snapshot ?? {}),
        ].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [workflowRuns, statusFilter, workflowFilter, modelFilter, search]);

  const stats = useMemo(() => {
    const out = { total: workflowRuns.length, success: 0, partial_success: 0, failed: 0, skipped: 0, depth_exceeded: 0 };
    for (const r of workflowRuns) out[r.status]++;
    return out;
  }, [workflowRuns]);

  const userLabel = (id?: string | null) => {
    if (!id) return isAr ? 'النظام' : 'System';
    const u = users.find((x) => x.id === id);
    return u ? (isAr ? u.name_ar : u.name_en) : id.slice(0, 8);
  };

  const onClearAll = () => {
    if (!workflowRuns.length) return;
    if (!confirm(isAr ? 'حذف جميع السجلات؟' : 'Delete ALL workflow run logs?')) return;
    clearWorkflowRuns();
    addToast(isAr ? 'تم الحذف' : 'Deleted', 'success');
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-charcoal/5 flex items-center justify-center">
            <ScrollText size={22} className="text-charcoal/60" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-chocolate">
              {isAr ? 'سجل تنفيذ سير العمل' : 'Workflow Execution Logs'}
            </h1>
            <p className="text-xs text-charcoal/40">
              {isAr
                ? 'كل مرة يتم فيها تفعيل سير عمل — ما الذي تم فحصه وما الذي تم تنفيذه بالتفصيل الكامل'
                : 'Every workflow firing — every condition checked, every action taken, in full detail'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => window.location.reload()}
            className="p-2.5 rounded-xl hover:bg-cream text-charcoal/40 hover:text-charcoal"
            title={isAr ? 'تحديث' : 'Refresh'}
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={onClearAll}
            disabled={!workflowRuns.length}
            className="pill border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 size={14} />
            {isAr ? 'مسح الكل' : 'Clear all'}
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
        <StatCard label={isAr ? 'الإجمالي' : 'Total'}            value={stats.total}            colorClass="text-charcoal" />
        <StatCard label={isAr ? 'نجح' : 'Success'}               value={stats.success}          colorClass="text-emerald-700" />
        <StatCard label={isAr ? 'جزئي' : 'Partial'}              value={stats.partial_success}  colorClass="text-amber-700" />
        <StatCard label={isAr ? 'تخطّى' : 'Skipped'}             value={stats.skipped}          colorClass="text-charcoal/60" />
        <StatCard label={isAr ? 'فشل' : 'Failed'}                value={stats.failed}           colorClass="text-red-700" />
      </div>

      {/* Filters */}
      <div className="card p-4 mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 flex-1 min-w-[220px]">
          <Search size={14} className="text-charcoal/30" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={isAr ? 'بحث (اسم، معرّف سجل، خطأ...)' : 'Search (name, record id, error...)'}
            className="form-input text-sm flex-1 border-0 focus:ring-0"
          />
        </div>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="form-input text-sm"
        >
          <option value="all">{isAr ? 'كل الحالات' : 'All statuses'}</option>
          {(Object.keys(STATUS_META) as WorkflowRunStatus[]).map((s) => (
            <option key={s} value={s}>{isAr ? STATUS_META[s].ar : STATUS_META[s].en}</option>
          ))}
        </select>

        <select
          value={workflowFilter}
          onChange={(e) => setWorkflowFilter(e.target.value)}
          className="form-input text-sm"
        >
          <option value="all">{isAr ? 'كل قواعد السير' : 'All workflows'}</option>
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>{isAr ? w.label_ar : w.label_en}</option>
          ))}
        </select>

        <select
          value={modelFilter}
          onChange={(e) => setModelFilter(e.target.value)}
          className="form-input text-sm"
        >
          <option value="all">{isAr ? 'كل النماذج' : 'All models'}</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>{isAr ? m.label_ar : m.label_en}</option>
          ))}
        </select>
      </div>

      {/* List */}
      {workflowRuns.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-charcoal/30">
          <ScrollText size={48} className="mb-4" />
          <p className="text-lg font-bold">{isAr ? 'لا توجد سجلات بعد' : 'No logs yet'}</p>
          <p className="text-sm">{isAr ? 'ستظهر السجلات هنا تلقائياً عند تنفيذ أي سير عمل.' : 'Logs will appear here automatically when a workflow runs.'}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-8 text-center text-charcoal/40 text-sm">
          {isAr ? 'لا نتائج مطابقة للفلاتر الحالية' : 'No runs match the current filters'}
        </div>
      ) : (
        <div className="grid gap-2">
          {filtered.map((r) => (
            <RunRow key={r.id} run={r} isAr={isAr} userLabel={userLabel(r.triggered_by_user_id)} onClick={() => navigate(`/workflow/logs/${r.id}`)} />
          ))}
        </div>
      )}

      {/* Suppress unused t warning — reserved for future localized empty states */}
      <span className="hidden">{t('workflow.title')}</span>
    </div>
  );
}

function StatCard({ label, value, colorClass }: { label: string; value: number; colorClass: string }) {
  return (
    <div className="card p-3">
      <div className="text-xs font-bold text-charcoal/40">{label}</div>
      <div className={`text-xl font-bold ${colorClass}`}>{value}</div>
    </div>
  );
}

function RunRow({ run, isAr, userLabel, onClick }: { run: WorkflowRun; isAr: boolean; userLabel: string; onClick: () => void }) {
  const meta = STATUS_META[run.status];
  const when = new Date(run.started_at);
  const ago = formatRelative(when, isAr);
  const event = EVENT_LABELS[run.trigger_event] ?? { ar: run.trigger_event, en: run.trigger_event };
  const actionsSummary = summarizeActions(run, isAr);

  return (
    <button
      onClick={onClick}
      className="card p-4 w-full text-start flex items-center gap-3 hover:border-copper/30 transition-colors"
    >
      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${meta.dotClass}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-charcoal text-sm truncate">{isAr ? run.workflow_label_ar : run.workflow_label_en}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-bold ${meta.bgClass} ${meta.textClass}`}>
            {isAr ? meta.ar : meta.en}
          </span>
          <span className="text-[11px] text-charcoal/40 font-bold">
            {(isAr ? run.trigger_model_label_ar : run.trigger_model_label_en) ?? run.trigger_model_id.slice(0, 6)} · {isAr ? event.ar : event.en}
          </span>
        </div>
        <div className="text-xs text-charcoal/50 mt-0.5 truncate">
          {actionsSummary}
        </div>
        <div className="text-[11px] text-charcoal/30 mt-0.5 flex items-center gap-2 flex-wrap">
          <span>{when.toLocaleString(isAr ? 'ar-SA' : 'en-US')}</span>
          <span>· {ago}</span>
          <span>· {run.duration_ms}ms</span>
          <span>· {userLabel}</span>
          {run.depth > 0 && <span>· {isAr ? `عمق ${run.depth}` : `depth ${run.depth}`}</span>}
        </div>
      </div>
      <ChevronRight size={16} className="text-charcoal/20 shrink-0 rtl:rotate-180" />
    </button>
  );
}

function summarizeActions(run: WorkflowRun, isAr: boolean): string {
  if (!run.conditions_passed) {
    return isAr ? 'لم يتم تحقق شروط التفعيل' : 'Conditions did not pass';
  }
  if (run.actions_trace.length === 0) {
    return isAr ? 'لا إجراءات' : 'No actions';
  }
  const parts: string[] = [];
  for (const a of run.actions_trace) {
    const label = describeActionShort(a.type, isAr);
    const status = a.status === 'executed' ? (isAr ? '✓' : '✓') : a.status === 'skipped' ? (isAr ? '⤼' : '⤼') : '✗';
    parts.push(`${status} ${label}`);
  }
  return parts.join(' · ');
}

function describeActionShort(type: string, isAr: boolean): string {
  if (type === 'create_record') return isAr ? 'إنشاء' : 'create';
  if (type === 'update_record') return isAr ? 'تحديث' : 'update';
  if (type === 'send_notification') return isAr ? 'إشعار' : 'notify';
  if (type === 'assign_user') return isAr ? 'تعيين' : 'assign';
  return type;
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
