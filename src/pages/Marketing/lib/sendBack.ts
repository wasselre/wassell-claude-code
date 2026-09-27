/**
 * «أُعيدت للتعديل» — the send-back an open row task is answering (2026-09-27).
 *
 * When a reviewer requests changes, the note and the posts/fields it names are
 * stored on the REVIEW task — which is then closed — while the next round's
 * task opens with neither. No row face read them back, so the designer handed
 * the 22 Sep يمام 17 batch in round 2 saw six filled slots, a full meter and an
 * enabled «إرسال الدفعة», and nothing saying one word on post 1 was wrong. It
 * sat five days late.
 *
 * Pure: reads the row's own task history (`row_detail.row_tasks`), no fetch.
 */
import type { MosRowDetail, MosSubjectTask } from '@/lib/marketingOS/rowClient';

export interface SendBackPost {
  memberId: string;
  /** Reading-order position, 0-based; -1 when the post is no longer in the row. */
  index: number;
  /** The fields named on that post; empty means the whole post. */
  fields: string[];
}

export interface SendBack {
  /** The closed review task that sent the work back. */
  review: MosSubjectTask;
  note: string | null;
  /** Posts the reviewer named, in reading order. */
  posts: SendBackPost[];
  /** Targets that name no post (a single item's fields, scenes). */
  otherTargets: string[];
}

const at = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
};

/**
 * The send-back the OPEN task answers: only while the row's most recent closed
 * task is a «changes requested». Once the fixed work is submitted, the newest
 * closed task is that submission and the notice goes away.
 */
export function latestSendBack(detail: Pick<MosRowDetail, 'task' | 'row_tasks' | 'members'>): SendBack | null {
  if (!detail.task) return null;
  const closed = (detail.row_tasks ?? [])
    .filter((t) => t.status === 'done' && t.id !== detail.task?.id)
    .sort((a, b) => at(b.closed_at) - at(a.closed_at));
  const review = closed[0];
  if (!review || review.result !== 'changes_requested') return null;

  const byMember = new Map<string, Set<string>>();
  const whole = new Set<string>();
  const otherTargets: string[] = [];
  for (const raw of review.revision_targets ?? []) {
    if (typeof raw !== 'string' || raw === '') continue;
    if (!raw.startsWith('post:')) {
      otherTargets.push(raw);
      continue;
    }
    const rest = raw.slice('post:'.length);
    const cut = rest.indexOf(':');
    const id = cut < 0 ? rest : rest.slice(0, cut);
    const field = cut < 0 ? '' : rest.slice(cut + 1);
    if (!id) continue;
    if (!byMember.has(id)) byMember.set(id, new Set());
    if (field) byMember.get(id)?.add(field);
    else whole.add(id);
  }

  const posts: SendBackPost[] = Array.from(byMember.entries())
    .map(([memberId, fields]) => ({
      memberId,
      index: detail.members.findIndex((m) => m.id === memberId),
      // A post named whole AND by field is simply the whole post.
      fields: whole.has(memberId) ? [] : Array.from(fields),
    }))
    .sort((a, b) => (a.index < 0 ? 999 : a.index) - (b.index < 0 ? 999 : b.index));

  const note = typeof review.note === 'string' && review.note.trim() !== '' ? review.note.trim() : null;
  return { review, note, posts, otherTargets };
}

/**
 * Has the post's design been replaced since the send-back? True once a final
 * slot on that post carries a file linked after the review closed.
 */
export function redesignedSince(
  links: Array<{ content_id: string; role: string; created_at?: string | null }>,
  memberId: string,
  sinceIso: string | null,
): boolean {
  const since = at(sinceIso);
  if (!since) return false;
  return links.some((l) => l.content_id === memberId
    && (l.role === 'final_square' || l.role === 'final_vertical')
    && at(l.created_at) > since);
}
