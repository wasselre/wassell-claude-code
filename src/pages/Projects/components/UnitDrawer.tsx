import { useEffect, useState } from 'react';
import { X, ExternalLink, FileText, Loader2, Check, Download } from 'lucide-react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { canEditRecord, getFieldPermission } from '@/lib/permissions';
import { signViewUrls } from '@/lib/files/client';
import { isFileIdValue } from '@/pages/Records/components/useFileRowMap';
import { modelByName, fieldByCandidates, type ProjectView } from '@/lib/projects/projectView';
import type { UnitView } from '@/lib/projects/unitView';
import { buildUnitPdf, unitPdfFilename } from '@/lib/projects/unitsPdf';
import { downloadPdf, type ChatPdfContext } from '@/lib/projects/sendPdfToChat';
import SendUnitsPdfModal from '@/pages/Chats/components/SendUnitsPdfModal';

interface UnitDrawerProps {
  unit: UnitView | null;
  projectName?: string | null;
  isAr: boolean;
  /** Project view for the PDF header (from the inventory). */
  project?: ProjectView | null;
  /** Set → the drawer offers "Send unit PDF" into that conversation. */
  chatPdf?: ChatPdfContext | null;
  onClose: () => void;
}

const SAR = (n: number, isAr: boolean) => `${n.toLocaleString(isAr ? 'ar-SA' : 'en-US')} ${isAr ? 'ر.س' : 'SAR'}`;
const AED = (n: number, isAr: boolean) => `${n.toLocaleString(isAr ? 'ar-AE' : 'en-US')} ${isAr ? 'د.إ' : 'AED'}`;
const DASH = '—';

// ── Payment plans (from the unit's `payment_plans` table field) ─────────────
// A unit lists several developer plan cards; the same %-structure can recur at
// different prices (different offers). Group by structure so the drawer shows
// one compact row per structure with its price (range if it has several).
interface PlanRow {
  down?: number; before_handover?: number; on_handover?: number; after_handover?: number;
  price?: number; price_sar?: number;
}
const pnum = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
function planStructLabel(p: PlanRow, isAr: boolean): string {
  if (pnum(p.down) === 100 && pnum(p.before_handover) === 0 && pnum(p.on_handover) === 0)
    return isAr ? 'دفعة كاملة (كاش)' : 'Full payment (cash)';
  const parts: string[] = [];
  if (pnum(p.down) > 0) parts.push(`${pnum(p.down)}% ${isAr ? 'مقدم' : 'down'}`);
  if (pnum(p.before_handover) > 0) parts.push(`${pnum(p.before_handover)}% ${isAr ? 'إنشاء' : 'constr.'}`);
  if (pnum(p.on_handover) > 0) parts.push(`${pnum(p.on_handover)}% ${isAr ? 'تسليم' : 'handover'}`);
  if (pnum(p.after_handover) > 0) parts.push(`${pnum(p.after_handover)}% ${isAr ? 'بعد التسليم' : 'post'}`);
  return parts.join(' / ');
}
function groupUnitPlans(rows: PlanRow[], isAr: boolean) {
  const map = new Map<string, { sample: PlanRow; aeds: number[]; sars: number[] }>();
  for (const p of rows) {
    const key = `${pnum(p.down)}/${pnum(p.before_handover)}/${pnum(p.on_handover)}/${pnum(p.after_handover)}`;
    const g = map.get(key) ?? { sample: p, aeds: [], sars: [] };
    if (pnum(p.price) > 0) g.aeds.push(pnum(p.price));
    if (pnum(p.price_sar) > 0) g.sars.push(pnum(p.price_sar));
    map.set(key, g);
  }
  return [...map.values()]
    .map((g) => ({
      label: planStructLabel(g.sample, isAr),
      down: pnum(g.sample.down),
      minAed: g.aeds.length ? Math.min(...g.aeds) : 0,
      maxAed: g.aeds.length ? Math.max(...g.aeds) : 0,
      minSar: g.sars.length ? Math.min(...g.sars) : 0,
      maxSar: g.sars.length ? Math.max(...g.sars) : 0,
    }))
    .sort((a, b) => a.down - b.down);
}

/**
 * The unit's status (available / reserved / sold / under construction) as a
 * one-click editor. This is the fast path sales asks for — mark a unit sold
 * from the project page without opening its record form. Each click writes the
 * unit through `saveRecord` (optimistic-concurrency aware); the DB triggers
 * then recompute the project's unit rollups and Realtime pushes the new
 * counts back, so the KPI cards above follow on their own.
 *
 * Falls back to a plain badge when the model/field is missing, or when the
 * user may not edit this record or this field.
 */
function UnitStatusEditor({ unit, isAr }: { unit: UnitView; isAr: boolean }) {
  const { models, users, profiles, roles, currentUserId, previewProfileId, saveRecord, addToast } = useAppStore();
  const [savingValue, setSavingValue] = useState<string | null>(null);

  const unitsModel = modelByName(models, 'units');
  const statusField = fieldByCandidates(unitsModel, ['unit_status']);
  const options = statusField?.options ?? [];

  const currentBadge = unit.status
    ? <Badge label={isAr ? unit.status.label_ar : unit.status.label_en} color={unit.status.color ?? undefined} />
    : <span className="text-sm text-charcoal/40">{DASH}</span>;

  if (!unitsModel || !statusField || options.length === 0) return currentBadge;
  const editable =
    canEditRecord(currentUserId, users, profiles, roles, unitsModel, unit.raw, previewProfileId) &&
    getFieldPermission(currentUserId, users, profiles, unitsModel.id, statusField, previewProfileId) === 'editable';
  if (!editable) return currentBadge;

  const current = typeof unit.raw.data[statusField.name] === 'string'
    ? (unit.raw.data[statusField.name] as string)
    : '';

  const apply = async (value: string) => {
    if (value === current || savingValue) return;
    setSavingValue(value);
    try {
      const res = await saveRecord(
        {
          ...unit.raw,
          data: { ...unit.raw.data, [statusField.name]: value },
          updated_at: new Date().toISOString(),
        },
        // Pass the version we loaded with so a concurrent edit surfaces as a
        // conflict instead of silently overwriting the other writer.
        { expectedVersion: unit.raw.version ?? null },
      );
      if (res.status === 'conflict') {
        addToast(
          isAr ? 'تم تعديل هذه الوحدة في مكان آخر — أعد التحميل' : 'This unit was edited elsewhere — reload',
          'error',
        );
        return;
      }
      const label = options.find((o) => o.value === value);
      addToast(
        isAr
          ? `تم تحديث حالة الوحدة إلى «${label ? label.label_ar : value}»`
          : `Unit status set to “${label ? label.label_en : value}”`,
        'success',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(isAr ? `تعذّر حفظ الحالة: ${msg}` : `Could not save status: ${msg}`, 'error');
    } finally {
      setSavingValue(null);
    }
  };

  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const active = o.value === current;
        const busy = savingValue === o.value;
        const color = o.color ?? '#B8734F';
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => void apply(o.value)}
            disabled={savingValue !== null}
            aria-pressed={active}
            className="text-xs px-2 py-1 rounded-full border inline-flex items-center gap-1 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            style={
              active
                ? { backgroundColor: `${color}22`, borderColor: color, color }
                : { backgroundColor: 'transparent', borderColor: '#D4B89680', color: '#4A4E54' }
            }
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : active ? <Check size={12} /> : null}
            {isAr ? o.label_ar : o.label_en}
          </button>
        );
      })}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 text-sm border-b border-sand/30 last:border-0">
      <span className="text-charcoal/50">{label}</span>
      <span className="text-charcoal font-medium text-end">{value}</span>
    </div>
  );
}

export default function UnitDrawer({ unit, projectName, isAr, project, chatPdf, onClose }: UnitDrawerProps) {
  const addToast = useAppStore((s) => s.addToast);
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

  const [pdfOpen, setPdfOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  // Reset the send/download modal when switching units.
  useEffect(() => { setPdfOpen(false); }, [unit?.id]);

  const downloadUnit = async () => {
    if (!unit || !project || downloading) return;
    setDownloading(true);
    try {
      downloadPdf(await buildUnitPdf({ project, unit, isAr }), unitPdfFilename(project, unit));
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setDownloading(false);
    }
  };

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
              {unit.type && <Badge label={lab(unit.type)} color={unit.type.color ?? '#C09B5F'} />}
            </div>
          </div>
          <button onClick={onClose} className="text-charcoal/40 hover:text-charcoal p-1" aria-label="close"><X size={20} /></button>
        </div>

        <div className="p-4 space-y-5 flex-1">
          {/* Unit PDF — send this unit's one-pager to the client (in a chat) or
              download it. Needs the resolved project for the branded header. */}
          {project && (
            <div className="flex items-center gap-2">
              {chatPdf ? (
                <Button variant="primary" className="text-sm !py-1.5" onClick={() => setPdfOpen(true)}>
                  <FileText size={14} className="inline -mt-0.5 me-1" />
                  {isAr ? 'إرسال PDF للعميل' : 'Send unit PDF'}
                </Button>
              ) : (
                <Button variant="secondary" className="text-sm !py-1.5" disabled={downloading} onClick={() => void downloadUnit()}>
                  {downloading ? <Loader2 size={14} className="inline -mt-0.5 me-1 animate-spin" /> : <Download size={14} className="inline -mt-0.5 me-1" />}
                  {isAr ? 'تنزيل PDF الوحدة' : 'Download unit PDF'}
                </Button>
              )}
            </div>
          )}

          {/* Status — editable in place (one click to mark sold/reserved). */}
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-1.5">{isAr ? 'حالة الوحدة' : 'Unit status'}</h3>
            <UnitStatusEditor unit={unit} isAr={isAr} />
          </section>

          {/* Price */}
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-1">{isAr ? 'السعر' : 'Price'}</h3>
            <Row label={isAr ? 'السعر الإجمالي' : 'Total price'} value={unit.totalPrice !== null ? SAR(unit.totalPrice, isAr) : DASH} />
            <Row label={isAr ? 'سعر المتر' : 'Price / m²'} value={unit.pricePerM2 !== null ? SAR(unit.pricePerM2, isAr) : DASH} />
          </section>

          {/* Payment plans — grouped by structure; price shown per structure
            * (range when the same structure has several priced offers). */}
          {(() => {
            const rawPlans = (unit.raw?.data as Record<string, unknown> | undefined)?.payment_plans;
            const plans = groupUnitPlans(Array.isArray(rawPlans) ? (rawPlans as PlanRow[]) : [], isAr);
            if (plans.length === 0) return null;
            const priceLine = (min: number, max: number, fmt: (n: number, a: boolean) => string) =>
              min <= 0 && max <= 0 ? DASH : min === max ? fmt(min, isAr) : `${fmt(min, isAr)} — ${fmt(max, isAr)}`;
            return (
              <section>
                <h3 className="text-xs font-bold uppercase tracking-wide text-copper mb-1.5">
                  {isAr ? 'خطط السداد' : 'Payment Plans'}
                </h3>
                <div className="space-y-1.5">
                  {plans.map((p, i) => (
                    <div key={i} className="rounded-lg border border-sand/40 bg-cream/20 px-2.5 py-1.5">
                      <div className="text-[13px] font-medium text-charcoal">{p.label}</div>
                      <div className="text-xs text-charcoal/70 mt-0.5">{priceLine(p.minAed, p.maxAed, AED)}</div>
                      {p.minSar > 0 && (
                        <div className="text-[11px] text-charcoal/45">{priceLine(p.minSar, p.maxSar, SAR)}</div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })()}

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

      {/* Send/Download this unit's PDF (chat context). */}
      {pdfOpen && chatPdf && project && (
        <SendUnitsPdfModal
          open
          onClose={() => setPdfOpen(false)}
          chatWid={chatPdf.chatWid}
          clientName={chatPdf.clientName}
          clientPhone={chatPdf.clientPhone}
          title={isAr ? `وحدة ${unit.code ?? ''}`.trim() : `Unit ${unit.code ?? ''}`.trim()}
          subtitle={[projectName, unit.type ? (isAr ? unit.type.label_ar : unit.type.label_en) : null].filter(Boolean).join(isAr ? ' · ' : ' · ')}
          filename={unitPdfFilename(project, unit)}
          defaultCaption={
            isAr
              ? `تفاصيل الوحدة ${unit.code ?? ''} — ${projectName ?? ''}`.trim()
              : `Unit ${unit.code ?? ''} — ${projectName ?? ''}`.trim()
          }
          build={() => buildUnitPdf({ project, unit, isAr })}
        />
      )}
    </div>
  );
}
