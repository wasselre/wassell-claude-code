/**
 * «الأسابيع» — the month's grid, in two panes (mockup `s-month.html` + edit E1).
 *
 * THE SWITCH IS THE POINT. October is 48 organic posts AND 60 paid creatives,
 * and before edit E1 every note channel on this grid was organic: the day cells
 * carried a pencil, the project columns carried a pencil, and the paid batch —
 * the half that spends the 6,000 riyals — carried none. So the grid has two
 * panes now: «العضوي» is four days a week of three posts, «المدفوع» is three
 * cells a week (one per project) of five creatives, and BOTH have their own
 * cell notes and their own project-column notes.
 *
 * THE TWO LANES DO NOT SHARE A COLUMN NOTE (decision D7). «تجنّبوا لغة الاستثمار»
 * written on أكنان's organic column reaches its rows and NOT its twenty ads;
 * the paid column note is a separate row in `mos_month_notes` with `lane='paid'`.
 * The month note — `lane IS NULL` — is the only one that reaches both, which is
 * why it sits ABOVE the switch rather than inside a pane.
 *
 * ONE COORDINATE HAS NO PENCIL, ON PURPOSE: the Saturday «عام» column. A
 * project-column note is keyed to a project id and the general row has none
 * (A8b — the general row belongs to no project). §3.7 already says what steers
 * that row: «ملاحظة الخلية هي موضوع اليوم», with the month note above it and the
 * settings topic bank as the fallback for a cell left blank. A pencil that
 * cannot store what it collects is worse than no pencil.
 */
import { useMemo, useState } from 'react';
import type { MosMonthGridWeek, MosMonthNote } from '@/lib/marketingOS/client';
import type { NoteCoord } from './MonthNoteModal';
import { num, dayLabel, shortDate } from '../lib/format';

export type MonthLane = 'organic' | 'paid';

/** What a day looks like in the REPORT tense — real publications, never a guess. */
export interface DayReleaseState {
  planned: number;
  published: number;
  failed: number;
}

const PIP_CLASS = ['p-a', 'p-b', 'p-c'];
const pipClass = (slot: number | null): string =>
  (slot === null ? 'p-g' : PIP_CLASS[slot] ?? 'p-a');

/** The note at a coordinate, or null. Kept tiny — the grid asks it a lot. */
function findNote(
  notes: MosMonthNote[],
  kind: MosMonthNote['kind'],
  lane: MonthLane | null,
  projectId: string | null,
  batchDate: string | null,
): MosMonthNote | null {
  return notes.find((n) => n.kind === kind
    && (n.lane ?? null) === lane
    && (n.project_id ?? null) === projectId
    && (n.batch_date ?? null) === batchDate) ?? null;
}

function Pencil({
  has, disabled, title, onClick,
}: {
  has: boolean; disabled: boolean; title: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`mth-pencil${has ? ' has' : ''}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      ✎
    </button>
  );
}

export default function MonthWeeksGrid({
  weeks, notes, isAr, canEdit, onOpenNote, projects, generalLabel, releaseState, footer,
  emptyWeekLabel,
}: {
  weeks: MosMonthGridWeek[];
  notes: MosMonthNote[];
  isAr: boolean;
  canEdit: boolean;
  onOpenNote: (coord: NoteCoord, body: string) => void;
  /** The month's projects in slot order — the column strip and the paid cells. */
  projects: Array<{ project_id: string; project_name: string | null; slot: number }>;
  generalLabel: string;
  /** Report tense only: day → what actually happened. Absent = plan tense. */
  releaseState?: Map<string, DayReleaseState>;
  footer?: React.ReactNode;
  /**
   * What an EMPTY week means, said by the caller.
   *
   * A month compiled part-way through has weeks with nothing left in them, and
   * a week card with no cells under it reads as a rendering fault rather than
   * as "this week has gone". The grid will not guess — in the report tense an
   * empty week means something else entirely — so the page that knows passes
   * the words in.
   */
  emptyWeekLabel?: string;
}) {
  const [lane, setLane] = useState<MonthLane>('organic');

  const laneNotes = useMemo(
    () => notes.filter((n) => n.lane === null || n.lane === lane),
    [notes, lane],
  );

  /**
   * A paid cell knows its project but not its SLOT, and the slot is what
   * carries the colour — أ copper, ب green, ج gold — so the same project reads
   * the same in both lanes. Without this the paid squares were all one copper,
   * a leftover from when the paid batch was a single summary strip at the end
   * of a week rather than one cell per project.
   */
  const slotOf = useMemo(() => {
    const bySlot = new Map(projects.map((p) => [p.project_id, p.slot]));
    return (projectId: string): number | null => bySlot.get(projectId) ?? null;
  }, [projects]);

  const monthNote = findNote(notes, 'month', null, null, null);

  const openNote = (coord: NoteCoord): void => {
    const existing = findNote(notes, coord.kind, coord.lane, coord.project_id, coord.batch_date);
    onOpenNote(coord, existing?.body ?? '');
  };

  const projectLabel = (id: string): string =>
    projects.find((p) => p.project_id === id)?.project_name ?? id.slice(0, 8);

  return (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'الأسابيع' : 'The weeks'}</h4>
        <div className="mth-row r" style={{ marginInlineStart: 'auto' }}>
          <span className="tag">
            {num(weeks.reduce((a, w) => a + w.days.length, 0), isAr)}{' '}
            {isAr ? 'صفًا' : 'rows'}
          </span>
          <span className="tag">
            {num(weeks.length, isAr)} {isAr ? 'دفعات إعلانية' : 'ad batches'}
          </span>
          <div className="seg">
            <button type="button" className={lane === 'organic' ? 'on' : ''}
              onClick={() => setLane('organic')}>
              {isAr ? 'العضوي' : 'Organic'}
            </button>
            <button type="button" className={lane === 'paid' ? 'on' : ''}
              onClick={() => setLane('paid')}>
              {isAr ? 'المدفوع' : 'Paid'}
            </button>
          </div>
          <button
            type="button"
            className={`btn btn-sm${monthNote ? ' btn-p' : ''}`}
            disabled={!canEdit}
            onClick={() => openNote({
              kind: 'month', lane: null, project_id: null, batch_date: null,
              label: isAr ? 'ملاحظة على الشهر — تصل العضوي والمدفوع معًا'
                : 'A note on the month — it reaches both organic and paid',
            })}
          >
            {isAr ? 'ملاحظة على الشهر' : 'Note on the month'}
          </button>
        </div>
      </div>

      <div className="card-b">
        {/* The column strip — per LANE, per D7. */}
        <div className="mth-notestrip">
          <span>{isAr ? 'ملاحظات الأعمدة:' : 'Column notes:'}</span>
          {projects.map((p) => {
            const n = findNote(notes, 'project', lane, p.project_id, null);
            return (
              <span className="one" key={`${lane}-${p.project_id}`}>
                <span className={`mth-pip ${pipClass(p.slot)}`}>
                  {isAr ? ['أ', 'ب', 'ج', 'د'][p.slot] ?? String(p.slot + 1) : String.fromCharCode(65 + p.slot)}
                </span>
                <span>{p.project_name ?? p.project_id.slice(0, 8)}</span>
                <Pencil
                  has={Boolean(n)}
                  disabled={!canEdit}
                  title={isAr
                    ? `ملاحظة على عمود ${p.project_name ?? ''} — ${lane === 'organic' ? 'العضوي' : 'المدفوع'} فقط`
                    : `Note on ${p.project_name ?? ''} — ${lane} only`}
                  onClick={() => openNote({
                    kind: 'project',
                    lane,
                    project_id: p.project_id,
                    batch_date: null,
                    label: isAr
                      ? `عمود ${p.project_name ?? ''} · ${lane === 'organic' ? 'الصفوف العضوية' : 'التصاميم المدفوعة'} — لا تصل اللين الآخر`
                      : `${p.project_name ?? ''} column · ${lane} only — it does not reach the other lane`,
                  })}
                />
              </span>
            );
          })}
          {lane === 'organic' && (
            <span className="one">
              <span className="mth-pip p-g">{isAr ? 'ع' : 'G'}</span>
              <span>{generalLabel}</span>
              <span className="mth-tiny">
                {isAr ? '— ملاحظة الخلية هي موضوع اليوم' : '— its cell note is the day’s topic'}
              </span>
            </span>
          )}
        </div>

        <div className="mth-weeks">
          {weeks.map((w) => (
            <div className="mth-week" key={w.index}>
              <div className="wk">
                {isAr ? `الأسبوع ${num(w.index + 1, isAr)}` : `Week ${num(w.index + 1, isAr)}`}
                <small>{shortDate(w.start, isAr)} — {shortDate(w.end, isAr)}</small>
              </div>

              {emptyWeekLabel && (lane === 'organic' ? w.days.length === 0 : w.paid.length === 0) && (
                <p className="mth-tiny" style={{ margin: '8px 2px 0' }}>{emptyWeekLabel}</p>
              )}

              {lane === 'organic' ? (
                <div className="mth-days">
                  {w.days.map((d) => {
                    const n = findNote(notes, 'row', 'organic', null, d.day);
                    const st = releaseState?.get(d.day);
                    return (
                      <div className="mth-day" key={d.rowKey}>
                        <div className="dh">
                          <span>{dayLabel(d.day, isAr)}</span>
                          <span className="nmx">
                            {d.projectName ?? (d.kind === 'general_row' ? generalLabel : '')}
                          </span>
                          <Pencil
                            has={Boolean(n)}
                            disabled={!canEdit}
                            title={isAr
                              ? (d.kind === 'general_row'
                                ? `موضوع ${dayLabel(d.day, isAr)}`
                                : `ملاحظة على صف ${dayLabel(d.day, isAr)}`)
                              : `Note on the ${dayLabel(d.day, isAr)} row`}
                            onClick={() => openNote({
                              kind: 'row',
                              lane: 'organic',
                              project_id: d.projectId,
                              batch_date: d.day,
                              label: isAr
                                ? (d.kind === 'general_row'
                                  ? `${dayLabel(d.day, isAr)} · ${generalLabel} — الملاحظة هي موضوع اليوم`
                                  : `صف ${dayLabel(d.day, isAr)} · ${d.projectName ?? ''}`)
                                : (d.kind === 'general_row'
                                  ? `${dayLabel(d.day, isAr)} · ${generalLabel} — the note is the day’s topic`
                                  : `${dayLabel(d.day, isAr)} row · ${d.projectName ?? ''}`),
                            })}
                          />
                        </div>
                        <div className="mth-pips">
                          {Array.from({ length: d.posts }).map((__, i) => {
                            const published = st ? i < st.published : false;
                            const failed = st ? i >= st.planned - st.failed : false;
                            return (
                              <span
                                key={i}
                                className={`mth-pip ${pipClass(d.slot)}${published ? ' done' : ''}${failed && !published ? ' late' : ''}`}
                              >
                                {num(i + 1, isAr)}
                              </span>
                            );
                          })}
                        </div>
                        {st && (
                          <div className="mth-tiny" style={{ marginBlockStart: 5 }}>
                            {isAr
                              ? `${num(st.published, isAr)} من ${num(st.planned, isAr)} إصدارًا نُشرت`
                              : `${num(st.published, isAr)} of ${num(st.planned, isAr)} releases out`}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mth-paid-cells">
                  {w.paid.map((c) => {
                    const n = findNote(notes, 'paid_batch', 'paid', c.projectId, c.batchDay);
                    return (
                      <div className="mth-day" key={`${c.batchDay}:${c.projectId}`}>
                        <div className="dh">
                          <span>{dayLabel(c.batchDay, isAr)}</span>
                          <span className="nmx">{c.projectName ?? projectLabel(c.projectId)}</span>
                          <Pencil
                            has={Boolean(n)}
                            disabled={!canEdit}
                            title={isAr
                              ? `ملاحظة على دفعة ${dayLabel(c.batchDay, isAr)} — ${c.projectName ?? ''}`
                              : `Note on the ${dayLabel(c.batchDay, isAr)} batch — ${c.projectName ?? ''}`}
                            onClick={() => openNote({
                              kind: 'paid_batch',
                              lane: 'paid',
                              project_id: c.projectId,
                              batch_date: c.batchDay,
                              label: isAr
                                ? `دفعة ${dayLabel(c.batchDay, isAr)} · ${c.projectName ?? ''} — ${num(c.creatives, isAr)} تصاميم`
                                : `${dayLabel(c.batchDay, isAr)} batch · ${c.projectName ?? ''} — ${num(c.creatives, isAr)} creatives`,
                            })}
                          />
                        </div>
                        <div className="mth-adpips">
                          {Array.from({ length: c.creatives }).map((__, i) => (
                            <span key={i} className={`mth-adpip ${pipClass(slotOf(c.projectId))}`} />
                          ))}
                          <span className="mth-tiny" style={{ marginInlineStart: 6 }}>
                            {num(c.creatives, isAr)} {isAr ? 'تصاميم' : 'creatives'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>

        <p className="mth-tiny" style={{ marginBlockStart: 10 }}>
          {lane === 'organic'
            ? (isAr
              ? 'الرقم داخل المربّع هو ترتيب القراءة على البروفايل. إنستقرام يعرض الأحدث أولًا، فالمنشور رقم ١ يُنشر آخرًا داخل صفه. وكل منشور يخرج مرتين: مربّع للفيد وعمودي للستوري بلا كابشن.'
              : 'The number in the square is the reading order on the profile. Instagram shows the newest first, so post 1 publishes LAST within its row. Every post goes out twice: a square feed post and a vertical story with no caption.')
            : (isAr
              ? 'كل خلية دفعة واحدة لمشروع واحد في أسبوع واحد: خمسة تصاميم تُفعَّل يوم الدفعة، ثم تُحكَم كل منها على أيامها السبعة الأولى وحدها.'
              : 'Each cell is one project’s batch for one week: five creatives activated on the batch date, each then judged on its own first seven days.')}
        </p>

        {footer}

        {laneNotes.length > 0 && <div className="mth-sep" />}
        {laneNotes.map((n) => (
          <div className="mth-note" key={n.id}>
            <span className="src">
              {n.kind === 'month'
                ? (isAr ? 'ملاحظة على الشهر — تصل اللينين' : 'Note on the month — reaches both lanes')
                : n.kind === 'project'
                  ? (isAr
                    ? `ملاحظة على عمود ${projectLabel(n.project_id ?? '')} · ${n.lane === 'paid' ? 'المدفوع' : 'العضوي'}`
                    : `${projectLabel(n.project_id ?? '')} column · ${n.lane}`)
                  : n.kind === 'row'
                    ? (isAr ? `ملاحظة على صف ${dayLabel(n.batch_date, isAr)}` : `${dayLabel(n.batch_date, isAr)} row`)
                    : (isAr
                      ? `ملاحظة على دفعة ${dayLabel(n.batch_date, isAr)} · ${projectLabel(n.project_id ?? '')}`
                      : `${dayLabel(n.batch_date, isAr)} batch · ${projectLabel(n.project_id ?? '')}`)}
            </span>
            {n.body}
          </div>
        ))}
      </div>
    </div>
  );
}
