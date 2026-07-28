/**
 * The honesty layer of the financing UI.
 *
 * Every number this feature displays is accompanied by one of these chips. That
 * is not decoration: an installment derived from a "starting from" marketing
 * rate looks identical to one derived from a contractual rate unless the screen
 * says otherwise, and the difference is what separates an estimate a rep can
 * stand behind from one that will embarrass them in front of a customer.
 */
import { AlertTriangle, CheckCircle2, Clock, HelpCircle, Info, XCircle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  CONFIDENCE_LABEL,
  RATE_BASIS_LABEL,
  RESULT_STATUS_LABEL,
  STATUS_TONE,
} from '@/lib/financing/client';
import type { Confidence, RateBasis, ResultStatus } from '@/lib/financing/types';

const TONE_CLASS: Record<'good' | 'warn' | 'neutral' | 'bad', string> = {
  good: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warn: 'bg-amber-50 text-amber-700 border-amber-200',
  neutral: 'bg-charcoal/5 text-charcoal/70 border-charcoal/15',
  bad: 'bg-red-50 text-red-700 border-red-200',
};

const TONE_ICON: Record<'good' | 'warn' | 'neutral' | 'bad', typeof CheckCircle2> = {
  good: CheckCircle2,
  warn: AlertTriangle,
  neutral: HelpCircle,
  bad: XCircle,
};

export function StatusChip({ status, className = '' }: { status: ResultStatus; className?: string }) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const tone = STATUS_TONE[status];
  const Icon = TONE_ICON[tone];
  const label = RESULT_STATUS_LABEL[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-bold ${TONE_CLASS[tone]} ${className}`}
    >
      <Icon size={13} />
      {isAr ? label.ar : label.en}
    </span>
  );
}

const CONFIDENCE_CLASS: Record<Confidence, string> = {
  high: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  low: 'bg-orange-50 text-orange-700 border-orange-200',
  unavailable: 'bg-charcoal/5 text-charcoal/60 border-charcoal/15',
};

export function ConfidenceChip({ confidence }: { confidence: Confidence }) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const label = CONFIDENCE_LABEL[confidence];
  return (
    <span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-bold ${CONFIDENCE_CLASS[confidence]}`}>
      {isAr ? label.ar : label.en}
    </span>
  );
}

/**
 * The single most important chip in the feature. A `contractual` basis is the
 * only one that earns a plain presentation; everything else is explicitly
 * flagged as an approximation so nobody reads a derived figure as a quote.
 */
export function RateBasisChip({ basis }: { basis: RateBasis }) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const label = RATE_BASIS_LABEL[basis];
  const isExact = basis === 'contractual';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px] font-bold ${
        isExact ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-orange-50 text-orange-700 border-orange-200'
      }`}
      title={isAr ? label.ar : label.en}
    >
      {!isExact && <Info size={11} />}
      {isAr ? label.ar : label.en}
    </span>
  );
}

export function StaleChip({ ageDays }: { ageDays: number | null }) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  return (
    <span className="inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-700">
      <Clock size={11} />
      {isAr
        ? `بيانات قديمة${ageDays !== null ? ` (${ageDays} يومًا)` : ''}`
        : `Stale${ageDays !== null ? ` (${ageDays}d)` : ''}`}
    </span>
  );
}

/**
 * The standing disclaimer. Rendered on the results page AND on any customer
 * summary, because the one thing this system must never be mistaken for is a
 * bank decision.
 */
export function IndicativeDisclaimer({ ar, en }: { ar?: string; en?: string }) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const fallbackAr =
    'هذه نتيجة استرشادية وليست موافقة تمويلية. التمويل الفعلي يخضع لدراسة البنك وسجل سمة وتقييم العقار واعتماد المشروع والمستندات النهائية.';
  const fallbackEn =
    'This is an indicative estimate, not a financing approval. Actual financing is subject to the bank’s underwriting, SIMAH review, property valuation, project approval and final documentation.';
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-xs leading-relaxed text-amber-900">
      <div className="mb-1 flex items-center gap-2 font-bold">
        <AlertTriangle size={14} />
        {isAr ? 'تنبيه مهم' : 'Important'}
      </div>
      {isAr ? (ar ?? fallbackAr) : (en ?? fallbackEn)}
    </div>
  );
}
