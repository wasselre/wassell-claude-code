/**
 * «أُعيدت للتعديل» — says, at the top of a row's working screen, why the row
 * is back on this desk: the reviewer's note, who sent it back from which step
 * and when, and which post and which part of it to change (2026-09-27).
 *
 * Until now no row face showed it. The note and the targets live on the CLOSED
 * review task; the next round opens bare. The designer handed the 22 Sep
 * يمام 17 batch in round 2 saw six filled slots and an enabled «إرسال الدفعة»,
 * and nothing saying one word on post 1 — «النرجس» for «النزهة» — was wrong.
 */
import { fieldSchemaEntries, ROLE_LABELS } from '@/lib/marketingOS/client';
import type { MosRowDetail } from '@/lib/marketingOS/rowClient';
import { useWorkspace } from '../MarketingWorkspace';
import { dateTimeShort, num } from '../lib/format';
import { latestSendBack } from '../lib/sendBack';

/** The row screens' own words for the parts a reviewer can name. */
const PART_LABELS: Record<string, { ar: string; en: string }> = {
  headlines: { ar: 'أسطر المنشور', en: 'the post lines' },
  approved_headline: { ar: 'العنوان المعتمد', en: 'the approved headline' },
  caption: { ar: 'التعليق', en: 'the caption' },
  design_brief: { ar: 'موجز التصميم', en: 'the design brief' },
  final_square: { ar: 'التصميم المربع', en: 'the square design' },
  final_vertical: { ar: 'التصميم الطولي', en: 'the vertical design' },
};

const ROLE_TEXT = ROLE_LABELS as Record<string, { ar: string; en: string } | undefined>;

export default function SendBackNotice({
  detail, isAr,
}: {
  detail: Pick<MosRowDetail, 'task' | 'row_tasks' | 'members' | 'steps'>;
  isAr: boolean;
}) {
  const { people, contentTypes } = useWorkspace();
  const sb = latestSendBack(detail);
  if (!sb || !detail.task) return null;
  const { review } = sb;

  const personName = (uid: string | null | undefined): string | null => {
    if (!uid) return null;
    const p = people.find((x) => x.user_id === uid);
    return p ? ((isAr ? (p.name_ar ?? p.name_en) : (p.name_en ?? p.name_ar)) ?? p.email ?? null) : null;
  };
  const step = detail.steps.find((s) => s.key === review.step_id) ?? null;
  const stepLabel = step ? (isAr ? step.label_ar : step.label_en) : (review.step_id ?? '');
  const roleLabel = ROLE_TEXT[review.role];
  const who = personName(review.closed_by_user_id)
    ?? personName(review.assignee_user_id)
    ?? (roleLabel ? (isAr ? roleLabel.ar : roleLabel.en) : (isAr ? 'المراجِع' : 'the reviewer'));

  const partLabel = (typeKey: string | null | undefined, key: string): string => {
    const own = PART_LABELS[key];
    if (own) return isAr ? own.ar : own.en;
    const type = contentTypes.find((t) => t.key === typeKey);
    const def = type ? fieldSchemaEntries(type.field_schema).find((f) => f.key === key) : undefined;
    if (def) return isAr ? def.label_ar : def.label_en;
    return key;
  };

  const postLines = sb.posts.map((p) => {
    const m = p.index >= 0 ? detail.members[p.index] : undefined;
    const which = p.index >= 0
      ? (isAr ? `المنشور ${num(p.index + 1, true)}` : `Post ${p.index + 1}`)
      : (isAr ? 'منشور لم يعد في الدفعة' : 'A post no longer in the batch');
    const title = m ? ` (${m.title})` : '';
    const parts = p.fields.length > 0
      ? p.fields.map((f) => partLabel(m?.content_type_key, f)).join(isAr ? '، ' : ', ')
      : (isAr ? 'المنشور كله' : 'the whole post');
    return `${which}${title} — ${parts}`;
  });

  return (
    <div className="notice" role="status" style={{ display: 'grid', gap: 6 }}>
      <div style={{ fontWeight: 700, fontSize: 14 }}>
        {isAr
          ? `أُعيدت للتعديل — الجولة ${num(detail.task.round, true)}`
          : `Sent back for changes — round ${detail.task.round}`}
      </div>
      <div style={{ fontSize: 12, color: 'var(--mute)' }}>
        {isAr
          ? `أعادها ${who} من «${stepLabel}»${review.closed_at ? ` · ${dateTimeShort(review.closed_at, true)}` : ''}`
          : `Sent back by ${who} at “${stepLabel}”${review.closed_at ? ` · ${dateTimeShort(review.closed_at, false)}` : ''}`}
      </div>
      {sb.note ? (
        <div
          style={{
            fontSize: 14.5, color: 'var(--ink)', lineHeight: 1.8,
            borderInlineStart: '3px solid var(--wait)', paddingInlineStart: 10, borderRadius: 0,
          }}
        >
          {sb.note}
        </div>
      ) : (
        <div>{isAr ? 'لم يكتب المراجِع ملاحظة.' : 'The reviewer left no note.'}</div>
      )}
      {postLines.length > 0 ? (
        <div>
          <b>{isAr ? 'المطلوب: ' : 'What to change: '}</b>
          {postLines.join(isAr ? '؛ ' : '; ')}
        </div>
      ) : (
        <div>
          {isAr
            ? 'لم يحدّد المراجِع منشورًا بعينه — الملاحظة تخصّ الدفعة كلها.'
            : 'No single post was marked — the note is about the whole batch.'}
        </div>
      )}
    </div>
  );
}
