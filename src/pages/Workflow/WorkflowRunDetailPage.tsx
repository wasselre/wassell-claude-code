import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin } from '@/hooks/usePermission';
import { ArrowLeft, CheckCircle2, XCircle, SkipForward, AlertCircle, Clock, User as UserIcon, Database, Hash, ChevronDown, ChevronRight, Trash2, Copy, GitBranch } from 'lucide-react';
import type { WorkflowRunStatus, WorkflowActionTrace, WorkflowConditionTrace, WorkflowBranchTrace, FieldMappingTrace, AppModel } from '@/types';

export default function WorkflowRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { workflowRuns, workflows, models, users, language, deleteWorkflowRun, addToast } = useAppStore();
  const isAr = language === 'ar';
  // Read-only for workflow-view profiles; deleting a run stays admin-only.
  const isAdmin = useIsAdmin();

  const run = workflowRuns.find((r) => r.id === runId);

  if (!run) {
    return (
      <div className="py-20 text-center text-charcoal/40">
        <p>{isAr ? 'السجل غير موجود' : 'Run not found'}</p>
        <button onClick={() => navigate('/workflow/logs')} className="pill mt-4 text-copper">
          {isAr ? 'العودة للسجلات' : 'Back to logs'}
        </button>
      </div>
    );
  }

  const workflow = workflows.find((w) => w.id === run.workflow_id);
  const triggerModel = models.find((m) => m.id === run.trigger_model_id);
  const user = users.find((u) => u.id === run.triggered_by_user_id);
  const statusMeta = STATUS_META[run.status];

  const onDelete = () => {
    if (!confirm(isAr ? 'حذف هذا السجل؟' : 'Delete this run log?')) return;
    deleteWorkflowRun(run.id);
    addToast(isAr ? 'تم الحذف' : 'Deleted', 'success');
    navigate('/workflow/logs');
  };

  const copyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(run, null, 2));
    addToast(isAr ? 'نُسخ' : 'Copied JSON', 'success');
  };

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate('/workflow/logs')}
          className="p-2 rounded-lg hover:bg-cream text-charcoal/40 hover:text-charcoal rtl:rotate-180"
          title={isAr ? 'رجوع' : 'Back'}
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold text-chocolate">{isAr ? run.workflow_label_ar : run.workflow_label_en}</h1>
            <span className={`text-xs px-2 py-0.5 rounded-md font-bold ${statusMeta.bgClass} ${statusMeta.textClass}`}>
              {isAr ? statusMeta.ar : statusMeta.en}
            </span>
          </div>
          <p className="text-xs text-charcoal/40 mt-0.5">
            {new Date(run.started_at).toLocaleString(isAr ? 'ar-SA' : 'en-US')} · {run.duration_ms}ms
          </p>
        </div>
        <button onClick={copyJson} className="pill text-charcoal/60 border-sand/30 hover:bg-cream-light">
          <Copy size={14} />
          {isAr ? 'نسخ JSON' : 'Copy JSON'}
        </button>
        {isAdmin && (
          <button onClick={onDelete} className="pill border-red-200 text-red-600 hover:bg-red-50">
            <Trash2 size={14} />
            {isAr ? 'حذف' : 'Delete'}
          </button>
        )}
      </div>

      {/* Run summary strip */}
      <div className="card p-5 mb-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <SummaryCell
            icon={<Database size={14} />}
            label={isAr ? 'نموذج المُشغِّل' : 'Trigger model'}
            value={(isAr ? run.trigger_model_label_ar : run.trigger_model_label_en) ?? '—'}
          />
          <SummaryCell
            icon={<span className="text-[11px] font-bold uppercase tracking-wider text-charcoal/40">{run.trigger_event}</span>}
            label={isAr ? 'الحدث' : 'Event'}
            value={EVENT_LABELS[run.trigger_event] ? (isAr ? EVENT_LABELS[run.trigger_event]!.ar : EVENT_LABELS[run.trigger_event]!.en) : run.trigger_event}
          />
          <SummaryCell
            icon={<Hash size={14} />}
            label={isAr ? 'معرّف السجل' : 'Record ID'}
            value={<span className="font-mono text-xs">{run.trigger_record_id.slice(0, 8)}...</span>}
          />
          <SummaryCell
            icon={<UserIcon size={14} />}
            label={isAr ? 'المُشغِّل' : 'Triggered by'}
            value={user ? (isAr ? user.name_ar : user.name_en) : (isAr ? 'النظام' : 'System')}
          />
          <SummaryCell
            icon={<Clock size={14} />}
            label={isAr ? 'المدة' : 'Duration'}
            value={`${run.duration_ms} ms`}
          />
          <SummaryCell
            icon={<Clock size={14} />}
            label={isAr ? 'بدأ' : 'Started'}
            value={new Date(run.started_at).toLocaleTimeString(isAr ? 'ar-SA' : 'en-US')}
          />
          <SummaryCell
            icon={<Clock size={14} />}
            label={isAr ? 'انتهى' : 'Finished'}
            value={new Date(run.finished_at).toLocaleTimeString(isAr ? 'ar-SA' : 'en-US')}
          />
          <SummaryCell
            icon={<span className="text-charcoal/40 text-xs">#</span>}
            label={isAr ? 'عمق التسلسل' : 'Cascade depth'}
            value={String(run.depth)}
          />
        </div>
        {run.error && (
          <div className="mt-4 p-3 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2">
            <AlertCircle size={16} className="text-red-500 shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-xs font-bold text-red-700">{isAr ? 'خطأ' : 'Error'}</div>
              <code className="text-xs text-red-800 whitespace-pre-wrap break-words">{run.error}</code>
            </div>
          </div>
        )}
        {workflow && (
          <div className="mt-4 pt-4 border-t border-sand/15 flex items-center gap-2 text-xs">
            <span className="text-charcoal/40">{isAr ? 'اذهب إلى:' : 'Jump to:'}</span>
            <button onClick={() => navigate(`/workflow/${workflow.id}`)} className="text-copper font-bold hover:underline">
              {isAr ? 'محرر السير' : 'Workflow editor'}
            </button>
            {triggerModel && (
              <>
                <span className="text-charcoal/20">·</span>
                <button onClick={() => navigate(`/model/${triggerModel.name}/${run.trigger_record_id}`)} className="text-copper font-bold hover:underline">
                  {isAr ? 'سجل التشغيل' : 'Trigger record'}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Branches overview — only shown for branched workflows (>1 branch). */}
      {run.branches_trace && run.branches_trace.length > 1 && (
        <BranchesSection branches={run.branches_trace} isAr={isAr} triggerModel={triggerModel} />
      )}

      {/* Conditions section — reflects the winning branch (or the first
          evaluated branch when none won). */}
      <ConditionsSection conditions={run.conditions_trace} passed={run.conditions_passed} isAr={isAr} triggerModel={triggerModel} />

      {/* Actions section — actions of the winning branch. */}
      <ActionsSection actions={run.actions_trace} isAr={isAr} models={models} />

      {/* Record snapshots */}
      <SnapshotsSection run={run} isAr={isAr} triggerModel={triggerModel} />
    </div>
  );
}

// ─── Status + event meta ──────────────────────────────────────────────────────

const STATUS_META: Record<WorkflowRunStatus, { ar: string; en: string; textClass: string; bgClass: string }> = {
  success:         { ar: 'نجح',         en: 'Success',     textClass: 'text-emerald-700',  bgClass: 'bg-emerald-50' },
  partial_success: { ar: 'نجح جزئياً',   en: 'Partial',     textClass: 'text-amber-700',    bgClass: 'bg-amber-50' },
  skipped:         { ar: 'تخطّى',        en: 'Skipped',     textClass: 'text-charcoal/50',  bgClass: 'bg-charcoal/5' },
  failed:          { ar: 'فشل',          en: 'Failed',      textClass: 'text-red-700',      bgClass: 'bg-red-50' },
  depth_exceeded:  { ar: 'تجاوز العمق',  en: 'Depth limit', textClass: 'text-purple-700',   bgClass: 'bg-purple-50' },
};

const EVENT_LABELS: Record<string, { ar: string; en: string }> = {
  create: { ar: 'إنشاء', en: 'Create' },
  update: { ar: 'تحديث', en: 'Update' },
  delete: { ar: 'حذف',   en: 'Delete' },
};

// ─── Summary cell ─────────────────────────────────────────────────────────────

function SummaryCell({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] font-bold text-charcoal/40 uppercase tracking-wide">
        <span className="text-charcoal/30">{icon}</span>
        <span>{label}</span>
      </div>
      <div className="text-sm font-bold text-charcoal mt-0.5 truncate">{value}</div>
    </div>
  );
}

// ─── Conditions section ───────────────────────────────────────────────────────

function ConditionsSection({
  conditions, passed, isAr, triggerModel,
}: { conditions: WorkflowConditionTrace[]; passed: boolean; isAr: boolean; triggerModel: AppModel | undefined }) {
  const fieldLabel = (slug: string) => {
    for (const s of triggerModel?.schema.sections ?? []) {
      for (const f of s.fields) {
        if (f.name === slug) return isAr ? f.label_ar : f.label_en;
      }
    }
    return slug;
  };

  return (
    <div className="card p-5 mb-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-bold text-charcoal flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-blue-500/10 text-blue-600 flex items-center justify-center text-xs font-bold">1</span>
          {isAr ? 'الشروط' : 'Conditions'}
          <span className="text-xs text-charcoal/40 font-normal">({conditions.length})</span>
        </h2>
        <span className={`text-xs px-2 py-0.5 rounded-md font-bold ${passed ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
          {passed ? (isAr ? 'مطابق' : 'Passed') : (isAr ? 'غير مطابق' : 'Not met')}
        </span>
      </div>
      {conditions.length === 0 ? (
        <p className="text-xs text-charcoal/40">{isAr ? 'لا توجد شروط — تعمل دائماً' : 'No conditions — always runs'}</p>
      ) : (
        <div className="space-y-2">
          {conditions.map((c, idx) => (
            <div key={c.id} className={`p-3 rounded-xl border ${c.result ? 'border-emerald-200 bg-emerald-50/40' : 'border-red-200 bg-red-50/30'}`}>
              <div className="flex items-center gap-2 flex-wrap text-sm">
                <span className="text-[10px] font-bold text-charcoal/30">#{idx + 1}</span>
                {c.result ? <CheckCircle2 size={14} className="text-emerald-600" /> : <XCircle size={14} className="text-red-500" />}
                <span className="font-bold text-charcoal">{fieldLabel(c.field_id)}</span>
                <code className="text-xs bg-white px-1.5 py-0.5 rounded border border-sand/30">{c.operator}</code>
                <span className="text-charcoal/40 text-xs">{isAr ? 'متوقّع:' : 'expected:'}</span>
                <code className="text-xs bg-white px-1.5 py-0.5 rounded border border-sand/30 max-w-xs truncate">{formatValue(c.expected_value)}</code>
              </div>
              <div className="flex items-center gap-2 flex-wrap mt-1.5 text-xs">
                <span className="text-charcoal/40">{isAr ? 'فعلي:' : 'actual:'}</span>
                <code className="text-xs bg-white px-1.5 py-0.5 rounded border border-sand/30 max-w-xs truncate">{formatValue(c.actual_value)}</code>
                {c.only_on_change && (
                  <>
                    <span className="text-charcoal/20">·</span>
                    <span className="text-charcoal/40">{isAr ? 'عند التغيّر:' : 'only_on_change:'}</span>
                    <span className="text-charcoal/60 font-bold">
                      {isAr ? 'الآن' : 'now'}={String(c.passes_now)}
                      {c.passed_before !== undefined && <>, {isAr ? 'قبل' : 'before'}={String(c.passed_before)}</>}
                    </span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Actions section ──────────────────────────────────────────────────────────

function ActionsSection({ actions, isAr, models }: { actions: WorkflowActionTrace[]; isAr: boolean; models: AppModel[] }) {
  return (
    <div className="card p-5 mb-5">
      <h2 className="font-bold text-charcoal flex items-center gap-2 mb-3">
        <span className="w-7 h-7 rounded-lg bg-green-500/10 text-green-600 flex items-center justify-center text-xs font-bold">2</span>
        {isAr ? 'الإجراءات' : 'Actions'}
        <span className="text-xs text-charcoal/40 font-normal">({actions.length})</span>
      </h2>
      {actions.length === 0 ? (
        <p className="text-xs text-charcoal/40">{isAr ? 'لم يتم تنفيذ أي إجراءات' : 'No actions executed'}</p>
      ) : (
        <div className="space-y-3">
          {actions.map((a) => (
            <ActionTraceCard key={a.id} action={a} isAr={isAr} models={models} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActionTraceCard({ action, isAr, models }: { action: WorkflowActionTrace; isAr: boolean; models: AppModel[] }) {
  const [open, setOpen] = useState(true);
  const statusIcon = action.status === 'executed' ? <CheckCircle2 size={15} className="text-emerald-600" />
    : action.status === 'skipped' ? <SkipForward size={15} className="text-charcoal/40" />
    : <XCircle size={15} className="text-red-500" />;
  const statusChip = action.status === 'executed' ? 'bg-emerald-50 text-emerald-700'
    : action.status === 'skipped' ? 'bg-charcoal/5 text-charcoal/60'
    : 'bg-red-50 text-red-700';

  const typeLabel = describeActionType(action.type, isAr);
  const targetModel = 'target_model_id' in action ? models.find((m) => m.id === action.target_model_id) : undefined;

  return (
    <div className="rounded-xl border border-sand/25 bg-white overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 p-3 text-start hover:bg-cream-light/50 transition-colors"
      >
        <span className="text-[10px] font-bold text-charcoal/30">#{action.order + 1}</span>
        {statusIcon}
        <span className="font-bold text-charcoal text-sm">{typeLabel}</span>
        {targetModel && (
          <span className="text-xs text-charcoal/40">→ {isAr ? targetModel.label_ar : targetModel.label_en}</span>
        )}
        <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ms-auto ${statusChip}`}>
          {labelStatus(action.status, isAr)}
        </span>
        <span className="text-[11px] text-charcoal/30 font-mono">{action.duration_ms}ms</span>
        {open ? <ChevronDown size={14} className="text-charcoal/30" /> : <ChevronRight size={14} className="text-charcoal/30 rtl:rotate-180" />}
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 border-t border-sand/15 bg-cream-light/30 space-y-3">
          {action.skip_reason && (
            <InlineNote kind="info" text={`${isAr ? 'سبب التخطّي:' : 'Skip reason:'} ${translateSkipReason(action.skip_reason, isAr)}`} />
          )}
          {action.error && <InlineNote kind="error" text={action.error} />}

          {action.type === 'update_record' && <UpdateTraceBody action={action} isAr={isAr} targetModel={targetModel} />}
          {action.type === 'create_record' && <CreateTraceBody action={action} isAr={isAr} targetModel={targetModel} />}
          {action.type === 'send_notification' && <NotifyTraceBody action={action} isAr={isAr} />}
          {action.type === 'assign_user' && <AssignTraceBody action={action} isAr={isAr} />}
          {action.type === 'outbound_ivr' && <IvrTraceBody action={action} isAr={isAr} />}
          {action.type === 'send_whatsapp_message' && <WhatsAppMessageTraceBody action={action} isAr={isAr} />}
        </div>
      )}
    </div>
  );
}

function InlineNote({ kind, text }: { kind: 'info' | 'error'; text: string }) {
  const cls = kind === 'error' ? 'bg-red-50 border-red-200 text-red-800' : 'bg-amber-50 border-amber-200 text-amber-900';
  return (
    <div className={`text-xs rounded-lg px-3 py-2 border ${cls} whitespace-pre-wrap break-words`}>
      {text}
    </div>
  );
}

function UpdateTraceBody({
  action, isAr, targetModel,
}: { action: Extract<WorkflowActionTrace, { type: 'update_record' }>; isAr: boolean; targetModel: AppModel | undefined }) {
  return (
    <>
      <KvRow label={isAr ? 'الحقل المستخدم للبحث' : 'Filter field'} value={fieldLabel(targetModel, action.filter_field_id, isAr)} />
      <KvRow
        label={isAr ? 'مصدر قيمة البحث' : 'Filter source'}
        value={action.filter_value_source === 'trigger_field'
          ? `${isAr ? 'حقل المُشغِّل' : 'Trigger field'} · ${action.filter_trigger_field_id ?? '—'}`
          : (isAr ? 'قيمة ثابتة' : 'Static value')}
      />
      <KvRow label={isAr ? 'القيمة المُحوَّلة' : 'Resolved filter value'} value={<code className="text-xs">{formatValue(action.resolved_filter_value)}</code>} />
      {action.matched_record_id ? (
        <>
          <KvRow label={isAr ? 'السجل المطابق' : 'Matched record'} value={<code className="text-xs font-mono">{action.matched_record_id}</code>} />
          {action.matched_by_record_id && (
            <KvRow
              label={isAr ? 'طريقة المطابقة' : 'Match strategy'}
              value={<span className="text-charcoal/60">{isAr ? 'عبر معرّف السجل (حقل البحث حقل ارتباط)' : 'By record id (filter source is a lookup)'}</span>}
            />
          )}
        </>
      ) : (
        <InlineNote kind="info" text={isAr ? 'لم يتم العثور على سجل مطابق' : 'No matching record found'} />
      )}
      {action.field_mappings.length > 0 && (
        <FieldMappingsTable mappings={action.field_mappings} targetModel={targetModel} isAr={isAr} />
      )}
      {action.diff && Object.keys(action.diff).length > 0 && (
        <DiffTable diff={action.diff} targetModel={targetModel} isAr={isAr} />
      )}
    </>
  );
}

function CreateTraceBody({
  action, isAr, targetModel,
}: { action: Extract<WorkflowActionTrace, { type: 'create_record' }>; isAr: boolean; targetModel: AppModel | undefined }) {
  return (
    <>
      {action.created_record_id && (
        <KvRow label={isAr ? 'السجل المُنشأ' : 'Created record'} value={<code className="text-xs font-mono">{action.created_record_id}</code>} />
      )}
      {action.dedup_checked && (
        <KvRow
          label={isAr ? 'فحص التكرار' : 'Dedup check'}
          value={action.dedup_match_record_id
            ? <span className="text-amber-700">{isAr ? 'موجود — تم التخطّي' : `matched ${action.dedup_match_record_id}`}</span>
            : <span className="text-emerald-700">{isAr ? 'لا تكرار' : 'no duplicate'}</span>}
        />
      )}
      {action.field_mappings.length > 0 && (
        <FieldMappingsTable mappings={action.field_mappings} targetModel={targetModel} isAr={isAr} />
      )}
      {Object.keys(action.resolved_data ?? {}).length > 0 && (
        <DataTable title={isAr ? 'بيانات السجل الجديد' : 'New record data'} data={action.resolved_data} targetModel={targetModel} isAr={isAr} />
      )}
    </>
  );
}

function NotifyTraceBody({
  action, isAr,
}: { action: Extract<WorkflowActionTrace, { type: 'send_notification' }>; isAr: boolean }) {
  return (
    <>
      <KvRow label={isAr ? 'اللغة المعروضة' : 'Shown language'} value={action.shown_language === 'ar' ? 'العربية' : 'English'} />
      <KvRow label={isAr ? 'النص المعروض' : 'Shown message'} value={<span className="text-sm">{action.shown_message}</span>} />
      <KvRow label={isAr ? 'القالب (عربي)' : 'Template (Arabic)'} value={<span className="text-xs text-charcoal/60" dir="rtl">{action.message_ar || '—'}</span>} />
      <KvRow label={isAr ? 'القالب (إنجليزي)' : 'Template (English)'} value={<span className="text-xs text-charcoal/60" dir="ltr">{action.message_en || '—'}</span>} />
    </>
  );
}

function AssignTraceBody({
  action, isAr,
}: { action: Extract<WorkflowActionTrace, { type: 'assign_user' }>; isAr: boolean }) {
  const { users } = useAppStore();
  const assignedUser = users.find((u) => u.id === action.assigned_user_id);
  const prevUser = typeof action.previous_assignee_id === 'string' ? users.find((u) => u.id === action.previous_assignee_id) : undefined;
  return (
    <>
      <KvRow label={isAr ? 'حقل التعيين' : 'Assignment field'} value={action.assignment_field_id} />
      <KvRow label={isAr ? 'طريقة التعيين' : 'Mode'} value={action.mode === 'specific_user' ? (isAr ? 'مستخدم محدد' : 'Specific user') : (isAr ? 'حسب الدور' : 'Role-based')} />
      {action.mode === 'role_based' && (
        <>
          <KvRow label={isAr ? 'شروط الدور' : 'Role conditions'} value={String(action.role_conditions_count)} />
          <KvRow label={isAr ? 'عدد المرشحين' : 'Candidates'} value={String(action.candidates_count ?? 0)} />
          <KvRow label={isAr ? 'طريقة الاختيار' : 'Selection strategy'} value={action.selection_strategy === 'least_workload' ? (isAr ? 'أقل حمل عمل' : 'Least workload') : (isAr ? 'أول تطابق' : 'First match')} />
        </>
      )}
      {prevUser && (
        <KvRow label={isAr ? 'المُعيَّن السابق' : 'Previous assignee'} value={<span className="text-charcoal/60">{isAr ? prevUser.name_ar : prevUser.name_en}</span>} />
      )}
      {assignedUser && (
        <KvRow label={isAr ? 'المُعيَّن الجديد' : 'New assignee'} value={<span className="font-bold">{isAr ? assignedUser.name_ar : assignedUser.name_en} ({assignedUser.email})</span>} />
      )}
    </>
  );
}

function IvrTraceBody({
  action, isAr,
}: { action: Extract<WorkflowActionTrace, { type: 'outbound_ivr' }>; isAr: boolean }) {
  const kindLabel = (kind: NonNullable<typeof action.destination_kind>): string => {
    const map: Record<typeof kind, { ar: string; en: string }> = {
      trigger_field:      { ar: 'حقل في المُشغِّل', en: 'Trigger field' },
      lookup:             { ar: 'حقل مرجعي',        en: 'Lookup' },
      static:             { ar: 'رقم ثابت',          en: 'Static number' },
      prev_action_output: { ar: 'مخرج إجراء سابق',   en: 'Previous action output' },
    };
    const entry = map[kind];
    return isAr ? entry.ar : entry.en;
  };

  return (
    <>
      <KvRow
        label={isAr ? 'الرقم المُتصل به' : 'Dialed number'}
        value={<span dir="ltr" className="font-mono">{action.resolved_to_number ?? '—'}</span>}
      />
      {action.destination_kind && (
        <KvRow
          label={isAr ? 'مصدر الرقم' : 'Number source'}
          value={
            <span>
              {kindLabel(action.destination_kind)}
              {action.destination_description && (
                <span className="text-charcoal/50 ms-2" dir="ltr">· {action.destination_description}</span>
              )}
            </span>
          }
        />
      )}
      <KvRow
        label={isAr ? 'مصدر الصوت' : 'Audio source'}
        value={action.audio_mode === 'tts'
          ? (isAr ? 'نص إلى كلام' : 'Text-to-speech')
          : (isAr ? 'ملف صوتي' : 'Audio file')}
      />
      {action.audio_mode === 'tts' && action.resolved_tts_text && (
        <KvRow
          label={isAr ? 'النص المُرسَل' : 'Sent text'}
          value={<span className="whitespace-pre-wrap">{action.resolved_tts_text}</span>}
        />
      )}
      {action.audio_mode === 'tts' && action.tts_voice && (
        <KvRow
          label={isAr ? 'الصوت' : 'Voice'}
          value={action.tts_voice === 'Female' ? (isAr ? 'أنثى' : 'Female') : (isAr ? 'ذكر' : 'Male')}
        />
      )}
      {action.audio_mode === 'audio' && action.audio_file_url && (
        <KvRow
          label={isAr ? 'رابط الملف الصوتي' : 'Audio file URL'}
          value={<a href={action.audio_file_url} target="_blank" rel="noopener noreferrer" className="underline text-copper break-all">{action.audio_file_url}</a>}
        />
      )}
      <KvRow label={isAr ? 'عدد الخيارات' : 'Options'} value={String(action.options_count)} />
      {action.ivr_call_id && (
        <KvRow
          label={isAr ? 'معرّف المكالمة' : 'IVR call id'}
          value={<code className="text-xs font-mono">{action.ivr_call_id}</code>}
        />
      )}
      {action.response_status !== undefined && (
        <KvRow label={isAr ? 'حالة الاستجابة' : 'Response status'} value={String(action.response_status)} />
      )}
      {action.response_snippet && (
        <KvRow
          label={isAr ? 'ردّ الخادم' : 'Server response'}
          value={<code className="text-xs font-mono break-all whitespace-pre-wrap bg-sand/20 px-2 py-1 rounded block">{action.response_snippet}</code>}
        />
      )}
    </>
  );
}

function WhatsAppMessageTraceBody({
  action, isAr,
}: { action: Extract<WorkflowActionTrace, { type: 'send_whatsapp_message' }>; isAr: boolean }) {
  return (
    <>
      <KvRow
        label={isAr ? 'الرقم المستقبل' : 'Recipient'}
        value={<span dir="ltr" className="font-mono">{action.resolved_to_number ?? '—'}</span>}
      />
      {action.destination_description && (
        <KvRow
          label={isAr ? 'مصدر الرقم' : 'Source'}
          value={<code className="text-xs font-mono">{action.destination_description}</code>}
        />
      )}
      {action.resolved_body && (
        <KvRow
          label={isAr ? 'نص الرسالة' : 'Message body'}
          value={<span className="whitespace-pre-wrap">{action.resolved_body}</span>}
        />
      )}
      {action.device_id && (
        <KvRow
          label={isAr ? 'الرقم المُرسِل' : 'Send-from device'}
          value={<code className="text-xs font-mono">{action.device_id}</code>}
        />
      )}
      {action.message_wid && (
        <KvRow
          label={isAr ? 'معرّف الرسالة' : 'Message wid'}
          value={<code className="text-xs font-mono">{action.message_wid}</code>}
        />
      )}
      {action.response_status !== undefined && (
        <KvRow label={isAr ? 'حالة الاستجابة' : 'Response status'} value={String(action.response_status)} />
      )}
      {action.response_snippet && (
        <KvRow
          label={isAr ? 'جسم الاستجابة' : 'Response body'}
          value={<code className="text-xs whitespace-pre-wrap break-all">{action.response_snippet}</code>}
        />
      )}
    </>
  );
}

function KvRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-xs">
      <span className="text-charcoal/40 w-36 shrink-0 font-bold">{label}</span>
      <span className="flex-1 text-charcoal">{value}</span>
    </div>
  );
}

function FieldMappingsTable({
  mappings, targetModel, isAr,
}: { mappings: FieldMappingTrace[]; targetModel: AppModel | undefined; isAr: boolean }) {
  return (
    <div className="mt-2">
      <div className="text-xs font-bold text-charcoal/40 mb-1.5">{isAr ? 'ربط الحقول' : 'Field mappings'}</div>
      <div className="rounded-xl overflow-hidden border border-sand/25">
        <table className="w-full text-xs">
          <thead className="bg-charcoal/5">
            <tr>
              <th className="px-3 py-2 text-start font-bold text-charcoal/50">{isAr ? 'الحقل المستهدف' : 'Target field'}</th>
              <th className="px-3 py-2 text-start font-bold text-charcoal/50">{isAr ? 'المصدر' : 'Source'}</th>
              <th className="px-3 py-2 text-start font-bold text-charcoal/50">{isAr ? 'القيمة' : 'Resolved value'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand/15 bg-white">
            {mappings.map((m, i) => (
              <tr key={i}>
                <td className="px-3 py-2 font-bold text-charcoal">{fieldLabel(targetModel, m.target_field_id, isAr)}</td>
                <td className="px-3 py-2 text-charcoal/60"><code className="text-xs">{m.source_description}</code></td>
                <td className="px-3 py-2 text-charcoal"><code className="text-xs">{formatValue(m.resolved_value)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiffTable({
  diff, targetModel, isAr,
}: { diff: Record<string, { before: unknown; after: unknown }>; targetModel: AppModel | undefined; isAr: boolean }) {
  const entries = Object.entries(diff);
  return (
    <div className="mt-2">
      <div className="text-xs font-bold text-charcoal/40 mb-1.5">{isAr ? 'التغييرات' : 'Changes'}</div>
      <div className="rounded-xl overflow-hidden border border-sand/25">
        <table className="w-full text-xs">
          <thead className="bg-charcoal/5">
            <tr>
              <th className="px-3 py-2 text-start font-bold text-charcoal/50">{isAr ? 'الحقل' : 'Field'}</th>
              <th className="px-3 py-2 text-start font-bold text-charcoal/50">{isAr ? 'قبل' : 'Before'}</th>
              <th className="px-3 py-2 text-start font-bold text-charcoal/50">{isAr ? 'بعد' : 'After'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand/15 bg-white">
            {entries.map(([key, { before, after }]) => (
              <tr key={key}>
                <td className="px-3 py-2 font-bold text-charcoal">{fieldLabel(targetModel, key, isAr)}</td>
                <td className="px-3 py-2"><code className="text-xs text-red-600">{formatValue(before)}</code></td>
                <td className="px-3 py-2"><code className="text-xs text-emerald-600">{formatValue(after)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DataTable({
  title, data, targetModel, isAr,
}: { title: string; data: Record<string, unknown>; targetModel: AppModel | undefined; isAr: boolean }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-xs font-bold text-charcoal/40 mb-1.5">{title}</div>
      <div className="rounded-xl overflow-hidden border border-sand/25">
        <table className="w-full text-xs">
          <thead className="bg-charcoal/5">
            <tr>
              <th className="px-3 py-2 text-start font-bold text-charcoal/50">{isAr ? 'الحقل' : 'Field'}</th>
              <th className="px-3 py-2 text-start font-bold text-charcoal/50">{isAr ? 'القيمة' : 'Value'}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand/15 bg-white">
            {entries.map(([key, value]) => (
              <tr key={key}>
                <td className="px-3 py-2 font-bold text-charcoal">{fieldLabel(targetModel, key, isAr)}</td>
                <td className="px-3 py-2 text-charcoal"><code className="text-xs">{formatValue(value)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Record snapshots section (before/after) ──────────────────────────────────

function SnapshotsSection({ run, isAr, triggerModel }: { run: import('@/types').WorkflowRun; isAr: boolean; triggerModel: AppModel | undefined }) {
  const [open, setOpen] = useState(false);
  if (!run.trigger_record_snapshot && !run.previous_record_snapshot) return null;
  return (
    <div className="card p-5 mb-5">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between">
        <h2 className="font-bold text-charcoal flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-purple-500/10 text-purple-600 flex items-center justify-center text-xs font-bold">3</span>
          {isAr ? 'لقطة السجل' : 'Record snapshot'}
        </h2>
        {open ? <ChevronDown size={16} className="text-charcoal/30" /> : <ChevronRight size={16} className="text-charcoal/30 rtl:rotate-180" />}
      </button>
      {open && (
        <div className="mt-4 grid md:grid-cols-2 gap-4">
          {run.previous_record_snapshot && (
            <DataTable title={isAr ? 'قبل الحدث' : 'Before event'} data={run.previous_record_snapshot} targetModel={triggerModel} isAr={isAr} />
          )}
          {run.trigger_record_snapshot && (
            <DataTable title={isAr ? 'عند التشغيل' : 'At trigger time'} data={run.trigger_record_snapshot} targetModel={triggerModel} isAr={isAr} />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fieldLabel(model: AppModel | undefined, slug: string, isAr: boolean): string {
  for (const s of model?.schema.sections ?? []) {
    for (const f of s.fields) {
      if (f.name === slug) return isAr ? f.label_ar : f.label_en;
    }
  }
  return slug;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v === '' ? '""' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function describeActionType(type: string, isAr: boolean): string {
  if (type === 'create_record') return isAr ? 'إنشاء سجل' : 'Create record';
  if (type === 'update_record') return isAr ? 'تحديث سجل' : 'Update record';
  if (type === 'send_notification') return isAr ? 'إرسال إشعار' : 'Send notification';
  if (type === 'assign_user') return isAr ? 'تعيين مستخدم' : 'Assign user';
  if (type === 'http_request') return isAr ? 'طلب HTTP' : 'HTTP Request';
  if (type === 'outbound_ivr') return isAr ? 'مكالمة آلية' : 'Automated call';
  if (type === 'send_whatsapp_message') return isAr ? 'إرسال واتساب' : 'Send WhatsApp';
  return type;
}

function labelStatus(s: string, isAr: boolean): string {
  if (s === 'executed') return isAr ? 'نُفِّذ' : 'Executed';
  if (s === 'skipped') return isAr ? 'تخطّى' : 'Skipped';
  if (s === 'failed') return isAr ? 'فشل' : 'Failed';
  return s;
}

function translateSkipReason(reason: string, isAr: boolean): string {
  const map: Record<string, { ar: string; en: string }> = {
    no_matching_record:  { ar: 'لم يتم العثور على سجل مطابق', en: 'No matching record found' },
    duplicate_exists:    { ar: 'توجد نسخة مطابقة — تم التخطّي', en: 'Duplicate exists — skipped' },
    no_eligible_users:   { ar: 'لا يوجد مستخدمون مؤهّلون للدور', en: 'No eligible users for the role' },
    no_specific_user:    { ar: 'لم يتم تحديد مستخدم', en: 'No specific user selected' },
  };
  const hit = map[reason];
  return hit ? (isAr ? hit.ar : hit.en) : reason;
}

// ─── Branches section ─────────────────────────────────────────────────────────
//
// Only shown for branched workflows (>1 branch). Gives a quick view of which
// arm of the if / else-if / else tree was taken at run time. The full
// per-branch condition detail lives in ConditionsSection below (winning branch
// only) — this section is the at-a-glance tree map.

function BranchesSection({
  branches, isAr, triggerModel,
}: { branches: WorkflowBranchTrace[]; isAr: boolean; triggerModel: AppModel | undefined }) {
  const fieldLabel = (slug: string) => {
    for (const s of triggerModel?.schema.sections ?? []) {
      for (const f of s.fields) {
        if (f.name === slug) return isAr ? f.label_ar : f.label_en;
      }
    }
    return slug;
  };

  return (
    <div className="card p-5 mb-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-bold text-charcoal flex items-center gap-2">
          <span className="w-7 h-7 rounded-lg bg-copper/15 text-copper flex items-center justify-center">
            <GitBranch size={14} />
          </span>
          {isAr ? 'الفروع' : 'Branches'}
          <span className="text-xs text-charcoal/40 font-normal">({branches.length})</span>
        </h2>
      </div>
      <div className="space-y-1.5">
        {branches.map((b, idx) => {
          const label = (isAr ? b.branch_label_ar : b.branch_label_en)
            ?? (b.is_else
              ? (isAr ? 'الحالة الافتراضية' : 'Default case')
              : (isAr ? `الفرع #${idx + 1}` : `Branch #${idx + 1}`));

          let statusPill;
          if (b.was_selected) {
            statusPill = (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                {isAr ? 'فائز' : 'WINNER'}
              </span>
            );
          } else if (!b.evaluated) {
            statusPill = (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-charcoal/5 text-charcoal/40">
                {isAr ? 'متجاهل' : 'SKIPPED'}
              </span>
            );
          } else {
            statusPill = (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-600">
                {isAr ? 'لم يطابق' : 'NO MATCH'}
              </span>
            );
          }

          return (
            <div
              key={b.branch_id}
              className={`flex items-start gap-3 p-3 rounded-xl border transition-colors ${
                b.was_selected
                  ? 'bg-emerald-50/60 border-emerald-200'
                  : b.evaluated
                    ? 'bg-white border-sand/30'
                    : 'bg-cream-light/40 border-sand/20 opacity-60'
              }`}
            >
              <div className="shrink-0 w-7 h-7 rounded-lg bg-white border border-sand/30 flex items-center justify-center text-xs font-bold text-charcoal/60">
                {idx + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-sm text-chocolate">{label}</span>
                  {b.is_else && (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-chocolate/10 text-chocolate/70 tracking-wider">
                      {isAr ? 'وإلا' : 'ELSE'}
                    </span>
                  )}
                  {statusPill}
                </div>
                {b.evaluated && b.conditions_trace.length > 0 && (
                  <div className="mt-1.5 space-y-0.5">
                    {b.conditions_trace.map((c) => (
                      <div key={c.id} className="text-xs flex items-center gap-1.5 text-charcoal/60">
                        <span className={c.result ? 'text-emerald-600' : 'text-red-500'}>
                          {c.result ? '✓' : '✗'}
                        </span>
                        <span className="font-mono text-[11px]">
                          {fieldLabel(c.field_id)} {c.operator} {formatValue(c.expected_value)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
