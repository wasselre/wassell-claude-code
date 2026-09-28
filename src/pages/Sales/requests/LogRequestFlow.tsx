/**
 * «تسجيل طلب غير مجاب» from anywhere: pick the client, then the existing
 * LogUnansweredRequestModal (which creates ONLY the request — the workflow on
 * its create moves the client and opens the search task; see that modal).
 * Used by the requests tab and the Sales Tools menu.
 */
import { useState } from 'react';
import Modal from '@/components/ui/Modal';
import { useAppStore } from '@/stores/appStore';
import ClientSearch from '@/pages/Sales/components/ClientSearch';
import LogUnansweredRequestModal from '@/pages/Clients/components/LogUnansweredRequestModal';

export default function LogRequestFlow({ onClose }: { onClose: () => void }) {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const [clientId, setClientId] = useState<string | null>(null);

  if (!clientId) {
    return (
      <Modal open onClose={onClose} title={isAr ? 'تسجيل طلب غير مجاب — اختر العميل' : 'Log an unanswered request — pick the client'} maxWidth="max-w-lg">
        <ClientSearch onPick={(c) => setClientId(c.id)} />
      </Modal>
    );
  }
  return (
    // The modal toasts its own outcome and closes itself on save.
    <LogUnansweredRequestModal clientId={clientId} isAr={isAr} onClose={onClose} />
  );
}
