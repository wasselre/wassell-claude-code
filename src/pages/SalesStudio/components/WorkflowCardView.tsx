import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Pencil, ExternalLink, ScrollText, GitCompare, Clock, MessageCircle, UserCog, RefreshCw,
  AlertTriangle, CheckCircle2, PhoneCall, UserCheck, Bell, ArrowRight, Sparkles,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { WorkflowCard, CompatibilityStatus, JourneyBranchCard, BranchActionLine } from '@/lib/salesStudio';
import { COMPATIBILITY_LABEL } from '@/lib/salesStudio';
import type { SalesAssignmentStrategy } from '@/types';
import { ASSIGNMENT_STRATEGY_LABELS, pick } from '../lib/labels';

const COMPAT_COLOR: Record<CompatibilityStatus, string> = {
  simple: '#10B981', partial: '#C09B5F', advanced: '#6B7280', drift: '#8E4E3A',
};

// Assignment strategies the inference can produce beyond the 4 editable ones —
// labeled so the card never shows a raw 'role' / 'trigger_field' slug.
const STRATEGY_EXTRA: Record<string, { ar: string; en: string }> = {
  role: { ar: 'حسب الدور', en: 'By role' },
  trigger_field: { ar: 'من السجل', en: 'From record' },
};

function actionIcon(kind: BranchActionLine['kind']) {
  switch (kind) {
    case 'create_followup': return <PhoneCall size={12} />;
    case 'update_client': return <UserCheck size={12} />;
    case 'send_whatsapp': return <MessageCircle size={12} />;
    case 'notify': return <Bell size={12} />;
    case 'assign': return <UserCog size={12} />;
    default: return <ArrowRight size={12} />;
  }
}

/** A workflow rendered as plain-language OUTCOME → ACTIONS blocks. */
export default function WorkflowCardView({
  card,
  onEditSimple,
  onCompare,
}: {
  card: WorkflowCard;
  onEditSimple: (card: WorkflowCard) => void;
  onCompare?: (card: WorkflowCard) => void;
}) {
  const { language, workflowRuns, users } = useAppStore();
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

  const userName = (id: string | null) => {
    if (!id) return '';
    const u = users.find((x) => x.id === id);
    return u ? ((isAr ? u.name_ar : u.name_en) || u.email || '') : '';
  };
  const strategyLabel = (s: string) => {
    const k = ASSIGNMENT_STRATEGY_LABELS[s as SalesAssignmentStrategy] ?? STRATEGY_EXTRA[s];
    return k ? pick(k, isAr) : (isAr ? 'إسناد آخر' : 'Other');
  };

  const missing = !card.workflow_id;
  const compatColor = COMPAT_COLOR[card.compatibility];
  const canSimpleEdit = card.compatibility === 'simple' || card.compatibility === 'partial';
  // The "Otherwise" / unconditional pass-through branches with no real actions
  // add noise; show outcome blocks that actually do something, else keep them.
  const outcomeBlocks = card.branches.filter((b) => b.action_lines.length > 0 || !b.is_else);

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
          {/* objective */}
          {(card.objective_ar || card.objective_en) && (
            <div className="mt-2 rounded-lg bg-cream/70 px-2.5 py-1.5 text-xs">
              <span className="font-semibold text-charcoal/60">{isAr ? 'الهدف: ' : 'Goal: '}</span>
              <span className="text-charcoal/80">{isAr ? card.objective_ar : card.objective_en}</span>
            </div>
          )}

          {/* OUTCOME → ACTIONS blocks */}
          <div className="mt-2.5 space-y-2">
            {outcomeBlocks.map((b) => (
              <OutcomeBlock key={b.branch_id} b={b} isAr={isAr} strategyLabel={strategyLabel} userName={userName} />
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
        {!missing && (
          <button type="button" onClick={() => navigate(`/workflow/${card.workflow_id}`)} className="inline-flex items-center gap-1 rounded-lg border border-sand px-2.5 py-1 text-[11px] font-semibold text-charcoal hover:bg-cream">
            <ExternalLink size={12} /> {(card.compatibility === 'advanced' || card.compatibility === 'drift') ? (isAr ? 'فتح في محرر سير العمل' : 'Open in Workflow Builder') : (isAr ? 'متقدم' : 'Advanced')}
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

/** One outcome rendered as a self-contained automation block. */
function OutcomeBlock({
  b, isAr, strategyLabel, userName,
}: {
  b: JourneyBranchCard;
  isAr: boolean;
  strategyLabel: (s: string) => string;
  userName: (id: string | null) => string;
}) {
  return (
    <div className={`rounded-lg border p-2.5 ${b.enabled ? 'border-sand/50 bg-cream/30' : 'border-sand/40 bg-cream/20 opacity-50'}`}>
      {/* outcome header */}
      <div className="flex items-center gap-1.5">
        <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${b.enabled ? 'bg-copper' : 'bg-charcoal/30'}`} />
        <span className={`flex-1 truncate text-xs font-bold text-chocolate ${b.enabled ? '' : 'line-through'}`}>{pick(b.summary, isAr)}</span>
        {b.primary_success && <span title={isAr ? 'النتيجة الرئيسية' : 'Primary success'}><CheckCircle2 size={12} className="shrink-0 text-[#10B981]" /></span>}
        {!b.enabled && <span className="badge shrink-0" style={{ backgroundColor: '#6B72801A', color: '#6B7280' }}>{isAr ? 'معطّل' : 'off'}</span>}
      </div>
      {b.condition_summary && (
        <p className="mt-0.5 ps-3 text-[10px] text-charcoal/45">{pick(b.condition_summary, isAr)}</p>
      )}

      {/* the actions this outcome runs */}
      {b.action_lines.length === 0 ? (
        <p className="mt-1 ps-3 text-[11px] text-charcoal/40">{isAr ? 'لا إجراء — إنهاء' : 'No action — ends here'}</p>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {b.action_lines.map((line) => {
            const timing = b.timings.find((t) => t.action_id === line.action_id);
            const assign = b.assignments.find((a) => a.action_id === line.action_id);
            const maxA = b.max_attempts.find((m) => m.action_id === line.action_id);
            const hasMsg = b.messages.some((m) => m.action_id === line.action_id);
            return (
              <li key={line.action_id} className="ps-3 text-[11px]">
                <div className="flex items-center gap-1.5 font-semibold text-charcoal/80">
                  <span className="text-copper">{actionIcon(line.kind)}</span>
                  <span className="truncate">{pick(line.label, isAr)}{line.sets ? ` → ${pick(line.sets, isAr)}` : ''}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-1 ps-4">
                  {timing && (
                    <Chip color="#B8734F" icon={<Clock size={10} />}>
                      {isAr ? 'الموعد: ' : 'Schedule: '}{timing.current_value?.trim() || (isAr ? 'فوري' : 'immediate')}
                    </Chip>
                  )}
                  {assign && (
                    <Chip color="#4A4E54" icon={<UserCog size={10} />}>
                      {isAr ? 'الإسناد: ' : 'Assign: '}{assign.current_strategy === 'fixed_user' && userName(assign.current_fixed_user_id) ? userName(assign.current_fixed_user_id) : strategyLabel(assign.current_strategy)}
                    </Chip>
                  )}
                  {maxA && maxA.current_value != null && (
                    <Chip color="#8E4E3A" icon={<RefreshCw size={10} />}>
                      {isAr ? 'حد المحاولات: ' : 'Max: '}{maxA.current_value}
                    </Chip>
                  )}
                  {hasMsg && (
                    <Chip color="#128C7E" icon={<MessageCircle size={10} />}>{isAr ? 'رسالة واتساب' : 'WhatsApp'}</Chip>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* next workflow / next task */}
      {b.next_action && (
        <p className="mt-1.5 inline-flex items-center gap-1 ps-3 text-[10px] text-charcoal/45">
          <Sparkles size={10} className="text-copper" /> {isAr ? 'التالي: ' : 'Next: '}{pick(b.next_action, isAr)}
        </p>
      )}
    </div>
  );
}

function Chip({ color, icon, children }: { color: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5" style={{ backgroundColor: `${color}14`, color }}>
      {icon}<span dir="auto">{children}</span>
    </span>
  );
}
