import { useState } from 'react';
import {
  Building2, MapPin, Wallet, Ruler, BedDouble, Bath, PackageCheck, AlertTriangle,
  HelpCircle, Megaphone, MessageCircle, GitCompareArrows, ExternalLink, Plus, Check, ChevronDown,
} from 'lucide-react';
import type { SuggestionItem, DataConfidence, DataGapCode, MatchBand } from '@/lib/matching/suggestions';

/**
 * One project in the Suggested Projects modal — renders the deterministic match
 * facts (score, category, distance, price/units or their absence, data gaps,
 * verification warning) and the action buttons. The card NEVER scores; it shows
 * what /api/suggest-projects decided. Pitch / WhatsApp / Compare hand off to the
 * assistant chat pane via callbacks.
 */

interface Props {
  item: SuggestionItem;
  isAr: boolean;
  compareSelected: boolean;
  onToggleCompare: (item: SuggestionItem) => void;
  onPitch: (item: SuggestionItem) => void;
  onDraftWhatsApp: (item: SuggestionItem) => void;
  onAsk: (item: SuggestionItem) => void; // "why this project?" → chat
  onOpenDetails: (item: SuggestionItem) => void;
  onAddToClient: (item: SuggestionItem) => void;
  addState: 'idle' | 'saving' | 'added';
}

const fmtNum = (n: number) => n.toLocaleString('en-US');

function fmtRange(v: unknown, unit: string): string | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return `${fmtNum(v)} ${unit}`.trim();
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const min = typeof o.min === 'number' ? o.min : Number(o.min);
    const max = typeof o.max === 'number' ? o.max : Number(o.max);
    const hasMin = Number.isFinite(min);
    const hasMax = Number.isFinite(max);
    if (hasMin && hasMax) return min === max ? `${fmtNum(min)} ${unit}`.trim() : `${fmtNum(min)} – ${fmtNum(max)} ${unit}`.trim();
    if (hasMax) return `${fmtNum(max)} ${unit}`.trim();
    if (hasMin) return `${fmtNum(min)} ${unit}`.trim();
  }
  return null;
}

// The project unit_types are stored as English slugs (apartment / villa / floor …);
// render them in Arabic when the UI is Arabic. Unknown values fall back to the raw
// value (so a new type still shows). English UI keeps the slug as-is.
const UNIT_TYPE_AR: Record<string, string> = {
  apartment: 'شقة', apartments: 'شقة', flat: 'شقة', flats: 'شقة', penthouse: 'بنتهاوس',
  villa: 'فيلا', villas: 'فيلا', townhouse: 'تاون هاوس', townhouses: 'تاون هاوس',
  studio: 'استوديو', studios: 'استوديو', duplex: 'دوبلكس', duplexes: 'دوبلكس',
  floor: 'دور', floors: 'أدوار', land: 'أرض', lands: 'أرض', plot: 'أرض', plots: 'أرض',
};
function localizeUnitType(v: string, isAr: boolean): string {
  if (!isAr) return v;
  return UNIT_TYPE_AR[v.trim().toLowerCase()] ?? v;
}

export default function SuggestionCard({
  item, isAr, compareSelected, onToggleCompare, onPitch, onDraftWhatsApp, onAsk, onOpenDetails, onAddToClient, addState,
}: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [showWhy, setShowWhy] = useState(false);
  const f = item.facts;

  const city = typeof f.city === 'string' ? f.city : '';
  const district = typeof f.district === 'string' ? f.district : '';
  const unitTypes = Array.isArray(f.unit_types) ? (f.unit_types as unknown[]).filter((x): x is string => typeof x === 'string').map((t) => localizeUnitType(t, isAr)).join('، ') : '';
  const cur = L('ر.س', 'SAR');
  const price = fmtRange(f.price_range, cur);
  const area = fmtRange(f.area_range, L('م²', 'm²'));
  const beds = fmtRange(f.bedroom_range, '');
  const baths = fmtRange(f.bathroom_range, '');
  const avail = typeof f.available_units === 'number' ? f.available_units : null;

  const priceMissing = item.data_gaps.includes('missing_price_range');
  const unitsMissing = item.data_gaps.includes('missing_unit_inventory');

  return (
    <div className={`rounded-xl border bg-white shadow-sm overflow-hidden ${compareSelected ? 'border-copper ring-1 ring-copper/40' : 'border-sand/50'}`}>
      {/* Verification banner */}
      {item.requires_verification && (
        <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>{item.verification_warning || L('من قاعدة «كل المشاريع» (غير موثّقة) — تحقّق قبل العرض.', 'From the All Projects database (unverified) — verify before offering.')}</span>
        </div>
      )}

      {/* Title row */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-sand/30">
        <Building2 size={15} className="text-charcoal/50 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-bold text-sm text-charcoal truncate">{item.project_name}</div>
          <div className="flex items-center gap-1 text-[11px] text-charcoal/55 truncate">
            <MapPin size={11} className="text-copper shrink-0" />
            {[district, city].filter(Boolean).join('، ') || L('الموقع غير محدد', 'Location not set')}
          </div>
        </div>
        {item.reason_code === 'no_criteria' ? (
          <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full border border-gray-200 bg-gray-100 text-gray-600 text-[11px] font-bold">
            {L('غير مطابق', 'Not matched')}
          </span>
        ) : (
          <BandBadge band={item.match_band} score={item.score} isAr={isAr} />
        )}
      </div>

      <div className="p-3 space-y-2.5">
        {/* Category + confidence + distance */}
        <div className="flex flex-wrap items-center gap-1.5">
          <CategoryPill group={item.group} isAr={isAr} />
          <ConfidencePill confidence={item.data_confidence} isAr={isAr} />
          {item.distance_km != null && (
            <span className="inline-flex items-center gap-1 rounded-full border border-sand/60 bg-cream/50 px-2 py-0.5 text-[11px] text-charcoal/70">
              <MapPin size={11} className="text-copper" />
              {L(`~${item.distance_km} كم من الحي`, `~${item.distance_km} km away`)}
              <span className="text-charcoal/40">· {L('مركز الحي', 'district center')}</span>
            </span>
          )}
        </div>

        {/* Sales reason */}
        <div className="text-sm text-charcoal/90">{localizedReason(item, isAr)}</div>

        {/* Specs grid */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg bg-cream/30 p-2.5 text-xs">
          <Spec icon={<Wallet size={12} />} label={L('السعر', 'Price')} value={price} missing={priceMissing} isAr={isAr} />
          <Spec icon={<PackageCheck size={12} />} label={L('وحدات متاحة', 'Available')} value={avail != null ? String(avail) : null} missing={unitsMissing} isAr={isAr} />
          <Spec icon={<Building2 size={12} />} label={L('النوع', 'Type')} value={unitTypes || null} isAr={isAr} />
          <Spec icon={<Ruler size={12} />} label={L('المساحة', 'Area')} value={area} isAr={isAr} />
          <Spec icon={<BedDouble size={12} />} label={L('الغرف', 'Bedrooms')} value={beds} isAr={isAr} />
          <Spec icon={<Bath size={12} />} label={L('دورات المياه', 'Bathrooms')} value={baths} isAr={isAr} />
        </div>

        {/* Data gaps */}
        {item.data_gaps.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {item.data_gaps.map((g) => (
              <span key={g} className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">
                <AlertTriangle size={10} />{gapLabel(g, isAr)}
              </span>
            ))}
          </div>
        )}

        {/* Why (score breakdown) */}
        <button type="button" onClick={() => setShowWhy((v) => !v)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-copper hover:underline">
          <HelpCircle size={12} /> {L('لماذا هذا المشروع؟', 'Why this project?')}
          <ChevronDown size={12} className={`transition ${showWhy ? 'rotate-180' : ''}`} />
        </button>
        {showWhy && (
          <div className="rounded-lg border border-sand/40 bg-cream/30 p-2.5 space-y-1">
            {Object.entries(item.score_breakdown)
              .filter(([, v]) => v != null)
              .map(([k, v]) => (
                <div key={k} className="flex items-center justify-between text-[11px]">
                  <span className="text-charcoal/60">{dimLabel(k, isAr)}</span>
                  <span className="font-semibold text-charcoal/85">{Math.round((v as number) * 100)}%</span>
                </div>
              ))}
            <button type="button" onClick={() => onAsk(item)} className="mt-1 text-[11px] font-semibold text-copper hover:underline">
              {L('اشرح أكثر في المحادثة ←', 'Explain more in chat →')}
            </button>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <ActionBtn icon={<Megaphone size={12} />} label={L('عرض', 'Pitch')} onClick={() => onPitch(item)} />
          <ActionBtn icon={<MessageCircle size={12} />} label={L('واتساب', 'WhatsApp')} onClick={() => onDraftWhatsApp(item)} />
          <ActionBtn icon={<GitCompareArrows size={12} />} label={compareSelected ? L('مُحدد للمقارنة', 'Selected') : L('قارن', 'Compare')} onClick={() => onToggleCompare(item)} active={compareSelected} />
          <ActionBtn icon={<ExternalLink size={12} />} label={L('التفاصيل', 'Details')} onClick={() => onOpenDetails(item)} />
          <ActionBtn
            icon={addState === 'added' ? <Check size={12} /> : <Plus size={12} />}
            label={addState === 'added' ? L('أُضيف', 'Added') : addState === 'saving' ? L('…', '…') : L('أضف للعميل', 'Add to client')}
            onClick={() => addState === 'idle' && onAddToClient(item)}
            active={addState === 'added'}
            disabled={addState !== 'idle'}
            primary
          />
        </div>
      </div>
    </div>
  );
}

function ActionBtn({ icon, label, onClick, active, disabled, primary }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean; disabled?: boolean; primary?: boolean }) {
  const base = 'inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-bold transition disabled:opacity-60';
  const cls = primary
    ? (active ? 'bg-green-100 text-green-700 border border-green-200' : 'bg-copper text-white hover:bg-terracotta')
    : (active ? 'border border-copper bg-copper/10 text-copper' : 'border border-sand/60 bg-white text-charcoal/75 hover:bg-cream/60');
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${cls}`}>
      {icon}{label}
    </button>
  );
}

function Spec({ icon, label, value, missing, isAr }: { icon: React.ReactNode; label: string; value: string | null; missing?: boolean; isAr: boolean }) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  return (
    <div className="flex items-start gap-1.5">
      <span className="text-copper mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="text-charcoal/50">{label}</div>
        {value ? (
          <div className="text-charcoal/90 font-medium break-words">{value}</div>
        ) : (
          <div className="text-amber-600/80 italic">{missing ? L('بيانات غير متوفرة', 'data not available') : '—'}</div>
        )}
      </div>
    </div>
  );
}

function BandBadge({ band, score, isAr }: { band: MatchBand; score: number; isAr: boolean }) {
  const map: Record<MatchBand, { cls: string; ar: string; en: string }> = {
    strong: { cls: 'bg-green-100 text-green-700 border-green-200', ar: 'قوية', en: 'Strong' },
    good: { cls: 'bg-copper/15 text-copper border-copper/30', ar: 'جيدة', en: 'Good' },
    partial: { cls: 'bg-gray-100 text-gray-600 border-gray-200', ar: 'جزئية', en: 'Partial' },
  };
  const e = map[band];
  return (
    <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-bold ${e.cls}`}>
      {isAr ? e.ar : e.en}<span className="opacity-70">· {score}</span>
    </span>
  );
}

function CategoryPill({ group, isAr }: { group: SuggestionItem['group']; isAr: boolean }) {
  const map: Record<SuggestionItem['group'], { ar: string; en: string }> = {
    exact_matches: { ar: 'مطابقة تامة', en: 'Exact' },
    nearby_alternatives: { ar: 'قريب', en: 'Nearby' },
    budget_matches: { ar: 'ضمن الميزانية', en: 'Budget' },
    location_matches: { ar: 'الموقع', en: 'Location' },
    fallback_matches: { ar: 'بديل', en: 'Fallback' },
  };
  const e = map[group];
  return <span className="inline-flex items-center rounded-full border border-copper/30 bg-copper/10 px-2 py-0.5 text-[11px] font-bold text-copper">{isAr ? e.ar : e.en}</span>;
}

function ConfidencePill({ confidence, isAr }: { confidence: DataConfidence; isAr: boolean }) {
  const map: Record<DataConfidence, { cls: string; ar: string; en: string }> = {
    high: { cls: 'bg-green-50 text-green-700 border-green-200', ar: 'بيانات موثوقة', en: 'High data' },
    medium: { cls: 'bg-amber-50 text-amber-700 border-amber-200', ar: 'بيانات جزئية', en: 'Med data' },
    low: { cls: 'bg-gray-50 text-gray-500 border-gray-200', ar: 'بيانات ضعيفة', en: 'Low data' },
  };
  const e = map[confidence];
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${e.cls}`}>{isAr ? e.ar : e.en}</span>;
}

function gapLabel(code: DataGapCode, isAr: boolean): string {
  const map: Record<DataGapCode, { ar: string; en: string }> = {
    missing_price_range: { ar: 'لا سعر', en: 'No price' },
    missing_unit_types: { ar: 'لا نوع وحدة', en: 'No unit type' },
    missing_area_range: { ar: 'لا مساحة', en: 'No area' },
    missing_bedroom_range: { ar: 'لا غرف', en: 'No bedrooms' },
    missing_unit_inventory: { ar: 'لا مخزون وحدات', en: 'No units' },
    missing_project_coordinates: { ar: 'لا إحداثيات', en: 'No coordinates' },
    legacy_text_match_only: { ar: 'مطابقة نصية فقط', en: 'Text match only' },
    requires_verification: { ar: 'يحتاج تحقّق', en: 'Verify' },
  };
  const e = map[code];
  return isAr ? e.ar : e.en;
}

function dimLabel(key: string, isAr: boolean): string {
  const map: Record<string, { ar: string; en: string }> = {
    location: { ar: 'الموقع', en: 'Location' },
    budget: { ar: 'الميزانية', en: 'Budget' },
    type: { ar: 'النوع', en: 'Type' },
    area: { ar: 'المساحة', en: 'Area' },
    bedrooms: { ar: 'الغرف', en: 'Bedrooms' },
    availability: { ar: 'التوفّر', en: 'Availability' },
    amenities: { ar: 'المرافق', en: 'Amenities' },
  };
  const e = map[key];
  return e ? (isAr ? e.ar : e.en) : key;
}

function localizedReason(item: SuggestionItem, isAr: boolean): string {
  const km = item.distance_km;
  switch (item.reason_code) {
    case 'exact_within_budget': return isAr ? 'مطابقة تامة للموقع وضمن الميزانية.' : 'Exact location match and within budget.';
    case 'exact_district': return isAr ? 'مطابقة تامة للحي المطلوب.' : 'Exact match for the requested district.';
    case 'nearby_distance': return isAr ? (km != null ? `قريب — حوالي ${km} كم من الحي المطلوب.` : 'بديل قريب في نفس المنطقة.') : (km != null ? `Nearby — about ${km} km from the requested district.` : 'Nearby alternative in the same area.');
    case 'budget_fit': return isAr ? 'سعر موثوق ضمن الميزانية.' : 'Reliable pricing that fits the budget.';
    case 'strong_location_over_budget': return isAr ? 'الموقع ممتاز لكن السعر أعلى من الميزانية — تأكد من المرونة.' : 'Strong location, but priced above budget — confirm flexibility.';
    case 'strong_location_no_price': return isAr ? 'مطابقة موقع قوية؛ بيانات السعر/الوحدات ناقصة — تحقّق قبل العرض.' : 'Strong location match; price/unit data missing — verify before offering.';
    case 'no_criteria': return isAr ? 'لا توجد تفضيلات محددة لهذا العميل — هذه مشاريع متاحة عامة وليست مطابقة لتفضيلاته.' : 'No preferences set for this client — general available inventory, not matched to them.';
    case 'fallback_verify': return isAr ? 'من القاعدة الموسّعة — تحقّق من التفاصيل قبل العرض.' : 'From the broad database — verify details before offering.';
    case 'fallback_weak': default: return isAr ? 'مطابقة جزئية — ملاءمة أضعف أو بيانات ناقصة.' : 'Partial match — weaker fit or missing data.';
  }
}
