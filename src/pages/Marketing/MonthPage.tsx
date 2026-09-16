/**
 * الشهر — one page in two tenses (F1 of the monthly operating model).
 *
 * BEFORE the month starts it is the PLAN you confirm once: three project slots
 * with a computed suggestion, what will be produced, the computed dates, whether
 * the team fits, the weeks grid you write your notes on, and one button. AFTER
 * it starts the same page is the REPORT: the same three cards and the same grid,
 * with live numbers instead of expectations. The layout is deliberately
 * identical — what changes is the tense, not the shape — because this one screen
 * replaces the campaign wizard, the content calendar and the monthly report.
 *
 * WHAT THIS PAGE REFUSES TO DO
 *
 *  • **Invent a number.** The suggestion's "days since last featured" is a
 *    STAND-IN (decision D6) — nothing has ever published, so it is
 *    `greatest(last day of spend, last content created)` and the card says so
 *    under the number. Cost per qualified lead is rendered as a COUNT beside
 *    cost per lead («١٣ مؤهل من ١٧»), never as a second riyal figure, because an
 *    ad lead onboards at «جديد» and before triage the two prices are one price.
 *  • **Compile twice.** The plan tense compiles the month through the engine
 *    (`month_compile`, which writes nothing). The report tense reads what the
 *    month ACTUALLY holds — its publications — rather than re-compiling the
 *    template, which would answer a different question and drift.
 *  • **A half-built month is no longer possible.** `month_confirm` commits all
 *    four plans in ONE transaction (D8), so a month either landed whole or not
 *    at all — there is no `rows_not_materialised` state to explain any more.
 *    `warnings` survives as the channel for anything a future confirm needs to
 *    say, and whatever arrives is rendered in red exactly as it arrives.
 *
 * Mockups: `s-month.html` (both tenses) and `s-exceptions.html`, with edit E1
 * (the organic/paid switch and paid notes) folded into the weeks card.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  fetchMonth, compileMonthPlan, confirmMonth, fetchMonthReport, setMonthNote,
  type MosMonthGet, type MosMonthCompile, type MosMonthReport,
  type MosMonthGridWeek, type MosMonthCapacityLine,
} from '@/lib/marketingOS/client';
import { conflictBlocksPlan as blocksConfirm } from '@/lib/marketingOS/scheduling/types';
import { useWorkspace } from './MarketingWorkspace';
import { LoadError, PageHead, Skeleton } from './components/kit';
import MonthExceptions from './components/MonthExceptions';
import MonthNumbers from './components/MonthNumbers';
import MonthNoteModal, { type NoteCoord } from './components/MonthNoteModal';
import MonthWeeksGrid, { type DayReleaseState } from './components/MonthWeeksGrid';
import { MonthProjectSlots, MonthProjectResults } from './components/MonthProjectSlots';
import { num, money, pct, dayLabel, monthName } from './lib/format';
import { monthDate } from './components/MonthDates';
import './styles/month.css';

type Tense = 'plan' | 'report';

/* ------------------------------------------------------------------ */
/* month arithmetic — all civil, no timezone anywhere                  */
/* ------------------------------------------------------------------ */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month: string, isAr: boolean): string {
  const [y, m] = month.split('-').map(Number);
  return `${monthName((m ?? 1) - 1, isAr)} ${num(y ?? 0, isAr)}`;
}

/**
 * The structured 409 the month actions send.
 *
 * The server sends `jsonError(409, JSON.stringify({error, error_ar, error_en}))`,
 * so the useful body arrives as a JSON STRING inside `payload.error`. A
 * non-JSON body is a legitimate outcome (plain error strings exist), so a
 * SyntaxError means "not a structured refusal" and the caller shows the raw
 * message; anything else re-throws rather than being swallowed.
 */
function monthRefusal(err: unknown, isAr: boolean): string {
  const e = err as { status?: number; payload?: { error?: unknown }; message?: string } | null;
  const raw = typeof e?.payload?.error === 'string' ? e.payload.error : e?.message ?? '';
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const text = isAr ? body.error_ar : body.error_en;
      if (typeof text === 'string' && text) {
        const extra = typeof body.detail === 'string' && body.detail ? ` — ${body.detail}` : '';
        return `${text}${extra}`;
      }
    } catch (parseErr) {
      if (!(parseErr instanceof SyntaxError)) throw parseErr;
    }
  }
  return typeof raw === 'string' && raw ? raw : String(err);
}

/* ------------------------------------------------------------------ */
/* the report tense's grid — built from real publications              */
/* ------------------------------------------------------------------ */

/**
 * The weeks grid for a month that is already running.
 *
 * Built from the month's OWN publications plus its geometry — never from a
 * second compile. A re-compile would show what the template would produce
 * today, which is a different month from the one that was confirmed the moment
 * anything has been edited, replaced or moved.
 */
function weeksFromReport(report: MosMonthReport): {
  weeks: MosMonthGridWeek[];
  state: Map<string, DayReleaseState>;
} {
  const slotOf = new Map(report.project_order.map((id, i) => [id, i]));
  const byDay = new Map<string, { posts: Set<string>; planned: number; published: number; failed: number; projects: Set<string> }>();
  for (const r of report.releases) {
    if (!r.day) continue;
    const cell = byDay.get(r.day) ?? {
      posts: new Set<string>(), planned: 0, published: 0, failed: 0, projects: new Set<string>(),
    };
    if (r.content_id) cell.posts.add(r.content_id);
    cell.planned += 1;
    if (r.status === 'published') cell.published += 1;
    if (r.status === 'failed') cell.failed += 1;
    if (r.project_id) cell.projects.add(r.project_id);
    byDay.set(r.day, cell);
  }

  const nameOf = (id: string): string | null =>
    report.projects.find((p) => p.project_id === id)?.project_name ?? null;

  const weeks: MosMonthGridWeek[] = report.geometry.weeks.map((w, wi) => {
    const days = report.geometry.postingDays.filter((d) => d >= w.start && d <= w.end);
    return {
      index: w.index,
      start: w.start,
      end: w.end,
      days: days.map((day, di) => {
        const cell = byDay.get(day);
        const projectId = cell && cell.projects.size === 1 ? [...cell.projects][0] ?? null : null;
        const slot = projectId !== null ? slotOf.get(projectId) ?? null : null;
        return {
          day,
          weekday: new Date(`${day}T00:00:00Z`).getUTCDay(),
          rowKey: `${report.month}:w${wi + 1}:${day}`,
          kind: (projectId ? 'organic_row' : 'general_row') as 'organic_row' | 'general_row',
          projectId,
          projectName: projectId ? nameOf(projectId) : null,
          slot: slot ?? (projectId ? di : null),
          slotLetter: null,
          posts: cell ? Math.max(cell.posts.size, 1) : report.template.postsPerRow,
        };
      }),
      paid: report.project_order.map((id, i) => ({
        batchDay: report.geometry.paidBatchDays[wi] ?? w.start,
        projectId: id,
        projectName: nameOf(id),
        slot: i,
        slotLetter: '',
        creatives: report.template.creativesPerProjectWeek,
      })),
    };
  });

  const state = new Map<string, DayReleaseState>();
  for (const [day, c] of byDay) {
    state.set(day, { planned: c.planned, published: c.published, failed: c.failed });
  }
  return { weeks, state };
}

/* ------------------------------------------------------------------ */
/* the page                                                            */
/* ------------------------------------------------------------------ */

export default function MonthPage() {
  const { isAr, can, people, projectName } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const [params, setParams] = useSearchParams();

  const urlMonth = params.get('month');
  const month = urlMonth && MONTH_RE.test(urlMonth)
    ? urlMonth
    : new Date().toISOString().slice(0, 7);
  const tense: Tense = params.get('view') === 'report' ? 'report' : 'plan';

  const [data, setData] = useState<MosMonthGet | null>(null);
  const [compiled, setCompiled] = useState<MosMonthCompile | null>(null);
  const [report, setReport] = useState<MosMonthReport | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [compiling, setCompiling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [note, setNote] = useState<{ coord: NoteCoord; body: string } | null>(null);
  const [savingNote, setSavingNote] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  const canPlan = can('plan_campaign');
  const canApprove = can('approve_plan');

  const go = useCallback((next: { month?: string; view?: Tense }): void => {
    const p = new URLSearchParams(params);
    if (next.month) p.set('month', next.month);
    if (next.view) p.set('view', next.view);
    setParams(p, { replace: true });
  }, [params, setParams]);

  /* ---- load the month itself ---- */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchMonth(month);
      setData(r);
      setSelection(r.selection.map((s) => s.project_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { void load(); }, [load]);

  /* ---- compile the plan tense ---- */
  useEffect(() => {
    if (tense !== 'plan' || !data || selection.length === 0) return;
    if (!canPlan) return;
    let cancelled = false;
    setCompiling(true);
    setCompileError(null);
    compileMonthPlan(month, selection)
      .then((r) => { if (!cancelled) setCompiled(r); })
      .catch((e: unknown) => {
        if (!cancelled) setCompileError(monthRefusal(e, isAr));
      })
      .finally(() => { if (!cancelled) setCompiling(false); });
    return () => { cancelled = true; };
  }, [tense, data, selection, month, canPlan, isAr]);

  /* ---- load the report tense ---- */
  useEffect(() => {
    if (tense !== 'report') return;
    let cancelled = false;
    fetchMonthReport(month)
      .then((r) => { if (!cancelled) setReport(r); })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [tense, month]);

  const saveNote = useCallback(async (coord: NoteCoord, body: string) => {
    setSavingNote(true);
    try {
      await setMonthNote({
        month,
        kind: coord.kind,
        lane: coord.lane,
        project_id: coord.project_id,
        batch_date: coord.batch_date,
        body,
      });
      setNote(null);
      await load();
    } catch (e) {
      addToast(
        isAr ? `تعذّر حفظ الملاحظة: ${monthRefusal(e, true)}` : `The note could not be saved: ${monthRefusal(e, false)}`,
        'error',
      );
    } finally {
      setSavingNote(false);
    }
  }, [month, load, addToast, isAr]);

  const doConfirm = useCallback(async () => {
    setConfirmBusy(true);
    try {
      const r = await confirmMonth(month, selection);
      setWarnings(r.warnings);
      setConfirming(false);
      addToast(
        isAr
          ? `اعتُمد ${monthLabel(month, true)} — ${num(r.committed.length, true)} خطط مُعتمدة.`
          : `${monthLabel(month, false)} confirmed — ${num(r.committed.length, false)} plans committed.`,
        r.warnings.length > 0 ? 'error' : 'success',
      );
      await load();
      go({ view: 'report' });
    } catch (e) {
      addToast(monthRefusal(e, isAr), 'error');
    } finally {
      setConfirmBusy(false);
    }
  }, [month, selection, addToast, isAr, load, go]);

  const summary = compiled?.summary ?? null;
  // The two reasons a posting day is not in this month, kept apart because they
  // are different news: one is the calendar, the other is a decision the page
  // has to explain.
  const pastDays = summary?.skippedPostingDays.filter((d) => d.reason === 'past') ?? [];
  const lateDays = summary?.skippedPostingDays.filter((d) => d.reason === 'lead') ?? [];
  const template = data?.template ?? compiled?.template ?? report?.template ?? null;

  const gridProjects = useMemo(
    () => selection.map((id, i) => ({
      project_id: id,
      project_name: data?.selection.find((s) => s.project_id === id)?.project_name
        ?? projectName(id),
      slot: i,
    })),
    [selection, data, projectName],
  );

  const reportGrid = useMemo(
    () => (report ? weeksFromReport(report) : null),
    [report],
  );

  const personName = useCallback((userId: string): string => {
    const p = people.find((x) => x.user_id === userId);
    const name = isAr ? p?.name_ar ?? p?.name_en : p?.name_en ?? p?.name_ar;
    return name ?? p?.email ?? userId.slice(0, 8);
  }, [people, isAr]);

  const bucketLabel = useCallback((b: MosMonthCapacityLine['bucket']): string => {
    if (b === 'approvals') return isAr ? 'الاعتماد' : 'Approvals';
    if (b === 'video') return isAr ? 'الفيديو' : 'Video';
    return isAr ? 'المحتوى' : 'Content';
  }, [isAr]);

  /* ---- shared header ---- */
  const head = (
    <PageHead
      title={isAr ? 'الشهر' : 'The month'}
      sub={isAr
        ? 'صفحة واحدة: قبل بداية الشهر هي الخطة التي تعتمدها مرة واحدة، وبعدها هي التقرير نفسه بنفس الشبكة.'
        : 'One page: before the month starts it is the plan you confirm once; after it starts it is the report, on the same grid.'}
    >
      <div className="seg">
        <button type="button" className={tense === 'plan' ? 'on' : ''} onClick={() => go({ view: 'plan' })}>
          {isAr ? 'الخطة' : 'Plan'}
        </button>
        <button type="button" className={tense === 'report' ? 'on' : ''} onClick={() => go({ view: 'report' })}>
          {isAr ? 'التقرير' : 'Report'}
        </button>
      </div>
    </PageHead>
  );

  const monthNav = (
    <div className="mth-row" style={{ justifyContent: 'space-between', marginBlockEnd: 14 }}>
      <div className="mth-row">
        <button type="button" className="btn btn-sm" onClick={() => go({ month: shiftMonth(month, -1) })}>
          {monthLabel(shiftMonth(month, -1), isAr)}
        </button>
        <span style={{ fontSize: 19, fontWeight: 700 }}>{monthLabel(month, isAr)}</span>
        <button type="button" className="btn btn-sm" onClick={() => go({ month: shiftMonth(month, 1) })}>
          {monthLabel(shiftMonth(month, 1), isAr)}
        </button>
      </div>
      <div className="mth-row">
        <span className="tag">
          {data?.state === 'confirmed' || report?.state === 'confirmed'
            ? (isAr ? 'معتمد — يعمل' : 'Confirmed — running')
            : (isAr ? 'مسودة — لم تُعتمد' : 'Draft — not confirmed')}
        </span>
        {data && (
          <span className="mth-tiny">
            {isAr
              ? `اليوم ${monthDate(data.today, true)} · موعد اختيار الشهر ${monthDate(data.geometry.nextMonthReminderOn, true)}`
              : `Today ${monthDate(data.today, false)} · month-choice date ${monthDate(data.geometry.nextMonthReminderOn, false)}`}
          </span>
        )}
      </div>
    </div>
  );

  if (loading && !data) {
    return <div className="body">{head}<Skeleton rows={8} /></div>;
  }
  if (error && !data) {
    return <div className="body">{head}<LoadError message={error} onRetry={() => void load()} isAr={isAr} /></div>;
  }
  if (!data || !template) {
    return <div className="body">{head}<Skeleton rows={8} /></div>;
  }

  /* ================= PLAN ================= */
  if (tense === 'plan') {
    return (
      <div className="body">
        {head}
        {monthNav}

        {warnings.length > 0 && (
          <div className="notice bad" role="alert" style={{ marginBlockEnd: 14 }}>
            {warnings.map((w) => <div key={w}>{w}</div>)}
          </div>
        )}

        {!template.enabled && (
          <div className="notice" style={{ marginBlockEnd: 14 }}>
            {isAr
              ? 'قالب الشهر غير مفعَّل بعد: الصفحة تعرض الخطة كاملة ويمكن كتابة الملاحظات، لكن «اعتماد الشهر» مرفوض حتى يُفعَّل القالب.'
              : 'The month template is not enabled yet: the page shows the full plan and notes can be written, but «confirm the month» is refused until the template is turned on.'}
          </div>
        )}

        {/* ── the three slots ── */}
        <div className="card" style={{ marginBlockEnd: 14 }}>
          <div className="card-h">
            <h4>{isAr ? 'المشاريع الثلاثة' : 'The three projects'}</h4>
            <span className="r">
              {isAr
                ? 'الأحد أ · الثلاثاء ب · الخميس ج · السبت عام'
                : 'Sun A · Tue B · Thu C · Sat general'}
            </span>
          </div>
          <div className="card-b">
            <MonthProjectSlots
              slots={selection.map((id) => ({
                project_id: id,
                project_name: data.selection.find((s) => s.project_id === id)?.project_name ?? projectName(id),
                ranking: data.ranking.find((r) => r.project_id === id) ?? null,
              }))}
              slotCount={template.projectsPerMonth}
              ranking={data.ranking}
              isAr={isAr}
              canEdit={canPlan && data.state !== 'confirmed'}
              onChange={(index, projectId) => {
                setSelection((prev) => {
                  const next = [...prev];
                  while (next.length < template.projectsPerMonth) next.push('');
                  next[index] = projectId;
                  return next.filter(Boolean);
                });
              }}
            />
            <p className="mth-tiny" style={{ marginBlockStart: 12, marginBlockEnd: 0 }}>
              {isAr
                ? 'الاقتراح يُحسب من ثلاثة أرقام فقط: الوحدات المتاحة، والأيام منذ آخر إبراز، وتكلفة العميل المؤهَّل في آخر شهر عُرض فيه. المشاريع التي نفدت وحداتها مستبعَدة آليًا.'
                : 'The suggestion is computed from three numbers only: available units, days since last featured, and last month’s cost per qualified lead. Projects with no available units are excluded automatically.'}
              {data.ranking.length > template.projectsPerMonth && (
                <>
                  {' '}
                  {isAr ? 'التالي في الترتيب:' : 'Next in the ranking:'}{' '}
                  {data.ranking
                    .filter((r) => !selection.includes(r.project_id))
                    .slice(0, 3)
                    .map((r) => `${r.project_name ?? ''} (${num(r.available_units, isAr)})`)
                    .join(isAr ? ' ثم ' : ', ')}
                </>
              )}
            </p>
          </div>
        </div>

        {compileError && (
          <div className="notice bad" role="alert" style={{ marginBlockEnd: 14 }}>{compileError}</div>
        )}
        {!canPlan && (
          <div className="notice" style={{ marginBlockEnd: 14 }}>
            {isAr
              ? 'حساب الشهر يحتاج صلاحية التخطيط، فالأرقام أدناه لا تُعرض لك. يمكنك قراءة الاختيار والملاحظات والاستثناءات.'
              : 'Compiling the month needs the planning capability, so the numbers below are not shown to you. The selection, the notes and the exceptions are readable.'}
          </div>
        )}

        {compiling && !compiled && <Skeleton rows={6} />}

        {summary?.exhausted && (
          /*
           * The month can no longer be STARTED.
           *
           * Not `bad`, and deliberately not the words «الشهر لا يُجدول»: nothing
           * failed to fit, there is simply no posting day left that production
           * can reach. The answer is the next month, and the page says so
           * instead of leaving an operator to work out why every number is zero.
           */
          <div className="notice" style={{ marginBlockEnd: 14 }}>
            <div>
              {isAr
                ? `لم يعد بالإمكان بدء ${monthLabel(month, true)}: كل أيام النشر المتبقية أقرب مما يستطيع الإنتاج بلوغه. الصف الواحد يحتاج ${num(summary.minLeadWorkingDays, true)} أيام عمل قبل موعد نشره — كتابة، مراجعة كتابة، تصميم، مراجعة الكاتب، اعتماد نهائي، ثم يوم للنشر — وكل يوم باقٍ أقلّ من ذلك.`
                : `${monthLabel(month, false)} can no longer be started: every remaining posting day is closer than production can reach. One row needs ${num(summary.minLeadWorkingDays, false)} working days before it publishes — writing, writing review, design, writer review, final approval, then a day to publish — and every day left has less.`}
            </div>
            <div>
              {isAr ? 'ابدأ الشهر التالي.' : 'Start the next month instead.'}
            </div>
          </div>
        )}

        {summary && !summary.exhausted
          && (summary.isPartial || summary.startMoved || summary.shortLeadRows.length > 0) && (
          /*
           * A PARTIAL month, said out loud.
           *
           * Warning tone, never `bad`: a month that starts today is a smaller
           * month, not a broken one, and a row with less slack than the target
           * lead is still a row the team can make. What must never happen is
           * the page showing a full month's numbers for a month that has two
           * weeks left — which is what it did while `productionStart` was
           * computed as «first posting day − ten working days» whatever the
           * date, and every row it drew was already in the past.
           */
          <div className="notice" style={{ marginBlockEnd: 14 }}>
            {summary.startMoved && (
              /*
               * The START MOVED, and why.
               *
               * The month does not begin on the day it was compiled from: the
               * first posting days after it cannot be PRODUCED in time, and
               * offering them and then refusing the month is not an answer. The
               * days are named with the lead each actually had, so the number
               * is checkable rather than asserted.
               */
              <div>
                {isAr
                  ? `${monthLabel(month, true)} يبدأ ${dayLabel(summary.startsOn, true)}، لا ${dayLabel(summary.startedFrom, true)}: ${lateDays.map((d) => dayLabel(d.day, true)).join(' و')} لا يمكن إنتاجها في الوقت. الصف يحتاج ${num(summary.minLeadWorkingDays, true)} أيام عمل قبل النشر، وهذه الأيام لديها ${lateDays.map((d) => num(d.leadWorkingDays, true)).join(' و')} على التوالي. العمل يتّسع — الأيام الأولى وحدها لم تتّسع.`
                  : `${monthLabel(month, false)} starts ${dayLabel(summary.startsOn, false)}, not ${dayLabel(summary.startedFrom, false)}: ${lateDays.map((d) => dayLabel(d.day, false)).join(', ')} cannot be produced in time. A row needs ${num(summary.minLeadWorkingDays, false)} working days before it publishes, and those days have ${lateDays.map((d) => num(d.leadWorkingDays, false)).join(', ')} respectively. The work fits — only the first few days did not.`}
              </div>
            )}
            {summary.isPartial && (
              <div>
                {/* Counted nouns are written as LABELS with the number after
                    them («الصفوف ١٠»), not as «١٠ صفًا»: the count here is
                    whatever is left of the month, and Arabic changes the noun's
                    form between 3–10 and 11–99. A label reads correctly at
                    every number. */}
                {isAr
                  ? `هذا الشهر محسوب من ${monthDate(summary.startedFrom, true)}، وما قبله مضى — أيام نشر فائتة: ${num(pastDays.length, true)}. المتبقي — الصفوف: ${num(summary.rows, true)} · المنشورات: ${num(summary.posts, true)} · الدفعات الإعلانية: ${num(summary.paidBatchesRemaining, true)} · أيام العمل: ${num(summary.productionWorkingDays, true)}.`
                  : `This month is compiled from ${monthDate(summary.startedFrom, false)}; everything before it has passed — posting days missed: ${num(pastDays.length, false)}. What is left — rows: ${num(summary.rows, false)} · posts: ${num(summary.posts, false)} · ad batches: ${num(summary.paidBatchesRemaining, false)} · working days: ${num(summary.productionWorkingDays, false)}.`}
              </div>
            )}
            {summary.isPartial && (
              <div>
                {isAr
                  ? `${money(template.budgetPerProject, true)} لكل مشروع رقم شهري كامل، والشهر الجزئي يشتري دفعات أقل: ${num(summary.paidBatchesRemaining, true)} بدل ${num(compiled?.geometry.weeks.length ?? 0, true)}. الرقم لم يُعدَّل — خفّضه بنفسك إن أردت.`
                  : `The ${money(template.budgetPerProject, false)} a project is a MONTHLY figure, and a partial month buys fewer batches: ${num(summary.paidBatchesRemaining, false)} instead of ${num(compiled?.geometry.weeks.length ?? 0, false)}. The number has not been changed — lower it yourself if you want to.`}
              </div>
            )}
            {summary.shortLeadRows.length > 0 && (
              <div>
                {isAr
                  ? `مهلة أقصر من المعتاد (المعتاد ${num(summary.targetLeadWorkingDays, true)} أيام عمل) في هذه الصفوف — اليوم ثم أيام العمل المتاحة له: `
                  : `Less slack than the usual ${num(summary.targetLeadWorkingDays, false)} working days on these rows — the day, then the working days it actually has: `}
                {summary.shortLeadRows
                  .map((r) => `${dayLabel(r.day, isAr)} (${num(r.leadWorkingDays, isAr)})`)
                  .join(' · ')}
                {isAr
                  ? '. العمل نفسه لم يكبر — المساحة للمراجعة والتعديل هي التي ضاقت.'
                  : '. The work itself is no bigger — there is simply less room for a revision.'}
              </div>
            )}
          </div>
        )}

        {/* A month that cannot be started has no numbers worth showing: every
            stat would be a zero, and the grid four empty weeks. The notice
            above is the whole answer. */}
        {summary && compiled && !summary.exhausted && (
          <>
            {/* ── what will be produced ── */}
            <div className="card" style={{ marginBlockEnd: 14 }}>
              <div className="card-h">
                <h4>{isAr ? 'ماذا سيُنتَج' : 'What gets produced'}</h4>
                <span className="r">{isAr ? 'يُحسب من الاختيار — لا يُكتب باليد' : 'computed from the selection'}</span>
              </div>
              <div className="card-b">
                <div className="grid g4">
                  <div className="stat">
                    <div className="k">{isAr ? 'منشورات عضوية' : 'Organic posts'}</div>
                    <div className="v">{num(summary.posts, isAr)}</div>
                    <div className="d">
                      {isAr
                        ? `${num(summary.rows, true)} صفًا × ${num(template.postsPerRow, true)} — منها ${num(summary.generalRows, true)} صفوف عامة`
                        : `${num(summary.rows, false)} rows × ${num(template.postsPerRow, false)} — ${num(summary.generalRows, false)} of them general`}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="k">{isAr ? 'إصدارات عضوية' : 'Organic releases'}</div>
                    <div className="v">{num(summary.organicReleases, isAr)}</div>
                    <div className="d">
                      {isAr
                        ? `${num(summary.feedReleases, true)} منشورًا للفيد و${num(summary.storyReleases, true)} ستوري بلا كابشن`
                        : `${num(summary.feedReleases, false)} feed posts and ${num(summary.storyReleases, false)} stories with no caption`}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="k">{isAr ? 'تصاميم مدفوعة' : 'Paid creatives'}</div>
                    <div className="v">{num(summary.paidCreatives, isAr)}</div>
                    <div className="d">
                      {/* Batches REMAINING, not weeks in the cycle: a month
                          compiled part-way through buys fewer batches, and the
                          line under the number has to say the same thing the
                          number does. */}
                      {isAr
                        ? `${num(selection.length, true)} مشاريع × ${num(template.creativesPerProjectWeek, true)} أسبوعيًا × ${num(summary.paidBatchesRemaining, true)} دفعات`
                        : `${num(selection.length, false)} projects × ${num(template.creativesPerProjectWeek, false)} weekly × ${num(summary.paidBatchesRemaining, false)} batches`}
                    </div>
                  </div>
                  <div className="stat">
                    <div className="k">{isAr ? 'إجمالي العناصر' : 'Items in all'}</div>
                    <div className="v">{num(summary.items, isAr)}</div>
                    <div className="d">
                      {isAr
                        ? `الميزانية ${money(summary.budgetTotal, true)}`
                        : `Budget ${money(summary.budgetTotal, false)}`}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ── computed dates + capacity ── */}
            <div className="grid g2" style={{ marginBlockEnd: 14 }}>
              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'التواريخ المحسوبة' : 'The computed dates'}</h4>
                  <span className="r">{isAr ? 'لا تُعدَّل يدويًا' : 'not editable by hand'}</span>
                </div>
                <div className="card-b">
                  <dl className="mth-dl">
                    <dt>{isAr ? 'أول نشر' : 'First publish'}</dt>
                    <dd>{monthDate(summary.firstPostingDay, isAr)} — {dayLabel(summary.firstPostingDay, isAr)}</dd>
                    <dt>{isAr ? 'يبدأ الإنتاج' : 'Production starts'}</dt>
                    <dd>{monthDate(summary.productionStart, isAr)}</dd>
                    <dt>{isAr ? 'الدفعات الإعلانية' : 'Ad batches'}</dt>
                    <dd>{compiled.geometry.paidBatchDays.map((d) => dayLabel(d, isAr)).join(' · ')}</dd>
                    <dt>{isAr ? 'الميزانية' : 'Budget'}</dt>
                    <dd>
                      {money(template.budgetPerProject, isAr)} × {num(selection.length, isAr)} ={' '}
                      <b>{money(summary.budgetTotal, isAr)}</b>
                    </dd>
                    <dt>{isAr ? 'آخر يوم نشر' : 'Last posting day'}</dt>
                    <dd>{monthDate(summary.lastPostingDay, isAr)}</dd>
                    <dt>{isAr ? 'اختيار الشهر القادم' : 'Next month’s choice'}</dt>
                    <dd>{monthDate(summary.nextMonthReminderOn, isAr)}</dd>
                  </dl>
                </div>
              </div>

              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'هل يتّسع الفريق؟' : 'Does the team fit?'}</h4>
                  <span className="r">
                    {/* An EMPTY load is not a pass. Nothing was placed on
                        anybody, so «يتّسع» would be a claim about a month the
                        engine never staffed — exactly the kind of green that
                        hides a refusal. */}
                    {summary.load.length === 0
                      ? (isAr ? 'لم تُقَس الطاقة — لم تُجدول أي خطوة' : 'Capacity not measured — nothing was scheduled')
                      : summary.capacityOk
                        ? (isAr ? 'الشهر يتّسع للفريق الحالي' : 'The month fits the current team')
                        : (isAr ? 'يوم واحد على الأقل يتجاوز الطاقة' : 'At least one day is over capacity')}
                  </span>
                </div>
                <div className="card-b">
                  {summary.load.length === 0 && (
                    <p className="mth-tiny">
                      {isAr
                        ? 'لا أحد محجوز بعد — لم تُسنَد أي خطوة إلى شخص في هذا الحساب.'
                        : 'Nobody is booked yet — no step in this compile was assigned to a person.'}
                    </p>
                  )}
                  {summary.load.map((l) => {
                    const ratio = l.capacityPerDay > 0
                      ? (l.averagePerWorkingDay / l.capacityPerDay) * 100 : 0;
                    const cls = l.over ? 'bad' : ratio >= 95 ? 'warn' : '';
                    return (
                      <div className="mth-meter" key={`${l.userId}:${l.bucket}`}>
                        <span className="lb">{bucketLabel(l.bucket)} · {personName(l.userId)}</span>
                        <span className="tr">
                          <span className={`fl ${cls}`} style={{ width: `${Math.min(100, Math.max(2, ratio))}%` }} />
                        </span>
                        <span className="vl">
                          {isAr
                            ? `${num(l.averagePerWorkingDay, true)} من ${num(l.capacityPerDay, true)} يوميًا · ${pct(ratio, true)}`
                            : `${num(l.averagePerWorkingDay, false)} of ${num(l.capacityPerDay, false)} a day · ${pct(ratio, false)}`}
                        </span>
                      </div>
                    );
                  })}
                  {!summary.feasible && (
                    <div className="notice bad" style={{ marginBlockStart: 10 }}>
                      {isAr
                        ? 'الشهر لا يُجدول بالكامل: عالج التعارضات أدناه قبل الاعتماد.'
                        : 'The month does not schedule in full: resolve the conflicts below before confirming.'}
                    </div>
                  )}
                  {summary.conflicts.length > 0 && (
                    /*
                     * EVERY conflict, never the first six.
                     *
                     * This list was `slice(0, 6)`. On 2026-09-16 that hid the
                     * only conflict that mattered: six unassignable publish
                     * releases — which do NOT block a month — filled the whole
                     * list, while the conflict actually refusing the confirm
                     * sat below the cut and was never drawn. The operator was
                     * told to «عالج التعارضات أدناه» about conflicts that were
                     * not the problem, and the real one was invisible.
                     *
                     * Blocking conflicts are listed FIRST so the thing standing
                     * between the operator and a confirmed month is the thing
                     * they read first.
                     */
                    <ul className="mth-tiny" style={{ marginBlockStart: 8, paddingInlineStart: 18 }}>
                      {[...summary.conflicts]
                        .sort((a, b) => Number(blocksConfirm(b)) - Number(blocksConfirm(a)))
                        .map((c, i) => (
                          <li key={i} className={blocksConfirm(c) ? 'mth-conflict-blocking' : undefined}>
                            {isAr ? c.messageAr : c.messageEn}
                            {blocksConfirm(c) && (
                              <strong> {isAr ? '— يمنع الاعتماد' : '— blocks confirming'}</strong>
                            )}
                          </li>
                        ))}
                    </ul>
                  )}
                  <p className="mth-tiny" style={{ marginBlockEnd: 0 }}>
                    {isAr
                      ? 'الصف بطاقة واحدة وإرسال واحد، لكنه يُحسب ثلاث فتحات كتابة وثلاث فتحات تصميم في الدفتر.'
                      : 'A row is one card and one submit, but it counts as three writing slots and three design slots in the ledger.'}
                  </p>
                </div>
              </div>
            </div>

            {/* ── the weeks ── */}
            <div style={{ marginBlockEnd: 14 }}>
              <MonthWeeksGrid
                weeks={compiled.weeks}
                notes={data.notes}
                isAr={isAr}
                canEdit={canPlan}
                onOpenNote={(coord, body) => setNote({ coord, body })}
                projects={gridProjects}
                generalLabel={isAr ? 'السبت — عام' : 'Saturday — general'}
                emptyWeekLabel={summary.isPartial
                  ? (isAr ? 'هذا الأسبوع مضى — لا شيء يُنتَج فيه.' : 'This week has passed — nothing is produced in it.')
                  : undefined}
              />
            </div>
          </>
        )}

        {/* ── exceptions ── */}
        <div className="card" style={{ marginBlockEnd: 14 }}>
          <div className="card-h">
            <h4>{isAr ? 'يحتاج قرارك' : 'Needs your decision'}</h4>
            <span className="r">{num(data.exceptions.length, isAr)}</span>
          </div>
          <div className="card-b">
            <MonthExceptions exceptions={data.exceptions} isAr={isAr} projectName={projectName} />
          </div>
        </div>

        {/* ── confirm ── */}
        <div className="card">
          <div className="card-b">
            <div className="mth-row" style={{ justifyContent: 'space-between' }}>
              {confirming ? (
                <span className="mth-row">
                  <button type="button" className="btn btn-p" disabled={confirmBusy} onClick={() => void doConfirm()}>
                    {confirmBusy
                      ? (isAr ? 'يُعتمد…' : 'Confirming…')
                      : (isAr ? 'تأكيد الاعتماد' : 'Yes, confirm')}
                  </button>
                  <button type="button" className="btn btn-d" disabled={confirmBusy} onClick={() => setConfirming(false)}>
                    {isAr ? 'إلغاء' : 'Cancel'}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-p"
                  /* `exhausted` is its own refusal: such a month is feasible
                     (there is nothing in it to fail), so the feasibility test
                     alone would leave this button live for a month the server
                     will refuse with `month_not_startable`. */
                  disabled={!canApprove || !template.enabled || !summary?.feasible
                    || summary.exhausted
                    || data.state === 'confirmed' || selection.length === 0}
                  onClick={() => setConfirming(true)}
                >
                  {data.state === 'confirmed'
                    ? (isAr ? 'الشهر معتمد' : 'The month is confirmed')
                    : (isAr ? 'اعتماد الشهر' : 'Confirm the month')}
                </button>
              )}
              <span className="mth-tiny" style={{ maxWidth: '62ch' }}>
                {summary?.exhausted
                  ? (isAr
                    ? 'لا شيء يُعتمد: لم يبقَ في هذا الشهر يوم نشر يستطيع الإنتاج بلوغه.'
                    : 'There is nothing to confirm: no posting day is left that production can reach.')
                  : summary
                  ? (isAr
                    ? `الاعتماد يُنشئ ${num(summary.rows, true)} مهمة كتابة و${num(summary.rows, true)} مهمة تصميم بمواعيدها، و${num(selection.length, true)} حملات على ميتا بميزانية ${money(template.budgetPerProject, true)} لكل واحدة، و${num(compiled?.geometry.paidBatchDays.length ?? 0, true)} دفعات إعلانية. بعد الاعتماد لا يوجد تخطيط — استثناءات فقط.`
                    : `Confirming creates ${num(summary.rows, false)} writing tasks and ${num(summary.rows, false)} design tasks with their dates, ${num(selection.length, false)} Meta campaigns at ${money(template.budgetPerProject, false)} each, and ${num(compiled?.geometry.paidBatchDays.length ?? 0, false)} ad batches. After confirming there is no planning — only exceptions.`)
                  : (isAr
                    ? 'احسب الشهر أولًا لترى ما سيُنشئه الاعتماد.'
                    : 'Compile the month first to see what confirming would create.')}
              </span>
            </div>
          </div>
        </div>

        {note && (
          <MonthNoteModal
            coord={note.coord}
            initial={note.body}
            isAr={isAr}
            busy={savingNote}
            onSave={(coord, body) => void saveNote(coord, body)}
            onClose={() => setNote(null)}
          />
        )}
      </div>
    );
  }

  /* ================= REPORT ================= */
  return (
    <div className="body">
      {head}
      {monthNav}

      {warnings.length > 0 && (
        <div className="notice bad" role="alert" style={{ marginBlockEnd: 14 }}>
          {warnings.map((w) => <div key={w}>{w}</div>)}
        </div>
      )}

      {!report && <Skeleton rows={8} />}

      {report && report.state === 'draft' && (
        <div className="notice" style={{ marginBlockEnd: 14 }}>
          {isAr
            ? 'هذا الشهر لم يُعتمد بعد، فلا أرقام له. الأرقام أدناه — إن ظهرت — تخص إنفاقًا قديمًا ما زال يعمل.'
            : 'This month was never confirmed, so it has no numbers of its own. Anything below belongs to legacy spend still running.'}
        </div>
      )}

      {report && (
        <>
          <div className="card" style={{ marginBlockEnd: 14 }}>
            <div className="card-h">
              <h4>{isAr ? 'المشاريع الثلاثة' : 'The three projects'}</h4>
              <span className="r">{isAr ? 'نفس البطاقات — بأرقام حيّة' : 'the same cards, with live numbers'}</span>
            </div>
            <div className="card-b">
              {report.projects.length > 0
                ? <MonthProjectResults projects={report.projects} isAr={isAr} />
                : (
                  <p className="mth-tiny">
                    {isAr ? 'لا مشروع يحمل إنفاقًا أو عملاء في هذه الفترة.' : 'No project carries spend or leads in this window.'}
                  </p>
                )}
            </div>
          </div>

          <div className="card" style={{ marginBlockEnd: 14 }}>
            <div className="card-h">
              <h4>{isAr ? 'يحتاج قرارك' : 'Needs your decision'}</h4>
              <span className="r">{num(report.exceptions.length, isAr)}</span>
            </div>
            <div className="card-b">
              <MonthExceptions exceptions={report.exceptions} isAr={isAr} projectName={projectName} />
            </div>
          </div>

          <div style={{ marginBlockEnd: 14 }}>
            <MonthNumbers report={report} isAr={isAr} />
          </div>

          {reportGrid && reportGrid.weeks.length > 0 && (
            <MonthWeeksGrid
              weeks={reportGrid.weeks}
              notes={data.notes}
              isAr={isAr}
              canEdit={canPlan}
              onOpenNote={(coord, body) => setNote({ coord, body })}
              projects={report.project_order.map((id, i) => ({
                project_id: id,
                project_name: report.projects.find((p) => p.project_id === id)?.project_name ?? projectName(id),
                slot: i,
              }))}
              generalLabel={isAr ? 'السبت — عام' : 'Saturday — general'}
              releaseState={reportGrid.state}
              footer={(
                <p className="mth-tiny">
                  {isAr
                    ? 'الشبكة هنا مبنية على إصدارات الشهر نفسها، لا على إعادة حساب القالب. وحالة كل إعلان على حدة تُقرأ من شاشة الإعلانات.'
                    : 'This grid is built from the month’s own releases, not from a re-compile of the template. Per-ad state is read on the ads screen.'}
                </p>
              )}
            />
          )}

          {note && (
            <MonthNoteModal
              coord={note.coord}
              initial={note.body}
              isAr={isAr}
              busy={savingNote}
              onSave={(coord, body) => void saveNote(coord, body)}
              onClose={() => setNote(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
