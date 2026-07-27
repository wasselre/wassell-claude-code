/**
 * "This client's market" — the Market Intelligence area statistics computed over
 * the client's OWN saved location preferences.
 *
 * The rep flow, as opposed to the analyst flow in Market Intelligence → Map:
 * the question here is never "which area shall I analyse", it is "this client
 * wants THAT — what does that market look like, and where do we sit in it".
 * So there is no area builder: the area is whatever the Preferences tab says,
 * and the honest answer when preferences are empty is to send the rep there.
 *
 * Same component, same endpoint, same numbers as the analyst view — a rep and a
 * manager discussing one client must never be reading two different figures.
 */
import { useEffect, useState } from 'react';
import { SlidersHorizontal, FileDown } from 'lucide-react';
import Button from '@/components/ui/Button';
import AreaStatsPanel from '@/pages/MarketIntelligence/components/AreaStatsPanel';
import { downloadAreaStudyPdf } from '@/pages/MarketIntelligence/reports/areaStudyPdf';
import {
  fetchClientArea, fetchGeoCoverage,
  type ClientAreaData, type GeoCoverage,
} from '@/lib/market/client';
import { parseLocationItems, describeLocationItem } from '@/lib/geo/locationItems';
import type { AppRecord } from '@/types';

interface Props {
  client: AppRecord;
  isAr: boolean;
  onOpenPreferences: () => void;
}

export default function MarketTab({ client, isAr, onOpenPreferences }: Props) {
  const [data, setData] = useState<ClientAreaData | null>(null);
  const [coverage, setCoverage] = useState<GeoCoverage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const items = parseLocationItems(client.data.location_items);
  const areaLabel = items.map((i) => describeLocationItem(i, isAr)).join(' + ');

  useEffect(() => {
    if (!items.length) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    Promise.all([fetchClientArea(client.id), fetchGeoCoverage().catch(() => null)])
      .then(([d, c]) => { if (!cancelled) { setData(d); setCoverage(c); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id, items.length]);

  if (!items.length) {
    return (
      <div className="card p-8 text-center">
        <div className="mb-2 text-sm text-charcoal/60">
          {isAr
            ? 'لم يحدد هذا العميل أي تفضيلات للموقع بعد، ولا يمكن حساب سوقه بدونها.'
            : 'This client has no saved location preferences yet, and their market cannot be computed without them.'}
        </div>
        <Button variant="secondary" onClick={onOpenPreferences}>
          <SlidersHorizontal size={15} /> {isAr ? 'إضافة تفضيلات الموقع' : 'Add location preferences'}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center justify-between gap-2 p-4">
        <div>
          <div className="text-sm font-bold text-charcoal">
            {isAr ? 'المنطقة التي يبحث فيها العميل' : 'Where this client is looking'}
          </div>
          <div className="mt-0.5 text-[12px] text-charcoal/60">{areaLabel}</div>
          {data?.preferred_unit_type && (
            <div className="mt-0.5 text-[11px] text-charcoal/45">
              {isAr ? 'حسب نوع العقار المفضل' : 'Filtered to their preferred property type'}
            </div>
          )}
        </div>
        {data?.stats && (
          <Button variant="secondary" onClick={() => downloadAreaStudyPdf({
            stats: data.stats,
            coverage,
            areaLabel,
            isAr,
            clientName: data.client_name,
            budget: { min: data.budget_min, max: data.budget_max },
            propertyType: data.preferred_unit_type ?? undefined,
          })}>
            <FileDown size={15} /> {isAr ? 'دراسة للعميل (PDF)' : 'Client study (PDF)'}
          </Button>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-[12px] text-rose-800">{error}</div>
      )}

      <AreaStatsPanel
        stats={data?.stats ?? null}
        coverage={coverage}
        loading={loading}
        isAr={isAr}
        budget={data ? { min: data.budget_min, max: data.budget_max } : null}
      />
    </div>
  );
}
