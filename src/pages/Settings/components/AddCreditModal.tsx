import { useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { addCredit, usd, type AiAccountBalance, type AiCreditEntry } from '@/lib/aiUsage/client';

/**
 * Record money going INTO a provider account.
 *
 * Three kinds, and the difference matters:
 *   opening    — "the account holds this much as of now". Sets the line from
 *                which spend starts being subtracted; usage recorded before it
 *                is never counted against the balance.
 *   topup      — money added to an account already being tracked.
 *   adjustment — a correction, and the only kind allowed to be negative.
 *
 * Nothing here is ever edited in place. A wrong figure is corrected with an
 * adjustment so the record of what was believed, and when, survives.
 */
export default function AddCreditModal({
  account,
  hasHistory,
  onClose,
  onSaved,
}: {
  account: AiAccountBalance;
  hasHistory: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);

  // A first entry is an opening balance; later ones default to a top-up.
  const [kind, setKind] = useState<AiCreditEntry['kind']>(hasHistory ? 'topup' : 'opening');
  const [amount, setAmount] = useState('');
  const [effectiveAt, setEffectiveAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const parsed = Number(amount.replace(/,/g, ''));
  const amountValid = Number.isFinite(parsed) && parsed !== 0 && (kind === 'adjustment' || parsed > 0);

  async function save() {
    if (!amountValid || saving) return;
    setSaving(true);
    try {
      await addCredit({
        accountId: account.id,
        amountUsd: parsed,
        kind,
        // Keep the operator's chosen day but stamp the current time, so two
        // entries on the same date keep their order.
        effectiveAt: new Date(`${effectiveAt}T${new Date().toISOString().slice(11, 19)}Z`).toISOString(),
        note: note.trim() || undefined,
      });
      addToast(
        isAr ? 'تم تسجيل الرصيد' : 'Credit recorded',
        'success',
      );
      onSaved();
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[aiUsage] addCredit failed:', msg);
      addToast(
        isAr ? `تعذّر حفظ الرصيد: ${msg}` : `Could not record credit: ${msg}`,
        'error',
      );
    } finally {
      setSaving(false);
    }
  }

  const KINDS: { value: AiCreditEntry['kind']; ar: string; en: string; hintAr: string; hintEn: string }[] = [
    {
      value: 'opening',
      ar: 'رصيد افتتاحي',
      en: 'Opening balance',
      hintAr: 'الرصيد الموجود الآن. يبدأ خصم الاستهلاك من هذا التاريخ.',
      hintEn: 'What the account holds now. Spend is counted from this date onward.',
    },
    {
      value: 'topup',
      ar: 'شحن رصيد',
      en: 'Top-up',
      hintAr: 'مبلغ أُضيف إلى الحساب.',
      hintEn: 'Money added to the account.',
    },
    {
      value: 'adjustment',
      ar: 'تصحيح',
      en: 'Adjustment',
      hintAr: 'تصحيح رقم سابق. يقبل قيمة سالبة.',
      hintEn: 'Correct an earlier figure. May be negative.',
    },
  ];
  const active = KINDS.find((k) => k.value === kind)!;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-sand/30 px-5 py-4">
          <div>
            <h3 className="text-base font-bold text-charcoal">
              {isAr ? 'تسجيل رصيد' : 'Record credit'}
            </h3>
            <p className="text-xs text-charcoal/50">{account.label}</p>
          </div>
          <button
            onClick={onClose}
            aria-label={isAr ? 'إغلاق' : 'Close'}
            className="rounded-lg p-1.5 text-charcoal/40 transition hover:bg-cream hover:text-charcoal"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-5">
          <div>
            <label className="mb-1.5 block text-xs font-bold text-charcoal/60">
              {isAr ? 'النوع' : 'Type'}
            </label>
            <div className="flex gap-1.5">
              {KINDS.map((k) => (
                <button
                  key={k.value}
                  onClick={() => setKind(k.value)}
                  className={`flex-1 rounded-lg border px-2 py-2 text-xs font-bold transition ${
                    kind === k.value
                      ? 'border-copper bg-copper/10 text-copper'
                      : 'border-sand/40 text-charcoal/60 hover:bg-cream'
                  }`}
                >
                  {isAr ? k.ar : k.en}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-charcoal/45">
              {isAr ? active.hintAr : active.hintEn}
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-bold text-charcoal/60">
              {isAr ? 'المبلغ بالدولار' : 'Amount (USD)'}
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 start-3 flex items-center text-sm text-charcoal/40">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={kind === 'adjustment' ? '-5.00' : '100.00'}
                autoFocus
                className="w-full rounded-lg border border-sand/40 bg-white py-2.5 ps-7 pe-3 text-sm text-charcoal outline-none focus:border-copper focus:ring-2 focus:ring-copper/20"
              />
            </div>
            {amount.trim() !== '' && !amountValid && (
              <p className="mt-1.5 text-[11px] text-red-500">
                {kind === 'adjustment'
                  ? isAr ? 'أدخل رقمًا غير صفري.' : 'Enter a non-zero number.'
                  : isAr ? 'أدخل رقمًا أكبر من صفر (استخدم «تصحيح» للقيم السالبة).' : 'Enter a number above zero (use Adjustment for negatives).'}
              </p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-bold text-charcoal/60">
              {isAr ? 'التاريخ' : 'Effective date'}
            </label>
            <input
              type="date"
              value={effectiveAt}
              onChange={(e) => setEffectiveAt(e.target.value)}
              className="w-full rounded-lg border border-sand/40 bg-white px-3 py-2.5 text-sm text-charcoal outline-none focus:border-copper focus:ring-2 focus:ring-copper/20"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-bold text-charcoal/60">
              {isAr ? 'ملاحظة (اختياري)' : 'Note (optional)'}
            </label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={isAr ? 'مثلاً: شحن سبتمبر' : 'e.g. September top-up'}
              className="w-full rounded-lg border border-sand/40 bg-white px-3 py-2.5 text-sm text-charcoal outline-none focus:border-copper focus:ring-2 focus:ring-copper/20"
            />
          </div>

          {amountValid && (
            <div className="rounded-lg bg-cream px-3 py-2.5 text-xs text-charcoal/70">
              {isAr ? 'الرصيد بعد الحفظ: ' : 'Balance after saving: '}
              <strong className="text-charcoal">{usd(account.remaining_usd + parsed)}</strong>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-sand/30 px-5 py-4">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </Button>
          <Button onClick={save} disabled={!amountValid || saving}>
            {saving && <Loader2 size={14} className="animate-spin" />}
            {isAr ? 'حفظ' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}
