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
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-copper/10 text-copper">
            <Activity size={20} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-chocolate">{isAr ? 'استوديو عملية المبيعات' : 'Sales Process Studio'}</h1>
            <p className="mt-1 max-w-2xl text-xs leading-relaxed text-terracotta">
              {isAr
                ? 'لكل مرحلة: عدد العملاء النشطين، المتابعات المتأخرة، 🔗 سير العمل المرتبط، ⚠ الأنشطة بدون سير عمل.'
                : 'Per stage: active clients, overdue follow-ups, 🔗 linked workflows, ⚠ activities with no workflow.'}
            </p>
          </div>
        </div>
        <span className="badge shrink-0 border border-sand/40 bg-cream text-terracotta">{isAr ? 'للعرض فقط' : 'Read-only'}</span>
      </header>

      {/* Lifecycle map */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
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
        <section className="card p-6">
          <div className="mb-4 flex items-center gap-3 border-b border-sand/30 pb-4">
            <span className="h-7 w-1.5 shrink-0 rounded-full" style={{ background: stage.color ?? '#C09B5F' }} />
            <h2 className="text-xl font-bold text-chocolate">
              {isAr ? stage.label_ar : stage.label_en}
              <span className="ms-2 text-sm font-normal text-terracotta">{isAr ? `(${stats.activeByStage.get(stage.value) ?? 0} عميل نشط)` : `(${stats.activeByStage.get(stage.value) ?? 0} active clients)`}</span>
            </h2>
          </div>
          {stage.followup_types.length === 0 ? (
            <p className="text-sm text-terracotta">{isAr ? 'لا توجد أنشطة لهذه المرحلة (مرحلة نهائية).' : 'No activities for this stage (terminal/side-exit).'}</p>
          ) : (
            <div className="space-y-3">
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
      className={`group relative overflow-hidden rounded-2xl border p-4 text-start shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${selected ? 'border-copper bg-cream shadow-md' : 'border-sand/40 bg-white hover:border-sand'}`}
    >
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: stage.color ?? '#C09B5F' }} />
      <div className="mt-1 text-sm font-bold text-chocolate">{isAr ? stage.label_ar : stage.label_en}</div>
      <div className="mt-2 flex flex-col gap-0.5">
        <span className="text-xs font-semibold text-charcoal">{isAr ? `${active} عميل نشط` : `${active} active`}</span>
        {overdue > 0 && <span className="text-xs font-medium text-terracotta">{isAr ? `${overdue} متأخرة` : `${overdue} overdue`}</span>}
      </div>
      {(linked > 0 || missing > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {linked > 0 && (
            <span title={isAr ? 'سير عمل مرتبط' : 'Linked workflows'} className="inline-flex items-center gap-1 rounded-full bg-copper/10 px-2 py-0.5 text-[11px] font-semibold text-copper"><WorkflowIcon size={11} /> {linked}</span>
          )}
          {missing > 0 && (
            <span title={isAr ? 'أنشطة بدون سير عمل' : 'Activities with no workflow'} className="inline-flex items-center gap-1 rounded-full bg-terracotta/10 px-2 py-0.5 text-[11px] font-semibold text-terracotta"><AlertTriangle size={11} /> {missing}</span>
          )}
        </div>
      )}
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
    <div className={`overflow-hidden rounded-2xl border transition-colors ${open ? 'border-sand bg-cream/40' : 'border-sand/40 bg-white hover:border-sand'}`}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 p-4 text-start">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-chocolate">{isAr ? typeConfig.label_ar : typeConfig.label_en}</span>
            <span className="inline-flex items-center rounded-full border border-sand/40 bg-cream px-2 py-0.5 text-[11px] font-medium text-charcoal">{channelLabel(typeConfig.primary_channel, isAr)}</span>
          </div>
          <div className="mt-1 text-xs text-terracotta">{isAr ? typeConfig.objective_ar : typeConfig.objective_en}</div>
        </div>
        <div className="shrink-0">
          {bound ? (
            drifted ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-gold/20 px-2.5 py-1 text-xs font-semibold text-terracotta"><GitBranch size={11} /> {isAr ? 'محرر يدويًا' : 'Advanced'}</span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#10B981]/15 px-2.5 py-1 text-xs font-semibold text-[#10B981]"><CheckCircle2 size={11} /> {isAr ? 'مرتبط' : 'Linked'}</span>
            )
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-terracotta/15 px-2.5 py-1 text-xs font-semibold text-terracotta"><AlertTriangle size={11} /> {isAr ? 'لا يوجد سير عمل' : 'Missing workflow'}</span>
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-sand/30 p-4">
          {/* outcomes */}
          <div className="flex flex-wrap gap-2">
            {typeConfig.allowed_outcomes.map((o) => {
              const meta = getOutcome(o.value);
              const req = requiredFieldSlugs(o);
              return (
                <div key={o.value} className="rounded-2xl border border-sand/40 bg-white px-3 py-2 text-sm shadow-sm">
                  <span className="font-bold text-copper">{isAr ? meta?.label_ar ?? o.value : meta?.label_en ?? o.value}</span>
                  {req.length > 0 && <span className="ms-2 text-xs text-terracotta">{isAr ? 'يتطلب: ' : 'requires: '}{req.join(', ')}</span>}
                  {(o.client_update_preview?.stage || o.client_update_preview?.status) && (
                    <span className="ms-2 text-xs text-charcoal">→ {o.client_update_preview?.stage ?? ''}{o.client_update_preview?.status ? ` · ${o.client_update_preview.status}` : ''}</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* workflow links */}
          <div className="mt-4 flex flex-wrap gap-2">
            {bound ? (
              <>
                <button type="button" onClick={() => navigate(`/workflow/${bound.id}`)} className="inline-flex items-center gap-2 rounded-xl border border-copper bg-copper/5 px-4 py-2 text-sm font-bold text-copper transition-colors hover:bg-copper hover:text-white">
                  <ExternalLink size={14} /> {isAr ? 'فتح في محرر سير العمل' : 'Open in Workflow Builder'}
                </button>
                <button type="button" onClick={() => navigate(`/workflow/logs?workflow=${bound.id}`)} className="inline-flex items-center gap-2 rounded-xl border border-sand/50 bg-white px-4 py-2 text-sm font-bold text-charcoal transition-colors hover:bg-cream">
                  <Activity size={14} /> {isAr ? 'عرض عمليات التشغيل' : 'View Workflow Runs'}
                </button>
              </>
            ) : (
              <p className="text-sm text-terracotta">{isAr ? 'لا يوجد سير عمل يطبق هذا النشاط بعد — أنشئه في محرر سير العمل.' : 'No workflow implements this activity yet — create one in the Workflow Builder.'}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
