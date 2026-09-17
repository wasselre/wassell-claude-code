/**
 * «الصف — اعتماد» — THE approval component for a row. One implementation,
 * mounted two ways.
 *
 * A row is one approval object with two faces: the WRITING review, then the
 * FINAL approval. Both approve the whole row; a send-back names one post and
 * leaves the other two exactly as they were.
 *
 * WHY THIS IS ONE COMPONENT AND NOT TWO. The proposal (§5.1) deletes an inline
 * approval that already existed — a second, weaker copy of the real one that
 * silently dropped the revision targets when you rejected from it. So the
 * requirement here is not "add an approval control to the queue card"; it is
 * that the card expands and renders THIS, whole. The only difference between
 * the queue's copy and the permalink's copy is which element it is mounted in.
 * Rejection is likewise not re-implemented: it opens `RequestChangesModal`, the
 * one rejection dialog, with the posts the reviewer marked already selected.
 *
 * ORDER. Editable at the writing review and read-only at the final approval —
 * by then six designs are keyed to it. That is not just drawn: `row_order_save`
 * refuses the write once the row is past the writing review. The writer's
 * FIRST-read post publishes LAST, because Instagram shows newest first.
 *
 * THE FINAL FACE also puts last week's row of the same project, dimmed, above
 * the three squares. The only real design question at that stage is whether the
 * profile still reads as one account, and a dimmed strip answers it in a second.
 */
import { useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { MosFieldDef, MosPublication, adSetRequiredChoices } from '@/lib/marketingOS/client';
import {
  MosRowDetail, MosRowMember,
  captionStateOf, completeSubjectTask, missingForStep, missingRequirementsOf,
  publishPosition, rowFaceOf, saveRowOrder,
} from '@/lib/marketingOS/rowClient';
import AdReadinessPanel, { hasAdBlockers, useAdReadiness } from './AdReadinessPanel';
import { AutoAdPanel, autoAdOutcomeText, useAutoAdPreview } from './AutoAdApproval';
import { useAssetUrls } from '../lib/assetUrls';
import { num, shortDate } from '../lib/format';
import { Pill } from './kit';
import { IconCheck } from './icons';
import RequestChangesModal from './RequestChangesModal';
import {
  CaptionBlock, MissingCard, PostLines, PostShell, RowTimeline,
  SLOTS, SLOT_META, SlotFrame, slotsFilled, slotsOfMember,
} from './RowParts';

/**
 * The words for the requirements an approval step can refuse on. The SERVER
 * sends these with a real refusal (`api/_lib/marketing/rowTasks.ts`); this copy
 * only labels the LOCAL prediction. Keep the two in step.
 */
const REQUIREMENT_LABELS: Record<string, { ar: string; en: string }> = {
  final_square: { ar: 'الملف المربّع ١:١', en: 'the square 1:1 file' },
  final_vertical: { ar: 'الملف العمودي ٩:١٦', en: 'the vertical 9:16 file' },
  caption: { ar: 'التعليق', en: 'the caption' },
  caption_confirmed: { ar: 'تأكيد التعليق من الكاتب', en: 'the writer’s caption confirmation' },
  headlines: { ar: 'أسطر المنشور', en: 'the post lines' },
  design_brief: { ar: 'موجز التصميم', en: 'the design brief' },
};

/**
 * The writing fields a row send-back can name. Fixed rather than read off the
 * content type because every member of an organic row is the same `post` type
 * and the reviewer is naming what to REWRITE, not what the form happens to show.
 */
const ROW_FIELDS: MosFieldDef[] = [
  { key: 'headlines', label_ar: 'أسطر المنشور', label_en: 'The post lines', kind: 'long', required: true },
  { key: 'caption', label_ar: 'التعليق', label_en: 'The caption', kind: 'long', required: true },
  { key: 'design_brief', label_ar: 'موجز التصميم', label_en: 'The design brief', kind: 'long', required: false },
  { key: 'hashtags', label_ar: 'الهاشتاقات', label_en: 'Hashtags', kind: 'short', required: false },
];

export default function RowApproval({
  detail, isAr, canAct, onChanged, brief,
}: {
  detail: MosRowDetail;
  isAr: boolean;
  canAct: boolean;
  onChanged: () => void | Promise<void>;
  brief?: React.ReactNode;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [refused, setRefused] = useState<Array<{ member: string | null; label_ar: string; label_en: string }> | null>(null);
  /** Posts the reviewer has marked as needing a change, before sending. */
  const [marked, setMarked] = useState<string[]>([]);
  /** A local reorder, applied optimistically while the save is in flight. */
  const [order, setOrder] = useState<string[] | null>(null);

  const face = rowFaceOf(detail.steps, detail.task?.step_id ?? null);
  const finalFace = face === 'final_approval';

  /*
   * A SINGLE item (a paid creative) can carry `auto_meta_ad` on its final
   * approval: approving it creates the Meta ad, server-side, inside
   * `task_complete`. The manager must see WHICH campaign and ad set before the
   * tap, pick one when several are linked, and be stopped when the ad cannot be
   * built — exactly what the old content page's approval did. Rows never carry
   * it (organic), so this is inert for them.
   */
  const itemId = detail.subject.kind === 'item' ? detail.subject.content_id : null;
  const autoAd = !!itemId && finalFace
    && detail.steps.find((s) => s.key === detail.task?.step_id)?.auto_meta_ad === true;
  const autoAdState = useAutoAdPreview(itemId ?? '', autoAd);
  const adReadiness = useAdReadiness(itemId, autoAd);
  const adBlocked = autoAd && hasAdBlockers(adReadiness);
  const needsAdSet = autoAd && autoAdState.preview?.kind === 'choose' && !autoAdState.adSetId;
  const isRow = detail.subject.kind === 'row';

  const members: MosRowMember[] = useMemo(() => {
    if (!order) return detail.members;
    const by = new Map(detail.members.map((m) => [m.id, m]));
    const out = order.map((id) => by.get(id)).filter((m): m is MosRowMember => !!m);
    // Anything the local order does not name still has to be visible.
    for (const m of detail.members) if (!order.includes(m.id)) out.push(m);
    return out;
  }, [detail.members, order]);

  const { urlFor, thumbFor } = useAssetUrls(detail.assets);
  const { filled, total } = slotsFilled(detail);

  /**
   * What the ENGINE would refuse THIS step for — read off the step's own
   * requirements, so an approval step that declares none blocks nothing. The
   * caption is confirmed at the WRITER's submit, not here; showing its state is
   * useful, blocking on it would be a rule the server does not share.
   */
  const step = detail.steps.find((s) => s.key === (detail.task?.step_id ?? ''));
  const predicted = missingForStep(detail, step);

  /* ── the order, editable at the writing review only ───────────────── */

  const move = async (index: number, delta: number): Promise<void> => {
    const next = [...members.map((m) => m.id)];
    const to = index + delta;
    if (to < 0 || to >= next.length) return;
    const a = next[index];
    const b = next[to];
    if (!a || !b) return;
    next[index] = b;
    next[to] = a;
    setOrder(next);
    try {
      await saveRowOrder(detail.row.row_id, next);
      await onChanged();
    } catch (e) {
      setOrder(null);
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  /* ── approve ──────────────────────────────────────────────────────── */

  const approve = async (): Promise<void> => {
    if (!detail.task) return;
    setBusy(true);
    setRefused(null);
    try {
      const res = await completeSubjectTask(detail, {
        taskId: detail.task.id,
        result: 'approved',
        adSetId: autoAd ? autoAdState.adSetId : null,
      });
      const adText = autoAd ? autoAdOutcomeText(res.auto_ad, isAr) : null;
      const stepKey = detail.task.step_id ?? '';
      const approvedText = stepKey === 'design_writer_review'
        ? (isAr ? 'اعتُمد التصميم — انتقل إلى الاعتماد النهائي.' : 'The design is approved — it moved to final approval.')
        : finalFace
          ? (isRow
            ? (isAr ? 'اعتُمدت الدفعة — تُسلَّم الإصدارات آليًا في موعد النشر.' : 'The batch is approved — its releases go out automatically at the publish time.')
            : (isAr ? 'اعتُمد التصميم.' : 'The design is approved.'))
          : (isAr ? 'اعتُمدت الكتابة — انتقلت إلى التصميم.' : 'The writing is approved — it moved to design.');
      addToast(adText ?? approvedText, res.auto_ad?.status === 'skipped' ? 'info' : 'success');
      setMarked([]);
      await onChanged();
    } catch (e) {
      // The server refuses an ambiguous ad set with the choices attached; offer
      // them in the panel rather than showing a raw error.
      const choices = autoAd ? adSetRequiredChoices(e) : null;
      if (choices) {
        autoAdState.offerChoices(choices);
        addToast(isAr ? 'اختر المجموعة الإعلانية أولًا.' : 'Pick the ad set first.', 'error');
        return;
      }
      const missing = missingRequirementsOf(e);
      if (missing) {
        setRefused(missing);
        addToast(isAr ? 'رُفض الاعتماد — الدفعة ناقصة.' : 'The approval was refused — the batch is incomplete.', 'error');
      } else {
        addToast(e instanceof Error ? e.message : String(e), 'error');
        // A step that already closed: show where the batch is now.
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  /**
   * What is shown as blocking: the engine's refusal when it has spoken, else
   * the local prediction of the same rule. Never both, never a third answer.
   */
  const shownMissing = refused ?? (predicted.length > 0
    ? predicted.map(({ member, key }) => ({
        member: member.ref ?? member.title,
        label_ar: REQUIREMENT_LABELS[key]?.ar ?? key,
        label_en: REQUIREMENT_LABELS[key]?.en ?? key,
      }))
    : null);

  const toggleMark = (id: string): void => {
    setMarked((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  };

  /* ── the preflight, final face only ───────────────────────────────── */

  const pubsOf = (contentId: string): MosPublication[] =>
    detail.publications.filter((p) => p.content_id === contentId && p.status !== 'cancelled');
  const membersWithoutDestination = members.filter((m) => pubsOf(m.id).length === 0);
  const accounts = detail.publications
    .filter((p) => p.status !== 'cancelled')
    .map((p) => p.account_handle)
    .filter((h): h is string => !!h);
  const uniqueAccounts = Array.from(new Set(accounts));

  /* ── heading facts ────────────────────────────────────────────────── */

  const batchDay = detail.row.batch_day
    ?? members.map((m) => m.target_publish_at).filter((v): v is string => !!v).sort()[0]
    ?? null;

  const firstMember = members[0];

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* ── what this row is ───────────────────────────────────────── */}
      <div className="card">
        <div className="card-h">
          <h4>
            {isAr
              ? `دفعة سوشيال ميديا ${batchDay ? shortDate(batchDay, true) : 'بلا يوم'}`
              : `Social media batch · ${batchDay ? shortDate(batchDay, false) : 'no day'}`}
          </h4>
          <span className="r" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Pill tone={finalFace ? 'now' : 'wait'}>
              {step ? (isAr ? step.label_ar : step.label_en) : (isAr ? 'بلا مرحلة' : 'no stage')}
            </Pill>
            <Pill tone="idle">
              {isAr
                ? `${num(members.length, true)} منشورات — مهمة واحدة`
                : `${members.length} posts — one task`}
            </Pill>
          </span>
        </div>
        <div className="card-b" style={{ display: 'grid', gap: 10 }}>
          <RowTimeline steps={detail.steps} currentKey={detail.task?.step_id ?? null} isAr={isAr} />
          <div style={{ display: 'grid', gap: 4, gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
            <div style={{ fontSize: 12.5 }}>
              <span style={{ color: 'var(--mute)' }}>{isAr ? 'المحتوى: ' : 'Content: '}</span>
              <b>
                {isAr
                  ? `${num(members.length, true)} منشورات × إصداران = ${num(members.length * 2, true)} إصدارات في نفس اليوم`
                  : `${members.length} posts × two releases = ${members.length * 2} releases on the same day`}
              </b>
            </div>
            <div style={{ fontSize: 12.5 }}>
              <span style={{ color: 'var(--mute)' }}>{isAr ? 'الملفات: ' : 'Files: '}</span>
              <b>{isAr ? `${num(filled, true)} من ${num(total, true)}` : `${filled} of ${total}`}</b>
            </div>
            {uniqueAccounts.length > 0 && (
              <div style={{ fontSize: 12.5 }}>
                <span style={{ color: 'var(--mute)' }}>{isAr ? 'الحساب: ' : 'Account: '}</span>
                <b className="ltr">{uniqueAccounts.join(' · ')}</b>
              </div>
            )}
          </div>
        </div>
      </div>

      {brief}


      {/* ── the three posts ────────────────────────────────────────── */}
      <div
        style={{
          display: 'grid', gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        }}
      >
        {members.map((m, i) => {
          const { text: caption, confirmed } = captionStateOf(m);
          const isMarked = marked.includes(m.id);
          const slots = slotsOfMember(detail, m.id);
          return (
            <PostShell
              key={m.id}
              member={m}
              index={i}
              total={members.length}
              isAr={isAr}
              tone={isMarked || (!finalFace && !confirmed) ? 'gap' : 'ok'}
              right={
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {!finalFace && canAct && isRow && members.length > 1 && (
                    <>
                      <button
                        type="button"
                        className="btn btn-d btn-sm"
                        disabled={busy || i === 0}
                        title={isAr ? 'أعلى' : 'Move up'}
                        onClick={() => void move(i, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn btn-d btn-sm"
                        disabled={busy || i === members.length - 1}
                        title={isAr ? 'أسفل' : 'Move down'}
                        onClick={() => void move(i, 1)}
                      >
                        ↓
                      </button>
                    </>
                  )}
                  <Pill tone={isMarked ? 'late' : 'go'}>
                    {isMarked
                      ? (isAr ? 'يحتاج تعديلًا' : 'needs changes')
                      : (isAr ? 'مقبول' : 'accepted')}
                  </Pill>
                </div>
              }
            >
              {finalFace ? (
                <div style={{ display: 'grid', gap: 10 }}>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
                    {SLOTS.map((role) => {
                      const slot = slots.find((s) => s.role === role);
                      return (
                        <div key={role} style={{ display: 'grid', gap: 5, justifyItems: 'center' }}>
                          <SlotFrame
                            role={role}
                            asset={slot?.asset ?? null}
                            url={urlFor(slot?.asset ?? null)}
                            thumb={thumbFor(slot?.asset ?? null)}
                            empty={isAr ? 'الخانة فارغة' : 'empty slot'}
                          />
                          <span style={{ fontSize: 11, color: 'var(--mute)', textAlign: 'center' }}>
                            {isAr ? SLOT_META[role].ar : SLOT_META[role].en}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <CaptionBlock member={m} isAr={isAr} />
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 12 }}>
                  <PostLines member={m} isAr={isAr} />
                  <CaptionBlock
                    member={m}
                    isAr={isAr}
                    label={isAr ? 'التعليق المنشور' : 'The published caption'}
                  />
                  {caption === '' && (
                    <div style={{ fontSize: 11.5, color: 'var(--late)', lineHeight: 1.8 }}>
                      {isAr
                        ? 'لا يمكن الاعتماد بلا تعليق.'
                        : 'Cannot be approved without a caption.'}
                    </div>
                  )}
                </div>
              )}
              {canAct && (
                <button
                  type="button"
                  className={`btn btn-sm${isMarked ? ' btn-p' : ''}`}
                  disabled={busy}
                  onClick={() => toggleMark(m.id)}
                >
                  {isMarked
                    ? (isAr ? 'تراجع عن التعليم' : 'Unmark')
                    : (isAr ? 'علّم هذا المنشور للإعادة' : 'Mark this post for changes')}
                </button>
              )}
            </PostShell>
          );
        })}
      </div>

      {/* ── the order rule, stated once ────────────────────────────── */}
      <div className="card">
        <div className="card-b" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="tag">
            {isAr
              ? `النشر: ${members.map((_, i) => num(publishPosition(i, members.length), true)).reverse().join(' ثم ')}`
              : `Publish: ${members.map((_, i) => publishPosition(i, members.length)).reverse().join(' then ')}`}
          </span>
          <span className="tag">
            {finalFace
              ? (isAr ? 'التعديل في مراجعة الكتابة وحدها' : 'editable at the writing review only')
              : (isAr ? 'هذه آخر فرصة لتعديل الترتيب' : 'last chance to change the order')}
          </span>
        </div>
      </div>

      {/* An ad has no organic destination — the Meta ad IS where it goes. */}
      {finalFace && detail.row.kind !== 'paid_creative' && membersWithoutDestination.length > 0 && (
        <div className="notice bad" role="alert">
          {isAr
            ? `${num(membersWithoutDestination.length, true)} من المنشورات بلا وجهة نشر — لن يخرج شيء لها.`
            : `${membersWithoutDestination.length} post(s) have no destination — nothing will go out for them.`}
        </div>
      )}


      {/* ── the engine's own refusal, or the same answer predicted ─── */}
      {shownMissing && (
        <MissingCard
          missing={shownMissing}
          isAr={isAr}
          title={isAr ? 'لا يمكن اعتماد الدفعة — ما زالت ناقصة' : 'This batch cannot be approved — it is still incomplete'}
        />
      )}

      {/* ── the decision ───────────────────────────────────────────── */}
      <div className="card">
        <div className="card-b" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 250, fontSize: 11.5, color: 'var(--mute)', lineHeight: 1.9 }}>
            {finalFace
              ? isAr
                ? `${num(members.length * 2, true)} إصدارات: ${num(members.length, true)} للخلاصة و${num(members.length, true)} للستوري`
                : `${members.length * 2} releases: ${members.length} feed, ${members.length} stories`
              : null}
          </div>
          {autoAd && (
            <div style={{ flexBasis: '100%', display: 'grid', gap: 10 }}>
              <AdReadinessPanel state={adReadiness} isAr={isAr} />
              <AutoAdPanel state={autoAdState} isAr={isAr} compact />
            </div>
          )}
          {canAct && detail.task ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setRejectOpen(true)}
              >
                {marked.length > 0
                  ? isAr
                    ? `أعد ${num(marked.length, true)} ${marked.length === 1 ? 'منشورًا' : 'منشورات'} للكاتب`
                    : `Send ${marked.length} post${marked.length === 1 ? '' : 's'} back`
                  : isAr ? 'أعد منشورًا واحدًا' : 'Send one post back'}
              </button>
              <button
                type="button"
                className="btn btn-go"
                disabled={busy || marked.length > 0 || predicted.length > 0 || adBlocked || needsAdSet}
                title={marked.length > 0
                  ? (isAr ? 'أزل التعليم أولًا، أو أرسل الإعادة' : 'Unmark first, or send the changes')
                  : predicted.length > 0
                    ? (isAr ? 'الدفعة ناقصة' : 'The batch is incomplete')
                    : undefined}
                onClick={() => void approve()}
              >
                <IconCheck />
                {busy
                  ? (isAr ? 'جارٍ…' : 'Working…')
                  : !isRow
                    ? finalFace
                      ? (isAr ? 'اعتماد التصميم' : 'Approve the design')
                      : (isAr ? 'اعتماد الكتابة' : 'Approve the writing')
                    : finalFace
                      ? (isAr ? 'اعتماد الدفعة' : 'Approve the batch')
                      : (isAr ? 'اعتماد كتابة الدفعة' : 'Approve the batch’s writing')}
              </button>
            </div>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--mute)' }}>
              {detail.task
                ? (isAr ? 'هذه المرحلة ليست لك — عرض فقط.' : 'This stage is not yours — view only.')
                : (isAr ? 'لا مهمة مفتوحة على هذه الدفعة.' : 'This batch has no open task.')}
            </span>
          )}
        </div>
      </div>

      {/* ── the ONE rejection dialog, carrying the member dimension ── */}
      {rejectOpen && detail.task && firstMember && (
        <RequestChangesModal
          item={firstMember}
          openTask={detail.task}
          steps={detail.steps}
          scenes={[]}
          fields={ROW_FIELDS}
          isAr={isAr}
          members={members.map((m) => ({ id: m.id, ref: m.ref, title: m.title }))}
          initialMembers={marked}
          subjectLabel={isAr
            ? `دفعة سوشيال ميديا ${batchDay ? shortDate(batchDay, true) : ''}`
            : `Social media batch · ${batchDay ? shortDate(batchDay, false) : ''}`}
          sendChanges={async ({ note, targets, returnTo }) => {
            const res = await completeSubjectTask(detail, {
              taskId: detail.task?.id, result: 'changes_requested', note, targets, returnTo,
            });
            return { opened_task_id: res.opened_task_id };
          }}
          onClose={() => setRejectOpen(false)}
          onSubmitted={() => {
            setRejectOpen(false);
            setMarked([]);
            void onChanged();
          }}
        />
      )}
    </div>
  );
}
