/**
 * «معاينة» — the ONE popup that shows a content item without leaving the page
 * you are on.
 *
 * It opens the ACTUAL CONTENT, never a summary of it:
 *   the material  → the FINAL APPROVED design (labelled as such), then the
 *                   file submitted for approval, then the other linked
 *                   materials;
 *   the writing   → the writing fields (editable while the stage is a working
 *                   step and the caller can write; locked text otherwise) and
 *                   the scenes;
 *   the caption   → the canonical caption and hashtags plus any per-platform
 *                   override, and the paid ad copy;
 *   the plan      → the publishing plan and every ad this creative runs on.
 * The open SECTION (from `contentRoute.sectionForStep`, never a hardcoded step
 * key) decides the ORDER, so a design review opens on the design and a
 * scheduling task opens on the plan. A finished item opens on its final
 * materials — the same answer the detail page and every deep link now give.
 *
 * When there is NO design yet the popup says so in words («لا تصميم بعد») over
 * the project cover, and shows what DOES exist: the writing, the caption, the
 * design references, and whatever the current stage has produced.
 *
 * The footer carries the CURRENT ROLE's action — the same `task_complete` flow
 * the content page's header uses. When the open stage is not the caller's, the
 * popup is read-only and says so; it never shows a button that would only 403.
 *
 * `usePreview()` is how a page mounts this: ONE modal per page, any row can
 * open it. Every list in the workspace uses it, so «معاينة» means the same
 * thing everywhere.
 */
import {
  useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosAsset, MosAssetLink, MosCampaign, MosContentRow, MosPublication, MosScene, MosStep, MosTask,
  PaidPlacement,
  PLATFORM_LABELS, PUB_STATUS_LABELS, ROLE_LABELS,
  adSetRequiredChoices, completeTask, fetchAssets, fetchCampaigns, fetchContentDetail, fetchPaidAds,
  fetchPublications, fieldSchemaEntries, fieldSchemaKeys,
} from '@/lib/marketingOS/client';
import { AutoAdPanel, autoAdOutcomeText, useAutoAdPreview } from './AutoAdApproval';
import CaptionReviewCard from './CaptionReviewCard';
import { useWorkspace } from '../MarketingWorkspace';
import { Modal, Pill, Skeleton, LoadError } from './kit';
import Thumb from './Thumb';
import { IconCheck, IconLibrary } from './icons';
import WritingFields from './WritingFields';
import RequestChangesModal from './RequestChangesModal';
import { useAssetUrls } from '../lib/assetUrls';
import { dateTimeShort, num, shortDate } from '../lib/format';
import { stageIsMine } from '../lib/stagePhase';
import {
  SECTION_LABELS, contentHref, sectionForStep, type ContentSection,
} from '../lib/contentRoute';

/* ── the fields the server is adding in parallel ────────────────────── */

/**
 * `mos_content_v` gains `plan_status` / `required_ready_at` / `need_at` /
 * `caption` in the campaign-planning migration, and `attachContentPreviews`
 * adds the project cover. Every one is optional here: the popup renders
 * correctly the day before those columns exist and the day after.
 */
interface PlanningFields {
  plan_status?: string | null;
  required_ready_at?: string | null;
  need_at?: string | null;
  caption?: string | null;
  caption_confirmed?: boolean | null;
  project_cover_url?: string | null;
}

type PreviewRow = MosContentRow & PlanningFields;

const PLAN_STATUS_LABELS: Record<string, { ar: string; en: string }> = {
  planned:       { ar: 'مخطّط',        en: 'Planned' },
  in_production: { ar: 'تحت الإنتاج',  en: 'In production' },
  ready:         { ar: 'جاهز',         en: 'Ready' },
  published:     { ar: 'منشور',        en: 'Published' },
  at_risk:       { ar: 'معرّض للتأخر', en: 'At risk' },
  late:          { ar: 'متأخر',        en: 'Late' },
};

/** The per-platform caption keys, Instagram being the legacy bare `caption`. */
const CAPTION_KEYS: Array<{ key: string; platform: string }> = [
  { key: 'caption', platform: 'instagram' },
  { key: 'caption_tiktok', platform: 'tiktok' },
  { key: 'caption_x', platform: 'x' },
  { key: 'caption_snapchat', platform: 'snapchat' },
];

/** Body order: what the reader came to look at goes first. */
type BodyOrder = 'writing_first' | 'materials_first' | 'plan_first';

function orderForSection(section: ContentSection): BodyOrder {
  if (section === 'schedule' || section === 'publish_check') return 'plan_first';
  if (section === 'writing' || section === 'writing_review'
    || section === 'caption' || section === 'overview') return 'writing_first';
  return 'materials_first';
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/* ── the popup ──────────────────────────────────────────────────────── */

export interface ContentPreviewProps {
  contentId: string;
  isAr: boolean;
  onClose: () => void;
  /** Fired after an action moved the item a stage — the caller refreshes. */
  onChanged: () => void;
  /**
   * Open on a specific section (a task's own step, a caption review, the final
   * materials of a finished item). Absent = the item's own current stage.
   */
  initialSection?: ContentSection | null;
  /** Where «فتح الصفحة كاملة» goes. Default: react-router `navigate`. */
  onNavigate?: (href: string) => void;
}

export default function ContentPreview({
  contentId, isAr, onClose, onChanged, initialSection, onNavigate,
}: ContentPreviewProps) {
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);
  const { roles, can, contentTypes, people, projectName } = useWorkspace();

  const [item, setItem] = useState<PreviewRow | null>(null);
  const [tasks, setTasks] = useState<MosTask[]>([]);
  const [scenes, setScenes] = useState<MosScene[]>([]);
  const [steps, setSteps] = useState<MosStep[]>([]);
  const [assets, setAssets] = useState<MosAsset[]>([]);
  const [links, setLinks] = useState<MosAssetLink[]>([]);
  const [publications, setPublications] = useState<MosPublication[]>([]);
  // Paid placements whose AI caption is parked for approval — the body of the
  // «مهامي» caption task (2026-09-13). Fetched for every viewer (RLS decides
  // what comes back); only manage_paid_ads can act.
  const [paid, setPaid] = useState<PaidPlacement[]>([]);
  // The parent campaign's name, for the header's «الحملة ← الإعلانية» chain.
  // Only fetched when the item has a campaign and no paid placement already
  // carries the name (a placement resolves its own campaign path).
  const [campaign, setCampaign] = useState<MosCampaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  // Set once an action advanced the item, so closing the popup refreshes the list.
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail = await fetchContentDetail(contentId);
      setItem(detail.item as PreviewRow);
      setTasks(detail.tasks);
      setScenes(detail.scenes);
      setSteps(detail.steps);
      // Not fatal to the popup: the caption card is simply absent, and the
      // failure is logged loudly rather than swallowed.
      try {
        setPaid((await fetchPaidAds(contentId)).placements);
      } catch (pe) {
        console.error('[marketing] preview paid placements unavailable', pe);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [contentId]);

  useEffect(() => { void load(); }, [load]);

  const openTask = tasks.find((t) => t.status === 'open') ?? null;
  const captionReviews = paid.filter((p) => p.creative?.auto_ad?.state === 'caption_review' || p.creative?.auto_ad?.state === 'failed');
  const canReviewCaption = can('manage_paid_ads');
  const currentStep = openTask ? steps.find((s) => s.id === openTask.step_id) ?? null : null;
  const sortedSteps = useMemo(() => [...steps].sort((a, b) => a.position - b.position), [steps]);
  // Auto Meta ad: when the step being approved creates the ad, the popup shows
  // the target ad set (or asks which) exactly like the page's approval dialog.
  const autoAdStep = currentStep?.auto_meta_ad === true && currentStep.is_approval;
  const autoAdState = useAutoAdPreview(contentId, autoAdStep);
  const needsAdSetPick = autoAdStep && autoAdState.preview?.kind === 'choose' && !autoAdState.adSetId;

  /**
   * The section this popup is showing. An explicit `initialSection` (a task's
   * own step, a caption review) wins; otherwise it is the item's current stage,
   * and a finished item is always its final materials.
   */
  const section: ContentSection = useMemo(() => {
    if (initialSection) return initialSection;
    if (!item) return 'overview';
    if (item.status_key === 'done') return 'materials_final';
    return sectionForStep(sortedSteps, currentStep?.key ?? item.status_key);
  }, [initialSection, item, currentStep, sortedSteps]);

  const order = orderForSection(section);

  // The linked materials — ALWAYS fetched: the material is the content, whatever
  // the stage. The publication plan only matters once the item is publishing
  // or done. A failure is shown in place (the header still renders), never
  // swallowed.
  useEffect(() => {
    if (!item) return undefined;
    let alive = true;
    fetchAssets()
      .then((res) => {
        if (!alive) return;
        const mine = res.links.filter((l) => l.content_id === contentId);
        const ids = new Set(mine.map((l) => l.asset_id));
        setLinks(mine);
        setAssets(res.assets.filter((a) => ids.has(a.id)));
      })
      .catch((e: unknown) => {
        console.error('[marketing] preview materials unavailable', e);
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    // The plan is part of the header now (planned publish, plan status), so it
    // is fetched for every item rather than only for publishing ones.
    fetchPublications(contentId)
      .then((res) => { if (alive) setPublications(res.publications); })
      .catch((e: unknown) => {
        console.error('[marketing] preview publications unavailable', e);
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, [item, contentId]);

  // The campaign name for the header chain — skipped entirely when a paid
  // placement already carries it, and never fatal.
  const campaignId = item?.campaign_id ?? null;
  const placementCampaignName = paid[0]?.execution.campaign_name ?? null;
  useEffect(() => {
    if (!campaignId || placementCampaignName) return undefined;
    let alive = true;
    fetchCampaigns()
      .then((res) => {
        if (alive) setCampaign(res.campaigns.find((c) => c.id === campaignId) ?? null);
      })
      .catch((e: unknown) => {
        console.error('[marketing] preview campaign name unavailable', e);
      });
    return () => { alive = false; };
  }, [campaignId, placementCampaignName]);

  const { urlFor, thumbFor } = useAssetUrls(assets);

  const canAct = !!openTask && stageIsMine(roles, openTask.role);
  const canEdit = !!openTask && currentStep?.is_approval !== true && can('write_content');
  const reviewedStep = currentStep?.is_approval
    ? sortedSteps.filter((s) => s.position < currentStep.position).pop() ?? null
    : null;
  const nextStep = currentStep
    ? steps.find((s) => s.position === currentStep.position + 1) ?? null
    : null;
  const type = item ? contentTypes.find((t) => t.key === item.content_type_key) ?? null : null;

  const close = (): void => {
    if (changed) onChanged();
    onClose();
  };

  const act = async (result: 'submitted' | 'approved'): Promise<void> => {
    if (!openTask) return;
    setBusy(true);
    try {
      const res = await completeTask(openTask.id, result, undefined, undefined,
        autoAdStep && result === 'approved' ? { adSetId: autoAdState.adSetId } : undefined);
      addToast(
        autoAdOutcomeText(res.auto_ad, isAr)
          ?? (result === 'approved'
            ? isAr ? 'اعتُمد — انتقل إلى الخطوة التالية.' : 'Approved — it moved to the next stage.'
            : isAr ? 'أُرسل — انتقل إلى الخطوة التالية.' : 'Submitted — it moved to the next stage.'),
        res.auto_ad?.status === 'skipped' ? 'info' : 'success',
      );
      setChanged(true);
      await load();
    } catch (e) {
      const choices = adSetRequiredChoices(e);
      if (choices) {
        autoAdState.offerChoices(choices);
        addToast(isAr ? 'اختر المجموعة الإعلانية أولًا.' : 'Pick the ad set first.', 'error');
      } else {
        addToast(e instanceof Error ? e.message : String(e), 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  // One resolver decides the URL — the same one the list rows and the task
  // rows use, so «فتح الصفحة كاملة» lands exactly where a click would have.
  const fullHref = item
    ? contentHref({ id: item.id, status_key: item.status_key }, sortedSteps, { section })
    : `/m/content/${contentId}`;

  const openFull = (): void => {
    onClose();
    if (changed) onChanged();
    if (onNavigate) onNavigate(fullHref);
    else navigate(fullHref);
  };

  const stepLabel = currentStep
    ? (isAr ? currentStep.label_ar : currentStep.label_en)
    : item?.status_key === 'done'
      ? (isAr ? 'منشور' : 'Published')
      : (isAr ? 'بلا مرحلة مفتوحة' : 'No open stage');
  const ownerRoleLabel = openTask && ROLE_LABELS[openTask.role]
    ? (isAr ? ROLE_LABELS[openTask.role].ar : ROLE_LABELS[openTask.role].en)
    : null;
  // The PERSON holding the stage, not just their role — «لدى سارة (مونتاج)».
  const ownerPerson = (() => {
    const uid = openTask?.assignee_user_id ?? item?.current_assignee_user_id ?? null;
    if (!uid) return null;
    const p = people.find((x) => x.user_id === uid);
    if (!p) return null;
    return (isAr ? p.name_ar ?? p.name_en : p.name_en ?? p.name_ar) ?? p.email ?? null;
  })();
  const ownerLabel = ownerPerson
    ? ownerRoleLabel ? `${ownerPerson} (${ownerRoleLabel})` : ownerPerson
    : ownerRoleLabel;

  /* ── header facts ───────────────────────────────────────────────────── */

  const campaignName = placementCampaignName ?? campaign?.name ?? null;
  const execution = paid[0]?.execution ?? null;
  const executionLabel = execution
    ? [
        execution.label,
        (isAr ? PLATFORM_LABELS[execution.platform]?.ar : PLATFORM_LABELS[execution.platform]?.en) ?? execution.platform,
      ].filter(Boolean).join(' · ')
    : null;

  const projectLabel = (() => {
    const ids = item?.project_ids ?? [];
    if (ids.length === 0) return null;
    const names = ids.map((id) => projectName(id));
    return names.length <= 2
      ? names.join(isAr ? '، ' : ', ')
      : `${names.slice(0, 2).join(isAr ? '، ' : ', ')} +${num(names.length - 2, isAr)}`;
  })();

  const plannedPublish = (() => {
    const scheduled = publications
      .filter((p) => p.status !== 'cancelled')
      .map((p) => p.published_at ?? p.scheduled_at)
      .filter((v): v is string => !!v)
      .sort()[0] ?? null;
    return scheduled ?? item?.need_at ?? item?.target_publish_at ?? null;
  })();
  const plannedIsTarget = !publications.some((p) => p.status !== 'cancelled' && (p.published_at ?? p.scheduled_at));

  const planStatus = item?.plan_status ?? null;
  const planStatusLabel = planStatus
    ? (isAr ? PLAN_STATUS_LABELS[planStatus]?.ar : PLAN_STATUS_LABELS[planStatus]?.en) ?? planStatus
    : null;

  const header = item ? (
    <div
      style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px',
        fontSize: 12, color: 'var(--mute)', marginBottom: 14,
        paddingBottom: 12, borderBottom: '1px solid var(--line-soft, var(--line))',
      }}
    >
      <Pill tone={item.status_key === 'done' ? 'live' : canAct ? 'now' : 'wait'}>
        {stepLabel}
      </Pill>
      {ownerLabel && (
        <span>{isAr ? 'لدى ' : 'with '}<b style={{ color: 'var(--ink)' }}>{ownerLabel}</b></span>
      )}
      <Fact label={isAr ? 'القسم' : 'Section'}>
        {isAr ? SECTION_LABELS[section].ar : SECTION_LABELS[section].en}
      </Fact>
      <Fact label={isAr ? 'النوع' : 'Type'}>
        {(isAr ? item.content_type_label_ar : item.content_type_label_en) || item.content_type_key}
      </Fact>
      {projectLabel && <Fact label={isAr ? 'المشروع' : 'Project'}>{projectLabel}</Fact>}
      {campaignName && (
        <Fact label={isAr ? 'الحملة' : 'Campaign'}>
          {campaignName}
          {executionLabel && <span style={{ color: 'var(--mute)' }}> ← {executionLabel}</span>}
        </Fact>
      )}
      <Fact label={plannedIsTarget ? (isAr ? 'النشر المستهدف' : 'Target publish') : (isAr ? 'النشر المجدول' : 'Scheduled')}>
        {plannedPublish ? shortDate(plannedPublish, isAr) : (isAr ? 'بلا موعد' : 'no date')}
      </Fact>
      {planStatusLabel && (
        <Fact label={isAr ? 'حالة الخطة' : 'Plan'}>
          <Pill tone={planStatus === 'late' ? 'late' : planStatus === 'at_risk' ? 'wait' : planStatus === 'published' ? 'live' : 'idle'}>
            {planStatusLabel}
          </Pill>
        </Fact>
      )}
      {item.required_ready_at && (
        <Fact label={isAr ? 'الجاهزية المطلوبة' : 'Ready by'}>{shortDate(item.required_ready_at, isAr)}</Fact>
      )}
    </div>
  ) : null;

  /* ── material ───────────────────────────────────────────────────────── */

  const renderable = (a: MosAsset): boolean => !!(a.thumb_url || a.url || a.file_id);
  // The square design is the feed-shaped one — the natural hero; then the
  // vertical, then the legacy single final.
  const finalLink = links.find((l) => l.role === 'final_square')
    ?? links.find((l) => l.role === 'final_vertical')
    ?? links.find((l) => l.role === 'final');
  const heroAsset: MosAsset | null =
    (finalLink ? assets.find((a) => a.id === finalLink.asset_id) : undefined)
    ?? (item?.approval_asset_id ? assets.find((a) => a.id === item.approval_asset_id) : undefined)
    ?? assets.find(renderable)
    ?? assets[0]
    ?? null;
  const heroIsApproved = !!(finalLink && heroAsset && heroAsset.id === finalLink.asset_id);
  const heroRole = heroAsset
    ? heroIsApproved
      ? (isAr ? 'النسخة المعتمدة النهائية' : 'The final approved version')
      : item?.approval_asset_id === heroAsset.id
        ? (isAr ? 'المادة المقدَّمة للاعتماد' : 'Material submitted for approval')
        : (isAr ? 'المادة' : 'Material')
    : (isAr ? 'المادة' : 'Material');
  const otherAssets = assets.filter((a) => a.id !== heroAsset?.id);
  /** True when nothing that could be called a design exists yet. */
  const noDesignYet = assets.length === 0;

  const roleOf = (assetId: string): string | null => {
    const l = links.find((x) => x.asset_id === assetId);
    if (!l) return null;
    return l.role === 'final_square'
      ? (isAr ? 'التصميم المربّع' : 'Square design')
      : l.role === 'final_vertical'
        ? (isAr ? 'التصميم الطولي' : 'Vertical design')
        : l.role === 'final'
      ? (isAr ? 'معتمد' : 'Approved')
      : l.role === 'reference'
        ? (isAr ? 'نسخة عمل' : 'Working file')
        : (isAr ? 'مادة أصلية' : 'Source');
  };

  const assetPreview = (a: MosAsset, big: boolean): JSX.Element => {
    const url = urlFor(a);
    const thumb = thumbFor(a);
    const box: CSSProperties = big
      ? { width: '100%', maxHeight: 420, borderRadius: 10, objectFit: 'contain', background: 'var(--line)' }
      : { width: 56, height: 56, borderRadius: 8, objectFit: 'cover', background: 'var(--line)' };
    if (a.kind === 'video' && url) return <video controls src={url} style={box} />;
    if (thumb) return <img src={thumb} alt={a.title} style={box} />;
    return (
      <div style={{ ...box, display: 'grid', placeItems: 'center', height: big ? 160 : 56, color: 'var(--mute)' }}>
        <IconLibrary strokeWidth={1.7} style={{ width: big ? 28 : 18, height: big ? 28 : 18 }} />
      </div>
    );
  };

  /** The design references from the brief — file ids, resolved by `<Thumb>`. */
  const referenceFileIds: string[] = (() => {
    const data = item?.data ?? {};
    const arr = data.design_reference_file_ids;
    if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
    const legacy = str(data.design_reference_file_id);
    return legacy ? [legacy] : [];
  })();

  const noDesignCard = item && noDesignYet ? (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'المادة' : 'Material'}</h4>
        <span className="r">{isAr ? 'لا تصميم بعد' : 'No design yet'}</span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 12 }}>
        <div style={{ position: 'relative' }}>
          <Thumb
            coverUrl={item.project_cover_url ?? null}
            kind={null}
            fallback={item.content_type_key}
            ratio="16 / 9"
            alt={item.title}
          />
          <span
            style={{
              position: 'absolute', insetInlineStart: 10, bottom: 10,
              background: 'color-mix(in srgb, var(--ink) 72%, transparent)',
              color: 'var(--paper)', borderRadius: 6, padding: '4px 9px',
              fontSize: 12, fontWeight: 700,
            }}
          >
            {isAr ? 'لا تصميم بعد' : 'No design yet'}
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--mute)', lineHeight: 1.8 }}>
          {isAr
            ? 'لم تُرفع أي مادة لهذا العنصر بعد — تُضاف من تبويب المواد. ما يلي هو كل ما أُنجز حتى الآن.'
            : 'No material has been uploaded yet — it is added on the Material tab. Everything produced so far is below.'}
        </div>
        {referenceFileIds.length > 0 && (
          <div>
            <div className="lbl" style={{ marginBottom: 6 }}>
              {isAr ? 'مراجع التصميم' : 'Design references'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {referenceFileIds.map((fid) => (
                <Thumb key={fid} fileId={fid} kind="photo" size="lg" alt={isAr ? 'مرجع' : 'Reference'} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  ) : null;

  const materialsCards = item ? (
    <>
      {noDesignCard ?? (
        <div className="card">
          <div className="card-h">
            <h4>{heroRole}</h4>
            {heroIsApproved && <Pill tone="go">{isAr ? 'معتمد' : 'Approved'}</Pill>}
            {heroAsset && urlFor(heroAsset) && (
              <a
                className="btn btn-d btn-sm"
                style={{ marginInlineStart: 'auto' }}
                href={urlFor(heroAsset) ?? undefined}
                target="_blank"
                rel="noreferrer"
              >
                {isAr ? 'فتح الملف' : 'Open file'}
              </a>
            )}
          </div>
          <div className="card-b">
            {heroAsset && (
              <div style={{ display: 'grid', gap: 10 }}>
                {assetPreview(heroAsset, true)}
                <div style={{ fontSize: 12.5 }}>
                  <b>{heroAsset.title}</b>
                  <span style={{ color: 'var(--mute)' }}> · <span className="ltr">{heroAsset.ref}</span></span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {otherAssets.length > 0 && (
        <div className="card">
          <div className="card-h">
            <h4>{isAr ? 'مواد أخرى مرتبطة' : 'Other linked material'}</h4>
            <span className="r">{num(otherAssets.length, isAr)}</span>
          </div>
          <div className="card-b" style={{ display: 'grid', gap: 10 }}>
            {otherAssets.map((a) => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {assetPreview(a, false)}
                <div style={{ minWidth: 0, fontSize: 12.5 }}>
                  <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</div>
                  <div style={{ color: 'var(--mute)' }}>{roleOf(a.id) ?? '—'}</div>
                </div>
                {urlFor(a) && (
                  <a className="btn btn-d btn-sm" style={{ marginInlineStart: 'auto' }} href={urlFor(a) ?? undefined} target="_blank" rel="noreferrer">
                    {isAr ? 'فتح' : 'Open'}
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  ) : null;

  /* ── writing ────────────────────────────────────────────────────────── */

  const writingCards = item ? (
    <>
      <WritingFields
        contentId={item.id}
        schema={fieldSchemaKeys(type?.field_schema ?? [])}
        data={item.data ?? {}}
        canEdit={canEdit}
        isAr={isAr}
        onSaved={(data) => setItem({ ...item, data })}
      />
      {scenes.length > 0 && (
        <div className="card">
          <div className="card-h">
            <h4>{isAr ? 'المشاهد' : 'Scenes'}</h4>
            <span className="r">{num(scenes.length, isAr)}</span>
          </div>
          <div className="card-b" style={{ display: 'grid', gap: 8 }}>
            {[...scenes].sort((a, b) => a.position - b.position).map((s) => (
              <div key={s.id} style={{ display: 'flex', gap: 10, fontSize: 12.5, lineHeight: 1.7 }}>
                <b style={{ color: 'var(--mute)', minWidth: 22 }}>{num(s.position, isAr)}</b>
                <span style={{ whiteSpace: 'pre-wrap' }}>{s.visual ?? s.voiceover ?? '—'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  ) : null;

  /* ── caption ────────────────────────────────────────────────────────── */

  const captions = (() => {
    const data = item?.data ?? {};
    const rows = CAPTION_KEYS
      .map(({ key, platform }) => ({ key, platform, text: str(data[key]).trim() }))
      .filter((r) => r.text !== '');
    // The planning migration puts the canonical caption on the view itself;
    // fall back to it when the writing data carries none.
    if (rows.length === 0 && item?.caption) {
      rows.push({ key: 'caption', platform: 'instagram', text: item.caption });
    }
    return rows;
  })();
  const hashtags = (() => {
    const v = item?.data?.hashtags;
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    const s = str(v).trim();
    return s ? [s] : [];
  })();
  const adCopy = paid
    .map((p) => ({ p, text: (p.creative?.primary_text ?? '').trim() }))
    .filter((x) => x.text !== '');

  const captionCard = item && (captions.length > 0 || hashtags.length > 0 || adCopy.length > 0) ? (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'الكابشن' : 'Caption'}</h4>
        {item.caption_confirmed === true && <Pill tone="go">{isAr ? 'معتمد' : 'Confirmed'}</Pill>}
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 12 }}>
        {captions.map((c, i) => (
          <div key={c.key}>
            <div className="lbl" style={{ marginBottom: 4 }}>
              {i === 0 && c.key === 'caption'
                ? (isAr ? 'النص الأساسي' : 'Canonical')
                : (isAr ? PLATFORM_LABELS[c.platform]?.ar : PLATFORM_LABELS[c.platform]?.en) ?? c.platform}
              {i > 0 && <span style={{ color: 'var(--mute)', fontWeight: 400 }}> · {isAr ? 'نسخة خاصة بالمنصة' : 'platform override'}</span>}
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.9, whiteSpace: 'pre-wrap' }}>{c.text}</div>
          </div>
        ))}
        {hashtags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {hashtags.map((h) => <span key={h} className="tag">{h}</span>)}
          </div>
        )}
        {adCopy.map(({ p, text }) => (
          <div key={p.id}>
            <div className="lbl" style={{ marginBottom: 4 }}>
              {isAr ? 'نص الإعلان' : 'Ad copy'}
              <span style={{ color: 'var(--mute)', fontWeight: 400 }}>
                {' · '}
                {(isAr ? PLATFORM_LABELS[p.execution.platform]?.ar : PLATFORM_LABELS[p.execution.platform]?.en) ?? p.execution.platform}
                {p.ad_set_name ? ` · ${p.ad_set_name}` : ''}
              </span>
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.9, whiteSpace: 'pre-wrap' }}>{text}</div>
          </div>
        ))}
      </div>
    </div>
  ) : null;

  /* ── publishing plan + the ads this creative runs on ────────────────── */

  const publishCard = item ? (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'خطة النشر' : 'Publishing plan'}</h4>
        <span className="r">{num(publications.length, isAr)} {isAr ? 'منصة' : 'platforms'}</span>
      </div>
      {publications.length === 0 ? (
        <p style={{ padding: 20, textAlign: 'center', fontSize: 12.5, color: 'var(--mute)' }}>
          {item.target_publish_at || item.need_at
            ? isAr
              ? `لا منصات بعد — الموعد المستهدف ${shortDate(item.need_at ?? item.target_publish_at, true)}.`
              : `No platforms yet — the target date is ${shortDate(item.need_at ?? item.target_publish_at, false)}.`
            : isAr ? 'لا منصات بعد.' : 'No platforms yet.'}
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
  ) : null;

  const adsCard = paid.length > 0 ? (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'الإعلانات المرتبطة' : 'Linked ads'}</h4>
        <span className="r">{num(paid.length, isAr)}</span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <tbody>
            {paid.map((p) => (
              <tr key={p.id}>
                <td style={{ width: 130 }}>
                  <span className="tag">
                    {(isAr ? PLATFORM_LABELS[p.execution.platform]?.ar : PLATFORM_LABELS[p.execution.platform]?.en) ?? p.execution.platform}
                  </span>
                </td>
                <td className="ttl">{p.execution.campaign_name ?? '—'}</td>
                <td style={{ color: 'var(--mute)' }}>{p.ad_set_name ?? (isAr ? 'بلا مجموعة' : 'no ad set')}</td>
                <td style={{ width: 110 }}>
                  <Pill tone={p.status === 'active' ? 'live' : p.status === 'paused' ? 'idle' : 'wait'}>{p.status}</Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  ) : null;

  /* ── body ───────────────────────────────────────────────────────────── */

  const body = (): JSX.Element | null => {
    if (!item) return null;
    const writingBlock = <>{writingCards}{captionCard}</>;
    const planBlock = <>{publishCard}{adsCard}</>;
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        {header}
        {/* The caption task comes FIRST: it is the one thing the manager is here to do. */}
        {captionReviews.map((p) => (
          <CaptionReviewCard
            key={p.id}
            contentId={contentId}
            placement={p}
            canAct={canReviewCaption}
            isAr={isAr}
            onChanged={(pls) => { setPaid(pls); setChanged(true); }}
            addToast={addToast}
          />
        ))}
        {order === 'writing_first' && <>{writingBlock}{materialsCards}{planBlock}</>}
        {order === 'materials_first' && <>{materialsCards}{writingBlock}{planBlock}</>}
        {order === 'plan_first' && <>{planBlock}{materialsCards}{writingBlock}</>}
        {openTask && canAct && autoAdStep && <AutoAdPanel state={autoAdState} isAr={isAr} />}
      </div>
    );
  };

  /* ── footer — the current role's action, or an honest "not yours" ──── */

  const footer = (
    <>
      <button type="button" className="btn btn-d" onClick={openFull}>
        {isAr ? 'فتح الصفحة كاملة' : 'Open full page'}
      </button>
      <span style={{ marginInlineStart: 'auto' }} />
      {openTask && canAct && currentStep?.is_approval && (
        <>
          <button type="button" className="btn" disabled={busy} onClick={() => setRejectOpen(true)}>
            {isAr ? 'طلب تعديلات' : 'Request changes'}
          </button>
          <button
            type="button"
            className="btn btn-go"
            disabled={busy || needsAdSetPick || (autoAdStep && autoAdState.loading)}
            title={needsAdSetPick ? (isAr ? 'اختر المجموعة الإعلانية' : 'Pick an ad set') : undefined}
            onClick={() => void act('approved')}
          >
            <IconCheck />
            {isAr
              ? `اعتماد ${reviewedStep?.label_ar ?? ''}`.trim()
              : `Approve ${reviewedStep?.label_en ?? ''}`.trim()}
          </button>
        </>
      )}
      {openTask && canAct && currentStep && !currentStep.is_approval && (
        <button type="button" className="btn btn-p" disabled={busy} onClick={() => void act('submitted')}>
          {isAr
            ? nextStep?.is_approval ? 'إرسال للمراجعة' : 'إرسال للخطوة التالية'
            : nextStep?.is_approval ? 'Submit for review' : 'Submit to the next stage'}
        </button>
      )}
      {openTask && !canAct && (
        <span style={{ fontSize: 12, color: 'var(--mute)' }}>
          {isAr ? `لدى ${ownerLabel ?? ''} — لا إجراء لك في هذه المرحلة` : `With ${ownerLabel ?? ''} — nothing for you at this stage`}
        </span>
      )}
      {!openTask && item && (
        <span style={{ fontSize: 12, color: captionReviews.length > 0 ? 'var(--copper)' : 'var(--mute)' }}>
          {captionReviews.length > 0
            ? (canReviewCaption
              ? (captionReviews.some((p) => p.creative?.auto_ad?.state === 'failed')
                ? (isAr ? 'إعلان ميتا يحتاج تدخلك — أعلاه.' : 'The Meta ad needs your attention — above.')
                : (isAr ? 'كابشن الإعلان بانتظار اعتمادك — أعلاه.' : 'The ad caption awaits your approval — above.'))
              : (isAr ? 'كابشن الإعلان بانتظار اعتماد مدير التسويق.' : 'The ad caption awaits the marketing manager’s approval.'))
            : item.status_key === 'done'
              ? (isAr ? 'انتهى مسار العمل.' : 'The workflow is finished.')
              : (isAr ? 'لا مهمة مفتوحة.' : 'No open task.')}
        </span>
      )}
    </>
  );

  return (
    <>
      <Modal
        wide
        title={item ? `${item.ref ?? ''} · ${item.title}`.replace(/^ · /, '') : (isAr ? 'معاينة' : 'Preview')}
        sub={item
          ? `${isAr ? 'المرحلة' : 'Stage'}: ${stepLabel}${ownerLabel ? ` · ${isAr ? 'لدى' : 'with'} ${ownerLabel}` : ''}`
          : undefined}
        onClose={close}
        footer={item ? footer : undefined}
      >
        {error && <div style={{ marginBottom: 12 }}><LoadError message={error} onRetry={() => void load()} isAr={isAr} /></div>}
        {loading && !item && <Skeleton rows={6} />}
        {body()}
      </Modal>

      {rejectOpen && item && openTask && (
        <RequestChangesModal
          item={item}
          openTask={openTask}
          steps={steps}
          scenes={scenes}
          fields={fieldSchemaEntries(type?.field_schema ?? [])}
          isAr={isAr}
          onClose={() => setRejectOpen(false)}
          onSubmitted={() => { setRejectOpen(false); setChanged(true); void load(); }}
        />
      )}
    </>
  );
}

/** One `label: value` chip in the header fact strip. */
function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <span>
      <span style={{ color: 'var(--mute)' }}>{label}: </span>
      <b style={{ color: 'var(--ink)', fontWeight: 700 }}>{children}</b>
    </span>
  );
}

/* ── usePreview — one modal per page, any row opens it ──────────────── */

export interface PreviewController {
  /** Open the popup on `contentId`, optionally on a specific section. */
  open: (contentId: string, section?: ContentSection | null) => void;
  close: () => void;
  /** The mounted modal (or null). Render this ONCE, at the page's root. */
  node: JSX.Element | null;
  /** The item currently open, so a row can mark itself. */
  openId: string | null;
}

/**
 * Mount ONE `<ContentPreview>` for a whole page.
 *
 * Every list in the workspace uses this, which is what makes «معاينة» mean the
 * same thing on the content table, my work, the calendar, the publishing
 * board, a campaign, a search result and a notification.
 */
export function usePreview(onChanged?: () => void): PreviewController {
  const { isAr } = useWorkspace();
  const [state, setState] = useState<{ id: string; section: ContentSection | null } | null>(null);

  const open = useCallback((contentId: string, section?: ContentSection | null) => {
    setState({ id: contentId, section: section ?? null });
  }, []);
  const close = useCallback(() => setState(null), []);

  const node = state ? (
    <ContentPreview
      contentId={state.id}
      isAr={isAr}
      initialSection={state.section}
      onClose={close}
      onChanged={() => { if (onChanged) onChanged(); }}
    />
  ) : null;

  return { open, close, node, openId: state?.id ?? null };
}
