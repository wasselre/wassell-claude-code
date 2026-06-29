import { useState } from 'react';
import { X, ExternalLink, FileText, MessageCircle, Copy, Check } from 'lucide-react';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import { callProjectAi, unitFacts } from '@/lib/projects/projectAi';
import type { UnitView } from '@/lib/projects/unitView';

interface UnitDrawerProps {
  unit: UnitView | null;
  projectName?: string | null;
  isAr: boolean;
  onClose: () => void;
}

const SAR = (n: number, isAr: boolean) => `${n.toLocaleString(isAr ? 'ar-SA' : 'en-US')} ${isAr ? 'ر.س' : 'SAR'}`;
const NA = (isAr: boolean) => (isAr ? 'غير متوفر' : 'N/A');

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 text-sm border-b border-sand/30 last:border-0">
      <span className="text-charcoal/50">{label}</span>
      <span className="text-charcoal font-medium text-end">{value}</span>
    </div>
  );
}

export default function UnitDrawer({ unit, projectName, isAr, onClose }: UnitDrawerProps) {
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  const [aiErr, setAiErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (!unit) return null;

  const dash = NA(isAr);
  const lab = (o: { label_ar: string; label_en: string } | null) => (o ? (isAr ? o.label_ar : o.label_en) : dash);

  const genWhatsapp = async () => {
    setAiBusy(true);
    setAiErr(null);
    setAiMsg(null);
    try {
      const facts = { project: projectName ?? null, unit: unitFacts(unit, isAr) };
      const result = await callProjectAi('whatsapp', facts, isAr ? 'ar' : 'en');
      setAiMsg(result);
    } catch (e) {
      setAiErr(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(false);
    }
  };

  const copy = async () => {
    if (!aiMsg) return;
    await navigator.clipboard.writeText(aiMsg);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

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
            <Row label={isAr ? 'السعر الإجمالي' : 'Total price'} value={unit.totalPrice !== null ? SAR(unit.totalPrice, isAr) : dash} />
            <Row label={isAr ? 'سعر المتر' : 'Price / m²'} value={unit.pricePerM2 !== null ? SAR(unit.pricePerM2, isAr) : dash} />
          </section>

          {/* Layout */}
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-1">{isAr ? 'التصميم' : 'Layout'}</h3>
            <Row label={isAr ? 'غرف النوم' : 'Bedrooms'} value={unit.bedrooms ?? dash} />
            <Row label={isAr ? 'دورات المياه' : 'Bathrooms'} value={unit.bathrooms ?? dash} />
            <Row label={isAr ? 'الطابق' : 'Floor'} value={lab(unit.floor)} />
            <Row label={isAr ? 'المصعد' : 'Elevator'} value={lab(unit.elevator)} />
          </section>

          {/* Areas */}
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-1">{isAr ? 'المساحات' : 'Areas'}</h3>
            <Row label={isAr ? 'مساحة الوحدة' : 'Unit area'} value={unit.area !== null ? `${unit.area} m²` : dash} />
            <Row label={isAr ? 'المساحة الخاصة' : 'Private area'} value={unit.privateArea !== null ? `${unit.privateArea} m²` : dash} />
            <Row label={isAr ? 'إجمالي المساحة' : 'Total area'} value={unit.totalArea !== null ? `${unit.totalArea} m²` : dash} />
            <Row label={isAr ? 'مساحة الصك' : 'Deed area'} value={unit.deedArea !== null ? `${unit.deedArea} m²` : dash} />
          </section>

          {/* Plan image */}
          {unit.planImage && (
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-1">{isAr ? 'المخطط' : 'Plan'}</h3>
              <img src={unit.planImage} alt="plan" className="w-full rounded-lg border border-sand/50" loading="lazy" />
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
            <Row label={isAr ? 'رقم العمارة' : 'Building'} value={unit.building ?? dash} />
            <Row label={isAr ? 'البلك' : 'Block'} value={unit.block ?? dash} />
            <Row label={isAr ? 'عرض الشارع' : 'Street width'} value={unit.streetWidth ?? dash} />
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

          {/* AI actions */}
          <section className="pt-2 border-t border-sand/40">
            <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-2">{isAr ? 'إجراءات الذكاء الاصطناعي' : 'AI Actions'}</h3>
            <Button variant="secondary" onClick={genWhatsapp} disabled={aiBusy} className="text-sm">
              <MessageCircle size={14} className="inline -mt-0.5 me-1" />
              {aiBusy ? (isAr ? 'جارٍ الإنشاء…' : 'Generating…') : (isAr ? 'رسالة واتساب' : 'WhatsApp message')}
            </Button>
            {aiErr && <p className="mt-2 text-sm text-red-600">{aiErr}</p>}
            {aiMsg && (
              <div className="mt-2">
                <div className="bg-cream rounded-lg p-3 text-sm text-charcoal whitespace-pre-wrap border border-sand/50">{aiMsg}</div>
                <button onClick={copy} className="mt-1 text-xs text-copper hover:underline inline-flex items-center gap-1">
                  {copied ? <><Check size={12} /> {isAr ? 'تم النسخ' : 'Copied'}</> : <><Copy size={12} /> {isAr ? 'نسخ' : 'Copy'}</>}
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
