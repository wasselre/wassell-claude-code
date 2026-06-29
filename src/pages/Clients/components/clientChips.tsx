import { Star } from 'lucide-react';
import { lifecycleHealthDisplay, nextActionTypeLabel, type Tone, toneColor } from '../lib/lifecycleDisplay';
import type { LifecycleHealth } from '../lib/clientView';

/** A compact brand-styled chip. Background renders at ~14% alpha of the color. */
export function Chip({ label, color, className = '' }: { label: string; color: string; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold leading-5 ${className}`}
      style={{ backgroundColor: `${color}24`, color }}
    >
      {label}
    </span>
  );
}

export function ToneChip({ label, tone, className }: { label: string; tone: Tone; className?: string }) {
  return <Chip label={label} color={toneColor(tone)} className={className} />;
}

/** Lifecycle-health badge — the primary at-a-glance status pill. */
export function HealthBadge({ value, isAr, className }: { value: LifecycleHealth | string | null | undefined; isAr: boolean; className?: string }) {
  const s = lifecycleHealthDisplay(value);
  return <Chip label={isAr ? s.label_ar : s.label_en} color={s.color} className={className} />;
}

/** Stage / status chip — neutral charcoal so it doesn't compete with health. */
export function MetaChip({ label }: { label: string | null | undefined }) {
  if (!label) return null;
  return <Chip label={label} color="#4A4E54" />;
}

/** Next-action-type chip in copper. */
export function NextActionChip({ value, isAr }: { value: string | null | undefined; isAr: boolean }) {
  const label = nextActionTypeLabel(value, isAr);
  if (!label) return null;
  return <Chip label={label} color="#B8734F" />;
}

/** 1–5 visit rating as stars; renders nothing when unrated. */
export function VisitRatingStars({ rating, size = 14 }: { rating: number | null | undefined; size?: number }) {
  if (typeof rating !== 'number' || rating <= 0) return null;
  const full = Math.round(rating);
  const tone = rating <= 2 ? '#B5462F' : rating >= 4 ? '#3F7D54' : '#C09B5F';
  return (
    <span className="inline-flex items-center gap-0.5" title={`${rating}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} size={size} fill={i <= full ? tone : 'none'} color={tone} strokeWidth={1.5} />
      ))}
    </span>
  );
}

/** A small "—" placeholder for missing values, consistent across the cockpit. */
export function Dash() {
  return <span className="text-charcoal/30">—</span>;
}
