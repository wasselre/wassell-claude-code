/**
 * WarningsPanel — every caveat the package carries, in one place: the base
 * warnings (validation issues that survived the AI's self-repair — these BLOCK
 * Apply), the missing-facts list, and per-derivative warnings (advisory limit
 * notes). Loud by design: a hidden warning is how a wrong number ships.
 */
import type { CreativeDerivativeRow } from '@/lib/creative/contracts';
import { PLACEMENT_LABELS, platformLabel, pick } from './labels';

export default function WarningsPanel({
  warnings, missing, derivatives, isAr,
}: {
  warnings: string[];
  missing: string[];
  derivatives: CreativeDerivativeRow[];
  isAr: boolean;
}) {
  const derivativeNotes = derivatives.flatMap((d) =>
    d.warnings.map((w) => ({
      target: `${platformLabel(d.platform, isAr)} · ${pick(PLACEMENT_LABELS, d.placement_type, isAr)}`,
      warning: w,
    })),
  );

  if (warnings.length === 0 && missing.length === 0 && derivativeNotes.length === 0) return null;

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {warnings.length > 0 && (
        <div className="notice bad">
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            {isAr ? 'تحذيرات مانعة — عالجها قبل التطبيق' : 'Blocking warnings — resolve before applying'}
          </div>
          {warnings.map((w, i) => <div key={i} style={{ fontSize: 12.5, lineHeight: 1.8 }}>{w}</div>)}
        </div>
      )}
      {missing.length > 0 && (
        <div className="notice">
          <b>{isAr ? 'حقائق ناقصة: ' : 'Missing facts: '}</b>
          {missing.join(isAr ? '، ' : ', ')}
        </div>
      )}
      {derivativeNotes.length > 0 && (
        <div className="notice">
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            {isAr ? 'ملاحظات المشتقات' : 'Derivative notes'}
          </div>
          {derivativeNotes.map((n, i) => (
            <div key={i} style={{ fontSize: 12.5, lineHeight: 1.8 }}>
              <b>{n.target}:</b> {n.warning}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
