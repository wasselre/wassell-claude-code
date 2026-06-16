import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Workflow as WorkflowIcon, AlertTriangle, ExternalLink, Activity, CheckCircle2, GitBranch } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  getSalesProcessConfig,
  getOutcome,
  requiredFieldSlugs,
  resolveBoundWorkflow,
  resolveBoundWorkflows,
  isWorkflowDrifted,
  channelLabel,
  type SalesStageConfig,
  type FollowUpTypeConfig,
} from '@/lib/salesProcess';
import type { AppRecord, Workflow } from '@/types';

/**
 * Sales Process Studio — a READ-ONLY visual map of the sales lifecycle. Shows
 * each stage's live counts, the activities + outcomes the config defines, which
 * workflow implements each activity ("Open in Workflow Builder"), and warns when
 * an activity has no bound workflow or its workflow has drifted from the
 * Studio-generated shape. No automation runs here (the brief's hard rule); the
 * Workflow Builder remains the only place workflows are edited. Admin-only.
 */
export default function SalesProcessStudioPage() {
  const { models, records, workflows, language } = useAppStore();
  const isAr = language === 'ar';
  const navigate = useNavigate();
  const config = getSalesProcessConfig();

  const [selectedStage, setSelectedStage] = useState<string>(config.stages[0]?.value ?? '');

  const clientsModel = models.find((m) => m.name === 'clients');
  const followupsModel = models.find((m) => m.name === 'followups');
  const now = Date.now();

  const stats = useMemo(() => {
    const clients: AppRecord[] = clientsModel ? records[clientsModel.id] ?? [] : [];
    const followups: AppRecord[] = followupsModel ? records[followupsModel.id] ?? [] : [];
    const activeByStage = new Map<string, number>();
    for (const c of clients) {
      const st = c.data.client_stage as string;
      if (st) activeByStage.set(st, (activeByStage.get(st) ?? 0) + 1);
    }
    // overdue open follow-ups grouped by the stage their type belongs to
    const overdueByStage = new Map<string, number>();
    const typeStage = new Map<string, string>();
    for (const t of config.followup_types) if (t.stage) typeStage.set(t.type, t.stage);
    for (const f of followups) {
      const status = (f.data.followup_status as string) || 'open';
      if (status !== 'open' && status !== 'in_progress') continue;
      const sched = f.data.scheduled_datetime as string;
      if (!sched || new Date(sched).getTime() >= now) continue;
      const type = Array.isArray(f.data.followup_type) ? f.data.followup_type[0] : f.data.followup_type;
      const stage = typeStage.get(type as string);
      if (stage) overdueByStage.set(stage, (overdueByStage.get(stage) ?? 0) + 1);
    }
    return { activeByStage, overdueByStage };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientsModel, followupsModel, records]);

  const stage = config.stages.find((s) => s.value === selectedStage);

  return (
    <div className="mx-auto max-w-6xl p-4">
      <header className="mb-4 flex items-center gap-2">
        <Activity className="text-[#B8734F]" />
        <h1 className="text-xl font-bold text-[#4A2C2A]">{isAr ? 'استوديو عملية المبيعات' : 'Sales Process Studio'}</h1>
        <span className="ms-2 rounded-full bg-[#F5EDE0] px-2 py-0.5 text-xs text-[#8E4E3A]">{isAr ? 'للعرض فقط' : 'Read-only'}</span>
      </header>

      <p className="mb-2 text-xs text-[#8E4E3A]">
        {isAr
          ? 'لكل مرحلة: عدد العملاء النشطين، المتابعات المتأخرة، 🔗 سير العمل المرتبط، ⚠ الأنشطة بدون سير عمل.'
          : 'Per stage: active clients, overdue follow-ups, 🔗 linked workflows, ⚠ activities with no workflow.'}
      </p>

      {/* Lifecycle map */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {config.stages.map((s) => (
          <StageCard
            key={s.value}
            stage={s}
            isAr={isAr}
            active={stats.activeByStage.get(s.value) ?? 0}
            overdue={stats.overdueByStage.get(s.value) ?? 0}
            workflows={workflows}
            selected={s.value === selectedStage}
            onSelect={() => setSelectedStage(s.value)}
          />
        ))}
      </div>

      {/* Selected stage detail */}
      {stage && (
        <section className="card">
          <h2 className="mb-3 text-lg font-bold text-[#4A2C2A]">
            {isAr ? stage.label_ar : stage.label_en}
            <span className="ms-2 text-sm font-normal text-[#8E4E3A]">{isAr ? `(${stats.activeByStage.get(stage.value) ?? 0} عميل نشط)` : `(${stats.activeByStage.get(stage.value) ?? 0} active clients)`}</span>
          </h2>
          {stage.followup_types.length === 0 ? (
            <p className="text-sm text-[#8E4E3A]">{isAr ? 'لا توجد أنشطة لهذه المرحلة (مرحلة نهائية).' : 'No activities for this stage (terminal/side-exit).'}</p>
          ) : (
            <div className="space-y-4">
              {stage.followup_types.map((typeKey) => {
                const tc = config.followup_types.find((t) => t.type === typeKey);
                if (!tc) return null;
                return <ActivityBlock key={typeKey} typeConfig={tc} workflows={workflows} isAr={isAr} navigate={navigate} />;
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function StageCard({
  stage, isAr, active, overdue, workflows, selected, onSelect,
}: {
  stage: SalesStageConfig; isAr: boolean; active: number; overdue: number;
  workflows: Workflow[]; selected: boolean; onSelect: () => void;
}) {
  const linked = resolveBoundWorkflows(workflows, { sales_stage: stage.value }).length;
  const missing = stage.followup_types.filter((t) => !resolveBoundWorkflow(workflows, { activity_type: t })).length;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-xl border p-3 text-start transition ${selected ? 'border-[#B8734F] bg-[#F5EDE0]' : 'border-[#D4B896] bg-white hover:bg-[#F5EDE0]'}`}
      style={{ borderTop: `3px solid ${stage.color ?? '#C09B5F'}` }}
    >
      <div className="text-sm font-bold text-[#4A2C2A]">{isAr ? stage.label_ar : stage.label_en}</div>
      <div className="mt-1 text-xs text-[#4A4E54]">{isAr ? `${active} عميل نشط` : `${active} active`}</div>
      {overdue > 0 && <div className="text-xs text-[#8E4E3A]">{isAr ? `${overdue} متأخرة` : `${overdue} overdue`}</div>}
      <div className="mt-1 flex items-center gap-2 text-xs text-[#8E4E3A]">
        {linked > 0 && (
          <span title={isAr ? 'سير عمل مرتبط' : 'Linked workflows'} className="inline-flex items-center gap-0.5"><WorkflowIcon size={11} /> {linked}</span>
        )}
        {missing > 0 && (
          <span title={isAr ? 'أنشطة بدون سير عمل' : 'Activities with no workflow'} className="inline-flex items-center gap-0.5"><AlertTriangle size={11} /> {missing}</span>
        )}
      </div>
    </button>
  );
}

function ActivityBlock({
  typeConfig, workflows, isAr, navigate,
}: {
  typeConfig: FollowUpTypeConfig; workflows: Workflow[]; isAr: boolean; navigate: (to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const bound = resolveBoundWorkflow(workflows, { activity_type: typeConfig.type });
  const drifted = bound ? isWorkflowDrifted(bound) : false;

  return (
    <div className="rounded-lg border border-[#D4B896]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-start justify-between gap-2 p-3 text-start">
        <div>
          <div className="font-semibold text-[#4A4E54]">{isAr ? typeConfig.label_ar : typeConfig.label_en}</div>
          <div className="text-xs text-[#8E4E3A]">{isAr ? typeConfig.objective_ar : typeConfig.objective_en} · {channelLabel(typeConfig.primary_channel, isAr)}</div>
        </div>
        <div className="shrink-0">
          {bound ? (
            drifted ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#C09B5F]/20 px-2 py-0.5 text-xs text-[#8E4E3A]"><GitBranch size={11} /> {isAr ? 'محرر يدويًا' : 'Advanced'}</span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#10B981]/15 px-2 py-0.5 text-xs text-[#10B981]"><CheckCircle2 size={11} /> {isAr ? 'مرتبط' : 'Linked'}</span>
            )
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#8E4E3A]/15 px-2 py-0.5 text-xs text-[#8E4E3A]"><AlertTriangle size={11} /> {isAr ? 'لا يوجد سير عمل' : 'Missing workflow'}</span>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-[#D4B896] p-3">
          {/* outcomes */}
          <div className="space-y-2">
            {typeConfig.allowed_outcomes.map((o) => {
              const meta = getOutcome(o.value);
              const req = requiredFieldSlugs(o);
              return (
                <div key={o.value} className="rounded-md bg-[#F5EDE0] p-2 text-sm">
                  <span className="font-medium text-[#B8734F]">{isAr ? meta?.label_ar ?? o.value : meta?.label_en ?? o.value}</span>
                  {req.length > 0 && <span className="ms-2 text-xs text-[#8E4E3A]">{isAr ? 'يتطلب: ' : 'requires: '}{req.join(', ')}</span>}
                  {(o.client_update_preview?.stage || o.client_update_preview?.status) && (
                    <span className="ms-2 text-xs text-[#4A4E54]">→ {o.client_update_preview?.stage ?? ''}{o.client_update_preview?.status ? ` · ${o.client_update_preview.status}` : ''}</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* workflow links */}
          <div className="mt-3 flex flex-wrap gap-2">
            {bound ? (
              <>
                <button type="button" onClick={() => navigate(`/workflow/${bound.id}`)} className="inline-flex items-center gap-1 rounded-lg border border-[#B8734F] px-3 py-1.5 text-sm text-[#B8734F] hover:bg-[#F5EDE0]">
                  <ExternalLink size={14} /> {isAr ? 'فتح في محرر سير العمل' : 'Open in Workflow Builder'}
                </button>
                <button type="button" onClick={() => navigate(`/workflow/logs?workflow=${bound.id}`)} className="inline-flex items-center gap-1 rounded-lg border border-[#D4B896] px-3 py-1.5 text-sm text-[#4A4E54] hover:bg-[#F5EDE0]">
                  <Activity size={14} /> {isAr ? 'عرض عمليات التشغيل' : 'View Workflow Runs'}
                </button>
              </>
            ) : (
              <p className="text-sm text-[#8E4E3A]">{isAr ? 'لا يوجد سير عمل يطبق هذا النشاط بعد — أنشئه في محرر سير العمل.' : 'No workflow implements this activity yet — create one in the Workflow Builder.'}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
