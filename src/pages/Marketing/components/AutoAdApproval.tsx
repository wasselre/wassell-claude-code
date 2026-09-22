/**
 * Auto Meta ad — the approval-side UI (2026-09-10; one-step since 2026-09-22).
 *
 * When the step being approved carries `auto_meta_ad`, the manager's «اعتماد»
 * does more than move the item: the ad is created in the campaign's Meta ad
 * set, with the caption the WRITER confirmed (D4 — there is no AI caption and
 * no caption approval after this tap; the approval itself refuses until the
 * caption is confirmed). So the panel says EXACTLY what will happen before the
 * tap — which campaign, which ad set, which caption — and, when the campaign
 * has several linked ad sets, asks which one. A creative that cannot get an ad
 * (no paid campaign, campaign never pushed to Meta) says so and the approval
 * simply continues the normal path.
 *
 * Three surfaces share the same hook + panel: the phone approval sheet
 * (ApprovalSheet.tsx), the review popup (ContentPreviewModal.tsx) and the row
 * approval (RowApproval.tsx).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  fetchAutoAdPreview,
  type AutoAdCaption, type AutoAdChoice, type AutoAdOutcome, type AutoAdPreview,
} from '@/lib/marketingOS/client';

export interface AutoAdPreviewState {
  preview: AutoAdPreview | null;
  loading: boolean;
  error: string | null;
  adSetId: string | null;
  setAdSetId: (id: string | null) => void;
  /** Force the picker open with these choices (after a 409 from the server). */
  offerChoices: (choices: AutoAdChoice[]) => void;
}

/** Loads what approving `contentId` would do on Meta. Inert when `enabled` is false. */
export function useAutoAdPreview(contentId: string, enabled: boolean): AutoAdPreviewState {
  const [preview, setPreview] = useState<AutoAdPreview | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [adSetId, setAdSetId] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) { setPreview(null); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    setError(null);
    fetchAutoAdPreview(contentId)
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        if (p.kind === 'target') setAdSetId(p.target.ad_set_id);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // The manager must still be able to approve; the failure is shown, not hidden.
        console.error('[marketing] auto-ad preview unavailable', e);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [contentId, enabled]);

  const offerChoices = useCallback((choices: AutoAdChoice[]) => {
    // The caption does not change with the ad set; keep what the preview said.
    setPreview((prev) => ({
      kind: 'choose', choices, caption: prev && prev.kind !== 'skip' ? prev.caption : undefined,
    }));
    setAdSetId(null);
  }, []);

  return { preview, loading, error, adSetId, setAdSetId, offerChoices };
}

/** The toast after an auto-ad approval — says what actually happened. */
export function autoAdOutcomeText(outcome: AutoAdOutcome | null | undefined, isAr: boolean): string | null {
  if (!outcome) return null;
  if (outcome.status === 'queued') {
    return isAr
      ? `اعتُمد — يُنشأ الإعلان الآن بالكابشن المثبّت في «${outcome.ad_set_name}»${outcome.finished ? '. اكتمل مسار المحتوى.' : '.'}`
      : `Approved — the ad is being created with the confirmed caption in “${outcome.ad_set_name}”${outcome.finished ? '. The content path is complete.' : '.'}`;
  }
  return isAr ? `اعتُمد — ${outcome.text_ar}` : `Approved — ${outcome.text_en}`;
}

/** At most this many characters of the caption are shown in the panel. */
const CAPTION_PREVIEW_CHARS = 220;

/**
 * The caption line of the panel: what the ad will carry, or that nothing is
 * confirmed yet. `undefined` (an older server answer without the field) shows
 * nothing rather than guessing.
 */
function CaptionLine({ caption, isAr }: { caption: AutoAdCaption | undefined; isAr: boolean }) {
  if (!caption) return null;
  if (!caption.confirmed || !caption.text) {
    return (
      <div style={{ color: 'var(--late)', fontSize: 12, marginTop: 6 }}>
        {isAr
          ? 'الكاتب لم يثبّت الكابشن بعد — لا يُطلق إعلان بلا كابشن مثبّت، والاعتماد يُرفض حتى يثبّته.'
          : 'The writer has not confirmed the caption yet — no ad launches without a confirmed caption, and the approval is refused until it is.'}
      </div>
    );
  }
  const text = caption.text.length > CAPTION_PREVIEW_CHARS
    ? `${caption.text.slice(0, CAPTION_PREVIEW_CHARS)}…`
    : caption.text;
  return (
    <div style={{ marginTop: 6 }}>
      <div className="k" style={{ fontSize: 11.5 }}>{isAr ? 'الكابشن المثبّت من الكاتب' : 'The caption the writer confirmed'}</div>
      <div style={{ whiteSpace: 'pre-wrap', color: 'var(--ink-2)', fontSize: 12.5, lineHeight: 1.7 }}>{text}</div>
    </div>
  );
}

/** What the approval will do on Meta — the same block on every surface. */
export function AutoAdPanel({ state, isAr, compact }: { state: AutoAdPreviewState; isAr: boolean; compact?: boolean }) {
  const { preview, loading, error, adSetId, setAdSetId } = state;
  const box: React.CSSProperties = {
    border: '1px solid var(--line-soft)', borderRadius: 10, padding: compact ? '10px 12px' : 12,
    marginTop: 10, fontSize: 13, lineHeight: 1.8,
  };
  const placements = isAr
    ? 'يُرفع التصميم المربّع لفيد إنستقرام والطولي للستوري والريلز وحالة واتساب، بلا تحسينات ميتا ولا إعلانات متعددة المعلنين.'
    : 'The square design goes to the Instagram feed and the vertical one to stories, reels and WhatsApp status — no Meta enhancements, no multi-advertiser ads.';
  if (loading) {
    return <div style={box}>{isAr ? 'جارٍ التحقق من حملة الإعلان…' : 'Checking the ad campaign…'}</div>;
  }
  if (error) {
    return (
      <div style={{ ...box, borderColor: 'var(--late)' }}>
        {isAr ? 'تعذّر التحقق من الحملة — ' : 'Could not check the campaign — '}{error}
        <div style={{ color: 'var(--mute)', fontSize: 12 }}>
          {isAr ? 'يمكنك الاعتماد؛ سيُحاول إنشاء الإعلان تلقائيًا.' : 'You can still approve; the ad will be attempted automatically.'}
        </div>
      </div>
    );
  }
  if (!preview) return null;
  if (preview.kind === 'skip') {
    return (
      <div style={{ ...box, color: 'var(--ink-2)' }}>
        <div className="k" style={{ marginBottom: 4 }}>{isAr ? 'الإعلان في ميتا' : 'Meta ad'}</div>
        {isAr ? preview.text_ar : preview.text_en}
        <div style={{ color: 'var(--mute)', fontSize: 12 }}>
          {isAr ? 'سيتابع المحتوى مساره العادي (الجدولة ثم تأكيد النشر).' : 'The item continues its normal path (scheduling, then publish check).'}
        </div>
      </div>
    );
  }
  if (preview.kind === 'target') {
    const t = preview.target;
    return (
      <div style={{ ...box, borderColor: 'var(--copper)' }}>
        <div className="k" style={{ marginBottom: 4 }}>
          {isAr ? 'عند الاعتماد يُنشأ الإعلان مباشرة في' : 'On approval the ad is created right away in'}
        </div>
        <div><b>{t.campaign_name ?? (isAr ? 'الحملة' : 'Campaign')}</b> ← {t.ad_set_name}</div>
        <CaptionLine caption={preview.caption} isAr={isAr} />
        <div style={{ color: 'var(--mute)', fontSize: 12, marginTop: 6 }}>{placements}</div>
      </div>
    );
  }
  // choose
  return (
    <div style={{ ...box, borderColor: 'var(--copper)' }}>
      <div className="k" style={{ marginBottom: 6 }}>
        {isAr ? 'الحملة تحتوي أكثر من مجموعة إعلانية — أين يُنشأ الإعلان؟' : 'The campaign has several ad sets — where should the ad go?'}
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {preview.choices.map((c) => (
          <label key={c.ad_set_id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input
              type="radio"
              name="auto-ad-set"
              checked={adSetId === c.ad_set_id}
              onChange={() => setAdSetId(c.ad_set_id)}
              style={{ marginTop: 5 }}
            />
            <span>
              <b>{c.ad_set_name}</b>
              <span style={{ color: 'var(--mute)', fontSize: 12 }}>
                {' · '}{c.campaign_name ?? ''}{c.execution_label ? ` · ${c.execution_label}` : ''}
              </span>
            </span>
          </label>
        ))}
      </div>
      <CaptionLine caption={preview.caption} isAr={isAr} />
      <div style={{ color: 'var(--mute)', fontSize: 12, marginTop: 6 }}>{placements}</div>
    </div>
  );
}
