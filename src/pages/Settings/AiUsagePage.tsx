import { useMemo, useState } from 'react';
import {
  Wallet, AlertTriangle, Loader2, Plus, Info,
  RefreshCw, ChevronDown, Check,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import type { ToastType } from '@/types';
import BackToSettings from './components/BackToSettings';
import AddCreditModal from './components/AddCreditModal';
import {
  useAiUsage, setModelPrice, usd, usdPrecise, formatTokens,
  summarizeAccounts, summarizeSpend,
  areaLabel, PROVIDER_LABELS,
  type AiAccountBalance, type AiUnpricedModel, type AiBalanceCheck,
} from '@/lib/aiUsage/client';

/**
 * Settings → AI Usage & Credit.
 *
 * Answers two questions the app could not answer before 2026-09-14:
 *   "what is the AI spending, and on what?"  → from the ai_usage ledger
 *   "how much credit is left?"               → operator-entered balance minus
 *                                               that metered spend
 *
 * The second is operator-entered because NO provider here exposes a balance an
 * API key can read. That makes honesty about precision the page's main job: any
 * figure resting on unpriced usage is labelled an upper bound rather than shown
 * as fact, and the models that lack a price are put in front of the operator
 * with the field to fix them.
 */
export default function AiUsagePage() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const { balances, runway, spend, unpriced, checks, loading, error, reload } = useAiUsage(30);
  const [creditFor, setCreditFor] = useState<AiAccountBalance | null>(null);

  const totals = useMemo(() => summarizeAccounts(balances), [balances]);

  const spend30 = useMemo(() => summarizeSpend(spend), [spend]);

  if (loading) {
    return (
      <div className="p-6">
        <BackToSettings />
        <div className="flex items-center gap-2 py-16 text-sm text-charcoal/50">
          <Loader2 size={16} className="animate-spin" />
          {isAr ? 'جارٍ التحميل…' : 'Loading…'}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 pb-24">
      <BackToSettings />

      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-charcoal">
            <Wallet size={22} className="text-copper" />
            {isAr ? 'استهلاك الذكاء الاصطناعي والرصيد' : 'AI Usage & Credit'}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-charcoal/55">
            {isAr
              ? 'كل نداء للذكاء الاصطناعي في التطبيق يُسجَّل هنا. الرصيد تُدخله يدويًا — لا يوفّر أي مزوّد واجهة لقراءة رصيدك — ثم يُخصم الاستهلاك المُسجَّل تلقائيًا.'
              : 'Every AI call the app makes is recorded here. Balances are typed in by hand — no provider exposes a balance an API key can read — and the metered spend is subtracted automatically.'}
          </p>
        </div>
        <button
          onClick={() => void reload()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-sand/40 px-3 py-2 text-xs font-bold text-charcoal/60 transition hover:bg-cream"
        >
          <RefreshCw size={13} />
          {isAr ? 'تحديث' : 'Refresh'}
        </button>
      </header>

      {error && (
        <div className="mb-6 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <div>
            <strong>{isAr ? 'تعذّر تحميل البيانات.' : 'Could not load the data.'}</strong>{' '}
            {isAr
              ? 'ما يظهر أدناه ليس «لا يوجد استهلاك» — بل لم نتمكّن من السؤال.'
              : 'What you see below is not "no spend" — it is "we could not ask".'}
            <div className="mt-1 font-mono text-xs opacity-70">{error}</div>
          </div>
        </div>
      )}

      {/* ── Totals ───────────────────────────────────────────────── */}
      <section className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={isAr ? 'الرصيد المتبقي' : 'Credit remaining'}
          value={totals.trackedCount ? usd(totals.remaining) : '—'}
          hint={
            totals.trackedCount
              ? totals.anyUpperBound
                ? isAr ? 'حد أعلى — راجع التسعير' : 'upper bound — see pricing'
                : isAr ? `عبر ${totals.trackedCount} حساب` : `across ${totals.trackedCount} accounts`
              : isAr ? 'لم تُدخل أي رصيد بعد' : 'no balances entered yet'
          }
          tone={totals.anyUpperBound ? 'warn' : 'default'}
        />
        <Stat
          label={isAr ? 'إجمالي ما أُضيف' : 'Total loaded'}
          value={totals.trackedCount ? usd(totals.credited) : '—'}
          hint={isAr ? 'منذ بداية التتبّع' : 'since tracking started'}
        />
        <Stat
          label={isAr ? 'أُنفق (٣٠ يومًا)' : 'Spent (30 days)'}
          value={usd(spend30.cost)}
          hint={`${spend30.calls.toLocaleString('en-US')} ${isAr ? 'نداء' : 'calls'}`}
        />
        <Stat
          label={isAr ? 'نداءات بلا سعر' : 'Unpriced calls'}
          value={spend30.unpricedCalls.toLocaleString('en-US')}
          hint={
            spend30.unpricedCalls
              ? isAr ? 'مُسجَّلة لكن غير مُسعَّرة' : 'recorded but not costed'
              : isAr ? 'كل شيء مُسعَّر' : 'everything is priced'
          }
          tone={spend30.unpricedCalls ? 'warn' : 'good'}
        />
      </section>

      {/* ── Is anything unmetered? ───────────────────── */}
      {/* Placed above everything else on purpose: every other number on this
          page is computed from OUR ledger, so they all agree with each other
          by construction. This is the only row that can disagree. */}
      <BalanceCheckPanel checks={checks} isAr={isAr} />

      {/* ── Unpriced models ──────────────────────────────────────── */}
      {unpriced.length > 0 && (
        <UnpricedPanel models={unpriced} isAr={isAr} onSaved={reload} addToast={addToast} />
      )}

      {/* ── Accounts ─────────────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-bold text-charcoal">
          {isAr ? 'الحسابات' : 'Accounts'}
        </h2>
        {balances.length === 0 ? (
          <div className="rounded-xl border border-dashed border-sand/50 bg-white px-4 py-8 text-center text-sm text-charcoal/45">
            {isAr
              ? 'لا توجد حسابات. تُنشأ تلقائيًا لكل مزوّد عند تطبيق الترحيل.'
              : 'No accounts. One is created per provider when the migration runs.'}
          </div>
        ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {balances.map((b) => (
            <AccountCard
              key={b.id}
              account={b}
              runwayDays={runway[b.id]?.days_remaining ?? null}
              dailyBurn={runway[b.id]?.avg_daily_usd ?? 0}
              isAr={isAr}
              onAddCredit={() => setCreditFor(b)}
            />
          ))}
        </div>
        )}
      </section>

      {/* ── Spend breakdown ──────────────────────────────────────── */}
      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="mb-3 text-sm font-bold text-charcoal">
            {isAr ? 'الإنفاق حسب القسم (٣٠ يومًا)' : 'Spend by area (30 days)'}
          </h2>
          {spend30.areas.length === 0 ? (
            <EmptyNote isAr={isAr} />
          ) : (
            <div className="overflow-hidden rounded-xl border border-sand/30 bg-white">
              {spend30.areas.map(([area, v]) => {
                const pct = spend30.cost > 0 ? (v.cost / spend30.cost) * 100 : 0;
                return (
                  <div key={area} className="border-b border-sand/20 px-4 py-3 last:border-0">
                    <div className="mb-1.5 flex items-baseline justify-between gap-3">
                      <span className="text-sm font-bold text-charcoal">
                        {areaLabel(area, isAr)}
                      </span>
                      <span className="font-mono text-sm tabular-nums text-charcoal">
                        {usdPrecise(v.cost)}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-cream">
                      <div className="h-full rounded-full bg-copper" style={{ width: `${Math.max(pct, v.cost > 0 ? 2 : 0)}%` }} />
                    </div>
                    <div className="mt-1 flex gap-3 text-[11px] text-charcoal/45">
                      <span>{v.calls.toLocaleString('en-US')} {isAr ? 'نداء' : 'calls'}</span>
                      {v.unpriced > 0 && (
                        <span className="text-amber-600">
                          {v.unpriced.toLocaleString('en-US')} {isAr ? 'بلا سعر' : 'unpriced'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-3 text-sm font-bold text-charcoal">
            {isAr ? 'أكثر المواضع إنفاقًا' : 'Top spending call sites'}
          </h2>
          {spend30.sites.length === 0 ? (
            <EmptyNote isAr={isAr} />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-sand/30 bg-white">
              <table className="w-full min-w-[420px]">
                <thead>
                  <tr className="border-b border-sand/30 text-start text-[10px] uppercase tracking-wider text-charcoal/45">
                    <th className="px-4 py-2.5 text-start font-medium">{isAr ? 'الموضع' : 'Call site'}</th>
                    <th className="px-4 py-2.5 text-end font-medium">{isAr ? 'نداءات' : 'Calls'}</th>
                    <th className="px-4 py-2.5 text-end font-medium">{isAr ? 'التكلفة' : 'Cost'}</th>
                  </tr>
                </thead>
                <tbody>
                  {spend30.sites.map(([site, v]) => (
                    <tr key={site} className="border-b border-sand/20 last:border-0">
                      <td className="px-4 py-2.5">
                        <div className="font-mono text-xs text-charcoal">{site}</div>
                        <div className="text-[10px] text-charcoal/40">
                          {areaLabel(v.area, isAr)}
                          {v.unpriced > 0 && (
                            <span className="text-amber-600">
                              {' · '}{v.unpriced} {isAr ? 'بلا سعر' : 'unpriced'}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-end font-mono text-xs tabular-nums text-charcoal/70">
                        {v.calls.toLocaleString('en-US')}
                      </td>
                      <td className="px-4 py-2.5 text-end font-mono text-xs tabular-nums text-charcoal">
                        {usdPrecise(v.cost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {creditFor && (
        <AddCreditModal
          account={creditFor}
          hasHistory={creditFor.entry_count > 0}
          onClose={() => setCreditFor(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

type Tone = 'bad' | 'warn' | 'good' | 'mute';

const TONE_CLASS: Record<Tone, string> = {
  bad: 'bg-red-50 text-red-700 border-red-200',
  warn: 'bg-amber-50 text-amber-700 border-amber-200',
  good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  mute: 'bg-charcoal/5 text-charcoal/50 border-sand/40',
};

/**
 * Our figure beside the provider's real balance.
 *
 * WHY THIS IS THE MOST IMPORTANT PANEL HERE. Every other number on this page
 * comes out of `ai_usage`, so it can only ever report the call sites somebody
 * remembered to meter. On 2026-09-15 an operator-run calibration batch spent
 * about 20x the app's entire daily Anthropic bill from a laptop, through the
 * same key, and not one row of it reached the ledger. No amount of internal
 * arithmetic can see that. Starting from the vendor's own balance can.
 *
 * Each verdict is written out rather than reduced to a green tick, because
 * "we checked and it matches" and "we have never been able to check" are
 * completely different facts and a blank would blur them.
 */
function BalanceCheckPanel({ checks, isAr }: { checks: AiBalanceCheck[]; isAr: boolean }) {
  if (checks.length === 0) return null;

  const alarms = checks.filter((c) => c.verdict === 'UNMETERED_SPEND');
  const matched = checks.filter((c) => c.verdict === 'match');

  const COPY: Record<AiBalanceCheck['verdict'], { ar: string; en: string; tone: Tone }> = {
    UNMETERED_SPEND: { ar: 'إنفاق غير محتسب', en: 'Unmetered spend', tone: 'bad' },
    match: { ar: 'مطابق', en: 'Matches', tone: 'good' },
    credit_added: { ar: 'رصيد مُضاف لم يُسجّل', en: 'Top-up not recorded', tone: 'warn' },
    ours_is_upper_bound: { ar: 'رقمنا حدّ أعلى', en: 'Ours is an upper bound', tone: 'warn' },
    stale_probe: { ar: 'القراءة قديمة', en: 'Reading is stale', tone: 'warn' },
    no_probe: { ar: 'لم يتم الفحص', en: 'Not checked yet', tone: 'mute' },
    not_tracked: { ar: 'غير متتبّع', en: 'Not tracked', tone: 'mute' },
  };

  return (
    <section
      className={`mb-8 rounded-xl border p-4 ${
        alarms.length > 0 ? 'border-red-200 bg-red-50/60' : 'border-sand/50 bg-white'
      }`}
    >
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-charcoal">
          {isAr ? 'مطابقة الرصيد مع المزوّد' : 'Balance check against the provider'}
        </h2>
        <span className="text-xs text-charcoal/45">
          {isAr
            ? `${matched.length} من ${checks.length} مطابق`
            : `${matched.length} of ${checks.length} reconciled`}
        </span>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-charcoal/55">
        {isAr
          ? 'كل رقم آخر في هذه الصفحة محسوب من سجلّنا، فلا يمكنه رؤية إنفاق لم يُسجّل أصلاً. هذه المقارنة تبدأ من رصيد المزوّد نفسه، وهي الوحيدة القادرة على كشف ذلك.'
          : 'Every other number here is computed from our own ledger, so none of them can see spend that was never recorded. This row starts from the provider’s own balance, which is the only thing that can.'}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-sand/40 text-xs text-charcoal/45">
              <th className="py-1.5 text-start font-medium">{isAr ? 'المزوّد' : 'Provider'}</th>
              <th className="py-1.5 text-end font-medium">{isAr ? 'حسب سجلّنا' : 'Our figure'}</th>
              <th className="py-1.5 text-end font-medium">{isAr ? 'لدى المزوّد' : 'Provider says'}</th>
              <th className="py-1.5 text-end font-medium">{isAr ? 'الفرق' : 'Difference'}</th>
              <th className="py-1.5 text-end font-medium">{isAr ? 'الحالة' : 'Status'}</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => {
              const copy = COPY[c.verdict];
              const label = PROVIDER_LABELS[c.provider];
              return (
                <tr key={c.provider} className="border-b border-sand/20 last:border-0">
                  <td className="py-2 font-medium text-charcoal">
                    {label ? (isAr ? label.ar : label.en) : c.provider}
                  </td>
                  <td className="py-2 text-end tabular-nums text-charcoal/70">{usdPrecise(c.ours_remaining_usd)}</td>
                  <td className="py-2 text-end tabular-nums text-charcoal/70">
                    {c.provider_balance_usd === null ? '—' : usdPrecise(c.provider_balance_usd)}
                  </td>
                  <td
                    className={`py-2 text-end tabular-nums ${
                      c.verdict === 'UNMETERED_SPEND' ? 'font-bold text-red-700' : 'text-charcoal/70'
                    }`}
                  >
                    {c.drift_usd === null ? '—' : usdPrecise(c.drift_usd)}
                  </td>
                  <td className="py-2 text-end">
                    <span className={`inline-block rounded-md border px-2 py-0.5 text-xs ${TONE_CLASS[copy.tone]}`}>
                      {isAr ? copy.ar : copy.en}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {alarms.length > 0 && (
        <p className="mt-3 rounded-lg bg-red-100/70 px-3 py-2 text-xs leading-relaxed text-red-800">
          {isAr
            ? 'خرج مال من الحساب دون المرور على السجلّ. الأسباب المعتادة: تشغيل يدوي لسكربت أو اختبار حيّ من جهاز، أو موضع استدعاء جديد غير موصول.'
            : 'Money left the account without passing through the ledger. Usual causes: a script or live e2e test run by hand from a laptop, or a new call site nobody wired.'}
        </p>
      )}

      {/* A provider we cannot check at all is stated plainly rather than left
          as a dash somebody reads as agreement. */}
      {checks.some((c) => c.probe_status === 'unsupported') && (
        <p className="mt-2 text-xs leading-relaxed text-charcoal/45">
          {isAr
            ? 'بعض المزوّدين لا يوفّرون واجهة لقراءة الرصيد، فلا يمكن فحصهم تلقائياً بعد.'
            : 'Some providers publish no balance endpoint, so they cannot be checked automatically yet.'}
        </p>
      )}
    </section>
  );
}

function Stat({
  label, value, hint, tone = 'default',
}: {
  label: string; value: string; hint?: string; tone?: 'default' | 'warn' | 'good';
}) {
  const valueTone =
    tone === 'warn' ? 'text-amber-600' : tone === 'good' ? 'text-emerald-600' : 'text-charcoal';
  return (
    <div className="rounded-xl border border-sand/30 bg-white px-4 py-3.5">
      <div className="text-[10px] uppercase tracking-wider text-charcoal/45">{label}</div>
      <div className={`mt-1 font-mono text-2xl font-bold tabular-nums ${valueTone}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-charcoal/45">{hint}</div>}
    </div>
  );
}

function EmptyNote({ isAr }: { isAr: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-sand/50 bg-white px-4 py-8 text-center text-sm text-charcoal/45">
      {isAr ? 'لا يوجد استهلاك مُسجَّل في آخر ٣٠ يومًا.' : 'No usage recorded in the last 30 days.'}
    </div>
  );
}

function AccountCard({
  account, runwayDays, dailyBurn, isAr, onAddCredit,
}: {
  account: AiAccountBalance;
  runwayDays: number | null;
  dailyBurn: number;
  isAr: boolean;
  onAddCredit: () => void;
}) {
  const meta = PROVIDER_LABELS[account.provider];
  const tracked = account.entry_count > 0;
  const pct = account.pct_used ?? 0;

  return (
    <div
      className={`flex flex-col rounded-xl border bg-white p-4 ${
        account.is_low ? 'border-amber-300 ring-1 ring-amber-200' : 'border-sand/30'
      }`}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-bold text-charcoal">{account.label}</div>
          <div className="truncate text-[11px] text-charcoal/40">{meta?.billing ?? account.provider}</div>
        </div>
        {account.is_low && (
          <span className="shrink-0 rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">
            {isAr ? 'منخفض' : 'Low'}
          </span>
        )}
      </div>

      {!tracked ? (
        <div className="flex flex-1 flex-col items-start justify-center gap-2 rounded-lg bg-cream px-3 py-5">
          <p className="text-xs leading-relaxed text-charcoal/55">
            {isAr
              ? 'لم يبدأ التتبّع. أدخل الرصيد الحالي ليُخصم منه الاستهلاك من الآن فصاعدًا.'
              : 'Not tracked yet. Enter the balance this account holds now and spend will be subtracted from it onward.'}
          </p>
          <Button onClick={onAddCredit} className="!px-3 !py-1.5 !text-xs">
            <Plus size={13} />
            {isAr ? 'إدخال الرصيد' : 'Set opening balance'}
          </Button>
        </div>
      ) : (
        <>
          <div className="mb-1 flex items-baseline gap-1.5">
            <span className="font-mono text-2xl font-bold tabular-nums text-charcoal">
              {usd(account.remaining_usd)}
            </span>
            <span className="text-xs text-charcoal/45">{isAr ? 'متبقٍ' : 'left'}</span>
          </div>

          {account.remaining_is_upper_bound && (
            <div className="mb-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-amber-700">
              <Info size={12} className="mt-0.5 shrink-0" />
              <span>
                {isAr
                  ? `حد أعلى: ${account.unpriced_calls.toLocaleString('en-US')} نداء مُسجَّل بلا سعر، فالمتبقي الحقيقي أقل.`
                  : `Upper bound: ${account.unpriced_calls.toLocaleString('en-US')} recorded calls have no price, so the real figure is lower.`}
              </span>
            </div>
          )}

          <div className="mb-2 h-2 overflow-hidden rounded-full bg-cream">
            <div
              className={`h-full rounded-full ${pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-copper'}`}
              style={{ width: `${Math.min(100, Math.max(pct, 1))}%` }}
            />
          </div>

          <dl className="mt-auto grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <Row label={isAr ? 'أُضيف' : 'Loaded'} value={usd(account.credited_usd)} />
            <Row label={isAr ? 'أُنفق' : 'Spent'} value={usd(account.spent_usd)} />
            <Row
              label={isAr ? 'يوميًا' : 'Per day'}
              value={dailyBurn > 0 ? usdPrecise(dailyBurn) : '—'}
            />
            <Row
              label={isAr ? 'يكفي' : 'Runway'}
              value={
                runwayDays == null
                  ? '—'
                  : isAr ? `${runwayDays.toLocaleString('en-US')} يومًا` : `${runwayDays.toLocaleString('en-US')} days`
              }
              tone={runwayDays != null && runwayDays < 14 ? 'warn' : 'default'}
            />
          </dl>

          <button
            onClick={onAddCredit}
            className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-lg border border-sand/40 px-3 py-1.5 text-xs font-bold text-charcoal/70 transition hover:bg-cream"
          >
            <Plus size={13} />
            {isAr ? 'تسجيل رصيد' : 'Record credit'}
          </button>
        </>
      )}
    </div>
  );
}

function Row({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'warn' }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-charcoal/45">{label}</dt>
      <dd className={`font-mono tabular-nums ${tone === 'warn' ? 'text-amber-600' : 'text-charcoal/75'}`}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The operator worklist: models with recorded usage and no price. Entering one
 * rate re-costs the whole history for that provider, and the panel reports how
 * many rows it just costed — which is the point at which a balance stops being
 * an upper bound.
 */
function UnpricedPanel({
  models, isAr, onSaved, addToast,
}: {
  models: AiUnpricedModel[];
  isAr: boolean;
  onSaved: () => void;
  addToast: (m: string, t: ToastType) => void;
}) {
  const [openModel, setOpenModel] = useState<string | null>(null);
  const totalCalls = models.reduce((s, m) => s + m.calls, 0);

  return (
    <section className="mb-8 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
      <div className="mb-1 flex items-center gap-2">
        <AlertTriangle size={16} className="text-amber-600" />
        <h2 className="text-sm font-bold text-charcoal">
          {isAr ? 'نماذج بلا سعر' : 'Models with no price'}
        </h2>
      </div>
      <p className="mb-3 max-w-3xl text-xs leading-relaxed text-charcoal/60">
        {isAr
          ? `تم تسجيل ${totalCalls.toLocaleString('en-US')} نداء لهذه النماذج بالكامل (عدد الرموز محفوظ)، لكن لا نعرف سعرها فلم تُحتسب تكلفتها. أدخل السعر من لوحة المزوّد وسيُعاد تسعير كل السجل تلقائيًا.`
          : `${totalCalls.toLocaleString('en-US')} calls to these models were recorded in full — the tokens are saved — but we do not know their rate, so they are not costed. Enter the price from the provider's dashboard and the whole history re-costs itself.`}
      </p>

      <div className="flex flex-col gap-2">
        {models.map((m) => {
          const key = `${m.provider}/${m.model}`;
          return (
            <div key={key} className="overflow-hidden rounded-lg border border-amber-200 bg-white">
              <button
                onClick={() => setOpenModel(openModel === key ? null : key)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-start transition hover:bg-cream/50"
              >
                <div className="min-w-0">
                  <div className="truncate font-mono text-xs font-bold text-charcoal">{key}</div>
                  <div className="text-[11px] text-charcoal/45">
                    {m.calls.toLocaleString('en-US')} {isAr ? 'نداء' : 'calls'}
                    {m.input_tokens > 0 && ` · ${formatTokens(m.input_tokens)} ${isAr ? 'رمز دخل' : 'in'}`}
                    {m.output_tokens > 0 && ` · ${formatTokens(m.output_tokens)} ${isAr ? 'رمز خرج' : 'out'}`}
                    {m.units != null && m.units > 0 && ` · ${m.units.toLocaleString('en-US')} ${m.unit_kind ?? ''}`}
                  </div>
                </div>
                <ChevronDown
                  size={15}
                  className={`shrink-0 text-charcoal/40 transition ${openModel === key ? 'rotate-180' : ''}`}
                />
              </button>
              {openModel === key && (
                <PriceForm model={m} isAr={isAr} onSaved={onSaved} addToast={addToast} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PriceForm({
  model, isAr, onSaved, addToast,
}: {
  model: AiUnpricedModel;
  isAr: boolean;
  onSaved: () => void;
  addToast: (m: string, t: ToastType) => void;
}) {
  // A model billed per unit (fal images, Modal GPU seconds, audio minutes) has
  // no token price at all, so the form shows the field that actually applies.
  const perUnit = model.units != null && model.units > 0;
  const [inputPerM, setInputPerM] = useState('');
  const [outputPerM, setOutputPerM] = useState('');
  const [cacheReadPerM, setCacheReadPerM] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [saving, setSaving] = useState(false);

  const n = (v: string): number | null => {
    const t = v.trim();
    if (!t) return null;
    const parsed = Number(t);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };
  const canSave = perUnit ? n(unitPrice) != null : n(inputPerM) != null && n(outputPerM) != null;

  async function save() {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const repriced = await setModelPrice({
        provider: model.provider,
        model: model.model,
        inputPerM: perUnit ? null : n(inputPerM),
        outputPerM: perUnit ? null : n(outputPerM),
        cacheReadPerM: perUnit ? null : n(cacheReadPerM),
        unitPrice: perUnit ? n(unitPrice) : null,
        unitKind: perUnit ? model.unit_kind : null,
      });
      addToast(
        isAr
          ? `تم الحفظ — أُعيد تسعير ${repriced.toLocaleString('en-US')} سجل.`
          : `Saved — ${repriced.toLocaleString('en-US')} recorded calls just became costed.`,
        'success',
      );
      onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[aiUsage] setModelPrice failed:', msg);
      addToast(isAr ? `تعذّر حفظ السعر: ${msg}` : `Could not save the price: ${msg}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  const field = 'w-full rounded-lg border border-sand/40 bg-white px-2.5 py-2 text-xs text-charcoal outline-none focus:border-copper focus:ring-2 focus:ring-copper/20';

  return (
    <div className="border-t border-amber-200 bg-cream/40 px-3 py-3">
      {perUnit ? (
        <div className="mb-2">
          <label className="mb-1 block text-[11px] font-bold text-charcoal/60">
            {isAr ? `السعر لكل ${model.unit_kind ?? 'وحدة'} بالدولار` : `USD per ${model.unit_kind ?? 'unit'}`}
          </label>
          <input className={field} inputMode="decimal" value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)} placeholder="0.01" />
        </div>
      ) : (
        <div className="mb-2 grid grid-cols-3 gap-2">
          <div>
            <label className="mb-1 block text-[11px] font-bold text-charcoal/60">
              {isAr ? 'دخل / مليون' : 'Input / 1M'}
            </label>
            <input className={field} inputMode="decimal" value={inputPerM}
              onChange={(e) => setInputPerM(e.target.value)} placeholder="0.28" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-charcoal/60">
              {isAr ? 'خرج / مليون' : 'Output / 1M'}
            </label>
            <input className={field} inputMode="decimal" value={outputPerM}
              onChange={(e) => setOutputPerM(e.target.value)} placeholder="0.42" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-bold text-charcoal/60">
              {isAr ? 'ذاكرة / مليون' : 'Cache / 1M'}
            </label>
            <input className={field} inputMode="decimal" value={cacheReadPerM}
              onChange={(e) => setCacheReadPerM(e.target.value)} placeholder={isAr ? 'اختياري' : 'optional'} />
          </div>
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] leading-relaxed text-charcoal/45">
          {isAr
            ? 'أدخل السعر المنشور لدى المزوّد. لا تُخمّن — السعر الخاطئ أسوأ من غيابه.'
            : "Use the provider's published rate. Don't guess — a wrong price is worse than a missing one."}
        </p>
        <Button onClick={save} disabled={!canSave || saving} className="!px-3 !py-1.5 !text-xs">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
          {isAr ? 'حفظ وإعادة التسعير' : 'Save & re-cost'}
        </Button>
      </div>
    </div>
  );
}
