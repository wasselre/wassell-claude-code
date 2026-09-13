/**
 * «معاينة» — the content list's in-place review popup.
 *
 * One click from the table opens the ACTUAL CONTENT without leaving the list —
 * always both halves of it:
 *   the material  → the approved / submitted design (final link → the file
 *                   marked for approval → any renderable linked file) rendered
 *                   big, then the other linked materials;
 *   the writing   → the writing fields (editable while the stage is a working
 *                   step and the caller can write; locked text otherwise) and
 *                   the scenes.
 * The item's phase (from its PINNED workflow steps — `stagePhase.ts`, never a
 * hardcoded step key) only decides the ORDER: writing first while the copy is
 * being written or reviewed, material first once it is in design or beyond.
 * A finished / publishing item also gets its publication plan underneath.
 * (The first cut showed ONLY the plan for a finished item — the operator
 * opened a published post and saw a table of platforms instead of the post.)
 *
 * The footer carries the CURRENT ROLE's action — the same `task_complete` flow
 * the content page's header uses: «اعتماد …» / «طلب تعديلات» on an approval
 * step, «إرسال للمراجعة» on a working step. When the open stage is not the
 * caller's, the popup is read-only and says so; it never shows a button that
 * would only 403.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosAsset, MosAssetLink, MosContentRow, MosPublication, MosScene, MosStep, MosTask,
  PLATFORM_LABELS, PUB_STATUS_LABELS, ROLE_LABELS,
  adSetRequiredChoices, completeTask, fetchAssets, fetchContentDetail, fetchPublications,
  fieldSchemaEntries, fieldSchemaKeys,
} from '@/lib/marketingOS/client';
import { AutoAdPanel, autoAdOutcomeText, useAutoAdPreview } from './AutoAdApproval';
import { useWorkspace } from '../MarketingWorkspace';
import { Modal, Pill, Skeleton, LoadError } from './kit';
import { IconCheck, IconLibrary } from './icons';
import WritingFields from './WritingFields';
import RequestChangesModal from './RequestChangesModal';
import { useAssetUrls } from '../lib/assetUrls';
import { dateTimeShort, num } from '../lib/format';
import { phaseOfStep, tabForPhase, stageIsMine, type StagePhase } from '../lib/stagePhase';

const PHASE_LABELS: Record<StagePhase, { ar: string; en: string }> = {
  writing: { ar: 'الكتابة', en: 'Writing' },
  design:  { ar: 'التصميم', en: 'Design' },
  publish: { ar: 'النشر',   en: 'Publishing' },
};

export default function ContentPreviewModal({
  contentId, isAr, onClose, onChanged,
}: {
  contentId: string;
  isAr: boolean;
  onClose: () => void;
  /** Fired after an action moved the item a stage — the list refreshes its rows. */
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);
  const { roles, can, contentTypes } = useWorkspace();

  const [item, setItem] = useState<MosContentRow | null>(null);
  const [tasks, setTasks] = useState<MosTask[]>([]);
  const [scenes, setScenes] = useState<MosScene[]>([]);
  const [steps, setSteps] = useState<MosStep[]>([]);
  const [assets, setAssets] = useState<MosAsset[]>([]);
  const [links, setLinks] = useState<MosAssetLink[]>([]);
  const [publications, setPublications] = useState<MosPublication[]>([]);
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
      setItem(detail.item);
      setTasks(detail.tasks);
      setScenes(detail.scenes);
      setSteps(detail.steps);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [contentId]);

  useEffect(() => { void load(); }, [load]);

  const openTask = tasks.find((t) => t.status === 'open') ?? null;
  const currentStep = openTask ? steps.find((s) => s.id === openTask.step_id) ?? null : null;
  const sortedSteps = useMemo(() => [...steps].sort((a, b) => a.position - b.position), [steps]);
  // Auto Meta ad: when the step being approved creates the ad, the popup shows
  // the target ad set (or asks which) exactly like the page's approval dialog.
  const autoAdStep = currentStep?.auto_meta_ad === true && currentStep.is_approval;
  const autoAdState = useAutoAdPreview(contentId, autoAdStep);
  const needsAdSetPick = autoAdStep && autoAdState.preview?.kind === 'choose' && !autoAdState.adSetId;

  const phase: StagePhase = useMemo(() => {
    if (!item) return 'writing';
    if (currentStep) return phaseOfStep(sortedSteps, currentStep.key);
    if (item.status_key === 'done') return 'publish';
    return phaseOfStep(sortedSteps, item.status_key);
  }, [item, currentStep, sortedSteps]);

  // The linked materials — ALWAYS fetched: the material is the content, whatever
  // the stage. The publication plan only matters once the item is publishing
  // or done. A failure is shown in place (the header still renders), never
  // swallowed.
  useEffect(() => {
    if (!item) return;
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
    if (phase === 'publish' || item.status_key === 'done') {
      fetchPublications(contentId)
        .then((res) => { if (alive) setPublications(res.publications); })
        .catch((e: unknown) => {
          console.error('[marketing] preview publications unavailable', e);
          if (alive) setError(e instanceof Error ? e.message : String(e));
        });
    }
    return () => { alive = false; };
  }, [item, phase, contentId]);

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

  const openFull = (): void => {
    onClose();
    if (changed) onChanged();
    navigate(`/m/content/${contentId}?tab=${item?.status_key === 'done' ? 'materials' : tabForPhase(phase)}`);
  };

  const stepLabel = currentStep
    ? (isAr ? currentStep.label_ar : currentStep.label_en)
    : item?.status_key === 'done'
      ? (isAr ? 'منشور' : 'Published')
      : (isAr ? 'بلا مرحلة مفتوحة' : 'No open stage');
  const ownerLabel = openTask && ROLE_LABELS[openTask.role]
    ? (isAr ? ROLE_LABELS[openTask.role].ar : ROLE_LABELS[openTask.role].en)
    : null;

  /* ── phase bodies ───────────────────────────────────────────────────── */

  // The one file to show BIG: the approved final cut, else the file marked for
  // approval, else the first linked file that can actually be rendered.
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
  const heroRole = heroAsset
    ? finalLink && heroAsset.id === finalLink.asset_id
      ? (isAr ? 'المادة المعتمدة' : 'Approved material')
      : item?.approval_asset_id === heroAsset.id
        ? (isAr ? 'المادة المقدَّمة للاعتماد' : 'Material submitted for approval')
        : (isAr ? 'المادة' : 'Material')
    : (isAr ? 'المادة' : 'Material');
  const otherAssets = assets.filter((a) => a.id !== heroAsset?.id);
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

  const assetPreview = (a: MosAsset, big: boolean) => {
    const url = urlFor(a);
    const thumb = thumbFor(a);
    const box: CSSProperties = big
      ? { width: '100%', maxHeight: 420, borderRadius: 10, objectFit: 'contain', background: 'var(--line)' }
      : { width: 56, height: 56, borderRadius: 8, objectFit: 'cover', background: 'var(--line)' };
    if (a.kind === 'video' && url) return <video controls src={url} style={box} />;
    if (thumb) return <img src={thumb} alt={a.title} style={box} />;
    return (
      <div style={{ ...box, display: 'grid', placeItems: 'center', height: big ? 160 : 56, color: 'var(--mute)' }}>
        <IconLibrary />
      </div>
    );
  };

  const materialsCards = item ? (
    <>
      <div className="card">
        <div className="card-h">
          <h4>{heroRole}</h4>
          {heroAsset && urlFor(heroAsset) && (
            <a className="btn btn-d btn-sm" href={urlFor(heroAsset) ?? undefined} target="_blank" rel="noreferrer">
              {isAr ? 'فتح الملف' : 'Open file'}
            </a>
          )}
        </div>
        <div className="card-b">
          {heroAsset ? (
            <div style={{ display: 'grid', gap: 10 }}>
              {assetPreview(heroAsset, true)}
              <div style={{ fontSize: 12.5 }}>
                <b>{heroAsset.title}</b>
                <span style={{ color: 'var(--mute)' }}> · <span className="ltr">{heroAsset.ref}</span></span>
              </div>
            </div>
          ) : (
            <div className="notice">
              {isAr
                ? 'لا مواد مرتبطة بهذا العنصر بعد — تُضاف من تبويب المواد.'
                : 'No material is linked to this item yet — it is added on the Material tab.'}
            </div>
          )}
        </div>
      </div>
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

  const publishCard = item && (phase === 'publish' || item.status_key === 'done') ? (
    <div className="card">
      <div className="card-h">
        <h4>{isAr ? 'خطة النشر' : 'Publishing plan'}</h4>
        <span className="r">{num(publications.length, isAr)} {isAr ? 'منصة' : 'platforms'}</span>
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
  ) : null;

  // The content itself, always: writing first while the copy is the work,
  // material first once the piece is in design or beyond.
  const body = (): JSX.Element | null => {
    if (!item) return null;
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        {phase === 'writing' ? (<>{writingCards}{materialsCards}</>) : (<>{materialsCards}{writingCards}</>)}
        {publishCard}
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
        <span style={{ fontSize: 12, color: 'var(--mute)' }}>
          {item.status_key === 'done'
            ? (isAr ? 'انتهى مسار العمل.' : 'The workflow is finished.')
            : (isAr ? 'لا مهمة مفتوحة.' : 'No open task.')}
        </span>
      )}
    </>
  );

  const phaseLabel = isAr ? PHASE_LABELS[phase].ar : PHASE_LABELS[phase].en;

  return (
    <>
      <Modal
        wide
        title={item ? `${item.ref ?? ''} · ${item.title}`.replace(/^ · /, '') : (isAr ? 'معاينة' : 'Preview')}
        sub={item
          ? `${isAr ? 'المرحلة' : 'Stage'}: ${stepLabel}${ownerLabel ? ` · ${isAr ? 'لدى' : 'with'} ${ownerLabel}` : ''} · ${phaseLabel}`
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
