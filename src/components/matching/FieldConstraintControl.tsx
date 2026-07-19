import { useState } from 'react';
import { Lock, Unlock, ChevronDown } from 'lucide-react';
import {
  resolveConstraint, isNonDefault, BANDED_FIELDS, TOLERANCE_PRESETS, MODE_LABELS, MAX_TOLERANCE_PCT,
  type ConstraintField, type ConstraintMode, type RequirementConstraints,
} from '@/lib/matching/constraints';

/**
 * The per-field strictness control rendered under each finder preference picker.
 *
 * Two decisions, one row:
 *   - MODE — «إلزامي» (hard: excludes anything outside the band) vs «مفضّل»
 *     (soft: influences ranking only). This is the fix for the class of bug where
 *     a stated requirement couldn't exclude anything: a 125 m² villa scored 89%
 *     against a 500–750 m² request because area was worth only 10 of ~90 points.
 *   - BAND — for numeric fields, how far outside the stated range still counts
 *     (±%, presets plus a free input). The band widens INCLUSION only; ranking
 *     still prefers exact fits, so a tolerated near-miss sits below a true match.
 *
 * Deliberately shows the drop count when the engine reports one: a required field
 * that silently removed 800 candidates is exactly the thing a rep needs to see
 * before concluding "there's nothing available".
 */
export default function FieldConstraintControl({
  field, constraints, onChange, isAr, droppedCount,
}: {
  field: ConstraintField;
  constraints: RequirementConstraints;
  onChange: (next: RequirementConstraints) => void;
  isAr: boolean;
  /** How many candidates this field excluded on the last search (if any). */
  droppedCount?: number;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const eff = resolveConstraint(field, constraints);
  const banded = BANDED_FIELDS.includes(field);
  const modified = isNonDefault(field, constraints);
  const [openBand, setOpenBand] = useState(false);

  const patch = (next: { mode?: ConstraintMode; tolerance_pct?: number }) => {
    onChange({ ...constraints, [field]: { ...eff, ...next } });
  };

  const pctLabel = `±${Math.round(eff.tolerance_pct * 100)}%`;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
      {/* Mode toggle — the whole point of the control, so it reads as a switch. */}
      <div className="inline-flex overflow-hidden rounded-md border border-sand/60">
        {(['hard', 'soft'] as ConstraintMode[]).map((m) => {
          const active = eff.mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => patch({ mode: m })}
              title={isAr ? MODE_LABELS[m].hint_ar : MODE_LABELS[m].hint_en}
              aria-pressed={active}
              className={`inline-flex items-center gap-1 px-2 py-0.5 font-bold transition ${
                active
                  ? m === 'hard'
                    ? 'bg-copper text-white'
                    : 'bg-sand/50 text-charcoal/80'
                  : 'bg-white text-charcoal/45 hover:bg-cream/60'
              }`}
            >
              {m === 'hard' ? <Lock size={10} /> : <Unlock size={10} />}
              {isAr ? MODE_LABELS[m].ar : MODE_LABELS[m].en}
            </button>
          );
        })}
      </div>

      {/* Tolerance band — only meaningful for numeric fields, and only when the
          field can actually exclude something (soft mode never excludes). */}
      {banded && eff.mode === 'hard' && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpenBand((v) => !v)}
            aria-expanded={openBand}
            className="inline-flex items-center gap-1 rounded-md border border-sand/60 bg-white px-2 py-0.5 font-semibold text-charcoal/70 transition hover:bg-cream/60"
            title={L('نطاق التسامح حول القيمة المطلوبة', 'Tolerance band around the requested value')}
          >
            {pctLabel}
            <ChevronDown size={10} className={openBand ? 'rotate-180 transition' : 'transition'} />
          </button>
          {openBand && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setOpenBand(false)} aria-hidden />
              <div className="absolute z-20 mt-1 w-40 rounded-lg border border-sand/60 bg-white p-1.5 shadow-lg">
                <div className="flex flex-wrap gap-1">
                  {TOLERANCE_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => { patch({ tolerance_pct: p.value }); setOpenBand(false); }}
                      className={`rounded px-1.5 py-0.5 font-semibold transition ${
                        Math.abs(eff.tolerance_pct - p.value) < 1e-9
                          ? 'bg-copper text-white'
                          : 'bg-cream/70 text-charcoal/70 hover:bg-sand/40'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <label className="mt-1.5 flex items-center gap-1 text-[10px] text-charcoal/60">
                  {L('مخصص', 'Custom')}
                  <input
                    type="number"
                    min={0}
                    max={Math.round(MAX_TOLERANCE_PCT * 100)}
                    value={Math.round(eff.tolerance_pct * 100)}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) {
                        patch({ tolerance_pct: Math.min(Math.max(v, 0), MAX_TOLERANCE_PCT * 100) / 100 });
                      }
                    }}
                    className="w-14 rounded border border-sand/60 px-1 py-0.5 text-[11px]"
                  />
                  %
                </label>
              </div>
            </>
          )}
        </div>
      )}

      {modified && (
        <span className="rounded-full bg-gold/20 px-1.5 font-semibold text-[10px] text-charcoal/60">
          {L('معدّل', 'edited')}
        </span>
      )}

      {/* Honest feedback: this field removed N candidates from the last search. */}
      {droppedCount != null && droppedCount > 0 && (
        <span
          className="text-[10px] font-semibold text-amber-700"
          title={L('خيارات استُبعدت بسبب هذا الشرط (بما فيها التي لا تحمل بيانات لهذا الحقل)',
                   'Candidates excluded by this constraint (including those with no data for the field)')}
        >
          {L(`استبعد ${droppedCount}`, `excluded ${droppedCount}`)}
        </span>
      )}
    </div>
  );
}
