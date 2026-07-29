import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Users, ArrowUpRight, Unlink, Loader2, AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import Button from '@/components/ui/Button';
import type { PropertyGroup } from '@/lib/marketListings/propertyGroups';
import type { AppRecord } from '@/types';

interface Props {
  group: PropertyGroup;
  /** Open one listing's record page. */
  onOpenListing: (record: AppRecord) => void;
  onClose: () => void;
}

const fmtPrice = (n: number | null, isAr: boolean): string =>
  n === null ? (isAr ? '—' : '—') : new Intl.NumberFormat(isAr ? 'ar-SA' : 'en-US').format(n);

const str = (r: AppRecord, k: string): string => {
  const v = (r.data as Record<string, unknown>)[k];
  return v === null || v === undefined ? '' : String(v);
};

/**
 * The listings behind one grouped property card: who is advertising it and for
 * how much.
 *
 * The spread is the point. Five brokers on the same plot asking 975,000 to
 * 1,100,002 tells a rep the real anchor is 975,000 — that is why the group is
 * shown intact rather than deduplicated down to a single "winning" row.
 */
export default function PropertyGroupModal({ group, onOpenListing, onClose }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const [splitting, setSplitting] = useState(false);

  const spread =
    group.priceMin !== null && group.priceMax !== null && group.priceMax > group.priceMin
      ? group.priceMax - group.priceMin
      : null;

  /**
   * Ungroup: mark every member so the list stops collapsing them.
   *
   * Goes through the market_listing_set_split RPC, NOT the record store.
   * market_listings is a SUMMARY model — the store only holds the slim
   * projection, so saving a record from the list would write that slim blob back
   * over the full row and destroy description / image_urls / everything else.
   */
  const handleSplit = async () => {
    if (!supabase) {
      addToast(isAr ? 'غير متصل بالخادم' : 'Not connected to the server', 'error');
      return;
    }
    setSplitting(true);
    const ids = group.members.map((m) => m.id);
    const { error } = await supabase.rpc('market_listing_set_split', {
      p_ids: ids,
      p_split: true,
    });
    setSplitting(false);
    if (error) {
      // Never swallow: the user asked for a change and must know it failed.
      console.error('[property-group] split failed', error);
      addToast(
        (isAr ? 'تعذّر فصل الإعلانات: ' : 'Could not split the listings: ') + error.message,
        'error',
      );
      return;
    }
    addToast(
      isAr
        ? `تم فصل ${ids.length} إعلانات — حدّث الصفحة لعرضها منفصلة`
        : `Split ${ids.length} listings — refresh to see them separately`,
      'success',
    );
    onClose();
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-charcoal/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-sand/40">
          <div className="flex items-center gap-2 text-charcoal">
            <Users size={18} className="text-copper" />
            <h2 className="text-base font-bold">
              {/* One agent re-posting the same property is a different story
                  from several agents competing on it — say which one this is
                  rather than rendering "1 advertisers". */}
              {group.agentCount > 1
                ? isAr
                  ? `عقار واحد — ${group.agentCount} معلنين`
                  : `One property — ${group.agentCount} advertisers`
                : isAr
                  ? `عقار واحد — ${group.members.length} إعلانات من نفس المعلن`
                  : `One property — ${group.members.length} listings from the same advertiser`}
            </h2>
          </div>
          <p className="mt-1 text-sm text-charcoal/60">
            {/* "from 3,800,000 to 3,800,000" is noise — when every broker asks
                the same price, say the price once. */}
            {spread === null
              ? isAr
                ? `${group.members.length} إعلانات لنفس العقار، جميعها بسعر ${fmtPrice(group.priceMin, isAr)} ر.س`
                : `${group.members.length} listings for the same property, all at ${fmtPrice(group.priceMin, isAr)} SAR`
              : isAr
                ? `${group.members.length} إعلانات لنفس العقار، من ${fmtPrice(group.priceMin, isAr)} إلى ${fmtPrice(group.priceMax, isAr)} ر.س`
                : `${group.members.length} listings for the same property, ${fmtPrice(group.priceMin, isAr)} to ${fmtPrice(group.priceMax, isAr)} SAR`}
            {spread !== null && (
              <span className="text-copper font-bold">
                {isAr ? ` — فارق ${fmtPrice(spread, isAr)}` : ` — ${fmtPrice(spread, isAr)} apart`}
              </span>
            )}
          </p>

          {/* Tier 3 is a coordinates+area guess (~88% precise), so say so. */}
          {group.tier === 3 && (
            <div className="mt-3 flex items-start gap-2 rounded-lg bg-gold/10 border border-gold/30 px-3 py-2">
              <AlertTriangle size={14} className="text-gold-dark mt-0.5 shrink-0" />
              <p className="text-xs text-charcoal/70">
                {isAr
                  ? 'مجمّعة بالموقع والمساحة (بدون رقم صك) — تجميع مُرجَّح وليس مؤكداً. افصلها إن كانت عقارات مختلفة.'
                  : 'Grouped by location and area (no deed number) — a probable match, not a confirmed one. Split them if these are different properties.'}
              </p>
            </div>
          )}
        </div>

        {/* Members */}
        <div className="flex-1 overflow-y-auto divide-y divide-sand/30">
          {group.members.map((m) => {
            const price = str(m, 'price');
            // Only worth flagging when the brokers actually disagree; if they
            // all ask the same, every row is "lowest" and the badge is noise.
            const isLowest = spread !== null && Number(price) === group.priceMin;
            return (
              <button
                key={m.id}
                onClick={() => onOpenListing(m)}
                className="w-full text-start px-5 py-3 hover:bg-cream-light transition-colors flex items-center gap-3"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-charcoal truncate">
                    {str(m, 'advertiser_name') || (isAr ? 'معلن غير معروف' : 'Unknown advertiser')}
                  </p>
                  <p className="text-xs text-charcoal/50 truncate">
                    {[str(m, 'property_type'), str(m, 'external_id') && `#${str(m, 'external_id')}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <div className="text-end shrink-0">
                  <p className={`text-sm font-bold ${isLowest ? 'text-copper' : 'text-charcoal'}`}>
                    {fmtPrice(Number(price) || null, isAr)}
                  </p>
                  {isLowest && (
                    <p className="text-[10px] text-copper font-bold">{isAr ? 'الأقل' : 'lowest'}</p>
                  )}
                </div>
                <ArrowUpRight size={14} className="text-charcoal/30 shrink-0" />
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-sand/40 flex items-center justify-between gap-3">
          <Button variant="secondary" onClick={handleSplit} disabled={splitting}>
            {splitting ? <Loader2 size={14} className="animate-spin" /> : <Unlink size={14} />}
            {isAr ? 'عرض كإعلانات منفصلة' : 'Show as separate listings'}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {isAr ? 'إغلاق' : 'Close'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
