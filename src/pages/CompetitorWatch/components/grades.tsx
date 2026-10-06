/** Marketing grades on a company (2026-10-06).
 *
 *  Set on the CRM Companies record («تقييم التسويق» section) and copied onto the
 *  watch entry by the database; Competitor Watch only shows them. Two grades on
 *  purpose — what we learn from a company's WRITING and from its VISUALS are
 *  separate judgements. A visual reference (org_type 'visual_reference') is a
 *  non-competitor we collect for its design only: its writing is never learned
 *  from, so it has no writing grade.
 */
import type { MarketingGrade } from '@/lib/competitorWatch/client';

const GRADE: Record<MarketingGrade, { ar: string; en: string; tone: string }> = {
  a: { ar: 'أ', en: 'A', tone: 'ok' },
  b: { ar: 'ب', en: 'B', tone: 'info' },
  c: { ar: 'ج', en: 'C', tone: 'warn' },
  skip: { ar: 'لا نتعلم منه', en: "Don't learn", tone: 'mute' },
};

export const GRADE_LONG: Record<MarketingGrade, { ar: string; en: string }> = {
  a: { ar: 'أ — ممتاز، نتعلم منه', en: 'A — Excellent, learn from it' },
  b: { ar: 'ب — جيد', en: 'B — Good' },
  c: { ar: 'ج — ضعيف', en: 'C — Weak' },
  skip: { ar: 'لا نتعلم منه', en: "Don't learn from it" },
};

/** «كتابة: أ» / «Visual: B»; «لم يُقيَّم» when empty. */
export function GradeBadge({ kind, grade, isAr }: { kind: 'writing' | 'visual'; grade: MarketingGrade | null; isAr: boolean }) {
  const k = kind === 'writing' ? (isAr ? 'كتابة' : 'Writing') : (isAr ? 'تصميم' : 'Visual');
  if (!grade) return <span className="cw-tag mute" title={isAr ? 'لم يُقيَّم بعد' : 'Not graded yet'}>{k}: —</span>;
  const g = GRADE[grade];
  return <span className={`cw-tag ${g.tone}`} title={isAr ? GRADE_LONG[grade].ar : GRADE_LONG[grade].en}>{k}: {isAr ? g.ar : g.en}</span>;
}

/** Both grades for one company; a visual reference shows only its visual grade. */
export function CompanyGrades({ visualOnly, writing, visual, isAr }: { visualOnly: boolean; writing: MarketingGrade | null; visual: MarketingGrade | null; isAr: boolean }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {!visualOnly && <GradeBadge kind="writing" grade={writing} isAr={isAr} />}
      <GradeBadge kind="visual" grade={visual} isAr={isAr} />
    </span>
  );
}
