/**
 * Team work — design screen 35 (متابعة الفريق).
 *
 * «مشرف» means seeing EVERYONE's queue, not your own. The one job is balancing
 * the load before it becomes a delay: the four tiles are ROLES not people («لو
 * انضم كاتب ثانٍ، يعرض العمود مجموع الدور»), the table is every open task
 * ordered by how long it has been stuck, and the imbalance card only ever
 * proposes postpone / bring-forward — never moving one role's work to another
 * («الأدوار ليست قابلة للتبادل» مكتوبة في الواجهة).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosContentRow,
  MosManualTask,
  MosRole,
  MosTask,
  ROLE_LABELS,
  cancelManualTask,
  fetchWork,
  isOverdue,
  remindContent,
  statusLabel,
  transferTask,
  updateTask,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, LoadError, Modal, PageHead, RoleChip, Skeleton, Stat } from './components/kit';
import NewTaskModal from './components/NewTaskModal';
import { daysAgo, daysFromNow, num, shortDate } from './lib/format';

/** The tile order, transcribed from the mockup: writer, editor, ops, manager. */
const TILE_ROLES: MosRole[] = ['writer', 'montage', 'ops_supervisor', 'marketing_manager'];

type SortMode = 'role' | 'project' | 'due';

const DAY_MS = 86_400_000;

function staleDays(r: MosContentRow): number {
  return (Date.now() - new Date(r.updated_at).getTime()) / DAY_MS;
}

function dueLabel(r: MosContentRow, isAr: boolean): string {
  const due = r.current_task_due_at ?? r.due_at;
  if (!due) return '—';
  const d = daysFromNow(due);
  if (d === 0) return isAr ? 'اليوم' : 'today';
  return shortDate(due, isAr);
}

export default function TeamPage() {
  const { isAr, role: myRole, projectName, people, can, surfaces, ready } = useWorkspace();
  const navigate = useNavigate();
  // Team work is EVERYONE's queue — gated by the `team` surface (CEO + marketing
  // manager by default). A role whose team surface is hidden is bounced back to
  // its own queue, so a direct /m/team URL cannot expose the whole team's tasks.
  // (The server's work_list also downgrades a hidden-surface caller to 'mine',
  // so no team data loads even for the instant before this redirect fires.)
  useEffect(() => {
    if (ready && surfaces.team === 'hidden') navigate('/m/my-work', { replace: true });
  }, [ready, surfaces.team, navigate]);
  const addToast = useAppStore((s) => s.addToast);

  const [rows, setRows] = useState<MosContentRow[]>([]);
  const [tasks, setTasks] = useState<MosTask[]>([]);
  const [manual, setManual] = useState<MosManualTask[]>([]);
  const [assigning, setAssigning] = useState(false);
  const [editTask, setEditTask] = useState<MosManualTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<SortMode>('role');
  const [busy, setBusy] = useState(false);
  const [transfer, setTransfer] = useState<MosContentRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWork('team');
      setRows(res.content);
      setTasks(res.tasks);
      setManual(res.manual_tasks ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const late = useMemo(() => rows.filter((r) => isOverdue(r)), [rows]);

  const roleStats = useMemo(() => TILE_ROLES.map((r) => {
    const items = rows.filter((x) => x.owner_role === r);
    return { role: r, open: items.length, late: items.filter((x) => isOverdue(x)).length };
  }), [rows]);

  const maxOpen = Math.max(1, ...roleStats.map((s) => s.open));
  // The overloaded role: the most late work; ties broken by the biggest queue.
  const overloaded = [...roleStats].sort((a, b) => b.late - a.late || b.open - a.open)[0];
  const idleRole = roleStats.find((s) => s.open === 0 && s.role !== overloaded?.role) ?? null;
  const leastLoaded = [...roleStats].filter((s) => s.open > 0)
    .sort((a, b) => a.open - b.open)[0] ?? null;
  const imbalanced = overloaded !== undefined
    && overloaded.open >= 2
    && (idleRole !== null || overloaded.open >= (leastLoaded?.open ?? 0) + 2);

  const taskFor = (contentId: string): MosTask | undefined =>
    tasks.find((t) => t.content_id === contentId);

  /* ── hand-assigned tasks across the team ─────────────────────────────── */

  const manualSorted = useMemo(
    () => [...manual].sort((a, b) => {
      if (!a.due_at) return 1;
      if (!b.due_at) return -1;
      return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
    }),
    [manual],
  );

  const personName = (userId: string | null): string => {
    if (!userId) return isAr ? 'غير مسند' : 'unassigned';
    const p = people.find((x) => x.user_id === userId);
    if (!p) return isAr ? 'غير معروف' : 'unknown';
    return (isAr ? p.name_ar ?? p.name_en : p.name_en ?? p.name_ar) ?? p.email ?? userId.slice(0, 8);
  };

  const cancelManual = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await cancelManualTask(id);
      addToast(isAr ? 'أُلغيت المهمة.' : 'Task cancelled.', 'success');
      await load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const sorted = useMemo(() => {
    const copy = [...rows];
    const roleRank = (r: MosContentRow): number => {
      const i = TILE_ROLES.indexOf(r.owner_role as MosRole);
      return i === -1 ? TILE_ROLES.length : i;
    };
    if (mode === 'role') {
      copy.sort((a, b) => roleRank(a) - roleRank(b) || staleDays(b) - staleDays(a));
    } else if (mode === 'project') {
      copy.sort((a, b) =>
        projectName(a.project_id).localeCompare(projectName(b.project_id), isAr ? 'ar' : 'en')
        || staleDays(b) - staleDays(a));
    } else {
      const due = (r: MosContentRow): number =>
        new Date(r.current_task_due_at ?? r.due_at ?? '9999-12-31').getTime();
      copy.sort((a, b) => due(a) - due(b));
    }
    return copy;
  }, [rows, mode, projectName, isAr]);

  const remindOne = async (contentId: string) => {
    try {
      await remindContent(contentId);
      addToast(isAr ? 'أُرسل التذكير إلى صاحب المهمة' : 'Reminder sent to the task holder', 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  const remindAllLate = async () => {
    setBusy(true);
    try {
      const results = await Promise.allSettled(late.map((r) => remindContent(r.id)));
      const sent = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - sent;
      if (failed > 0) {
        addToast(isAr
          ? `أُرسل ${num(sent, true)} تذكيرًا وتعذّر ${num(failed, true)}`
          : `${sent} reminders sent, ${failed} failed`, 'error');
      } else {
        addToast(isAr
          ? `أُرسل ${num(sent, true)} تذكيرًا لأصحاب المتأخر`
          : `${sent} reminders sent to everyone late`, 'success');
      }
    } finally {
      setBusy(false);
    }
  };

  /** «تأجيل» — push a task's due date out two days (task_update). */
  const postpone = async (contentId: string) => {
    const task = taskFor(contentId);
    if (!task) return;
    setBusy(true);
    try {
      const base = task.due_at ? new Date(task.due_at).getTime() : Date.now();
      await updateTask(task.id, { due_at: new Date(base + 2 * DAY_MS).toISOString() });
      addToast(isAr ? 'أُجّل الاستحقاق يومين' : 'Due date postponed two days', 'success');
      await load();
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** «تقديم» — pull a task's due date to tomorrow so it leads the queue. */
  const bringForward = async (contentId: string) => {
    const task = taskFor(contentId);
    if (!task) return;
    setBusy(true);
    try {
      await updateTask(task.id, { due_at: new Date(Date.now() + DAY_MS).toISOString() });
      addToast(isAr ? 'قُدّم الاستحقاق إلى الغد' : 'Due date brought forward to tomorrow', 'success');
      await load();
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const doTransfer = async (toUserId: string) => {
    if (!transfer) return;
    const task = taskFor(transfer.id);
    if (!task) return;
    setBusy(true);
    try {
      await transferTask(task.id, toUserId);
      addToast(isAr ? 'نُقلت المهمة' : 'Task transferred', 'success');
      setTransfer(null);
      await load();
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  // The imbalance card acts on two concrete tasks: the overloaded role's
  // latest-due task (postpone), and the lightest role's earliest-due one
  // (bring forward). Roles are not interchangeable — the card says so.
  const overloadedRows = rows.filter((r) => r.owner_role === overloaded?.role);
  const postponeTarget = [...overloadedRows].sort((a, b) =>
    new Date(b.current_task_due_at ?? b.due_at ?? 0).getTime()
    - new Date(a.current_task_due_at ?? a.due_at ?? 0).getTime())[0];
  const forwardRows = rows.filter((r) => r.owner_role === leastLoaded?.role);
  const forwardTarget = [...forwardRows].sort((a, b) =>
    new Date(a.current_task_due_at ?? a.due_at ?? '9999-12-31').getTime()
    - new Date(b.current_task_due_at ?? b.due_at ?? '9999-12-31').getTime())[0];

  // The approvals split — creative sits with the manager, process with ops.
  const creativeApprovals = tasks.filter((t) => t.is_approval && t.approval_kind === 'creative').length;
  const processApprovals = tasks.filter((t) => t.is_approval && t.approval_kind === 'process').length;

  const roleName = (r: MosRole): string =>
    ROLE_LABELS[r] ? (isAr ? ROLE_LABELS[r].ar : ROLE_LABELS[r].en) : r;

  const transferCandidates = transfer
    ? people.filter((p) => transfer.owner_role && p.roles.includes(transfer.owner_role))
    : [];

  return (
    <>
      <PageHead
        title={isAr ? 'متابعة الفريق' : 'Team work'}
        sub={isAr
          ? `${roleName(myRole)} · ${num(rows.length, true)} مهمة مفتوحة · ${num(late.length, true)} متأخرة`
          : `${roleName(myRole)} · ${rows.length} open · ${late.length} late`}
      >
        <div className="seg">
          <button type="button" className={mode === 'role' ? 'on' : ''} onClick={() => setMode('role')}>
            {isAr ? 'حسب الدور' : 'By role'}
          </button>
          <button type="button" className={mode === 'project' ? 'on' : ''} onClick={() => setMode('project')}>
            {isAr ? 'حسب المشروع' : 'By project'}
          </button>
          <button type="button" className={mode === 'due' ? 'on' : ''} onClick={() => setMode('due')}>
            {isAr ? 'حسب الاستحقاق' : 'By due date'}
          </button>
        </div>
        {/* Hand-assigning work needs `assign_task` — the CEO and the marketing
            manager hold it, the workflow-only roles do not. */}
        {can('assign_task') && (
          <button type="button" className="btn" onClick={() => setAssigning(true)}>
            {isAr ? 'إسناد مهمة' : 'Assign task'}
          </button>
        )}
        <button
          type="button"
          className="btn btn-p"
          disabled={busy || late.length === 0}
          onClick={() => void remindAllLate()}
        >
          {isAr ? 'تذكير الجميع بالمتأخر' : 'Remind everyone late'}
        </button>
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && rows.length === 0 && <Skeleton rows={5} />}

        {!loading && rows.length === 0 && manualSorted.length === 0 && !error && (
          <Empty
            title={isAr ? 'لا عمل مفتوح' : 'No open work'}
            body={isAr
              ? 'لا يوجد عنصر تحت الإنتاج الآن.'
              : 'Nothing is in production right now.'}
          />
        )}

        {rows.length > 0 && (
          <>
            <div className="grid g4" style={{ marginBottom: 18 }}>
              {roleStats.map((s) => {
                const isOverloaded = overloaded !== undefined && s.role === overloaded.role
                  && s.open === overloaded.open && (s.late > 0 || imbalanced);
                return (
                  <Stat
                    key={s.role}
                    isAr={isAr}
                    alert={isOverloaded}
                    label={roleName(s.role)}
                    value={s.open}
                    detail={
                      s.open === 0
                        ? isAr ? 'فارغ حاليًا' : 'empty right now'
                        : isOverloaded
                          ? isAr
                            ? `${num(s.late, true)} متأخرة · محمّل بأكثر من طاقته`
                            : `${s.late} late · overloaded`
                          : s.late > 0
                            ? isAr ? `${num(s.late, true)} متأخرة` : `${s.late} late`
                            : isAr ? 'لا متأخرات' : 'nothing late'
                    }
                    meter={[{
                      pct: (s.open / maxOpen) * 100,
                      color: isOverloaded ? 'var(--late)'
                        : s.role === 'marketing_manager' ? 'var(--wait)' : 'var(--copper)',
                    }]}
                  />
                );
              })}
            </div>

            <div className="grid main-rail-16">
              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'كل المهام المفتوحة' : 'Every open task'}</h4>
                  <span className="r">
                    {mode === 'role'
                      ? isAr ? 'مرتبة بمدة التوقف' : 'longest stalled first'
                      : mode === 'project'
                        ? isAr ? 'مرتبة بالمشروع' : 'by project'
                        : isAr ? 'مرتبة بالاستحقاق' : 'by due date'}
                  </span>
                </div>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th style={{ width: 60 }}>{isAr ? 'الرقم' : 'Ref'}</th>
                        <th>{isAr ? 'المهمة' : 'Task'}</th>
                        <th style={{ width: 126 }}>{isAr ? 'الدور' : 'Role'}</th>
                        <th style={{ width: 100 }}>{isAr ? 'الاستحقاق' : 'Due'}</th>
                        <th className="num" style={{ width: 70 }}>{isAr ? 'متوقفة' : 'Stalled'}</th>
                        <th style={{ width: 130 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((r) => {
                        const overdue = isOverdue(r);
                        const stale = staleDays(r);
                        return (
                          <tr
                            key={r.id}
                            className={`click${overdue ? ' hl' : ''}`}
                            onClick={() => navigate(`/m/content/${r.id}`)}
                          >
                            <td className="id">{r.ref ?? '—'}</td>
                            <td className="ttl">{statusLabel(r, isAr)} · {r.title}</td>
                            <td><RoleChip role={r.owner_role} isAr={isAr} /></td>
                            <td style={overdue ? { color: 'var(--late)', fontWeight: 700 } : undefined}>
                              {dueLabel(r, isAr)}
                            </td>
                            <td
                              className="num"
                              style={stale >= 3 ? { color: 'var(--late)', fontWeight: 700 } : undefined}
                            >
                              {stale >= 1 ? daysAgo(r.updated_at, isAr) : '—'}
                            </td>
                            <td onClick={(e) => e.stopPropagation()}>
                              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                {(overdue || stale >= 2) && (
                                  <button
                                    type="button"
                                    className="btn btn-sm"
                                    disabled={busy}
                                    onClick={() => void remindOne(r.id)}
                                  >
                                    {isAr ? 'تذكير' : 'Remind'}
                                  </button>
                                )}
                                {stale >= 3 && (
                                  <button
                                    type="button"
                                    className="btn btn-sm"
                                    disabled={busy}
                                    onClick={() => setTransfer(r)}
                                  >
                                    {isAr ? 'نقل' : 'Move'}
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
                {imbalanced && overloaded && (
                  <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--late) 38%, transparent)' }}>
                    <div className="card-h" style={{ background: 'color-mix(in srgb, var(--late) 6%, transparent)' }}>
                      <h4>{isAr ? 'اختلال في الحمل' : 'Load imbalance'}</h4>
                    </div>
                    <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
                      <div>
                        <b>{roleName(overloaded.role)}</b>
                        {isAr
                          ? ` عليه ${num(overloaded.open, true)} مهام مفتوحة${overloaded.late > 0 ? `، ${num(overloaded.late, true)} منها متأخرة` : ''}.`
                          : ` holds ${overloaded.open} open tasks${overloaded.late > 0 ? `, ${overloaded.late} of them late` : ''}.`}
                      </div>
                      {idleRole && (
                        <div style={{ marginTop: 9 }}>
                          <b>{roleName(idleRole.role)}</b>
                          {isAr ? ' طابوره فارغ الآن ولا شيء بعده.' : ' — queue empty, nothing behind it.'}
                        </div>
                      )}
                      <div style={{ marginTop: 11, paddingTop: 10, borderTop: '1px solid var(--line-soft)' }}>
                        {isAr ? (
                          <>
                            لا يمكن نقل عمل دور إلى دور آخر — الأدوار ليست قابلة للتبادل. لكن يمكن
                            {postponeTarget && <> <b>تأجيل {postponeTarget.ref}</b></>}
                            {forwardTarget && <> أو <b>تقديم {forwardTarget.ref}</b></>}.
                          </>
                        ) : (
                          <>
                            One role’s work cannot move to another — roles are not interchangeable.
                            But you can{postponeTarget && <> <b>postpone {postponeTarget.ref}</b></>}
                            {forwardTarget && <> or <b>bring {forwardTarget.ref} forward</b></>}.
                          </>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                        {postponeTarget && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            style={{ flex: 1, justifyContent: 'center' }}
                            disabled={busy}
                            onClick={() => void postpone(postponeTarget.id)}
                          >
                            {isAr ? `تأجيل ${postponeTarget.ref ?? ''}` : `Postpone ${postponeTarget.ref ?? ''}`}
                          </button>
                        )}
                        {forwardTarget && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            style={{ flex: 1, justifyContent: 'center' }}
                            disabled={busy}
                            onClick={() => void bringForward(forwardTarget.id)}
                          >
                            {isAr ? `تقديم ${forwardTarget.ref ?? ''}` : `Bring fwd ${forwardTarget.ref ?? ''}`}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="card">
                  <div className="card-h">
                    <h4>{isAr ? 'الاعتمادات المعلّقة' : 'Pending approvals'}</h4>
                    <span className="r">{num(creativeApprovals + processApprovals, isAr)}</span>
                  </div>
                  <div className="card-b" style={{ display: 'grid', gap: 9, fontSize: 12 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span className="av a-r">{isAr ? 'ر' : 'M'}</span>
                      <span style={{ flex: 1 }}>
                        {isAr ? 'إبداعي · مدير التسويق' : 'Creative · marketing manager'}
                      </span>
                      <span className="pill p-late">{num(creativeApprovals, isAr)}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span className="av a-n">{isAr ? 'ن' : 'O'}</span>
                      <span style={{ flex: 1 }}>
                        {isAr
                          ? `إجرائي · ${myRole === 'ops_supervisor' ? 'أنت' : 'مشرف العمليات'}`
                          : `Process · ${myRole === 'ops_supervisor' ? 'you' : 'ops supervisor'}`}
                      </span>
                      <span className="pill p-now">{num(processApprovals, isAr)}</span>
                    </div>
                    <div style={{
                      fontSize: 11, color: 'var(--mute)', marginTop: 5,
                      paddingTop: 9, borderTop: '1px solid var(--line-soft)', lineHeight: 1.75,
                    }}>
                      {isAr
                        ? 'قبل فصل الاعتمادات كانت كلها عند مدير التسويق. هذا هو الفرق عمليًا.'
                        : 'Before the split, every approval sat with the marketing manager. This is the difference, in practice.'}
                    </div>
                  </div>
                </div>

                {myRole === 'ops_supervisor' && (
                  <div className="card">
                    <div className="card-h"><h4>{isAr ? 'ما لا تستطيع فعله' : 'What you cannot do'}</h4></div>
                    <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--mute)' }}>
                      {isAr ? (
                        <>
                          لا تعتمد نصًا ولا تصميمًا — ذلك إبداعي. تستطيع <b>النقل، والتأجيل، والتذكير،
                          وإعادة الترتيب</b>، واعتماد اكتمال المواد وصحة الجدولة.
                        </>
                      ) : (
                        <>
                          You approve neither copy nor design — that is creative. You can <b>move,
                          postpone, remind, and reorder</b>, and approve material completeness and
                          schedule correctness.
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* Hand-assigned work, team-wide. Outside the `rows.length > 0` board on
            purpose: a team can have manual tasks open with nothing in
            production, and that queue must still be visible. */}
        {manualSorted.length > 0 && (
          <div className="card" style={{ marginTop: 18 }}>
            <div className="card-h">
              <h4>{isAr ? 'مهام مُسندة يدويًا' : 'Hand-assigned tasks'}</h4>
              <span className="r">
                {isAr ? 'خارج مسارات العمل' : 'outside the workflows'}
              </span>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{isAr ? 'المهمة' : 'Task'}</th>
                    <th style={{ width: 150 }}>{isAr ? 'المسؤول' : 'Assigned to'}</th>
                    <th style={{ width: 110 }}>{isAr ? 'الاستحقاق' : 'Due'}</th>
                    <th style={{ width: 150 }} />
                  </tr>
                </thead>
                <tbody>
                  {manualSorted.map((t) => {
                    const overdue = Boolean(t.due_at)
                      && new Date(t.due_at as string).getTime() < Date.now();
                    return (
                      <tr key={t.id} className={overdue ? 'hl' : undefined}>
                        <td className="ttl">
                          {t.title}
                          {t.series_id && (
                            <span style={{ color: 'var(--mute)', fontWeight: 400 }}>
                              {isAr ? ' · متكررة' : ' · repeating'}
                            </span>
                          )}
                        </td>
                        <td>{personName(t.assignee_user_id)}</td>
                        <td style={overdue ? { color: 'var(--late)', fontWeight: 700 } : undefined}>
                          {t.due_at ? shortDate(t.due_at, isAr) : '—'}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            {can('assign_task') && (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  disabled={busy}
                                  onClick={() => setEditTask(t)}
                                >
                                  {isAr ? 'تعديل' : 'Edit'}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  disabled={busy}
                                  onClick={() => void cancelManual(t.id)}
                                >
                                  {isAr ? 'إلغاء' : 'Cancel'}
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {(assigning || editTask) && (
        <NewTaskModal
          task={editTask}
          onClose={() => { setAssigning(false); setEditTask(null); }}
          onSaved={() => void load()}
        />
      )}

      {transfer && (
        <Modal
          title={isAr ? `نقل ${transfer.ref ?? ''}` : `Move ${transfer.ref ?? ''}`}
          sub={isAr
            ? `تبقى المهمة داخل دور «${transfer.owner_role ? roleName(transfer.owner_role) : ''}» — النقل إلى شخص آخر من نفس الدور.`
            : 'The task stays inside its role — move it to another person holding the same role.'}
          onClose={() => setTransfer(null)}
        >
          {transferCandidates.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--mute)', lineHeight: 1.8 }}>
              {isAr
                ? 'لا أحد آخر يحمل هذا الدور حاليًا — تُدار الأدوار من الإعدادات ← الأدوار.'
                : 'Nobody else holds this role right now — roles are managed in Settings → Roles.'}
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {transferCandidates.map((p) => (
                <button
                  key={p.user_id}
                  type="button"
                  className="btn"
                  style={{ justifyContent: 'flex-start' }}
                  disabled={busy}
                  onClick={() => void doTransfer(p.user_id)}
                >
                  {(isAr ? p.name_ar : p.name_en) ?? p.name_ar ?? p.email ?? p.user_id}
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
