import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import { ArrowRight, ThumbsUp, Clock, AlertTriangle, MessageSquare, BarChart3 } from 'lucide-react';
import { aggregateInsights, intentLabel } from '@/lib/matching/telemetry';

/**
 * Lightweight Sales-Assistant usage insights (admin-only). Aggregates the
 * per-message telemetry + 👍/👎 feedback stored inline on the matching_chats
 * conversations the current admin can see — capability usage, helpful rate,
 * which intents failed, complaints, errors, response time. No new write path.
 */
const TOOL_LABELS: Record<string, { ar: string; en: string }> = {
  match_projects: { ar: 'مطابقة المشاريع', en: 'Project matching' },
  get_project: { ar: 'تفاصيل مشروع', en: 'Project details' },
  compare_projects: { ar: 'مقارنة المشاريع', en: 'Comparison' },
  get_customer_context: { ar: 'سياق العميل', en: 'Customer context' },
  emit_recommendation: { ar: 'بطاقة توصية', en: 'Recommendation card' },
  emit_comparison: { ar: 'بطاقة مقارنة', en: 'Comparison card' },
  emit_next_action: { ar: 'بطاقة الخطوة التالية', en: 'Next-action card' },
  emit_message: { ar: 'مسودة رسالة', en: 'Message draft' },
  propose_task: { ar: 'اقتراح مهمة', en: 'Task proposal' },
};
const CARD_LABELS: Record<string, { ar: string; en: string }> = {
  recommendation: { ar: 'توصية مشروع', en: 'Project recommendation' },
  comparison: { ar: 'مقارنة', en: 'Comparison' },
  next_action: { ar: 'الخطوة التالية', en: 'Next action' },
  message: { ar: 'رسالة', en: 'Message' },
  task_proposal: { ar: 'مهمة', en: 'Task' },
};

export default function AssistantInsightsPage() {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const recordsByModel = useAppStore((s) => s.records);
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const model = useMemo(() => models.find((m) => m.name === 'matching_chats'), [models]);
  const ins = useMemo(() => aggregateInsights(model ? recordsByModel[model.id] ?? [] : []), [model, recordsByModel]);

  const maxTool = Math.max(1, ...ins.tool_usage.map((t) => t.count));
  const upRate = ins.thumbs_up_rate == null ? null : Math.round(ins.thumbs_up_rate * 100);

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={() => navigate('/model/matching_chats')} className="p-1.5 rounded-lg hover:bg-cream text-charcoal/60" title={L('رجوع', 'Back')}>
          <ArrowRight size={18} className={isAr ? '' : 'rotate-180'} />
        </button>
        <BarChart3 size={20} className="text-copper" />
        <h1 className="text-lg font-bold text-charcoal">{L('رؤى مساعد المبيعات', 'Sales Assistant insights')}</h1>
      </div>
      <p className="text-xs text-charcoal/50">
        {L(
          `محسوبة من ${ins.conversations} محادثة ضمن نطاق رؤيتك. الإشارات تتراكم كلما استخدم المندوبون المساعد وقيّموا الإجابات.`,
          `Based on ${ins.conversations} conversations within your visibility. Signal accrues as reps use the assistant and rate answers.`,
        )}
      </p>

      {/* Top stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={<MessageSquare size={15} />} label={L('المحادثات', 'Conversations')} value={String(ins.conversations)} />
        <Stat icon={<MessageSquare size={15} />} label={L('ردود المساعد', 'Assistant answers')} value={String(ins.assistant_turns)} />
        <Stat icon={<ThumbsUp size={15} className="text-green-600" />} label={L('نسبة الإفادة', 'Helpful rate')}
          value={upRate == null ? '—' : `${upRate}%`} sub={`👍 ${ins.thumbs_up} · 👎 ${ins.thumbs_down}`} />
        <Stat icon={<Clock size={15} />} label={L('متوسط الاستجابة', 'Avg response')}
          value={ins.avg_response_ms == null ? '—' : `${(ins.avg_response_ms / 1000).toFixed(1)}s`}
          sub={ins.errored_turns > 0 ? L(`${ins.errored_turns} ردود فيها خطأ`, `${ins.errored_turns} errored`) : undefined} />
      </div>

      {/* Capability usage */}
      <Panel title={L('استخدام القدرات', 'Capability usage')}>
        {ins.tool_usage.length === 0 ? (
          <Empty isAr={isAr} />
        ) : (
          <div className="space-y-1.5">
            {ins.tool_usage.map((t) => {
              const lbl = TOOL_LABELS[t.name];
              return (
                <div key={t.name} className="flex items-center gap-2 text-xs">
                  <div className="w-40 shrink-0 text-charcoal/70 truncate">{lbl ? (isAr ? lbl.ar : lbl.en) : t.name}</div>
                  <div className="flex-1 bg-cream rounded-full h-2.5 overflow-hidden">
                    <div className="h-full bg-copper rounded-full" style={{ width: `${(t.count / maxTool) * 100}%` }} />
                  </div>
                  <div className="w-8 text-end text-charcoal/60">{t.count}</div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      {/* Failed intents + complaints */}
      <div className="grid md:grid-cols-2 gap-4">
        <Panel title={L('طلبات لم تنجح (من 👎)', "Requests that didn't land (from 👎)")}>
          {ins.failed_intents.length === 0 ? (
            <Empty isAr={isAr} text={L('لا يوجد تقييم سلبي بعد', 'No negative feedback yet')} />
          ) : (
            <ul className="space-y-1">
              {ins.failed_intents.map((f) => (
                <li key={f.intent} className="flex items-center justify-between text-sm">
                  <span className="text-charcoal/80">{intentLabel(f.intent, isAr)}</span>
                  <span className="px-2 py-0.5 rounded-full bg-red-50 text-red-700 text-xs font-bold">{f.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={L('بطاقات معروضة', 'Cards delivered')}>
          {ins.card_usage.length === 0 ? (
            <Empty isAr={isAr} />
          ) : (
            <ul className="space-y-1">
              {ins.card_usage.map((c) => {
                const lbl = CARD_LABELS[c.kind];
                return (
                  <li key={c.kind} className="flex items-center justify-between text-sm">
                    <span className="text-charcoal/80">{lbl ? (isAr ? lbl.ar : lbl.en) : c.kind}</span>
                    <span className="text-charcoal/50 text-xs">{c.count}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      {/* Complaints */}
      <Panel title={L('ملاحظات المندوبين', 'Rep comments')}>
        {ins.complaints.length === 0 ? (
          <Empty isAr={isAr} text={L('لا توجد ملاحظات مكتوبة بعد', 'No written comments yet')} />
        ) : (
          <ul className="space-y-1.5">
            {ins.complaints.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-charcoal/80">
                <AlertTriangle size={13} className="text-amber-600 shrink-0 mt-0.5" />
                <span>
                  {c.comment}
                  {c.intent && <span className="text-charcoal/40 text-xs"> — {intentLabel(c.intent, isAr)}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-sand/30 bg-white p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-charcoal/50 uppercase tracking-wider">{icon}{label}</div>
      <div className="text-2xl font-bold text-charcoal mt-1">{value}</div>
      {sub && <div className="text-[11px] text-charcoal/50 mt-0.5">{sub}</div>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-sand/30 bg-white p-4">
      <div className="text-sm font-bold text-charcoal mb-2.5">{title}</div>
      {children}
    </div>
  );
}

function Empty({ isAr, text }: { isAr: boolean; text?: string }) {
  return <div className="text-xs text-charcoal/40 italic">{text ?? (isAr ? 'لا توجد بيانات بعد' : 'No data yet')}</div>;
}
