import {
  Building2, MapPin, Wallet, Ruler, BedDouble, Bath, PackageCheck, AlertTriangle,
  ExternalLink, ShieldCheck, ShieldAlert, ShieldX, HelpCircle, ChevronDown,
  CheckSquare, Square, Send, KeyRound, HardHat, LayoutGrid,
} from 'lucide-react';
import { useState } from 'react';
import ProjectUnitsModal from './ProjectUnitsModal';
import type { FinderMatch, FinderBand, FinderMatchType, FinderSource, GeoStatus, OurFit } from '@/lib/matching/projectFinder';
import {
  resolveDeliveryStatus, deliveryLabel, formatHandoverMonth, type DeliveryKind,
} from '@/lib/matching/deliveryStatus';
import { dealBadgeLabel, dealBadgeTone, type DealBadge } from '@/lib/market/dealBadge';
import { CLIENT_OPTION_STATUS_META, CLIENT_OPTION_STATUS_ORDER, type ClientOptionStatus } from '@/lib/matching/clientOptions';
import type { ChatPdfContext } from '@/lib/projects/sendPdfToChat';
import { useSignedImage } from '@/lib/projects/useSignedImage';
import ContactAdvertiserButton from '@/components/market/ContactAdvertiserButton';
import QualityBadge from '@/components/market/QualityBadge';

/**
 * One project in the deterministic Project Finder modal (Phase 2). Renders ONLY
 * what /api/project-finder decided — score, band, match type, geography
 * verification (geo_status + geo_confidence), distance, key facts, data gaps,
 * mismatch warnings, and the deterministic explanation. The card NEVER scores.
 * Actions: bulk-select checkbox + Details + Save-to-options + Eliminate (or, if
 * the option is already saved, a status chip; if eliminated, Reactivate). The
 * card writes nothing itself — the parent modal owns all persistence.
 */

interface Props {
  item: FinderMatch;
  isAr: boolean;
  onOpenDetails: (item: FinderMatch) => void;
  /** Bulk-selection state for "Save selected to client options". */
  selected: boolean;
  onToggleSelect: (item: FinderMatch) => void;
  /** Single save of THIS card into the client's options. */
  onSaveOption: (item: FinderMatch) => void;
  onEliminate: (item: FinderMatch) => void;
  onReactivate: (item: FinderMatch) => void;
  saveState: 'idle' | 'saving' | 'saved';
  /** Status of an already-saved option for this source, or null if not saved yet. */
  existingStatus: ClientOptionStatus | null;
  /** Set/change this card's client-option status inline (main / presented / not
   *  interested / …). Ensures the option exists first. Omit → no status control. */
  onSetStatus?: (item: FinderMatch, status: ClientOptionStatus) => void;
  /** Send THIS project/listing to the connected client over WhatsApp — reuses
   *  the stored message if one exists, else starts the creation flow. The
   *  parent owns the flow modal. Omit → no send button. */
  onSendToClient?: (item: FinderMatch) => void;
  /** Jump to the MAP view and open/center THIS project's pin. Supplied only in
   *  list context (a map is available to switch to); omitted for the map's own
   *  selected-pin card and where the item has no coordinates. */
  onShowOnMap?: (item: FinderMatch) => void;
  /**
   * Standalone Project Finder (no client context): hide the select checkbox and
   * the save / eliminate / reactivate actions, leaving only "Details". Saving an
   * option requires a client to attach it to, which the standalone tool doesn't have.
   */
  hideClientActions?: boolean;
  /** When set (finder scoped to a client), the project's units popup lets the
   *  rep SEND the units-table + single-unit PDFs to the client, not just
   *  download them. Absent → download only. */
  chatPdf?: ChatPdfContext | null;
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

const UNIT_TYPE_AR: Record<string, string> = {
  apartment: 'شقة', apartments: 'شقة', flat: 'شقة', flats: 'شقة', penthouse: 'بنتهاوس',
  villa: 'فيلا', villas: 'فيلا', townhouse: 'تاون هاوس', townhouses: 'تاون هاوس',
  studio: 'استوديو', studios: 'استوديو', duplex: 'دوبلكس', duplexes: 'دوبلكس',
  floor: 'دور', floors: 'أدوار', land: 'أرض', lands: 'أرض', plot: 'أرض', plots: 'أرض',
};
const localizeUnitType = (v: string, isAr: boolean) => (isAr ? UNIT_TYPE_AR[v.trim().toLowerCase()] ?? v : v);

/** Deal-quality badge (Market Intelligence). Decision-support only — never ranking.
 *  'no_benchmark' is rendered silently (no segment) to avoid clutter; data gaps are
 *  already surfaced elsewhere on the card. */
function DealPill({ deal, isAr }: { deal: DealBadge; isAr: boolean }) {
  if (deal.kind === 'no_benchmark') return null;
  const tone = dealBadgeTone(deal.kind);
  const cls: Record<string, string> = {
    good: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    high: 'border-rose-200 bg-rose-50 text-rose-700',
    warn: 'border-amber-200 bg-amber-50 text-amber-700',
    neutral: 'border-sand/60 bg-cream/60 text-charcoal/70',
    unknown: 'border-sand/50 bg-white text-charcoal/50',
  };
  const pct = deal.vs_median_pct != null ? ` (${deal.vs_median_pct > 0 ? '+' : ''}${deal.vs_median_pct}%)` : '';
  const showPct = deal.kind === 'strong_value' || deal.kind === 'premium_price' || deal.kind === 'fair_market' || deal.kind === 'potential_value';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${cls[tone]}`}
      title={isAr ? (deal.asking_only ? 'مبني على الأسعار المعروضة' : '') : (deal.asking_only ? 'Based on asking prices' : '')}>
      {dealBadgeLabel(deal.kind, isAr)}{showPct ? pct : ''}
    </span>
  );
}

/**
 * Delivery readiness — "جاهز / Ready" vs "على الخارطة / Off-plan", and for
 * off-plan the expected handover month. Derived ONLY from the project's existing
 * `construction_status` / `project_status` / `handover_date` facts (see
 * `src/lib/matching/deliveryStatus.ts`); it never guesses "Ready".
 *
 * Unknown readiness renders a neutral "غير محدد" chip on catalog projects (a real
 * data-quality signal the rep should see) but nothing on market listings, where a
 * resale ad simply has no construction stage.
 */
function DeliveryPill({ facts, source, isAr }: { facts: Record<string, unknown>; source: FinderSource; isAr: boolean }) {
  const { kind, handoverDate } = resolveDeliveryStatus(facts);
  if (kind === 'unknown' && source === 'market_listings') return null;
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const handover = kind === 'off_plan' ? formatHandoverMonth(handoverDate, isAr) : null;
  const cls: Record<DeliveryKind, string> = {
    ready: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    off_plan: 'border-copper/40 bg-copper/10 text-terracotta',
    unknown: 'border-sand/60 bg-cream/50 text-charcoal/50',
  };
  const Icon = kind === 'ready' ? KeyRound : kind === 'off_plan' ? HardHat : HelpCircle;
  const title = kind === 'off_plan' && handoverDate
    ? L(`تاريخ التسليم المتوقع: ${handoverDate}`, `Expected handover date: ${handoverDate}`)
    : L('حالة التسليم', 'Delivery status');
  // Always SELF-LABELED — a bare "غير محدد" reads as a contextless "undetermined
  // what?" to the rep. Unknown → "حالة التسليم غير محددة"; off-plan with no date →
  // "موعد التسليم يُحدَّد لاحقًا" (normal for a project still under construction).
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${cls[kind]}`}
      title={title}
    >
      <Icon size={11} className="shrink-0" />
      {kind === 'unknown' ? L('حالة التسليم غير محددة', 'Delivery status unknown') : deliveryLabel(kind, isAr)}
      {kind === 'off_plan' && (
        <span className="font-semibold">
          {handover
            ? L(`· التسليم ${handover}`, `· handover ${handover}`)
            : L('· موعد التسليم يُحدَّد لاحقًا', '· handover date TBD')}
        </span>
      )}
    </span>
  );
}

const asCoord = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

export default function FinderCard({
  item, isAr, onOpenDetails, selected, onToggleSelect, saveState, existingStatus,
  onSetStatus, onSendToClient, onShowOnMap, hideClientActions, chatPdf,
}: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [showWhy, setShowWhy] = useState(false);
  const [showUnits, setShowUnits] = useState(false);
  const [imgError, setImgError] = useState(false);
  const f = item.facts;
  // Units belong to catalog projects (our_projects / all_projects); a single
  // market listing has none, so the "view units" affordance is projects-only.
  const hasUnits = item.source !== 'market_listings';
  // "Show on map" only makes sense when the pin can actually be placed.
  const hasCoords = asCoord(f.latitude) != null && asCoord(f.longitude) != null;
  // Main image: raw URL (market listings) or files.id (projects) → resolved to a
  // renderable URL by useSignedImage (passthrough / short-lived signed view URL).
  const imgUrl = useSignedImage(typeof f.image === 'string' && f.image ? f.image : null);

  const city = typeof f.city === 'string' ? f.city : '';
  const district = typeof f.district === 'string' ? f.district : '';
  const unitTypes = Array.isArray(f.unit_types)
    ? (f.unit_types as unknown[]).filter((x): x is string => typeof x === 'string').map((t) => localizeUnitType(t, isAr)).join('، ')
    : '';
  const cur = L('ر.س', 'SAR');
  const price = fmtRange(f.price_range, cur);
  const area = fmtRange(f.area_range, L('م²', 'm²'));
  const beds = fmtRange(f.bedroom_range, '');
  const baths = fmtRange(f.bathroom_range, '');
  const avail = typeof f.available_units === 'number' ? f.available_units : null;
  // عمر العقار (years; 0 = new). Market listings carry the parsed Aqar age;
  // catalog projects are stamped 0 (new-development stock).
  const unitAge = typeof f.unit_age === 'number' && Number.isFinite(f.unit_age) ? f.unit_age : null;
  const unitAgeText = unitAge == null ? null
    : unitAge <= 0 ? L('جديد', 'New')
    : unitAge === 1 ? L('سنة', '1 yr')
    : unitAge === 2 ? L('سنتين', '2 yrs')
    : L(`${unitAge} سنوات`, `${unitAge} yrs`);
  // Aqar ad id — only market listings carry it; shown as a small "@id" chip.
  const adId = item.source === 'market_listings' && typeof f.external_id === 'string' && f.external_id ? f.external_id : null;

  const requiresVerify = item.source !== 'our_projects';

  return (
    <div className="overflow-hidden rounded-xl border border-sand/50 bg-white shadow-sm">
      {/* Main image (listing photo / project hero). Hidden if none or load fails. */}
      {imgUrl && !imgError && (
        <div className="h-40 w-full overflow-hidden bg-cream">
          <img
            src={imgUrl}
            alt={item.project_name}
            loading="lazy"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover"
          />
        </div>
      )}
      {requiresVerify && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {item.source === 'market_listings'
              ? L('من إعلانات السوق الخارجية (غير موثّقة) — تحقّق قبل العرض.', 'From external market listings (unverified) — verify before offering.')
              : L('من قاعدة «كل المشاريع» (غير موثّقة) — تحقّق قبل العرض.', 'From the All Projects database (unverified) — verify before offering.')}
          </span>
        </div>
      )}

      {/* Title row */}
      <div className="flex items-center gap-2 border-b border-sand/30 px-3 py-2">
        {!hideClientActions && (
          <button
            type="button"
            onClick={() => onToggleSelect(item)}
            className={`shrink-0 transition ${selected ? 'text-copper' : 'text-charcoal/35 hover:text-charcoal/60'}`}
            aria-label={L('تحديد للحفظ', 'Select to save')}
            aria-pressed={selected}
            title={L('تحديد للحفظ ضمن خيارات العميل', 'Select to save into client options')}
          >
            {selected ? <CheckSquare size={17} /> : <Square size={17} />}
          </button>
        )}
        <Building2 size={15} className="shrink-0 text-charcoal/50" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold text-charcoal">{item.project_name}</div>
          <div className="flex items-center gap-1 truncate text-[11px] text-charcoal/55">
            <MapPin size={11} className="shrink-0 text-copper" />
            {[district, city].filter(Boolean).join(isAr ? '، ' : ', ') || L('الموقع غير محدد', 'Location not set')}
          </div>
        </div>
        <BandBadge band={item.match_band} score={item.score} isAr={isAr} />
      </div>

      <div className="space-y-2.5 p-3">
        {/* Match type + geography verification + distance */}
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Our portfolio is matched LOOSELY, so it shows an honest fit summary
              (location/budget/size) instead of the generic match-type pill. */}
          {item.source === 'our_projects' && item.our_fit
            ? <OurFitBadges fit={item.our_fit} isAr={isAr} />
            : <MatchTypePill type={item.match_type} isAr={isAr} />}
          {/* Ready (جاهز) vs off-plan (على الخارطة) + the expected handover date.
              Every result carries it; unknown reads as "غير محدد", never "ready". */}
          <DeliveryPill facts={f} source={item.source} isAr={isAr} />
          <SourcePill source={item.source} isAr={isAr} />
          {adId && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-chocolate/25 bg-chocolate/5 px-2 py-0.5 text-[11px] font-bold text-chocolate"
              title={L('رقم الإعلان', 'Ad ID')}
            >
              @{adId}
            </span>
          )}
          {/* Listing quality (market listings only) — display + tiebreak, never
              part of the match score. Renders nothing when facts carry no grade. */}
          {item.source === 'market_listings' && (
            <QualityBadge grade={f.quality_grade} score={f.quality_score} isAr={isAr} />
          )}
          {/* عمر العقار — shown for market listings (parsed Aqar age). The catalog's
              implicit "new" stamp is skipped to avoid a redundant chip on every card. */}
          {item.source === 'market_listings' && unitAgeText && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-sand/60 bg-cream/50 px-2 py-0.5 text-[11px] font-bold text-charcoal/75"
              title={L('عمر العقار', 'Unit age')}
            >
              {L(`العمر: ${unitAgeText}`, `Age: ${unitAgeText}`)}
            </span>
          )}
          {item.geo_status && <GeoStatusPill status={item.geo_status} isAr={isAr} />}
          {item.geo_confidence && <GeoConfidencePill confidence={item.geo_confidence} isAr={isAr} />}
          {/* The generic distance pill is redundant for our projects (OurFitBadges
              already carries the distance in its location badge). */}
          {item.distance_km != null && !(item.source === 'our_projects' && item.our_fit) && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-sand/60 bg-cream/50 px-2 py-0.5 text-[11px] text-charcoal/70"
              title={L('المسافة من أقرب منطقة مختارة', 'Distance from the nearest selected area')}
            >
              <MapPin size={11} className="text-copper" />
              {item.nearest_ref_name
                ? L(`~${item.distance_km} كم من ${item.nearest_ref_name}`, `~${item.distance_km} km from ${item.nearest_ref_name}`)
                : L(`~${item.distance_km} كم`, `~${item.distance_km} km`)}
            </span>
          )}
          {item.deal && <DealPill deal={item.deal} isAr={isAr} />}
        </div>

        {/* Deterministic explanation — HIDDEN for now (2026-08-23): the sentence
            just restates the badges + specs grid below (location/distance, price,
            availability), so it was noise, not value. The server still computes
            item.explanation; re-render this line to bring it back. */}

        {/* Mismatch warnings */}
        {item.mismatch_warnings.length > 0 && (
          <div className="space-y-1">
            {item.mismatch_warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[11px] text-red-700">
                <ShieldAlert size={12} className="mt-0.5 shrink-0" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}

        {/* Specs grid */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg bg-cream/30 p-2.5 text-xs">
          <Spec icon={<Wallet size={12} />} label={L('السعر', 'Price')} value={price} />
          <Spec icon={<PackageCheck size={12} />} label={L('وحدات متاحة', 'Available')} value={avail != null ? String(avail) : null} />
          <Spec icon={<Building2 size={12} />} label={L('النوع', 'Type')} value={unitTypes || null} />
          <Spec icon={<Ruler size={12} />} label={L('المساحة', 'Area')} value={area} />
          <Spec icon={<BedDouble size={12} />} label={L('الغرف', 'Bedrooms')} value={beds} />
          <Spec icon={<Bath size={12} />} label={L('دورات المياه', 'Bathrooms')} value={baths} />
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

        {/* Why (deterministic score breakdown) */}
        <button type="button" onClick={() => setShowWhy((v) => !v)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-copper hover:underline">
          <HelpCircle size={12} /> {L('لماذا هذا المشروع؟', 'Why this project?')}
          <ChevronDown size={12} className={`transition ${showWhy ? 'rotate-180' : ''}`} />
        </button>
        {showWhy && (
          <div className="space-y-1 rounded-lg border border-sand/40 bg-cream/30 p-2.5">
            {Object.entries(item.score_breakdown).filter(([, v]) => v != null).map(([k, v]) => (
              <div key={k} className="flex items-center justify-between text-[11px]">
                <span className="text-charcoal/60">{dimLabel(k, isAr)}</span>
                <span className="font-semibold text-charcoal/85">{Math.round((v as number) * 100)}%</span>
              </div>
            ))}
          </div>
        )}

        {/* Actions — Details + an inline STATUS selector that saves the option into
            the client's unified list AND sets its status (main / presented / not
            interested / …) in one step. Picking "Eliminated" routes to the
            reason-notes prompt. Hidden on the standalone finder (no client). */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <ActionBtn icon={<ExternalLink size={12} />} label={L('التفاصيل', 'Details')} onClick={() => onOpenDetails(item)} />

          {/* Jump to the map view and center this project's pin. */}
          {onShowOnMap && hasCoords && (
            <ActionBtn icon={<MapPin size={12} />} label={L('عرض على الخريطة', 'Show on map')} onClick={() => onShowOnMap(item)} />
          )}

          {/* All units of this project in a popup (catalog projects only). */}
          {hasUnits && (
            <ActionBtn icon={<LayoutGrid size={12} />} label={L('الوحدات', 'Units')} onClick={() => setShowUnits(true)} />
          )}

          {/* Send THIS project/listing to the connected client — the prepared
              WhatsApp message if one exists, else the creation flow, right from
              the card. Hidden on the standalone finder (no client). */}
          {!hideClientActions && onSendToClient && (
            <ActionBtn
              icon={<Send size={12} />}
              label={L('إرسال للعميل', 'Send to client')}
              onClick={() => onSendToClient(item)}
              primary
            />
          )}

          {/* Market listings only: contact the advertiser — opens the WhatsApp
              chat if the phone is already on the listing, else runs the REGA
              lookup and opens it when the number lands. Needs no client, so it
              also shows on the standalone finder. */}
          {item.source === 'market_listings' && (
            <ContactAdvertiserButton listingId={item.project_id} isAr={isAr} />
          )}

          {!hideClientActions && onSetStatus && (
            <StatusSelect
              value={existingStatus}
              saving={saveState === 'saving'}
              isAr={isAr}
              onChange={(s) => onSetStatus(item, s)}
            />
          )}
        </div>
      </div>

      {showUnits && <ProjectUnitsModal item={item} isAr={isAr} chatPdf={chatPdf} onClose={() => setShowUnits(false)} />}
    </div>
  );
}

function ActionBtn({ icon, label, onClick, active, disabled, primary }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean; disabled?: boolean; primary?: boolean }) {
  const base = 'inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-bold transition disabled:opacity-60';
  const cls = primary
    ? (active ? 'bg-green-100 text-green-700 border border-green-200' : 'bg-copper text-white hover:bg-terracotta')
    : 'border border-sand/60 bg-white text-charcoal/75 hover:bg-cream/60';
  return <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${cls}`}>{icon}{label}</button>;
}

/**
 * Inline client-option STATUS selector. Picking a status ensures the option
 * exists (creating it if needed) AND sets the chosen status in one step — so a
 * rep can mark a card as the Main Focus, Presented, Not Interested, etc. right
 * from the results. When nothing is saved yet it shows an "Add as option…"
 * placeholder; once saved it shows the current status colored to match its badge.
 * A native <select> keeps this RTL-safe (no custom-positioned chevron).
 */
function StatusSelect({
  value, saving, isAr, onChange,
}: {
  value: ClientOptionStatus | null;
  saving: boolean;
  isAr: boolean;
  onChange: (status: ClientOptionStatus) => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const meta = value ? CLIENT_OPTION_STATUS_META[value] : null;
  return (
    <select
      value={value ?? ''}
      disabled={saving}
      onChange={(e) => { const v = e.target.value; if (v) onChange(v as ClientOptionStatus); }}
      className="rounded-lg border px-2 py-1 text-[11px] font-bold transition disabled:opacity-60 focus:outline-none focus:ring-1 focus:ring-copper/40"
      style={meta
        ? { color: meta.color, borderColor: `${meta.color}66`, backgroundColor: `${meta.color}12` }
        : { color: '#8E6E52', borderColor: 'rgba(212,184,150,0.6)', backgroundColor: '#fff' }}
      title={L('حالة الخيار لدى العميل', 'Client option status')}
      aria-label={L('حالة الخيار', 'Option status')}
    >
      <option value="" disabled>
        {saving ? L('…', '…') : L('أضِف كخيار…', 'Add as option…')}
      </option>
      {CLIENT_OPTION_STATUS_ORDER.map((s) => (
        <option key={s} value={s}>
          {isAr ? CLIENT_OPTION_STATUS_META[s].ar : CLIENT_OPTION_STATUS_META[s].en}
        </option>
      ))}
    </select>
  );
}

function Spec({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | null }) {
  // Missing value → a quiet em-dash, NOT the words "not available". With the label
  // right above it ("السعر —") the rep instantly reads "no price" — no confusing
  // "undetermined what?" moment.
  return (
    <div className="flex items-start gap-1.5">
      <span className={`mt-0.5 shrink-0 ${value ? 'text-copper' : 'text-charcoal/25'}`}>{icon}</span>
      <div className="min-w-0">
        <div className="text-charcoal/50">{label}</div>
        {value
          ? <div className="break-words font-medium text-charcoal/90">{value}</div>
          : <div className="text-charcoal/30" aria-label="—">—</div>}
      </div>
    </div>
  );
}

function BandBadge({ band, score, isAr }: { band: FinderBand; score: number; isAr: boolean }) {
  const map: Record<FinderBand, { cls: string; ar: string; en: string }> = {
    strong: { cls: 'bg-green-100 text-green-700 border-green-200', ar: 'قوية', en: 'Strong' },
    good: { cls: 'bg-copper/15 text-copper border-copper/30', ar: 'جيدة', en: 'Good' },
    partial: { cls: 'bg-gray-100 text-gray-600 border-gray-200', ar: 'جزئية', en: 'Partial' },
    weak: { cls: 'bg-gray-50 text-gray-500 border-gray-200', ar: 'ضعيفة', en: 'Weak' },
  };
  const e = map[band];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${e.cls}`}>
      {isAr ? e.ar : e.en}<span className="opacity-70">· {score}</span>
    </span>
  );
}

/**
 * PREFERENTIAL-FIT badges for an our_projects card. Our portfolio is matched
 * loosely (location/budget/size no longer EXCLUDE — they become these honest
 * badges), so the rep sees every real matching project of ours and judges the
 * stretch. Green = on-target, amber = a stretch worth showing, gray = neutral.
 */
function OurFitBadges({ fit, isAr }: { fit: OurFit; isAr: boolean }) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const green = 'border-emerald-200 bg-emerald-50 text-emerald-700';
  const amber = 'border-amber-200 bg-amber-50 text-amber-700';
  const rose = 'border-rose-200 bg-rose-50 text-rose-700';
  const gray = 'border-sand/60 bg-cream/50 text-charcoal/60';
  const pill = (cls: string, text: string, key: string, icon?: React.ReactNode) => (
    <span key={key} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${cls}`}>
      {icon}{text}
    </span>
  );
  const geoIcon = <MapPin size={11} className="opacity-60" />;
  const km = fit.distance_km != null ? L(`~${fit.distance_km} كم`, `~${fit.distance_km} km`) : '';
  const out: React.ReactNode[] = [];

  // Location
  if (fit.location === 'in_area') out.push(pill(green, L('ضمن المنطقة المطلوبة', 'In requested area'), 'loc', geoIcon));
  else if (fit.location === 'nearby') out.push(pill(amber, [L('قريب', 'Nearby'), km].filter(Boolean).join(' · '), 'loc', geoIcon));
  else if (fit.location === 'same_city') out.push(pill(amber, [L('نفس المدينة · خارج المنطقة', 'Same city · outside area'), km].filter(Boolean).join(' · '), 'loc', geoIcon));
  else out.push(pill(gray, [L('خارج المنطقة', 'Outside area'), km].filter(Boolean).join(' · '), 'loc', geoIcon));

  // Budget (only when the client stated a budget)
  if (fit.budget === 'within') out.push(pill(green, L('ضمن الميزانية', 'Within budget'), 'bud'));
  else if (fit.budget === 'over') {
    const p = fit.budget_over_pct;
    const heavy = p != null && p > 15;
    out.push(pill(heavy ? rose : amber, p != null ? L(`أعلى من الميزانية +${p}%`, `Over budget +${p}%`) : L('أعلى من الميزانية', 'Over budget'), 'bud'));
  } else if (fit.budget === 'under') out.push(pill(gray, L('أقل من الميزانية', 'Under budget'), 'bud'));

  // Size (only when the client stated an area)
  if (fit.area === 'match') out.push(pill(green, L('المساحة مطابقة', 'Size matches'), 'area'));
  else if (fit.area === 'smaller') out.push(pill(amber, fit.area_gap_pct != null ? L(`المساحة أصغر −${fit.area_gap_pct}%`, `Smaller −${fit.area_gap_pct}%`) : L('المساحة أصغر', 'Smaller'), 'area'));
  else if (fit.area === 'larger') out.push(pill(amber, fit.area_gap_pct != null ? L(`المساحة أكبر +${fit.area_gap_pct}%`, `Larger +${fit.area_gap_pct}%`) : L('المساحة أكبر', 'Larger'), 'area'));

  return <>{out}</>;
}

function MatchTypePill({ type, isAr }: { type: FinderMatchType; isAr: boolean }) {
  const map: Record<FinderMatchType, { ar: string; en: string }> = {
    exact: { ar: 'مطابقة تامة', en: 'Exact' },
    nearby: { ar: 'قريب', en: 'Nearby' },
    same_city: { ar: 'نفس المدينة', en: 'Same city' },
    fallback: { ar: 'بديل', en: 'Fallback' },
  };
  const e = map[type];
  return <span className="inline-flex items-center rounded-full border border-copper/30 bg-copper/10 px-2 py-0.5 text-[11px] font-bold text-copper">{isAr ? e.ar : e.en}</span>;
}

function SourcePill({ source, isAr }: { source: FinderSource; isAr: boolean }) {
  const map: Record<FinderSource, { cls: string; ar: string; en: string }> = {
    our_projects: { cls: 'bg-green-600 text-white border-green-600', ar: 'مشاريعنا', en: 'Our Projects' },
    all_projects: { cls: 'bg-charcoal/70 text-white border-charcoal/70', ar: 'كل المشاريع', en: 'Listings DB' },
    market_listings: { cls: 'bg-chocolate text-white border-chocolate', ar: 'إعلانات السوق', en: 'Market' },
  };
  const e = map[source];
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold ${e.cls}`}>{isAr ? e.ar : e.en}</span>;
}

/** Geography boundary-verification status (the Phase-1 correctness signal). */
function GeoStatusPill({ status, isAr }: { status: GeoStatus; isAr: boolean }) {
  const map: Record<GeoStatus, { cls: string; icon: React.ReactNode; ar: string; en: string }> = {
    verified_match: { cls: 'bg-green-50 text-green-700 border-green-200', icon: <ShieldCheck size={11} />, ar: 'موقع موثّق بالإحداثيات', en: 'Coordinate-verified' },
    verified_derived: { cls: 'bg-green-50 text-green-700 border-green-200', icon: <ShieldCheck size={11} />, ar: 'حي مشتق من الإحداثيات', en: 'District from coords' },
    mismatch: { cls: 'bg-red-50 text-red-700 border-red-200', icon: <ShieldAlert size={11} />, ar: 'تعارض حي مخزّن', en: 'District mismatch' },
    outside_known_districts: { cls: 'bg-amber-50 text-amber-700 border-amber-200', icon: <ShieldAlert size={11} />, ar: 'خارج الحدود المعروفة', en: 'Outside boundaries' },
    unverified_no_coords: { cls: 'bg-amber-50 text-amber-700 border-amber-200', icon: <ShieldX size={11} />, ar: 'بدون إحداثيات', en: 'No coordinates' },
    no_geography: { cls: 'bg-gray-50 text-gray-500 border-gray-200', icon: <ShieldX size={11} />, ar: 'لا بيانات جغرافية', en: 'No geography' },
  };
  const e = map[status];
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${e.cls}`}>{e.icon}{isAr ? e.ar : e.en}</span>;
}

function GeoConfidencePill({ confidence, isAr }: { confidence: string; isAr: boolean }) {
  const map: Record<string, { cls: string; ar: string; en: string }> = {
    high: { cls: 'bg-green-50 text-green-700 border-green-200', ar: 'ثقة عالية', en: 'High geo' },
    medium: { cls: 'bg-amber-50 text-amber-700 border-amber-200', ar: 'ثقة متوسطة', en: 'Med geo' },
    low: { cls: 'bg-gray-50 text-gray-500 border-gray-200', ar: 'ثقة منخفضة', en: 'Low geo' },
  };
  const e = map[confidence] ?? map.low!;
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${e.cls}`}>{isAr ? e.ar : e.en}</span>;
}

function gapLabel(code: string, isAr: boolean): string {
  const map: Record<string, { ar: string; en: string }> = {
    missing_project_coordinates: { ar: 'لا إحداثيات', en: 'No coordinates' },
    district_mismatch: { ar: 'تعارض حي', en: 'District mismatch' },
    coordinates_outside_known_districts: { ar: 'خارج الحدود', en: 'Outside boundaries' },
    missing_geography: { ar: 'لا جغرافيا', en: 'No geography' },
    'no price data': { ar: 'لا سعر', en: 'No price' },
    'no unit type data': { ar: 'لا نوع وحدة', en: 'No unit type' },
    'no area data': { ar: 'لا مساحة', en: 'No area' },
    'no bedroom data': { ar: 'لا غرف', en: 'No bedrooms' },
    'no bathroom data': { ar: 'لا دورات مياه', en: 'No bathrooms' },
    'no availability data': { ar: 'لا مخزون', en: 'No inventory' },
  };
  return map[code] ? (isAr ? map[code]!.ar : map[code]!.en) : code;
}

function dimLabel(key: string, isAr: boolean): string {
  const map: Record<string, { ar: string; en: string }> = {
    location: { ar: 'الموقع', en: 'Location' },
    budget: { ar: 'الميزانية', en: 'Budget' },
    type: { ar: 'النوع', en: 'Type' },
    area: { ar: 'المساحة', en: 'Area' },
    bedrooms: { ar: 'الغرف', en: 'Bedrooms' },
    bathrooms: { ar: 'دورات المياه', en: 'Bathrooms' },
    availability: { ar: 'التوفّر', en: 'Availability' },
    amenities: { ar: 'المرافق', en: 'Amenities' },
  };
  return map[key] ? (isAr ? map[key]!.ar : map[key]!.en) : key;
}
