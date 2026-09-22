/**
 * «تعذّر إنشاء الإعلان في ميتا» (2026-09-22).
 *
 * A paid placement whose automatic Meta ad FAILED (`creative.auto_ad.state ===
 * 'failed'`): the reason, and one button — retry. The retry re-queues the ad
 * with the caption the WRITER confirmed on the creative; there is no caption
 * to read or edit here any more (decision D4: caption approval was retired —
 * the final approval launches the ad with the confirmed caption).
 *
 * Replaces CaptionReviewCard, which carried the retired AI-caption approval.
 */
import { useState } from 'react';
import {
  PLATFORM_LABELS, type PaidPlacement, MosApiError, adSetRequiredChoices, retryAutoAd,
} from '@/lib/marketingOS/client';

export default function AdFailedCard({
  contentId, placement, canAct, isAr, onChanged, addToast,
}: {
  contentId: string;
  placement: PaidPlacement;
  /** manage_paid_ads — without it the failure is shown read-only. */
  canAct: boolean;
  isAr: boolean;
  onChanged: (placements: PaidPlacement[]) => void;
  addToast: (msg: string, kind: 'success' | 'error') => void;
}) {
  const [busy, setBusy] = useState(false);
  const auto = placement.creative?.auto_ad ?? null;
  const platform = PLATFORM_LABELS[placement.execution.platform];

  const retry = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await retryAutoAd(contentId, placement.ad_set_id);
      onChanged(res.placements);
      addToast(isAr ? 'أُعيدت المحاولة — جارٍ إنشاء الإعلان في ميتا.' : 'Retrying — creating the ad in Meta.', 'success');
    } catch (e) {
      if (adSetRequiredChoices(e)) {
        addToast(isAr ? 'الحملة تحتوي أكثر من مجموعة إعلانية — أعد المحاولة من صفحة المحتوى.' : 'Several ad sets — retry from the content page.', 'error');
      } else if (e instanceof MosApiError && typeof e.payload.error_ar === 'string' && isAr) {
        addToast(e.payload.error_ar, 'error');
      } else {
        addToast(e instanceof Error ? e.message : String(e), 'error');
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ borderColor: 'var(--late)' }}>
      <div className="card-h">
        <h4>{isAr ? '⚠️ تعذّر إنشاء الإعلان في ميتا' : '⚠️ The Meta ad could not be created'}</h4>
        <span className="r" style={{ fontSize: 12, color: 'var(--mute)' }}>
          {platform ? (isAr ? platform.ar : platform.en) : placement.execution.platform}
          {placement.execution.campaign_name ? ` · ${placement.execution.campaign_name}` : ''}
          {placement.ad_set_name ? ` · ${placement.ad_set_name}` : ''}
        </span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 10 }}>
        <div className="notice" style={{ color: 'var(--late)', whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>
          {auto?.error ?? '—'}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.8 }}>
          {isAr
            ? 'عالج السبب أعلاه (مثلًا ارفع التصميمين من تبويب المواد) ثم أعد المحاولة — يُبنى الإعلان بالكابشن الذي ثبّته الكاتب.'
            : 'Fix the reason above (e.g. upload both designs on the Materials tab), then retry — the ad is built with the caption the writer confirmed.'}
        </div>
        {canAct && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-go btn-sm" onClick={() => void retry()} disabled={busy}>
              {busy ? '…' : (isAr ? 'إعادة المحاولة' : 'Retry')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
