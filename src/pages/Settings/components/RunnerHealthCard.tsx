// Claude Code runner health — the always-on Fly machine ("wassel-claude-runner")
// that executes intelligence Skills on the paid Claude subscription.
//
// The runner deliberately exposes no HTTP surface, so its ONLY liveness signal
// is the database lease heartbeat. This card is therefore the operator's single
// answer to "is intelligence actually running right now, and where".
//
// Nothing sensitive crosses this boundary: the OAuth token, database
// credentials, job payloads and customer evidence never reach the client — only
// identifiers, states, counts and ages.
import { Bot, RefreshCw, AlertTriangle, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { runnerStatus } from '@/lib/marketing/ops';
import { ago } from '@/lib/marketing/ops';
import type { RunnerHealth } from '@/lib/marketing/client';

const STATUS_CLS = {
  healthy: 'bg-green-100 text-green-800 border-green-200',
  degraded: 'bg-amber-100 text-amber-800 border-amber-200',
  down: 'bg-red-100 text-red-800 border-red-200',
} as const;

const SEV_CLS: Record<string, string> = {
  critical: 'bg-red-50 border-red-200 text-red-800',
  warning: 'bg-amber-50 border-amber-200 text-amber-800',
  info: 'bg-blue-50 border-blue-200 text-blue-800',
};

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-charcoal/40 mb-0.5">{label}</div>
      <div className={`text-sm text-charcoal ${mono ? 'font-mono text-xs break-all' : ''}`}>{value}</div>
    </div>
  );
}

export default function RunnerHealthCard({
  health, onRefresh, busy,
}: { health: RunnerHealth | null; onRefresh: () => void; busy?: boolean }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const { status, alerts } = runnerStatus(health);
  const lease = health?.lease ?? null;
  const q = health?.queue ?? {};
  const Icon = status === 'healthy' ? CheckCircle2 : status === 'degraded' ? AlertTriangle : XCircle;

  return (
    <div className="card p-5 mb-4">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-chocolate/10 flex items-center justify-center">
            <Bot size={18} className="text-chocolate" />
          </div>
          <div>
            <h2 className="font-bold text-charcoal">{L('مشغّل الذكاء (Claude Code)', 'Intelligence runner (Claude Code)')}</h2>
            <div className="text-[11px] text-charcoal/40">
              {L('يعمل باشتراك Claude المدفوع — بدون رسوم لكل رمز عبر واجهة البرمجة',
                 'Runs on the paid Claude subscription — no incremental per-token API charge')}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold border ${STATUS_CLS[status]}`}>
            <Icon size={14} />
            {status === 'healthy' ? L('يعمل', 'Running') : status === 'degraded' ? L('متدهور', 'Degraded') : L('متوقف', 'Down')}
          </span>
          <button type="button" onClick={onRefresh} disabled={busy}
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-copper/10 text-copper hover:bg-copper/20 disabled:opacity-50">
            <RefreshCw size={14} /> {L('تحديث', 'Refresh')}
          </button>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="space-y-1.5 mb-4">
          {alerts.map((a) => (
            <div key={a.code} className={`text-xs px-3 py-2 rounded-lg border flex items-center gap-2 ${SEV_CLS[a.severity]}`}>
              <AlertTriangle size={13} className="shrink-0" />
              {isAr ? a.ar : a.en}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <Field label={L('المضيف', 'Host')} value={lease?.host ?? '—'} mono />
        <Field label={L('آخر نبضة', 'Last heartbeat')}
               value={lease ? `${lease.heartbeat_age_seconds}s ${L('مضت', 'ago')}` : '—'} />
        <Field label={L('يملك العقد منذ', 'Lease held since')} value={lease ? ago(lease.acquired_at) : '—'} />
        <Field label={L('آخر مهمة مكتملة', 'Last completed job')} value={ago(health?.last_completed_at)} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {([['pending', 'في الانتظار', 'Queued'], ['running', 'قيد التنفيذ', 'Running'],
           ['ready', 'مكتملة', 'Completed'], ['failed', 'فاشلة', 'Failed']] as const).map(([k, ar, en]) => (
          <div key={k} className="rounded-xl bg-cream/60 px-3 py-2">
            <div className="text-[11px] text-charcoal/40">{L(ar, en)}</div>
            <div className={`text-lg font-bold ${k === 'failed' && (q.failed ?? 0) > 0 ? 'text-amber-600' : 'text-copper'}`}>
              {q[k] ?? 0}
            </div>
          </div>
        ))}
      </div>

      {health?.current_job ? (
        <div className="rounded-xl border border-copper/20 bg-copper/5 px-4 py-3 flex items-center gap-3">
          <Clock size={16} className="text-copper shrink-0" />
          <div className="text-sm text-charcoal">
            <span className="font-semibold">{health.current_job.kind}</span>
            {' — '}
            {L('يعمل منذ', 'running for')} {Math.max(1, Math.round(health.current_job.running_seconds / 60))} {L('دقيقة', 'min')}
            {health.current_job.attempts > 1 && ` · ${L('محاولة', 'attempt')} ${health.current_job.attempts}`}
          </div>
        </div>
      ) : (
        <div className="text-xs text-charcoal/40">{L('لا توجد مهمة قيد التنفيذ حاليًا', 'No job currently running')}</div>
      )}

      {health && health.awaiting_intelligence_posts > 0 && (
        <div className="mt-3 text-xs text-charcoal/60">
          {health.awaiting_intelligence_posts} {L('منشور بانتظار التحليل', 'post(s) awaiting intelligence')}
        </div>
      )}
    </div>
  );
}
