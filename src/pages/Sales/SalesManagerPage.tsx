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
  const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);

  return (
    <div className="mx-auto max-w-6xl p-4">
      <header className="mb-4 flex items-center gap-2">
        <BarChart3 className="text-[#B8734F]" />
        <h1 className="text-xl font-bold text-[#4A2C2A]">{isAr ? 'لوحة مدير المبيعات' : 'Sales Manager'}</h1>
      </header>

      {/* headline stats */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <button type="button" onClick={() => navigate('/sales/tasks')} className="text-start">
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
      <div className="mb-4 flex flex-wrap gap-4 rounded-lg bg-[#F5EDE0] p-3 text-sm text-[#4A4E54]">
        <span><b>{isAr ? 'إجمالي العملاء: ' : 'Total clients: '}</b>{m.totalClients}</span>
        <span><b>{isAr ? 'نسبة عدم الرد (مكالمات الحجز): ' : 'No-answer rate (booking): '}</b>{pct(m.rates.noAnswerRate)}</span>
        <span><b>{isAr ? 'نسبة الإكمال في الوقت: ' : 'On-time completion: '}</b>{pct(m.rates.onTimeRate)}</span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <BarList title={isAr ? 'مسار العملاء حسب المرحلة' : 'Pipeline by Stage'} items={funnel} label={stageLabel} />
        <BarList title={isAr ? 'نتائج المتابعات المكتملة' : 'Completed Outcomes'} items={m.outcomes} label={outcomeLabel} />
        <BarList title={isAr ? 'أسباب الخسارة' : 'Lost Reasons'} items={m.lostReasons} label={(k) => k} empty={isAr ? 'لا توجد خسائر مسجلة' : 'No losses recorded'} />
        <section className="card">
          <h2 className="mb-2 text-sm font-bold text-[#4A2C2A]">{isAr ? 'الأداء حسب المندوب' : 'Per Rep'}</h2>
          {m.perRep.length === 0 ? (
            <p className="text-sm text-[#8E4E3A]">{isAr ? 'لا توجد بيانات' : 'No data'}</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="text-start text-xs text-[#8E4E3A]"><th className="text-start font-normal">{isAr ? 'المندوب' : 'Rep'}</th><th className="text-end font-normal">{isAr ? 'مفتوحة' : 'Open'}</th><th className="text-end font-normal">{isAr ? 'مكتملة' : 'Completed'}</th></tr></thead>
              <tbody>
                {m.perRep.slice(0, 12).map((r) => (
                  <tr key={r.repId} className="border-t border-[#D4B896]/50">
                    <td className="py-1 text-[#4A4E54]">{repName(r.repId)}</td>
                    <td className="py-1 text-end text-[#8E4E3A]">{r.open}</td>
                    <td className="py-1 text-end text-[#10B981]">{r.completed}</td>
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
    <div className="rounded-xl border border-[#D4B896] bg-white p-3" style={{ borderTop: `3px solid ${color}` }}>
      <div className="flex items-center justify-between text-[#8E4E3A]">
        <span className="text-xs">{label}</span>
        <span style={{ color }}>{icon}</span>
      </div>
      <div className="mt-1 text-2xl font-bold" style={{ color }}>{value}</div>
      {hint && <div className="text-xs text-[#8E4E3A]">{hint}</div>}
    </div>
  );
}

function BarList({ title, items, label, empty }: { title: string; items: Distribution[]; label: (k: string) => string; empty?: string }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <section className="card">
      <h2 className="mb-2 text-sm font-bold text-[#4A2C2A]">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-[#8E4E3A]">{empty ?? '—'}</p>
      ) : (
        <ul className="space-y-1">
          {items.filter((i) => i.key).map((i) => (
            <li key={i.key} className="flex items-center gap-2 text-sm">
              <span className="w-40 shrink-0 truncate text-[#4A4E54]" title={label(i.key)}>{label(i.key)}</span>
              <span className="h-2 rounded-full bg-[#B8734F]" style={{ width: `${(i.count / max) * 100}%`, minWidth: 4 }} />
              <span className="ms-auto text-[#8E4E3A]">{i.count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
