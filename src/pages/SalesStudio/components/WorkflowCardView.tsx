import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pencil, ExternalLink, ScrollText, GitCompare, Clock, MessageCircle, UserCog, AlertTriangle, CheckCircle2, ChevronRight } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { WorkflowCard, CompatibilityStatus } from '@/lib/salesStudio';
import { COMPATIBILITY_LABEL } from '@/lib/salesStudio';
import { pick } from '../lib/labels';

const COMPAT_COLOR: Record<CompatibilityStatus, string> = {
  simple: '#10B981', partial: '#C09B5F', advanced: '#6B7280', drift: '#8E4E3A',
};

/** A workflow rendered as a plain-language business card under a journey stage. */
export default function WorkflowCardView({
  card,
  onEditSimple,
  onCompare,
}: {
  card: WorkflowCard;
  onEditSimple: (card: WorkflowCard) => void;
  onCompare?: (card: WorkflowCard) => void;
}) {
  const { language, workflowRuns } = useAppStore();
  const isAr = language === 'ar';
  const navigate = useNavigate();

  const metrics = useMemo(() => {
    if (!card.workflow_id) return { runs: 0, success: 0, skipped: 0, failed: 0 };
    let runs = 0, success = 0, skipped = 0, failed = 0;
    for (const r of workflowRuns) {
      if (r.workflow_id !== card.workflow_id) continue;
      runs++;
      if (r.status === 'success' || r.status === 'partial_success') success++;
      else if (r.status === 'skipped') skipped++;
      else if (r.status === 'failed' || r.status === 'depth_exceeded') failed++;
    }
    return { runs, success, skipped, failed };
  }, [workflowRuns, card.workflow_id]);

  const missing = !card.workflow_id;
  const compatColor = COMPAT_COLOR[card.compatibility];
  const canSimpleEdit = card.compatibility === 'simple' || card.compatibility === 'partial';

  return (
    <div className="rounded-xl border border-sand/40 bg-white p-3.5 shadow-sm">
      {/* header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="truncate text-sm font-bold text-chocolate">{isAr ? card.label_ar : card.label_en}</h4>
            {!missing && (
              <span className={`h-2 w-2 shrink-0 rounded-full ${card.is_active ? 'bg-[#10B981]' : 'bg-charcoal/30'}`} title={card.is_active ? (isAr ? 'نشط' : 'Active') : (isAr ? 'غير نشط' : 'Inactive')} />
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-charcoal/55">{pick(card.trigger_summary, isAr)}</p>
        </div>
        <span className="badge shrink-0" style={{ backgroundColor: `${compatColor}1A`, color: compatColor }}>
          {pick(COMPATIBILITY_LABEL[card.compatibility], isAr)}
        </span>
      </div>

      {missing ? (
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-terracotta/10 px-2 py-1.5 text-xs text-terracotta">
          <AlertTriangle size={13} /> {isAr ? 'لا يوجد سير عمل ينفّذ هذا النشاط' : 'No workflow executes this activity'}
        </p>
      ) : (
        <>
          {/* plain-language explanation */}
          <p className="mt-2 text-xs leading-relaxed text-charcoal/70">{pick(card.explanation, isAr)}</p>

          {/* objective */}
          {(card.objective_ar || card.objective_en) && (
            <div className="mt-2 rounded-lg bg-cream/70 px-2.5 py-1.5 text-xs">
              <span className="font-semibold text-charcoal/60">{isAr ? 'الهدف: ' : 'Goal: '}</span>
              <span className="text-charcoal/80">{isAr ? card.objective_ar : card.objective_en}</span>
            </div>
          )}

          {/* branch / outcome summary */}
          {card.branches.length > 0 && (
            <div className="mt-2 space-y-1">
              {card.branches.slice(0, 5).map((b) => (
                <div key={b.branch_id} className={`flex items-center gap-1.5 text-xs ${b.enabled ? '' : 'opacity-40 line-through'}`}>
                  <ChevronRight size={11} className="shrink-0 text-copper" />
                  <span className="truncate text-charcoal/75">{pick(b.summary, isAr)}</span>
                  {b.primary_success && <span title={isAr ? 'النتيجة الرئيسية' : 'Primary success'}><CheckCircle2 size={12} className="shrink-0 text-[#10B981]" /></span>}
                  {b.next_action && <span className="truncate text-charcoal/45">→ {pick(b.next_action, isAr)}</span>}
                </div>
              ))}
            </div>
          )}

          {/* current safe-edit surfaces */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {card.timings.map((t) => (
              <span key={t.action_id} className="inline-flex items-center gap-1 rounded-md bg-copper/10 px-2 py-0.5 text-[11px] text-copper" dir="ltr">
                <Clock size={11} /> {t.current_value || '—'}
              </span>
            ))}
            {card.messages.length > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md bg-[#25D366]/10 px-2 py-0.5 text-[11px] text-[#128C7E]">
                <MessageCircle size={11} /> {card.messages.length} {isAr ? 'رسالة' : 'msg'}
              </span>
            )}
            {card.assignments.map((a) => (
              <span key={a.action_id} className="inline-flex items-center gap-1 rounded-md bg-charcoal/5 px-2 py-0.5 text-[11px] text-charcoal/70">
                <UserCog size={11} /> {a.current_strategy}
              </span>
            ))}
          </div>

          {/* metrics */}
          <div className="mt-2.5 flex items-center gap-3 border-t border-sand/40 pt-2 text-[11px] text-charcoal/55">
            <span dir="ltr">{metrics.runs} {isAr ? 'تشغيل' : 'runs'}</span>
            <span className="text-[#10B981]" dir="ltr">✓ {metrics.success}</span>
            <span dir="ltr">⤼ {metrics.skipped}</span>
            {metrics.failed > 0 && <span className="text-terracotta" dir="ltr">✕ {metrics.failed}</span>}
          </div>
        </>
      )}

      {/* actions */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {!missing && canSimpleEdit && (
          <button type="button" onClick={() => onEditSimple(card)} className="inline-flex items-center gap-1 rounded-lg bg-copper px-2.5 py-1 text-[11px] font-bold text-white hover:bg-terracotta">
            <Pencil size={12} /> {isAr ? 'تحرير مبسّط' : 'Edit simple'}
          </button>
        )}
        {!missing && (card.compatibility === 'advanced' || card.compatibility === 'drift') && (
          <button type="button" onClick={() => navigate(`/workflow/${card.workflow_id}`)} className="inline-flex items-center gap-1 rounded-lg border border-sand px-2.5 py-1 text-[11px] font-semibold text-charcoal hover:bg-cream">
            <ExternalLink size={12} /> {isAr ? 'فتح في محرر سير العمل' : 'Open in Workflow Builder'}
          </button>
        )}
        {!missing && card.compatibility !== 'advanced' && card.compatibility !== 'drift' && (
          <button type="button" onClick={() => navigate(`/workflow/${card.workflow_id}`)} className="inline-flex items-center gap-1 rounded-lg border border-sand px-2.5 py-1 text-[11px] font-semibold text-charcoal hover:bg-cream">
            <ExternalLink size={12} /> {isAr ? 'متقدم' : 'Advanced'}
          </button>
        )}
        {!missing && (
          <button type="button" onClick={() => navigate('/workflow/logs')} className="inline-flex items-center gap-1 rounded-lg border border-sand px-2.5 py-1 text-[11px] font-semibold text-charcoal hover:bg-cream">
            <ScrollText size={12} /> {isAr ? 'السجلات' : 'Logs'}
          </button>
        )}
        {!missing && onCompare && (
          <button type="button" onClick={() => onCompare(card)} className="inline-flex items-center gap-1 rounded-lg border border-sand px-2.5 py-1 text-[11px] font-semibold text-charcoal hover:bg-cream">
            <GitCompare size={12} /> {isAr ? 'مقارنة الإصدارات' : 'Compare'}
          </button>
        )}
      </div>
    </div>
  );
}
