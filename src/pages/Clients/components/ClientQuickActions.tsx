import { useNavigate } from 'react-router-dom';
import { Phone, ExternalLink, ListChecks, MessageCircle, User as UserIcon } from 'lucide-react';
import { waMeUrl, telUrl } from '../lib/phoneLinks';

interface QuickActionsProps {
  clientId: string;
  phone: string | null;
  nextFollowupId: string | null;
  /** Compact icon-only buttons (list rows) vs labeled buttons (detail header). */
  variant?: 'row' | 'header';
  /** Detail header passes these to jump to the in-app tab instead of leaving. */
  onWhatsApp?: () => void;
  /** Where "Open next follow-up" should return to after completion. */
  returnTo?: string;
  /** Hide the "Open Client" button (already on the client page). */
  hideOpenClient?: boolean;
}

/**
 * Shared quick actions. On the list (`row`) WhatsApp opens wa.me in a new tab
 * and the open-client button navigates to the cockpit. On the detail header,
 * `onWhatsApp` switches to the in-app WhatsApp tab so the existing panel (and
 * its realtime behavior) is reused rather than duplicated.
 */
export default function ClientQuickActions({
  clientId,
  phone,
  nextFollowupId,
  variant = 'row',
  onWhatsApp,
  returnTo,
  hideOpenClient,
}: QuickActionsProps) {
  const navigate = useNavigate();
  const isHeader = variant === 'header';
  const wa = waMeUrl(phone);
  const tel = telUrl(phone);

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
          title="Open client"
          aria-label="Open client"
          onClick={() => navigate(`/model/clients/${clientId}`)}
          className={`${btn} ${isHeader ? 'bg-copper text-white hover:bg-terracotta' : 'text-copper hover:bg-copper/10'}`}
        >
          <UserIcon size={16} />
          {isHeader && <span>Open</span>}
        </button>
      )}

      <button
        type="button"
        title="Open next follow-up"
        aria-label="Open next follow-up"
        disabled={!nextFollowupId}
        onClick={openNextFollowup}
        className={`${btn} ${isHeader ? 'bg-chocolate text-white hover:opacity-90' : 'text-chocolate hover:bg-chocolate/10'}`}
      >
        <ListChecks size={16} />
        {isHeader && <span>Next follow-up</span>}
      </button>

      {onWhatsApp ? (
        <button
          type="button"
          title="WhatsApp"
          aria-label="WhatsApp"
          disabled={!phone}
          onClick={onWhatsApp}
          className={`${btn} ${isHeader ? 'bg-[#25D366]/15 text-[#128C7E] hover:bg-[#25D366]/25' : 'text-[#128C7E] hover:bg-[#25D366]/15'}`}
        >
          <MessageCircle size={16} />
          {isHeader && <span>WhatsApp</span>}
        </button>
      ) : (
        <a
          href={wa ?? undefined}
          target="_blank"
          rel="noreferrer"
          title="WhatsApp"
          aria-label="WhatsApp"
          aria-disabled={!wa}
          onClick={(e) => {
            e.stopPropagation();
            if (!wa) e.preventDefault();
          }}
          className={`${btn} ${isHeader ? 'bg-[#25D366]/15 text-[#128C7E] hover:bg-[#25D366]/25' : 'text-[#128C7E] hover:bg-[#25D366]/15'} ${!wa ? 'pointer-events-none opacity-30' : ''}`}
        >
          <MessageCircle size={16} />
          {isHeader && <span>WhatsApp</span>}
        </a>
      )}

      <a
        href={tel ?? undefined}
        title="Call"
        aria-label="Call"
        aria-disabled={!tel}
        onClick={(e) => {
          e.stopPropagation();
          if (!tel) e.preventDefault();
        }}
        className={`${btn} ${isHeader ? 'bg-charcoal/10 text-charcoal hover:bg-charcoal/20' : 'text-charcoal/70 hover:bg-charcoal/10'} ${!tel ? 'pointer-events-none opacity-30' : ''}`}
      >
        <Phone size={16} />
        {isHeader && <span>Call</span>}
      </a>

      {isHeader && wa && (
        <a
          href={wa}
          target="_blank"
          rel="noreferrer"
          title="Open WhatsApp Web"
          aria-label="Open WhatsApp Web"
          onClick={(e) => e.stopPropagation()}
          className={`${btn} bg-charcoal/5 text-charcoal/60 hover:bg-charcoal/10`}
        >
          <ExternalLink size={16} />
        </a>
      )}
    </div>
  );
}
