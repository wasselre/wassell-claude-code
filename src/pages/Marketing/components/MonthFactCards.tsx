/**
 * The month's standing facts, as CARDS with the decision attached.
 *
 * Until 2026-09-20 every one of these was a sentence in a single stacked
 * `notice` block: capacity, the moved start, the stretch, the budget, the
 * short lead — six paragraphs of centred Arabic prose with the numbers buried
 * inside them. The operator's words were "they are big text, which I don't
 * understand", and, more sharply: "if they require a decision from me, there
 * should be some way to decide instead of just showing me a bunch of text."
 *
 * Two rules follow from that and this file exists to hold them:
 *
 *   1. ONE FACT PER CARD, and the number is the card — label, figure, one
 *      short line underneath. Nothing here is a paragraph.
 *   2. A CARD THAT IMPLIES A DECISION CARRIES ITS CONTROL. The budget card had
 *      been telling the operator to «raise it» and «lower it yourself» in two
 *      adjacent sentences with nowhere to do either.
 *
 * Reuses the workspace's own `.stat` shape (`mos.css`) rather than inventing a
 * card: label `.k`, figure `.v`, detail `.d`, optional `.meter`. RTL comes from
 * the logical properties the sheet already uses — nothing here is side-aware.
 */
import { useState } from 'react';
import type { MosMonthDemandLine } from '@/lib/marketingOS/client';
import { num, pct, money } from '../lib/format';

export type FactTone = 'ok' | 'warn' | 'bad';

export interface MonthFact {
  id: string;
  label: string;
  /** The figure. Already formatted — this component never formats a domain value. */
  value: string;
  detail: string;
  tone?: FactTone;
  /** 0..1. Draws the thin bar under the figure. */
  fill?: number | null;
  /** Rendered under the detail: the control that acts on this card's decision. */
  action?: React.ReactNode;
}

const toneClass = (t: FactTone | undefined): string => (t === 'bad' ? 'bad' : t === 'warn' ? 'warn' : '');

/** The grid. Four across on a wide screen, and the sheet collapses it. */
export function MonthFactCards({ facts }: { facts: MonthFact[] }): JSX.Element | null {
  if (facts.length === 0) return null;
  return (
    <div className="grid g4" style={{ marginBlockEnd: 14 }}>
      {facts.map((f) => (
        <div key={f.id} className={`stat mth-fact ${toneClass(f.tone)}`.trim()}>
          <div className="k">{f.label}</div>
          <div className="v">{f.value}</div>
          {f.fill !== null && f.fill !== undefined && (
            <div className="meter" aria-hidden="true">
              <span
                className={`fl ${toneClass(f.tone)}`.trim()}
                style={{ width: `${Math.max(0, Math.min(1, f.fill)) * 100}%` }}
              />
            </div>
          )}
          <div className="d">{f.detail}</div>
          {f.action && <div className="mth-fact-act">{f.action}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * A number the operator changes by picking, not by typing.
 *
 * Presets rather than a free field: every decision on this page has a small set
 * of sensible answers (a budget of one month or two; a batch of one to five),
 * and a text box invites a typo that a plan then quietly reshapes around. The
 * current value is shown as selected, so the control also reports the state.
 */
export function PickOne({
  options, value, onPick, busy, disabled,
}: {
  options: Array<{ v: number; label: string }>;
  value: number;
  onPick: (v: number) => void;
  busy?: boolean;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="mth-pick" role="group">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          className={`btn btn-sm${o.v === value ? ' on' : ''}`}
          disabled={busy || disabled || o.v === value}
          onClick={() => onPick(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The capacity card for one role, in the DISPATCHER's units.
 *
 * `required` counts every requested unit whether or not the planner placed it —
 * the per-person load lines cannot report that, because they are summed from
 * bookings and unplaced work books nothing. That is the whole reason this card
 * exists, so the figure it leads with is utilisation of the real demand.
 */
export function demandFact(d: MosMonthDemandLine, isAr: boolean): MonthFact {
  const label = d.capacityKey === 'design'
    ? (isAr ? 'التصميم' : 'Design')
    : (isAr ? 'الكتابة' : 'Writing');
  const over = d.over || d.unscheduled > 0;
  return {
    id: `demand:${d.capacityKey}`,
    label,
    // `pct` takes an ALREADY-percentage number and only rounds it. Dividing by
    // 100 first rendered 83.3% as «١٪» and 41.7% as «٠٪» on the live page.
    value: d.utilisationPct === null ? '—' : pct(d.utilisationPct, isAr),
    fill: d.capacity > 0 ? d.required / d.capacity : null,
    tone: over ? 'bad' : d.utilisationPct !== null && d.utilisationPct >= 90 ? 'warn' : 'ok',
    detail: isAr
      ? `${num(d.required, true)} من ${num(d.capacity, true)} وحدة · ${num(d.unitsPerDay, true)} يوميًا على ${num(d.workingDays, true)} يوم عمل`
      : `${num(d.required, false)} of ${num(d.capacity, false)} units · ${num(d.unitsPerDay, false)}/day over ${num(d.workingDays, false)} working days`,
  };
}

/** «٦٠ بلا خطة» — the card that must never be a sentence buried in a notice. */
export function unscheduledFact(count: number, days: string[], isAr: boolean): MonthFact {
  return {
    id: 'unscheduled',
    label: isAr ? 'بلا خطة إنتاج' : 'No production plan',
    value: num(count, isAr),
    tone: 'bad',
    detail: isAr
      ? `لا يُعتمد الشهر قبل معالجتها — المطلوب: ${days.join(' · ')}`
      : `the month cannot be confirmed until these are resolved — required by ${days.join(' · ')}`,
  };
}

/** Money, with the two answers that are ever right for a stretched month. */
export function budgetFact(
  opts: {
    perProject: number; budgetTotal: number; running: number; monthsCovered: number;
    isAr: boolean; canEdit: boolean; busy: boolean; onSet: (v: number) => void;
  },
): MonthFact {
  const { perProject, budgetTotal, running, monthsCovered, isAr, canEdit, busy, onSet } = opts;
  const full = perProject * monthsCovered;
  const stretched = monthsCovered > 1;
  return {
    id: 'budget',
    label: isAr ? 'الميزانية' : 'Budget',
    // `budgetTotal` comes from the compiler, which counts the projects that
    // actually GET ROWS — not the number chosen. Multiplying by the selection
    // here would promise 8,000 for four projects while three run, which is the
    // same defect the compiler's own comment records having already fixed once.
    value: money(budgetTotal, isAr),
    tone: stretched ? 'warn' : 'ok',
    detail: stretched
      ? (isAr
        ? `${money(perProject, true)} لكل مشروع — رقم شهري واحد على مدة ${num(monthsCovered, true)} أشهر`
        : `${money(perProject, false)} a project — one month's figure across ${num(monthsCovered, false)} months`)
      : (isAr
        ? `${money(perProject, true)} لكل مشروع × ${num(running, true)}`
        : `${money(perProject, false)} a project × ${num(running, false)}`),
    action: canEdit && stretched ? (
      <PickOne
        value={perProject}
        busy={busy}
        onPick={onSet}
        options={[
          { v: perProject, label: isAr ? 'شهر واحد' : 'One month' },
          { v: full, label: isAr ? `المدة كلها · ${money(full, true)}` : `Whole stretch · ${money(full, false)}` },
        ].filter((o, i, a) => i === 0 || o.v !== a[0]!.v)}
      />
    ) : undefined,
  };
}

/**
 * The first ad batch, sized.
 *
 * A batch with too few working days in front of it is a SMALLER batch — not a
 * late one and not an impossible month. This is where that gets decided, and
 * the template's own number is always among the choices so the override can be
 * removed as easily as it was made.
 */
export function batchSizeFact(
  opts: {
    batchDay: string; dayText: string; current: number; templateValue: number; projects: number;
    isAr: boolean; canEdit: boolean; busy: boolean; onSet: (v: number) => void;
  },
): MonthFact {
  const { dayText, current, templateValue, projects, isAr, canEdit, busy, onSet } = opts;
  const sized = current !== templateValue;
  const choices = Array.from(new Set([1, 2, 3, templateValue]))
    .filter((v) => v >= 1 && v <= templateValue)
    .sort((a, b) => a - b);
  return {
    id: 'batch-size',
    label: isAr ? 'أول دفعة إعلانية' : 'First ad batch',
    value: isAr ? `${num(current * projects, true)} تصميم` : `${num(current * projects, false)} designs`,
    tone: sized ? 'warn' : 'ok',
    detail: isAr
      ? `${dayText} · ${num(current, true)} لكل مشروع${sized ? ` — بدل ${num(templateValue, true)}` : ''}`
      : `${dayText} · ${num(current, false)} per project${sized ? ` — instead of ${num(templateValue, false)}` : ''}`,
    action: canEdit ? (
      <PickOne
        value={current}
        busy={busy}
        onPick={onSet}
        options={choices.map((v) => ({ v, label: num(v, isAr) }))}
      />
    ) : undefined,
  };
}

/** Hook for the two template writes, so the page keeps one busy flag. */
export function useFactBusy(): [string | null, (id: string | null) => void] {
  const [busy, setBusy] = useState<string | null>(null);
  return [busy, setBusy];
}
