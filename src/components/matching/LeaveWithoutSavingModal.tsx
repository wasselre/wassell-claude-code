import { AlertTriangle } from 'lucide-react';

/**
 * Confirmation shown when the rep tries to leave a client-scoped Project Finder
 * (Done / Esc / clearing the client) without having saved a single option for
 * that client during this visit. "Stay" is the safe primary action.
 */
export default function LeaveWithoutSavingModal({ isAr, clientName, onStay, onLeave }: {
  isAr: boolean;
  clientName?: string | null;
  onStay: () => void;
  onLeave: () => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-charcoal/40 p-4" onMouseDown={onStay}>
      <div className="w-full max-w-md rounded-2xl bg-cream p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()} dir={isAr ? 'rtl' : 'ltr'}>
        <div className="mb-2 flex items-center gap-2 text-chocolate">
          <AlertTriangle size={18} className="text-amber-600" />
          <h3 className="text-base font-bold">{L('لم تحفظ أي خيار', 'No option saved')}</h3>
        </div>
        <p className="mb-1 text-sm text-charcoal/75">
          {L('هل أنت متأكد أنك لن تحفظ أي خيار لهذا العميل؟', 'Are you sure you will not save any option for this client?')}
        </p>
        {clientName && <p className="mb-3 text-xs text-charcoal/55">{clientName}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onLeave}
            className="rounded-lg border border-sand/60 bg-white px-3.5 py-2 text-sm font-bold text-charcoal/75 transition hover:bg-cream/60"
          >
            {L('الخروج بدون حفظ', 'Leave without saving')}
          </button>
          <button
            type="button"
            onClick={onStay}
            autoFocus
            className="rounded-lg bg-copper px-3.5 py-2 text-sm font-bold text-white transition hover:bg-terracotta"
          >
            {L('البقاء لحفظ الخيارات', 'Stay and save options')}
          </button>
        </div>
      </div>
    </div>
  );
}
