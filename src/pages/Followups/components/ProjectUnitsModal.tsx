// All units of ONE project, in a popup — opened from a Finder card so the rep can
// browse the project's inventory without leaving the results. Reuses the real
// UnitsInventory (filters + unit detail + compare), keyed by the All-Projects id
// that units link to. For a مشاريعنا (our_projects) card that id is the card's
// `project` master link, not the our_projects record id itself.

import { useMemo } from 'react';
import Modal from '@/components/ui/Modal';
import UnitsInventory from '@/pages/Projects/components/UnitsInventory';
import { useAppStore } from '@/stores/appStore';
import type { FinderMatch } from '@/lib/matching/projectFinder';
import type { ChatPdfContext } from '@/lib/projects/sendPdfToChat';

export default function ProjectUnitsModal({
  item, isAr, onClose, chatPdf,
}: {
  item: FinderMatch;
  isAr: boolean;
  onClose: () => void;
  /** When set, the units table + each unit sheet gain a "Send to client" PDF
   *  action into this client's conversation (else Download only). */
  chatPdf?: ChatPdfContext | null;
}) {
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  // Units carry a lookup to All Projects. all_projects cards use their own id;
  // our_projects cards resolve to their master All-Projects link (`project`).
  const allProjectId = useMemo(() => {
    if (item.source !== 'our_projects') return item.project_id;
    const our = models.find((m) => m.name === 'our_projects');
    const rec = our ? (records[our.id] ?? []).find((r) => r.id === item.project_id) : null;
    const master = (rec?.data as Record<string, unknown> | undefined)?.project;
    const id = Array.isArray(master) ? master[0] : master;
    return typeof id === 'string' && id ? id : item.project_id;
  }, [item.source, item.project_id, models, records]);

  return (
    <Modal open onClose={onClose} title={isAr ? `وحدات المشروع — ${item.project_name}` : `Project units — ${item.project_name}`} maxWidth="max-w-6xl">
      <UnitsInventory projectId={allProjectId} projectName={item.project_name} isAr={isAr} chatPdf={chatPdf} />
    </Modal>
  );
}
