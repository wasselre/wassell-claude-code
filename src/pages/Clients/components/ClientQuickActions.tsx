import { useNavigate } from 'react-router-dom';
import { Phone, ListChecks, MessageCircle, User as UserIcon, Calculator } from 'lucide-react';
import { telUrl } from '../lib/phoneLinks';
import { useCanAccessPage } from '@/hooks/usePermission';

interface QuickActionsProps {
  clientId: string;
  phone: string | null;
  nextFollowupId: string | null;
  isAr: boolean;
  /** Compact icon-only buttons (list rows) vs labeled buttons (detail header). */
  variant?: 'row' | 'header';
  /**
   * WhatsApp handler. When supplied (detail header AND list rows), clicking
   * WhatsApp opens the in-app chat popup (existing conversation thread, or the
   * new-chat composer) — the SAME flow the Follow-up Workspace uses. The page
   * owns the modal state so the existing chat components are reused, not
   * duplicated.
   */
  onWhatsApp?: () => void;
  /** Where "Open next follow-up" should return to after completion. */
  returnTo?: string;
  /** Hide the "Open Client" button (already on the client page). */
  hideOpenClient?: boolean;
}

const L = {
  open: { ar: 'فتح', en: 'Open' },
  nextFollowup: { ar: 'المتابعة التالية', en: 'Next follow-up' },
  whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
  call: { ar: 'اتصال', en: 'Call' },
  financing: { ar: 'حاسبة التمويل', en: 'Financing' },
} as const;

/**
 * Shared quick actions for the Clients list rows and the Client 360 header.
 * Labels/tooltips are bilingual. WhatsApp + Call resolve in-app: WhatsApp opens
 * the chat popup via `onWhatsApp`; Call uses a tel: link.
 */
export default function ClientQuickActions({
  clientId,
  phone,
  nextFollowupId,
  isAr,
  variant = 'row',
  onWhatsApp,
  returnTo,
  hideOpenClient,
}: QuickActionsProps) {
  const navigate = useNavigate();
  const isHeader = variant === 'header';
  const tel = telUrl(phone);
  const t = (k: keyof typeof L) => (isAr ? L[k].ar : L[k].en);
  // The financing action only appears for profiles granted the calculator page —
  // it reads salary and debt data, so it is not a universal quick action.
  const canFinance = useCanAccessPage('financing_calculator');

  const btn = isHeader
    ? 'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-bold transition disabled:opacity-40 disabled:cursor-not-allowed'
    : 'inline-flex items-center justify-center rounded-lg p-2 transition disabled:opacity-30 disabled:cursor-not-allowed';

  const openNextFollowup = () => {
    if (!nextFollowupId) return;
    const qs = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : '';
    navigate(`/model/followups/${nextFollowupId}${qs}`);
  };

  return (
    <div className={`flex items-center ${isHeader ? 'flex-wrap gap-2' : 'gap-1'}`} onClick={(e) => e.stopPropagation()}>
      {!hideOpenClient && (
        <button
          type="button"
          title={t('open')}
          aria-label={t('open')}
          onClick={() => navigate(`/model/clients/${clientId}`)}
          className={`${btn} ${isHeader ? 'bg-copper text-white hover:bg-terracotta' : 'text-copper hover:bg-copper/10'}`}
        >
          <UserIcon size={16} />
          {isHeader && <span>{t('open')}</span>}
        </button>
      )}

      <button
        type="button"
        title={t('nextFollowup')}
        aria-label={t('nextFollowup')}
        disabled={!nextFollowupId}
        onClick={openNextFollowup}
        className={`${btn} ${isHeader ? 'bg-chocolate text-white hover:opacity-90' : 'text-chocolate hover:bg-chocolate/10'}`}
      >
        <ListChecks size={16} />
        {isHeader && <span>{t('nextFollowup')}</span>}
      </button>

      <button
        type="button"
        title={t('whatsapp')}
        aria-label={t('whatsapp')}
        disabled={!phone || !onWhatsApp}
        onClick={() => onWhatsApp?.()}
        className={`${btn} ${isHeader ? 'bg-[#25D366]/15 text-[#128C7E] hover:bg-[#25D366]/25' : 'text-[#128C7E] hover:bg-[#25D366]/15'}`}
      >
        <MessageCircle size={16} />
        {isHeader && <span>{t('whatsapp')}</span>}
      </button>

      {canFinance && (
        <button
          type="button"
          title={t('financing')}
          aria-label={t('financing')}
          onClick={() => navigate(`/financing?client=${clientId}`)}
          className={`${btn} ${isHeader ? 'bg-copper/15 text-copper hover:bg-copper/25' : 'text-copper hover:bg-copper/10'}`}
        >
          <Calculator size={16} />
          {isHeader && <span>{t('financing')}</span>}
        </button>
      )}

      <a
        href={tel ?? undefined}
        title={t('call')}
        aria-label={t('call')}
        aria-disabled={!tel}
        onClick={(e) => {
          e.stopPropagation();
          if (!tel) e.preventDefault();
        }}
        className={`${btn} ${isHeader ? 'bg-charcoal/10 text-charcoal hover:bg-charcoal/20' : 'text-charcoal/70 hover:bg-charcoal/10'} ${!tel ? 'pointer-events-none opacity-30' : ''}`}
      >
        <Phone size={16} />
        {isHeader && <span>{t('call')}</span>}
      </a>
    </div>
  );
}
