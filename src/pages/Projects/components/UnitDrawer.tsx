import { useEffect, useState } from 'react';
import { X, ExternalLink, FileText } from 'lucide-react';
import Badge from '@/components/ui/Badge';
import { signViewUrls } from '@/lib/files/client';
import { isFileIdValue } from '@/pages/Records/components/useFileRowMap';
import type { UnitView } from '@/lib/projects/unitView';

interface UnitDrawerProps {
  unit: UnitView | null;
  projectName?: string | null;
  isAr: boolean;
  onClose: () => void;
}

const SAR = (n: number, isAr: boolean) => `${n.toLocaleString(isAr ? 'ar-SA' : 'en-US')} ${isAr ? 'ر.س' : 'SAR'}`;
const DASH = '—';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 text-sm border-b border-sand/30 last:border-0">
      <span className="text-charcoal/50">{label}</span>
      <span className="text-charcoal font-medium text-end">{value}</span>
    </div>
  );
}

export default function UnitDrawer({ unit, projectName, isAr, onClose }: UnitDrawerProps) {
  // Resolve the plan image: it's a files.id UUID (private wassel-files bucket) →
  // batch-sign a view URL; legacy http values are used directly.
  const [planUrl, setPlanUrl] = useState<string | null>(null);
  const planValue = unit?.planImage ?? null;
  useEffect(() => {
    let alive = true;
    setPlanUrl(null);
    if (!planValue) return;
    if (/^https?:\/\//i.test(planValue)) { setPlanUrl(planValue); return; }
    if (isFileIdValue(planValue)) {
      signViewUrls([planValue])
        .then((m) => { if (alive) setPlanUrl(m[planValue] ?? null); })
        .catch((e) => { console.error('[UnitDrawer] failed to sign plan image url', e); });
    }
    return () => { alive = false; };
  }, [planValue]);

  if (!unit) return null;

  const lab = (o: { label_ar: string; label_en: string } | null) => (o ? (isAr ? o.label_ar : o.label_en) : DASH);

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <div className="flex-1 bg-charcoal/40" onClick={onClose} />
      <div className="w-full max-w-md bg-white h-full overflow-y-auto shadow-2xl flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-sand/50 flex items-start justify-between gap-3 sticky top-0 bg-white z-10">
          <div>
            <div className="text-lg font-bold text-charcoal">{unit.code ?? `#${unit.id.slice(0, 8)}`}</div>
            <div className="text-sm text-charcoal/50">{projectName ?? ''}</div>
            <div className="mt-1 flex gap-1.5">
              {unit.status && <Badge label={lab(unit.status)} color={unit.status.color ?? undefined} />}
              {unit.type && <Badge label={lab(unit.type)} color={unit.type.color ?? '#C09B5F'} />}
            </div>
          </div>
          <button onClick={onClose} className="text-charcoal/40 hover:text-charcoal p-1" aria-label="close"><X size={20} /></button>
        </div>

        <div className="p-4 space-y-5 flex-1">
          {/* Status & price */}
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-1">{isAr ? 'السعر' : 'Price'}</h3>
            <Row label={isAr ? 'السعر الإجمالي' : 'Total price'} value={unit.totalPrice !== null ? SAR(unit.totalPrice, isAr) : DASH} />
            <Row label={isAr ? 'سعر المتر' : 'Price / m²'} value={unit.pricePerM2 !== null ? SAR(unit.pricePerM2, isAr) : DASH} />
          </section>

          {/* Layout */}
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-1">{isAr ? 'التصميم' : 'Layout'}</h3>
            <Row label={isAr ? 'غرف النوم' : 'Bedrooms'} value={unit.bedrooms ?? DASH} />
            <Row label={isAr ? 'دورات المياه' : 'Bathrooms'} value={unit.bathrooms ?? DASH} />
            <Row label={isAr ? 'الطابق' : 'Floor'} value={lab(unit.floor)} />
            <Row label={isAr ? 'المصعد' : 'Elevator'} value={lab(unit.elevator)} />
          </section>

          {/* Areas */}
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-1">{isAr ? 'المساحات' : 'Areas'}</h3>
            <Row label={isAr ? 'مساحة الوحدة' : 'Unit area'} value={unit.area !== null ? `${unit.area} m²` : DASH} />
            <Row label={isAr ? 'المساحة الخاصة' : 'Private area'} value={unit.privateArea !== null ? `${unit.privateArea} m²` : DASH} />
            <Row label={isAr ? 'إجمالي المساحة' : 'Total area'} value={unit.totalArea !== null ? `${unit.totalArea} m²` : DASH} />
            <Row label={isAr ? 'مساحة الصك' : 'Deed area'} value={unit.deedArea !== null ? `${unit.deedArea} m²` : DASH} />
          </section>

          {/* Plan image */}
          {planUrl && (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-1">{isAr ? 'المخطط' : 'Plan'}</h3>
              <a href={planUrl} target="_blank" rel="noreferrer">
                <img src={planUrl} alt={isAr ? 'مخطط الوحدة' : 'Unit plan'} className="w-full rounded-lg border border-sand/50" loading="lazy" />
              </a>
            </section>
          )}

          {/* Components */}
          {unit.components.length > 0 && (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-1">{isAr ? 'المكونات' : 'Components'}</h3>
              <div className="flex flex-wrap gap-1">
                {unit.components.map((c) => (
                  <span key={c.value} className="text-[11px] px-1.5 py-0.5 rounded bg-cream text-charcoal/70 border border-sand/50">{lab(c)}</span>
                ))}
              </div>
            </section>
          )}

          {/* Location / building */}
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-1">{isAr ? 'الموقع والمبنى' : 'Location & Building'}</h3>
            <Row label={isAr ? 'رقم العمارة' : 'Building'} value={unit.building ?? DASH} />
            <Row label={isAr ? 'البلك' : 'Block'} value={unit.block ?? DASH} />
            <Row label={isAr ? 'عرض الشارع' : 'Street width'} value={unit.streetWidth ?? DASH} />
            {unit.locationLink && (
              <a href={unit.locationLink} target="_blank" rel="noreferrer" className="text-copper hover:underline text-sm inline-flex items-center gap-1 mt-1">
                <ExternalLink size={13} /> {isAr ? 'فتح الموقع' : 'Open location'}
              </a>
            )}
          </section>

          {/* Documents */}
          {(unit.unitBrochure || unit.projectBrochure) && (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-1">{isAr ? 'المستندات' : 'Documents'}</h3>
              <div className="space-y-1">
                {unit.unitBrochure && (
                  <a href={unit.unitBrochure} target="_blank" rel="noreferrer" className="text-copper hover:underline text-sm inline-flex items-center gap-1">
                    <FileText size={13} /> {isAr ? 'بروشور الوحدة' : 'Unit brochure'}
                  </a>
                )}
                {unit.projectBrochure && (
                  <a href={unit.projectBrochure} target="_blank" rel="noreferrer" className="text-copper hover:underline text-sm flex items-center gap-1">
                    <FileText size={13} /> {isAr ? 'بروشور المشروع' : 'Project brochure'}
                  </a>
                )}
              </div>
            </section>
          )}

          {/* Notes */}
          {unit.notes && (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-1">{isAr ? 'ملاحظات' : 'Notes'}</h3>
              <p className="text-sm text-charcoal/80 whitespace-pre-wrap">{unit.notes}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
