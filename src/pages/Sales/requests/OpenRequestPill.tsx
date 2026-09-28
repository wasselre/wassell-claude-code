/**
 * «طلب بحث مفتوح» — shown next to the client's name (chat header) while the
 * client has an open unanswered request, so nobody pitches them the stock we
 * already know does not fit while a search is running. Links to the requests tab.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { SearchX } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { firstId, isOpenRequest } from './requestData';

export default function OpenRequestPill({ clientId, className = '' }: { clientId: string | null; className?: string }) {
  const navigate = useNavigate();
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const isAr = useAppStore((s) => s.language) === 'ar';

  const open = useMemo(() => {
    if (!clientId) return false;
    const m = models.find((x) => x.name === 'unanswered_requests');
    return !!m && (records[m.id] ?? []).some((r) => firstId((r.data as Record<string, unknown>).client_id) === clientId && isOpenRequest(r));
  }, [clientId, models, records]);

  if (!open) return null;
  return (
    <button
      type="button"
      onClick={() => navigate('/sales-workspace/requests')}
      className={`inline-flex items-center gap-1 rounded-full bg-amber-50 font-medium text-amber-800 transition-colors hover:bg-amber-100 ${className}`}
      title={isAr ? 'لهذا العميل طلب بحث مفتوح — ما عندنا يناسبه حالياً' : 'This client has an open search request — nothing we have fits yet'}
    >
      <SearchX size={12} />
      {isAr ? 'طلب بحث مفتوح' : 'Open search request'}
    </button>
  );
}
