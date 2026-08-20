/**
 * Financing calculator — Bayut-style rebuild (2026-08-20).
 *
 * A deliberate duplicate of bayut.sa's listing-page "حاسبة التمويل": pick a
 * bank, set price / down payment / term, see the flat-rate monthly instalment.
 * The V2 prequalification engine (scenarios, capacity/DBR, product matching,
 * consent, admin) was deleted on user decision — too complicated.
 *
 * One deliberate divergence from Bayut: their "هل تمتلك عقار؟" toggle is wired
 * backwards (answering "yes, I already own property" gets the 10% first-home
 * down payment). Here the question is asked as first-home directly and wired
 * per SAMA: Saudi + first home → 10% min down; otherwise 30%.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Calculator, Copy } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import {
  DEFAULT_BANKS, DEFAULT_TERM_YEARS, FIRST_HOME_MIN_DOWN_PCT, MAX_DOWN_PCT, MAX_TERM_YEARS,
  MIN_TERM_YEARS, STANDARD_MIN_DOWN_PCT, loadBanks, rateFor, type FinancingBank,
} from '@/lib/financing/banks';
import { calcFinancing, clamp } from '@/lib/financing/calc';

const DEFAULT_PRICE = 750_000;
const PRICE_MIN = 100_000;
/** Bayut caps its price slider at 1.3× the listing price; same idea here. */
const PRICE_SLIDER_MULTIPLIER = 1.3;

function fmt(n: number, isAr: boolean): string {
  return new Intl.NumberFormat(isAr ? 'ar-SA' : 'en-US', { maximumFractionDigits: 0 }).format(Math.round(n));
}

const inputCls =
  'w-full rounded-lg border border-sand/40 bg-white px-3 py-2 text-sm font-bold text-charcoal outline-none focus:border-copper focus:ring-2 focus:ring-copper/20';

function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: Array<{ key: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-sand/40 bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={`rounded-md px-4 py-1.5 text-sm font-bold transition-colors ${
            value === o.key ? 'bg-copper text-white' : 'text-charcoal/60 hover:text-charcoal'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Donut: financing value vs interest, total due in the middle. */
function FinancingDonut({ interestShare, totalPayable, isAr }: {
  interestShare: number;
  totalPayable: number;
  isAr: boolean;
}) {
  const R = 54;
  const C = 2 * Math.PI * R;
  const interestLen = C * clamp(interestShare, 0, 1);
  return (
    <div className="relative mx-auto h-40 w-40">
      <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90">
        <circle cx="64" cy="64" r={R} fill="none" stroke="#D4B896" strokeOpacity="0.45" strokeWidth="12" />
        <circle
          cx="64" cy="64" r={R} fill="none" stroke="#4A2C2A" strokeWidth="12" strokeLinecap="butt"
          strokeDasharray={`${interestLen} ${C - interestLen}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-[10px] font-bold text-charcoal/55">
          {isAr ? 'إجمالي المبلغ المستحق' : 'Total amount due'}
        </span>
        <span className="text-base font-bold text-charcoal">{fmt(totalPayable, isAr)}</span>
        <span className="text-[10px] text-charcoal/45">{isAr ? 'ر.س' : 'SAR'}</span>
      </div>
    </div>
  );
}

function SliderRow({ label, suffix, badge, value, display, min, max, step, onValue, isAr }: {
  label: string;
  suffix: string;
  badge?: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onValue: (n: number) => void;
  isAr: boolean;
}) {
  // The text input is free-typed and clamped on blur; the slider clamps live.
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { setDraft(null); }, [value]);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-bold text-charcoal">{label}</span>
        {badge && <span className="rounded-md bg-copper/10 px-2 py-0.5 text-xs font-bold text-copper">{badge}</span>}
      </div>
      <div className="flex items-center gap-3">
        <div className="relative w-44 shrink-0">
          <input
            className={`${inputCls} ${isAr ? 'pl-12' : 'pr-12'}`}
            inputMode="numeric"
            value={draft ?? display}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft === null) return;
              const n = Number(draft.replace(/[^\d.]/g, ''));
              onValue(clamp(n, min, max));
              setDraft(null);
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
          <span className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-xs text-charcoal/40 ${isAr ? 'left-3' : 'right-3'}`}>
            {suffix}
          </span>
        </div>
        <input
          type="range"
          className="h-1.5 w-full cursor-pointer accent-copper"
          min={min}
          max={max}
          step={step}
          value={clamp(value, min, max)}
          onChange={(e) => onValue(Number(e.target.value))}
        />
      </div>
    </div>
  );
}

export default function FinancingPage() {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const addToast = useAppStore((s) => s.addToast);
  const t = (ar: string, en: string) => (isAr ? ar : en);
  const [params] = useSearchParams();

  const [banks, setBanks] = useState<FinancingBank[]>(DEFAULT_BANKS);
  const [bankSlug, setBankSlug] = useState<string>(DEFAULT_BANKS[0]?.slug ?? '');
  const [nationality, setNationality] = useState<'saudi' | 'non_saudi'>('saudi');
  const [firstHome, setFirstHome] = useState(true);

  const priceParam = Number(params.get('price'));
  const initialPrice = Number.isFinite(priceParam) && priceParam >= PRICE_MIN ? priceParam : DEFAULT_PRICE;
  const [price, setPrice] = useState(initialPrice);
  const [term, setTerm] = useState(DEFAULT_TERM_YEARS);

  const minDownPct = nationality === 'saudi' && firstHome ? FIRST_HOME_MIN_DOWN_PCT : STANDARD_MIN_DOWN_PCT;
  const minDown = (price * minDownPct) / 100;
  const maxDown = (price * MAX_DOWN_PCT) / 100;
  const [downPayment, setDownPayment] = useState(minDown);

  // Bayut resets the down payment to the minimum whenever the floor moves
  // (price edit or eligibility change); duplicated here.
  useEffect(() => { setDownPayment(minDown); }, [minDown]);

  useEffect(() => {
    let alive = true;
    void loadBanks().then((b) => {
      if (!alive || b.length === 0) return;
      setBanks(b);
      setBankSlug((cur) => (b.some((x) => x.slug === cur) ? cur : (b[0]?.slug ?? cur)));
    });
    return () => { alive = false; };
  }, []);

  const bank = banks.find((b) => b.slug === bankSlug) ?? banks[0] ?? null;
  const rate = rateFor(bank, term);
  const result = useMemo(
    () => calcFinancing(price, clamp(downPayment, minDown, maxDown), term, rate),
    [price, downPayment, minDown, maxDown, term, rate],
  );
  const downPct = price > 0 ? Math.round((result.downPaymentAmount / price) * 100) : 0;
  const priceSliderMax = Math.max(2_000_000, Math.ceil((price * PRICE_SLIDER_MULTIPLIER) / 50_000) * 50_000);

  const copySummary = async () => {
    const bankName = bank ? (isAr ? bank.name_ar : bank.name_en) : '';
    const lines = isAr
      ? [
          'حاسبة التمويل — وصل العقارية',
          `سعر العقار: ${fmt(price, true)} ر.س`,
          `الدفعة الأولى: ${fmt(result.downPaymentAmount, true)} ر.س (${downPct}%)`,
          `مبلغ التمويل: ${fmt(result.totalLoanAmount, true)} ر.س`,
          `المدة: ${term} سنة — ${bankName} (${(rate * 100).toFixed(2)}% سنوي ثابت)`,
          `القسط الشهري التقريبي: ${fmt(result.monthlyInstalment, true)} ر.س`,
          `إجمالي المبلغ المستحق: ${fmt(result.totalPayableValue, true)} ر.س`,
          'الأرقام تقديرية وقد تختلف حسب سياسة البنك.',
        ]
      : [
          'Financing calculator — Wassel',
          `Property price: SAR ${fmt(price, false)}`,
          `Down payment: SAR ${fmt(result.downPaymentAmount, false)} (${downPct}%)`,
          `Financing amount: SAR ${fmt(result.totalLoanAmount, false)}`,
          `Term: ${term} years — ${bankName} (${(rate * 100).toFixed(2)}% flat/yr)`,
          `Est. monthly instalment: SAR ${fmt(result.monthlyInstalment, false)}`,
          `Total amount due: SAR ${fmt(result.totalPayableValue, false)}`,
          'Estimates only; final terms depend on the bank.',
        ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      addToast(t('تم نسخ الملخص', 'Summary copied'), 'success');
    } catch (err) {
      console.error('[financing] clipboard write failed', err);
      addToast(t('تعذّر النسخ', 'Copy failed'), 'error');
    }
  };

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="mb-4 flex items-center gap-2">
        <Calculator size={20} className="text-copper" />
        <h1 className="text-xl font-bold text-charcoal">{t('حاسبة التمويل', 'Financing Calculator')}</h1>
      </div>

      <div className="rounded-xl border border-sand/40 bg-white p-4 sm:p-6">
        <div className="flex flex-col gap-6 lg:flex-row">
          {/* Controls */}
          <div className="min-w-0 flex-1 space-y-5">
            <Segmented
              value={nationality}
              onChange={setNationality}
              options={[
                { key: 'saudi', label: t('سعودي', 'Saudi') },
                { key: 'non_saudi', label: t('غير سعودي', 'Non-Saudi') },
              ]}
            />

            {nationality === 'saudi' && (
              <div>
                <div className="mb-1.5 text-sm font-bold text-charcoal">
                  {t('هل هذا أول عقار تتملكه؟', 'Is this your first home?')}
                </div>
                <Segmented
                  value={firstHome ? 'yes' : 'no'}
                  onChange={(v) => setFirstHome(v === 'yes')}
                  options={[
                    { key: 'yes', label: t('نعم', 'Yes') },
                    { key: 'no', label: t('لا', 'No') },
                  ]}
                />
              </div>
            )}

            <div>
              <div className="mb-1.5 text-sm font-bold text-charcoal">{t('البنك', 'Bank')}</div>
              <div className="flex flex-wrap gap-2">
                {banks.map((b) => (
                  <button
                    key={b.slug}
                    type="button"
                    onClick={() => setBankSlug(b.slug)}
                    className={`rounded-lg border px-3 py-2 text-xs font-bold transition-colors ${
                      b.slug === bankSlug
                        ? 'border-copper bg-copper/10 text-copper'
                        : 'border-sand/40 bg-white text-charcoal/70 hover:border-copper/40'
                    }`}
                  >
                    {isAr ? b.name_ar : b.name_en}
                  </button>
                ))}
              </div>
            </div>

            <SliderRow
              label={t('السعر الإجمالي', 'Total price')}
              suffix={t('ر.س', 'SAR')}
              value={price}
              display={fmt(price, isAr)}
              min={PRICE_MIN}
              max={priceSliderMax}
              step={10_000}
              onValue={setPrice}
              isAr={isAr}
            />

            <SliderRow
              label={t('الدفعة الأولى', 'Down payment')}
              suffix={t('ر.س', 'SAR')}
              badge={`${downPct}%`}
              value={result.downPaymentAmount}
              display={fmt(result.downPaymentAmount, isAr)}
              min={minDown}
              max={maxDown}
              step={5_000}
              onValue={setDownPayment}
              isAr={isAr}
            />

            <SliderRow
              label={t('فترة السداد', 'Repayment period')}
              suffix={t('سنة', 'yrs')}
              value={term}
              display={String(term)}
              min={MIN_TERM_YEARS}
              max={MAX_TERM_YEARS}
              step={1}
              onValue={(n) => setTerm(Math.round(n))}
              isAr={isAr}
            />

            <p className="text-[11px] leading-snug text-charcoal/45">
              {t(
                'إخلاء المسؤولية: الأرقام تقديرية بفائدة سنوية ثابتة وقد تختلف الأسعار النهائية وفقًا لسياسة البنك عند تقديم الطلب.',
                'Disclaimer: figures are estimates using a flat annual rate; final pricing depends on the bank at application time.',
              )}
            </p>
          </div>

          {/* Details */}
          <div className="w-full shrink-0 rounded-xl border border-sand/40 bg-cream/40 p-5 lg:w-80">
            <div className="mb-3 text-center text-sm font-bold text-charcoal">{t('تفاصيل التمويل', 'Financing details')}</div>
            <FinancingDonut interestShare={result.interestShare} totalPayable={result.totalPayableValue} isAr={isAr} />
            <div className="mt-2 flex items-center justify-center gap-4 text-[11px] text-charcoal/60">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#4A2C2A]" /> {t('الفائدة', 'Interest')}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-sand" /> {t('قيمة التمويل', 'Financing value')}
              </span>
            </div>

            <div className="mt-4 space-y-3 border-t border-sand/40 pt-4 text-center">
              <div>
                <div className="text-xs font-bold text-charcoal/55">{t('قسط شهري', 'Monthly instalment')}</div>
                <div className="text-2xl font-bold text-charcoal">
                  {fmt(result.monthlyInstalment, isAr)} <span className="text-sm">{t('ر.س', 'SAR')}</span>
                </div>
              </div>
              <div>
                <div className="text-xs font-bold text-charcoal/55">{t('إجمالي مبلغ التمويل', 'Total financing amount')}</div>
                <div className="text-lg font-bold text-charcoal">
                  {fmt(result.totalLoanAmount, isAr)} <span className="text-xs">{t('ر.س', 'SAR')}</span>
                </div>
              </div>
              <div className="text-[11px] text-charcoal/50">
                {t('نسبة سنوية ثابتة', 'Flat annual rate')}: {(rate * 100).toFixed(2)}%
              </div>
            </div>

            <Button className="mt-4 w-full" onClick={() => void copySummary()}>
              <Copy size={15} /> {t('نسخ الملخص', 'Copy summary')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
