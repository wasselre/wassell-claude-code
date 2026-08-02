/**
 * The content workspace — design screens 06 through 12, plus 38.
 *
 * One item, six tabs, one stage rail. Tabs are LOCAL STATE, not routes: moving
 * between Overview and Publishing must not refetch the item, which is the
 * concrete answer to "it always reloads".
 *
 * Everything the header shows — stage, owner, round, overdue — is derived from
 * the open task by `mos_content_v`. There is no status dropdown, so this header
 * can never disagree with the queue.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  MosAccount, MosComment, MosContentRow, MosPublication, MosScene, MosStep, MosTask,
  PLATFORM_LABELS, PUB_STATUS_LABELS, PURPOSE_LABELS, ROLE_LABELS,
  fetchComments, fetchContentDetail, fetchPublications, fieldSchemaKeys, isOverdue, updateContent,
} from '@/lib/marketingOS/client';
import { useAppStore } from '@/stores/appStore';
import { useWorkspace } from './MarketingWorkspace';
import {
  KindCell, LoadError, Pill, ReadField, Skeleton, StatusPill,
} from './components/kit';
import StageRail from './components/StageRail';
import TaskCard from './components/TaskCard';
import WritingFields from './components/WritingFields';
import SceneTable from './components/SceneTable';
import PublishTab from './components/PublishTab';
import PerformanceTab from './components/PerformanceTab';
import MaterialsTab from './components/MaterialsTab';
import CommentThread from './components/CommentThread';
import { IconBack, IconForward } from './components/icons';
import { daysAgo, num, shortDate } from './lib/format';

type Tab = 'overview' | 'content' | 'materials' | 'tasks' | 'publishing' | 'performance';

export default function ContentDetailPage() {
  const { contentId } = useParams<{ contentId: string }>();
  const navigate = useNavigate();
  const { isAr, role, can, typeLabel, projectName, contentTypes, people, projects } = useWorkspace();
  // CommentThread wants the legacy {id,name_ar,name_en} shape.
  const users = people.map((p) => ({ id: p.user_id, name_ar: p.name_ar, name_en: p.name_en }));

  const [item, setItem] = useState<MosContentRow | null>(null);
  const [tasks, setTasks] = useState<MosTask[]>([]);
  const [scenes, setScenes] = useState<MosScene[]>([]);
  const [steps, setSteps] = useState<MosStep[]>([]);
  const [publications, setPublications] = useState<MosPublication[]>([]);
  const [accounts, setAccounts] = useState<MosAccount[]>([]);
  const [comments, setComments] = useState<MosComment[]>([]);
  const [materialCount, setMaterialCount] = useState(0);
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingBrief, setEditingBrief] = useState(false);

  const load = useCallback(async () => {
    if (!contentId) return;
    setLoading(true);
    setError(null);
    try {
      // One round trip for the item, then publications and the thread in
      // parallel. The old module fetched per tab; this fetches per ITEM.
      const [detail, pubs, thread] = await Promise.all([
        fetchContentDetail(contentId),
        fetchPublications(contentId),
        fetchComments({ contentId }),
      ]);
      setItem(detail.item);
      setTasks(detail.tasks);
      setScenes(detail.scenes);
      setSteps(detail.steps);
      setPublications(pubs.publications);
      setAccounts(pubs.accounts);
      setComments(thread.comments);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [contentId]);

  useEffect(() => { void load(); }, [load]);

  const openTask = tasks.find((t) => t.status === 'open') ?? null;
  const currentStep = openTask ? steps.find((s) => s.id === openTask.step_id) ?? null : null;
  const type = item ? contentTypes.find((t) => t.key === item.content_type_key) ?? null : null;

  /**
   * Editing is allowed when the open stage sits with YOUR role — the same rule
   * the database enforces. Managers and admins can always edit, because someone
   * has to be able to fix a typo at 11pm.
   */
  const canEditNow = useMemo(() => {
    if (role === 'administrator' || role === 'marketing_manager') return true;
    if (!openTask) return false;
    return openTask.role === role && can('write_content');
  }, [role, openTask, can]);

  const canActOnTask = useMemo(() => {
    if (!openTask) return false;
    if (role === 'administrator') return true;
    return openTask.role === role;
  }, [openTask, role]);

  if (loading && !item) {
    return <div className="body"><Skeleton rows={7} /></div>;
  }

  if (error && !item) {
    return (
      <div className="body">
        <LoadError message={error} onRetry={() => void load()} isAr={isAr} />
      </div>
    );
  }

  if (!item) {
    return (
      <div className="body">
        <div className="notice">{isAr ? 'العنصر غير موجود.' : 'That item does not exist.'}</div>
      </div>
    );
  }

  const Back = isAr ? IconForward : IconBack;
  const overdue = isOverdue(item);
  const openPubs = publications.filter((p) => p.status !== 'cancelled').length;
  const openTasks = tasks.filter((t) => t.status === 'open').length;

  // The version IS the round — a rejection opens round 2, which is version 2.
  // One number, derived from the task chain, never set by hand.
  const version = tasks.reduce((a, t) => Math.max(a, t.round), 1);

  // The pinned review note: the latest rejection, shown while the item is
  // still open so nobody has to scroll the thread to learn WHY it came back.
  const lastRejection = item.status_key !== 'done'
    ? [...tasks]
        .filter((t) => t.result === 'changes_requested' && t.note)
        .sort((a, b) => (a.closed_at ?? '').localeCompare(b.closed_at ?? ''))
        .pop() ?? null
    : null;

  const tabs: Array<{ key: Tab; ar: string; en: string; badge?: number }> = [
    { key: 'overview', ar: 'نظرة عامة', en: 'Overview' },
    { key: 'content', ar: 'المحتوى', en: 'Content' },
    { key: 'materials', ar: 'المواد', en: 'Material', badge: materialCount || undefined },
    { key: 'tasks', ar: 'المهام والاعتمادات', en: 'Tasks & approvals', badge: openTasks || undefined },
    { key: 'publishing', ar: 'النشر', en: 'Publishing', badge: openPubs || undefined },
    { key: 'performance', ar: 'الأداء', en: 'Performance' },
  ];

  return (
    <>
      <div className="rhead">
        <div className="top">
          <div style={{ minWidth: 0 }}>
            <div className="crumb">
              <button type="button" onClick={() => navigate('/m/content')}>
                <Back style={{ width: 11, height: 11, verticalAlign: -1 }} />{' '}
                {isAr ? 'المحتوى' : 'Content'}
              </button>
              <span className="sep">/</span>
              <span>{typeLabel(item.content_type_key)}</span>
              <span className="sep">/</span>
              <span className="ltr">{item.ref}</span>
            </div>
            <h3>{item.title}</h3>
            <div className="chips">
              <KindCell typeKey={item.content_type_key} label={typeLabel(item.content_type_key)} />
              {version > 1 && (
                <span className="tag">{isAr ? `النسخة ${num(version, true)}` : `Version ${version}`}</span>
              )}
              {item.project_id && <span className="tag">{projectName(item.project_id)}</span>}
              <span className="tag tag-t">
                {(isAr ? PURPOSE_LABELS[item.purpose]?.ar : PURPOSE_LABELS[item.purpose]?.en) ?? item.purpose}
              </span>
              <StatusPill row={item} isAr={isAr} />
              {item.owner_role && (
                <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                  {isAr ? 'لدى ' : 'with '}
                  <b style={{ color: 'var(--ink)' }}>
                    {ROLE_LABELS[item.owner_role]
                      ? isAr ? ROLE_LABELS[item.owner_role].ar : ROLE_LABELS[item.owner_role].en
                      : item.owner_role}
                  </b>
                  {openTask && <> · {daysAgo(openTask.opened_at, isAr)}</>}
                </span>
              )}
              {overdue && (
                <span style={{ fontSize: 11.5, color: 'var(--late)', fontWeight: 700 }}>
                  {isAr ? 'استحقاق ' : 'due '}
                  {shortDate(item.current_task_due_at ?? item.due_at, isAr)} ·{' '}
                  {isAr ? 'متأخر' : 'late'}
                </span>
              )}
              <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                {isAr ? 'آخر تعديل ' : 'last edited '}{shortDate(item.updated_at, isAr)}
              </span>
            </div>
          </div>
          <div className="acts">
            <button type="button" className="btn" onClick={() => void load()}>
              {isAr ? 'تحديث' : 'Refresh'}
            </button>
          </div>
        </div>
        <div className="tabs">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              className={tab === t.key ? 'on' : ''}
              onClick={() => setTab(t.key)}
            >
              {isAr ? t.ar : t.en}
              {t.badge ? <span className="b">{num(t.badge, isAr)}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="wsplit">
        <div className="wmain">
          {error && (
            <div style={{ marginBottom: 12 }}>
              <LoadError message={error} onRetry={() => void load()} isAr={isAr} />
            </div>
          )}

          {tab === 'overview' && (
            <div style={{ display: 'grid', gap: 16 }}>
              {openTask ? (
                <TaskCard
                  item={item}
                  task={openTask}
                  step={currentStep}
                  scenes={scenes}
                  canAct={canActOnTask}
                  isAr={isAr}
                  onDone={() => void load()}
                />
              ) : (
                <div className="notice">
                  {item.status_key === 'done'
                    ? isAr
                      ? 'انتهى مسار العمل لهذا العنصر — لا مهمة مفتوحة.'
                      : 'The workflow is finished for this item — no open task.'
                    : isAr
                      ? 'لا مهمة مفتوحة. هذا العنصر ليس في طابور أحد.'
                      : 'No open task. This item is in nobody’s queue.'}
                </div>
              )}

              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'الموجز' : 'The brief'}</h4>
                  <span className="r">
                    {isAr ? 'يُحدَّد عند الإنشاء · قابل للتعديل' : 'set at creation · editable'}
                  </span>
                  {canEditNow && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setEditingBrief((v) => !v)}
                    >
                      {editingBrief ? (isAr ? 'إنهاء' : 'Done') : (isAr ? 'تعديل' : 'Edit')}
                    </button>
                  )}
                </div>
                <div className="card-b">
                  {editingBrief ? (
                    <BriefForm
                      row={item}
                      isAr={isAr}
                      projects={projects}
                      onSaved={(patched) => { setItem(patched); setEditingBrief(false); }}
                    />
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 26px' }}>
                      <ReadField label={isAr ? 'الهدف' : 'Goal'}>{item.goal || '—'}</ReadField>
                      <ReadField label={isAr ? 'الجمهور' : 'Audience'}>{item.audience || '—'}</ReadField>
                      <ReadField label={isAr ? 'الزاوية' : 'Angle'}>{item.angle || '—'}</ReadField>
                      <ReadField label={isAr ? 'دعوة الإجراء' : 'Call to action'}>{item.cta || '—'}</ReadField>
                      <ReadField label={isAr ? 'المشروع' : 'Project'}>
                        {item.project_id ? projectName(item.project_id) : '—'}
                      </ReadField>
                      <ReadField label={isAr ? 'المدة والحجم المطلوب' : 'Required duration & volume'}>
                        {typeof item.data?.duration_size === 'string' && item.data.duration_size !== ''
                          ? item.data.duration_size
                          : '—'}
                      </ReadField>
                    </div>
                  )}
                </div>
              </div>

              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'خطة النشر' : 'Publishing plan'}</h4>
                  <span className="r">
                    {isAr
                      ? `${num(publications.length, true)} منصة`
                      : `${publications.length} platforms`}
                  </span>
                  <button type="button" className="btn btn-sm" onClick={() => setTab('publishing')}>
                    {isAr ? 'فتح' : 'Open'}
                  </button>
                </div>
                {publications.length === 0 ? (
                  <p style={{ padding: 20, textAlign: 'center', fontSize: 12.5, color: 'var(--mute)' }}>
                    {isAr ? 'لا منصات بعد.' : 'No platforms yet.'}
                  </p>
                ) : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <tbody>
                        {publications.map((p) => (
                          <tr key={p.id}>
                            <td style={{ width: 140 }}>
                              <span className="tag">
                                {(isAr ? PLATFORM_LABELS[p.platform]?.ar : PLATFORM_LABELS[p.platform]?.en) ?? p.platform}
                              </span>
                            </td>
                            <td className="ltr" style={{ color: 'var(--mute)' }}>{p.account_handle ?? '—'}</td>
                            <td style={{ width: 170, color: 'var(--mute)' }}>
                              {p.published_at || p.scheduled_at
                                ? shortDate(p.published_at ?? p.scheduled_at, isAr)
                                : (isAr ? 'بلا موعد' : 'no time set')}
                            </td>
                            <td style={{ width: 110 }}>
                              <Pill tone={p.status === 'published' ? 'live' : p.status === 'scheduled' ? 'go' : 'idle'}>
                                {(isAr ? PUB_STATUS_LABELS[p.status]?.ar : PUB_STATUS_LABELS[p.status]?.en) ?? p.status}
                              </Pill>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'content' && (
            <div style={{ display: 'grid', gap: 16 }}>
              <WritingFields
                contentId={item.id}
                schema={fieldSchemaKeys(type?.field_schema ?? [])}
                data={item.data ?? {}}
                canEdit={canEditNow}
                canApprove={can('approve_creative')}
                isAr={isAr}
                onSaved={(data) => setItem({ ...item, data })}
              />
              {(item.content_type_key === 'video' || scenes.length > 0) && (
                <SceneTable
                  contentId={item.id}
                  contentTitle={item.title}
                  projectId={item.project_id}
                  scenes={scenes}
                  canEdit={canEditNow}
                  isAr={isAr}
                  onChange={setScenes}
                />
              )}
            </div>
          )}

          {tab === 'materials' && (
            <MaterialsTab
              contentId={item.id}
              projectId={item.project_id}
              canEdit={can('manage_assets') || canEditNow}
              isAr={isAr}
              onCount={setMaterialCount}
            />
          )}

          {tab === 'tasks' && (
            <div className="card">
              <div className="card-h">
                <h4>{isAr ? 'كل المهام والاعتمادات' : 'Every task and approval'}</h4>
                <span className="r">
                  {isAr
                    ? 'الرفض يُنشئ جولة جديدة — لا يُستبدل أحد'
                    : 'a rejection opens a new round — nothing is overwritten'}
                </span>
              </div>
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>{isAr ? 'المرحلة' : 'Stage'}</th>
                      <th style={{ width: 140 }}>{isAr ? 'الدور' : 'Role'}</th>
                      <th style={{ width: 90 }}>{isAr ? 'الجولة' : 'Round'}</th>
                      <th style={{ width: 130 }}>{isAr ? 'النتيجة' : 'Result'}</th>
                      <th style={{ width: 130 }}>{isAr ? 'أُغلقت' : 'Closed'}</th>
                      <th>{isAr ? 'الملاحظة' : 'Note'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((t) => {
                      const s = steps.find((x) => x.id === t.step_id);
                      return (
                        <tr key={t.id}>
                          <td className="ttl">{s ? (isAr ? s.label_ar : s.label_en) : '—'}</td>
                          <td>
                            {ROLE_LABELS[t.role]
                              ? isAr ? ROLE_LABELS[t.role].ar : ROLE_LABELS[t.role].en
                              : t.role}
                          </td>
                          <td className="num">{num(t.round, isAr)}</td>
                          <td>
                            {t.status === 'open' ? (
                              <Pill tone="now">{isAr ? 'مفتوحة' : 'Open'}</Pill>
                            ) : t.result === 'approved' ? (
                              <Pill tone="go">{isAr ? 'اعتُمدت' : 'Approved'}</Pill>
                            ) : t.result === 'changes_requested' ? (
                              <Pill tone="late">{isAr ? 'أُعيدت' : 'Sent back'}</Pill>
                            ) : (
                              <Pill tone="idle">{isAr ? 'أُرسلت' : 'Submitted'}</Pill>
                            )}
                          </td>
                          <td style={{ color: 'var(--mute)' }}>{shortDate(t.closed_at, isAr)}</td>
                          <td style={{ fontSize: 12, color: 'var(--ink-2)' }}>{t.note ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'publishing' && (
            <PublishTab
              contentId={item.id}
              publications={publications}
              accounts={accounts}
              canEdit={can('schedule') || can('publish')}
              isAr={isAr}
              onChange={setPublications}
            />
          )}

          {tab === 'performance' && (
            <PerformanceTab
              publications={publications}
              canEnter={can('enter_metrics')}
              isAr={isAr}
            />
          )}
        </div>

        <div className="wside wide">
          {steps.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <StageRail
                steps={steps}
                tasks={tasks}
                workflowLabel={typeLabel(item.content_type_key)}
                isAr={isAr}
              />
            </div>
          )}
          {lastRejection && (
            <div
              style={{
                background: 'color-mix(in srgb, var(--late) 8%, transparent)',
                border: '1px solid color-mix(in srgb, var(--late) 30%, transparent)',
                borderRadius: 8,
                padding: '10px 12px',
                marginBottom: 13,
              }}
            >
              <div className="lbl" style={{ color: 'var(--late)' }}>
                {isAr
                  ? `ملاحظة مراجعة مفتوحة · النسخة ${num(lastRejection.round, true)}`
                  : `Open review note · version ${lastRejection.round}`}
              </div>
              <div style={{ fontSize: 12, marginTop: 5, lineHeight: 1.7 }}>{lastRejection.note}</div>
              <div style={{ fontSize: 10.5, color: 'var(--mute)', marginTop: 6 }}>
                {shortDate(lastRejection.closed_at, isAr)}
                {version > lastRejection.round && (
                  <> · {isAr ? `قيد المعالجة في النسخة ${num(version, true)}` : `being addressed in version ${version}`}</>
                )}
              </div>
            </div>
          )}
          <CommentThread
            target={{ contentId: item.id }}
            comments={comments}
            tasks={tasks}
            steps={steps}
            users={users}
            canComment={can('comment')}
            isAr={isAr}
            onChange={setComments}
          />
        </div>
      </div>
    </>
  );
}

/**
 * The brief is the only part of a content item that is a plain form. Everything
 * else on this page is either derived or belongs to a workflow stage.
 */
function BriefForm({
  row, isAr, projects, onSaved,
}: {
  row: MosContentRow;
  isAr: boolean;
  projects: Array<{ id: string; project_name: string | null }>;
  onSaved: (row: MosContentRow) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [goal, setGoal] = useState(row.goal ?? '');
  const [audience, setAudience] = useState(row.audience ?? '');
  const [angle, setAngle] = useState(row.angle ?? '');
  const [cta, setCta] = useState(row.cta ?? '');
  const [projectId, setProjectId] = useState(row.project_id ?? '');
  // «المدة والحجم المطلوب» — free text («٣٥–٤٥ ثانية · ٩:١٦», «١٠ تصاميم»),
  // not a date. Lives in data; the actual publish timing belongs to the
  // Publishing tab's per-platform rows.
  const [durationSize, setDurationSize] = useState(
    typeof row.data?.duration_size === 'string' ? row.data.duration_size : '',
  );
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const mergedData = { ...(row.data ?? {}), duration_size: durationSize || null };
      const res = await updateContent(row.id, {
        goal: goal || null,
        audience: audience || null,
        angle: angle || null,
        cta: cta || null,
        project_id: projectId || null,
        data: mergedData,
      });
      onSaved({ ...row, ...res.item, goal, audience, angle, cta, data: mergedData });
      addToast(isAr ? 'حُفظ الموجز.' : 'Brief saved.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label>
          <span className="lbl">{isAr ? 'الهدف' : 'Goal'}</span>
          <textarea className="inp" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} />
        </label>
        <label>
          <span className="lbl">{isAr ? 'الجمهور' : 'Audience'}</span>
          <textarea className="inp" rows={2} value={audience} onChange={(e) => setAudience(e.target.value)} />
        </label>
        <label>
          <span className="lbl">{isAr ? 'الزاوية' : 'Angle'}</span>
          <textarea className="inp" rows={2} value={angle} onChange={(e) => setAngle(e.target.value)} />
        </label>
        <label>
          <span className="lbl">{isAr ? 'دعوة الإجراء' : 'Call to action'}</span>
          <textarea className="inp" rows={2} value={cta} onChange={(e) => setCta(e.target.value)} />
        </label>
        <label>
          <span className="lbl">{isAr ? 'المشروع' : 'Project'}</span>
          <select className="inp" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{isAr ? 'بدون' : 'None'}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.project_name ?? p.id.slice(0, 8)}</option>
            ))}
          </select>
        </label>
        <label>
          <span className="lbl">{isAr ? 'المدة والحجم المطلوب' : 'Required duration & volume'}</span>
          <input
            className="inp"
            value={durationSize}
            onChange={(e) => setDurationSize(e.target.value)}
            placeholder={isAr ? '٣٥–٤٥ ثانية · ٩:١٦' : '35–45s · 9:16'}
          />
        </label>
      </div>
      <div>
        <button type="button" className="btn btn-p" onClick={() => void save()} disabled={busy}>
          {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ الموجز' : 'Save brief'}
        </button>
      </div>
    </div>
  );
}
