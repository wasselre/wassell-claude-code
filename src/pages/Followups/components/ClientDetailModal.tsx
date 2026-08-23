// The custom Client 360 cockpit (ClientDetailPage) in a popup, so a rep can view
// the full client profile without leaving the follow-up mission. ClientDetailPage
// runs in `embedded` mode: no full-page wrapper, and Back / Advanced / Find-more
// close the popup or open a new tab instead of navigating under the modal.

import Modal from '@/components/ui/Modal';
import { useAppStore } from '@/stores/appStore';
import ClientDetailPage from '@/pages/Clients/ClientDetailPage';

export default function ClientDetailModal({ clientId, onClose }: { clientId: string; onClose: () => void }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  return (
    <Modal open onClose={onClose} title={isAr ? 'ملف العميل' : 'Client profile'} maxWidth="max-w-[1400px]">
      <ClientDetailPage clientId={clientId} onClose={onClose} />
    </Modal>
  );
}
