import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import SectionBlock from './SectionBlock';
import RelatedRecordsPanel from './RelatedRecordsPanel';
import type { ModelSection } from '@/types';

interface ClientDetailsTabPaneProps {
  clientId: string;
}

/**
 * Embedded "Client 360" view rendered inside the record form when the user
 * selects the Client Details tab. Shows the client's full record (every
 * section, read-only — including WhatsApp History + Calls) followed by a
 * cross-model "Related Records" list of every record in any model that points
 * at this client via a lookup field.
 *
 * Reuses `SectionBlock` with `formReadOnly={true}` so the user can scan but
 * not edit. Edits to the client itself happen on the client's own page,
 * accessible by clicking through to it from the Records sidebar.
 */
export default function ClientDetailsTabPane({ clientId }: ClientDetailsTabPaneProps) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);
  const clientRecord = useMemo(() => {
    if (!clientsModel) return null;
    return (records[clientsModel.id] ?? []).find((r) => r.id === clientId) ?? null;
  }, [clientsModel, records, clientId]);

  if (!clientsModel) {
    return (
      <p className="text-sm text-charcoal/50">
        {isAr ? 'نموذج العملاء غير موجود.' : 'Clients model not found.'}
      </p>
    );
  }

  if (!clientRecord) {
    return (
      <p className="text-sm text-charcoal/50">
        {isAr ? 'لم يتم العثور على سجل العميل المرتبط.' : 'Linked client record not found.'}
      </p>
    );
  }

  const visibleSections: ModelSection[] = clientsModel.schema.sections
    .slice()
    .sort((a, b) => a.order - b.order);

  // Use the language-specific name as the heading. Falls back to record id.
  const data = clientRecord.data as Record<string, unknown>;
  const clientName =
    (typeof data.client_name === 'string' && data.client_name.trim()) ||
    clientRecord.id.slice(0, 8);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-chocolate mb-1">
          {isAr ? `تفاصيل العميل — ${clientName}` : `Client Details — ${clientName}`}
        </h2>
        <p className="text-xs text-charcoal/50">
          {t('records.client_details_readonly_hint', {
            defaultValue: isAr
              ? 'عرض فقط — افتح سجل العميل لتعديل البيانات.'
              : 'Read-only view — open the client record itself to edit.',
          })}
        </p>
      </div>

      <div className="space-y-6">
        {visibleSections.map((section) => (
          <SectionBlock
            key={section.id}
            section={section}
            formData={data}
            onChange={() => undefined}
            currentModel={clientsModel}
            mirrorEdits={{}}
            onMirrorFieldChange={() => undefined}
            formReadOnly={true}
            recordId={clientRecord.id}
          />
        ))}
      </div>

      <RelatedRecordsPanel clientId={clientRecord.id} excludeModelName="clients" />
    </div>
  );
}
