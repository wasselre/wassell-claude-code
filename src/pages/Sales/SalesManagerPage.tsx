import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { BarChart3, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { getStageConfig, getOutcome } from '@/lib/salesProcess';
import type { AppRecord } from '@/types';
import { computeManagerMetrics, type Distribution } from './lib/salesMetrics';

/** Admin manager view — the sales-operation health metrics (Part 13, "views
 *  first"). Read-only, computed in-memory from the store. Headline: active
 *  clients with no next action should be zero. */
export default function SalesManagerPage() {
  const { models, records, language, users } = useAppStore();
  const isAr = language === 'ar';
  const navigate = useNavigate();
  const now = Date.now();

  const clientsModel = models.find((m) => m.name === 'clients');
  const followupsModel = models.find((m) => m.name === 'followups');

  const m = useMemo(() => {
    const clients: AppRecord[] = clientsModel ? records[clientsModel.id] ?? [] : [];
    const followups: AppRecord[] = followupsModel ? records[followupsModel.id] ?? [] : [];
    return computeManagerMetrics(clients, followups, now);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientsModel, followupsModel, records]);

  const repName = (id: string) => {
    const u = users.find((x) => x.id === id);
    return u ? ((isAr ? u.name_ar : u.name_en) || u.email || id.slice(0, 6)) : (isAr ? 'بدون مسؤول' : 'Unassigned');
  };
  const stageLabel = (v: string) => { const s = getStageConfig(v); return s ? (isAr ? s.label_ar : s.label_en) : v; };
  const stageOrder = (v: string) => getStageConfig(v)?.order ?? 99;
  const outcomeLabel = (v: string) => { const o = getOutcome(v); return o ? (isAr ? o.label_ar : o.label_en) : v; };

  const funnel = [...m.byStage].sort((a, b) => stageOrder(a.key) - stageOrder(b.key));
  const noData = isAr ? 'لا توجد بيانات كافية' : 'Not enough data';
  const pct = (x: number | null) => (x == null ? noData : `${Math.round(x * 100)}%`);

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6">
      <header className="mb-6 flex items-start gap-3">
        <span className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-copper-50 text-copper">
          <BarChart3 size={22} />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-chocolate">{isAr ? 'لوحة مدير المبيعات' : 'Sales Manager'}</h1>
          <p className="mt-0.5 text-sm text-charcoal/60">
            {isAr ? 'صحة عملية المبيعات في لمحة' : 'Sales operation health at a glance'}
          </p>
        </div>
      </header>

      {/* headline stats */}
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <button type="button" onClick={() => navigate('/sales/tasks?view=no_next_action')} className="block text-start">
          <Stat
            label={isAr ? 'بدون إجراء تالٍ' : 'No Next Action'}
            value={m.noNextAction}
            tone={m.noNextAction === 0 ? 'good' : 'bad'}
            icon={m.noNextAction === 0 ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
            hint={isAr ? 'يجب أن يكون صفرًا' : 'should be zero'}
          />
        </button>
        <Stat label={isAr ? 'متابعات متأخرة' : 'Overdue'} value={m.overdue} tone={m.overdue > 0 ? 'warn' : 'neutral'} icon={<Clock size={18} />} />
        <Stat label={isAr ? 'متابعات مفتوحة' : 'Open Follow-ups'} value={m.openFollowups} tone="neutral" />
        <Stat label={isAr ? 'أُكملت (30 يومًا)' : 'Completed (30d)'} value={m.completed30d} tone="neutral" hint={isAr ? `${m.completedLate} متأخرة` : `${m.completedLate} late`} />
      </div>

      {/* derived rates */}
      <div className="mb-4 flex flex-wrap items-center gap-x-8 gap-y-2 rounded-2xl bg-cream px-5 py-3.5 text-sm text-charcoal">
        <span>
          {isAr ? 'إجمالي العملاء: ' : 'Total clients: '}
          <b className="text-base font-bold text-chocolate" dir="ltr">{m.totalClients}</b>
        </span>
        <span>
          {isAr ? 'نسبة عدم الرد (مكالمات الحجز): ' : 'No-answer rate (booking): '}
          <b className="text-base font-bold text-terracotta" dir="ltr">{pct(m.rates.noAnswerRate)}</b>
        </span>
        <span>
          {isAr ? 'نسبة الإكمال في الوقت: ' : 'On-time completion: '}
          <b className="text-base font-bold text-[#10B981]" dir="ltr">{pct(m.rates.onTimeRate)}</b>
        </span>
      </div>

      <p className="mb-6 text-xs leading-relaxed text-terracotta">
        {isAr
          ? 'تعتمد مقاييس «المكتملة / في الوقت» على حالة المتابعة (followup_status). وقد تم تحديث المتابعات التاريخية المكتملة لتُحتسب هنا.'
          : 'Completed / on-time metrics are based on followup_status; historical completed follow-ups were backfilled so they count here.'}
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <BarList title={isAr ? 'مسار العملاء حسب المرحلة' : 'Pipeline by Stage'} items={funnel} label={stageLabel} />
        <BarList title={isAr ? 'نتائج المتابعات المكتملة' : 'Completed Outcomes'} items={m.outcomes} label={outcomeLabel} />
        <BarList title={isAr ? 'أسباب الخسارة' : 'Lost Reasons'} items={m.lostReasons} label={(k) => k} empty={isAr ? 'لا توجد خسائر مسجلة' : 'No losses recorded'} tone="terracotta" />
        <section className="card rounded-2xl p-5">
          <h2 className="mb-4 text-base font-bold text-chocolate">{isAr ? 'الأداء حسب المندوب' : 'Per Rep'}</h2>
          {m.perRep.length === 0 ? (
            <p className="text-sm text-terracotta">{isAr ? 'لا توجد بيانات' : 'No data'}</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="text-start text-xs uppercase tracking-wide text-charcoal/50"><th className="pb-2 text-start font-medium">{isAr ? 'المندوب' : 'Rep'}</th><th className="pb-2 text-end font-medium">{isAr ? 'مفتوحة' : 'Open'}</th><th className="pb-2 text-end font-medium">{isAr ? 'مكتملة' : 'Completed'}</th></tr></thead>
              <tbody>
                {m.perRep.slice(0, 12).map((r) => (
                  <tr key={r.repId} className="border-t border-sand/40">
                    <td className="py-2 font-medium text-charcoal">{repName(r.repId)}</td>
                    <td className="py-2 text-end font-bold text-terracotta" dir="ltr">{r.open}</td>
                    <td className="py-2 text-end font-bold text-[#10B981]" dir="ltr">{r.completed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, tone, icon, hint }: { label: string; value: number; tone: 'good' | 'bad' | 'warn' | 'neutral'; icon?: ReactNode; hint?: string }) {
  const color = tone === 'good' ? '#10B981' : tone === 'bad' ? '#8E4E3A' : tone === 'warn' ? '#C09B5F' : '#4A4E54';
  return (
    <div className="h-full rounded-2xl border border-sand/30 bg-white px-5 pb-5 pt-4 shadow-sm" style={{ borderTop: `3px solid ${color}` }}>
      <div className="flex items-center justify-between text-charcoal/60">
        <span className="text-xs font-medium">{label}</span>
        <span style={{ color }}>{icon}</span>
      </div>
      <div className="mt-3 text-4xl font-bold leading-none" style={{ color }} dir="ltr">{value}</div>
      {hint && <div className="mt-2 text-xs text-charcoal/50">{hint}</div>}
    </div>
  );
}

function BarList({ title, items, label, empty, tone = 'copper' }: { title: string; items: Distribution[]; label: (k: string) => string; empty?: string; tone?: 'copper' | 'terracotta' }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  const fill = tone === 'terracotta' ? 'bg-terracotta' : 'bg-copper';
  return (
    <section className="card rounded-2xl p-5">
      <h2 className="mb-4 text-base font-bold text-chocolate">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-terracotta">{empty ?? '—'}</p>
      ) : (
        <ul className="space-y-3">
          {items.filter((i) => i.key).map((i) => (
            <li key={i.key} className="text-sm">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="truncate font-medium text-charcoal" title={label(i.key)}>{label(i.key)}</span>
                <span className="shrink-0 font-bold text-chocolate" dir="ltr">{i.count}</span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-cream">
                <span className={`block h-full rounded-full ${fill}`} style={{ width: `${(i.count / max) * 100}%`, minWidth: 4 }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
