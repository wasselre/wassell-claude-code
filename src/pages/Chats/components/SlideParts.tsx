import type { ReactNode } from 'react';
import { Check, Info, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Button from '@/components/ui/Button';
import { num } from '@/pages/Marketing/lib/format';

/**
 * The shared frame of a «تفضيلات العميل» slide: a capped, scrolling item area
 * and a footer with «احفظ المحدد (n)», «تجاهل», and an ⓘ whose tooltip carries
 * the save rule (fill-empty-only / union) instead of a sentence per section.
 */

export function SlideBody({ top, children, bottom, footer }: {
  /** Small notes above the tiles (e.g. «تحتاج تأكيد العميل»). */
  top?: ReactNode;
  children: ReactNode;
  /** A muted line under the tiles (e.g. the places the reader may have missed). */
  bottom?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex max-h-[260px] flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pe-0.5">
        {top}
        {children}
        {bottom}
      </div>
      <div className="shrink-0 pt-1.5">{footer}</div>
    </div>
  );
}

export function SlideFooter({ tickedCount, saving, saveDisabled, onSave, onDismiss, info, note, extra, isAr }: {
  tickedCount: number;
  saving: boolean;
  /** Extra reason the save is off (e.g. the client already has places). */
  saveDisabled?: boolean;
  onSave: () => void;
  onDismiss: () => void;
  /** The save rule — shown as the ⓘ tooltip. */
  info: string;
  /** A short amber note beside the buttons (e.g. why save is off). */
  note?: ReactNode;
  /** Trailing controls (e.g. the map toggle). */
  extra?: ReactNode;
  isAr: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <Button
        className="!px-3 !py-1 !text-[11px] !rounded-full !gap-1"
        onClick={onSave}
        disabled={saving || !!saveDisabled || tickedCount === 0}
      >
        {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
        {t('chats.prefs.save_count', { n: num(tickedCount, isAr) })}
      </Button>
      <Button variant="ghost" className="!px-3 !py-1 !text-[11px] !rounded-full" onClick={onDismiss} disabled={saving}>
        {t('chats.prefs.dismiss')}
      </Button>
      <span className="inline-flex text-charcoal/40 hover:text-copper cursor-help" title={info} aria-label={info} role="img">
        <Info size={13} />
      </span>
      {note}
      {extra && <div className="ms-auto flex items-center gap-1">{extra}</div>}
    </div>
  );
}

/** A slide the rep just saved or dismissed — compact, until the card is re-read. */
export function SlideDoneView({ action, detail }: { action: 'saved' | 'dismissed'; detail?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[48px] flex-col items-center justify-center gap-0.5 py-2 text-center">
      <p className={`text-[12px] font-bold ${action === 'saved' ? 'text-green-700' : 'text-charcoal/60'}`}>
        {action === 'saved' ? t('chats.prefs.done_saved') : t('chats.prefs.done_dismissed')}
      </p>
      {detail}
    </div>
  );
}
