import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CornerDownLeft, MessageSquareText, RotateCcw, Trash2, Undo2, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { CommentThread, DocComment } from '@/lib/documents/comments';
import ConfirmModal from '@/components/ui/ConfirmModal';

/**
 * Comment threads sidebar for the document editor (Google-Docs style).
 *
 * Pure display + composition: the PAGE owns the thread list, the anchor
 * position map, mutations, and the highlight refresh — this component renders
 * threads in reading order, hosts the pending-comment composer, and calls
 * back up for every action. Threads whose anchor mark is gone from the
 * document ("orphaned") show their anchor_text snapshot greyed out.
 */

export interface PendingAnchor {
  from: number;
  to: number;
  text: string;
}

interface Props {
  threads: CommentThread[];
  /** comment id → first anchor position in the doc (absent = orphaned). */
  anchorPositions: Map<string, number>;
  activeId: string | null;
  onActivate: (id: string | null) => void;
  /** New-comment composer state (selection snapshot from the toolbar). */
  pending: PendingAnchor | null;
  onSubmitPending: (body: string) => Promise<void>;
  onCancelPending: () => void;
  onReply: (rootId: string, body: string) => Promise<void>;
  onSetResolved: (rootId: string, resolved: boolean) => Promise<void>;
  onDelete: (comment: DocComment, isRoot: boolean) => Promise<void>;
  onClose: () => void;
  /** Whether the current user may add comments (needs doc edit for the mark). */
  canComment: boolean;
}

export default function CommentsPanel({
  threads,
  anchorPositions,
  activeId,
  onActivate,
  pending,
  onSubmitPending,
  onCancelPending,
  onReply,
  onSetResolved,
  onDelete,
  onClose,
  canComment,
}: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const users = useAppStore((s) => s.users);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const [showResolved, setShowResolved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ comment: DocComment; isRoot: boolean } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const userName = (id: string): string => {
    const u = users.find((x) => x.id === id);
    if (!u) return t('doc.comments.unknown_user');
    return (isAr ? u.name_ar : u.name_en) || u.email;
  };

  const fmtTime = (iso: string): string =>
    new Date(iso).toLocaleString(isAr ? 'ar-SA' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });

  /** Reading order: anchored threads by document position, then orphans
   *  (newest first). Resolved threads live in their own collapsed section. */
  const { open, resolved } = useMemo(() => {
    const sortKey = (th: CommentThread) => anchorPositions.get(th.root.id) ?? Number.MAX_SAFE_INTEGER;
    const sorted = [...threads].sort((a, b) => {
      const pa = sortKey(a);
      const pb = sortKey(b);
      if (pa !== pb) return pa - pb;
      return b.root.created_at.localeCompare(a.root.created_at);
    });
    return {
      open: sorted.filter((th) => !th.root.resolved),
      resolved: sorted.filter((th) => th.root.resolved),
    };
  }, [threads, anchorPositions]);

  // Activating a resolved thread (click on a leftover span) must reveal it.
  useEffect(() => {
    if (!activeId) return;
    if (resolved.some((th) => th.root.id === activeId)) setShowResolved(true);
  }, [activeId, resolved]);

  // Keep the active card in view when activation comes from the document.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!activeId || !listRef.current) return;
    listRef.current
      .querySelector(`[data-thread-id="${activeId}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeId]);

  return (
    <div className="bg-white rounded-xl border border-sand/40 shadow-sm flex flex-col">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-sand/30">
        <MessageSquareText size={16} className="text-copper shrink-0" />
        <span className="font-bold text-sm text-charcoal flex-1">
          {t('doc.comments.title')}
          {open.length > 0 && <span className="ms-1.5 text-xs text-charcoal/50">({open.length})</span>}
        </span>
        {resolved.length > 0 && (
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className="text-[0.6875rem] font-bold text-charcoal/50 hover:text-charcoal px-1.5 py-0.5 rounded hover:bg-cream"
          >
            {showResolved ? t('doc.comments.hide_resolved') : t('doc.comments.show_resolved', { count: resolved.length })}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded-md text-charcoal/40 hover:text-charcoal hover:bg-cream"
          aria-label={t('common.close')}
        >
          <X size={14} />
        </button>
      </div>

      <div ref={listRef} className="overflow-y-auto p-2 space-y-2 max-h-[70vh]">
        {pending && (
          <PendingComposer pending={pending} onSubmit={onSubmitPending} onCancel={onCancelPending} />
        )}

        {open.length === 0 && !pending && (
          <div className="text-center text-xs text-charcoal/40 py-8 px-3 leading-relaxed">
            {canComment ? t('doc.comments.empty_hint') : t('doc.comments.empty')}
          </div>
        )}

        {open.map((th) => (
          <ThreadCard
            key={th.root.id}
            thread={th}
            orphaned={!anchorPositions.has(th.root.id)}
            active={activeId === th.root.id}
            onActivate={onActivate}
            userName={userName}
            fmtTime={fmtTime}
            currentUserId={currentUserId}
            onReply={onReply}
            onSetResolved={onSetResolved}
            onAskDelete={(comment, isRoot) => setConfirmDelete({ comment, isRoot })}
          />
        ))}

        {showResolved && resolved.length > 0 && (
          <>
            <div className="text-[0.6875rem] font-bold text-charcoal/40 px-1 pt-2">
              {t('doc.comments.resolved_section')}
            </div>
            {resolved.map((th) => (
              <ThreadCard
                key={th.root.id}
                thread={th}
                orphaned={!anchorPositions.has(th.root.id)}
                active={activeId === th.root.id}
                onActivate={onActivate}
                userName={userName}
                fmtTime={fmtTime}
                currentUserId={currentUserId}
                onReply={onReply}
                onSetResolved={onSetResolved}
                onAskDelete={(comment, isRoot) => setConfirmDelete({ comment, isRoot })}
              />
            ))}
          </>
        )}
      </div>

      <ConfirmModal
        open={!!confirmDelete}
        title={t(confirmDelete?.isRoot ? 'doc.comments.delete_thread_title' : 'doc.comments.delete_title')}
        message={t(confirmDelete?.isRoot ? 'doc.comments.delete_thread_msg' : 'doc.comments.delete_msg')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        busy={deleting}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (!confirmDelete) return;
          setDeleting(true);
          void onDelete(confirmDelete.comment, confirmDelete.isRoot).finally(() => {
            setDeleting(false);
            setConfirmDelete(null);
          });
        }}
      />
    </div>
  );
}

// ─── Pending (new comment) composer ───────────────────────────────────────────

function PendingComposer({
  pending,
  onSubmit,
  onCancel,
}: {
  pending: PendingAnchor;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = body.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    void onSubmit(trimmed).finally(() => setBusy(false));
  };

  return (
    <div className="rounded-lg border-2 border-copper/60 bg-cream/40 p-2.5 space-y-2">
      {pending.text && (
        <div className="text-[0.6875rem] text-charcoal/60 border-s-2 border-gold ps-2 line-clamp-2" dir="auto">
          {pending.text}
        </div>
      )}
      <textarea
        ref={taRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
          if (e.key === 'Escape') onCancel();
        }}
        rows={2}
        dir="auto"
        placeholder={t('doc.comments.placeholder')}
        className="w-full text-sm rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 focus:border-copper focus:outline-none resize-y"
      />
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="px-2.5 py-1 rounded-lg text-xs font-bold text-charcoal/60 hover:bg-cream"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!body.trim() || busy}
          className="px-3 py-1 rounded-lg text-xs font-bold bg-copper text-white hover:bg-terracotta disabled:opacity-50"
        >
          {t('doc.comments.submit')}
        </button>
      </div>
    </div>
  );
}

// ─── One thread ───────────────────────────────────────────────────────────────

function ThreadCard({
  thread,
  orphaned,
  active,
  onActivate,
  userName,
  fmtTime,
  currentUserId,
  onReply,
  onSetResolved,
  onAskDelete,
}: {
  thread: CommentThread;
  orphaned: boolean;
  active: boolean;
  onActivate: (id: string | null) => void;
  userName: (id: string) => string;
  fmtTime: (iso: string) => string;
  currentUserId: string | null;
  onReply: (rootId: string, body: string) => Promise<void>;
  onSetResolved: (rootId: string, resolved: boolean) => Promise<void>;
  onAskDelete: (comment: DocComment, isRoot: boolean) => void;
}) {
  const { t } = useTranslation();
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const root = thread.root;

  const sendReply = () => {
    const trimmed = reply.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    void onReply(root.id, trimmed)
      .then(() => setReply(''))
      .finally(() => setBusy(false));
  };

  return (
    <div
      data-thread-id={root.id}
      onClick={() => onActivate(root.id)}
      className={`rounded-lg border p-2.5 space-y-2 cursor-pointer transition-colors ${
        active ? 'border-copper bg-cream/50 shadow-sm' : 'border-sand/40 bg-white hover:border-sand'
      } ${root.resolved ? 'opacity-70' : ''}`}
    >
      {/* Anchor snippet / orphan notice. */}
      {orphaned ? (
        <div className="text-[0.6875rem] text-charcoal/40 italic border-s-2 border-sand ps-2">
          {t('doc.comments.orphaned')}
          {root.anchor_text && (
            <span className="line-through ms-1" dir="auto">
              {root.anchor_text}
            </span>
          )}
        </div>
      ) : (
        root.anchor_text && (
          <div className="text-[0.6875rem] text-charcoal/60 border-s-2 border-gold ps-2 line-clamp-2" dir="auto">
            {root.anchor_text}
          </div>
        )
      )}

      <CommentRow
        comment={root}
        name={userName(root.author_id)}
        time={fmtTime(root.created_at)}
        canDelete={root.author_id === currentUserId}
        onDelete={() => onAskDelete(root, true)}
      />

      {thread.replies.map((r) => (
        <div key={r.id} className="ms-3 ps-2 border-s border-sand/40">
          <CommentRow
            comment={r}
            name={userName(r.author_id)}
            time={fmtTime(r.created_at)}
            canDelete={r.author_id === currentUserId}
            onDelete={() => onAskDelete(r, false)}
          />
        </div>
      ))}

      {/* Reply + resolve row. Stop propagation so typing doesn't re-activate. */}
      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <input
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') sendReply();
          }}
          dir="auto"
          placeholder={t('doc.comments.reply_placeholder')}
          className="flex-1 min-w-0 text-xs rounded-lg border border-sand/50 bg-white px-2 py-1.5 focus:border-copper focus:outline-none"
        />
        {reply.trim() ? (
          <IconBtn
            icon={CornerDownLeft}
            label={t('doc.comments.reply')}
            onClick={sendReply}
            disabled={busy}
          />
        ) : root.resolved ? (
          <IconBtn
            icon={RotateCcw}
            label={t('doc.comments.reopen')}
            onClick={() => void onSetResolved(root.id, false)}
          />
        ) : (
          <IconBtn icon={Check} label={t('doc.comments.resolve')} onClick={() => void onSetResolved(root.id, true)} />
        )}
      </div>
    </div>
  );
}

function CommentRow({
  comment,
  name,
  time,
  canDelete,
  onDelete,
}: {
  comment: DocComment;
  name: string;
  time: string;
  canDelete: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="group/comment">
      <div className="flex items-baseline gap-1.5">
        <span className="text-xs font-bold text-charcoal truncate">{name}</span>
        <span className="text-[0.625rem] text-charcoal/40 shrink-0">{time}</span>
        {canDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="ms-auto opacity-0 group-hover/comment:opacity-100 p-0.5 rounded text-charcoal/40 hover:text-red-600 transition-opacity shrink-0"
            aria-label="delete"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      <div className="text-sm text-charcoal/90 whitespace-pre-wrap break-words" dir="auto">
        {comment.body}
      </div>
    </div>
  );
}

function IconBtn({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof Undo2;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="p-1.5 rounded-lg text-charcoal/50 hover:text-copper hover:bg-cream disabled:opacity-40 shrink-0"
    >
      <Icon size={14} />
    </button>
  );
}
