/**
 * Settings — design screens 25, 17, 26, 27 and 33/37.
 *
 * Four surfaces, one page each:
 *   workflows  — the stages, who owns each, how long it should take
 *   types      — what a Post/Video/Carousel IS, including its writing fields
 *   platforms  — the accounts, and the honest truth about what is connected
 *   roles      — which PERSON currently fills each ROLE
 *
 * The last one matters most: workflow steps point at roles, never people, so
 * replacing whoever fills a role is one change here rather than an edit to
 * every workflow. («الدور لأن الأشخاص يتغيرون».)
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosAccount, MosContentType, MosPathRole, MosRole, MosStep, ROLE_LABELS,
  StepDef, WorkflowDef, fetchSettings, grantRole, saveWorkflow, stepDefToMosStep,
} from '@/lib/marketingOS/client';
import { useWorkspace, type Capability } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Pill, Skeleton } from './components/kit';
import {
  IconBack, IconCalendar, IconContent, IconForward, IconPlus, IconRoles, IconSettings,
} from './components/icons';
import SettingsPlatforms from './components/SettingsPlatforms';
import SettingsContentTypes from './components/SettingsContentTypes';
import { num } from './lib/format';

/* ------------------------------------------------------------------ */
/* index                                                              */
/* ------------------------------------------------------------------ */

const SECTIONS = [
  {
    slug: 'workflows', Icon: IconContent,
    ar: 'مسارات العمل', en: 'Workflows',
    ar_d: 'المراحل، ومن يملك كل مرحلة، وكم يُفترض أن تستغرق.',
    en_d: 'The stages, who owns each one, and how long it should take.',
  },
  {
    slug: 'content-types', Icon: IconSettings,
    ar: 'أنواع المحتوى', en: 'Content types',
    ar_d: 'ما الذي يعنيه «منشور» أو «فيديو» — بادئة الرقم، والمسار، وحقول الكتابة.',
    en_d: 'What a Post or a Video actually is — its ref prefix, its workflow, its writing fields.',
  },
  {
    slug: 'platforms', Icon: IconCalendar,
    ar: 'المنصات والحسابات', en: 'Platforms and accounts',
    ar_d: 'الحسابات التي ننشر عليها، وما هو موصول فعلًا وما ليس كذلك.',
    en_d: 'The accounts we post to, and the honest state of what is connected.',
  },
  {
    slug: 'roles', Icon: IconRoles,
    ar: 'الأدوار ومن يشغلها', en: 'Roles and who fills them',
    ar_d: 'خطوات المسار تشير إلى أدوار لا إلى أشخاص. هنا يُحدَّد من يشغل كل دور.',
    en_d: 'Workflow steps point at roles, not people. This is where you say who fills each one.',
  },
] as const;

export default function SettingsPage() {
  const { isAr, role } = useWorkspace();
  const navigate = useNavigate();
  const roleLabel = ROLE_LABELS[role] ? (isAr ? ROLE_LABELS[role].ar : ROLE_LABELS[role].en) : role;

  return (
    <>
      <PageHead
        title={isAr ? 'الإعدادات' : 'Settings'}
        sub={isAr ? `دورك الحالي: ${roleLabel}` : `You are signed in as ${roleLabel}`}
      />
      <div className="body">
        <div className="grid g2">
          {SECTIONS.map((s) => (
            <button
              key={s.slug}
              type="button"
              className="card"
              style={{ textAlign: 'start', cursor: 'pointer', padding: 0 }}
              onClick={() => navigate(`/m/settings/${s.slug}`)}
            >
              <div className="card-h">
                <s.Icon style={{ width: 16, height: 16, color: 'var(--copper)' }} />
                <h4>{isAr ? s.ar : s.en}</h4>
              </div>
              <div className="card-b" style={{ fontSize: 12.5, color: 'var(--mute)', lineHeight: 1.9 }}>
                {isAr ? s.ar_d : s.en_d}
              </div>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* section pages                                                      */
/* ------------------------------------------------------------------ */

export function SettingsSectionPage() {
  const { section } = useParams<{ section: string }>();
  const { isAr, can } = useWorkspace();
  const navigate = useNavigate();

  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [types, setTypes] = useState<MosContentType[]>([]);
  const [accounts, setAccounts] = useState<MosAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Steps live inside each canonical workflow (metadata.steps); the flat list
  // the sections render is derived, never stored separately.
  const steps = useMemo(
    () => workflows.flatMap((w) => w.steps.map((s, i) => stepDefToMosStep(w.id, s, i))),
    [workflows],
  );

  const load = useCallback(async () => {
    if (section === 'roles') { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSettings();
      setWorkflows(res.workflows);
      setTypes(res.content_types);
      setAccounts(res.accounts);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [section]);

  useEffect(() => { void load(); }, [load]);

  const meta = SECTIONS.find((s) => s.slug === section);
  const Back = isAr ? IconForward : IconBack;
  const canManage = can('manage_settings' as Capability);
  // Screens 26/27 render their own header (sub + actions depend on live data).
  const ownHead = section === 'platforms' || section === 'content-types';

  if (!meta) {
    return (
      <div className="body">
        <div className="notice">{isAr ? 'قسم غير معروف.' : 'Unknown settings section.'}</div>
      </div>
    );
  }

  if (ownHead) {
    return (
      <>
        {error && <div className="body"><LoadError message={error} onRetry={() => void load()} isAr={isAr} /></div>}
        {loading && <div className="body"><Skeleton rows={5} /></div>}
        {!loading && section === 'platforms' && (
          <SettingsPlatforms accounts={accounts} canManage={canManage} isAr={isAr} onAccounts={setAccounts} />
        )}
        {!loading && section === 'content-types' && (
          <SettingsContentTypes
            types={types}
            workflows={workflows}
            canManage={canManage}
            isAr={isAr}
            onTypes={setTypes}
          />
        )}
      </>
    );
  }

  return (
    <>
      <PageHead
        title={isAr ? meta.ar : meta.en}
        sub={isAr ? meta.ar_d : meta.en_d}
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      />
      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={5} />}

        {!loading && section === 'workflows' && (
          <WorkflowsSection
            workflows={workflows}
            steps={steps}
            canManage={canManage}
            isAr={isAr}
            onWorkflow={(saved) =>
              setWorkflows((ws) => ws.map((w) => (w.id === saved.id ? saved : w)))}
          />
        )}
        {section === 'roles' && <RolesSection isAr={isAr} />}
      </div>
    </>
  );
}

/* ── Workflows (screen 17) ────────────────────────────────────────── */

function WorkflowsSection({
  workflows, steps, canManage, isAr, onWorkflow,
}: {
  workflows: WorkflowDef[];
  steps: MosStep[];
  canManage: boolean;
  isAr: boolean;
  onWorkflow: (workflow: WorkflowDef) => void;
}) {
  const [editing, setEditing] = useState<{ step: MosStep | null; workflow: WorkflowDef } | null>(null);

  if (workflows.length === 0) {
    return <Empty title={isAr ? 'لا مسارات' : 'No workflows'} />;
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      {workflows.map((w) => {
        const rows = steps.filter((s) => s.workflow_id === w.id).sort((a, b) => a.position - b.position);
        return (
          <div key={w.id}>
            <div className="lbl" style={{ marginBottom: 9, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{isAr ? w.label_ar : w.label_en}</span>
              <span style={{ color: 'var(--mute)', fontWeight: 400 }}>
                {isAr ? `${num(rows.length, true)} مرحلة` : `${rows.length} stages`}
              </span>
              {canManage && (
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ marginInlineStart: 'auto' }}
                  onClick={() => setEditing({ step: null, workflow: w })}
                >
                  <IconPlus />
                  {isAr ? 'إضافة مرحلة' : 'Add a stage'}
                </button>
              )}
            </div>
            {rows.map((s) => (
              <div key={s.id} className="wstep">
                <span className="n2">{num(s.position, isAr)}</span>
                <div className="bd2">
                  <div className="nm3">
                    {isAr ? s.label_ar : s.label_en}
                    {s.is_approval && (
                      <span style={{ marginInlineStart: 8 }}>
                        <Pill tone="wait">{isAr ? 'اعتماد' : 'Approval'}</Pill>
                      </span>
                    )}
                  </div>
                  <div className="rowx">
                    <div className="cell">
                      <div className="k2">{isAr ? 'الدور' : 'Role'}</div>
                      <div className="v2">
                        {ROLE_LABELS[s.role] ? (isAr ? ROLE_LABELS[s.role].ar : ROLE_LABELS[s.role].en) : s.role}
                      </div>
                    </div>
                    <div className="cell">
                      <div className="k2">{isAr ? 'المهلة' : 'Allowed'}</div>
                      <div className="v2">
                        {isAr ? `${num(s.due_days, true)} أيام` : `${s.due_days} days`}
                      </div>
                    </div>
                    <div className="cell">
                      <div className="k2">{isAr ? 'المفتاح' : 'Key'}</div>
                      <div className="v2 ltr">{s.key}</div>
                    </div>
                    {Array.isArray(s.required_fields) && s.required_fields.length > 0 && (
                      <div className="cell">
                        <div className="k2">{isAr ? 'مطلوب' : 'Expects'}</div>
                        <div className="v2 ltr">{s.required_fields.join(', ')}</div>
                      </div>
                    )}
                  </div>
                </div>
                {canManage && (
                  <button type="button" className="btn btn-sm" onClick={() => setEditing({ step: s, workflow: w })}>
                    {isAr ? 'تعديل' : 'Edit'}
                  </button>
                )}
              </div>
            ))}
          </div>
        );
      })}

      {editing && (
        <StepModal
          step={editing.step}
          workflow={editing.workflow}
          nextPosition={steps.filter((s) => s.workflow_id === editing.workflow.id).length + 1}
          isAr={isAr}
          onClose={() => setEditing(null)}
          onSaved={(saved) => { onWorkflow(saved); setEditing(null); }}
        />
      )}
    </div>
  );
}

function StepModal({
  step, workflow, nextPosition, isAr, onClose, onSaved,
}: {
  step: MosStep | null;
  workflow: WorkflowDef;
  nextPosition: number;
  isAr: boolean;
  onClose: () => void;
  onSaved: (workflow: WorkflowDef) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [labelAr, setLabelAr] = useState(step?.label_ar ?? '');
  const [labelEn, setLabelEn] = useState(step?.label_en ?? '');
  const [key, setKey] = useState(step?.key ?? '');
  const [role, setRole] = useState<MosPathRole>((step?.role as MosPathRole | undefined) ?? 'writer');
  const [dueDays, setDueDays] = useState((step?.due_days ?? 2).toString());
  const [isApproval, setIsApproval] = useState(step?.is_approval ?? false);
  const [position, setPosition] = useState((step?.position ?? nextPosition).toString());
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!labelAr.trim() || !labelEn.trim() || !key.trim()) {
      addToast(isAr ? 'الاسم بالعربية والإنجليزية والمفتاح إلزامية.' : 'Both labels and the key are required.', 'error');
      return;
    }
    setBusy(true);
    try {
      // Steps live inside the workflow row, so saving one means saving the
      // whole path: replace the edited step (by key) or insert the new one at
      // its position, then upsert. The DB trigger snapshots a new version.
      const defs: StepDef[] = workflow.steps.map((s) => ({ ...s }));
      const next: StepDef = {
        key: key.trim(),
        label_ar: labelAr.trim(),
        label_en: labelEn.trim(),
        role_key: role,
        due_days: Number(dueDays) || 1,
        is_approval: isApproval,
        approval_kind: isApproval ? (role === 'ceo' ? 'budget' : role === 'ops_supervisor' ? 'process' : 'creative') : null,
        require_note_on_reject: step?.require_note_on_reject ?? false,
        creates_revision: step?.creates_revision ?? false,
        required_fields: step?.required_fields ?? [],
        required_files: step?.required_files ?? [],
      };
      if (step) {
        const at = defs.findIndex((d) => d.key === step.key);
        if (at >= 0) defs.splice(at, 1);
      }
      const pos = Math.min(Math.max(1, Number(position) || defs.length + 1), defs.length + 1);
      defs.splice(pos - 1, 0, next);
      const res = await saveWorkflow({
        id: workflow.id,
        label_ar: workflow.label_ar,
        label_en: workflow.label_en,
        steps: defs,
      });
      addToast(isAr ? 'حُفظت المرحلة.' : 'Stage saved.', 'success');
      onSaved(res.workflow);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const ROLES: MosPathRole[] = ['writer', 'montage', 'ops_supervisor', 'marketing_manager', 'ceo'];

  return (
    <Modal
      title={step ? (isAr ? 'تعديل المرحلة' : 'Edit stage') : (isAr ? 'مرحلة جديدة' : 'New stage')}
      sub={isAr
        ? 'المرحلة تشير إلى دور، لا إلى شخص. تغيير من يشغل الدور لا يمسّ المسار.'
        : 'A stage points at a role, not a person. Changing who fills the role never touches the workflow.'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'الاسم بالعربية' : 'Arabic label'}>
          <input className="inp" value={labelAr} onChange={(e) => setLabelAr(e.target.value)} />
        </Field>
        <Field label={isAr ? 'الاسم بالإنجليزية' : 'English label'}>
          <input className="inp" dir="ltr" value={labelEn} onChange={(e) => setLabelEn(e.target.value)} />
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'المفتاح' : 'Key'} hint="snake_case">
          <input className="inp" dir="ltr" value={key} onChange={(e) => setKey(e.target.value)} />
        </Field>
        <Field label={isAr ? 'الترتيب' : 'Position'}>
          <input className="inp" inputMode="numeric" value={position} onChange={(e) => setPosition(e.target.value)} />
        </Field>
        <Field label={isAr ? 'المهلة بالأيام' : 'Days allowed'}>
          <input className="inp" inputMode="numeric" value={dueDays} onChange={(e) => setDueDays(e.target.value)} />
        </Field>
      </div>
      <Field label={isAr ? 'الدور المسؤول' : 'Owning role'}>
        <select className="inp" value={role} onChange={(e) => setRole(e.target.value as MosPathRole)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>{isAr ? ROLE_LABELS[r].ar : ROLE_LABELS[r].en}</option>
          ))}
        </select>
      </Field>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={isApproval} onChange={(e) => setIsApproval(e.target.checked)} />
        {isAr
          ? 'هذه مرحلة اعتماد — يمكن قبولها أو إعادتها مع ملاحظة'
          : 'This is an approval stage — it can be approved or sent back with a note'}
      </label>
    </Modal>
  );
}

/* ── Roles (screens 33 + 37) ──────────────────────────────────────── */

/** The five grantable roles. Viewer is the ABSENCE of any grant, not a grant. */
const ASSIGNABLE: MosPathRole[] = ['marketing_manager', 'ops_supervisor', 'writer', 'montage', 'ceo'];

/** The capability matrix table also shows what a grant-less viewer can do. */
const MATRIX_ROLES: MosRole[] = [...ASSIGNABLE, 'viewer'];

/** The matrix from screen 33, mirrored from `wassell_mos_can`. */
const CAPS: Array<{ ar: string; en: string; key: Capability }> = [
  { ar: 'الاطلاع', en: 'View', key: 'read' },
  { ar: 'التعليق', en: 'Comment', key: 'comment' },
  { ar: 'كتابة المحتوى', en: 'Write content', key: 'write_content' },
  { ar: 'الإسناد', en: 'Assign', key: 'assign' },
  { ar: 'الجدولة', en: 'Schedule', key: 'schedule' },
  { ar: 'النشر', en: 'Publish', key: 'publish' },
  { ar: 'اعتماد الإبداع', en: 'Approve creative', key: 'approve_creative' },
  { ar: 'اعتماد الإجراءات', en: 'Approve process', key: 'approve_process' },
  { ar: 'اعتماد الميزانية', en: 'Approve budget', key: 'approve_budget' },
  { ar: 'إدارة المواد', en: 'Manage material', key: 'manage_assets' },
  { ar: 'إدخال الأرقام', en: 'Enter numbers', key: 'enter_metrics' },
  { ar: 'مراجعة الأداء', en: 'Review performance', key: 'review_performance' },
  { ar: 'الإعدادات', en: 'Settings', key: 'manage_settings' },
];

const ROLE_CAPS: Record<string, Capability[]> = {
  marketing_manager: CAPS.map((c) => c.key),
  ceo: ['read', 'comment', 'approve_budget', 'review_performance'],
  ops_supervisor: ['read', 'comment', 'assign', 'schedule', 'publish', 'approve_process',
    'manage_assets', 'enter_metrics', 'review_performance'],
  writer: ['read', 'comment', 'write_content', 'schedule', 'publish'],
  montage: ['read', 'comment', 'write_content', 'manage_assets'],
  viewer: ['read'],
};

function RolesSection({ isAr }: { isAr: boolean }) {
  const { people, reloadGrants, role } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const [busy, setBusy] = useState<string | null>(null);

  const canManage = role === 'administrator' || role === 'marketing_manager';
  const rolesOf = useCallback(
    (userId: string): MosRole[] => people.find((p) => p.user_id === userId)?.roles ?? [],
    [people],
  );

  const grantedCount = useMemo(() => people.filter((p) => p.roles.length > 0).length, [people]);

  // Multi-role: each button grants or revokes ONE key; the others stay.
  const toggle = async (userId: string, next: MosPathRole, grant: boolean): Promise<void> => {
    setBusy(`${userId}:${next}`);
    try {
      await grantRole(userId, next, grant);
      await reloadGrants();
      addToast(isAr ? 'تم تحديث الدور.' : 'Role updated.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {grantedCount === 0 && (
        <div className="notice">
          {isAr
            ? 'لم يُمنح أي دور بعد، فكل من ليس مدير نظام يرى النظام للقراءة فقط. امنح دورًا واحدًا على الأقل لكل وظيفة قبل بدء العمل.'
            : 'No role has been granted yet, so everyone who is not an app admin sees this workspace read-only. Grant at least one person per function before the team starts.'}
        </div>
      )}

      <div className="card">
        <div className="card-h">
          <h4>{isAr ? 'من يشغل كل دور' : 'Who fills each role'}</h4>
          <span className="r">
            {isAr ? `${num(grantedCount, true)} ممنوحة` : `${grantedCount} granted`}
          </span>
        </div>
        {people.length === 0 ? (
          <Empty title={isAr ? 'لا مستخدمين' : 'No users'} />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 240 }}>{isAr ? 'الشخص' : 'Person'}</th>
                  <th>{isAr ? 'الأدوار في التسويق' : 'Marketing roles'}</th>
                </tr>
              </thead>
              <tbody>
                {people.map((u) => {
                  const held = rolesOf(u.user_id);
                  return (
                    <tr key={u.user_id}>
                      <td>
                        <div className="ttl">{(isAr ? u.name_ar : u.name_en) ?? u.name_en ?? u.name_ar ?? '—'}</div>
                        <div className="ltr" style={{ fontSize: 11, color: 'var(--mute)' }}>{u.email ?? ''}</div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {ASSIGNABLE.map((r) => (
                            <button
                              key={r}
                              type="button"
                              className={`fbtn${held.includes(r) ? ' on' : ''}`}
                              disabled={!canManage || busy === `${u.user_id}:${r}`}
                              onClick={() => void toggle(u.user_id, r, !held.includes(r))}
                            >
                              {isAr ? ROLE_LABELS[r].ar : ROLE_LABELS[r].en}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-h">
          <h4>{isAr ? 'ما الذي يستطيعه كل دور' : 'What each role can do'}</h4>
          <span className="r">
            {isAr ? 'هذه القواعد مطبَّقة في قاعدة البيانات، لا في الواجهة' : 'enforced in the database, not the interface'}
          </span>
        </div>
        <div className="tbl-wrap">
          <table className="mx">
            <thead>
              <tr>
                <th>{isAr ? 'الصلاحية' : 'Capability'}</th>
                {MATRIX_ROLES.map((r) => (
                  <th key={r}>{isAr ? ROLE_LABELS[r].ar : ROLE_LABELS[r].en}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAPS.map((c) => (
                <tr key={c.key}>
                  <td>{isAr ? c.ar : c.en}</td>
                  {MATRIX_ROLES.map((r) => {
                    const has = (ROLE_CAPS[r] ?? []).includes(c.key);
                    return (
                      <td key={r}>
                        <span className={`mk2 ${has ? 'mk-f' : 'mk-n'}`}>{has ? '✓' : '·'}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="notice">
        {isAr
          ? 'الاعتماد مقسوم: مدير التسويق يعتمد الإبداع، ومشرف العمليات يعتمد الإجراءات، والرئيس التنفيذي يوقّع الميزانية ولا يعتمد محتوى. هذا التقسيم هو ما يمنع شخصًا واحدًا من أن يصبح طابور الجميع.'
          : 'Approval is split: the Marketing Manager approves creative, the Operations Supervisor approves process, and the CEO signs off budget and approves no content. That split is what stops one person becoming everyone else’s queue.'}
      </div>
    </div>
  );
}
