import { KeyRound, HardHat, HelpCircle } from 'lucide-react';
import {
  resolveDeliveryStatus, deliveryLabel, formatHandoverMonth, type DeliveryKind,
} from '@/lib/matching/deliveryStatus';

/**
 * Delivery readiness pill — "جاهز / Ready" vs "على الخارطة / Off-plan", and for
 * off-plan the expected handover month. Derived ONLY from the project's existing
 * `construction_status` / `project_status` / `handover_date` facts (see
 * `src/lib/matching/deliveryStatus.ts`); it never guesses "Ready".
 *
 * Shared by the Project Finder card AND the saved Client-Options card (both hold
 * the same finder `facts` snapshot), so the two surfaces read identically.
 *
 * Unknown readiness renders a neutral self-labelled chip on catalog projects (a
 * real data-quality signal the rep should see) but NOTHING on market listings,
 * where a resale ad simply has no construction stage — pass `isMarketListing`.
 */
export default function DeliveryPill({
  facts, isMarketListing, isAr,
}: {
  facts: Record<string, unknown>;
  isMarketListing: boolean;
  isAr: boolean;
}) {
  const { kind, handoverDate } = resolveDeliveryStatus(facts);
  if (kind === 'unknown' && isMarketListing) return null;
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const handover = kind === 'off_plan' ? formatHandoverMonth(handoverDate, isAr) : null;
  const cls: Record<DeliveryKind, string> = {
    ready: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    off_plan: 'border-copper/40 bg-copper/10 text-terracotta',
    unknown: 'border-sand/60 bg-cream/50 text-charcoal/50',
  };
  const Icon = kind === 'ready' ? KeyRound : kind === 'off_plan' ? HardHat : HelpCircle;
  const title = kind === 'off_plan' && handoverDate
    ? L(`تاريخ التسليم المتوقع: ${handoverDate}`, `Expected handover date: ${handoverDate}`)
    : L('حالة التسليم', 'Delivery status');
  // Always SELF-LABELED — a bare "غير محدد" reads as a contextless "undetermined
  // what?" to the rep. Unknown → "حالة التسليم غير محددة"; off-plan with no date →
  // "موعد التسليم يُحدَّد لاحقًا" (normal for a project still under construction).
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${cls[kind]}`}
      title={title}
    >
      <Icon size={11} className="shrink-0" />
      {kind === 'unknown' ? L('حالة التسليم غير محددة', 'Delivery status unknown') : deliveryLabel(kind, isAr)}
      {kind === 'off_plan' && (
        <span className="font-semibold">
          {handover
            ? L(`· التسليم ${handover}`, `· handover ${handover}`)
            : L('· موعد التسليم يُحدَّد لاحقًا', '· handover date TBD')}
        </span>
      )}
    </span>
  );
}
