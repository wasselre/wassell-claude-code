import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FlaskConical, Plus, ArrowLeft, Play, Pause, CheckCircle2, Copy, Archive, Users, AlertTriangle, MoreVertical } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin } from '@/hooks/usePermission';
import type { SalesExperiment } from '@/types';
import { useExperimentAnalytics } from './lib/useStudioData';
import { EXPERIMENT_STATUS_LABELS, PRIMARY_METRIC_LABELS, statusColor, formatMetric, pick, primaryToFunnelKey } from './lib/labels';
import { RECOMMENDATION_LABEL } from '@/lib/salesStudio';
import ExperimentBuilderModal from './components/ExperimentBuilderModal';

export default function ExperimentsPage() {
  const { language, salesExperiments } = useAppStore();
  const isAr = language === 'ar';
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<SalesExperiment | null>(null);

  const grouped = useMemo(() => {
    const order: SalesExperiment['status'][] = ['active', 'draft', 'paused', 'completed', 'archived'];
    return order.map((st) => ({ status: st, items: salesExperiments.filter((e) => e.status === st) })).filter((g) => g.items.length > 0);
  }, [salesExperiments]);

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6">
      <button onClick={() => navigate('/sales/studio')} className="mb-3 inline-flex items-center gap-1 text-sm text-copper hover:underline"><ArrowLeft size={15} /> {isAr ? 'استوديو المبيعات' : 'Sales Studio'}</button>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-copper-50 text-copper"><FlaskConical size={22} /></span>
          <div>
            <h1 className="text-2xl font-bold text-chocolate">{isAr ? 'تجارب المبيعات' : 'Sales Experiments'}</h1>
            <p className="mt-0.5 text-sm text-charcoal/60">{isAr ? 'قارن مساري مبيعات بأرقام حقيقية واعتمد الفائز' : 'A/B two sales processes with real funnel data, then promote the winner'}</p>
          </div>
        </div>
        {isAdmin && (
          <button type="button" onClick={() => { setEditing(null); setBuilderOpen(true); }} className="inline-flex items-center gap-2 rounded-xl bg-copper px-4 py-2.5 text-sm font-bold text-white hover:bg-terracotta">
            <Plus size={16} /> {isAr ? 'تجربة جديدة' : 'Create experiment'}
          </button>
        )}
      </header>

      {salesExperiments.length === 0 ? (
        <div className="card flex flex-col items-center justify-center gap-3 rounded-2xl p-12 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-copper/10 text-copper"><FlaskConical size={28} /></span>
          <h2 className="text-lg font-bold text-chocolate">{isAr ? 'لا توجد تجارب بعد' : 'No experiments yet'}</h2>
          <p className="max-w-md text-sm text-charcoal/55">{isAr ? 'أنشئ تجربة لمقارنة إصدارين من مسارات المبيعات.' : 'Create an experiment to compare two sales-process versions.'}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((g) => (
            <div key={g.status}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-charcoal/55">
                <span className="badge" style={{ backgroundColor: `${statusColor(g.status)}1A`, color: statusColor(g.status) }}>{pick(EXPERIMENT_STATUS_LABELS[g.status], isAr)}</span>
                <span dir="ltr">{g.items.length}</span>
              </h2>
              <div className="grid gap-4 md:grid-cols-2">
                {g.items.map((exp) => <ExperimentCard key={exp.id} exp={exp} isAdmin={isAdmin} onEdit={(e) => { setEditing(e); setBuilderOpen(true); }} />)}
              </div>
            </div>
          ))}
        </div>
      )}

      <ExperimentBuilderModal open={builderOpen} onClose={() => setBuilderOpen(false)} existing={editing} />
    </div>
  );
}

function ExperimentCard({ exp, isAdmin, onEdit }: { exp: SalesExperiment; isAdmin: boolean; onEdit: (e: SalesExperiment) => void }) {
  const { language, salesProcesses, salesProcessVersions, clientSalesProcessAssignments, saveSalesExperiment, addToast } = useAppStore();
  const isAr = language === 'ar';
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);

  const primaryKey = exp.primary_metric ? primaryToFunnelKey(exp.primary_metric) : null;
  const guardrailKeys = useMemo(() => (exp.guardrail_metrics_json ?? []) as never[], [exp.guardrail_metrics_json]);
  const analytics = useExperimentAnalytics(exp, primaryKey, guardrailKeys);

  const assignedCount = useMemo(
    () => clientSalesProcessAssignments.filter((a) => a.is_active && a.sales_experiment_id === exp.id).length,
    [clientSalesProcessAssignments, exp.id],
  );

  const versionName = (id: string | null | undefined) => {
    const v = salesProcessVersions.find((x) => x.id === id);
    if (!v) return '—';
    const p = salesProcesses.find((x) => x.id === v.sales_process_id);
    return `${p ? (isAr ? p.name_ar : p.name_en) : '—'} v${v.version_number}`;
  };

  const setStatus = (status: SalesExperiment['status']) => {
    setMenu(false);
    if (status === 'active' && (!exp.control_process_version_id || !exp.variant_process_version_id)) {
      addToast(isAr ? 'التجربة النشطة تحتاج مسارًا ضابطًا ومتغيّرًا' : 'An active experiment needs control + variant versions', 'error');
      return;
    }
    saveSalesExperiment({ ...exp, status, updated_at: new Date().toISOString() });
    addToast(isAr ? 'تم التحديث' : 'Updated', 'success');
  };
  const duplicate = () => { setMenu(false); onEdit({ ...exp, id: '', name_ar: `${exp.name_ar} (نسخة)`, name_en: `${exp.name_en} (copy)`, status: 'draft' } as SalesExperiment); };

  const rec = analytics ? RECOMMENDATION_LABEL[analytics.comparison.recommendation] : null;

  return (
    <div className="card relative flex flex-col gap-3 rounded-2xl p-5">
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={() => navigate(`/sales/studio/experiments/${exp.id}`)} className="min-w-0 flex-1 text-start">
          <h3 className="truncate text-base font-bold text-chocolate">{isAr ? exp.name_ar : exp.name_en}</h3>
          {(exp.hypothesis_ar || exp.hypothesis_en) && <p className="mt-0.5 line-clamp-2 text-xs text-charcoal/55">{isAr ? exp.hypothesis_ar : exp.hypothesis_en}</p>}
        </button>
        {isAdmin && (
          <div className="relative shrink-0">
            <button type="button" onClick={() => setMenu((o) => !o)} className="rounded-lg p-1.5 text-charcoal/50 hover:bg-cream"><MoreVertical size={16} /></button>
            {menu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                <div className="absolute end-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-sand/40 bg-white py-1 shadow-lg">
                  {exp.status !== 'active' && <MI icon={<Play size={14} />} label={isAr ? 'تشغيل' : 'Resume / Activate'} onClick={() => setStatus('active')} />}
                  {exp.status === 'active' && <MI icon={<Pause size={14} />} label={isAr ? 'إيقاف مؤقت' : 'Pause'} onClick={() => setStatus('paused')} />}
                  {exp.status !== 'completed' && <MI icon={<CheckCircle2 size={14} />} label={isAr ? 'إكمال' : 'Complete'} onClick={() => setStatus('completed')} />}
                  <MI icon={<Copy size={14} />} label={isAr ? 'نسخ' : 'Duplicate'} onClick={duplicate} />
                  {exp.status !== 'archived' && <MI icon={<Archive size={14} />} label={isAr ? 'أرشفة' : 'Archive'} onClick={() => setStatus('archived')} danger />}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-cream/70 px-2.5 py-1.5">
          <div className="text-[10px] text-charcoal/50">{isAr ? 'ضابط' : 'Control'}</div>
          <div className="truncate font-semibold text-charcoal">{versionName(exp.control_process_version_id)}</div>
        </div>
        <div className="rounded-lg bg-cream/70 px-2.5 py-1.5">
          <div className="text-[10px] text-charcoal/50">{isAr ? 'متغيّر' : 'Variant'}</div>
          <div className="truncate font-semibold text-charcoal">{versionName(exp.variant_process_version_id)}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-charcoal/65">
        <span className="inline-flex items-center gap-1"><Users size={13} className="text-copper" /><b dir="ltr">{assignedCount}</b> {isAr ? 'عميل' : 'clients'}</span>
        {exp.primary_metric && <span>{isAr ? 'المقياس: ' : 'Metric: '}{pick(PRIMARY_METRIC_LABELS[exp.primary_metric], isAr)}</span>}
      </div>

      {/* current result */}
      {analytics && primaryKey && (
        <div className="flex items-center justify-between rounded-lg border border-sand/40 px-3 py-2 text-xs">
          <span className="text-charcoal/60">{isAr ? 'ضابط' : 'C'} <b dir="ltr">{formatMetric(analytics.control[primaryKey], isAr)}</b> · {isAr ? 'متغيّر' : 'V'} <b dir="ltr">{formatMetric(analytics.variant[primaryKey], isAr)}</b></span>
          {rec && <span className="font-semibold" style={{ color: analytics.comparison.recommendation === 'promote_variant' ? '#10B981' : analytics.comparison.recommendation === 'reject_variant' ? '#8E4E3A' : '#C09B5F' }}>{pick(rec, isAr)}</span>}
        </div>
      )}
      {analytics && analytics.comparison.guardrail_warnings.length > 0 && (
        <p className="inline-flex items-center gap-1 text-[11px] text-terracotta"><AlertTriangle size={12} /> {analytics.comparison.guardrail_warnings.length} {isAr ? 'تحذير حارس' : 'guardrail alert(s)'}</p>
      )}
    </div>
  );
}

function MI({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" onClick={onClick} className={`flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-cream ${danger ? 'text-red-600' : 'text-charcoal'}`}>{icon} {label}</button>;
}
