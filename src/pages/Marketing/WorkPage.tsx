/**
 * My work — design screen 02 (مهامي).
 *
 * The screen the writer and the editor live in. Three groups in this order:
 * late, yours today, someone else's — the third deliberately faded so nobody
 * chases a task that isn't theirs. Row buttons NAME the action («ابدئي
 * الكتابة», «جدولة»), not a generic «فتح» — the verb comes from the workflow
 * step itself.
 *
 * The «القادم إليك» band is NOT tasks: future steps for my role on in-flight
 * items, from each item's pinned path. It exists so the role can prepare
 * without their queue filling with work they cannot start yet (s36's note:
 * «قادم إليك ليست مهمة»).
 *
 * Below 760px this page becomes design screen 28's «اليوم»: the same groups
 * as full-width thumb cards — the late card red and unmissable above the fold,
 * one full-width verb button per card, and a thumb-scrolled chip filter bar
 * instead of dropdowns. Desktop rendering is untouched.
 *
 * TWO KINDS OF CARD (2026-09-15). A ROW — three posts that move together, one
 * task to work and one to approve — is a single card here, marked «صف · ٣
 * منشورات»; its three posts never appear separately, because the row IS the
 * task. A post still gets its own card when it carries its own task (a per-post
 * revision sent back out of a row is exactly that).
 *
 * AND THE CARD EXPANDS IN PLACE. Clicking it opens the work right here — the
 * queue below moves down, nothing overlays. A row expands into `RowPane`, which
 * mounts the ONE approval component (or the designer's six slots) whole; a post
 * expands into the same `ContentPreview` every other list opens, in its inline
 * variant. There is no second, thinner approval anywhere: the inline approval
 * that used to live on the task card was deleted precisely because it was one,
 * and it dropped the revision targets when you rejected from it.
 *
 * `?row=<id>` / `?task=<id>` is the PERMALINK: a notification lands here with
 * that row already open, whether or not it is in your own queue.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosContentRow,
  MosManualTask,
  MosRole,
  MosUpcoming,
  ROLE_LABELS,
  completeManualTask,
  isOverdue,
  statusLabel,
} from '@/lib/marketingOS/client';
import {
  MosRowFacts, MosSubjectTask, fetchWorkQueue,
} from '@/lib/marketingOS/rowClient';
import { useWorkspace } from './MarketingWorkspace';
import {
  ContentThumb, Empty, KindCell, LoadError, PageHead, Pill, Skeleton, ThumbSigner,
} from './components/kit';
import ProjectLink from './components/ProjectLink';
import { IconSearch } from './components/icons';
import NewTaskModal from './components/NewTaskModal';
import { usePreview } from './components/ContentPreviewModal';
import RowPane from './components/RowPane';
import { dateTimeShort, dayName, daysAgo, daysFromNow, num, shortDate } from './lib/format';
import {
  TASK_ACTION_LABELS, actionOfTask, contentHref, previewTargetOfTask, taskHref,
} from './lib/contentRoute';
import './styles/mobile-m1.css';

/** Social media (organic) or an ad — stated on every card, never inferred. */
function LaneTag({ purpose, isAr }: { purpose: 'organic' | 'paid' | 'both'; isAr: boolean }) {
  const label = purpose === 'paid'
    ? (isAr ? 'إعلان' : 'Ad')
    : purpose === 'both'
      ? (isAr ? 'سوشيال ميديا + إعلان' : 'Social media + ad')
      : (isAr ? 'سوشيال ميديا' : 'Social media');
  return <span className="tag">{label}</span>;
}

/**
 * A task that is open but not handed out: nobody who takes this role's routine
 * work has room in their last 24 hours. It is NOT late — nobody has received it
 * yet — so it shows why it waits instead of a deadline.
 */
function waitingLabel(
  task: { step_id: string | null; waiting_reason?: string | null },
  isAr: boolean,
): string {
  if (task.waiting_reason === 'day_off') {
    return isAr ? 'الجمعة إجازة — تُسلَّم يوم السبت' : 'Friday is off — handed out on Saturday';
  }
  if (task.waiting_reason === 'no_holder') {
    return isAr ? 'بانتظار من يتولّى هذا الدور' : 'Waiting for someone in this role';
  }
  if (task.step_id === 'design') {
    return isAr ? 'بانتظار سعة التصميم' : 'Waiting for design capacity';
  }
  if (task.step_id === 'writing') {
    return isAr ? 'بانتظار سعة الكتابة' : 'Waiting for writing capacity';
  }
  return isAr ? 'بانتظار السعة' : 'Waiting for capacity';
}

/**
 * What a CONTENT ROW should say where a deadline would go.
 *
 * The task table renders `waitingLabel` from the task itself; a content row
 * only ever had `current_task_due_at`, which a queued task deliberately leaves
 * NULL — so every queued item read «بلا موعد», "no date", for work whose
 * production day was perfectly well planned. On 2026-09-20 that was fourteen
 * of September's fifteen ad creatives: each is produced 27–28 Sep and goes live
 * on the 29th, and the screen said nobody had set a date.
 *
 * Returns null when there is genuinely nothing to say.
 *
 * Exported for its test — it is the one piece of this page with a rule worth
 * pinning down.
 */
export function rowWaitText(
  r: { status_key: string; current_task_waiting_reason?: string | null; current_task_scheduled_start?: string | null },
  isAr: boolean,
): string | null {
  if (!r.current_task_waiting_reason) return null;
  const why = waitingLabel({ step_id: r.status_key, waiting_reason: r.current_task_waiting_reason }, isAr);
  const day = r.current_task_scheduled_start;
  if (!day) return why;
  return isAr
    ? `${why} · الإنتاج ${shortDate(day, true)}`
    : `${why} · produced ${shortDate(day, false)}`;
}

/**
 * The shell's phone breakpoint (mobile-shell.css). No shared matchMedia hook
 * exists in the codebase, so each mobile-aware page carries this small one.
 */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const sync = (): void => setMobile(mq.matches);
    // Both signals: emulated viewports (devtools/webviews) can resize without
    // firing the media-query change event.
    mq.addEventListener('change', sync);
    window.addEventListener('resize', sync);
    return () => {
      mq.removeEventListener('change', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);
  return mobile;
}

/**
 * s28's late pill — «متأخرة يومين», with the mock's own dual forms rather
 * than the table pill's longer «استحقاق … · متأخر …» phrase.
 */
function lateBy(iso: string | null, isAr: boolean): string {
  const d = daysFromNow(iso);
  const n = d === null ? 0 : Math.max(0, -d);
  if (isAr) {
    if (n === 0) return 'متأخرة اليوم';
    if (n === 1) return 'متأخرة يومًا';
    if (n === 2) return 'متأخرة يومين';
    if (n <= 10) return `متأخرة ${num(n, true)} أيام`;
    return `متأخرة ${num(n, true)} يومًا`;
  }
  if (n === 0) return 'late today';
  return `${n} day${n === 1 ? '' : 's'} late`;
}

/**
 * The verb for a ROW's stage. Same keyword rule as `actionLabel` below, on the
 * row task's own step key — a row has no `status_key` of its own because its
 * status IS the task.
 */
function rowActionLabel(stepKey: string | null, isAr: boolean): string {
  const key = stepKey ?? '';
  if (key.includes('design_review') || key.includes('final')) {
    return isAr ? 'الاعتماد النهائي' : 'Final approval';
  }
  if (key.includes('design_writer') || key.includes('writer_review')) {
    return isAr ? 'مراجعة التصميم' : 'Review the design';
  }
  if (key.includes('review') || key.includes('approve')) {
    return isAr ? 'مراجعة الكتابة' : 'Review the writing';
  }
  if (key.includes('design') || key.includes('edit') || key.includes('version')) {
    return isAr ? 'بدء التصميم' : 'Start the design';
  }
  if (key.includes('writ') || key.includes('script') || key.includes('caption')) {
    return isAr ? 'كتابة الدفعة' : 'Write the batch';
  }
  return isAr ? 'فتح الدفعة' : 'Open the batch';
}

/**
 * The verb for a stage. An approval stage asks you to decide; a making stage
 * asks you to make. Anything unrecognised falls back to a plain open, which is
 * honest rather than wrong.
 */
function actionLabel(row: MosContentRow, isAr: boolean): string {
  const key = row.status_key;
  if (key.includes('approve') || key.includes('review')) return isAr ? 'مراجعة' : 'Review';
  if (key.includes('write') || key.includes('script') || key.includes('caption')) {
    return isAr ? 'بدء الكتابة' : 'Start writing';
  }
  if (key.includes('design') || key.includes('edit') || key.includes('montage')) {
    return isAr ? 'بدء التنفيذ' : 'Start work';
  }
  if (key.includes('schedule') || key.includes('publish')) return isAr ? 'جدولة' : 'Schedule';
  if (key.includes('shoot') || key.includes('footage') || key.includes('material')) {
    return isAr ? 'تجهيز المواد' : 'Gather material';
  }
  return isAr ? 'فتح' : 'Open';
}

/** Is this hand-assigned task past its due moment? */
const manualOverdue = (t: MosManualTask): boolean =>
  Boolean(t.due_at) && new Date(t.due_at as string).getTime() < Date.now();

/**
 * One card in the queue. A ROW is a single card carrying its three posts; a
 * POST gets its own card only when it holds its own task.
 */
type QueueItem =
  | { kind: 'post'; id: string; row: MosContentRow }
  | {
      kind: 'row'; id: string; facts: MosRowFacts; task: MosSubjectTask;
      members: MosContentRow[];
    };

/**
 * A ROW in the queue: the card, and — when it is open — the work itself,
 * expanded into a full-width row underneath it.
 *
 * The three posts are listed inside the card in READING order, with the one
 * fact that is not obvious stated plainly: the first one publishes last.
 */
function RowCardRows({
  facts, task, members, open, overdue, isMine, faded, tone, isAr, projectLabel,
  onToggle, onChanged,
}: {
  facts: MosRowFacts;
  task: MosSubjectTask;
  members: MosContentRow[];
  open: boolean;
  overdue: boolean;
  isMine: boolean;
  faded?: boolean;
  tone: 'late' | 'now' | 'idle';
  isAr: boolean;
  projectLabel: string;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const day = facts.batch_day;
  const general = facts.kind === 'general_row' || !facts.project_id;
  return (
    <Fragment>
      <tr className="click" onClick={onToggle}>
        <td style={{ width: 44 }}>
          {members[0] ? <ContentThumb row={members[0]} size="sm" /> : null}
        </td>
        <td style={{ width: 30 }}>
          <KindCell typeKey="post" />
        </td>
        <td>
          <div className="ttl" style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="tag">
              {isAr
                ? `سوشيال ميديا · ${num(facts.member_count, true)} منشورات`
                : `Social media · ${facts.member_count} posts`}
            </span>
            {isAr
              ? `دفعة سوشيال ميديا ${day ? shortDate(day, true) : 'بلا يوم'} — ${general ? 'عام' : projectLabel}`
              : `Social media batch · ${day ? shortDate(day, false) : 'no day'} — ${general ? 'general' : projectLabel}`}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--mute)', marginTop: 3 }}>
            {members.map((m, i) => (
              <span key={m.id}>
                {i > 0 ? ' · ' : ''}
                {num(i + 1, isAr)} {m.title}
              </span>
            ))}
            {task.round > 1 && (
              <> · {isAr ? `الجولة ${num(task.round, true)}` : `round ${task.round}`}</>
            )}
          </div>
        </td>
        <td style={{ width: 190 }}>
          {task.waiting_since ? (
            <Pill tone="wait">{waitingLabel(task, isAr)}</Pill>
          ) : overdue ? (
            <Pill tone="late">
              {isAr
                ? `آخر موعد للتسليم ${dateTimeShort(task.due_at, true)} · متأخر ${daysAgo(task.due_at, true)}`
                : `due ${dateTimeShort(task.due_at, false)} · ${daysAgo(task.due_at, false)} late`}
            </Pill>
          ) : (
            <Pill tone={tone === 'idle' ? 'wait' : 'now'}>
              {task.due_at
                ? isAr ? `آخر موعد للتسليم ${dateTimeShort(task.due_at, true)}` : `due ${dateTimeShort(task.due_at, false)}`
                : isAr ? 'بلا موعد' : 'no due date'}
            </Pill>
          )}
        </td>
        <td style={{ width: 130, textAlign: 'end' }}>
          <span className={`btn btn-sm${isMine && !faded ? ' btn-p' : ' btn-d'}`}>
            {open
              ? (isAr ? 'طيّ' : 'Collapse')
              : isMine
                ? rowActionLabel(task.step_id, isAr)
                : (isAr ? 'عرض الدفعة' : 'View the batch')}
          </span>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ padding: '4px 10px 14px' }}>
            <RowPane rowId={facts.row_id} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/**
 * What `QueueGroup` needs from the page. Passed as ONE object so the group can
 * live at module level (see the note on `QueueGroup`) without a dozen props.
 */
interface GroupCtx {
  isAr: boolean;
  myRole: MosRole;
  typeLabel: (key: string) => string;
  projectName: (id: string | null | undefined) => string;
  openRowId: string | null;
  openPostId: string | null;
  expandRow: (rowId: string | null) => void;
  expandPost: (contentId: string | null) => void;
  taskFor: (contentId: string) => MosSubjectTask | undefined;
  itemLate: (it: QueueItem) => boolean;
  itemMine: (it: QueueItem) => boolean;
  reload: () => void;
  navigate: (href: string) => void;
}

/**
 * One group of the queue. A row and a post are different cards but the same
 * table: both expand IN PLACE into a second full-width row underneath, which is
 * what makes «مهامي» the place approvals happen rather than a list of links to
 * somewhere else.
 *
 * Declared at MODULE level on purpose. It mounts `RowPane`, which fetches on
 * mount; a component defined inside `WorkPage` would get a new identity on
 * every render of the page, so React would unmount and remount the whole
 * subtree — and the expanded row would re-fetch itself every time anyone typed
 * a character into the search box.
 */
function QueueGroup({
  label, tone, items: groupItems, faded, ctx,
}: {
  label: string;
  tone: 'late' | 'now' | 'idle';
  items: QueueItem[];
  faded?: boolean;
  ctx: GroupCtx;
}) {
  const {
    isAr, myRole, typeLabel, projectName, openRowId, openPostId,
    expandRow, expandPost, taskFor, itemLate, itemMine, reload,
  } = ctx;
  if (groupItems.length === 0) return null;
  return (
    <>
      {label && (
        <div
          className="lbl"
          style={{ marginBottom: 9, color: tone === 'late' ? 'var(--late)' : undefined }}
        >
          {label}
        </div>
      )}
      <div
        className="card"
        style={{
          marginBottom: 22,
          opacity: faded ? 0.72 : 1,
          borderColor: tone === 'late' ? 'color-mix(in srgb, var(--late) 38%, transparent)' : undefined,
        }}
      >
        <div className="tbl-wrap">
          <table className="tbl">
            <tbody>
              {groupItems.map((it) => {
                if (it.kind === 'row') {
                  const { facts, task, members } = it;
                  const open = openRowId === facts.row_id;
                  return (
                    <RowCardRows
                      key={`row:${facts.row_id}`}
                      facts={facts}
                      task={task}
                      members={members}
                      open={open}
                      overdue={itemLate(it)}
                      isMine={itemMine(it)}
                      faded={faded}
                      tone={tone}
                      isAr={isAr}
                      projectLabel={projectName(facts.project_id)}
                      onToggle={() => expandRow(open ? null : facts.row_id)}
                      onChanged={reload}
                    />
                  );
                }
                const r = it.row;
                const task = taskFor(r.id);
                const isMine = r.owner_role === myRole;
                const open = openPostId === r.id;
                return (
                  <Fragment key={`post:${r.id}`}>
                    <tr className="click" onClick={() => expandPost(open ? null : r.id)}>
                      <td style={{ width: 44 }}>
                        <ContentThumb row={r} size="sm" />
                      </td>
                      <td style={{ width: 30 }}>
                        <KindCell typeKey={r.content_type_key} />
                      </td>
                      <td>
                        <div className="ttl" style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
                          <LaneTag purpose={r.purpose} isAr={isAr} />
                          {statusLabel(r, isAr)} — {r.title}
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--mute)', marginTop: 3 }}>
                          <span className="ltr">{r.ref}</span> · {typeLabel(r.content_type_key)}
                          {r.project_id && <> · <ProjectLink projectIds={[r.project_id]} variant="link" /></>}
                          {task && task.round > 1 && (
                            <> · {isAr ? `الجولة ${num(task.round, true)}` : `round ${task.round}`}</>
                          )}
                        </div>
                      </td>
                      <td style={{ width: 190 }}>
                        {isOverdue(r) ? (
                          <Pill tone="late">
                            {isAr
                              ? `آخر موعد للتسليم ${dateTimeShort(r.current_task_due_at ?? r.due_at, true)} · متأخر ${daysAgo(r.current_task_due_at ?? r.due_at, true)}`
                              : `due ${dateTimeShort(r.current_task_due_at ?? r.due_at, false)} · ${daysAgo(r.current_task_due_at ?? r.due_at, false)} late`}
                          </Pill>
                        ) : rowWaitText(r, isAr) ? (
                          <Pill tone="wait">{rowWaitText(r, isAr)}</Pill>
                        ) : (
                          <Pill tone={tone === 'idle' ? 'wait' : 'now'}>
                            {r.current_task_due_at
                              ? isAr
                                ? `آخر موعد للتسليم ${dateTimeShort(r.current_task_due_at, true)}`
                                : `due ${dateTimeShort(r.current_task_due_at, false)}`
                              : isAr ? 'بلا موعد' : 'no due date'}
                          </Pill>
                        )}
                      </td>
                      <td style={{ width: 130, textAlign: 'end' }}>
                        {isMine ? (
                          <span className={`btn btn-sm${faded ? ' btn-d' : ' btn-p'}`}>
                            {open ? (isAr ? 'طيّ' : 'Collapse') : actionLabel(r, isAr)}
                          </span>
                        ) : (
                          <span className="btn btn-d btn-sm">
                            {open ? (isAr ? 'طيّ' : 'Collapse') : isAr ? 'عرض' : 'View'}
                          </span>
                        )}
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={5} style={{ padding: '4px 10px 14px' }}>
                          {/* The single item's own working screen — the same
                              faces as a row, with one post. It replaced an
                              inline preview whose buttons led to the old
                              per-item content page (deleted 2026-09-16). */}
                          <RowPane contentId={r.id} onChanged={reload} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export default function WorkPage() {
  const { isAr, typeLabel, projectName, setBadge, people, surfaces } = useWorkspace();
  const navigate = useNavigate();
  // The «الجميع» (everyone) view is the team board — visible only to roles whose
  // `team` surface is not hidden (CEO + marketing manager by default). Without
  // this gate the toggle let any role click through to everyone's tasks.
  const canSeeTeam = surfaces.team !== 'hidden';
  const isMobile = useIsMobile();
  const addToast = useAppStore((s) => s.addToast);

  const [rows, setRows] = useState<MosContentRow[]>([]);
  const [tasks, setTasks] = useState<MosSubjectTask[]>([]);
  const [rowFacts, setRowFacts] = useState<MosRowFacts[]>([]);
  const [manual, setManual] = useState<MosManualTask[]>([]);
  const [upcoming, setUpcoming] = useState<MosUpcoming[]>([]);
  const [myRole, setMyRole] = useState<MosRole>('viewer');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  /*
   * «مهامي» or «الجميع». «الجميع» used to NAVIGATE to the team page, which was
   * deleted with the other old pages (2026-09-16). It is a switch on this page
   * now: the same queue, the same row and item screens, over the whole team's
   * open work (`work_list` scope 'team' — the server already served it).
   */
  const [scope, setScope] = useState<'mine' | 'team'>('mine');
  const [newTask, setNewTask] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  // A task row opens the item's PREVIEW POPUP (the same one every other list
  // uses): the thing under review is shown right there — the copy for a
  // writing step, the design for a design review, the plan for scheduling —
  // with approve / request-changes in its footer, opened ON the task's own
  // section. The full page stays one click away («فتح الصفحة كاملة»).
  // Coming-soon rows still navigate: they are not the reader's task yet.

  // s28's chip filters — a thumb bar, no dropdowns and no filter dialog.
  const [chipProject, setChipProject] = useState<string | null>(null);
  const [chipMine, setChipMine] = useState(false);
  const [chipVideo, setChipVideo] = useState(false);

  const preview = usePreview(() => { void load(); });

  // The expanded card — one at a time, and mirrored into the URL so the thing
  // you are looking at can be linked to. `?row=` is what a row notification
  // carries; `?task=` is the task id, for a row you cannot name yet; `?item=` is
  // ONE content item (a paid creative) — what `/m/content/:id` forwards to now
  // that the old per-item page is gone.
  const [params, setParams] = useSearchParams();
  const openRowId = params.get('row');
  const openTaskId = params.get('task');
  const openPostId = params.get('item');

  const expandRow = (rowId: string | null): void => {
    const next = new URLSearchParams(params);
    if (rowId) next.set('row', rowId); else next.delete('row');
    next.delete('task');
    next.delete('item');
    setParams(next, { replace: true });
  };
  const expandPost = (contentId: string | null): void => {
    const next = new URLSearchParams(params);
    next.delete('row');
    next.delete('task');
    if (contentId) next.set('item', contentId); else next.delete('item');
    setParams(next, { replace: true });
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWorkQueue(scope);
      setRows(res.content);
      setTasks(res.tasks ?? []);
      setRowFacts(res.rows ?? []);
      setManual(res.manual_tasks ?? []);
      setUpcoming(res.upcoming ?? []);
      setMyRole(res.role);
      // The rail badge counts EVERYTHING open for me. A ROW is ONE item, not
      // three: counting its members would tell the reader they have three times
      // the work they actually have.
      const rowTaskCount = (res.rows ?? []).length;
      const postTaskCount = (res.tasks ?? [])
        .filter((t) => t.subject_table !== 'mos_content_rows').length;
      // The rail badge is MY count — never the team's, or it would read as my backlog.
      if (scope === 'mine') setBadge('mywork', rowTaskCount + postTaskCount + (res.manual_tasks?.length ?? 0));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [setBadge, scope]);

  useEffect(() => { void load(); }, [load]);

  const term = q.trim().toLowerCase();

  /* ── the two kinds of card ───────────────────────────────────────────
     A ROW is one card; its three posts are shown inside it, never beside it.
     A POST gets its own card only when it carries its OWN task — which is
     exactly what a per-post revision sent back out of a row is. */

  const rowTasks = useMemo(
    () => tasks.filter((t) => t.subject_table === 'mos_content_rows'),
    [tasks],
  );
  const postTaskIds = useMemo(
    () => new Set(tasks.filter((t) => t.subject_table !== 'mos_content_rows')
      .map((t) => t.subject_id)),
    [tasks],
  );

  const items: QueueItem[] = useMemo(() => {
    const factsBy = new Map(rowFacts.map((f) => [f.row_id, f]));
    const rowItems: QueueItem[] = rowTasks.flatMap((t) => {
      const facts = factsBy.get(t.subject_id);
      if (!facts) return [];
      const members = (facts.member_ids ?? [])
        .map((id) => rows.find((r) => r.id === id))
        .filter((r): r is MosContentRow => !!r);
      return [{ kind: 'row', id: facts.row_id, facts, task: t, members }];
    });
    const postItems: QueueItem[] = rows
      .filter((r) => postTaskIds.has(r.id))
      .map((r) => ({ kind: 'post', id: r.id, row: r }));
    return [...rowItems, ...postItems];
  }, [rowFacts, rowTasks, rows, postTaskIds]);

  const matches = (it: QueueItem): boolean => {
    if (!term) return true;
    if (it.kind === 'post') {
      return it.row.title.toLowerCase().includes(term)
        || (it.row.ref ?? '').toLowerCase().includes(term);
    }
    return it.members.some((m) => m.title.toLowerCase().includes(term)
      || (m.ref ?? '').toLowerCase().includes(term))
      || projectName(it.facts.project_id).toLowerCase().includes(term);
  };

  const itemLate = (it: QueueItem): boolean => (it.kind === 'post'
    ? isOverdue(it.row)
    : Boolean(it.task.due_at) && new Date(it.task.due_at as string).getTime() < Date.now());
  const itemMine = (it: QueueItem): boolean => (it.kind === 'post'
    ? it.row.owner_role === myRole
    : it.task.role === myRole);

  const filtered = useMemo(() => items.filter(matches), [items, term, myRole]);

  /**
   * The PERMALINK case: the page was OPENED on a row that is not in this queue
   * — someone else's stage, or a row you were only sent to look at. It renders
   * above the queue rather than 404-ing; the component is the same one either
   * way.
   *
   * Pinned to the param the page arrived with, deliberately. Without that, a row
   * you expanded from your own queue and then approved would vanish from the
   * queue and immediately reappear here as a stray block — the opposite of
   * «collapsing returns you to the queue with the card gone».
   */
  const [arrivedWithRow] = useState(() => params.get('row'));
  const [arrivedWithTask] = useState(() => params.get('task'));
  const [arrivedWithItem] = useState(() => params.get('item'));
  // Same permalink rule for a single item: opened by link, not in this queue.
  const linkedItemOutsideQueue = Boolean(
    openPostId && openPostId === arrivedWithItem
    && !items.some((it) => it.kind === 'post' && it.id === openPostId),
  );
  const linkedRowOutsideQueue = Boolean(
    ((openRowId && openRowId === arrivedWithRow) || (!openRowId && openTaskId && openTaskId === arrivedWithTask))
    && !items.some((it) => it.kind === 'row' && it.id === openRowId),
  );

  /* Rendered as an ELEMENT, not a nested component: a component declared
     inside this function gets a new identity on every render, which would
     unmount and remount `RowPane` — and re-fetch the row — on every keystroke
     in the search box. */
  const linkedItem = linkedItemOutsideQueue && openPostId ? (
    <>
      <div className="lbl" style={{ marginBottom: 9 }}>
        {isAr ? 'العنصر المفتوح من الرابط' : 'The item this link opened'}
      </div>
      <div style={{ marginBottom: 22 }}>
        <RowPane contentId={openPostId} onChanged={() => void load()} />
        <button
          type="button"
          className="btn btn-d btn-sm"
          style={{ marginTop: 10 }}
          onClick={() => expandPost(null)}
        >
          {isAr ? 'إغلاق' : 'Close'}
        </button>
      </div>
    </>
  ) : null;

  const linkedRow = linkedRowOutsideQueue ? (
    <>
      <div className="lbl" style={{ marginBottom: 9 }}>
        {isAr ? 'الدفعة المفتوحة من الرابط' : 'The batch this link opened'}
      </div>
      <div style={{ marginBottom: 22 }}>
        <RowPane rowId={openRowId} taskId={openTaskId} onChanged={() => void load()} />
        <button
          type="button"
          className="btn btn-d btn-sm"
          style={{ marginTop: 10 }}
          onClick={() => expandRow(null)}
        >
          {isAr ? 'إغلاق' : 'Close'}
        </button>
      </div>
    </>
  ) : null;

  const late = filtered.filter((it) => itemLate(it));
  const mine = filtered.filter((it) => !itemLate(it) && itemMine(it));
  const others = filtered.filter((it) => !itemLate(it) && !itemMine(it));

  const taskFor = (contentId: string): MosSubjectTask | undefined =>
    tasks.find((t) => t.subject_table !== 'mos_content_rows' && t.subject_id === contentId);

  /** The loaded content row behind an id — the thumbnail source for a task. */
  const contentRow = (contentId: string): MosContentRow | undefined =>
    rows.find((r) => r.id === contentId);

  /**
   * «القادم إليك» rows carry the step KEY the path will reach, so the link can
   * point at the exact area rather than at the top of the page. This page has
   * no pinned step list of its own; the resolver's keyword fallback handles it.
   */
  const upcomingHref = (u: MosUpcoming): string =>
    contentHref({ id: u.content_id, current_step_key: u.step_key });

  /* ── hand-assigned tasks ─────────────────────────────────────────────── */

  // Late first, then by due date, then the undated — the same "start here"
  // ordering the workflow queue uses.
  const manualSorted = useMemo(() => {
    const list = term
      ? manual.filter((t) => t.title.toLowerCase().includes(term)
          || (t.details ?? '').toLowerCase().includes(term))
      : manual;
    return [...list].sort((a, b) => {
      const la = manualOverdue(a) ? 0 : 1;
      const lb = manualOverdue(b) ? 0 : 1;
      if (la !== lb) return la - lb;
      if (!a.due_at) return 1;
      if (!b.due_at) return -1;
      return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
    });
  }, [manual, term]);

  const manualLateCount = manual.filter(manualOverdue).length;

  const closeManual = async (id: string): Promise<void> => {
    setClosing(id);
    try {
      await completeManualTask(id);
      addToast(isAr ? 'أُنهيت المهمة.' : 'Task completed.', 'success');
      await load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setClosing(null);
    }
  };

  /**
   * Where a hand-assigned task points — the ONE resolver decides, so the new
   * planning kinds (`refresh_decision`, `plan_conflict`, `ad_failed`) land
   * somewhere sensible the day their rows appear instead of dead-ending here.
   * `taskHref` never returns null; a task pointing at nothing goes to my work.
   */
  const manualTarget = (t: MosManualTask): string => taskHref(t);
  /** What this row shows the reader in its popup, or null when it has none. */
  const manualPreview = (t: MosManualTask) => previewTargetOfTask(t);
  // A SYSTEM task (a caption awaiting approval, a refresh decision, a failed
  // ad) behaves like a workflow task: the row opens the review popup, where
  // the thing is decided. It is never closed with «تم» — `manualVerb` reads
  // the verb off the kind, so a new kind needs no change here.
  /** The verb on the row's button — the kind's own, never a generic «فتح». */
  const manualVerb = (t: MosManualTask): string => {
    const a = actionOfTask(t);
    return isAr ? TASK_ACTION_LABELS[a].ar : TASK_ACTION_LABELS[a].en;
  };
  /** «معاينة» — always the popup when there is one to show. */
  const previewManual = (t: MosManualTask): void => {
    const target = manualPreview(t);
    // A task about a piece of content shows the content; anything else is a
    // navigation, because there is no popup for a cycle or a campaign.
    if (target) { preview.open(target.contentId, target.section); return; }
    navigate(manualTarget(t));
  };
  const openManual = (t: MosManualTask): void => {
    // A PUBLICATION task is done on its own screen — the finished material, the
    // destination and that platform's rules, and nothing else. Its «معاينة»
    // still shows the approved creative; the verb goes where the work happens.
    if (actionOfTask(t) === 'publish') { navigate(manualTarget(t)); return; }
    previewManual(t);
  };

  /** The project a hand-assigned task points at — its own, else its content's. */
  const manualProjectId = (t: MosManualTask): string | null =>
    t.project_id
    ?? (t.content_id ? rows.find((r) => r.id === t.content_id)?.project_id ?? null : null);

  // The project is rendered as its own clickable chip (manualProjectId), so it's
  // deliberately kept OUT of this plain-text meta line to avoid showing twice.
  const manualMeta = (t: MosManualTask): string => {
    const bits: string[] = [];
    if (t.details) bits.push(t.details);
    if (t.series_id) bits.push(isAr ? 'مهمة متكررة' : 'repeating');
    if (t.created_by_user_id) {
      const p = people.find((x) => x.user_id === t.created_by_user_id);
      const n = p ? ((isAr ? p.name_ar ?? p.name_en : p.name_en ?? p.name_ar) ?? p.email) : null;
      if (n) bits.push(isAr ? `أسندها ${n}` : `from ${n}`);
    }
    return bits.join(' · ');
  };

  const duePill = (t: MosManualTask) => (
    manualOverdue(t) ? (
      <Pill tone="late">
        {isAr
          ? `آخر موعد للتسليم ${shortDate(t.due_at, true)} · متأخر ${daysAgo(t.due_at, true)}`
          : `due ${shortDate(t.due_at, false)} · ${daysAgo(t.due_at, false)} late`}
      </Pill>
    ) : (
      <Pill tone="now">
        {t.due_at
          ? isAr ? `آخر موعد للتسليم ${shortDate(t.due_at, true)}` : `due ${shortDate(t.due_at, false)}`
          : isAr ? 'بلا موعد' : 'no due date'}
      </Pill>
    )
  );

  /**
   * Hand-assigned work, in its own block. It is deliberately NOT merged into the
   * workflow groups: those rows open a stage, these ones just get done, and
   * blurring the two would make «بدء الكتابة» and «تم» look interchangeable.
   */
  const ManualBlock = () => {
    if (manualSorted.length === 0) return null;
    return (
      <>
        <div className="lbl" style={{ marginBottom: 9, color: manualLateCount > 0 ? 'var(--late)' : undefined }}>
          {isAr ? 'مهام مُسندة إليك' : 'Assigned to you'}
        </div>
        <div className="card" style={{ marginBottom: 22 }}>
          <div className="tbl-wrap">
            <table className="tbl">
              <tbody>
                {manualSorted.map((t) => {
                  const projectId = manualProjectId(t);
                  const previewable = manualPreview(t);
                  return (
                    <tr
                      key={t.id}
                      className="click"
                      onClick={() => openManual(t)}
                    >
                      <td style={{ width: 44 }}>
                        {t.content_id
                          ? <ContentThumb row={contentRow(t.content_id) ?? { title: t.title }} size="sm" />
                          : null}
                      </td>
                      <td>
                        <div className="ttl">{t.title}</div>
                        <div style={{ fontSize: 11.5, color: 'var(--mute)', marginTop: 3 }}>
                          {manualMeta(t)}
                        </div>
                        {projectId && (
                          <div style={{ marginTop: 6 }}>
                            <ProjectLink projectIds={[projectId]} />
                          </div>
                        )}
                      </td>
                      <td style={{ width: 190 }}>{duePill(t)}</td>
                      <td style={{ width: 210, textAlign: 'end' }}>
                        {/* «معاينة» opens the item; the primary button carries
                            the KIND's own verb. A plain hand-assigned task is
                            still closed with «تم» — closing it advances
                            nothing, which is why the two never merged. */}
                        {previewable && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            style={{ marginInlineEnd: 6 }}
                            onClick={(e) => { e.stopPropagation(); previewManual(t); }}
                          >
                            {isAr ? 'معاينة' : 'Preview'}
                          </button>
                        )}
                        {!t.kind || t.kind === 'manual' ? (
                          <button
                            type="button"
                            className="btn btn-p btn-sm"
                            disabled={closing === t.id}
                            onClick={(e) => { e.stopPropagation(); void closeManual(t.id); }}
                          >
                            {closing === t.id ? '…' : isAr ? 'تم' : 'Done'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-p btn-sm"
                            onClick={(e) => { e.stopPropagation(); openManual(t); }}
                          >
                            {manualVerb(t)}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </>
    );
  };

  /* ── s28 mobile: chips + card groups ─────────────────────────────────── */

  // The chip bar's project chips come from the live rows, «×»-removable when
  // active — the mock's «مينا ٥٢ ×» pattern.
  const chipProjects = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) if (r.project_id) seen.add(r.project_id);
    return [...seen];
  }, [rows]);

  // Posts only: a row's three members are represented by the ROW card below,
  // never as three separate cards — the row IS the task.
  const mobileRows = useMemo(
    () => rows.filter((r) =>
      postTaskIds.has(r.id)
      && (!chipProject || r.project_id === chipProject)
      && (!chipVideo || r.content_type_key === 'video')),
    [rows, postTaskIds, chipProject, chipVideo],
  );

  /** The ROW cards on the phone — same objects, same expansion, one column. */
  const mobileRowItems = useMemo(
    () => items.filter((it): it is Extract<QueueItem, { kind: 'row' }> => it.kind === 'row')
      .filter((it) => (!chipProject || it.facts.project_id === chipProject) && !chipVideo)
      .filter((it) => !chipMine || itemMine(it)),
    [items, chipProject, chipVideo, chipMine, myRole],
  );

  // The late card is never filtered away by «لي» — it cannot be missed.
  const mLate = mobileRows.filter((r) => isOverdue(r));
  const mMine = mobileRows.filter((r) => !isOverdue(r) && r.owner_role === myRole);
  const mOthers = chipMine
    ? []
    : mobileRows.filter((r) => !isOverdue(r) && r.owner_role !== myRole);

  // «لدى سارة، ٣ أيام» — the person holding the item, else their role.
  const holderName = (r: MosContentRow): string => {
    const p = r.current_assignee_user_id
      ? people.find((x) => x.user_id === r.current_assignee_user_id)
      : undefined;
    if (p) {
      const n = (isAr ? p.name_ar : p.name_en) ?? p.name_ar ?? p.name_en ?? p.email;
      if (n) return n;
    }
    if (r.owner_role && ROLE_LABELS[r.owner_role]) {
      return isAr ? ROLE_LABELS[r.owner_role].ar : ROLE_LABELS[r.owner_role].en;
    }
    return isAr ? 'شخص آخر' : 'someone else';
  };

  /** `rowWaitText` bound to the current language — used wherever a row would
   *  otherwise claim it has no date. */
  const waitText = (r: MosContentRow): string | null => rowWaitText(r, isAr);

  // «P-022 · خطة سداد الثلاث غرف · اليوم» — the mine-card meta tail.
  const dueText = (r: MosContentRow): string => {
    const due = r.current_task_due_at ?? r.due_at;
    if (!due) return waitText(r) ?? (isAr ? 'بلا موعد' : 'no due date');
    return daysFromNow(due) === 0 ? (isAr ? 'اليوم' : 'today') : shortDate(due, isAr);
  };

  const isScheduleStep = (r: MosContentRow): boolean =>
    r.status_key.includes('schedule') || r.status_key.includes('publish');

  /**
   * One group of the queue. A row and a post are different cards but the same
   * table: both expand IN PLACE into a second full-width row underneath, which
   * is what makes «مهامي» the place approvals happen rather than a list of
   * links to somewhere else.
   */

  const roleLabel = ROLE_LABELS[myRole] ? (isAr ? ROLE_LABELS[myRole].ar : ROLE_LABELS[myRole].en) : myRole;

  const groupCtx: GroupCtx = {
    isAr,
    myRole,
    typeLabel,
    projectName,
    openRowId,
    openPostId,
    expandRow,
    expandPost,
    taskFor,
    itemLate,
    itemMine,
    reload: () => { void load(); },
    navigate: (href) => navigate(href),
  };

  // s28's phone header: «اليوم» + «الخميس ٣٠ يوليو · ٤ مفتوحة، ١ متأخرة».
  const todayIso = new Date().toISOString();
  const mOpen = mMine.length + mLate.length;

  if (isMobile) {
    return (
      <ThumbSigner rows={rows}>
        <PageHead
          title={isAr ? 'اليوم' : 'Today'}
          sub={isAr
            ? `${dayName(todayIso, true)} ${shortDate(todayIso, true)} · ${num(mOpen + manualSorted.length, true)} مفتوحة، ${num(mLate.length + manualLateCount, true)} متأخرة`
            : `${dayName(todayIso, false)} ${shortDate(todayIso, false)} · ${mOpen + manualSorted.length} open, ${mLate.length + manualLateCount} late`}
        >
          <button type="button" className="btn btn-p btn-sm" onClick={() => setNewTask(true)}>
            {isAr ? 'مهمة جديدة' : 'New task'}
          </button>
        </PageHead>

        <div className="body">
          {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
          {loading && rows.length === 0 && <Skeleton rows={5} />}

          {linkedRow}
          {linkedItem}

          {rows.length > 0 && (
            <div className="m1-chips">
              {chipProjects.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`fbtn${chipProject === id ? ' on' : ''}`}
                  onClick={() => setChipProject((p) => (p === id ? null : id))}
                >
                  {projectName(id)}
                  {chipProject === id && <span className="x">×</span>}
                </button>
              ))}
              <button
                type="button"
                className={`fbtn${chipMine ? ' on' : ''}`}
                onClick={() => setChipMine((v) => !v)}
              >
                {isAr ? 'لي' : 'Mine'}
                {chipMine && <span className="x">×</span>}
              </button>
              <button
                type="button"
                className={`fbtn${chipVideo ? ' on' : ''}`}
                onClick={() => setChipVideo((v) => !v)}
              >
                {isAr ? 'فيديو' : 'Video'}
                {chipVideo && <span className="x">×</span>}
              </button>
            </div>
          )}

          {!loading && !error && mobileRows.length === 0 && mobileRowItems.length === 0
            && upcoming.length === 0 && manualSorted.length === 0 && (
            <Empty
              title={isAr ? 'لا مهام مفتوحة لديك' : 'Nothing open for you'}
            />
          )}

          {/* الصفوف — بطاقة واحدة لثلاثة منشورات، تتوسّع في مكانها. */}
          {mobileRowItems.length > 0 && (
            <div className="m1-lbl">{isAr ? 'دفعات سوشيال ميديا' : 'Social media batches'}</div>
          )}
          {mobileRowItems.map((it) => {
            const open = openRowId === it.facts.row_id;
            const day = it.facts.batch_day;
            const overdue = itemLate(it);
            return (
              <div key={it.facts.row_id} className={`m1-card${overdue ? ' late2' : ''}`}>
                {overdue && <span className="m1-pill late">{lateBy(it.task.due_at, isAr)}</span>}
                <div
                  className="m1-t"
                  style={{ marginTop: overdue ? 9 : 0 }}
                  role="button"
                  tabIndex={0}
                  onClick={() => expandRow(open ? null : it.facts.row_id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') expandRow(open ? null : it.facts.row_id); }}
                >
                  {isAr
                    ? `دفعة سوشيال ميديا ${day ? shortDate(day, true) : 'بلا يوم'} — ${it.facts.project_id ? projectName(it.facts.project_id) : 'عام'}`
                    : `Social media batch · ${day ? shortDate(day, false) : 'no day'} — ${it.facts.project_id ? projectName(it.facts.project_id) : 'general'}`}
                </div>
                <div className="m1-m">
                  {isAr
                    ? `${num(it.facts.member_count, true)} منشورات — مهمة واحدة · الأول في الترتيب يُنشر أخيرًا`
                    : `${it.facts.member_count} posts — one task · the first in the order publishes last`}
                  <br />
                  {it.task.waiting_since
                    ? waitingLabel(it.task, isAr)
                    : it.task.due_at
                      ? (isAr ? `آخر موعد للتسليم ${dateTimeShort(it.task.due_at, true)}` : `due ${dateTimeShort(it.task.due_at, false)}`)
                      : (isAr ? 'بلا موعد' : 'no due date')}
                </div>
                <button
                  type="button"
                  className="m1-btn p sm"
                  onClick={() => expandRow(open ? null : it.facts.row_id)}
                >
                  {open
                    ? (isAr ? 'طيّ' : 'Collapse')
                    : itemMine(it)
                      ? rowActionLabel(it.task.step_id, isAr)
                      : (isAr ? 'عرض الدفعة' : 'View the batch')}
                </button>
                {open && (
                  <div style={{ marginTop: 12 }}>
                    <RowPane rowId={it.facts.row_id} onChanged={() => void load()} />
                  </div>
                )}
              </div>
            );
          })}

          {/* المتأخر بطاقة حمراء منفصلة فوق الطيّة، لا صفّ في قائمة (s28). */}
          {mLate.map((r) => {
            const task = taskFor(r.id);
            return (
              <div
                key={r.id}
                className="m1-card late2"
                style={{ marginTop: 4 }}
                role="button"
                tabIndex={0}
                onClick={() => preview.open(r.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') preview.open(r.id); }}
              >
                <span className="m1-pill late">
                  {lateBy(r.current_task_due_at ?? r.due_at, isAr)}
                </span>
                <div className="m1-t" style={{ marginTop: 9 }}><LaneTag purpose={r.purpose} isAr={isAr} /> {statusLabel(r, isAr)}</div>
                <div className="m1-m">
                  <span className="ltr">{r.ref}</span> · {r.title}
                  {r.project_id && <> · <ProjectLink projectIds={[r.project_id]} variant="link" /></>}
                  {task && task.round > 1 && (
                    <>
                      <br />
                      {isAr ? `أُعيدت للجولة ${num(task.round, true)}` : `returned · round ${task.round}`}
                    </>
                  )}
                </div>
                {r.owner_role === myRole && (
                  <button
                    type="button"
                    className="m1-btn p sm"
                    onClick={(e) => { e.stopPropagation(); preview.open(r.id); }}
                  >
                    {actionLabel(r, isAr)}
                  </button>
                )}
              </div>
            );
          })}

          {/* Hand-assigned work — one full-width card each, one verb: «تم». */}
          {manualSorted.length > 0 && (
            <div className="m1-lbl">{isAr ? 'مهام مُسندة إليك' : 'Assigned to you'}</div>
          )}
          {manualSorted.map((t) => {
            const projectId = manualProjectId(t);
            return (
              <div key={t.id} className={`m1-card${manualOverdue(t) ? ' late2' : ''}`}>
                {manualOverdue(t) && (
                  <span className="m1-pill late">{lateBy(t.due_at, isAr)}</span>
                )}
                <div
                  className="m1-t"
                  style={{ marginTop: manualOverdue(t) ? 9 : 0 }}
                  role="button"
                  tabIndex={0}
                  onClick={() => openManual(t)}
                  onKeyDown={(e) => { if (e.key === 'Enter') openManual(t); }}
                >
                  {t.title}
                </div>
                <div className="m1-m">
                  {manualMeta(t)}
                  {t.due_at && !manualOverdue(t) && (
                    <>{manualMeta(t) ? ' · ' : ''}{isAr ? 'آخر موعد للتسليم ' : 'due '}{shortDate(t.due_at, isAr)}</>
                  )}
                </div>
                {projectId && (
                  <div style={{ marginTop: 6 }}>
                    <ProjectLink projectIds={[projectId]} />
                  </div>
                )}
                {!t.kind || t.kind === 'manual' ? (
                  <button
                    type="button"
                    className="m1-btn p sm"
                    disabled={closing === t.id}
                    onClick={() => void closeManual(t.id)}
                  >
                    {isAr ? 'تم' : 'Done'}
                  </button>
                ) : (
                  <button type="button" className="m1-btn p sm" onClick={() => openManual(t)}>
                    {manualVerb(t)}
                  </button>
                )}
              </div>
            );
          })}

          {mMine.length > 0 && (
            <div className="m1-lbl">{isAr ? 'مطلوب منك اليوم' : 'Yours today'}</div>
          )}
          {mMine.map((r, i) => (
            <div
              key={r.id}
              className={`m1-card${i === 0 ? ' hot' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => preview.open(r.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') preview.open(r.id); }}
            >
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <ContentThumb row={r} size="md" />
                <div className="m1-t" style={{ minWidth: 0 }}><LaneTag purpose={r.purpose} isAr={isAr} /> {statusLabel(r, isAr)}</div>
              </div>
              <div className="m1-m">
                <span className="ltr">{r.ref}</span> · {r.title} · {dueText(r)}
              </div>
              <button
                type="button"
                className={`m1-btn sm${isScheduleStep(r) ? ' g' : ''}`}
                onClick={(e) => { e.stopPropagation(); preview.open(r.id); }}
              >
                {actionLabel(r, isAr)}
              </button>
            </div>
          ))}

          {/* «القادم إليك» — visible preparation, explicitly NOT tasks. */}
          {upcoming.length > 0 && (
            <>
              <div className="m1-lbl">
                {isAr ? 'القادم إليك — ليست مهامًا بعد' : 'Coming to you — not tasks yet'}
              </div>
              {upcoming.map((u) => (
                <div
                  key={`${u.content_id}:${u.step_key}`}
                  className="m1-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(upcomingHref(u))}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate(upcomingHref(u)); }}
                >
                  <div className="m1-row">
                    <span className="m1-t" style={{ fontSize: 14 }}>
                      {isAr ? u.step_label_ar : u.step_label_en}
                    </span>
                    <Pill tone="idle">
                      {u.steps_away <= 1
                        ? isAr ? 'الخطوة التالية' : 'next step'
                        : isAr ? `بعد ${num(u.steps_away, true)} خطوات` : `${u.steps_away} steps away`}
                    </Pill>
                  </div>
                  <div className="m1-m">
                    <span className="ltr">{u.ref ?? ''}</span> · {u.title}
                  </div>
                </div>
              ))}
            </>
          )}

          {mOthers.length > 0 && (
            <div className="m1-lbl">{isAr ? 'بانتظار شخص آخر' : 'Waiting on someone else'}</div>
          )}
          {mOthers.map((r) => (
            <div
              key={r.id}
              className="m1-card faded"
              role="button"
              tabIndex={0}
              onClick={() => preview.open(r.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') preview.open(r.id); }}
            >
              <div className="m1-t" style={{ fontSize: 14 }}>
                <span className="ltr">{r.ref}</span>
                {' · '}
                {isAr
                  ? `لدى ${holderName(r)}، ${daysAgo(r.updated_at, true)}`
                  : `with ${holderName(r)}, ${daysAgo(r.updated_at, false)}`}
              </div>
            </div>
          ))}
        </div>

        {preview.node}

        {newTask && (
          <NewTaskModal onClose={() => setNewTask(false)} onSaved={() => void load()} />
        )}
      </ThumbSigner>
    );
  }

  return (
    <ThumbSigner rows={rows}>
      <PageHead
        title={isAr ? 'مهامي' : 'My work'}
        sub={isAr
          ? `${roleLabel} · ${num(mine.length + late.length + manualSorted.length, true)} مفتوحة، ${num(late.length + manualLateCount, true)} متأخرة`
          : `${roleLabel} · ${mine.length + late.length + manualSorted.length} open, ${late.length + manualLateCount} late`}
      >
        {canSeeTeam && (
          <div className="seg">
            <button type="button" className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>
              {isAr ? 'مهامي' : 'Mine'}
            </button>
            <button type="button" className={scope === 'team' ? 'on' : ''} onClick={() => setScope('team')}>
              {isAr ? 'الجميع' : 'Everyone'}
            </button>
          </div>
        )}
        {/* Everyone can give themselves a task; assigning to someone else is
            gated inside the modal by the `assign_task` capability. */}
        <button type="button" className="btn btn-p" onClick={() => setNewTask(true)}>
          {isAr ? 'مهمة جديدة' : 'New task'}
        </button>
        <div className="search">
          <IconSearch />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={isAr ? 'ابحث في مهامي' : 'Search my work'}
          />
        </div>
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && rows.length === 0 && <Skeleton rows={5} />}

        {linkedRow}
          {linkedItem}

        {!loading && filtered.length === 0 && upcoming.length === 0
          && manualSorted.length === 0 && !error && (
          <Empty
            title={isAr ? 'لا مهام مفتوحة لديك' : 'Nothing open for you'}
          />
        )}

        <QueueGroup
          label={isAr ? 'متأخر' : 'Late'}
          tone="late"
          items={late}
          ctx={groupCtx}
        />
        <ManualBlock />
        <QueueGroup
          label={isAr ? 'مطلوب منك اليوم' : 'Yours today'}
          tone="now"
          items={mine}
          ctx={groupCtx}
        />

        {/* «القادم إليك» — visible preparation, explicitly NOT tasks. */}
        {upcoming.length > 0 && (
          <>
            <div className="lbl" style={{ marginBottom: 9 }}>
              {isAr ? 'القادم إليك — ليست مهامًا بعد' : 'Coming to you — not tasks yet'}
            </div>
            <div className="card" style={{ marginBottom: 22 }}>
              <div className="card-b" style={{ padding: '10px 14px 12px' }}>
                {upcoming.map((u) => (
                  <button
                    key={`${u.content_id}:${u.step_key}`}
                    type="button"
                    className="up-row"
                    onClick={() => navigate(upcomingHref(u))}
                  >
                    <span className="up-row-main">
                      <b className="ltr">{u.ref ?? ''}</b>
                      {' · '}
                      {u.title}
                      {' · '}
                      <span style={{ color: 'var(--ink-2)' }}>
                        {isAr ? u.step_label_ar : u.step_label_en}
                      </span>
                    </span>
                    <Pill tone="idle">
                      {u.steps_away <= 1
                        ? isAr ? 'قادم إليك · الخطوة التالية' : 'next step'
                        : isAr ? `قادم إليك · بعد ${num(u.steps_away, true)} خطوات` : `${u.steps_away} steps away`}
                    </Pill>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        <QueueGroup
          label={isAr ? 'بانتظار شخص آخر — لا إجراء منك' : 'Waiting on someone else — no action from you'}
          tone="idle"
          items={others}
          faded
          ctx={groupCtx}
        />
      </div>

      {preview.node}

      {newTask && (
        <NewTaskModal onClose={() => setNewTask(false)} onSaved={() => void load()} />
      )}
    </ThumbSigner>
  );
}
