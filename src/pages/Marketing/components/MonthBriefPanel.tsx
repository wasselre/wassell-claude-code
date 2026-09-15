/**
 * The resolved brief — F2b.
 *
 * Instructions for a month are written on the MONTH GRID, never on the record:
 * the records do not exist until production starts. A task therefore resolves
 * its brief LIVE, down the levels that apply to it, and labels every line by
 * where it came from. Empty levels do not render — a heading with no text under
 * it reads as "nothing to say here", which is not the same as "nobody wrote
 * anything".
 *
 * **Decision D7 — the brief resolves down ONE LANE only.** Paid notes are their
 * own channel:
 *
 *   organic row task   →  month note  →  organic project column  →  row cell
 *   paid creative task →  month note  →  paid project column     →  paid batch cell
 *
 * A paid task must NEVER show an organic column note. That leak is exactly what
 * D7 closes, and it is why `mos_month_notes.lane` exists: a project-column note
 * belongs to exactly one lane, and `lane IS NULL` is the month note, which is
 * the one level that reaches both.
 *
 * **The Saturday general row has no project column.** `mos_content_rows.project_id`
 * is nullable for it (A8b), so its chain is month → cell note → topic bank: its
 * own cell note is the only project-specific instruction it can ever receive,
 * and `mos_month_template.general_topic_bank` is the fallback when that cell was
 * left blank.
 *
 * This file owns the RESOLUTION as a pure function as well as the panel, so the
 * month screen and the task screens cannot disagree about what a note reaches.
 */
import { useMemo } from 'react';
import type { MosMonthNote } from '@/lib/marketingOS/client';
import { fullDate } from '../lib/format';

/* ── the note as it comes off `mos_month_notes` ───────────────────────── */

export type BriefLane = 'organic' | 'paid';
export type MonthNoteKind = 'month' | 'project' | 'row' | 'paid_batch';

/**
 * What this panel resolves over. The COORDINATE fields are taken straight from
 * `MosMonthNote` — the shape `month_get` returns — so a rename there breaks the
 * resolution loudly instead of silently matching nothing. Provenance is relaxed
 * to optional, because a caller assembling a note by hand (a test, an optimistic
 * local write after the pencil) has no `updated_at` yet, and `author_name` is
 * resolved by the caller when it has the people map.
 */
export type MonthNote =
  Omit<MosMonthNote, 'author_user_id' | 'updated_at'>
  & {
    author_user_id?: string | null;
    updated_at?: string | null;
    author_name?: string | null;
    created_at?: string | null;
  };

/** Which task is asking. `projectId: null` is the Saturday general row. */
export interface BriefCoord {
  lane: BriefLane;
  projectId: string | null;
  /** The row's / paid batch's day — `YYYY-MM-DD`. */
  batchDate: string | null;
  /** Shown in the «عمود المشروع — X» label; falls back to a generic word. */
  projectName?: string | null;
}

export interface BriefLine {
  key: string;
  kind: MonthNoteKind | 'topic_bank';
  /** Where this line came from, already worded. */
  source_ar: string;
  source_en: string;
  body: string;
  author_name?: string | null;
  at?: string | null;
}

const ymd = (v: string | null | undefined): string => (v ?? '').slice(0, 10);

/**
 * The applicable notes for one task, in the order they are read: the widest
 * instruction first, the most specific last, so a later line overrides an
 * earlier one by being read after it.
 *
 * `topicBank` supplies the LAST resort and ONLY for the general row: a Saturday
 * cell left blank falls back to the standing topic list rather than reaching the
 * writer with nothing at all.
 */
export function resolveMonthBrief(
  notes: MonthNote[],
  coord: BriefCoord,
  topicBank?: string[],
): BriefLine[] {
  const out: BriefLine[] = [];
  const day = ymd(coord.batchDate);

  // 1 — the month. lane IS NULL by construction: it reaches both lanes.
  const monthNote = notes.find((n) => n.kind === 'month' && n.lane === null && n.body.trim() !== '');
  if (monthNote) {
    out.push({
      key: monthNote.id,
      kind: 'month',
      source_ar: 'ملاحظة على الشهر',
      source_en: 'Month note',
      body: monthNote.body,
      author_name: monthNote.author_name ?? null,
      at: monthNote.updated_at ?? monthNote.created_at ?? null,
    });
  }

  // 2 — the project column, IN THIS LANE ONLY (D7). Skipped entirely when the
  //     row has no project: the general row has no column to inherit from.
  if (coord.projectId) {
    const col = notes.find((n) => n.kind === 'project'
      && n.lane === coord.lane
      && n.project_id === coord.projectId
      && n.body.trim() !== '');
    if (col) {
      const name = coord.projectName?.trim();
      out.push({
        key: col.id,
        kind: 'project',
        source_ar: name ? `عمود المشروع — ${name}` : 'عمود المشروع',
        source_en: name ? `Project column — ${name}` : 'Project column',
        body: col.body,
        author_name: col.author_name ?? null,
        at: col.updated_at ?? col.created_at ?? null,
      });
    }
  }

  // 3 — the cell. Organic = the row cell; paid = that project's batch cell.
  const cellKind: MonthNoteKind = coord.lane === 'paid' ? 'paid_batch' : 'row';
  const cell = day
    ? notes.find((n) => n.kind === cellKind
      && n.lane === coord.lane
      && ymd(n.batch_date) === day
      && (n.project_id ?? null) === (coord.projectId ?? null)
      && n.body.trim() !== '')
    : undefined;
  if (cell) {
    out.push({
      key: cell.id,
      kind: cellKind,
      source_ar: coord.lane === 'paid'
        ? `ملاحظة الدفعة — ${fullDate(day, true)}`
        : `ملاحظة الصف — ${fullDate(day, true)}`,
      source_en: coord.lane === 'paid'
        ? `Batch note — ${fullDate(day, false)}`
        : `Row note — ${fullDate(day, false)}`,
      body: cell.body,
      author_name: cell.author_name ?? null,
      at: cell.updated_at ?? cell.created_at ?? null,
    });
  }

  // 4 — the general row's fallback. ONLY when it has no project AND no cell
  //     note: a topic bank is a standing list, not an instruction, so it must
  //     never sit beside a real one.
  if (!coord.projectId && !cell && topicBank && topicBank.length > 0) {
    out.push({
      key: 'topic-bank',
      kind: 'topic_bank',
      source_ar: 'بنك مواضيع السبت — لم تُكتب ملاحظة على هذه الخلية',
      source_en: 'Saturday topic bank — no note was written on this cell',
      body: topicBank.join('\n'),
    });
  }

  return out;
}

/* ── the panel ────────────────────────────────────────────────────────── */

const noteBox = {
  border: '1px solid var(--line)',
  borderInlineStart: '3px solid var(--copper)',
  borderRadius: 8,
  background: 'var(--sand-2)',
  padding: '10px 13px',
  fontSize: 13.5,
  lineHeight: 1.85,
  whiteSpace: 'pre-wrap' as const,
};
const srcLabel = {
  display: 'block',
  fontSize: 10.5,
  fontWeight: 700,
  color: 'var(--mute)',
  marginBottom: 3,
  whiteSpace: 'normal' as const,
};

export default function MonthBriefPanel({
  notes, coord, topicBank, isAr, loading = false, error = null, compact = false,
}: {
  notes: MonthNote[];
  coord: BriefCoord;
  /** `mos_month_template.general_topic_bank` — used by the general row only. */
  topicBank?: string[];
  isAr: boolean;
  loading?: boolean;
  /** A read that FAILED is not an empty brief — say so instead of showing none. */
  error?: string | null;
  /** Inside a row card rather than as a page section. */
  compact?: boolean;
}) {
  const lines = useMemo(
    () => resolveMonthBrief(notes, coord, topicBank),
    [notes, coord, topicBank],
  );

  const title = isAr ? 'الموجز المجمَّع' : 'The resolved brief';
  const laneWord = coord.lane === 'paid'
    ? (isAr ? 'المدفوع' : 'Paid')
    : (isAr ? 'العضوي' : 'Organic');

  const body = (() => {
    if (error) {
      return (
        <div style={{ fontSize: 12.5, color: 'var(--late)', fontWeight: 700 }}>
          {isAr
            ? `تعذّر قراءة ملاحظات الشهر — لا تعتبرها فارغة. ${error}`
            : `Could not read the month’s notes — do not read this as “none”. ${error}`}
        </div>
      );
    }
    if (loading) {
      return (
        <div style={{ fontSize: 12.5, color: 'var(--mute)' }}>
          {isAr ? 'جارٍ قراءة ملاحظات الشهر…' : 'Reading the month’s notes…'}
        </div>
      );
    }
    if (lines.length === 0) {
      return (
        <div style={{ fontSize: 12.5, color: 'var(--mute)' }}>
          {isAr
            ? 'لا ملاحظات على هذا العمل — لا على الشهر ولا على المشروع ولا على الخلية.'
            : 'No notes reach this work — none on the month, the project, or the cell.'}
        </div>
      );
    }
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        {lines.map((l) => (
          <div key={l.key} style={noteBox}>
            <span style={srcLabel}>{isAr ? l.source_ar : l.source_en}</span>
            {l.body}
            {(l.author_name || l.at) && (
              <div style={{ fontSize: 10.5, color: 'var(--mute)', marginTop: 5, whiteSpace: 'normal' }}>
                {[
                  l.author_name ? (isAr ? `كتبها ${l.author_name}` : `by ${l.author_name}`) : null,
                  l.at ? fullDate(l.at, isAr) : null,
                ].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  })();

  const footnote = (
    <p style={{ fontSize: 11, color: 'var(--mute)', marginTop: 10, lineHeight: 1.8 }}>
      {isAr
        ? 'تُكتب هذه الملاحظات على شبكة الشهر، لا من هنا، وتُقرأ حيًّا — فتعديلها يظهر فورًا. المستويات الفارغة لا تظهر أصلًا. '
          + `ملاحظات ${laneWord} وحده تصل هذا العمل؛ ملاحظة الشهر تصل الجانبين.`
        : 'These notes are written on the month grid, not here, and are read live — an edit shows immediately. '
          + `Empty levels never render. Only ${laneWord.toLowerCase()} notes reach this work; the month note reaches both.`}
    </p>
  );

  if (compact) {
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <div className="doc-lbl" style={{ margin: 0 }}>{title}</div>
        {body}
      </div>
    );
  }

  return (
    <div className="write">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <div className="doc-lbl" style={{ margin: 0 }}>{title}</div>
        <span className="tag tag-t">{laneWord}</span>
        <span className="tag tag-t" style={{ marginInlineStart: 'auto' }}>
          {isAr
            ? 'تُحرَّر على شبكة الشهر'
            : 'Edited on the month grid'}
        </span>
      </div>
      {body}
      {footnote}
    </div>
  );
}
