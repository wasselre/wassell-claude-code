/**
 * Campaign status, as a machine rather than a dropdown of every value.
 *
 * `status` is not in the API's campaign save allow-list. It moves only through
 * campaign_transition, and the legal moves come from mkt_campaign_next_statuses()
 * — the same function the rejecting trigger consults. So this bar cannot offer a
 * move the database will refuse, and cannot hide one it would allow.
 *
 * Blocked transitions are shown DISABLED WITH THEIR REASON rather than hidden.
 * Hiding "Activate" from a campaign that is missing an owner tells the user
 * nothing; showing it greyed out with "missing: owner, deliverables" tells them
 * exactly what to go and do.
 */
import { useState } from 'react';
import { Lock, ArrowRight } from 'lucide-react';
import { lbl } from '@/lib/marketingMgmt/labels';
import { CAMPAIGN_STATUS_LABEL, CAMPAIGN_BLOCKER_LABEL } from '@/lib/marketingMgmt/v2';
import { transitionCampaign, type NextStatus } from '@/lib/marketingMgmt/client';
import { err } from './shared';

export function CampaignStatusBar({ campaignId, status, next, isAr, onChanged, onError, onToast }: {
  campaignId: string; status: string; next: NextStatus[]; isAr: boolean;
  onChanged: () => void; onError: (m: string) => void; onToast: (m: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const go = async (to: string) => {
    setBusy(to);
    try {
      await transitionCampaign(campaignId, to);
      onToast(isAr ? 'تم تحديث حالة الحملة' : 'Campaign status updated');
      onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(null); }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center rounded-full border border-copper/30 bg-copper/10 px-2.5 py-1 text-[11.5px] font-semibold text-copper-500">
        {lbl(CAMPAIGN_STATUS_LABEL, status, isAr)}
      </span>

      {next.length === 0 ? (
        <span className="inline-flex items-center gap-1 text-[11.5px] text-charcoal/40">
          <Lock className="h-3.5 w-3.5" />
          {isAr ? 'حالة نهائية — لا انتقالات متاحة' : 'Terminal — no further transitions'}
        </span>
      ) : next.map((n) => {
        const reason = n.blockers.map((b) => lbl(CAMPAIGN_BLOCKER_LABEL, b, isAr))
          .join(isAr ? '، ' : ', ');
        return (
          <span key={n.status} className="inline-flex flex-col">
            <button type="button" disabled={!n.allowed || busy !== null}
              onClick={() => void go(n.status)}
              title={n.allowed ? undefined
                : (isAr ? `ناقص: ${reason}` : `Missing: ${reason}`)}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition ${
                n.allowed
                  ? 'border-sand/60 bg-white text-charcoal/70 hover:border-copper hover:text-copper'
                  : 'cursor-not-allowed border-sand/40 bg-cream-light text-charcoal/30'}`}>
              <ArrowRight className={`h-3 w-3 ${isAr ? 'rotate-180' : ''}`} />
              {lbl(CAMPAIGN_STATUS_LABEL, n.status, isAr)}
            </button>
            {!n.allowed && n.blockers.length > 0 && (
              <span className="mt-0.5 max-w-[16rem] text-[10px] leading-snug text-amber-700">
                {isAr ? `ناقص: ${reason}` : `Missing: ${reason}`}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
