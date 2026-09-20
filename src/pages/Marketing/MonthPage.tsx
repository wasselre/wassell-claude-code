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
  setMonthBudget, setMonthBatchSize,
  type MosMonthGet, type MosMonthCompile, type MosMonthReport,
  type MosMonthGridWeek, type MosMonthCapacityLine,
} from '@/lib/marketingOS/client';
import { conflictBlocksConfirm as blocksConfirm } from '@/lib/marketingOS/scheduling/types';
import { useWorkspace } from './MarketingWorkspace';
import { LoadError, PageHead, Skeleton } from './components/kit';
import MonthExceptions from './components/MonthExceptions';
import MonthNumbers from './components/MonthNumbers';
import MonthNoteModal, { type NoteCoord } from './components/MonthNoteModal';
import MonthWeeksGrid, { type DayReleaseState } from './components/MonthWeeksGrid';
import { MonthProjectSlots, MonthProjectResults } from './components/MonthProjectSlots';
import { num, money, pct, dayLabel, monthName } from './lib/format';
import {
  MonthFactCards, demandFact, unscheduledFact, budgetFact, batchSizeFact,
  type MonthFact,
} from './components/MonthFactCards';
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
/*
 * The month's project choice, kept on the DEVICE until it is confirmed.
 *
 * Choosing three projects is real work — reading the ranking, weighing the
 * three numbers — and until now none of it was written anywhere before the
 * confirm: a refresh, a crash or a stray Cmd-R and the page came back with the
 * system's suggestion as if nothing had happened. Same rule as the writing
 * fields: what you type is saved as you type it.
 *
 * It is device-local on purpose. A draft selection is one operator's thinking
 * in one sitting, not a shared record — the shared record is the confirmed
 * month, whose campaigns ARE the selection (`mos_campaigns.ref` carries each
 * project id). So this restores your own tab and nothing more, and it is
 * dropped the moment the month is confirmed.
 */
const SELECTION_KEY = (month: string): string => `wassel.mos.month-selection.v1:${month}`;

export function readSelectionDraft(month: string): string[] | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SELECTION_KEY(month));
  } catch (e) {
    // Storage blocked (private mode / policy). The page still works; the
    // choice simply is not remembered across a reload.
    console.error('[marketing] month selection read failed', month, e);
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.map(String).filter(Boolean);
    return ids.length > 0 ? ids : null;
  } catch (e) {
    console.error('[marketing] month selection unreadable — discarded', month, e);
    return null;
  }
}

export function writeSelectionDraft(month: string, ids: string[]): void {
  try {
    if (ids.length === 0) window.localStorage.removeItem(SELECTION_KEY(month));
    else window.localStorage.setItem(SELECTION_KEY(month), JSON.stringify(ids));
  } catch (e) {
    console.error('[marketing] month selection save failed', month, e);
  }
}

export function clearSelectionDraft(month: string): void {
  try {
    window.localStorage.removeItem(SELECTION_KEY(month));
  } catch (e) {
    console.error('[marketing] month selection clear failed', month, e);
  }
}

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
      // A DRAFT month restores what was picked on this device; once the month
      // is confirmed its campaigns are the record and the draft is discarded.
      const kept = r.state === 'draft' ? readSelectionDraft(month) : null;
      if (kept) setSelection(kept);
      else {
        if (r.state !== 'draft') clearSelectionDraft(month);
        setSelection(r.selection.map((s) => s.project_id));
      }
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

  /*
   * The two decisions the cards can take.
   *
   * Both edit `mos_month_template`, so both re-load the month afterwards
   * rather than patching local state: the compile that follows has to be the
   * one the confirm will re-run, and a card showing a number the server did
   * not accept is the same class of lie this page was rebuilt to remove.
   */
  const [factBusy, setFactBusy] = useState<string | null>(null);

  const applyBudget = useCallback(async (perProject: number) => {
    setFactBusy('budget');
    try {
      await setMonthBudget(perProject);
      await load();
      addToast(
        isAr ? `الميزانية الآن ${money(perProject, true)} لكل مشروع.` : `Budget is now ${money(perProject, false)} a project.`,
        'success',
      );
    } catch (e) {
      addToast(monthRefusal(e, isAr), 'error');
    } finally {
      setFactBusy(null);
    }
  }, [load, addToast, isAr]);

  const applyBatchSize = useCallback(async (batchDay: string, creatives: number) => {
    setFactBusy('batch-size');
    try {
      await setMonthBatchSize(month, batchDay, creatives);
      await load();
      addToast(
        isAr
          ? `دفعة ${dayLabel(batchDay, true)} الآن ${num(creatives, true)} لكل مشروع.`
          : `The ${dayLabel(batchDay, false)} batch is now ${num(creatives, false)} per project.`,
        'success',
      );
    } catch (e) {
      addToast(monthRefusal(e, isAr), 'error');
    } finally {
      setFactBusy(null);
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
  // Ad batches the team could not staff in the days left, so the ads open at the
  // next batch instead (see `compileMonth`). Said out loud, never skipped quietly.
  const staffedOutBatches = compiled?.geometry.skippedPaidBatchDays.filter((d) => d.reason === 'capacity') ?? [];
  const firstAdBatch = compiled?.geometry.paidBatchDays[0] ?? null;
  const template = data?.template ?? compiled?.template ?? report?.template ?? null;

  /*
   * THE FACTS, in the order an operator reads them: can the team do it, is
   * anything unplanned, how long is the month, what does it cost, how big is
   * the first batch, and did anything move.
   */
  const facts = useMemo((): MonthFact[] => {
    if (!summary || !template || summary.exhausted) return [];
    const out: MonthFact[] = [];
    const runningProjects = Math.min(
      selection.length || summary.projectSlots, summary.projectSlots,
    );

    for (const d of summary.demand) out.push(demandFact(d, isAr));

    if (summary.unscheduled.length > 0) {
      const days = [...new Set(summary.unscheduled.map((u) => u.requiredBy))]
        .sort().map((d) => dayLabel(d, isAr));
      out.push(unscheduledFact(summary.unscheduled.length, days, isAr));
    }

    if (summary.monthsCovered > 1 || summary.isPartial) {
      out.push({
        id: 'span',
        label: isAr ? 'المدة' : 'The stretch',
        value: `${dayLabel(summary.firstPostingDay, isAr)} — ${dayLabel(summary.lastPostingDay, isAr)}`,
        tone: 'ok',
        // `pastDays` is the count the old prose carried as «أيام نشر فائتة»:
        // posting days this month will never use because they are behind us.
        // It belongs to the span, not to a paragraph of its own.
        detail: isAr
          ? `${summary.monthsCovered > 1 ? `خطة واحدة تغطي ${num(summary.monthsCovered, true)} أشهر · ` : ''}${num(summary.productionWorkingDays, true)} يوم عمل · الإنتاج من ${dayLabel(summary.productionStart, true)}${pastDays.length > 0 ? ` · أيام نشر فائتة ${num(pastDays.length, true)}` : ''}`
          : `${summary.monthsCovered > 1 ? `one plan over ${num(summary.monthsCovered, false)} months · ` : ''}${num(summary.productionWorkingDays, false)} working days · production from ${dayLabel(summary.productionStart, false)}${pastDays.length > 0 ? ` · ${num(pastDays.length, false)} posting days missed` : ''}`,
      });
    }

    out.push(budgetFact({
      perProject: template.budgetPerProject,
      budgetTotal: summary.budgetTotal,
      running: runningProjects,
      monthsCovered: summary.monthsCovered,
      isAr,
      canEdit: canPlan && data?.state !== 'confirmed',
      busy: factBusy === 'budget',
      onSet: (v) => { void applyBudget(v); },
    }));

    if (firstAdBatch) {
      const sized = template.monthStarts[month]?.creativeOverrides ?? [];
      const rule = sized.find((r) => r.batchDay === firstAdBatch && r.projectId === null);
      out.push(batchSizeFact({
        batchDay: firstAdBatch,
        dayText: dayLabel(firstAdBatch, isAr),
        current: rule ? rule.creatives : template.creativesPerProjectWeek,
        templateValue: template.creativesPerProjectWeek,
        projects: runningProjects,
        isAr,
        canEdit: canPlan && data?.state !== 'confirmed',
        busy: factBusy === 'batch-size',
        onSet: (v) => { void applyBatchSize(firstAdBatch, v); },
      }));
    }

    if (summary.startMoved && lateDays.length > 0) {
      out.push({
        id: 'start-moved',
        label: isAr ? 'البداية تحرّكت' : 'The start moved',
        value: dayLabel(summary.startsOn, isAr),
        tone: 'warn',
        detail: isAr
          ? `${lateDays.map((d) => dayLabel(d.day, true)).join(' و')} لا يمكن إنتاجها — الدفعة تحتاج ${num(summary.minLeadWorkingDays, true)} أيام عمل`
          : `${lateDays.map((d) => dayLabel(d.day, false)).join(', ')} cannot be produced — a batch needs ${num(summary.minLeadWorkingDays, false)} working days`,
      });
    }

    if (summary.shortLeadRows.length > 0) {
      out.push({
        id: 'short-lead',
        label: isAr ? 'مهلة أقصر' : 'Less slack',
        value: num(summary.shortLeadRows.length, isAr),
        tone: 'warn',
        detail: isAr
          ? `دفعات مهلتها دون ${num(summary.targetLeadWorkingDays, true)} أيام عمل — العمل لم يكبر، المساحة للمراجعة هي التي ضاقت`
          : `batches with under ${num(summary.targetLeadWorkingDays, false)} working days of lead — the work is no bigger, there is less room for a revision`,
      });
    }

    if (staffedOutBatches.length > 0 && firstAdBatch) {
      out.push({
        id: 'ads-moved',
        label: isAr ? 'الإعلانات تأخّرت' : 'Ads moved',
        value: dayLabel(firstAdBatch, isAr),
        tone: 'warn',
        detail: isAr
          ? `${staffedOutBatches.map((d) => dayLabel(d.day, true)).join(' و')} لا تتّسع للمصممين — المنشورات تبقى في مواعيدها`
          : `${staffedOutBatches.map((d) => dayLabel(d.day, false)).join(', ')} does not fit the designers — the posts keep their dates`,
      });
    }

    return out;
  }, [summary, template, isAr, selection.length, canPlan, data?.state, factBusy, pastDays.length,
      applyBudget, applyBatchSize, firstAdBatch, month, lateDays, staffedOutBatches]);

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
    // `publishing` fell through to «المحتوى» until 2026-09-16, so the writer
    // appeared twice under the same label with two different capacities.
    if (b === 'publishing') return isAr ? 'النشر' : 'Publishing';
    return isAr ? 'المحتوى' : 'Content';
  }, [isAr]);

  /* ---- shared header ---- */
  const head = (
    <PageHead
      title={isAr ? 'الشهر' : 'The month'}
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

  /*
   * A month another month already plans has NO planner of its own.
   *
   * September 2026 runs through October as one plan, so October's own page
   * would otherwise offer a second selection over the same weeks — and
   * confirming it would book every designer day twice, with neither plan
   * seeing the other. The API refuses it; the page must not offer it, and it
   * names the owner so the next click is obvious rather than blocked.
   */
  if (tense === 'plan' && data.covered_by) {
    const owner = data.covered_by;
    return (
      <div className="body">
        {head}
        {monthNav}
        <div className="notice" style={{ marginBlockEnd: 14 }}>
          <div>
            {isAr
              ? `${monthLabel(month, true)} مُخطَّط ضمن خطة ${monthLabel(owner, true)} الممتدة — خطة واحدة تغطي الشهرين. لا يوجد اختيار مشاريع هنا، ولا تُخطَّط هذه الأسابيع مرتين.`
              : `${monthLabel(month, false)} is planned inside ${monthLabel(owner, false)}'s stretched plan — one plan covering both months. There is no project selection here, and these weeks are not planned twice.`}
          </div>
          <div style={{ marginBlockStart: 8 }}>
            <button type="button" className="btn btn-sm" onClick={() => go({ month: owner })}>
              {isAr ? `افتح ${monthLabel(owner, true)}` : `Open ${monthLabel(owner, false)}`}
            </button>
          </div>
        </div>
      </div>
    );
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
                  const picked = next.filter(Boolean);
                  // Persisted the moment it changes, like the writing fields:
                  // a refresh before confirming used to throw the choice away.
                  writeSelectionDraft(month, picked);
                  return picked;
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
                ? `لم يعد بالإمكان بدء ${monthLabel(month, true)}: كل أيام النشر المتبقية أقرب مما يستطيع الإنتاج بلوغه. الدفعة تحتاج ${num(summary.minLeadWorkingDays, true)} أيام عمل قبل موعد نشرها.`
                : `${monthLabel(month, false)} can no longer be started: every remaining posting day is closer than production can reach. A batch needs ${num(summary.minLeadWorkingDays, false)} working days before it publishes.`}
            </div>
            <div>
              {isAr ? 'ابدأ الشهر التالي.' : 'Start the next month instead.'}
            </div>
          </div>
        )}

        {data.backlog.length > 0 && (
          /*
           * THE LIVE BACKLOG — reality, not forecast.
           *
           * The compile above is a prediction. This is what the dispatcher has
           * actually parked for capacity right now. It is shown even when the
           * month's own plan is fine, because a backlog is usually caused by
           * something the plan never knew about: leave, a revision, a month
           * started late. Until 2026-09-20 the only trace of it was a pill on
           * a per-task card.
           *
           * Units and the nearest deadline, never a task count: a batch is
           * three units and a creative is one, so «٤ مهام» says nothing about
           * how long the queue takes to clear or whether it threatens anything.
           */
          <div className="notice bad" style={{ marginBlockEnd: 14 }} role="alert">
            {data.backlog.map((b) => (
              <div key={`${b.capacity_key}:${b.role_key}`}>
                {isAr
                  ? `${b.capacity_key === 'design' ? 'التصميم' : 'الكتابة'} — ${num(b.waiting_units, true)} وحدة بانتظار السعة`
                    + (b.days_to_clear === null
                      ? ' · لا أحد يتولّى هذا الدور'
                      : ` · تُنجَز خلال ${num(b.days_to_clear, true)} يوم عمل`)
                    + (b.oldest_waiting_hours === null ? '' : ` · أقدمها منتظر ${num(Math.round(b.oldest_waiting_hours), true)} ساعة`)
                    + (b.next_publish_at === null ? '' : ` · أقرب نشر ${dayLabel(b.next_publish_at.slice(0, 10), true)}`)
                  : `${b.capacity_key === 'design' ? 'Design' : 'Writing'} — ${num(b.waiting_units, false)} unit(s) waiting on capacity`
                    + (b.days_to_clear === null
                      ? ' · nobody holds this role'
                      : ` · clears in ${num(b.days_to_clear, false)} working days`)
                    + (b.oldest_waiting_hours === null ? '' : ` · oldest waiting ${num(Math.round(b.oldest_waiting_hours), false)}h`)
                    + (b.next_publish_at === null ? '' : ` · nearest publish ${dayLabel(b.next_publish_at.slice(0, 10), false)}`)}
              </div>
            ))}
          </div>
        )}

        {/*
          * THE MONTH'S FACTS — one per card, with the decision attached.
          *
          * This replaced six stacked paragraphs of centred Arabic prose on
          * 2026-09-20. The numbers were buried inside sentences, and the two
          * that asked for a decision («raise the budget for the stretch»,
          * «lower it yourself for a partial month») appeared together, said
          * opposite things, and offered no control for either.
          *
          * Cards are built in `MonthFactCards.tsx`; the list is assembled in
          * the `facts` memo above so the ordering rule lives in one place.
          */}
        <MonthFactCards facts={facts} />

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
                        ? `${num(summary.rows, true)} دفعة سوشيال ميديا × ${num(template.postsPerRow, true)} — منها ${num(summary.generalRows, true)} عامة`
                        : `${num(summary.rows, false)} social media batches × ${num(template.postsPerRow, false)} — ${num(summary.generalRows, false)} of them general`}
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
                        {/*
                          * The percentage is its own ISOLATED run, separated by
                          * «—». It was `… يوميًا · ٥٠٪` in one string: the bidi
                          * algorithm set the neutral «·» beside the digits, and a
                          * middle dot is indistinguishable from the Arabic zero
                          * «٠». Every meter read ten times too high — 50% as
                          * «٥٠٠٪», 1% as «١٠٪» — on the one card that answers
                          * "is the team overloaded?".
                          */}
                        <span className="vl">
                          {isAr
                            ? <>{`${num(l.averagePerWorkingDay, true)} من ${num(l.capacityPerDay, true)} يوميًا — `}<bdi>{pct(ratio, true)}</bdi></>
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
