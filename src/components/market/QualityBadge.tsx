/**
 * QualityBadge — colored A–D listing-quality chip for a market listing.
 *
 * Renders the DB-computed `quality_grade` (+ optional numeric `quality_score`)
 * that the records trigger maintains on every market_listings row (see the
 * market-listings quality migration). Colors/labels mirror the quality_grade
 * dropdown options in the model schema, so the chip looks identical to the
 * record-list column. Renders nothing when the grade is absent/unknown —
 * callers can pass raw `facts` values without guarding.
 */

const GRADE_META: Record<string, { ar: string; en: string; color: string }> = {
  A: { ar: 'ممتاز', en: 'Excellent', color: '#B8734F' },
  B: { ar: 'جيد', en: 'Good', color: '#C09B5F' },
  C: { ar: 'متوسط', en: 'Fair', color: '#8E4E3A' },
  D: { ar: 'ضعيف', en: 'Poor', color: '#4A4E54' },
};

interface Props {
  grade: unknown;
  score?: unknown;
  isAr: boolean;
}

export default function QualityBadge({ grade, score, isAr }: Props) {
  const g = typeof grade === 'string' ? grade.trim().toUpperCase() : '';
  const meta = GRADE_META[g];
  if (!meta) return null;
  const s = typeof score === 'number' && Number.isFinite(score) ? Math.round(score) : null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold"
      style={{ color: meta.color, borderColor: `${meta.color}55`, backgroundColor: `${meta.color}12` }}
      title={isAr
        ? 'جودة الإعلان — تُحسب تلقائياً من اكتمال البيانات والوسائط والوصف والموثوقية والحداثة'
        : 'Listing quality — auto-computed from completeness, media, description, trust, and freshness'}
    >
      {isAr ? meta.ar : meta.en} ({g}){s != null ? ` · ${s}` : ''}
    </span>
  );
}
