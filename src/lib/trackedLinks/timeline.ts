/**
 * Interest timeline — PURE shaping of the rows returned by the SQL function
 * `tracked_interest_timeline` (which does the scoring). Nothing here computes
 * points: it only folds the raw event stream into readable steps and SUMS the
 * points SQL already assigned, so the steps always add up to the project score.
 *
 * Folding rule: within one stay on a tab (same visit + same section, until the
 * next `view`), the 15-second time beats fold INTO the "opened <tab>" step as
 * its seconds (one line per stay, not two), photos enlarged become one
 * "enlarged N photos" step, brochure pages one "reached page N" step, and a
 * video's progress ticks one "watched N%" step.
 */
import type { InterestTimelineEvent } from '@/types';

export type TimelineStepKind =
  | 'sent' | 'view' | 'time' | 'photo_open' | 'video_play' | 'video_progress'
  | 'brochure_page' | 'unit_open' | 'units_filter' | 'map_open';

export interface TimelineStep {
  at: string;
  kind: TimelineStepKind;
  section: string | null;
  focus: InterestTimelineEvent['focus'];
  sentVia: string;
  /** Folded events in this step (photos enlarged, pages reached…). */
  count: number;
  /** view / time: seconds on the tab · video_progress: highest % · brochure_page: highest page. */
  value: number;
  /** unit_open / sent(unit): the unit · units_filter: the filter string. */
  item: string | null;
  unitLabel: string | null;
  /** Points this step added to the project score (after caps). */
  points: number;
  /** Project score right after this step. */
  running: number;
}

const FOLDABLE = new Set(['time', 'photo_open', 'brochure_page', 'video_progress']);

export function foldTimeline(events: InterestTimelineEvent[]): TimelineStep[] {
  const steps: TimelineStep[] = [];
  // "<session>|<section>|<kind>[|<item>]" → index of the open step for this stay.
  const open = new Map<string, number>();

  for (const e of events) {
    const kind = e.kind as TimelineStepKind;
    const session = e.session_id ?? '';
    if (kind === 'view') {
      // A new stay on this tab: later beats start fresh steps.
      for (const k of [...open.keys()]) if (k.startsWith(`${session}|${e.section ?? ''}|`)) open.delete(k);
    }
    const stay = `${session}|${e.section ?? ''}|`;
    // A time beat belongs to the "opened <tab>" step of the same stay.
    const foldKey = kind === 'time'
      ? (open.has(`${stay}view`) ? `${stay}view` : `${stay}time`)
      : FOLDABLE.has(kind) ? `${stay}${kind}${kind === 'video_progress' ? `|${e.item ?? ''}` : ''}` : null;
    const idx = foldKey !== null ? open.get(foldKey) : undefined;
    if (idx !== undefined) {
      const s = steps[idx]!;
      s.count += 1;
      s.points += e.points;
      s.running = e.running;
      const v = Number(e.value) || 0;
      if (kind === 'time') s.value += v;
      else if (kind === 'video_progress') s.value = Math.max(s.value, v);
      else if (kind === 'brochure_page') s.value = Math.max(s.value, Number(e.item) || 0);
      continue;
    }
    steps.push({
      at: e.at,
      kind,
      section: e.section,
      focus: e.focus,
      sentVia: e.sent_via,
      count: 1,
      value: kind === 'brochure_page' ? Number(e.item) || 0 : kind === 'view' ? 0 : Number(e.value) || 0,
      item: e.item,
      unitLabel: e.unit_label ?? null,
      points: e.points,
      running: e.running,
    });
    if (foldKey !== null) open.set(foldKey, steps.length - 1);
    if (kind === 'view') open.set(`${stay}view`, steps.length - 1);
  }
  // A folded step's `running` is the score after its LAST beat, which can be
  // later than steps pushed after it. Recompute a monotone running total in
  // display order so each row reads "score so far".
  let total = 0;
  for (const s of steps) { total += s.points; s.running = total; }
  return steps;
}
