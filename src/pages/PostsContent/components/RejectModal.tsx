import { useState } from 'react';
import { X, Ban, RefreshCw } from 'lucide-react';
import Button from '@/components/ui/Button';
import type { RejectionInfo } from '../lib/persistence';

/**
 * Reasons mirror the `rejection_reason` dropdown options on the posts_content
 * model — keep the two in sync (migration 2026-07-26_posts_content_v2.sql).
 */
export const DEFAULT_REJECTION_REASON = 'incorrect_facts';

export const REJECTION_REASONS: Array<{ value: string; ar: string; en: string }> = [
  { value: 'incorrect_facts', ar: 'معلومات غير صحيحة', en: 'Incorrect facts' },
  { value: 'weak_headline', ar: 'عنوان ضعيف', en: 'Weak headline' },
  { value: 'repetitive', ar: 'تكرار في الصياغة', en: 'Repetitive wording' },
  { value: 'wrong_angle', ar: 'زاوية تسويقية خاطئة', en: 'Wrong marketing angle' },
  { value: 'too_formal', ar: 'رسمي أكثر من اللازم', en: 'Too formal' },
  { value: 'too_casual', ar: 'غير رسمي بما يكفي', en: 'Too casual' },
  { value: 'too_long', ar: 'طويل', en: 'Too long' },
  { value: 'too_short', ar: 'قصير', en: 'Too short' },
  { value: 'other', ar: 'أخرى', en: 'Other' },
];

interface Props {
  isAr: boolean;
  /** 'reject' stores the verdict; 'regenerate' rewrites using the feedback. */
  intent: 'reject' | 'regenerate';
  onClose: () => void;
  onConfirm: (info: RejectionInfo, alsoRegenerate: boolean) => void;
}

/**
 * Captures WHY a post was rejected. The reason + note are persisted on the
 * record AND fed back into the prompt on a rewrite, so the model is told what
 * to fix instead of rolling the dice again.
 */
export default function RejectModal({ isAr, intent, onClose, onConfirm }: Props) {
  const [reason, setReason] = useState(DEFAULT_REJECTION_REASON);
  const [note, setNote] = useState('');

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-sand/20">
          <div className="w-8 h-8 rounded-lg bg-red-50 text-red-500 flex items-center justify-center shrink-0">
            {intent === 'reject' ? <Ban size={16} /> : <RefreshCw size={16} />}
          </div>
          <h2 className="flex-1 text-base font-bold text-chocolate">
            {intent === 'reject'
              ? (isAr ? 'سبب الرفض' : 'Rejection reason')
              : (isAr ? 'ما الذي يجب تصحيحه؟' : 'What should be fixed?')}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream transition-colors"
            aria-label={isAr ? 'إغلاق' : 'Close'}
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {REJECTION_REASONS.map((r) => (
              <button
                key={r.value}
                onClick={() => setReason(r.value)}
                className={`text-start px-3 py-2 rounded-xl border text-xs font-bold transition-colors ${
                  reason === r.value
                    ? 'border-copper bg-copper/8 text-chocolate'
                    : 'border-sand/25 text-charcoal/60 hover:bg-cream/60'
                }`}
              >
                {isAr ? r.ar : r.en}
              </button>
            ))}
          </div>
          <div>
            <label className="block text-xs font-bold text-charcoal/60 mb-1">
              {isAr ? 'ملاحظة (اختياري)' : 'Note (optional)'}
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder={isAr ? 'مثال: العنوان عام جدًا، ركّز على الضمانات' : 'e.g. the headline is too generic — lead on the warranties'}
              className="w-full text-sm text-charcoal bg-cream/40 rounded-xl border border-sand/25 p-2.5 resize-y focus:outline-none focus:ring-2 focus:ring-copper/25"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-sand/20">
          <Button variant="ghost" onClick={onClose}>{isAr ? 'إلغاء' : 'Cancel'}</Button>
          {intent === 'reject' && (
            <Button
              variant="secondary"
              onClick={() => onConfirm({ reason, note }, true)}
            >
              <RefreshCw size={15} />
              {isAr ? 'رفض وإعادة كتابة' : 'Reject & rewrite'}
            </Button>
          )}
          <Button
            variant={intent === 'reject' ? 'danger' : 'primary'}
            onClick={() => onConfirm({ reason, note }, intent === 'regenerate')}
          >
            {intent === 'reject' ? <Ban size={15} /> : <RefreshCw size={15} />}
            {intent === 'reject' ? (isAr ? 'رفض' : 'Reject') : (isAr ? 'إعادة الكتابة' : 'Rewrite')}
          </Button>
        </div>
      </div>
    </div>
  );
}
