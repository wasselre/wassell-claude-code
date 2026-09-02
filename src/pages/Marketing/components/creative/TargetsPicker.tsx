/**
 * TargetsPicker — step zero of the Creative Director: WHERE will this post run?
 *
 * The server resolves the item's organic publications + paid placements into
 * concrete targets (creative_targets); the writer confirms the selection and
 * the intended use. `intended_use` is authored HERE, on the package — never
 * derived from placement rows later (contracts §0.6). Dimensions come from
 * PLACEMENT_SPECS per target, shown up front so the geometry is a fact, not a
 * surprise after generation.
 */
import { useMemo, useState } from 'react';
import type { DerivativeTarget, IntendedUse, PlacementType } from '@/lib/creative/contracts';
import { placementSpec } from '@/lib/marketingOS/platformRules';
import type { CreativeTargetsResult } from '@/lib/marketingOS/creativeClient';
import { Field } from '../kit';
import { INTENDED_USE_LABELS, PLACEMENT_LABELS, platformLabel, pick } from './labels';

export default function TargetsPicker({
  targets, defaultUse, busy, isAr, onStart,
}: {
  targets: CreativeTargetsResult;
  defaultUse: IntendedUse;
  busy: boolean;
  isAr: boolean;
  onStart: (selection: DerivativeTarget[], intendedUse: IntendedUse, recipe: string | null) => void;
}) {
  // Pre-check whatever the server already marked selected (existing placements).
  const [organicSel, setOrganicSel] = useState<Set<number>>(
    () => new Set(targets.organic.map((t, i) => (t.selected ? i : -1)).filter((i) => i >= 0)),
  );
  const [paidSel, setPaidSel] = useState<Set<number>>(
    () => new Set(targets.paid.map((t, i) => (t.selected ? i : -1)).filter((i) => i >= 0)),
  );
  const [use, setUse] = useState<IntendedUse>(defaultUse);
  const [recipe, setRecipe] = useState('');

  const toggle = (set_: Set<number>, setter: (s: Set<number>) => void, i: number): void => {
    const next = new Set(set_);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setter(next);
  };

  const selection = useMemo<DerivativeTarget[]>(() => {
    const out: DerivativeTarget[] = [];
    targets.organic.forEach((t, i) => {
      if (!organicSel.has(i)) return;
      out.push({
        target_kind: 'organic',
        platform: t.platform,
        placement_type: t.placement_type as PlacementType,
        target_ref: t.publication_id ? { publication_id: t.publication_id } : {},
      });
    });
    targets.paid.forEach((t, i) => {
      if (!paidSel.has(i)) return;
      out.push({
        target_kind: 'paid',
        platform: t.platform,
        placement_type: t.placement_type as PlacementType,
        target_ref: {
          execution_id: t.execution_id,
          ...(t.ad_set_id ? { ad_set_id: t.ad_set_id } : {}),
          ...(t.ad_id ? { ad_id: t.ad_id } : {}),
        },
      });
    });
    return out;
  }, [targets, organicSel, paidSel]);

  const dimsOf = (platform: string, type: string): string => {
    const spec = placementSpec(platform, type);
    if (!spec) return '';
    const aspect = spec.aspects[0] ?? '';
    const px = spec.px[aspect];
    return px ? `${aspect} · ${px[0]}×${px[1]}` : aspect;
  };

  const nothingSelected = selection.length === 0;

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'أين سيُنشر هذا البوست؟' : 'Where will this post run?'}</h4>
        <span className="r">
          {isAr
            ? `المقاس الرئيسي المقترح: ${targets.suggested_master_aspect}`
            : `Suggested master aspect: ${targets.suggested_master_aspect}`}
        </span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 14 }}>
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="lbl">{isAr ? 'أهداف عضوية' : 'Organic targets'}</div>
          {targets.organic.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--mute)' }}>
              {isAr ? 'لا أهداف عضوية — أضف منصة من تبويب «أماكن النشر» أولًا.' : 'No organic targets — add a platform in the Placements tab first.'}
            </div>
          )}
          {targets.organic.map((t, i) => (
            <label key={`o-${i}`} className={`opt${organicSel.has(i) ? ' pick' : ''}`} style={{ cursor: 'pointer', marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={organicSel.has(i)}
                onChange={() => toggle(organicSel, setOrganicSel, i)}
                style={{ marginTop: 5 }}
              />
              <span className="tx">
                <b>{platformLabel(t.platform, isAr)}</b>{' · '}{pick(PLACEMENT_LABELS, t.placement_type, isAr)}
                <span className="mt ltr" style={{ display: 'block' }}>{dimsOf(t.platform, t.placement_type)}</span>
              </span>
            </label>
          ))}
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          <div className="lbl">{isAr ? 'أهداف مدفوعة' : 'Paid targets'}</div>
          {targets.paid.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--mute)' }}>
              {isAr ? 'لا أماكن مدفوعة مرتبطة بهذا المحتوى.' : 'No paid placements linked to this creative.'}
            </div>
          )}
          {targets.paid.map((t, i) => (
            <label key={`p-${i}`} className={`opt${paidSel.has(i) ? ' pick' : ''}`} style={{ cursor: 'pointer', marginBottom: 0 }}>
              <input
                type="checkbox"
                checked={paidSel.has(i)}
                onChange={() => toggle(paidSel, setPaidSel, i)}
                style={{ marginTop: 5 }}
              />
              <span className="tx">
                <b>{platformLabel(t.platform, isAr)}</b>{' · '}{pick(PLACEMENT_LABELS, t.placement_type, isAr)}
                <span className="mt ltr" style={{ display: 'block' }}>{dimsOf(t.platform, t.placement_type)}</span>
              </span>
            </label>
          ))}
        </div>

        <Field
          label={isAr ? 'الغرض المقصود' : 'Intended use'}
          hint={isAr ? 'يُؤلَّف هنا ولا يُستنتج من أماكن النشر لاحقًا' : 'Authored here — never derived from placements later'}
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['organic', 'paid', 'both'] as IntendedUse[]).map((u) => (
              <button
                key={u}
                type="button"
                className={`fbtn${use === u ? ' on' : ''}`}
                onClick={() => setUse(u)}
              >
                {pick(INTENDED_USE_LABELS, u, isAr)}
              </button>
            ))}
          </div>
        </Field>

        <Field
          label={isAr ? 'توجيه إضافي (اختياري)' : 'Extra direction (optional)'}
          hint={isAr ? 'مثال: ركّز على خطة السداد، نبرة هادئة' : 'e.g. focus the payment plan, calm tone'}
        >
          <input
            className="inp"
            value={recipe}
            onChange={(e) => setRecipe(e.target.value)}
            placeholder={isAr ? 'وصف قصير يوجّه التوليد…' : 'A short steer for the generation…'}
          />
        </Field>

        <div>
          <button
            type="button"
            className="btn btn-p"
            disabled={busy || nothingSelected}
            onClick={() => onStart(selection, use, recipe.trim() || null)}
          >
            {busy
              ? (isAr ? 'يبدأ…' : 'Starting…')
              : (isAr ? 'اقترح الأفكار' : 'Suggest concepts')}
          </button>
          {nothingSelected && (
            <span style={{ fontSize: 11.5, color: 'var(--mute)', marginInlineStart: 10 }}>
              {isAr ? 'اختر هدفًا واحدًا على الأقل.' : 'Pick at least one target.'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
