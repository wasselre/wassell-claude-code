import Modal from '@/components/ui/Modal';
import { useAppStore } from '@/stores/appStore';
import type { FollowUpTypeConfig } from '@/lib/salesProcess';

/** The call-guidance script, in a popup (kept out of the main flow so the Call step
 *  stays compact). Opened by the "Call script" button. */
export default function ScriptModal({ typeConfig, onClose }: { typeConfig: FollowUpTypeConfig | undefined; onClose: () => void }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const lines = (isAr ? typeConfig?.script?.ar : typeConfig?.script?.en) ?? [];
  return (
    <Modal open onClose={onClose} title={isAr ? 'سكربت المكالمة' : 'Call script'} maxWidth="max-w-2xl">
      {lines.length === 0 ? (
        <p className="text-sm text-charcoal/60">{isAr ? 'لا يوجد سكربت لهذا النوع.' : 'No script for this type.'}</p>
      ) : (
        <ul className="list-disc space-y-2.5 ps-5 text-sm leading-relaxed text-charcoal/90 marker:text-copper">
          {lines.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      )}
    </Modal>
  );
}
