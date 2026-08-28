/**
 * The thread — design screen 10, right column.
 *
 * Comments and the system's own record of what happened share one timeline, so
 * "why did this go back twice?" is answered by scrolling rather than by asking.
 * Rejection notes come from the task chain, not from a comment somebody
 * remembered to leave.
 */
import { useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { MosComment, MosStep, MosTask, ROLE_LABELS, addComment } from '@/lib/marketingOS/client';
import MentionComposer, { renderMentions } from './MentionComposer';
import { dateTime, initial, num, roleAvatarClass } from '../lib/format';

interface Entry {
  key: string;
  at: string;
  kind: 'comment' | 'system';
  role: string | null;
  body: string;
  detail?: string;
}

export default function CommentThread({
  target, comments, tasks, steps, users, canComment, isAr, onChange,
}: {
  target: { contentId?: string; campaignId?: string };
  comments: MosComment[];
  tasks: MosTask[];
  steps: MosStep[];
  users: Array<{ id: string; name_ar: string | null; name_en: string | null }>;
  canComment: boolean;
  isAr: boolean;
  onChange: (comments: MosComment[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [busy, setBusy] = useState(false);

  const nameOf = (userId: string | null): string | null => {
    if (!userId) return null;
    const u = users.find((x) => x.id === userId);
    if (!u) return null;
    return (isAr ? u.name_ar : u.name_en) ?? u.name_en ?? u.name_ar;
  };

  const stepLabel = (stepId: string | null): string => {
    const s = steps.find((x) => x.id === stepId);
    if (!s) return isAr ? 'خطوة' : 'a stage';
    return isAr ? s.label_ar : s.label_en;
  };

  const entries: Entry[] = [
    ...comments.map<Entry>((c) => ({
      key: `c-${c.id}`,
      at: c.created_at,
      kind: 'comment',
      role: null,
      body: c.body,
      detail: nameOf(c.author_user_id) ?? undefined,
    })),
    // The task chain IS the audit trail — closed tasks become timeline entries.
    ...tasks
      .filter((t) => t.status === 'done' && t.closed_at)
      .map<Entry>((t) => {
        const roleLabel = ROLE_LABELS[t.role] ? (isAr ? ROLE_LABELS[t.role].ar : ROLE_LABELS[t.role].en) : t.role;
        const verb = t.result === 'approved'
          ? isAr ? 'اعتمد' : 'approved'
          : t.result === 'changes_requested'
            ? isAr ? 'طلب تعديلات على' : 'requested changes on'
            : isAr ? 'أرسل' : 'submitted';
        return {
          key: `t-${t.id}`,
          at: t.closed_at ?? t.opened_at,
          kind: 'system',
          role: t.role,
          body: `${roleLabel} ${verb} «${stepLabel(t.step_id)}»${
            t.round > 1 ? (isAr ? ` · الجولة ${num(t.round, true)}` : ` · round ${t.round}`) : ''
          }`,
          detail: t.note ?? undefined,
        };
      }),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const send = async (body: string, mentions: string[]): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await addComment(target, body, mentions);
      onChange(res.comments);
      return true;
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'السجل' : 'Activity'}</div>

      {entries.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--mute)', padding: '10px 0' }}>
          {isAr ? 'لا شيء بعد.' : 'Nothing yet.'}
        </div>
      )}

      {entries.map((e) => (
        <div key={e.key} className="thread">
          <span className={`av ${roleAvatarClass(e.role)}`} style={e.kind === 'system' ? { opacity: 0.6 } : undefined}>
            {initial(e.detail ?? e.body)}
          </span>
          <div className="bd">
            {e.kind === 'system' ? (
              <>
                <div className="sys">
                  <b>{e.body}</b>
                  <span className="tm">{dateTime(e.at, isAr)}</span>
                </div>
                {e.detail && <div className="msg">“{e.detail}”</div>}
              </>
            ) : (
              <>
                <div className="who2">
                  {e.detail ?? (isAr ? 'تعليق' : 'Comment')}
                  <span className="tm">{dateTime(e.at, isAr)}</span>
                </div>
                <div className="msg">{renderMentions(e.body, users, isAr)}</div>
              </>
            )}
          </div>
        </div>
      ))}

      {canComment && (
        <div style={{ marginTop: 12 }}>
          <MentionComposer
            people={users}
            isAr={isAr}
            busy={busy}
            rows={3}
            onSubmit={send}
          />
        </div>
      )}
    </div>
  );
}
