/**
 * «كابشن الإعلان — بانتظار اعتمادك» (2026-09-13).
 *
 * The AI-written Meta ad caption parked on a paid placement
 * (`creative.auto_ad.state === 'caption_review'`). The manager reads it,
 * edits it in place if needed, and either APPROVES it (→ the worker builds the
 * ad on Meta with the text exactly as shown) or asks for a REWRITE (→ a fresh
 * AI caption comes back for approval). This is the body of the «مهامي» caption
 * task, rendered inside the review popup (ContentPreviewModal) — the same
 * card the Placements tab shows, so the two surfaces never disagree.
 */
import { useEffect, useState } from 'react';
import {
  PLATFORM_LABELS, type PaidPlacement, adSetRequiredChoices, approveAutoAdCaption, retryAutoAd,
} from '@/lib/marketingOS/client';

export default function CaptionReviewCard({
  contentId, placement, canAct, isAr, onChanged, addToast,
}: {
  contentId: string;
  placement: PaidPlacement;
  /** manage_paid_ads — without it the caption is shown read-only. */
  canAct: boolean;
  isAr: boolean;
  onChanged: (placements: PaidPlacement[]) => void;
  addToast: (msg: string, kind: 'success' | 'error') => void;
}) {
  const [text, setText] = useState(placement.creative?.primary_text ?? '');
  const [busy, setBusy] = useState<'approve' | 'rewrite' | null>(null);
  useEffect(() => { setText(placement.creative?.primary_text ?? ''); }, [placement]);
  const auto = placement.creative?.auto_ad ?? null;
  const platform = PLATFORM_LABELS[placement.execution.platform];

  const approve = async (): Promise<void> => {
    if (!text.trim()) { addToast(isAr ? 'الكابشن فارغ.' : 'The caption is empty.', 'error'); return; }
    setBusy('approve');
    try {
      const res = await approveAutoAdCaption(contentId, placement.id, text);
      onChanged(res.placements);
      addToast(isAr ? 'اعتُمد الكابشن — جارٍ إنشاء الإعلان في ميتا.' : 'Caption approved — creating the ad in Meta.', 'success');
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(null); }
  };

  const rewrite = async (): Promise<void> => {
    setBusy('rewrite');
    try {
      const res = await retryAutoAd(contentId, placement.ad_set_id);
      onChanged(res.placements);
      addToast(isAr ? 'جارٍ كتابة كابشن جديد — سيعود إليك للاعتماد.' : 'Writing a fresh caption — it will come back for your approval.', 'success');
    } catch (e) {
      addToast(adSetRequiredChoices(e)
        ? (isAr ? 'الحملة تحتوي أكثر من مجموعة إعلانية — أعد الكتابة من صفحة المحتوى.' : 'Several ad sets — rewrite from the content page.')
        : e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(null); }
  };

  return (
    <div className="card" style={{ borderColor: 'var(--copper)' }}>
      <div className="card-h">
        <h4>{isAr ? '✍️ كابشن الإعلان — بانتظار اعتمادك' : '✍️ Ad caption — awaiting your approval'}</h4>
        <span className="r" style={{ fontSize: 12, color: 'var(--mute)' }}>
          {platform ? (isAr ? platform.ar : platform.en) : placement.execution.platform}
          {placement.execution.campaign_name ? ` · ${placement.execution.campaign_name}` : ''}
          {placement.ad_set_name ? ` · ${placement.ad_set_name}` : ''}
        </span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 10 }}>
        <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.8 }}>
          {isAr
            ? 'كتبه الذكاء الاصطناعي من معلومات المشروع. عدّله إن لزم، ثم اعتمده ليُنشأ الإعلان في ميتا بالنص كما تراه.'
            : 'Written by AI from the project facts. Edit if needed, then approve — the Meta ad is created with the text exactly as shown.'}
          {auto?.caption_source === 'fallback' ? (isAr ? ' (من القالب — تعذّر الذكاء الاصطناعي)' : ' (template — AI unavailable)') : ''}
        </div>
        {canAct ? (
          <textarea
            className="inp"
            rows={12}
            dir="auto"
            style={{ fontSize: 13.5, lineHeight: 1.9, whiteSpace: 'pre-wrap' }}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.9 }}>{text || '—'}</div>
        )}
        {canAct && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-sm" onClick={() => void rewrite()} disabled={busy !== null}>
              {busy === 'rewrite' ? '…' : (isAr ? 'إعادة الكتابة' : 'Rewrite')}
            </button>
            <button type="button" className="btn btn-go btn-sm" onClick={() => void approve()} disabled={busy !== null || !text.trim()}>
              {busy === 'approve' ? '…' : (isAr ? 'اعتماد الكابشن وإنشاء الإعلان' : 'Approve caption & create ad')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
