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
  MosAccount, MosContentType, MosRole, MosStep, MosWorkflow, PLATFORM_LABELS, ROLE_LABELS,
  fetchSettings, grantRole, saveAccount, saveContentType, saveStep,
} from '@/lib/marketingOS/client';
import { useWorkspace, type Capability } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Pill, Skeleton } from './components/kit';
import {
  IconBack, IconCalendar, IconContent, IconForward, IconPlus, IconRoles, IconSettings,
} from './components/icons';
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
    slug: 'types', Icon: IconSettings,
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

  const [workflows, setWorkflows] = useState<MosWorkflow[]>([]);
  const [steps, setSteps] = useState<MosStep[]>([]);
  const [types, setTypes] = useState<MosContentType[]>([]);
  const [accounts, setAccounts] = useState<MosAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (section === 'roles') { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSettings();
      setWorkflows(res.workflows);
      setSteps(res.steps);
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

  if (!meta) {
    return (
      <div className="body">
        <div className="notice">{isAr ? 'قسم غير معروف.' : 'Unknown settings section.'}</div>
      </div>
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
            onSteps={setSteps}
          />
        )}
        {!loading && section === 'types' && (
          <TypesSection
            types={types}
            workflows={workflows}
            steps={steps}
            canManage={canManage}
            isAr={isAr}
            onTypes={setTypes}
          />
        )}
        {!loading && section === 'platforms' && (
          <PlatformsSection accounts={accounts} canManage={canManage} isAr={isAr} onAccounts={setAccounts} />
        )}
        {section === 'roles' && <RolesSection isAr={isAr} />}
      </div>
    </>
  );
}

/* ── Workflows (screen 17) ────────────────────────────────────────── */

function WorkflowsSection({
  workflows, steps, canManage, isAr, onSteps,
}: {
  workflows: MosWorkflow[];
  steps: MosStep[];
  canManage: boolean;
  isAr: boolean;
  onSteps: (steps: MosStep[]) => void;
}) {
  const [editing, setEditing] = useState<{ step: MosStep | null; workflowId: string } | null>(null);

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
                  onClick={() => setEditing({ step: null, workflowId: w.id })}
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
                  <button type="button" className="btn btn-sm" onClick={() => setEditing({ step: s, workflowId: w.id })}>
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
          workflowId={editing.workflowId}
          nextPosition={steps.filter((s) => s.workflow_id === editing.workflowId).length + 1}
          isAr={isAr}
          onClose={() => setEditing(null)}
          onSaved={(rows) => { onSteps(rows); setEditing(null); }}
        />
      )}
    </div>
  );
}

function StepModal({
  step, workflowId, nextPosition, isAr, onClose, onSaved,
}: {
  step: MosStep | null;
  workflowId: string;
  nextPosition: number;
  isAr: boolean;
  onClose: () => void;
  onSaved: (steps: MosStep[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [labelAr, setLabelAr] = useState(step?.label_ar ?? '');
  const [labelEn, setLabelEn] = useState(step?.label_en ?? '');
  const [key, setKey] = useState(step?.key ?? '');
  const [role, setRole] = useState<MosRole>(step?.role ?? 'writer');
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
      const res = await saveStep({
        id: step?.id,
        workflow_id: workflowId,
        key: key.trim(),
        label_ar: labelAr.trim(),
        label_en: labelEn.trim(),
        role,
        due_days: Number(dueDays) || 1,
        is_approval: isApproval,
        approval_kind: isApproval ? (role === 'ceo' ? 'budget' : role === 'ops_supervisor' ? 'process' : 'creative') : null,
        position: Number(position) || nextPosition,
      });
      addToast(isAr ? 'حُفظت المرحلة.' : 'Stage saved.', 'success');
      onSaved(res.steps);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const ROLES: MosRole[] = ['writer', 'montage', 'ops_supervisor', 'marketing_manager', 'ceo'];

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
        <select className="inp" value={role} onChange={(e) => setRole(e.target.value as MosRole)}>
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

/* ── Content types (screen 27) ────────────────────────────────────── */

function TypesSection({
  types, workflows, steps, canManage, isAr, onTypes,
}: {
  types: MosContentType[];
  workflows: MosWorkflow[];
  steps: MosStep[];
  canManage: boolean;
  isAr: boolean;
  onTypes: (types: MosContentType[]) => void;
}) {
  const [editing, setEditing] = useState<MosContentType | null>(null);
  const [adding, setAdding] = useState(false);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{isAr ? 'النوع' : 'Type'}</th>
                <th style={{ width: 80 }}>{isAr ? 'البادئة' : 'Prefix'}</th>
                <th style={{ width: 190 }}>{isAr ? 'المسار' : 'Workflow'}</th>
                <th style={{ width: 90 }}>{isAr ? 'المراحل' : 'Stages'}</th>
                <th>{isAr ? 'حقول الكتابة' : 'Writing fields'}</th>
                {canManage && <th style={{ width: 90 }} />}
              </tr>
            </thead>
            <tbody>
              {types.map((t) => {
                const w = workflows.find((x) => x.id === t.workflow_id);
                const n = steps.filter((s) => s.workflow_id === t.workflow_id).length;
                return (
                  <tr key={t.id}>
                    <td className="ttl">
                      {isAr ? t.label_ar : t.label_en}
                      <div style={{ fontSize: 11, color: 'var(--mute)', fontWeight: 400 }} className="ltr">{t.key}</div>
                    </td>
                    <td className="id">{t.prefix}</td>
                    <td>{w ? (isAr ? w.label_ar : w.label_en) : '—'}</td>
                    <td className="num">{num(n, isAr)}</td>
                    <td className="ltr" style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                      {t.field_schema.join(', ') || '—'}
                    </td>
                    {canManage && (
                      <td>
                        <button type="button" className="btn btn-sm" onClick={() => setEditing(t)}>
                          {isAr ? 'تعديل' : 'Edit'}
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="notice">
        {isAr
          ? 'إضافة نوع جديد — كتيّب، ستوري، إعلان — صفٌّ هنا، لا شاشة جديدة. هذه هي كل حجة «كيان محتوى واحد».'
          : 'Adding a new type — a brochure, a story, an ad — is a row here, not a new screen. That is the whole "one content entity" argument.'}
      </div>

      {canManage && (
        <div>
          <button type="button" className="btn" onClick={() => setAdding(true)}>
            <IconPlus />
            {isAr ? 'نوع جديد' : 'New type'}
          </button>
        </div>
      )}

      {(editing || adding) && (
        <TypeModal
          type={editing}
          workflows={workflows}
          isAr={isAr}
          onClose={() => { setEditing(null); setAdding(false); }}
          onSaved={(rows) => { onTypes(rows); setEditing(null); setAdding(false); }}
        />
      )}
    </div>
  );
}

function TypeModal({
  type, workflows, isAr, onClose, onSaved,
}: {
  type: MosContentType | null;
  workflows: MosWorkflow[];
  isAr: boolean;
  onClose: () => void;
  onSaved: (types: MosContentType[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [key, setKey] = useState(type?.key ?? '');
  const [labelAr, setLabelAr] = useState(type?.label_ar ?? '');
  const [labelEn, setLabelEn] = useState(type?.label_en ?? '');
  const [prefix, setPrefix] = useState(type?.prefix ?? '');
  const [workflowId, setWorkflowId] = useState(type?.workflow_id ?? '');
  const [fields, setFields] = useState((type?.field_schema ?? []).join(', '));
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!key.trim() || !prefix.trim() || !labelAr.trim() || !labelEn.trim()) {
      addToast(isAr ? 'المفتاح والبادئة والاسمان إلزامية.' : 'Key, prefix and both labels are required.', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await saveContentType({
        id: type?.id,
        key: key.trim(),
        label_ar: labelAr.trim(),
        label_en: labelEn.trim(),
        prefix: prefix.trim(),
        workflow_id: workflowId || null,
        field_schema: fields.split(',').map((f) => f.trim()).filter(Boolean),
      });
      addToast(isAr ? 'حُفظ النوع.' : 'Type saved.', 'success');
      onSaved(res.content_types);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={type ? (isAr ? 'تعديل النوع' : 'Edit type') : (isAr ? 'نوع جديد' : 'New type')}
      sub={isAr
        ? 'البادئة تُستخدم في ترقيم العناصر. أنواع تتشارك البادئة تتشارك العدّاد نفسه.'
        : 'The prefix numbers the items. Types sharing a prefix share one counter.'}
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
          <input className="inp" dir="ltr" value={key} onChange={(e) => setKey(e.target.value)} disabled={Boolean(type)} />
        </Field>
        <Field label={isAr ? 'البادئة' : 'Prefix'} hint="P- / V-">
          <input className="inp" dir="ltr" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        </Field>
        <Field label={isAr ? 'المسار' : 'Workflow'}>
          <select className="inp" value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
            <option value="">{isAr ? 'بلا مسار' : 'None'}</option>
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>{isAr ? w.label_ar : w.label_en}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        label={isAr ? 'حقول الكتابة' : 'Writing fields'}
        hint={isAr ? 'مفصولة بفاصلة — idea, hook, script…' : 'comma separated — idea, hook, script…'}
      >
        <input className="inp" dir="ltr" value={fields} onChange={(e) => setFields(e.target.value)} />
      </Field>
    </Modal>
  );
}

/* ── Platforms (screen 26) ────────────────────────────────────────── */

function PlatformsSection({
  accounts, canManage, isAr, onAccounts,
}: {
  accounts: MosAccount[];
  canManage: boolean;
  isAr: boolean;
  onAccounts: (accounts: MosAccount[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [editing, setEditing] = useState<MosAccount | null>(null);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    if (!editing) return;
    setBusy(true);
    try {
      const res = await saveAccount({ id: editing.id, handle: handle.trim() || null });
      onAccounts(res.accounts);
      setEditing(null);
      addToast(isAr ? 'حُفظ الحساب.' : 'Account saved.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 150 }}>{isAr ? 'المنصة' : 'Platform'}</th>
                <th>{isAr ? 'الحساب' : 'Account'}</th>
                <th style={{ width: 140 }}>{isAr ? 'الاتصال' : 'Connection'}</th>
                <th style={{ width: 150 }}>{isAr ? 'النشر التلقائي' : 'Auto-publish'}</th>
                <th style={{ width: 150 }}>{isAr ? 'قراءة الأرقام' : 'Reads metrics'}</th>
                {canManage && <th style={{ width: 90 }} />}
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td className="ttl">
                    {(isAr ? PLATFORM_LABELS[a.platform]?.ar : PLATFORM_LABELS[a.platform]?.en) ?? a.platform}
                  </td>
                  <td className="ltr" style={{ color: a.handle ? 'var(--ink)' : 'var(--mute)' }}>
                    {a.handle ?? (isAr ? 'لم يُحدَّد' : 'not set')}
                  </td>
                  <td>
                    <Pill tone={a.is_connected ? 'go' : 'idle'}>
                      {a.is_connected ? (isAr ? 'موصول' : 'Connected') : (isAr ? 'غير موصول' : 'Not connected')}
                    </Pill>
                  </td>
                  <td>
                    <Pill tone={a.can_publish ? 'go' : 'idle'}>
                      {a.can_publish ? (isAr ? 'ممكن' : 'Possible') : (isAr ? 'يدوي' : 'Manual')}
                    </Pill>
                  </td>
                  <td>
                    <Pill tone={a.can_read_metrics ? 'go' : 'idle'}>
                      {a.can_read_metrics ? (isAr ? 'تلقائي' : 'Automatic') : (isAr ? 'يدوي' : 'By hand')}
                    </Pill>
                  </td>
                  {canManage && (
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => { setEditing(a); setHandle(a.handle ?? ''); }}
                      >
                        {isAr ? 'تعديل' : 'Edit'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="notice">
        {isAr
          ? 'النشر يدوي بقرار — لا يوجد مفتاح هنا يجعله تلقائيًا. تشغيل النشر التلقائي يتطلب مراجعة تطبيق من ميتا وتيك توك، وهو قرار منفصل. الحالة أعلاه تقول الحقيقة كما هي، لا كما نتمنى.'
          : 'Publishing is manual by decision — there is no switch here that makes it automatic. Turning it on would need Meta and TikTok app review, which is a separate decision. The states above say what is true, not what we would like.'}
      </div>

      {editing && (
        <Modal
          title={(isAr ? PLATFORM_LABELS[editing.platform]?.ar : PLATFORM_LABELS[editing.platform]?.en) ?? editing.platform}
          sub={isAr ? 'اسم الحساب فقط — الاتصال ليس مفتاحًا في الواجهة.' : 'The handle only — a connection is not a checkbox.'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(null)} disabled={busy}>
                {isAr ? 'إلغاء' : 'Cancel'}
              </button>
              <button type="button" className="btn btn-p" onClick={() => void save()} disabled={busy}>
                {isAr ? 'حفظ' : 'Save'}
              </button>
            </>
          }
        >
          <Field label={isAr ? 'اسم الحساب' : 'Handle'}>
            <input className="inp" dir="ltr" value={handle} onChange={(e) => setHandle(e.target.value)} autoFocus />
          </Field>
        </Modal>
      )}
    </div>
  );
}

/* ── Roles (screens 33 + 37) ──────────────────────────────────────── */

const ASSIGNABLE: MosRole[] = ['marketing_manager', 'ops_supervisor', 'writer', 'montage', 'ceo', 'viewer'];

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
  const { users, grants, reloadGrants, role } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const [busy, setBusy] = useState<string | null>(null);

  const canManage = role === 'administrator' || role === 'marketing_manager';
  const roleOf = useCallback(
    (userId: string): MosRole | null => grants.find((g) => g.user_id === userId)?.mos_role ?? null,
    [grants],
  );

  const grantedCount = useMemo(() => grants.length, [grants]);

  const set = async (userId: string, next: MosRole | null): Promise<void> => {
    setBusy(userId);
    try {
      await grantRole(userId, next);
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
        {users.length === 0 ? (
          <Empty title={isAr ? 'لا مستخدمين' : 'No users'} />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 240 }}>{isAr ? 'الشخص' : 'Person'}</th>
                  <th>{isAr ? 'الدور في التسويق' : 'Marketing role'}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const current = roleOf(u.id);
                  return (
                    <tr key={u.id}>
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
                              className={`fbtn${current === r ? ' on' : ''}`}
                              disabled={!canManage || busy === u.id}
                              onClick={() => void set(u.id, current === r ? null : r)}
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
                {ASSIGNABLE.map((r) => (
                  <th key={r}>{isAr ? ROLE_LABELS[r].ar : ROLE_LABELS[r].en}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAPS.map((c) => (
                <tr key={c.key}>
                  <td>{isAr ? c.ar : c.en}</td>
                  {ASSIGNABLE.map((r) => {
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
