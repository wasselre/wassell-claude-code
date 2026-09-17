/**
 * The ROW writer — F3.
 *
 * A row is three posts for one project on ONE day. It is one card in the queue,
 * one task and ONE submit — but three writing slots in the ledger. This surface
 * is where that becomes true for the writer: the three drafts sit side by side,
 * she sets the order they will read on the account, and she sends once.
 *
 * Three rules this surface exists to make visible:
 *
 *   1. **One submit, and it is all-or-nothing.** An empty third post blocks the
 *      finished two. That refusal is the rule, not a bug: a row does not go out
 *      as two posts. The check card names the post holding it and why, and the
 *      engine's own refusal (`MOS:REQUIREMENTS_MISSING`) is rendered as the
 *      same kind of list rather than as «رفضت قاعدة البيانات هذا التغيير».
 *
 *   2. **The first-read post publishes LAST.** Instagram shows the newest first,
 *      so publish reverses the writer's order: post 1 goes out at the END of the
 *      batch and therefore lands on top of the profile. The rule is stated on
 *      screen because an unexplained reversal reads as a bug. The reversal
 *      itself lives in `releases.ts`; `publishPosition()` is the one function
 *      every pane derives it from.
 *
 *   3. **Order is editable HERE and at the writing review, and nowhere after.**
 *      By the final approval the design is keyed to it, so the final pane shows
 *      the order read-only — and `row_order_save` refuses the edit server-side,
 *      so that is enforced rather than merely drawn.
 *
 * Same contract as its sibling faces (`RowDesign`, `RowApproval`): the row is
 * loaded ONCE by whoever mounts this — `RowPane` for the queue and the
 * permalink, a row screen for the writer — and the resolved brief arrives as a
 * `brief` node, because the month's notes belong to the caller that already has
 * them. `MonthBriefPanel` is what a caller puts there, resolving down the
 * ORGANIC lane only (D7): month → project column → row cell, and month → cell →
 * topic bank for a general (Saturday) row, which has no project column at all.
 */
import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { fieldSchemaKeys, updateContent } from '@/lib/marketingOS/client';
import {
  completeSubjectTask, headlinesOf, missingRequirementsOf, publishPosition,
  rowFaceOf, saveRowOrder,
  type MosMissingRequirement, type MosRowDetail, type MosRowMember,
} from '@/lib/marketingOS/rowClient';
import { useWorkspace } from '../MarketingWorkspace';
import { CheckLine, MissingCard, PostShell, RowTimeline } from './RowParts';
import { dayLabel, fullDate, num } from '../lib/format';
import WritingFields, { postWritingState } from './WritingFields';

/**
 * One shared empty object for a member with no `data` yet.
 *
 * `WritingFields` re-seeds its draft whenever the `data` PROP CHANGES IDENTITY,
 * so handing it a fresh `{}` on every render would wipe what the writer is
 * typing the moment any sibling reports a draft change.
 */
const NO_DATA: Record<string, unknown> = Object.freeze({});

const postsGrid = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: 14,
  alignItems: 'start' as const,
};

const moveBtn = {
  flex: '0 0 auto', width: 24, height: 24, padding: 0, lineHeight: 1, fontSize: 12,
  borderRadius: 6, border: '1px solid var(--line)', background: 'var(--paper)',
  color: 'var(--mute)', cursor: 'pointer',
};

/** One line of the pre-send check: the claim, whether it holds, and why not. */
interface RowCheck {
  key: string;
  ok: boolean;
  claim_ar: string;
  claim_en: string;
  detail_ar: string;
  detail_en: string;
}

export default function RowWriter({
  detail, isAr, canAct, onChanged, brief,
}: {
  /** The row, already loaded — one `row_detail` per surface, never per face. */
  detail: MosRowDetail;
  isAr: boolean;
  /** The open task sits with a role I hold (`stageIsMine`). */
  canAct: boolean;
  /** Fired after a save, a reorder or a submit, so the caller reloads. */
  onChanged?: () => void | Promise<void>;
  /** The resolved-brief panel — `MonthBriefPanel`, mounted by the caller. */
  brief?: ReactNode;
}) {
  const { contentTypes, projectName, can } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);

  const [busy, setBusy] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [missing, setMissing] = useState<MosMissingRequirement[] | null>(null);

  /** The live drafts, keyed by content id and fed by each `WritingFields`. */
  const [drafts, setDrafts] = useState<Record<string, { data: Record<string, unknown>; dirty: boolean }>>({});
  /** The order on screen, which can run ahead of the server between saves. */
  const [order, setOrder] = useState<string[]>([]);

  const memberKey = detail.members.map((m) => m.id).join(',');
  useEffect(() => {
    setOrder(detail.members.map((m) => m.id));
    setDrafts(Object.fromEntries(detail.members.map((m) => [m.id, { data: m.data ?? {}, dirty: false }])));
    setMissing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberKey]);

  const members: MosRowMember[] = useMemo(() => {
    const by = new Map(detail.members.map((m) => [m.id, m]));
    const ordered = order.map((id) => by.get(id)).filter((m): m is MosRowMember => !!m);
    // Anything the local order does not know about still has to render.
    for (const m of detail.members) if (!order.includes(m.id)) ordered.push(m);
    return ordered;
  }, [detail, order]);

  const onDraftChange = useCallback(
    (contentId: string, data: Record<string, unknown>, dirty: boolean): void => {
      setDrafts((cur) => ({ ...cur, [contentId]: { data, dirty } }));
    },
    [],
  );

  const schemaOf = useCallback((typeKey: string): string[] => {
    const t = contentTypes.find((ct) => ct.key === typeKey);
    return fieldSchemaKeys(t?.field_schema ?? []);
  }, [contentTypes]);

  /* ── may I edit this row? ──────────────────────────────────────────
     The row's FACE decides what the surface is for; who holds the open task
     decides whether it is mine. An unassigned task in a role I hold is mine to
     pick up — the same rule the queue uses. */
  const task = detail.task ?? null;
  const face = rowFaceOf(detail.steps, task?.step_id);
  const canEdit = canAct
    && !!task && task.status === 'open'
    && face === 'writing'
    && can('write_content');

  /* ── the order ─────────────────────────────────────────────────────
     Written through `row_order_save`, which refuses once the designs are keyed
     to it. Saved immediately rather than at submit, so a reload never loses a
     decision the writer already made. */
  const move = async (index: number, delta: number): Promise<void> => {
    const to = index + delta;
    if (to < 0 || to >= members.length) return;
    const next = members.map((m) => m.id);
    const [moved] = next.splice(index, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    const before = order;
    setOrder(next);
    setReordering(true);
    try {
      await saveRowOrder(detail.row.row_id, next);
      await onChanged?.();
    } catch (e) {
      // Never leave an order on screen the server refused.
      console.error('[marketing] row order save failed', e);
      setOrder(before);
      addToast(
        isAr
          ? `تعذّر حفظ الترتيب: ${e instanceof Error ? e.message : String(e)}`
          : `Could not save the order: ${e instanceof Error ? e.message : String(e)}`,
        'error',
      );
    } finally {
      setReordering(false);
    }
  };

  /* ── the pre-send check ────────────────────────────────────────────
     The engine is the real gate (`workflow_advance_role_path` refuses and names
     the member); this is the writer's own view of the same three questions, so
     she is not sent to the button to find out. */
  const states = useMemo(
    () => members.map((m) => postWritingState(drafts[m.id]?.data ?? m.data ?? {})),
    [members, drafts],
  );

  const postName = (i: number): string => {
    const m = members[i];
    return m?.ref ?? (isAr ? `المنشور ${num(i + 1, true)}` : `post ${i + 1}`);
  };

  const checks: RowCheck[] = useMemo(() => {
    const idx = (pred: (s: ReturnType<typeof postWritingState>) => boolean): number[] =>
      states.map((s, i) => (pred(s) ? i : -1)).filter((i) => i >= 0);

    const noLines = idx((s) => !s.hasLines);
    const noCaption = idx((s) => !s.hasCaption);
    const unconfirmed = idx((s) => s.hasCaption && !s.captionConfirmed);

    // «لا سطر أول متكرر» — the row-level sameness check is about FIRST LINES
    // (the hook), not whole line lists: three posts for one project on one day
    // that open identically read as one post sent three times.
    const firsts = states.map((s) => (s.lines[0] ?? '').trim()).filter((v) => v !== '');
    const dupFirst = firsts.length !== new Set(firsts).size;

    const n = members.length;
    const all_ar = `الـ${num(n, true)}`;
    const all_en = `all ${n}`;
    const names = (list: number[], ar: boolean): string =>
      list.map((i) => (ar ? postName(i) : (members[i]?.ref ?? `post ${i + 1}`))).join(ar ? '، ' : ', ');

    return [
      {
        key: 'lines',
        ok: noLines.length === 0,
        claim_ar: `${all_ar} تحمل أسطرًا`,
        claim_en: `${all_en} posts carry lines`,
        detail_ar: noLines.length === 0
          ? 'كل منشور يحمل النص الذي يظهر على تصميمه.'
          : `${names(noLines, true)} بلا أسطر.`,
        detail_en: noLines.length === 0
          ? 'Every post carries the copy that lands on its design.'
          : `${names(noLines, false)} has no lines.`,
      },
      {
        key: 'caption',
        ok: noCaption.length === 0,
        claim_ar: `${all_ar} تحمل نصًا`,
        claim_en: `${all_en} posts carry a caption`,
        detail_ar: noCaption.length === 0
          ? 'كل منشور يحمل نصه الذي يُنشر تحت الصورة.'
          : `${names(noCaption, true)} بلا نص.`,
        detail_en: noCaption.length === 0
          ? 'Every post carries the caption published under it.'
          : `${names(noCaption, false)} has no caption.`,
      },
      {
        key: 'caption_confirmed',
        ok: unconfirmed.length === 0,
        claim_ar: 'كل نص مؤكَّد من الكاتب',
        claim_en: 'Every caption is writer-confirmed',
        detail_ar: unconfirmed.length === 0
          ? 'لا نص هنا كتبه الذكاء ومرّ دون أن يقرأه أحد.'
          : `${names(unconfirmed, true)} نصه مسودة لم تُؤكَّد — اقرأه ثم أكّده.`,
        detail_en: unconfirmed.length === 0
          ? 'No caption here was written by the AI and passed unread.'
          : `${names(unconfirmed, false)} still carries an unconfirmed draft — read it, then confirm.`,
      },
      {
        key: 'distinct',
        ok: !dupFirst,
        claim_ar: 'لا سطر أول متكرر',
        claim_en: 'No two posts open the same way',
        detail_ar: dupFirst
          ? 'منشوران يفتحان بالسطر نفسه — غيّر الخطاف أو الزاوية.'
          : 'الخطافات الثلاثة مختلفة في الصياغة والزاوية.',
        detail_en: dupFirst
          ? 'Two posts open with the same line — change the hook or the angle.'
          : 'The three hooks differ in wording and in angle.',
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, states, isAr]);

  /** Is at least one post finished? — see the flag rule at the posts grid. */
  const anyReady = states.some((st) => st.hasLines && st.captionConfirmed);
  const failing = checks.filter((c) => !c.ok);
  const canSend = canEdit && members.length > 0 && failing.length === 0 && !busy;

  const saveDrafts = async (): Promise<void> => {
    const dirty = members.filter((m) => drafts[m.id]?.dirty);
    if (dirty.length === 0) return;
    await Promise.all(dirty.map((m) => updateContent(m.id, {
      data: { ...(m.data ?? NO_DATA), ...(drafts[m.id]?.data ?? {}) },
    })));
    setDrafts((cur) => Object.fromEntries(
      Object.entries(cur).map(([id, d]) => [id, { ...d, dirty: false }]),
    ));
  };

  const saveOnly = async (): Promise<void> => {
    setBusy(true);
    try {
      await saveDrafts();
      addToast(
        isAr ? 'حُفظت مسودات الدفعة' : 'The batch’s drafts were saved',
        'success',
      );
      await onChanged?.();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    setBusy(true);
    setMissing(null);
    try {
      // The writing has to be ON the records before the engine reads them —
      // the requirement check runs server-side over all three members.
      await saveDrafts();
      await completeSubjectTask(detail, { taskId: task?.id ?? null, result: 'submitted' });
      addToast(isAr ? 'أُرسلت الدفعة للمراجعة' : 'The batch was sent for review', 'success');
      await onChanged?.();
    } catch (e) {
      const named = missingRequirementsOf(e);
      if (named) setMissing(named);
      else addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const row = detail.row;
  const project = row.project_id
    ? projectName(row.project_id)
    : (isAr ? 'عام — بلا مشروع' : 'General — no project');
  const total = members.length;

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {/* ── the row's identity ───────────────────────────────────── */}
      <div className="write">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div className="doc-lbl" style={{ margin: 0, fontSize: 13 }}>
            {isAr
              ? `دفعة سوشيال ميديا ${dayLabel(row.batch_day, true)} — ${project}`
              : `Social media batch · ${dayLabel(row.batch_day, false)} — ${project}`}
          </div>
          <span className="tag tag-t">{fullDate(row.batch_day, isAr)}</span>
          <span className="tag tag-t">
            {isAr
              ? `${num(total, true)} منشورات · ${num(total * 2, true)} إصدارات`
              : `${total} posts · ${total * 2} releases`}
          </span>
          {!canEdit && (
            <span className="tag tag-t" style={{ marginInlineStart: 'auto' }}>
              {isAr ? 'للقراءة فقط — الكتابة ليست لديك الآن' : 'Read-only — the writing does not sit with you'}
            </span>
          )}
        </div>
        <div style={{ marginTop: 10 }}>
          <RowTimeline steps={detail.steps} currentKey={task?.step_id ?? null} isAr={isAr} />
        </div>
      </div>

      {/* ── the resolved brief — ORGANIC lane only (D7), mounted by the
             caller because the month's notes are the caller's to hold. ─── */}
      {brief}

      {/* ── the engine's refusal, named ──────────────────────────── */}
      {missing && (
        <MissingCard
          missing={missing}
          isAr={isAr}
          title={isAr ? 'الدفعة لم تُرسل — بنود ناقصة' : 'The batch was not sent — missing requirements'}
        />
      )}

      {/* ── the three posts, side by side ────────────────────────────
             A post is flagged only once a SIBLING is finished: on a fresh row
             nothing is written yet, and three red cards say "everything is
             wrong" when the truth is "nothing has started". The flag means
             «this one is holding the row», which is only true relative to the
             others. What is missing is said in full by the check card below. */}
      <div style={postsGrid}>
        {members.map((m, i) => {
          const s = states[i];
          const ready = !!s?.hasLines && !!s?.captionConfirmed;
          return (
            <PostShell
              key={m.id}
              member={m}
              index={i}
              total={total}
              isAr={isAr}
              tone={!ready && anyReady ? 'gap' : undefined}
              right={(
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span
                    className="tag"
                    style={{
                      color: ready ? 'var(--go)' : 'var(--wait)',
                      borderColor: ready ? 'var(--go)' : 'var(--wait)',
                      background: 'transparent', fontWeight: 700,
                    }}
                  >
                    {ready
                      ? (isAr ? 'جاهز' : 'Ready')
                      : !s?.hasLines
                        ? (isAr ? 'بلا أسطر' : 'No lines')
                        : (isAr ? 'النص غير مؤكَّد' : 'Caption unconfirmed')}
                  </span>
                  {/* Order only means something for a row of several posts. */}
                  {canEdit && detail.subject.kind === 'row' && total > 1 && (
                    <>
                      <button
                        type="button"
                        style={moveBtn}
                        disabled={i === 0 || reordering}
                        onClick={() => { void move(i, -1); }}
                        aria-label={isAr ? 'تقديم هذا المنشور في الترتيب' : 'Move this post earlier'}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        style={moveBtn}
                        disabled={i === total - 1 || reordering}
                        onClick={() => { void move(i, 1); }}
                        aria-label={isAr ? 'تأخير هذا المنشور في الترتيب' : 'Move this post later'}
                      >
                        ↓
                      </button>
                    </>
                  )}
                </span>
              )}
            >
              <WritingFields
                contentId={m.id}
                schema={schemaOf(m.content_type_key)}
                data={m.data ?? NO_DATA}
                canEdit={canEdit}
                isAr={isAr}
                embedded
                onDraftChange={onDraftChange}
                onSaved={() => { void onChanged?.(); }}
              />
            </PostShell>
          );
        })}
      </div>

      {/* ── the check, and the one submit ────────────────────────── */}
      <div className="write">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
          <div className="doc-lbl" style={{ margin: 0 }}>
            {isAr ? 'فحص قبل الإرسال' : 'Check before sending'}
          </div>
          <span
            className="tag"
            style={{
              marginInlineStart: 'auto',
              color: failing.length === 0 ? 'var(--go)' : 'var(--late)',
              borderColor: failing.length === 0 ? 'var(--go)' : 'var(--late)',
              background: 'transparent', fontWeight: 700,
            }}
          >
            {failing.length === 0
              ? (isAr ? 'كل البنود مستوفاة' : 'Everything holds')
              : isAr
                ? `${num(failing.length, true)} بند غير مستوفٍ`
                : `${failing.length} item${failing.length === 1 ? '' : 's'} unmet`}
          </span>
        </div>
        {checks.map((c) => (
          <CheckLine
            key={c.key}
            ok={c.ok}
            label={(
              <>
                <b>{isAr ? c.claim_ar : c.claim_en}</b>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--mute)' }}>
                  {isAr ? c.detail_ar : c.detail_en}
                </span>
              </>
            )}
            value={c.ok ? (isAr ? 'مستوفٍ' : 'met') : (isAr ? 'ناقص' : 'missing')}
          />
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-p"
            disabled={!canSend}
            onClick={() => { void submit(); }}
          >
            {busy ? (isAr ? 'جارٍ الإرسال…' : 'Sending…') : isAr ? 'إرسال الدفعة' : 'Send the batch'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!canEdit || busy}
            onClick={() => { void saveOnly(); }}
          >
            {isAr ? 'حفظ مسودة' : 'Save draft'}
          </button>
          <span style={{ fontSize: 11.5, color: failing.length > 0 ? 'var(--late)' : 'var(--mute)' }}>
            {failing.length > 0
              && (isAr
                ? `لا يمكن الإرسال: ${failing[0]?.detail_ar ?? ''}`
                : `Cannot send: ${failing[0]?.detail_en ?? ''}`)}
          </span>
        </div>
      </div>

      {/* ── why the first one publishes last ─────────────────────── */}
      <div className="write">
        <div className="doc-lbl">
          {isAr ? 'لماذا يُنشر الأول أخيرًا' : 'Why the first one publishes last'}
        </div>
        <p style={{ fontSize: 13.5, lineHeight: 1.9 }}>
          {isAr
            ? 'إنستقرام يعرض الأحدث أولًا. لذلك يُقلب ترتيبك عند النشر داخل الدفعة نفسها: المنشور الذي وضعتَه أولًا يُنشر أخيرًا، فيستقرّ أعلى الحساب ويقرؤه الزائر أولًا. الفارق بين منشور وآخر دقائق معدودة داخل فتحة اليوم نفسه.'
            : 'Instagram shows the newest first. So publish reverses your order inside the same batch: the post you put FIRST goes out LAST, lands on top of the profile, and is the one a visitor reads first. The gap between them is a few minutes inside the same day’s slot.'}
        </p>
        <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
          {members.map((m, i) => {
            const pos = publishPosition(i, total);
            return (
              <div
                key={m.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  fontSize: 12.5, padding: '6px 10px',
                  border: '1px solid var(--line-soft)', borderRadius: 7,
                }}
              >
                <span style={{ color: 'var(--mute)' }}>
                  {isAr ? `القراءة ${num(i + 1, true)}` : `read #${i + 1}`}
                </span>
                <span style={{ flex: 1, minWidth: 140 }}>
                  {headlinesOf(m)[0] ?? m.title}
                </span>
                <span style={{ color: 'var(--mute)' }}>
                  {isAr
                    ? `النشر ${num(pos, true)}${pos === total ? ' — أولًا' : pos === 1 ? ' — أخيرًا' : ''}`
                    : `publish #${pos}${pos === total ? ' — first out' : pos === 1 ? ' — last out' : ''}`}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── last week's row of the same project ──────────────────── */}
      {detail.previous_row && detail.previous_row.members.length > 0 && (
        <div className="write">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
            <div className="doc-lbl" style={{ margin: 0 }}>
              {isAr ? 'آخر دفعة نُشرت لهذا المشروع' : 'This project’s last published batch'}
            </div>
            <span className="tag tag-t" style={{ marginInlineStart: 'auto' }}>
              {isAr ? 'للاطّلاع فقط' : 'For reference only'}
            </span>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            {detail.previous_row.members.map((m, i) => (
              <div
                key={m.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  fontSize: 12.5, padding: '6px 10px', color: 'var(--mute)',
                  border: '1px solid var(--line-soft)', borderRadius: 7,
                }}
              >
                <span>{num(i + 1, isAr)}</span>
                <span style={{ flex: 1, minWidth: 140 }}>{headlinesOf(m)[0] ?? m.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
