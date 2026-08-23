// Rich detail for one Client Option — picture, a one-line summary, and the key
// facts (price, area, bedrooms, location, unit types…). Reads the option's
// snapshotted `data.facts` (the same shape FinderCard renders), so no re-run of
// the finder is needed. Opened from OptionsBrief when a rep taps an option.

import { useState } from 'react';
import { Wallet, Ruler, BedDouble, Bath, MapPin, Home, Building2, CalendarClock, Layers } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import { useAppStore } from '@/stores/appStore';
import { useSignedImage } from '@/lib/projects/useSignedImage';
import type { AppRecord } from '@/types';

const SOURCE_META: Record<string, { ar: string; en: string; color: string }> = {
  project: { ar: 'مشروع', en: 'Project', color: '#B8734F' },
  unit: { ar: 'وحدة', en: 'Unit', color: '#8E4E3A' },
  market_listing: { ar: 'إعلان سوق', en: 'Market listing', color: '#4A2C2A' },
};

const STATUS_META: Record<string, { ar: string; en: string; color: string }> = {
  main_focus: { ar: 'التركيز الرئيسي', en: 'Main focus', color: '#10B981' },
  reserved: { ar: 'محجوزة', en: 'Reserved', color: '#8E4E3A' },
  interested: { ar: 'مهتم', en: 'Interested', color: '#B8734F' },
  presented: { ar: 'تم العرض', en: 'Presented', color: '#3B82F6' },
  suitable: { ar: 'مناسبة', en: 'Suitable', color: '#C09B5F' },
  not_interested: { ar: 'غير مهتم', en: 'Not interested', color: '#8E4E3A' },
  closed: { ar: 'مغلقة', en: 'Closed', color: '#4A4E54' },
};

const UNIT_TYPE_AR: Record<string, string> = {
  apartment: 'شقة', apartments: 'شقة', flat: 'شقة', penthouse: 'بنتهاوس',
  villa: 'فيلا', villas: 'فيلا', townhouse: 'تاون هاوس', townhouses: 'تاون هاوس',
  studio: 'استوديو', duplex: 'دوبلكس', floor: 'دور', floors: 'أدوار', land: 'أرض', plot: 'أرض',
};
const localizeUnitType = (v: string, isAr: boolean) => (isAr ? UNIT_TYPE_AR[v.trim().toLowerCase()] ?? v : v);

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

function Spec({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-sand/40 bg-cream/30 px-3 py-2">
      <span className="mt-0.5 text-copper">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[11px] text-charcoal/50">{label}</span>
        <span className="block text-sm font-semibold text-chocolate">{value}</span>
      </span>
    </div>
  );
}

export default function OptionDetailModal({ option, onClose }: { option: AppRecord; onClose: () => void }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [imgError, setImgError] = useState(false);

  const d = option.data as Record<string, unknown>;
  const f = (d.facts as Record<string, unknown> | null) ?? {};
  const name = typeof d.source_name === 'string' ? d.source_name : '—';
  const sourceType = typeof d.source_type === 'string' ? d.source_type : '';
  const status = typeof d.status === 'string' ? d.status : '';
  const score = typeof d.match_score === 'number' ? d.match_score : Number(d.match_score) || null;

  const imgUrl = useSignedImage(typeof f.image === 'string' && f.image ? f.image : null);

  const city = typeof f.city === 'string' ? f.city : '';
  const district = typeof f.district === 'string' ? f.district : '';
  const location = [district, city].filter(Boolean).join('، ');
  const unitTypes = Array.isArray(f.unit_types)
    ? (f.unit_types as unknown[]).filter((x): x is string => typeof x === 'string').map((t) => localizeUnitType(t, isAr)).join('، ')
    : '';
  const cur = L('ر.س', 'SAR');
  const price = fmtRange(f.price_range, cur);
  const area = fmtRange(f.area_range, L('م²', 'm²'));
  const beds = fmtRange(f.bedroom_range, '');
  const baths = fmtRange(f.bathroom_range, '');
  const avail = typeof f.available_units === 'number' ? f.available_units : null;
  const unitAge = typeof f.unit_age === 'number' && Number.isFinite(f.unit_age) ? f.unit_age : null;
  const unitAgeText = unitAge == null ? null : unitAge <= 0 ? L('جديد', 'New') : L(`${unitAge} سنوات`, `${unitAge} yrs`);

  const summary = [unitTypes, location, price].filter(Boolean).join(' · ');
  const src = SOURCE_META[sourceType];
  const st = STATUS_META[status];

  const specs = [
    price ? { icon: <Wallet size={14} />, label: L('السعر', 'Price'), value: price } : null,
    area ? { icon: <Ruler size={14} />, label: L('المساحة', 'Area'), value: area } : null,
    beds ? { icon: <BedDouble size={14} />, label: L('غرف النوم', 'Bedrooms'), value: beds } : null,
    baths ? { icon: <Bath size={14} />, label: L('دورات المياه', 'Bathrooms'), value: baths } : null,
    location ? { icon: <MapPin size={14} />, label: L('الموقع', 'Location'), value: location } : null,
    unitTypes ? { icon: <Home size={14} />, label: L('نوع الوحدة', 'Unit type'), value: unitTypes } : null,
    unitAgeText ? { icon: <CalendarClock size={14} />, label: L('عمر العقار', 'Unit age'), value: unitAgeText } : null,
    avail != null ? { icon: <Layers size={14} />, label: L('وحدات متاحة', 'Available units'), value: String(avail) } : null,
  ].filter(Boolean) as Array<{ icon: React.ReactNode; label: string; value: string }>;

  return (
    <Modal open onClose={onClose} title={L('تفاصيل الخيار', 'Option details')} maxWidth="max-w-xl">
      <div className="space-y-4">
        {imgUrl && !imgError ? (
          <div className="h-48 w-full overflow-hidden rounded-xl bg-cream">
            <img src={imgUrl} alt={name} loading="lazy" onError={() => setImgError(true)} className="h-full w-full object-cover" />
          </div>
        ) : null}

        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-bold text-chocolate">{name}</h2>
            {src ? (
              <span className="badge inline-flex items-center gap-1" style={{ backgroundColor: `${src.color}1A`, color: src.color }}>
                <Building2 size={11} /> {isAr ? src.ar : src.en}
              </span>
            ) : null}
            {score != null ? <span className="text-xs font-semibold text-charcoal/50">{Math.round(score)}%</span> : null}
            {st ? (
              <span className="badge" style={{ backgroundColor: `${st.color}1A`, color: st.color }}>{isAr ? st.ar : st.en}</span>
            ) : null}
          </div>
          {summary ? <p className="mt-1 text-sm text-charcoal/70">{summary}</p> : null}
        </div>

        {specs.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {specs.map((s, i) => <Spec key={i} icon={s.icon} label={s.label} value={s.value} />)}
          </div>
        ) : (
          <p className="text-sm text-charcoal/60">
            {L('لا توجد تفاصيل محفوظة لهذا الخيار.', 'No saved details for this option.')}
          </p>
        )}
      </div>
    </Modal>
  );
}
