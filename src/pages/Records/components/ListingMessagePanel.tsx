import { useState } from 'react';
import { MessageSquarePlus, MessageSquareText } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import ListingMessageModal from './ListingMessageModal';

interface Props {
  modelId: string;
  recordId: string;
}

/**
 * "Generate message" panel on a market_listings record form. Self-hides on every
 * other model. Reuse-first: if a saved (status='ready') chat_templates message
 * already exists for this listing, the button says "View message" and opens it;
 * otherwise it generates a new one (AI text + text-removed photos). Mirrors
 * RecordDocumentsPanel's card shell.
 */
export default function ListingMessagePanel({ modelId, recordId }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const tr = (ar: string, en: string) => (isAr ? ar : en);
  const [open, setOpen] = useState(false);

  const model = models.find((m) => m.id === modelId);
  if (model?.name !== 'market_listings') return null;

  const chatTemplatesModel = models.find((m) => m.name === 'chat_templates');
  if (!chatTemplatesModel) return null;

  const existing =
    (records[chatTemplatesModel.id] ?? []).find(
      (r) =>
        (r.data as Record<string, unknown>)?.listing_id === recordId &&
        (r.data as Record<string, unknown>)?.status === 'ready',
    ) ?? null;

  const listing = (records[modelId] ?? []).find((r) => r.id === recordId);
  const listingData = (listing?.data as Record<string, unknown> | undefined) ?? {};
  // The template is NAMED after the listing's Aqar ad id ("@123456") — the id
  // is how listings are referenced everywhere. Title is display-only fallback.
  const listingExternalId =
    typeof listingData.external_id === 'string' && listingData.external_id.trim()
      ? listingData.external_id.trim()
      : '';
  const listingTitle =
    (listingExternalId && `@${listingExternalId}`) ||
    (listingData.title as string | undefined) ||
    tr('رسالة الإعلان', 'Listing message');

  return (
    <div className="mt-6 bg-white rounded-2xl border border-sand/30 p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MessageSquareText size={16} className="text-copper" />
          <h3 className="font-bold text-charcoal text-sm">{tr('رسالة واتساب للإعلان', 'Listing WhatsApp message')}</h3>
        </div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          <MessageSquarePlus size={16} />
          {existing ? tr('عرض الرسالة', 'View message') : tr('إنشاء رسالة', 'Generate message')}
        </Button>
      </div>
      {existing ? (
        <p className="text-xs text-charcoal/50 mt-2">
          {tr('يوجد رسالة محفوظة لهذا الإعلان مع صور تمت إزالة النص منها.', 'A saved message with text-removed photos exists for this listing.')}
        </p>
      ) : (
        <p className="text-xs text-charcoal/50 mt-2">
          {tr(
            'أنشئ رسالة تسويقية تتضمن نوع الوحدة والحي والمساحة والغرف والمميزات، مع تنظيف النص من صور الإعلان.',
            'Generate a marketing message with the unit type, district, area, rooms and features — and clean text off the listing photos.',
          )}
        </p>
      )}

      {open && (
        <ListingMessageModal
          listingId={recordId}
          listingTitle={listingTitle}
          chatTemplatesModelId={chatTemplatesModel.id}
          existing={existing}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
