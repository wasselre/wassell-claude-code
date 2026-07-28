/**
 * The results surface: capacity breakdown, headline numbers, product
 * comparison, term/down-payment grids, sensitivity, and every caveat.
 *
 * Layout principle: the EXPLANATION sits beside the number, not behind a
 * tooltip. A rep reading "SAR 4,120/month" needs to see, without clicking, that
 * it came from a starting-from rate on data verified eight days ago.
 */
import { useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileWarning,
  Info,
  TrendingUp,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  INCOME_LABEL,
  OBLIGATION_LABEL,
  formatMonths,
  formatPct,
  formatSar,
} from '@/lib/financing/client';
import type { EngineResult, ProductMatch } from '@/lib/financing/types';
import { ConfidenceChip, IndicativeDisclaimer, RateBasisChip, StaleChip, StatusChip } from './StatusChips';

function Stat({
  label,
  value,
  sub,
  emphasis = false,
}: {
  label: string;
  value: string;
  sub?: string | null;
  emphasis?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-4 ${emphasis ? 'border-copper/30 bg-copper/5' : 'border-sand/30 bg-white'}`}>
      <div className="text-[11px] font-bold uppercase tracking-wide text-charcoal/50">{label}</div>
      <div className={`mt-1 font-bold ${emphasis ? 'text-2xl text-copper' : 'text-lg text-charcoal'}`}>{value}</div>
      {sub && <div className="mt-1 text-[11px] leading-snug text-charcoal/50">{sub}</div>}
    </div>
  );
}

function Section({
  title,
  children,
  defaultOpen = true,
  icon,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  icon?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card p-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 p-4 text-start"
      >
        {open ? <ChevronDown size={16} className="text-charcoal/40" /> : <ChevronRight size={16} className="text-charcoal/40 rtl:rotate-180" />}
        {icon}
        <span className="font-bold text-charcoal">{title}</span>
      </button>
      {open && <div className="border-t border-sand/20 p-4">{children}</div>}
    </div>
  );
}

export default function ResultsView({
  result,
  onSelectProduct,
}: {
  result: EngineResult;
  onSelectProduct?: (match: ProductMatch) => void;
}) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const t = (ar: string, en: string) => (isAr ? ar : en);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const cap = result.capacity;

  const toggleCompare = (id: string) =>
    setCompareIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-3)));

  const compared = result.matches.filter((m) => compareIds.includes(m.product.id));

  return (
    <div className="space-y-4" dir={isAr ? 'rtl' : 'ltr'}>
      {/* ── Headline ─────────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-3 p-5 pb-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={result.status} />
            <ConfidenceChip confidence={result.confidence} />
            <span className="text-xs text-charcoal/50">
              {t('تاريخ الاحتساب', 'Calculated')}: {result.as_of_date} · {t('محرك', 'engine')} v{result.engine_version}
            </span>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label={t('أقصى قسط شهري', 'Max monthly installment')}
            value={formatSar(cap.max_installment, isAr)}
            sub={cap.binding_constraint ? t(`القيد الحاكم: ${cap.binding_constraint}`, `Binding: ${cap.binding_constraint}`) : null}
            emphasis
          />
          <Stat
            label={t('أقصى مبلغ تمويل', 'Max financing')}
            value={formatSar(result.max_financing_from_income, isAr)}
          />
          <Stat
            label={t('أقصى قيمة عقار', 'Max property value')}
            value={formatSar(result.max_property_value, isAr)}
          />
          <Stat
            label={t('نسبة الاستقطاع الحالية', 'Current DBR')}
            value={formatPct(cap.current_dbr_pct, isAr)}
          />
        </div>
      </div>

      {/* ── The selected property, when one was supplied ─────────────── */}
      {result.selected && (
        <div className="card p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-bold text-charcoal">
              {t('العقار المحدد', 'Selected property')} — {isAr ? result.selected.product.name_ar : result.selected.product.name_en}
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              <RateBasisChip basis={result.selected.rate_basis} />
              {result.selected.is_stale && <StaleChip ageDays={result.selected.data_age_days} />}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label={t('القسط الشهري التقديري', 'Estimated monthly')}
              value={formatSar(result.selected.monthly_payment, isAr)}
              emphasis
            />
            <Stat label={t('مبلغ التمويل', 'Financing amount')} value={formatSar(result.selected.financing_amount, isAr)} />
            <Stat label={t('الدفعة الأولى', 'Down payment')} value={formatSar(result.selected.down_payment, isAr)} />
            <Stat
              label={t('نسبة التمويل للقيمة', 'LTV')}
              value={formatPct(result.selected.ltv_pct, isAr)}
              sub={t(`السقف: ${formatPct(result.selected.max_ltv_pct, isAr)}`, `Ceiling: ${formatPct(result.selected.max_ltv_pct, isAr)}`)}
            />
            <Stat label={t('إجمالي السداد', 'Total repayment')} value={formatSar(result.selected.total_repayment, isAr)} />
            <Stat label={t('تكلفة التمويل', 'Financing cost')} value={formatSar(result.selected.financing_cost, isAr)} />
            <Stat
              label={t('معدل النسبة السنوية', 'APR')}
              value={formatPct(result.selected.calculated_apr_pct ?? result.selected.published_apr_pct, isAr)}
              sub={
                result.selected.apr_basis === 'calculated'
                  ? t('محتسب من التدفقات النقدية', 'Calculated from cash flows')
                  : result.selected.apr_basis === 'published'
                    ? t('منشور من الممول — غير محتسب لهذا العميل', 'Published by the provider — not calculated for this customer')
                    : t('غير متاح', 'Unavailable')
              }
            />
            <Stat
              label={t('نسبة الاستقطاع بعد التمويل', 'DBR after financing')}
              value={formatPct(result.selected.projected_dbr_pct, isAr)}
            />
          </div>

          {/* Upfront cash */}
          {result.selected.upfront && (
            <div className="mt-4 rounded-xl border border-sand/30 bg-cream/40 p-4">
              <div className="mb-2 text-sm font-bold text-charcoal">{t('النقد المطلوب مقدمًا', 'Upfront cash required')}</div>
              <div className="space-y-1 text-xs">
                {result.selected.upfront.lines.map((l) => (
                  <div key={l.code} className="flex justify-between gap-4">
                    <span className="text-charcoal/60">{isAr ? l.label_ar : l.label_en}</span>
                    <span className="font-bold text-charcoal">{formatSar(l.value, isAr)}</span>
                  </div>
                ))}
                <div className="mt-2 flex justify-between gap-4 border-t border-sand/30 pt-2 text-sm">
                  <span className="font-bold text-charcoal">{t('الإجمالي', 'Total')}</span>
                  <span className="font-bold text-copper">{formatSar(result.selected.upfront.total, isAr)}</span>
                </div>
                {result.selected.upfront.shortfall !== null && result.selected.upfront.shortfall > 0 && (
                  <div className="mt-2 flex items-center gap-2 rounded-lg bg-red-50 p-2 text-red-700">
                    <AlertTriangle size={13} />
                    {t('نقص عن النقد المتاح', 'Shortfall vs available cash')}:{' '}
                    <span className="font-bold">{formatSar(result.selected.upfront.shortfall, isAr)}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Variable-rate sensitivity — scenarios, never forecasts */}
          {result.selected.sensitivity.length > 0 && (
            <div className="mt-4 rounded-xl border border-sand/30 p-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-bold text-charcoal">
                <TrendingUp size={14} />
                {t('حساسية السعر المتغير', 'Variable-rate sensitivity')}
              </div>
              <p className="mb-3 text-[11px] text-charcoal/50">
                {t(
                  'سيناريوهات افتراضية لبيان الأثر عند ارتفاع المؤشر — وليست توقعات.',
                  'Hypothetical scenarios showing the impact if the benchmark rises — these are not forecasts.',
                )}
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-lg bg-cream/60 p-2 text-center">
                  <div className="text-[10px] text-charcoal/50">{t('الحالي', 'Current')}</div>
                  <div className="text-sm font-bold text-charcoal">{formatSar(result.selected.monthly_payment, isAr)}</div>
                </div>
                {result.selected.sensitivity.map((s) => (
                  <div key={s.shock_pct} className="rounded-lg bg-amber-50 p-2 text-center">
                    <div className="text-[10px] text-amber-700">+{s.shock_pct}% ({formatPct(s.rate_pct, isAr)})</div>
                    <div className="text-sm font-bold text-amber-800">{formatSar(s.monthly_payment, isAr)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Qualifying income ────────────────────────────────────────── */}
      <Section title={t('تفصيل الدخل المؤهل', 'Qualifying income breakdown')}>
        <div className="mb-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-charcoal/5 p-2">
            <div className="text-[10px] text-charcoal/50">{t('المُقر', 'Declared')}</div>
            <div className="font-bold text-charcoal">{formatSar(cap.income.declared_total, isAr)}</div>
          </div>
          <div className="rounded-lg bg-charcoal/5 p-2">
            <div className="text-[10px] text-charcoal/50">{t('الموثق', 'Verified')}</div>
            <div className="font-bold text-charcoal">{formatSar(cap.income.verified_total, isAr)}</div>
          </div>
          <div className="rounded-lg bg-copper/10 p-2">
            <div className="text-[10px] text-copper">{t('المؤهل نظاميًا', 'Qualifying')}</div>
            <div className="font-bold text-copper">{formatSar(cap.income.qualifying_total, isAr)}</div>
          </div>
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-sand/30 text-charcoal/50">
              <th className="p-2 text-start">{t('المصدر', 'Source')}</th>
              <th className="p-2 text-end">{t('المُقر', 'Declared')}</th>
              <th className="p-2 text-end">{t('النسبة المؤهلة', 'Eligible %')}</th>
              <th className="p-2 text-end">{t('المحتسب', 'Counted')}</th>
              <th className="p-2 text-start">{t('السبب', 'Basis')}</th>
            </tr>
          </thead>
          <tbody>
            {cap.income.lines.map((l) => (
              <tr key={l.income_id} className="border-b border-sand/10">
                <td className="p-2 font-medium text-charcoal">
                  {isAr ? INCOME_LABEL[l.income_type]?.ar : INCOME_LABEL[l.income_type]?.en}
                </td>
                <td className="p-2 text-end text-charcoal/70">{formatSar(l.declared, isAr)}</td>
                <td className="p-2 text-end text-charcoal/70">{l.eligible_pct}%</td>
                <td className="p-2 text-end font-bold text-charcoal">{formatSar(l.qualifying, isAr)}</td>
                <td className="p-2 text-[11px] text-charcoal/50">
                  {l.exclusion_reason ?? l.basis}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* ── Obligations ──────────────────────────────────────────────── */}
      {cap.obligations.lines.length > 0 && (
        <Section title={t('الالتزامات القائمة', 'Existing obligations')}>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-sand/30 text-charcoal/50">
                <th className="p-2 text-start">{t('النوع', 'Type')}</th>
                <th className="p-2 text-end">{t('المحتسب شهريًا', 'Counted monthly')}</th>
                <th className="p-2 text-start">{t('طريقة الاحتساب', 'Counting basis')}</th>
              </tr>
            </thead>
            <tbody>
              {cap.obligations.lines.map((l) => (
                <tr key={l.obligation_id} className={`border-b border-sand/10 ${l.excluded ? 'opacity-50' : ''}`}>
                  <td className="p-2 font-medium text-charcoal">
                    {isAr ? OBLIGATION_LABEL[l.obligation_type]?.ar : OBLIGATION_LABEL[l.obligation_type]?.en}
                  </td>
                  <td className="p-2 text-end font-bold text-charcoal">
                    {l.excluded ? '—' : formatSar(l.counted_monthly, isAr)}
                  </td>
                  <td className="p-2 text-[11px] text-charcoal/50">{l.exclusion_reason ?? l.basis}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cap.after_expiry && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
              <div className="font-bold">{t('سيناريو بعد انتهاء الالتزامات', 'Scenario after obligations end')}</div>
              {t(
                `بعد ${cap.after_expiry.earliest_expiry_date} يرتفع أقصى قسط إلى ${formatSar(cap.after_expiry.max_installment, isAr)}`,
                `From ${cap.after_expiry.earliest_expiry_date}, the maximum installment rises to ${formatSar(cap.after_expiry.max_installment, isAr)}`,
              )}
            </div>
          )}
        </Section>
      )}

      {/* ── Ceilings ─────────────────────────────────────────────────── */}
      <Section title={t('السقوف النظامية المطبقة', 'Applicable regulatory ceilings')} defaultOpen={false}>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-sand/30 text-charcoal/50">
              <th className="p-2 text-start">{t('السقف', 'Ceiling')}</th>
              <th className="p-2 text-end">{t('النسبة', '%')}</th>
              <th className="p-2 text-end">{t('القيمة', 'Amount')}</th>
              <th className="p-2 text-end">{t('المتاح', 'Available')}</th>
            </tr>
          </thead>
          <tbody>
            {cap.ceilings.map((c) => (
              <tr key={c.code} className={`border-b border-sand/10 ${c.code === cap.binding_constraint ? 'bg-copper/5 font-bold' : ''}`}>
                <td className="p-2 text-charcoal">{isAr ? c.label_ar : c.label_en}</td>
                <td className="p-2 text-end text-charcoal/70">{c.pct !== null ? `${c.pct}%` : '—'}</td>
                <td className="p-2 text-end text-charcoal/70">{formatSar(c.ceiling_amount, isAr)}</td>
                <td className="p-2 text-end text-charcoal">
                  {c.defers_to_creditor ? t('حسب سياسة البنك', 'Per bank policy') : formatSar(c.available_amount, isAr)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* ── Product comparison ───────────────────────────────────────── */}
      <Section title={t('مقارنة المنتجات التمويلية', 'Financing product comparison')} icon={<Info size={15} className="text-charcoal/40" />}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-xs">
            <thead>
              <tr className="border-b border-sand/30 text-charcoal/50">
                <th className="p-2 text-start">{t('قارن', 'Compare')}</th>
                <th className="p-2 text-start">{t('الممول', 'Provider')}</th>
                <th className="p-2 text-start">{t('المنتج', 'Product')}</th>
                <th className="p-2 text-start">{t('الحالة', 'Status')}</th>
                <th className="p-2 text-end">{t('القسط', 'Monthly')}</th>
                <th className="p-2 text-end">{t('الإجمالي', 'Total cost')}</th>
                <th className="p-2 text-end">{t('السعر', 'Rate')}</th>
                <th className="p-2 text-end">{t('النسبة السنوية', 'APR')}</th>
                <th className="p-2 text-end">{t('الدفعة الأولى', 'Down pmt')}</th>
                <th className="p-2 text-end">{t('المدة', 'Term')}</th>
                <th className="p-2 text-start">{t('التحقق', 'Verified')}</th>
              </tr>
            </thead>
            <tbody>
              {result.matches.map((m) => (
                <tr
                  key={m.product.id}
                  className="cursor-pointer border-b border-sand/10 hover:bg-cream/40"
                  onClick={() => onSelectProduct?.(m)}
                >
                  <td className="p-2" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={compareIds.includes(m.product.id)}
                      onChange={() => toggleCompare(m.product.id)}
                      className="accent-copper"
                    />
                  </td>
                  <td className="p-2 font-medium text-charcoal">
                    {isAr ? m.product.provider.name_ar : m.product.provider.name_en}
                  </td>
                  <td className="p-2 text-charcoal/80">
                    <a
                      href={m.product.official_url ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="hover:text-copper hover:underline"
                    >
                      {isAr ? m.product.name_ar : m.product.name_en}
                    </a>
                  </td>
                  <td className="p-2"><StatusChip status={m.status} /></td>
                  <td className="p-2 text-end font-bold text-charcoal">
                    {m.monthly_payment !== null ? formatSar(m.monthly_payment, isAr) : '—'}
                  </td>
                  <td className="p-2 text-end text-charcoal/70">
                    {m.total_repayment !== null ? formatSar(m.total_repayment, isAr) : '—'}
                  </td>
                  <td className="p-2 text-end">
                    {m.applied_rate_pct !== null ? (
                      <div className="flex flex-col items-end gap-1">
                        <span className="font-bold text-charcoal">{formatPct(m.applied_rate_pct, isAr)}</span>
                        <RateBasisChip basis={m.rate_basis} />
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="p-2 text-end text-charcoal/70">
                    {formatPct(m.calculated_apr_pct ?? m.published_apr_pct, isAr)}
                  </td>
                  <td className="p-2 text-end text-charcoal/70">{m.down_payment !== null ? formatSar(m.down_payment, isAr) : '—'}</td>
                  <td className="p-2 text-end text-charcoal/70">{formatMonths(m.term_months, isAr)}</td>
                  <td className="p-2">
                    <div className="flex flex-col gap-1">
                      <ConfidenceChip confidence={m.confidence} />
                      {m.is_stale && <StaleChip ageDays={m.data_age_days} />}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Side-by-side drawer */}
        {compared.length > 1 && (
          <div className="mt-4 rounded-xl border border-copper/30 bg-copper/5 p-4">
            <div className="mb-3 text-sm font-bold text-charcoal">{t('مقارنة جانبية', 'Side-by-side comparison')}</div>
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${compared.length}, minmax(0, 1fr))` }}>
              {compared.map((m) => (
                <div key={m.product.id} className="rounded-lg bg-white p-3 text-xs">
                  <div className="mb-2 font-bold text-charcoal">
                    {isAr ? m.product.provider.name_ar : m.product.provider.name_en}
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between"><span className="text-charcoal/50">{t('القسط', 'Monthly')}</span><span className="font-bold">{formatSar(m.monthly_payment, isAr)}</span></div>
                    <div className="flex justify-between"><span className="text-charcoal/50">{t('الإجمالي', 'Total')}</span><span>{formatSar(m.total_repayment, isAr)}</span></div>
                    <div className="flex justify-between"><span className="text-charcoal/50">{t('الدفعة', 'Down')}</span><span>{formatSar(m.down_payment, isAr)}</span></div>
                    <div className="flex justify-between"><span className="text-charcoal/50">{t('النقد المقدم', 'Upfront')}</span><span>{formatSar(m.upfront?.total, isAr)}</span></div>
                    <div className="flex justify-between"><span className="text-charcoal/50">{t('المدة', 'Term')}</span><span>{formatMonths(m.term_months, isAr)}</span></div>
                    <div className="flex justify-between"><span className="text-charcoal/50">{t('السقف', 'Max LTV')}</span><span>{formatPct(m.max_ltv_pct, isAr)}</span></div>
                  </div>
                  <div className="mt-2"><RateBasisChip basis={m.rate_basis} /></div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Section>

      {/* ── Term and down-payment grids ──────────────────────────────── */}
      {result.term_options.length > 0 && (
        <Section title={t('مقارنة المدد', 'Term comparison')} defaultOpen={false}>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-sand/30 text-charcoal/50">
                <th className="p-2 text-start">{t('المدة', 'Term')}</th>
                <th className="p-2 text-end">{t('القسط', 'Monthly')}</th>
                <th className="p-2 text-end">{t('إجمالي السداد', 'Total repayment')}</th>
              </tr>
            </thead>
            <tbody>
              {result.term_options.map((o) => (
                <tr key={o.term_months} className="border-b border-sand/10">
                  <td className="p-2 text-charcoal">{formatMonths(o.term_months, isAr)}</td>
                  <td className="p-2 text-end font-bold text-charcoal">{formatSar(o.monthly_payment, isAr)}</td>
                  <td className="p-2 text-end text-charcoal/70">{formatSar(o.total_repayment, isAr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {result.down_payment_options.length > 0 && (
        <Section title={t('مقارنة الدفعة الأولى', 'Down-payment comparison')} defaultOpen={false}>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-sand/30 text-charcoal/50">
                <th className="p-2 text-start">{t('النسبة', '%')}</th>
                <th className="p-2 text-end">{t('الدفعة', 'Down payment')}</th>
                <th className="p-2 text-end">{t('التمويل', 'Financing')}</th>
                <th className="p-2 text-end">{t('القسط', 'Monthly')}</th>
                <th className="p-2 text-end">{t('نسبة التمويل', 'LTV')}</th>
              </tr>
            </thead>
            <tbody>
              {result.down_payment_options.map((o) => (
                <tr key={o.down_payment_pct} className="border-b border-sand/10">
                  <td className="p-2 text-charcoal">{o.down_payment_pct}%</td>
                  <td className="p-2 text-end text-charcoal/70">{formatSar(o.down_payment, isAr)}</td>
                  <td className="p-2 text-end text-charcoal/70">{formatSar(o.financing_amount, isAr)}</td>
                  <td className="p-2 text-end font-bold text-charcoal">{formatSar(o.monthly_payment, isAr)}</td>
                  <td className="p-2 text-end text-charcoal/70">{formatPct(o.ltv_pct, isAr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* ── Caveats ──────────────────────────────────────────────────── */}
      {(result.missing.length > 0 || cap.capacity_reducers.length > 0 || result.assumptions.length > 0) && (
        <Section title={t('ما يقلل الدقة والمعلومات الناقصة', 'What reduces accuracy, and what is missing')} icon={<FileWarning size={15} className="text-amber-500" />}>
          {cap.capacity_reducers.length > 0 && (
            <div className="mb-4">
              <div className="mb-1 text-xs font-bold text-charcoal">{t('أسباب انخفاض القدرة', 'Reasons capacity is reduced')}</div>
              <ul className="space-y-1 text-xs text-charcoal/70">
                {cap.capacity_reducers.map((r) => (
                  <li key={r.code}>• {isAr ? r.label_ar : r.label_en}{r.value !== null && r.value !== undefined ? ` — ${formatSar(r.value, isAr)}` : ''}</li>
                ))}
              </ul>
            </div>
          )}
          {result.missing.length > 0 && (
            <div className="mb-4">
              <div className="mb-1 text-xs font-bold text-charcoal">{t('معلومات ناقصة', 'Missing information')}</div>
              <ul className="space-y-1 text-xs text-charcoal/70">
                {result.missing.map((m, i) => (
                  <li key={`${m.code}-${i}`}>• {isAr ? m.label_ar : m.label_en}</li>
                ))}
              </ul>
            </div>
          )}
          {result.assumptions.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-bold text-charcoal">{t('الافتراضات', 'Assumptions')}</div>
              <ul className="space-y-1 text-xs text-charcoal/70">
                {result.assumptions.map((a, i) => (
                  <li key={`${a.code}-${i}`}>• {isAr ? a.label_ar : a.label_en}</li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      <IndicativeDisclaimer ar={result.disclaimer_ar} en={result.disclaimer_en} />
    </div>
  );
}
