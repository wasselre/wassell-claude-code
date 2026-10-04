/**
 * Settings → Roles and who fills them — design screen 37.
 *
 * The ONE place in the system that binds a role to a person. Everything else
 * points at the role, so changing who fills it here re-routes every FUTURE
 * task without touching a single workflow. Multi-role is canonical — one
 * person may hold two roles and the system treats them as two.
 *
 * The screen also owns the explicit OPEN-TASK TRANSFER flow: future tasks
 * follow the new holder automatically, but open ones stay with the old holder
 * until they are moved by hand — `task_transfer`, one task at a time, on
 * purpose. History is never rewritten.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  ACTIVE_PATH_ROLES, MosContentRow, MosPathRole, MosTask, ROLE_LABELS, RolePerson, StepDef, WorkflowDef,
  fetchWork, grantRole, transferTask,
} from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { Modal, PageHead, Pill } from './kit';
import { IconBack, IconForward } from './icons';
import { initial, money, num, roleAvatarClass } from '../lib/format';

/** The grantable roles (CEO and Operations supervisor retired 2026-10-04). */
const ROLE_ROWS = ACTIVE_PATH_ROLES;

const KIND_LABELS: Record<'creative' | 'process' | 'budget', { ar: string; en: string }> = {
  creative: { ar: 'الاعتماد الإبداعي', en: 'Creative approval' },
  process:  { ar: 'الاعتماد الإجرائي', en: 'Process approval' },
  budget:   { ar: 'توقيع الميزانية',   en: 'Budget signature' },
};

function roleLabel(role: string, isAr: boolean): string {
  const l = ROLE_LABELS[role as MosPathRole];
  return l ? (isAr ? l.ar : l.en) : role;
}

function personName(p: RolePerson, isAr: boolean): string {
  return (isAr ? p.name_ar : p.name_en) ?? p.name_en ?? p.name_ar ?? p.email ?? '—';
}

export default function SettingsPeople({
  workflows, settings, canManage, isAr,
}: {
  workflows: WorkflowDef[];
  settings: Record<string, unknown>;
  canManage: boolean;
  isAr: boolean;
}) {
  const { people, reloadGrants } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;

  /* ── open tasks (team scope) — counts + the transfer flow ── */
  const [tasks, setTasks] = useState<MosTask[]>([]);
  const [taskContent, setTaskContent] = useState<MosContentRow[]>([]);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setTasksError(null);
    try {
      const res = await fetchWork('team');
      setTasks(res.tasks.filter((t) => t.status === 'open'));
      setTaskContent(res.content);
    } catch (e) {
      setTasksError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void loadTasks(); }, [loadTasks]);

  /* ── derived facts ── */

  const holdersOf = useCallback(
    (role: MosPathRole): RolePerson[] => people.filter((p) => p.roles.includes(role)),
    [people],
  );

  /** Approval kinds per role, read from the CANONICAL paths — never hardcoded. */
  const approvalKinds = useMemo(() => {
    const m = new Map<string, Set<NonNullable<StepDef['approval_kind']>>>();
    for (const w of workflows) {
      for (const s of w.steps) {
        if (!s.is_approval) continue;
        const set = m.get(s.role_key) ?? new Set();
        set.add(s.approval_kind ?? 'creative');
        m.set(s.role_key, set);
      }
    }
    // The budget signature is settings-driven (campaign_sign), not a path step;
    // it is the Manager's since the CEO role was retired.
    const mgr = m.get('marketing_manager') ?? new Set();
    mgr.add('budget');
    m.set('marketing_manager', mgr);
    return m;
  }, [workflows]);

  const signatureThreshold = useMemo(() => {
    const amount = (settings.signature_threshold as { amount?: unknown } | undefined)?.amount;
    return typeof amount === 'number' && Number.isFinite(amount) ? amount : 50_000;
  }, [settings]);

  const openTaskCount = useCallback(
    (role: MosPathRole): number => tasks.filter((t) => t.role === role).length,
    [tasks],
  );

  /** Approval roles that a single absence would stall. */
  const noBackupRoles = useMemo(
    () => ROLE_ROWS.filter((r) => (approvalKinds.get(r)?.size ?? 0) > 0
      && holdersOf(r).length <= 1),
    [approvalKinds, holdersOf],
  );

  /* ── modals ── */
  const [editingRole, setEditingRole] = useState<MosPathRole | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const toggleGrant = async (userId: string, role: MosPathRole, grant: boolean): Promise<void> => {
    setBusy(`${userId}:${role}`);
    try {
      await grantRole(userId, role, grant);
      await reloadGrants();
      addToast(isAr ? 'تم تحديث الدور.' : 'Role updated.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const subCounts = isAr
    ? `${num(ROLE_ROWS.length, true)} أدوار · ${num(people.length, true)} أشخاص · ${
      noBackupRoles.length === 0
        ? 'لكل اعتماد أكثر من شاغل'
        : noBackupRoles.length === 1 ? 'دور واحد بلا بديل' : `${num(noBackupRoles.length, true)} أدوار بلا بديل`}`
    : `${ROLE_ROWS.length} roles · ${people.length} people · ${
      noBackupRoles.length === 0
        ? 'every approval has more than one holder'
        : noBackupRoles.length === 1 ? 'one role has no backup' : `${noBackupRoles.length} roles have no backup`}`;

  return (
    <>
      <PageHead
        title={isAr ? 'الأدوار ومن يشغلها' : 'Roles and who fills them'}
        sub={subCounts}
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      >
        {canManage && (
          <button type="button" className="btn btn-p" onClick={() => setTransferOpen(true)}>
            {isAr ? 'نقل المهام المفتوحة' : 'Transfer open tasks'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {tasksError && (
          <div className="notice bad" role="alert" style={{ marginBottom: 14 }}>
            {isAr ? 'تعذّر تحميل المهام المفتوحة: ' : 'Open tasks could not load: '}{tasksError}
          </div>
        )}

        {/* ── the role table — screen 37's centrepiece ── */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 190 }}>{isAr ? 'الدور' : 'Role'}</th>
                  <th style={{ width: 170 }}>{isAr ? 'يشغله' : 'Filled by'}</th>
                  <th style={{ width: 170 }}>{isAr ? 'البديل عند الغياب' : 'Backup when away'}</th>
                  <th>{isAr ? 'يعتمد' : 'Approves'}</th>
                  <th className="num" style={{ width: 100 }}>{isAr ? 'مهام مفتوحة' : 'Open tasks'}</th>
                  <th style={{ width: 80 }} />
                </tr>
              </thead>
              <tbody>
                {ROLE_ROWS.map((r) => {
                  const holders = holdersOf(r);
                  const kinds = [...(approvalKinds.get(r) ?? [])];
                  const approves = kinds.length > 0;
                  const warn = approves && holders.length <= 1;
                  return (
                    <tr key={r} style={warn ? { background: 'color-mix(in srgb, var(--late) 5%, transparent)' } : undefined}>
                      <td>
                        <div className="who">
                          <span className={`av ${roleAvatarClass(r)}`}>{initial(roleLabel(r, isAr))}</span>
                          <b>{roleLabel(r, isAr)}</b>
                        </div>
                      </td>
                      <td>
                        {holders.length > 0
                          ? holders.map((p) => personName(p, isAr)).join(isAr ? '، ' : ', ')
                          : <span style={{ color: 'var(--late)', fontWeight: 700 }}>{isAr ? 'بلا شاغل' : 'Unfilled'}</span>}
                      </td>
                      <td>
                        {!approves ? (
                          <span style={{ color: 'var(--mute)' }}>{isAr ? 'لا يعتمد — لا حاجة' : 'Approves nothing — not needed'}</span>
                        ) : holders.length >= 2 ? (
                          holders.slice(1).map((p) => personName(p, isAr)).join(isAr ? '، ' : ', ')
                        ) : (
                          <span style={{ color: 'var(--late)', fontWeight: 700 }}>{isAr ? 'بلا بديل' : 'No backup'}</span>
                        )}
                      </td>
                      <td>
                        {approves ? (
                          <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                            {kinds.map((k) => (
                              <span key={k} className="tag">
                                {k === 'budget'
                                  ? (isAr ? `ميزانية فوق ${money(signatureThreshold, true)}` : `Budget above ${money(signatureThreshold, false)}`)
                                  : (isAr ? KIND_LABELS[k].ar : KIND_LABELS[k].en)}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--mute)' }}>—</span>
                        )}
                      </td>
                      <td className="num">{tasksError ? '—' : num(openTaskCount(r), isAr)}</td>
                      <td>
                        {canManage && (
                          <button type="button" className="btn btn-sm" onClick={() => setEditingRole(r)}>
                            {isAr ? 'تعديل' : 'Edit'}
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

        {/* ── the three cards under the table ── */}
        <div className="grid g2" style={{ marginBottom: 16 }}>
          {noBackupRoles.length > 0 ? (
            <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--late) 38%, transparent)' }}>
              <div className="card-h" style={{ background: 'color-mix(in srgb, var(--late) 6%, transparent)' }}>
                <h4>
                  {isAr
                    ? `خطر: ${roleLabel(noBackupRoles[0] ?? 'writer', true)} بلا بديل`
                    : `Risk: ${roleLabel(noBackupRoles[0] ?? 'writer', false)} has no backup`}
                </h4>
              </div>
              <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
                {isAr
                  ? <>كل اعتماد يمر بشخص واحد. سفره ثلاثة أيام يوقف <b>كل</b> محتوى في مرحلة مراجعة.</>
                  : <>Every approval passes through one person. Three days of travel stops <b>every</b> item sitting in review.</>}
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line-soft)' }}>
                  {isAr
                    ? 'الحل: امنح الدور لشخص ثانٍ ليصبح بديلًا يرث الاعتمادات أثناء الغياب.'
                    : 'The fix: grant the role to a second person, who becomes the backup and inherits approvals while they are away.'}
                </div>
                {canManage && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button
                      type="button"
                      className="btn btn-p btn-sm"
                      style={{ flex: 1, justifyContent: 'center' }}
                      onClick={() => setEditingRole(noBackupRoles[0] ?? null)}
                    >
                      {isAr ? 'تعيين بديل' : 'Assign a backup'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-h"><h4>{isAr ? 'الاعتمادات مؤمَّنة' : 'Approvals are covered'}</h4></div>
              <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
                {isAr
                  ? 'كل دور يعتمد له أكثر من شاغل، فلا يتوقف اعتماد حين يغيب شخص واحد.'
                  : 'Every approving role has more than one holder, so no single absence stalls an approval.'}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-h"><h4>{isAr ? 'عند تغيير من يشغل الدور' : 'When the holder changes'}</h4></div>
            <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
              <div className="rule">
                <span className="arw">←</span>
                <span>{isAr ? <>المهام <b>المستقبلية</b> تذهب للشاغل الجديد تلقائيًا</> : <><b>Future</b> tasks go to the new holder automatically</>}</span>
              </div>
              <div className="rule">
                <span className="arw">←</span>
                <span>{isAr ? <>المهام <b>المفتوحة</b> تبقى مع القديم حتى تُنقل يدويًا</> : <><b>Open</b> tasks stay with the old holder until moved by hand</>}</span>
              </div>
              <div className="rule">
                <span className="arw">←</span>
                <span>{isAr ? 'التعليقات والاعتمادات السابقة تحتفظ باسم صاحبها' : 'Past comments and approvals keep their author’s name'}</span>
              </div>
              <div className="rule">
                <span className="arw">←</span>
                <span>{isAr ? 'لا يُعاد كتابة أي تاريخ' : 'No history is ever rewritten'}</span>
              </div>
            </div>
          </div>

        </div>

        <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.8 }}>
          {isAr
            ? 'لتعديل أدوار شخص واحد في التسويق والمبيعات معًا: الإعدادات › الفريق والصلاحيات › الأشخاص.'
            : 'To edit one person’s Marketing and Sales roles together: Settings › Team & Access › People.'}
        </div>
      </div>

      {editingRole && (
        <Modal
          title={isAr ? `من يشغل ${roleLabel(editingRole, true)}` : `Who fills ${roleLabel(editingRole, false)}`}
          sub={isAr
            ? 'امنح الدور لأكثر من شخص ليصبح الثاني بديلًا عند الغياب.'
            : 'Grant the role to more than one person — the second holder is the backup.'}
          onClose={() => setEditingRole(null)}
          footer={
            <button type="button" className="btn" onClick={() => setEditingRole(null)}>
              {isAr ? 'إغلاق' : 'Close'}
            </button>
          }
        >
          <div style={{ display: 'grid', gap: 8 }}>
            {people.map((u) => {
              const held = u.roles.includes(editingRole);
              return (
                <div key={u.user_id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className={`av ${roleAvatarClass(editingRole)}`}>{initial(personName(u, isAr))}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{personName(u, isAr)}</div>
                    <div className="ltr" style={{ fontSize: 11, color: 'var(--mute)' }}>{u.email ?? ''}</div>
                  </div>
                  <button
                    type="button"
                    className={`fbtn${held ? ' on' : ''}`}
                    style={{ marginInlineStart: 'auto' }}
                    disabled={busy === `${u.user_id}:${editingRole}`}
                    onClick={() => void toggleGrant(u.user_id, editingRole, !held)}
                  >
                    {held ? (isAr ? 'يشغل الدور — إلغاء' : 'Holds it — revoke') : (isAr ? 'منح الدور' : 'Grant')}
                  </button>
                </div>
              );
            })}
          </div>
        </Modal>
      )}

      {transferOpen && (
        <TransferModal
          people={people}
          tasks={tasks}
          content={taskContent}
          isAr={isAr}
          onClose={() => setTransferOpen(false)}
          onTransferred={() => void loadTasks()}
        />
      )}
    </>
  );
}

/* ── the explicit open-task transfer flow ─────────────────────────── */

function TransferModal({
  people, tasks, content, isAr, onClose, onTransferred,
}: {
  people: RolePerson[];
  tasks: MosTask[];
  content: MosContentRow[];
  isAr: boolean;
  onClose: () => void;
  onTransferred: () => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [fromId, setFromId] = useState<string>('');
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [movedIds, setMovedIds] = useState<Set<string>>(new Set());

  const contentById = useMemo(() => new Map(content.map((c) => [c.id, c])), [content]);

  /** A person's open tasks: assigned to them, or sitting unassigned on a role
   *  they are the SOLE holder of — i.e. the tasks that would stall without them. */
  const tasksOf = useCallback((userId: string): MosTask[] => {
    const person = people.find((p) => p.user_id === userId);
    if (!person) return [];
    return tasks.filter((t) => {
      if (movedIds.has(t.id)) return false;
      if (t.assignee_user_id === userId) return true;
      if (t.assignee_user_id) return false;
      const holders = people.filter((p) => p.roles.includes(t.role));
      return holders.length === 1 && holders[0]?.user_id === userId;
    });
  }, [people, tasks, movedIds]);

  const rows = fromId ? tasksOf(fromId) : [];

  const doTransfer = async (task: MosTask): Promise<void> => {
    const to = targets[task.id];
    if (!to) {
      addToast(isAr ? 'اختر من يستلم المهمة أولًا.' : 'Pick who receives the task first.', 'error');
      return;
    }
    setBusyTask(task.id);
    try {
      await transferTask(task.id, to);
      setMovedIds((s) => new Set(s).add(task.id));
      addToast(isAr ? 'نُقلت المهمة.' : 'Task transferred.', 'success');
      onTransferred();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusyTask(null);
    }
  };

  return (
    <Modal
      wide
      title={isAr ? 'نقل المهام المفتوحة' : 'Transfer open tasks'}
      sub={isAr
        ? 'المهام المستقبلية تتبع الدور تلقائيًا — هنا تُنقل المفتوحة فقط، مهمة مهمة، ولا يُعاد كتابة أي تاريخ.'
        : 'Future tasks follow the role automatically — only OPEN ones move here, one by one, and no history is rewritten.'}
      onClose={onClose}
      footer={
        <button type="button" className="btn" onClick={onClose}>{isAr ? 'إغلاق' : 'Close'}</button>
      }
    >
      <div style={{ display: 'grid', gap: 14 }}>
        <label style={{ display: 'block' }}>
          <span className="lbl">{isAr ? 'انقل من' : 'Transfer from'}</span>
          <div style={{ marginTop: 6 }}>
            <select className="inp" value={fromId} onChange={(e) => { setFromId(e.target.value); setTargets({}); }}>
              <option value="">{isAr ? '— اختر شخصًا —' : '— pick a person —'}</option>
              {people.map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {personName(p, isAr)} · {num(tasksOf(p.user_id).length, isAr)} {isAr ? 'مهام' : 'tasks'}
                </option>
              ))}
            </select>
          </div>
        </label>

        {fromId && rows.length === 0 && (
          <div className="notice">
            {isAr ? 'لا مهام مفتوحة عند هذا الشخص.' : 'This person has no open tasks.'}
          </div>
        )}

        {rows.map((t) => {
          const item = contentById.get(t.content_id);
          const eligible = people.filter((p) => p.user_id !== fromId && p.roles.includes(t.role));
          return (
            <div key={t.id} className="wstep" style={{ alignItems: 'center' }}>
              <div className="bd2" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>
                    {item ? item.title : t.content_id}
                    {item?.ref && <span className="ltr" style={{ color: 'var(--mute)', fontWeight: 400, marginInlineStart: 6 }}>{item.ref}</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--mute)', marginTop: 2 }}>
                    {roleLabel(t.role, isAr)}
                    {item && (isAr ? item.current_step_label_ar : item.current_step_label_en) && (
                      <> · {isAr ? item.current_step_label_ar : item.current_step_label_en}</>
                    )}
                  </div>
                </div>
                {eligible.length === 0 ? (
                  <Pill tone="wait">{isAr ? 'لا شاغل آخر لهذا الدور' : 'No other holder of this role'}</Pill>
                ) : (
                  <>
                    <select
                      className="inp"
                      style={{ width: 190 }}
                      value={targets[t.id] ?? ''}
                      onChange={(e) => setTargets((m) => ({ ...m, [t.id]: e.target.value }))}
                    >
                      <option value="">{isAr ? '— إلى —' : '— to —'}</option>
                      {eligible.map((p) => (
                        <option key={p.user_id} value={p.user_id}>{personName(p, isAr)}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-p btn-sm"
                      disabled={busyTask === t.id}
                      onClick={() => void doTransfer(t)}
                    >
                      {busyTask === t.id ? (isAr ? 'جارٍ النقل…' : 'Moving…') : isAr ? 'نقل' : 'Transfer'}
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
