/**
 * «الصف — تصميم» — the designer's half of a row task.
 *
 * Three posts, six named slots, ONE submit. سارة opens the row مريم wrote and
 * ريان approved, fills the slots, and sends once. There is no per-post send and
 * no manual override: the row goes out whole or it waits.
 *
 * What the designer is laying out is the LINES — the ordered copy that lands on
 * the image — plus the one-sentence brief. The confirmed caption is shown as
 * context, dimmed, because it travels with the feed post but is not the thing
 * being designed. Neither can be edited from here: the caption comes from the
 * writing task and the files come from the two slots, so nothing can drift
 * between approval and publish.
 *
 * READINESS IS REFUSED AT THE SUBMIT, not at an approval gate and not at
 * publish time. The engine already does it — `post_std` v8 declares
 * `required_files: ['final_square','final_vertical']` and
 * `workflow_advance_role_path` names the offending member. This screen predicts
 * the same answer from the links it already has (so the button is honest before
 * it is pressed) and renders the engine's own refusal when it disagrees.
 */
import { useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  MosAssetLink,
  linkAsset, saveAsset, setApprovalAsset, unlinkAsset,
} from '@/lib/marketingOS/client';
import {
  MosMissingRequirement, MosRowDetail, MosRowMember, RowSlotRole,
  completeRowTask, missingForStep, missingRequirementsOf,
} from '@/lib/marketingOS/rowClient';
import { useAssetUrls } from '../lib/assetUrls';
import { assetErrorText, canonicalAssetFields, uploadCanonicalAsset } from '../lib/canonicalUpload';
import { heicToJpeg, isHeic, kindFromFile } from '../lib/upload';
import { formatBytes } from '../lib/upload';
import { num, pct } from '../lib/format';
import { Pill } from './kit';
import { IconLibrary, IconTrash } from './icons';
import {
  CaptionBlock, DesignBrief, MissingCard, PostLines, PostShell, ReadinessMeter,
  SLOTS, SLOT_META, SlotFrame, slotsFilled, slotsOfMember,
} from './RowParts';

/**
 * The words for each requirement the design step can refuse on. The SERVER
 * sends these with a real refusal (`api/_lib/marketing/rowTasks.ts`); this copy
 * is only for the local prediction, so the pane can say the same thing BEFORE
 * the button is pressed. Keep the two in step.
 */
const REQUIREMENT_LABELS: Record<string, { ar: string; en: string }> = {
  final_square: { ar: SLOT_META.final_square.ar, en: SLOT_META.final_square.en },
  final_vertical: { ar: SLOT_META.final_vertical.ar, en: SLOT_META.final_vertical.en },
  caption: { ar: 'النص', en: 'the caption' },
  caption_confirmed: { ar: 'تأكيد النص من الكاتب', en: 'the writer’s caption confirmation' },
  headlines: { ar: 'أسطر المنشور', en: 'the post lines' },
  design_brief: { ar: 'موجز التصميم', en: 'the design brief' },
};

export default function RowDesign({
  detail, isAr, canAct, onChanged, brief,
}: {
  detail: MosRowDetail;
  isAr: boolean;
  /** The stage is this person's — otherwise the pane is a read-only look. */
  canAct: boolean;
  /** Reload the row (and whatever list mounted it). */
  onChanged: () => void | Promise<void>;
  /** The resolved brief panel, when the caller has one to mount. */
  brief?: React.ReactNode;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<{ key: string; frac: number } | null>(null);
  const [refused, setRefused] = useState<MosMissingRequirement[] | null>(null);
  /** Links written since the last reload — the pane stays live between saves. */
  const [extraLinks, setExtraLinks] = useState<MosAssetLink[] | null>(null);

  const view: MosRowDetail = useMemo(
    () => (extraLinks ? { ...detail, links: extraLinks } : detail),
    [detail, extraLinks],
  );

  const previousMembers = view.previous_row?.members ?? [];
  const { urlFor, thumbFor, error: signError, retry: retrySign } = useAssetUrls([
    ...view.assets,
  ]);

  const { filled, total } = slotsFilled(view);

  /**
   * The same answer the engine will give, read off the SAME pinned step. It is
   * a prediction — `workflow_advance_role_path` refuses independently and its
   * answer is the one that counts — but it is the same rule, so the button is
   * honest before it is pressed.
   */
  const currentStep = view.steps.find((s) => s.key === (view.task?.step_id ?? '')) ?? null;
  const predicted: MosMissingRequirement[] = useMemo(
    () => missingForStep(view, currentStep).map(({ member, key }) => {
      const label = REQUIREMENT_LABELS[key] ?? { ar: key, en: key };
      return { member: member.ref ?? member.title, key, label_ar: label.ar, label_en: label.en };
    }),
    [view, currentStep],
  );

  const ready = predicted.length === 0 && view.members.length > 0;

  /* ── writing into a slot ──────────────────────────────────────────── */

  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const slotKey = (contentId: string, role: RowSlotRole): string => `${contentId}:${role}`;

  /**
   * The approval asset follows the slots — the square (feed) design, else the
   * vertical. Nothing is marked by hand, so the preview hero and the legacy
   * promote bridge keep pointing at a real design.
   */
  const syncApprovalAsset = async (contentId: string, links: MosAssetLink[]): Promise<void> => {
    const ours = links.filter((l) => l.content_id === contentId);
    const want = ours.find((l) => l.role === 'final_square')?.asset_id
      ?? ours.find((l) => l.role === 'final_vertical')?.asset_id
      ?? null;
    const member = view.members.find((m) => m.id === contentId);
    if (!member || member.approval_asset_id === want) return;
    try {
      await setApprovalAsset(contentId, want);
    } catch (e) {
      // Not fatal to the upload — the file IS linked. Surfaced, never swallowed.
      console.error('[marketing] row slot approval-asset sync failed', contentId, e);
      addToast(
        isAr
          ? 'رُفع الملف، لكن تعذّر تحديث المادة المعروضة للاعتماد.'
          : 'The file was linked, but the material shown for approval could not be updated.',
        'error',
      );
    }
  };

  const mergeLinks = (contentId: string, fresh: MosAssetLink[]): MosAssetLink[] => (
    [...view.links.filter((l) => l.content_id !== contentId), ...fresh]
  );

  const attach = async (contentId: string, role: RowSlotRole, assetId: string): Promise<void> => {
    // One file per slot. A previous occupant becomes a plain source link rather
    // than disappearing — a replaced design is still a design that existed.
    const prev = slotsOfMember(view, contentId).find((s) => s.role === role)?.link ?? null;
    if (prev && prev.asset_id !== assetId) await linkAsset(prev.asset_id, contentId, 'source');
    const res = await linkAsset(assetId, contentId, role);
    const next = mergeLinks(contentId, res.links);
    setExtraLinks(next);
    await syncApprovalAsset(contentId, next);
  };

  const upload = async (member: MosRowMember, role: RowSlotRole, file: File): Promise<void> => {
    const key = slotKey(member.id, role);
    setBusy(true);
    setUploading({ key, frac: 0 });
    setRefused(null);
    try {
      let toSend = file;
      if (isHeic(file)) {
        try {
          toSend = await heicToJpeg(file);
        } catch (convErr) {
          console.error('[marketing] HEIC conversion failed', file.name, convErr);
        }
      }
      const fileRow = await uploadCanonicalAsset(toSend, {
        onProgress: (frac) => setUploading({ key, frac }),
      });
      const kind = kindFromFile(toSend);
      const meta = SLOT_META[role];
      const res = await saveAsset({
        title: `${member.title} — ${isAr ? meta.ar : meta.en}`,
        kind: kind === 'photo' || kind === 'video' ? kind : 'design',
        source: 'design',
        project_id: member.project_id,
        shot_on: null,
        tags: [role],
        aspect_ratio: meta.ratio,
        ...canonicalAssetFields(fileRow),
        original_name: file.name,
      });
      await attach(member.id, role, res.asset.id);
      // The optimistic link list is DROPPED once the authoritative read lands:
      // `asset_link` answers without the `superseded_at IS NULL` filter that
      // `row_detail` (and the engine) apply, so holding on to it would let a
      // superseded file keep looking like a filled slot.
      await onChanged();
      setExtraLinks(null);
    } catch (e) {
      console.error('[marketing] row slot upload failed', file.name, e);
      addToast(assetErrorText(e, isAr), 'error');
    } finally {
      setUploading(null);
      setBusy(false);
    }
  };

  const clear = async (member: MosRowMember, role: RowSlotRole): Promise<void> => {
    const link = slotsOfMember(view, member.id).find((s) => s.role === role)?.link ?? null;
    if (!link) return;
    setBusy(true);
    try {
      const res = await unlinkAsset(link.asset_id, member.id);
      const next = mergeLinks(member.id, res.links);
      setExtraLinks(next);
      await syncApprovalAsset(member.id, next);
      await onChanged();
      setExtraLinks(null);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /* ── the one submit ───────────────────────────────────────────────── */

  const submit = async (): Promise<void> => {
    if (!view.task) return;
    setBusy(true);
    setRefused(null);
    try {
      await completeRowTask({ taskId: view.task.id, result: 'submitted' });
      addToast(
        isAr ? 'أُرسل الصف كاملًا للاعتماد النهائي.' : 'The whole row went to the final approval.',
        'success',
      );
      await onChanged();
    } catch (e) {
      const missing = missingRequirementsOf(e);
      if (missing) {
        setRefused(missing);
        addToast(
          isAr ? 'رُفض الإرسال — الصف ناقص.' : 'The submit was refused — the row is incomplete.',
          'error',
        );
      } else {
        addToast(e instanceof Error ? e.message : String(e), 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  const shown = refused ?? (predicted.length > 0 ? predicted : null);

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {brief}

      {signError && (
        <div className="notice bad" role="alert">
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            {isAr ? 'تعذّر تحميل بعض المعاينات' : 'Some previews could not be loaded'}
          </div>
          <div style={{ overflowWrap: 'anywhere' }}>{signError}</div>
          <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={retrySign}>
            {isAr ? 'إعادة المحاولة' : 'Try again'}
          </button>
        </div>
      )}

      {/* ── the six slots ──────────────────────────────────────────── */}
      <div className="card">
        <div className="card-h">
          <h4>
            {isAr
              ? 'ملفات الصف — ثلاثة منشورات × خانتان'
              : 'The row’s files — three posts × two slots'}
          </h4>
          <span className="r">
            <Pill tone={filled === total ? 'go' : 'late'}>
              {isAr
                ? `${num(filled, true)} من ${num(total, true)}`
                : `${filled} of ${total}`}
            </Pill>
          </span>
        </div>
        <div className="card-b" style={{ display: 'grid', gap: 14 }}>
          <div style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.85 }}>
            {isAr
              ? 'ما تحتاجه النسخة يقرّره مكان نشرها لا نوعها: المربّع يذهب إلى الفيد ويحمل النص، والعمودي يذهب إلى الستوري بلا نص. النص والأسطر تأتي من مهمة الكتابة ولا تُعدَّل من هنا.'
              : 'What a release needs is decided by where it is going, not what it is: the square goes to the feed and carries the caption, the vertical goes to the story with none. The lines and the caption come from the writing task and cannot be edited here.'}
          </div>

          {view.members.map((m, i) => {
            const slots = slotsOfMember(view, m.id);
            const missingHere = slots.filter((s) => !s.link).length;
            return (
              <PostShell
                key={m.id}
                member={m}
                index={i}
                total={view.members.length}
                isAr={isAr}
                tone={missingHere > 0 ? 'gap' : 'ok'}
                right={
                  <Pill tone={missingHere === 0 ? 'go' : 'late'}>
                    {missingHere === 0
                      ? (isAr ? 'الخانتان جاهزتان' : 'both slots ready')
                      : isAr
                        ? `ينقصه ${num(missingHere, true)} من ٢`
                        : `${missingHere} of 2 missing`}
                  </Pill>
                }
              >
                <div
                  style={{
                    display: 'grid', gap: 14,
                    gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))',
                  }}
                >
                  {/* what سارة is actually laying out */}
                  <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
                    <PostLines member={m} isAr={isAr} />
                    <DesignBrief member={m} isAr={isAr} />
                    <CaptionBlock
                      member={m}
                      isAr={isAr}
                      tone="context"
                      label={isAr ? 'النص المرافق — سياق، لا يُصمَّم' : 'The caption — context, not the design'}
                    />
                  </div>

                  {/* the two slots */}
                  <div style={{ display: 'grid', gap: 10 }}>
                    <div className="lbl" style={{ margin: 0 }}>
                      {isAr ? 'خانتا الملفات' : 'The two file slots'}
                    </div>
                    <div
                      style={{
                        display: 'grid', gap: 12,
                        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                      }}
                    >
                      {SLOTS.map((role) => {
                        const slot = slots.find((s) => s.role === role);
                        const asset = slot?.asset ?? null;
                        const meta = SLOT_META[role];
                        const key = slotKey(m.id, role);
                        const up = uploading?.key === key ? uploading : null;
                        return (
                          <div key={role} style={{ display: 'grid', gap: 7, justifyItems: 'center' }}>
                            <SlotFrame
                              role={role}
                              asset={asset}
                              url={urlFor(asset)}
                              thumb={thumbFor(asset)}
                              empty={up
                                ? `${isAr ? 'جارٍ الرفع' : 'Uploading'} ${pct(up.frac * 100, isAr)}`
                                : isAr ? 'الخانة فارغة — مطلوبة' : 'Empty — required'}
                            />
                            <div style={{ fontSize: 11.5, textAlign: 'center' }}>
                              <b>{isAr ? meta.ar : meta.en}</b>
                              <div style={{ color: 'var(--mute)' }}>{isAr ? meta.hintAr : meta.hintEn}</div>
                              {asset && (
                                <div className="ltr" style={{ color: 'var(--mute)', overflowWrap: 'anywhere' }}>
                                  {asset.original_name ?? asset.title}
                                  {asset.size_bytes ? ` · ${formatBytes(asset.size_bytes, isAr)}` : ''}
                                </div>
                              )}
                            </div>
                            {canAct && (
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                                <input
                                  ref={(el) => { inputs.current[key] = el; }}
                                  type="file"
                                  accept="image/*,video/*"
                                  style={{ display: 'none' }}
                                  onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    e.target.value = '';
                                    if (f) void upload(m, role, f);
                                  }}
                                />
                                <button
                                  type="button"
                                  className={`btn btn-sm${asset ? '' : ' btn-p'}`}
                                  disabled={busy}
                                  onClick={() => inputs.current[key]?.click()}
                                >
                                  {asset ? (isAr ? 'استبدال' : 'Replace') : (isAr ? 'ارفع الملف' : 'Upload')}
                                </button>
                                {asset && (
                                  <button
                                    type="button"
                                    className="btn btn-d btn-sm"
                                    disabled={busy}
                                    onClick={() => void clear(m, role)}
                                    aria-label={isAr ? 'إزالة' : 'Remove'}
                                  >
                                    <IconTrash />
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </PostShell>
            );
          })}
        </div>
      </div>

      {/* ── the refusal, named ─────────────────────────────────────── */}
      {shown && (
        <MissingCard
          missing={shown}
          isAr={isAr}
          title={isAr
            ? 'لا يمكن إرسال الصف — ما زال ناقصًا'
            : 'This row cannot be sent — it is still incomplete'}
          why={isAr
            ? 'الصف يخرج كاملًا أو لا يخرج: لن يُرسَل منشوران وينتظر الثالث، ولن ينشر النظام صفًّا ناقصًا. لا يوجد خيار «إرسال جزئي» — بالتصميم، لا بالخطأ.'
            : 'The row goes out whole or not at all: two posts are never sent while the third waits, and an incomplete row is never published. There is no partial send — by design, not by omission.'}
        />
      )}

      {/* ── one submit ─────────────────────────────────────────────── */}
      <div className="card">
        <div className="card-b" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <ReadinessMeter filled={filled} total={total} isAr={isAr} />
          <div style={{ flex: 1, minWidth: 220, fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.85 }}>
            {isAr
              ? 'كل ملف يُحفظ لحظة رفعه — لا حاجة لحفظ مسودة. يُفتح زر الإرسال في اللحظة التي تمتلئ فيها الخانة الأخيرة، ويُرفض الإرسال في الخادم أيضًا إن نقص شيء.'
              : 'Every file is saved the moment it is uploaded — there is no draft to save. The send button opens when the last slot fills, and the server refuses an incomplete row independently.'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {canAct && view.task ? (
              <button
                type="button"
                className="btn btn-p"
                disabled={busy || !ready}
                title={ready
                  ? undefined
                  : isAr ? 'الصف ناقص — انظر القائمة أعلاه' : 'The row is incomplete — see the list above'}
                onClick={() => void submit()}
              >
                {busy ? (isAr ? 'جارٍ الإرسال…' : 'Sending…') : isAr ? 'إرسال الصف' : 'Send the row'}
              </button>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--mute)' }}>
                {isAr ? 'هذه المرحلة ليست لك — عرض فقط.' : 'This stage is not yours — view only.'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── last week's row, inert ─────────────────────────────────── */}
      {previousMembers.length > 0 && (
        <div className="card">
          <div className="card-h">
            <h4>
              {isAr
                ? 'للمقارنة البصرية — آخر صف نُشر لهذا المشروع'
                : 'For visual comparison — this project’s last row'}
            </h4>
            <span className="r">{isAr ? 'للنظر فقط' : 'look only'}</span>
          </div>
          <div className="card-b">
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', opacity: 0.55 }}>
              {previousMembers.flatMap((pm) => slotsOfMember(view, pm.id).map((s) => (
                <div key={`${pm.id}:${s.role}`} style={{ display: 'grid', gap: 4, justifyItems: 'center' }}>
                  <div
                    style={{
                      width: SLOT_META[s.role].vertical ? 54 : 78,
                      aspectRatio: SLOT_META[s.role].vertical ? '9 / 16' : '1 / 1',
                      borderRadius: 8, overflow: 'hidden', background: 'var(--line)',
                      display: 'grid', placeItems: 'center',
                    }}
                  >
                    {thumbFor(s.asset)
                      ? <img src={thumbFor(s.asset) ?? undefined} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <IconLibrary />}
                  </div>
                  <span style={{ fontSize: 10.5, color: 'var(--mute)' }}>
                    {SLOT_META[s.role].vertical ? (isAr ? 'عمودي' : 'vertical') : (isAr ? 'مربّع' : 'square')}
                  </span>
                </div>
              )))}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.85, marginTop: 10 }}>
              {isAr
                ? 'الغرض أن يبتعد صفّ اليوم عن سابقه في اللون والتكوين والزاوية، لا أن يُعاد استخدام ملفاته — لا يمكن سحب ملف من هنا إلى خانة.'
                : 'It is here so today’s row differs from the last in colour, composition and angle — not as a source to reuse. No file can be dragged from here into a slot.'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
