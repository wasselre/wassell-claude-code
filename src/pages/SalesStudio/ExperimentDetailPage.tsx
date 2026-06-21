import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, FlaskConical, Trophy, Wand2, AlertTriangle, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin } from '@/hooks/usePermission';
import type { FunnelMetricKey } from '@/lib/salesStudio';
import { RECOMMENDATION_LABEL } from '@/lib/salesStudio';
import { useExperimentAnalytics } from './lib/useStudioData';
import {
  METRIC_LABELS, EXPERIMENT_STATUS_LABELS, PRIMARY_METRIC_LABELS, statusColor,
  formatMetric, unavailableReason, pick, primaryToFunnelKey,
} from './lib/labels';
import PromoteWinnerModal from './components/PromoteWinnerModal';

// The full funnel, in display order.
const ROWS: FunnelMetricKey[] = [
  'lead_count', 'appointment_booking_rate', 'appointment_confirmation_rate', 'visit_rate',
  'offer_request_rate', 'reservation_rate', 'financing_started_rate', 'closed_won_rate',
  'lost_rate', 'unqualified_rate', 'whatsapp_response_rate', 'no_answer_rate',
  'touches_per_client', 'time_to_appointment', 'time_to_offer', 'time_to_close',
  'no_next_action_count', 'rep_workload',
];

export default function ExperimentDetailPage() {
  const { experimentId } = useParams<{ experimentId: string }>();
  const navigate = useNavigate();
  const isAdmin = useIsAdmin();
  const { language, salesExperiments, salesProcesses, salesProcessVersions, applyExperimentAssignments, addToast } = useAppStore();
  const isAr = language === 'ar';
  const [promoteOpen, setPromoteOpen] = useState(false);

  const exp = salesExperiments.find((e) => e.id === experimentId);
  const primaryKey = exp?.primary_metric ? primaryToFunnelKey(exp.primary_metric) : null;
  const guardrailKeys = useMemo(() => (exp?.guardrail_metrics_json ?? []) as FunnelMetricKey[], [exp?.guardrail_metrics_json]);
  const analytics = useExperimentAnalytics(exp, primaryKey, guardrailKeys);

  if (!exp) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <button onClick={() => navigate('/sales/studio/experiments')} className="mb-4 inline-flex items-center gap-1 text-sm text-copper"><ArrowLeft size={15} /> {isAr ? 'التجارب' : 'Experiments'}</button>
        <p className="rounded-xl bg-terracotta/10 p-4 text-sm text-terracotta">{isAr ? 'التجربة غير موجودة.' : 'Experiment not found.'}</p>
      </div>
    );
  }

  const versionName = (id: string | null | undefined) => {
    const v = salesProcessVersions.find((x) => x.id === id);
    if (!v) return '—';
    const p = salesProcesses.find((x) => x.id === v.sales_process_id);
    return `${p ? (isAr ? p.name_ar : p.name_en) : '—'} · v${v.version_number}`;
  };

  const comparison = analytics?.comparison;
  const apply = () => {
    const n = applyExperimentAssignments(exp.id);
    addToast(isAr ? `تم إسناد ${n} عميلًا` : `Assigned ${n} clients`, n > 0 ? 'success' : 'info');
  };

  return (
    <div className="mx-auto max-w-5xl p-4 md:p-6">
      <button onClick={() => navigate('/sales/studio/experiments')} className="mb-3 inline-flex items-center gap-1 text-sm text-copper hover:underline"><ArrowLeft size={15} /> {isAr ? 'كل التجارب' : 'All experiments'}</button>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-copper-50 text-copper"><FlaskConical size={22} /></span>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-chocolate">{isAr ? exp.name_ar : exp.name_en}</h1>
              <span className="badge" style={{ backgroundColor: `${statusColor(exp.status)}1A`, color: statusColor(exp.status) }}>{pick(EXPERIMENT_STATUS_LABELS[exp.status], isAr)}</span>
            </div>
            {(exp.hypothesis_ar || exp.hypothesis_en) && <p className="mt-0.5 max-w-2xl text-sm text-charcoal/60">{isAr ? exp.hypothesis_ar : exp.hypothesis_en}</p>}
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-charcoal/55">
              <span>{isAr ? 'ضابط: ' : 'Control: '}<b>{versionName(exp.control_process_version_id)}</b></span>
              <span>{isAr ? 'متغيّر: ' : 'Variant: '}<b>{versionName(exp.variant_process_version_id)}</b></span>
              <span>{isAr ? 'الإسناد: ' : 'Assignment: '}{exp.assignment_mode}{exp.assignment_mode === 'random_split' ? ` (${exp.split_percentage}%)` : ''}</span>
            </div>
          </div>
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            {exp.assignment_mode !== 'manual' && (
              <button type="button" onClick={apply} className="inline-flex items-center gap-1.5 rounded-xl border border-sand bg-white px-3 py-2 text-sm font-semibold text-charcoal hover:bg-cream">
                <Wand2 size={15} className="text-copper" /> {isAr ? 'تطبيق الإسناد' : 'Apply assignments'}
              </button>
            )}
            <button type="button" onClick={() => setPromoteOpen(true)} className="inline-flex items-center gap-1.5 rounded-xl bg-copper px-3 py-2 text-sm font-bold text-white hover:bg-terracotta">
              <Trophy size={15} /> {isAr ? 'اعتماد الفائز' : 'Promote winner'}
            </button>
          </div>
        )}
      </header>

      {/* interpretation */}
      {comparison && (
        <div className="mb-5 grid gap-3 md:grid-cols-3">
          <div className="card rounded-2xl p-4">
            <div className="text-xs text-charcoal/50">{isAr ? 'التوصية' : 'Recommendation'}</div>
            <div className="mt-1 text-lg font-bold" style={{ color: comparison.recommendation === 'promote_variant' ? '#10B981' : comparison.recommendation === 'reject_variant' ? '#8E4E3A' : '#C09B5F' }}>
              {pick(RECOMMENDATION_LABEL[comparison.recommendation], isAr)}
            </div>
            {comparison.low_sample && <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-terracotta"><AlertTriangle size={11} /> {isAr ? 'حجم عينة صغير' : 'Low sample size'}</div>}
          </div>
          <div className="card rounded-2xl p-4">
            <div className="text-xs text-charcoal/50">{isAr ? 'المجموعة الفائزة' : 'Winning group'}</div>
            <div className="mt-1 text-lg font-bold text-chocolate">
              {comparison.winner === 'variant' ? (isAr ? 'المتغيّرة' : 'Variant') : comparison.winner === 'control' ? (isAr ? 'الضابطة' : 'Control') : comparison.winner === 'tie' ? (isAr ? 'تعادل' : 'Tie') : '—'}
            </div>
            {comparison.primary && comparison.primary.delta_rel != null && (
              <div className="mt-1 text-[11px] text-charcoal/55" dir="ltr">{(comparison.primary.delta_rel * 100).toFixed(1)}% {isAr ? 'فرق على المقياس الرئيسي' : 'on primary metric'}</div>
            )}
          </div>
          <div className="card rounded-2xl p-4">
            <div className="text-xs text-charcoal/50">{isAr ? 'تحذيرات الحُرّاس' : 'Guardrail alerts'}</div>
            <div className="mt-1 text-lg font-bold" style={{ color: comparison.guardrail_warnings.length ? '#8E4E3A' : '#10B981' }} dir="ltr">{comparison.guardrail_warnings.length}</div>
            {comparison.guardrail_warnings.slice(0, 2).map((w) => <div key={w.key} className="mt-0.5 text-[11px] text-terracotta">{isAr ? w.message_ar : w.message_en}</div>)}
          </div>
        </div>
      )}

      {/* comparison table */}
      <section className="card overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between border-b border-sand/40 p-4">
          <h2 className="text-base font-bold text-chocolate">{isAr ? 'مقارنة القُمع: ضابط × متغيّر' : 'Funnel comparison: control × variant'}</h2>
          {analytics && <span className="text-xs text-charcoal/50" dir="ltr">{isAr ? 'ض' : 'C'} {analytics.controlCount} · {isAr ? 'م' : 'V'} {analytics.variantCount}</span>}
        </div>
        {!analytics ? (
          <div className="p-8 text-center text-sm text-charcoal/40">{isAr ? 'لا توجد بيانات' : 'No data'}</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-charcoal/50">
                <th className="p-3 text-start font-medium">{isAr ? 'المقياس' : 'Metric'}</th>
                <th className="p-3 text-end font-medium">{isAr ? 'الضابطة' : 'Control'}</th>
                <th className="p-3 text-end font-medium">{isAr ? 'المتغيّرة' : 'Variant'}</th>
                <th className="p-3 text-end font-medium">{isAr ? 'الفرق' : 'Δ'}</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((key) => {
                const c = analytics.control[key];
                const v = analytics.variant[key];
                const isPrimary = key === primaryKey;
                const cv = c.value, vv = v.value;
                const delta = cv != null && vv != null && cv !== 0 ? (vv - cv) / Math.abs(cv) : null;
                return (
                  <tr key={key} className={`border-t border-sand/30 ${isPrimary ? 'bg-copper/5' : ''}`}>
                    <td className="p-3 font-medium text-charcoal">
                      {pick(METRIC_LABELS[key], isAr)}
                      {isPrimary && <span className="ms-1.5 badge" style={{ backgroundColor: '#B8734F1A', color: '#8E4E3A' }}>{isAr ? 'رئيسي' : 'primary'}</span>}
                    </td>
                    <td className="p-3 text-end tabular-nums" dir="ltr" title={unavailableReason(c, isAr)}>{formatMetric(c, isAr)}</td>
                    <td className="p-3 text-end font-semibold tabular-nums" dir="ltr" title={unavailableReason(v, isAr)}>{formatMetric(v, isAr)}</td>
                    <td className="p-3 text-end" dir="ltr">
                      {delta == null ? <Minus size={13} className="ms-auto text-charcoal/30" /> : (
                        <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${delta > 0.001 ? 'text-[#10B981]' : delta < -0.001 ? 'text-terracotta' : 'text-charcoal/40'}`}>
                          {delta > 0.001 ? <ArrowUp size={12} /> : delta < -0.001 ? <ArrowDown size={12} /> : <Minus size={12} />}
                          {Math.abs(delta * 100).toFixed(0)}%
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="border-t border-sand/30 p-3 text-[11px] leading-relaxed text-charcoal/45">
          {isAr
            ? 'تُحسب «الوصول إلى مرحلة» من المرحلة الحالية للعميل أو من وجود سجل مرتبط (موعد/زيارة/عرض/حجز/تمويل/إفراغ). المقاييس التي تتعذّر حسابتها تظهر «—» مع سبب عند المرور عليها. لا يُدّعى يقين إحصائي.'
            : '“Reached a stage” is derived from the client’s current stage or a linked downstream record (appointment/visit/offer/reservation/financing/ownership). Metrics that can’t be computed show “—” with a reason on hover. No statistical certainty is claimed.'}
        </p>
      </section>

      {exp.primary_metric && (
        <p className="mt-3 text-xs text-charcoal/50">{isAr ? 'المقياس الرئيسي: ' : 'Primary metric: '}{pick(PRIMARY_METRIC_LABELS[exp.primary_metric], isAr)}</p>
      )}

      {comparison && <PromoteWinnerModal open={promoteOpen} onClose={() => setPromoteOpen(false)} experiment={exp} comparison={comparison} />}
    </div>
  );
}
