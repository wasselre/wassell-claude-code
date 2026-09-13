/**
 * Auto Meta ad — the approval-side UI (2026-09-10).
 *
 * When the step being approved carries `auto_meta_ad`, the manager's «اعتماد»
 * does more than move the item: the caption is written by AI and the ad is
 * created in the campaign's Meta ad set. So the dialog says EXACTLY what will
 * happen before the tap — which campaign, which ad set — and, when the
 * campaign has several linked ad sets, asks which one. A creative that cannot
 * get an ad (no paid campaign, campaign never pushed to Meta) says so and the
 * approval simply continues the normal path.
 *
 * Two surfaces share the same hook + panel: the desktop modal here, and the
 * phone approval sheet (ApprovalSheet.tsx) which embeds the panel.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import {
  adSetRequiredChoices, completeTask, fetchAutoAdPreview,
  type AutoAdChoice, type AutoAdOutcome, type AutoAdPreview, type MosStep, type MosTask,
} from '@/lib/marketingOS/client';
import { Modal } from './kit';

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
    setPreview({ kind: 'choose', choices });
    setAdSetId(null);
  }, []);

  return { preview, loading, error, adSetId, setAdSetId, offerChoices };
}

/** The toast after an auto-ad approval — says what actually happened. */
export function autoAdOutcomeText(outcome: AutoAdOutcome | null | undefined, isAr: boolean): string | null {
  if (!outcome) return null;
  if (outcome.status === 'queued') {
    return isAr
      ? `اعتُمد — الذكاء الاصطناعي يكتب الكابشن الآن؛ ستعتمده من تبويب «الأماكن» ثم يُنشأ الإعلان في «${outcome.ad_set_name}»${outcome.finished ? '. اكتمل مسار المحتوى.' : '.'}`
      : `Approved — AI is writing the caption; approve it on the Placements tab and the ad is created in “${outcome.ad_set_name}”${outcome.finished ? '. The content path is complete.' : '.'}`;
  }
  return isAr ? `اعتُمد — ${outcome.text_ar}` : `Approved — ${outcome.text_en}`;
}

/** What the approval will do on Meta — the same block on desktop and phone. */
export function AutoAdPanel({ state, isAr, compact }: { state: AutoAdPreviewState; isAr: boolean; compact?: boolean }) {
  const { preview, loading, error, adSetId, setAdSetId } = state;
  const box: React.CSSProperties = {
    border: '1px solid var(--line-soft)', borderRadius: 10, padding: compact ? '10px 12px' : 12,
    marginTop: 10, fontSize: 13, lineHeight: 1.8,
  };
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
          {isAr ? 'عند الاعتماد يُكتب كابشن الإعلان لاعتمادك، ثم يُنشأ في' : 'On approval the ad caption is written for your approval, then the ad is created in'}
        </div>
        <div><b>{t.campaign_name ?? (isAr ? 'الحملة' : 'Campaign')}</b> ← {t.ad_set_name}</div>
        <div style={{ color: 'var(--mute)', fontSize: 12 }}>
          {isAr
            ? 'الذكاء الاصطناعي يكتب الكابشن من معلومات المشروع ويرسله لك في تبويب «الأماكن»؛ بعد اعتمادك يُرفع التصميم المربّع لفيد إنستقرام والطولي للستوري والريلز وحالة واتساب، بلا تحسينات ميتا ولا إعلانات متعددة المعلنين.'
            : 'AI writes the caption from the project facts and sends it to you on the Placements tab; after your approval the square design goes to the Instagram feed and the vertical one to stories, reels and WhatsApp status — no Meta enhancements, no multi-advertiser ads.'}
        </div>
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
    </div>
  );
}

/** The desktop approval dialog for an auto-ad step. */
export default function AutoAdApproveModal({
  contentId, openTask, reviewedStep, isAr, onClose, onDone,
}: {
  contentId: string;
  openTask: MosTask;
  reviewedStep: MosStep | null;
  isAr: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const state = useAutoAdPreview(contentId, true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const thing = reviewedStep ? (isAr ? reviewedStep.label_ar : reviewedStep.label_en) : (isAr ? 'هذه الخطوة' : 'this stage');
  const needsPick = state.preview?.kind === 'choose' && !state.adSetId;

  const approve = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await completeTask(openTask.id, 'approved', note.trim() || undefined, undefined, { adSetId: state.adSetId });
      addToast(
        autoAdOutcomeText(res.auto_ad, isAr)
          ?? (isAr ? 'اعتُمد — انتقل إلى الخطوة التالية.' : 'Approved — it moved to the next stage.'),
        res.auto_ad?.status === 'skipped' ? 'info' : 'success',
      );
      onDone();
    } catch (e) {
      const choices = adSetRequiredChoices(e);
      if (choices) {
        state.offerChoices(choices);
        addToast(isAr ? 'اختر المجموعة الإعلانية أولًا.' : 'Pick the ad set first.', 'error');
      } else {
        addToast(e instanceof Error ? e.message : String(e), 'error');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isAr ? `اعتماد ${thing}؟` : `Approve ${thing}?`}
      sub={isAr
        ? 'هذا الاعتماد هو الأخير على التصميم — بعده يبقى اعتماد واحد: كابشن الإعلان الذي يكتبه الذكاء الاصطناعي.'
        : 'This is the final approval of the design — one approval remains after it: the AI-written ad caption.'}
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button
            type="button"
            className="btn btn-go"
            onClick={() => void approve()}
            disabled={busy || state.loading || needsPick}
            title={needsPick ? (isAr ? 'اختر المجموعة الإعلانية' : 'Pick an ad set') : undefined}
          >
            {busy
              ? (isAr ? 'جارٍ…' : 'Working…')
              : state.preview?.kind === 'skip'
                ? (isAr ? 'اعتماد' : 'Approve')
                : (isAr ? 'اعتماد وكتابة الكابشن' : 'Approve & write the caption')}
          </button>
        </div>
      )}
    >
      <AutoAdPanel state={state} isAr={isAr} />
      <textarea
        className="inp"
        rows={2}
        style={{ marginTop: 12, fontSize: 13 }}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={isAr ? 'ملاحظة — اختياري' : 'Note — optional'}
      />
    </Modal>
  );
}
