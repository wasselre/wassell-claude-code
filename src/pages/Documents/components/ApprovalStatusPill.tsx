import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import type { DocApprovalStatus } from '@/types/files';

/**
 * Approval workflow pill for the document header. Shows the current status
 * in its stage color; clicking opens a transition menu. Stage rules (v1, UI
 * level): editors may move draft ↔ review; only the file OWNER may set
 * approved/published. Content edits auto-demote approved/published → draft
 * (handled by the page's save path, not here).
 */

const STATUS_ORDER: DocApprovalStatus[] = ['draft', 'review', 'approved', 'published'];

const STATUS_STYLE: Record<DocApprovalStatus, string> = {
  draft: 'bg-charcoal/10 text-charcoal/70',
  review: 'bg-amber-100 text-amber-700',
  approved: 'bg-emerald-100 text-emerald-700',
  published: 'bg-copper/15 text-copper',
};

interface Props {
  status: DocApprovalStatus;
  /** Current user can edit the doc (toolbar-level rights). */
  canEdit: boolean;
  /** Current user owns the file — required for approve/publish. */
  isOwner: boolean;
  busy?: boolean;
  onChange: (next: DocApprovalStatus) => void;
}

export default function ApprovalStatusPill({ status, canEdit, isOwner, busy, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const allowed = (next: DocApprovalStatus): boolean => {
    if (next === status) return false;
    if (!canEdit) return false;
    if (next === 'approved' || next === 'published') return isOwner;
    return true; // draft / review — any editor
  };

  const label = (s: DocApprovalStatus) => t(`doc.approval.${s}`);

  if (!canEdit) {
    // Read-only chip for viewers.
    return (
      <span className={`hidden sm:inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold ${STATUS_STYLE[status]}`}>
        {label(status)}
      </span>
    );
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold transition-colors ${STATUS_STYLE[status]} hover:brightness-95 disabled:opacity-60`}
        title={t('doc.approval.title')}
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : null}
        {label(status)}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute top-full mt-1 start-0 z-30 w-44 bg-white rounded-xl border border-sand/50 shadow-lg py-1">
          {STATUS_ORDER.map((s) => {
            const ok = allowed(s);
            const current = s === status;
            return (
              <button
                key={s}
                type="button"
                disabled={!ok && !current}
                onClick={() => {
                  setOpen(false);
                  if (ok) onChange(s);
                }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-start transition-colors ${
                  current
                    ? 'font-bold text-charcoal'
                    : ok
                    ? 'text-charcoal/70 hover:bg-cream'
                    : 'text-charcoal/30 cursor-not-allowed'
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${STATUS_STYLE[s].split(' ')[0]}`} />
                {label(s)}
                {current && <Check size={12} className="ms-auto text-copper" />}
                {!ok && !current && (s === 'approved' || s === 'published') && (
                  <span className="ms-auto text-[0.5625rem]">{t('doc.approval.owner_only')}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
