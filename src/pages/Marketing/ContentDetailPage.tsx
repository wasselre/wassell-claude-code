/**
 * The content workspace — design screens 06 through 12, plus 36 and 38.
 *
 * One item, six tabs, one activity rail. Tabs are LOCAL STATE, not routes:
 * moving between Overview and Publishing must not refetch the item, which is
 * the concrete answer to "it always reloads".
 *
 * Everything the header shows — stage, owner, round, overdue — is derived from
 * the open task by `mos_content_v`. There is no status dropdown, so this header
 * can never disagree with the queue.
 *
 * Screen 36's role rules are computed HERE, once, and fanned out:
 *   canAct      — the open task's role is one I HOLD, or I'm manager/admin.
 *                 Buttons render only when this is true; never disabled
 *                 refusals.
 *   canEditNow  — the stage sits with MY role and that role writes. A manager
 *                 reviewing can approve or send back — «لا يستطيع تعديل النص
 *                 بنفسه» — so approval does not imply editing.
 *   قادم إليك    — a later step on the pinned path belongs to my role: a
 *                 banner, not a task.
 *   ceo         — read-only AND no script, scenes, or comments at all.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  FOOTAGE_LABELS, MosAccount, MosComment, MosContentRow, MosContentVersion, MosPublication,
  MosScene, MosStep, MosTask, PLATFORM_LABELS, PUB_STATUS_LABELS, ROLE_LABELS, RolePerson,
  addComment, completeTask, fetchAssets, fetchCampaigns, fetchComments,
  fetchContentDetail, fetchContentVersions, fetchPublications,
  fieldSchemaEntries, fieldSchemaKeys, isOverdue, updateContent,
} from '@/lib/marketingOS/client';
import { useAppStore } from '@/stores/appStore';
import { useWorkspace, type Capability } from './MarketingWorkspace';
import {
  KindCell, LoadError, Pill, ReadField, Skeleton, StatusPill, Modal,
} from './components/kit';
import StageRail from './components/StageRail';
import TaskCard, { TasksApprovalsTab } from './components/TaskCard';
import WritingFields from './components/WritingFields';
import SceneTable from './components/SceneTable';
import { useMosText } from './lib/useMosText';
import PublishTab from './components/PublishTab';
import PerformanceTab from './components/PerformanceTab';
import MaterialsTab from './components/MaterialsTab';
import RequestChangesModal from './components/RequestChangesModal';
import ProjectMultiSelect from './components/ProjectMultiSelect';
import ApprovalSheet, { useIsMobile } from './components/ApprovalSheet';
import { IconBack, IconCheck, IconForward, IconSend } from './components/icons';
import { dateTimeShort, daysAgo, daysFromNow, initial, num, roleAvatarClass, shortDate } from './lib/format';
import './styles/mobile-m2.css';

type Tab = 'overview' | 'content' | 'materials' | 'tasks' | 'publishing' | 'performance';

/** The breadcrumb's plural type names — s06 «الفيديوهات», s08 «المنشورات». */
const TYPE_PLURAL: Record<string, { ar: string; en: string }> = {
  video:    { ar: 'الفيديوهات', en: 'Videos' },
  post:     { ar: 'المنشورات',  en: 'Posts' },
  carousel: { ar: 'الكاروسيل',  en: 'Carousels' },
  story:    { ar: 'القصص',      en: 'Stories' },
};

/** Labels for data keys the comparison panel can meet outside the schema. */
const DATA_LABELS: Record<string, { ar: string; en: string }> = {
  idea:              { ar: 'الفكرة', en: 'Idea' },
  hook:              { ar: 'الافتتاحية', en: 'Hook' },
  core_message:      { ar: 'الرسالة الأساسية', en: 'Core message' },
  voiceover:         { ar: 'نص التعليق الصوتي', en: 'Voice-over' },
  script:            { ar: 'النص', en: 'Script' },
  headlines:         { ar: 'العناوين', en: 'Headlines' },
  approved_headline: { ar: 'العنوان المعتمد', en: 'Approved headline' },
  caption:           { ar: 'الكابشن', en: 'Caption' },
  hashtags:          { ar: 'الوسوم', en: 'Hashtags' },
  design_brief:      { ar: 'الاتجاه البصري', en: 'Visual direction' },
  design_format:     { ar: 'الصيغة', en: 'Format' },
  design_reference:  { ar: 'مرجع', en: 'Reference' },
  slides:            { ar: 'الشرائح', en: 'Slides' },
  duration:          { ar: 'المدة', en: 'Duration' },
  duration_size:     { ar: 'المدة والحجم', en: 'Duration & size' },
  aspect_ratio:      { ar: 'نسبة العرض', en: 'Aspect ratio' },
  expiry:            { ar: 'تاريخ الانتهاء', en: 'Expiry' },
};

/** «اليوم» / «أمس» / «٢٢ يوليو» — the rail's timestamp shape. */
function relDay(iso: string | null | undefined, isAr: boolean): string {
  if (!iso) return '—';
  const d = daysFromNow(iso);
  if (d === 0) return isAr ? 'اليوم' : 'today';
  if (d === -1) return isAr ? 'أمس' : 'yesterday';
  return shortDate(iso, isAr);
}

export default function ContentDetailPage() {
  const { contentId } = useParams<{ contentId: string }>();
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);
  const { isAr, roles, can, typeLabel, projectName, contentTypes, people, projects, appUserId } = useWorkspace();
  // W6-M: content field VALUES read in the workspace language (English pages
  // translate the Arabic-authored text on demand; Arabic pages pass through).
  const mosText = useMosText();
  // Screen 29 — the phone review flow renders its own pinned note, scene
  // list, fixed action bar and approval sheet below the 760px breakpoint.
  const isMobile = useIsMobile();

  const [item, setItem] = useState<MosContentRow | null>(null);
  const [tasks, setTasks] = useState<MosTask[]>([]);
  const [scenes, setScenes] = useState<MosScene[]>([]);
  const [steps, setSteps] = useState<MosStep[]>([]);
  const [publications, setPublications] = useState<MosPublication[]>([]);
  const [accounts, setAccounts] = useState<MosAccount[]>([]);
  const [comments, setComments] = useState<MosComment[]>([]);
  const [materialCount, setMaterialCount] = useState(0);
  const [campaignName, setCampaignName] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingBrief, setEditingBrief] = useState(false);
  const [actBusy, setActBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [versions, setVersions] = useState<MosContentVersion[] | null>(null);

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

  // The campaign tag («أغسطس العضوي») needs one extra lookup, only when the
  // item is actually linked. A failure hides the tag — and is logged, never
  // swallowed.
  const campaignId = item?.campaign_id ?? null;
  useEffect(() => {
    if (!campaignId) { setCampaignName(null); return; }
    let alive = true;
    fetchCampaigns()
      .then((res) => {
        if (!alive) return;
        setCampaignName(res.campaigns.find((c) => c.id === campaignId)?.name ?? null);
      })
      .catch((e: unknown) => { console.error('[marketing] campaign name unavailable', e); });
    return () => { alive = false; };
  }, [campaignId]);

  // The «المواد» tab badge — screen 06 shows the count from page open, before
  // the tab is ever visited. Non-fatal: a failure hides the badge and is
  // logged, never swallowed; MaterialsTab's own onCount keeps it fresh later.
  useEffect(() => {
    if (!contentId) return;
    let alive = true;
    fetchAssets()
      .then((res) => {
        if (!alive) return;
        setMaterialCount(res.links.filter((l) => l.content_id === contentId).length);
      })
      .catch((e: unknown) => { console.error('[marketing] material count unavailable', e); });
    return () => { alive = false; };
  }, [contentId]);

  const openTask = tasks.find((t) => t.status === 'open') ?? null;
  const currentStep = openTask ? steps.find((s) => s.id === openTask.step_id) ?? null : null;
  const type = item ? contentTypes.find((t) => t.key === item.content_type_key) ?? null : null;

  /* ── screen 36's rules, computed once ─────────────────────────────── */

  /** The task is actionable: its role is one I HOLD, or I'm manager/admin. */
  const canAct = useMemo(() => {
    if (!openTask) return false;
    if (roles.includes('administrator') || roles.includes('marketing_manager')) return true;
    return roles.includes(openTask.role);
  }, [openTask, roles]);

  /**
   * Writing is editable by anyone whose role holds the `write_content`
   * capability — the capability IS the gate, independent of which role currently
   * owns the stage. This mirrors the server, where the `mos_content` /
   * `mos_content_versions` / `mos_scenes` UPDATE policies gate on
   * `wassell_mos_can('write_content')`, not on stage ownership. (User decision
   * 2026-08-06: "capability alone lets you write" — a writer/CEO/anyone granted
   * write_content can type on a piece at a writing stage without holding the
   * stage's owning role.)
   *
   * Two structural guards remain, and are NOT about role ownership:
   *  - no open task → the workflow isn't active, there is nothing to edit;
   *  - an approval stage edits NOTHING — the fields shown are what is being
   *    approved, so nobody rewrites them mid-approval (you approve or return).
   * Advancing the task (submit / approve — see `canAct`) still follows stage
   * ownership; only EDITING the content body is capability-based.
   */
  const canEditNow = useMemo(() => {
    if (!openTask) return false;
    if (currentStep?.is_approval) return false;
    return can('write_content');
  }, [openTask, currentStep, can]);

  /**
   * The "oversight" view — sees the item but NOT its body/scripts, activity, or
   * version history. Formerly hardcoded to `role === 'ceo'`; now each facet is
   * its own capability (view_content_body / view_activity / compare_versions),
   * seeded so the default CEO preset reproduces the old behaviour but any role
   * can be reconfigured from the Roles screen. Kept as a boolean only where a
   * single "no content body" signal is what the code needs.
   */
  const hideContentBody = !can('view_content_body');

  /** «قادم إليك» — a LATER step on the pinned path belongs to a role I hold. */
  const upcomingForMe = useMemo(() => {
    if (!openTask || canAct || hideContentBody) return null;
    const currentPos = steps.find((s) => s.id === openTask.step_id)?.position ?? -1;
    if (currentPos < 0) return null;
    const mine = steps
      .filter((s) => s.position > currentPos && roles.includes(s.role))
      .sort((a, b) => a.position - b.position)[0];
    if (!mine) return null;
    return { step: mine, stepsAway: mine.position - currentPos };
  }, [openTask, canAct, hideContentBody, steps, roles]);

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

  // The step under review (for «اعتماد النص») is the one BEFORE an approval step.
  const reviewedStep = currentStep?.is_approval
    ? [...steps].sort((a, b) => a.position - b.position)
        .filter((s) => s.position < currentStep.position)
        .pop() ?? null
    : null;
  const nextStep = currentStep
    ? steps.find((s) => s.position === currentStep.position + 1) ?? null
    : null;

  // Screen 29's FIXED تعديلات/اعتماد bar — the phone twin of the header pair.
  const showFixBar = isMobile && !!openTask && canAct && currentStep?.is_approval === true;

  const ownerRoleLabel = item.owner_role
    ? ROLE_LABELS[item.owner_role]
      ? isAr ? ROLE_LABELS[item.owner_role].ar : ROLE_LABELS[item.owner_role].en
      : item.owner_role
    : null;

  const dueAt = item.current_task_due_at ?? item.due_at;
  const dueToday = dueAt ? daysFromNow(dueAt) === 0 : false;

  const runTaskAction = async (result: 'submitted' | 'approved'): Promise<void> => {
    if (!openTask) return;
    setActBusy(true);
    try {
      await completeTask(openTask.id, result);
      addToast(
        result === 'approved'
          ? isAr ? 'اعتُمد — انتقل إلى الخطوة التالية.' : 'Approved — it moved to the next stage.'
          : isAr ? 'أُرسل — انتقل إلى الخطوة التالية.' : 'Submitted — it moved to the next stage.',
        'success',
      );
      await load();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setActBusy(false);
    }
  };

  const openCompare = (): void => {
    setCompareOpen(true);
    if (versions !== null) return;
    fetchContentVersions(item.id)
      .then((res) => setVersions(res.versions))
      .catch((e: unknown) => {
        console.error('[marketing] version history unavailable', e);
        addToast(e instanceof Error ? e.message : String(e), 'error');
        setCompareOpen(false);
      });
  };

  const allTabs: Array<{ key: Tab; ar: string; en: string; badge?: number; needs?: Capability }> = [
    { key: 'overview', ar: 'نظرة عامة', en: 'Overview' },
    // The script/scenes tab requires `view_content_body` — the default CEO
    // preset lacks it, so an oversight role sees no script (screen 36), but
    // it's now a capability toggle, not a hardcoded role check.
    { key: 'content', ar: 'المحتوى', en: 'Content', needs: 'view_content_body' },
    { key: 'materials', ar: 'المواد', en: 'Material', badge: materialCount || undefined },
    { key: 'tasks', ar: 'المهام والاعتمادات', en: 'Tasks & approvals', badge: openTasks || undefined },
    { key: 'publishing', ar: 'النشر', en: 'Publishing', badge: openPubs || undefined },
    { key: 'performance', ar: 'الأداء', en: 'Performance' },
  ];
  const tabs = allTabs.filter((t) => !t.needs || can(t.needs));
  const activeTab: Tab = tabs.some((t) => t.key === tab) ? tab : 'overview';

  const plural = TYPE_PLURAL[item.content_type_key];
  const typePluralLabel = plural ? (isAr ? plural.ar : plural.en) : typeLabel(item.content_type_key);

  const upcomingCopy = upcomingForMe
    ? isAr
      ? `قادم إليك · بعد ${upcomingForMe.stepsAway === 1 ? 'خطوة' : upcomingForMe.stepsAway === 2 ? 'خطوتين' : `${num(upcomingForMe.stepsAway, true)} خطوات`}`
      : `Coming to you · ${upcomingForMe.stepsAway} step${upcomingForMe.stepsAway === 1 ? '' : 's'} away`
    : '';

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
              <span>{typePluralLabel}</span>
              <span className="sep">/</span>
              <span className="ltr">{item.ref}</span>
            </div>
            <h3>{mosText(item.title, 'title')}</h3>
            <div className="chips">
              <KindCell typeKey={item.content_type_key} label={typeLabel(item.content_type_key)} />
              {version > 1 && (
                <span className="tag">{isAr ? `النسخة ${num(version, true)}` : `Version ${version}`}</span>
              )}
              {(item.project_ids ?? []).map((pid) => (
                <span key={pid} className="tag">{projectName(pid)}</span>
              ))}
              {campaignName && campaignId && (
                <span
                  className="tag"
                  role="button"
                  tabIndex={0}
                  title={isAr ? 'فتح الحملة' : 'Open campaign'}
                  style={{ cursor: 'pointer', borderColor: 'var(--copper)', color: 'var(--copper)' }}
                  onClick={() => navigate(`/m/campaigns/${campaignId}`)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate(`/m/campaigns/${campaignId}`);
                    }
                  }}
                >
                  {isAr ? `الحملة: ${campaignName}` : `Campaign: ${campaignName}`}
                </span>
              )}
              <StatusPill row={item} isAr={isAr} />
              {ownerRoleLabel && (
                <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                  {isAr ? 'لدى ' : 'with '}
                  <b style={{ color: 'var(--ink)' }}>{ownerRoleLabel}</b>
                  {openTask && <> · {daysAgo(openTask.opened_at, isAr)}</>}
                </span>
              )}
              {overdue && dueAt && (
                <span style={{ fontSize: 11.5, color: 'var(--late)', fontWeight: 700 }}>
                  {isAr ? 'استحقاق ' : 'due '}
                  {shortDate(dueAt, isAr)} · {isAr ? 'متأخر' : 'late'}
                </span>
              )}
              {!overdue && dueToday && (
                <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                  {isAr ? 'الاستحقاق اليوم' : 'due today'}
                </span>
              )}
              {!overdue && !dueToday && dueAt && openTask && (
                <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                  {isAr ? 'الاستحقاق ' : 'due '}{shortDate(dueAt, isAr)}
                </span>
              )}
              <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                {isAr ? 'آخر تعديل ' : 'last edited '}{shortDate(item.updated_at, isAr)}
              </span>
            </div>
          </div>
          <div className="acts">
            {/* «مقارنة بالنسخة ١» — the compare panel renders the writing
                fields, so it is gated by `compare_versions` (an oversight role
                that can't see the body can't diff it either). */}
            {version > 1 && can('compare_versions') && (
              <button type="button" className="btn btn-d" onClick={openCompare}>
                {isAr ? `مقارنة بالنسخة ${num(version - 1, true)}` : `Compare with version ${version - 1}`}
              </button>
            )}
            {/* Screen 36: the header buttons are the CURRENT ROLE's buttons.
                They render only while the task is actionable — no disabled
                refusals. On the phone (s29) the approval pair moves to the
                FIXED bottom bar instead. */}
            {openTask && canAct && currentStep?.is_approval && !isMobile && (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={actBusy}
                  onClick={() => setRejectOpen(true)}
                >
                  {isAr ? 'طلب تعديلات' : 'Request changes'}
                </button>
                <button
                  type="button"
                  className="btn btn-go"
                  disabled={actBusy}
                  onClick={() => void runTaskAction('approved')}
                >
                  <IconCheck />
                  {isAr
                    ? `اعتماد ${reviewedStep?.label_ar ?? ''}`.trim()
                    : `Approve ${reviewedStep?.label_en ?? ''}`.trim()}
                </button>
              </>
            )}
            {openTask && canAct && currentStep && !currentStep.is_approval && (
              <button
                type="button"
                className="btn btn-p"
                disabled={actBusy}
                onClick={() => void runTaskAction('submitted')}
              >
                {isAr
                  ? nextStep?.is_approval ? 'إرسال للمراجعة' : 'إرسال للخطوة التالية'
                  : nextStep?.is_approval ? 'Submit for review' : 'Submit to the next stage'}
              </button>
            )}
          </div>
        </div>
        <div className="tabs">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              className={activeTab === t.key ? 'on' : ''}
              onClick={() => setTab(t.key)}
            >
              {isAr ? t.ar : t.en}
              {t.badge ? <span className="b">{num(t.badge, isAr)}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div className={`wsplit${showFixBar ? ' m2-pad' : ''}`}>
        <div className="wmain">
          {error && (
            <div style={{ marginBottom: 12 }}>
              <LoadError message={error} onRetry={() => void load()} isAr={isAr} />
            </div>
          )}

          {/* Screen 29, phone 2 — the prior rejection note pinned at the TOP
              of the phone screen, so the reviewer re-reads what they asked
              for without scrolling the thread. Desktop keeps it in the rail. */}
          {isMobile && lastRejection && (
            <div className="m2-note">
              <div className="t">
                {lastRejection.closed_by_user_id === appUserId
                  ? isAr
                    ? `ملاحظتك على النسخة ${num(lastRejection.round, true)}`
                    : `Your note on version ${lastRejection.round}`
                  : isAr
                    ? `ملاحظة المراجعة على النسخة ${num(lastRejection.round, true)}`
                    : `Review note on version ${lastRejection.round}`}
              </div>
              <div className="b">{lastRejection.note}</div>
            </div>
          )}

          {/* Screen 36: «قادم إليك» is NOT a task — the montage sees the work
              coming without a queue full of things they cannot start. */}
          {upcomingForMe && (
            <div className="up-banner">
              <Pill tone="idle">{upcomingCopy}</Pill>
              <span>
                {isAr
                  ? `«${upcomingForMe.step.label_ar}» — يظهر في مهامك عند وصوله، لا قبل.`
                  : `“${upcomingForMe.step.label_en}” — it appears in your queue when it arrives, not before.`}
              </span>
            </div>
          )}

          {activeTab === 'overview' && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: steps.length > 0 ? '1fr 216px' : '1fr',
                gap: 18,
                alignItems: 'start',
              }}
            >
              <div style={{ display: 'grid', gap: 16 }}>
                {openTask ? (
                  <TaskCard
                    item={item}
                    task={openTask}
                    step={currentStep}
                    scenes={scenes}
                    canAct={canAct}
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
                      {isAr ? 'يُحدَّد عند الإنشاء · قابل للتعديل حتى المونتاج' : 'set at creation · editable until montage'}
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
                        <ReadField label={isAr ? 'الهدف' : 'Goal'}>{mosText(item.goal, 'goal') || '—'}</ReadField>
                        <ReadField label={isAr ? 'الجمهور' : 'Audience'}>{mosText(item.audience, 'audience') || '—'}</ReadField>
                        <ReadField label={isAr ? 'الزاوية' : 'Angle'}>{mosText(item.angle, 'angle') || '—'}</ReadField>
                        <ReadField label={isAr ? 'دعوة الإجراء' : 'Call to action'}>{mosText(item.cta, 'cta') || '—'}</ReadField>
                        <ReadField label={isAr ? 'يُنشر على' : 'Publishing to'}>
                          {publications.length > 0
                            ? publications
                                .map((p) => (isAr ? PLATFORM_LABELS[p.platform]?.ar : PLATFORM_LABELS[p.platform]?.en) ?? p.platform)
                                .join(isAr ? ' · ' : ' · ')
                            : '—'}
                        </ReadField>
                        <ReadField label={isAr ? 'المدة المستهدفة' : 'Target duration'}>
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
                        ? `${num(publications.length, true)} منصة${publications.every((p) => !p.scheduled_at && !p.published_at) && publications.length > 0 ? ' · لا شيء مجدول بعد' : ''}`
                        : `${publications.length} platforms${publications.every((p) => !p.scheduled_at && !p.published_at) && publications.length > 0 ? ' · nothing scheduled yet' : ''}`}
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
                                  ? dateTimeShort(p.published_at ?? p.scheduled_at, isAr)
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

              {/* Screen 06 keeps the stage rail INSIDE the overview — a card
                  beside the task, not part of the activity rail. */}
              {steps.length > 0 && (
                <StageRail
                  steps={steps}
                  tasks={tasks}
                  workflowLabel={typeLabel(item.content_type_key)}
                  isAr={isAr}
                />
              )}
            </div>
          )}

          {activeTab === 'content' && (
            <div style={{ display: 'grid', gap: 16 }}>
              <WritingFields
                contentId={item.id}
                schema={fieldSchemaKeys(type?.field_schema ?? [])}
                data={item.data ?? {}}
                canEdit={canEditNow}
                isAr={isAr}
                projectName={projectName}
                onSaved={(data) => setItem({ ...item, data })}
              />
              {/* Screen 29, phone 2: on the phone the scenes render as a
                  READABLE list with a duration bar, not a compressed table. */}
              {(item.content_type_key === 'video' || scenes.length > 0) && (
                isMobile ? (
                  scenes.length > 0 && <MobileSceneList scenes={scenes} isAr={isAr} />
                ) : (
                  <SceneTable
                    contentId={item.id}
                    contentTitle={item.title}
                    projectId={item.project_id}
                    scenes={scenes}
                    canEdit={canEditNow}
                    canRaiseShoot={can('assign')}
                    isAr={isAr}
                    onChange={setScenes}
                  />
                )
              )}
            </div>
          )}

          {activeTab === 'materials' && (
            <MaterialsTab
              contentId={item.id}
              projectId={item.project_id}
              canEdit={can('manage_assets') || canEditNow}
              isAr={isAr}
              onCount={setMaterialCount}
              approvalAssetId={item.approval_asset_id ?? null}
            />
          )}

          {activeTab === 'tasks' && (
            <TasksApprovalsTab
              item={item}
              tasks={tasks}
              steps={steps}
              scenes={scenes}
              canApprove={canAct && currentStep?.is_approval === true}
              onRequestChanges={() => setRejectOpen(true)}
              onDone={() => void load()}
              isAr={isAr}
            />
          )}


          {activeTab === 'publishing' && (
            <PublishTab
              contentId={item.id}
              publications={publications}
              accounts={accounts}
              canEdit={can('schedule') || can('publish')}
              isAr={isAr}
              onChange={setPublications}
            />
          )}

          {activeTab === 'performance' && (
            <PerformanceTab
              publications={publications}
              canEnter={can('enter_metrics')}
              isAr={isAr}
            />
          )}
        </div>

        {/* The activity rail — screen 06's persistent side column. Gated by
            `view_activity`; the default CEO preset lacks it, so an oversight
            role sees no comments (screen 36) — now a toggle, not a role check. */}
        {can('view_activity') && (
          <div className="wside wide">
            <ActivityRail
              item={item}
              comments={comments}
              tasks={tasks}
              steps={steps}
              people={people}
              version={version}
              lastRejection={lastRejection}
              canComment={can('comment')}
              isAr={isAr}
              onCommentsChange={setComments}
            />
          </div>
        )}
      </div>

      {/* Screen 29's FIXED bottom bar — تعديلات / اعتماد, floating above the
          tab bar so the decision never needs a scroll to the header. */}
      {showFixBar && openTask && (
        <div className="m2-fix">
          <button
            type="button"
            className="m2-btn"
            style={{ flex: '0 0 132px' }}
            disabled={actBusy}
            onClick={() => setRejectOpen(true)}
          >
            {isAr ? 'تعديلات' : 'Changes'}
          </button>
          <button
            type="button"
            className="m2-btn g"
            disabled={actBusy}
            onClick={() => setApproveOpen(true)}
          >
            {isAr ? 'اعتماد' : 'Approve'}
          </button>
        </div>
      )}

      {/* Screen 29, phone 3 — the approval sheet: checklist above the
          buttons, «اعتماد رغم النقص» as a conscious path. */}
      {approveOpen && openTask && (
        <ApprovalSheet
          openTask={openTask}
          step={currentStep}
          reviewedStep={reviewedStep}
          nextStep={nextStep}
          scenes={scenes}
          data={item.data ?? {}}
          isAr={isAr}
          onClose={() => setApproveOpen(false)}
          onDone={() => { setApproveOpen(false); void load(); }}
        />
      )}

      {rejectOpen && openTask && (
        <RequestChangesModal
          item={item}
          openTask={openTask}
          steps={steps}
          scenes={scenes}
          fields={fieldSchemaEntries(type?.field_schema ?? [])}
          isAr={isAr}
          onClose={() => setRejectOpen(false)}
          onSubmitted={() => { setRejectOpen(false); void load(); }}
        />
      )}

      {compareOpen && (
        <CompareModal
          itemRef={item.ref}
          versions={versions}
          currentRound={version}
          isAr={isAr}
          onClose={() => setCompareOpen(false)}
        />
      )}
    </>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Screen 29, phone 2 — «المشاهد» as a READABLE phone list: a proportional
   duration bar on top, then one row per scene (number · time · footage pill,
   visual line under). Read-only by design: the phone flow is for REVIEWING;
   scene editing stays on the desktop SceneTable.
   ════════════════════════════════════════════════════════════════════════ */

/** The mockup's bar segment colours, cycled in its exact order. */
const SCENE_BAR_COLORS = [
  'var(--choc)', 'var(--copper)', 'var(--terracotta)',
  'var(--copper)', 'var(--gold)', 'var(--choc)',
];

const FOOTAGE_TONE: Record<MosScene['footage_status'], string> = {
  have: 'p-go',
  missing: 'p-late',
  to_make: 'p-wait',
  template: 'p-idle',
};

function MobileSceneList({ scenes, isAr }: { scenes: MosScene[]; isAr: boolean }) {
  const sorted = [...scenes].sort((a, b) => a.position - b.position);

  // Segment widths: proportional when every scene carries a valid duration,
  // an even split otherwise — a half-timed script must not draw a lying bar.
  const durations = sorted.map((s) =>
    s.start_sec != null && s.end_sec != null && s.end_sec > s.start_sec
      ? s.end_sec - s.start_sec
      : null,
  );
  const allTimed = durations.every((d): d is number => d !== null);
  const totalDur = allTimed ? durations.reduce((a, b) => a + (b ?? 0), 0) : 0;
  const widthOf = (i: number): string =>
    allTimed && totalDur > 0
      ? `${(((durations[i] ?? 0) / totalDur) * 100).toFixed(1)}%`
      : `${(100 / sorted.length).toFixed(1)}%`;

  // «٦ · ٣٨ ثانية» — count · the last scene's end second.
  const totalSec = sorted.reduce((a, s) => Math.max(a, s.end_sec ?? 0), 0);
  const tag = totalSec > 0
    ? isAr
      ? `${num(sorted.length, true)} · ${num(totalSec, true)} ثانية`
      : `${sorted.length} · ${totalSec}s`
    : num(sorted.length, isAr);

  const timeOf = (s: MosScene): string | null =>
    s.start_sec != null && s.end_sec != null
      ? isAr
        ? `${num(s.start_sec, true)}–${num(s.end_sec, true)}ث`
        : `${s.start_sec}–${s.end_sec}s`
      : null;

  return (
    <div className="m2-scenes">
      <div className="hd">
        <span className="l">{isAr ? 'المشاهد' : 'Scenes'}</span>
        <span className="tag">{tag}</span>
      </div>
      <div className="m2-bar">
        {sorted.map((s, i) => (
          <i
            key={s.id}
            style={{ width: widthOf(i), background: SCENE_BAR_COLORS[i % SCENE_BAR_COLORS.length] }}
          />
        ))}
      </div>
      {sorted.map((s) => {
        const t = timeOf(s);
        return (
          <div key={s.id} className="m2-scene">
            <div className="row">
              <span className="n">{num(s.position, isAr)}</span>
              {t && <span className="t">{t}</span>}
              <span className={`pill ${FOOTAGE_TONE[s.footage_status] ?? 'p-idle'}`}>
                {(isAr ? FOOTAGE_LABELS[s.footage_status]?.ar : FOOTAGE_LABELS[s.footage_status]?.en)
                  ?? s.footage_status}
              </span>
            </div>
            {(s.visual || s.voiceover) && (
              <div className="v">{s.visual ?? s.voiceover}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   The activity rail — screens 06/07/08, right column, present on EVERY tab.
   Comments and the task chain share one timeline, newest first, so "why did
   this come back?" is answered by scrolling rather than by asking.
   ════════════════════════════════════════════════════════════════════════ */
function ActivityRail({
  item, comments, tasks, steps, people, version, lastRejection, canComment, isAr, onCommentsChange,
}: {
  item: MosContentRow;
  comments: MosComment[];
  tasks: MosTask[];
  steps: MosStep[];
  people: RolePerson[];
  version: number;
  lastRejection: MosTask | null;
  canComment: boolean;
  isAr: boolean;
  onCommentsChange: (comments: MosComment[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [collapsed, setCollapsed] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const person = (userId: string | null | undefined): RolePerson | null =>
    userId ? people.find((x) => x.user_id === userId) ?? null : null;
  const nameOf = (userId: string | null | undefined): string => {
    const u = person(userId);
    if (!u) return isAr ? 'النظام' : 'System';
    return (isAr ? u.name_ar : u.name_en) ?? u.name_en ?? u.name_ar ?? (isAr ? 'النظام' : 'System');
  };
  const avatarOf = (userId: string | null | undefined): string => {
    const u = person(userId);
    const role = u?.roles.find((r) => r !== 'viewer' && r !== 'none') ?? u?.roles[0] ?? null;
    return roleAvatarClass(role);
  };

  const stepLabel = (stepId: string | null): string => {
    const s = steps.find((x) => x.id === stepId);
    return s ? (isAr ? s.label_ar : s.label_en) : isAr ? 'خطوة' : 'a stage';
  };
  /** The thing an approval approved: the step BEFORE the approval step. */
  const approvedThing = (stepId: string | null): string => {
    const s = steps.find((x) => x.id === stepId);
    if (!s) return stepLabel(stepId);
    const prev = [...steps].sort((a, b) => a.position - b.position)
      .filter((x) => x.position < s.position).pop();
    return prev ? (isAr ? prev.label_ar : prev.label_en) : (isAr ? s.label_ar : s.label_en);
  };

  interface SysEntry {
    key: string;
    at: string;
    node: ReactNode;
  }

  const systemEntries: SysEntry[] = [
    ...tasks
      .filter((t) => t.status === 'done' && t.closed_at)
      .map((t) => {
        const name = nameOf(t.closed_by_user_id);
        const when = relDay(t.closed_at, isAr);
        let node: ReactNode;
        if (t.result === 'approved') {
          node = isAr
            ? <><b>{name}</b> اعتمد <b>{approvedThing(t.step_id)}</b> · {when}</>
            : <><b>{name}</b> approved <b>{approvedThing(t.step_id)}</b> · {when}</>;
        } else if (t.result === 'changes_requested') {
          node = isAr
            ? <><b>{name}</b> أعاد <b>النسخة {num(t.round, true)}</b> — طلب تعديلات · {when}</>
            : <><b>{name}</b> sent back <b>version {t.round}</b> — changes requested · {when}</>;
        } else {
          node = isAr
            ? <><b>{name}</b> أرسل <b>النسخة {num(t.round, true)}</b> للمراجعة · {when}</>
            : <><b>{name}</b> submitted <b>version {t.round}</b> for review · {when}</>;
        }
        return { key: `t-${t.id}`, at: t.closed_at ?? '', node };
      }),
    // The creation line — «مريم أنشأت V-004 · ١٨ يوليو».
    ...(item.created_at
      ? [{
          key: 'created',
          at: item.created_at,
          node: isAr
            ? <><b>{nameOf(item.created_by_user_id)}</b> أنشأ <b className="ltr">{item.ref}</b> · {relDay(item.created_at, true)}</>
            : <><b>{nameOf(item.created_by_user_id)}</b> created <b className="ltr">{item.ref}</b> · {relDay(item.created_at, false)}</>,
        }]
      : []),
  ];

  const entries = [
    ...comments.map((c) => ({ key: `c-${c.id}`, at: c.created_at, comment: c })),
    ...systemEntries.map((s) => ({ key: s.key, at: s.at, sys: s.node })),
  ].sort((a, b) => b.at.localeCompare(a.at)); // newest first — the rail's order

  /** @mentions render in copper, as in the mockups. */
  const renderBody = (body: string): ReactNode =>
    body.split(/(@[^\s@]+)/g).map((part, i) =>
      part.startsWith('@') ? <span key={i} className="mn">{part}</span> : part,
    );

  const send = async (): Promise<void> => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      const res = await addComment({ contentId: item.id }, body);
      onCommentsChange(res.comments);
      setText('');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
        <div className="lbl">{isAr ? 'النشاط والتعليقات' : 'Activity & comments'}</div>
        <button
          type="button"
          className="btn btn-d btn-sm"
          style={{ marginInlineStart: 'auto' }}
          onClick={() => setCollapsed((v) => !v)}
        >
          {collapsed ? (isAr ? 'عرض' : 'Show') : (isAr ? 'طيّ' : 'Collapse')}
        </button>
      </div>

      {!collapsed && (
        <>
          {canComment && (
            <div style={{ marginBottom: 13 }}>
              <textarea
                className="inp"
                rows={2}
                style={{ width: '100%', fontSize: 12 }}
                placeholder={isAr ? 'اكتب تعليقًا، أو اذكر شخصًا…' : 'Write a comment, or mention someone…'}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
                }}
              />
              {text.trim() !== '' && (
                <button
                  type="button"
                  className="btn btn-p btn-sm"
                  style={{ marginTop: 7 }}
                  disabled={busy}
                  onClick={() => void send()}
                >
                  <IconSend />
                  {isAr ? 'إرسال' : 'Post'}
                </button>
              )}
            </div>
          )}

          {/* The pinned review note — screen 07's open-rejection card. */}
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
                {nameOf(lastRejection.closed_by_user_id)} · {shortDate(lastRejection.closed_at, isAr)}
                {version > lastRejection.round && (
                  <> · {isAr ? `عولجت في النسخة ${num(version, true)}` : `addressed in version ${version}`}</>
                )}
              </div>
            </div>
          )}

          {entries.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--mute)', padding: '10px 0' }}>
              {isAr ? 'لا شيء بعد.' : 'Nothing yet.'}
            </div>
          )}

          {entries.map((e) =>
            'comment' in e ? (
              <div key={e.key} className="thread">
                <span className={`av ${avatarOf(e.comment.author_user_id)}`}>
                  {initial(nameOf(e.comment.author_user_id))}
                </span>
                <div className="bd">
                  <div className="who2">
                    {nameOf(e.comment.author_user_id)}
                    <span className="tm">{relDay(e.comment.created_at, isAr)}</span>
                  </div>
                  <div className="msg">{renderBody(e.comment.body)}</div>
                </div>
              </div>
            ) : (
              <div key={e.key} className="thread">
                <div className="bd"><div className="sys">{e.sys}</div></div>
              </div>
            ),
          )}
        </>
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   «مقارنة بالنسخة ١» — two frozen submissions side by side; changed fields
   are lit so the reviewer diffs with their eyes, not their memory.
   ════════════════════════════════════════════════════════════════════════ */
function CompareModal({
  itemRef, versions, currentRound, isAr, onClose,
}: {
  itemRef: string | null;
  versions: MosContentVersion[] | null;
  currentRound: number;
  isAr: boolean;
  onClose: () => void;
}) {
  const cmp = useMemo(() => {
    if (!versions || versions.length === 0) return null;
    const newer = versions[versions.length - 1] ?? null;
    const older = versions.length > 1 ? versions[versions.length - 2] ?? null : null;
    return newer ? { older, newer } : null;
  }, [versions]);

  const labelOf = (key: string): string => {
    const m = DATA_LABELS[key];
    return m ? (isAr ? m.ar : m.en) : key;
  };

  const valueOf = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return '—';
    if (Array.isArray(v)) return v.map((x) => String(x)).join(isAr ? '، ' : ', ') || '—';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };

  const fieldRows = useMemo(() => {
    if (!cmp) return [];
    const a = cmp.older?.data ?? {};
    const b = cmp.newer.data ?? {};
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((k) => !k.startsWith('_'))
      .sort((x, y) => labelOf(x).localeCompare(labelOf(y), 'ar'));
    return keys.map((k) => ({
      key: k,
      label: labelOf(k),
      oldV: valueOf(a[k]),
      newV: valueOf(b[k]),
      changed: JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmp, isAr]);

  const sceneRows = useMemo(() => {
    if (!cmp) return [];
    const a = cmp.older?.scenes ?? [];
    const b = cmp.newer.scenes ?? [];
    const positions = [...new Set([...a, ...b].map((s) => s.position))].sort((x, y) => x - y);
    const byPos = (list: MosScene[], pos: number) => list.find((s) => s.position === pos) ?? null;
    const summary = (s: MosScene | null): string => {
      if (!s) return '—';
      const parts = [s.visual, s.voiceover, s.on_screen_text].filter((x): x is string => !!x);
      return parts.join(' · ') || '—';
    };
    return positions.map((pos) => {
      const o = byPos(a, pos);
      const n = byPos(b, pos);
      return {
        pos,
        oldV: summary(o),
        newV: summary(n),
        changed: JSON.stringify(o ?? null) !== JSON.stringify(n ?? null),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmp, isAr]);

  return (
    <Modal
      wide
      title={isAr ? `مقارنة النسخ · ${itemRef ?? ''}` : `Compare versions · ${itemRef ?? ''}`}
      sub={cmp?.older
        ? isAr
          ? `النسخة ${num(cmp.older.round, true)} ← النسخة ${num(cmp.newer.round, true)} — المتغيّر مضاء`
          : `Version ${cmp.older.round} ← version ${cmp.newer.round} — changes lit`
        : isAr ? `النسخة ${num(currentRound, true)}` : `Version ${currentRound}`}
      onClose={onClose}
    >
      {!cmp ? (
        <div style={{ fontSize: 12.5, color: 'var(--mute)', textAlign: 'center', padding: 18 }}>
          {versions === null
            ? isAr ? 'جارٍ التحميل…' : 'Loading…'
            : isAr ? 'لا نسخ محفوظة بعد — تُحفظ النسخة عند كل إرسال للمراجعة.' : 'No saved versions yet — a version is frozen on every submit for review.'}
        </div>
      ) : (
        <>
          <div className="cmp-head">
            <div />
            <div>
              <div className="lbl">{isAr ? `النسخة ${num(cmp.older?.round ?? 0, true)}` : `Version ${cmp.older?.round ?? 0}`}</div>
              <div style={{ fontSize: 11, color: 'var(--mute)' }}>{shortDate(cmp.older?.created_at, isAr)}</div>
              {cmp.older?.rejected_note && (
                <div style={{ fontSize: 11, color: 'var(--late)', marginTop: 4, lineHeight: 1.7 }}>
                  {isAr ? `رُفضت: ${cmp.older.rejected_note}` : `Rejected: ${cmp.older.rejected_note}`}
                </div>
              )}
            </div>
            <div>
              <div className="lbl">{isAr ? `النسخة ${num(cmp.newer.round, true)}` : `Version ${cmp.newer.round}`}</div>
              <div style={{ fontSize: 11, color: 'var(--mute)' }}>{shortDate(cmp.newer.created_at, isAr)}</div>
            </div>
          </div>

          {fieldRows.length > 0 && (
            <div>
              {fieldRows.map((r) => (
                <div key={r.key} className="cmp-row">
                  <div className="cmp-k">{r.label}</div>
                  <div className={`cmp-v${r.changed ? ' chg-old' : ''}`}>{r.oldV}</div>
                  <div className={`cmp-v${r.changed ? ' chg' : ''}`}>{r.newV}</div>
                </div>
              ))}
            </div>
          )}

          {sceneRows.length > 0 && (
            <div>
              <div className="lbl" style={{ margin: '8px 0 2px' }}>
                {isAr ? 'المشاهد' : 'Scenes'}
              </div>
              {sceneRows.map((r) => (
                <div key={r.pos} className="cmp-row">
                  <div className="cmp-k">{isAr ? `المشهد ${num(r.pos, true)}` : `Scene ${r.pos}`}</div>
                  <div className={`cmp-v${r.changed ? ' chg-old' : ''}`}>{r.oldV}</div>
                  <div className={`cmp-v${r.changed ? ' chg' : ''}`}>{r.newV}</div>
                </div>
              ))}
            </div>
          )}

          {fieldRows.every((r) => !r.changed) && sceneRows.every((r) => !r.changed) && (
            <div style={{ fontSize: 12, color: 'var(--mute)', textAlign: 'center', padding: 10 }}>
              {isAr ? 'لا فرق بين النسختين.' : 'No differences between the two versions.'}
            </div>
          )}
        </>
      )}
    </Modal>
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
  const [projectIds, setProjectIds] = useState<string[]>(row.project_ids ?? []);
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
        project_ids: projectIds,
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
          <ProjectMultiSelect projects={projects} value={projectIds} onChange={setProjectIds} isAr={isAr} />
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
