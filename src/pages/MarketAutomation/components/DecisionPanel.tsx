/**
 * Decision drawer — the operator rules on ONE field's meaning. Writes via the
 * source_field_decide RPC (upserts the mapping + resolves the gap). The publisher
 * is a separate gated step, so a decision here never auto-flows to market_listings.
 */
import { useEffect, useMemo, useState } from 'react';
import { X, AlertTriangle, ExternalLink } from 'lucide-react';
import Button from '@/components/ui/Button';
import { decideField, exampleList, coercePreview, fetchSampleListingUrls, type CoerceClass, type Disposition, type FieldStatus } from '@/lib/marketAutomation/client';

const OPTIONS: { id: Disposition; ar: string; en: string; hint_ar: string; hint_en: string }[] = [
  { id: 'mapped_existing_field', ar: 'مطابقة لحقل قائم', en: 'Map to existing field', hint_ar: 'نفس معنى حقل موجود في وصل', hint_en: 'Same meaning as an existing Wassell column' },
  { id: 'candidate_new_field', ar: 'حقل جديد (عالمي)', en: 'New universal field', hint_ar: 'مفهوم جديد يستحق عمودًا', hint_en: 'A genuinely new concept worth a column' },
  { id: 'reviewed_source_specific', ar: 'خاص بالمنصة', en: 'Platform-specific', hint_ar: 'بيانات خاصة بالمنصة تُحفظ كما هي', hint_en: 'Kept per-platform as-is' },
  { id: 'intentionally_ignored', ar: 'تجاهل', en: 'Ignore', hint_ar: 'لا نحتاجه', hint_en: 'Not needed' },
  { id: 'technical_excluded', ar: 'بيانات تقنية', en: 'Technical junk', hint_ar: 'قيمة تقنية داخلية', hint_en: 'Internal technical value' },
  { id: 'review_required', ar: 'تأجيل للمراجعة', en: 'Hold for review', hint_ar: 'غير واضح بعد', hint_en: 'Not understood yet' },
];
const NEEDS_REASON = new Set<Disposition>(['mapped_existing_field', 'candidate_new_field', 'review_required']);

export default function DecisionPanel({
  field, targetFields, targetTypes, isAr, onClose, onSaved,
}: {
  field: FieldStatus;
  targetFields: string[];
  targetTypes: Record<string, CoerceClass>;
  isAr: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<Disposition>((field.authoritative_status as Disposition) || 'mapped_existing_field');
  const [canonical, setCanonical] = useState<string>(field.canonical_field ?? '');
  const [reason, setReason] = useState<string>(field.reason ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sampleUrls, setSampleUrls] = useState<string[]>([]);

  useEffect(() => { fetchSampleListingUrls(field.platform, 6).then(setSampleUrls).catch(() => {}); }, [field.platform]);

  const targetCls = canonical ? targetTypes[canonical] : undefined;
  const typeMismatch = useMemo(
    () => status === 'mapped_existing_field' && targetCls === 'numeric'
      && field.raw_data_type != null && !['number', 'numeric', 'integer', 'float'].includes(field.raw_data_type),
    [status, targetCls, field.raw_data_type],
  );
  // Composed target (geography cascade, lookup, multi-value, mirror): a raw scalar
  // does not map into it — the app builds it (e.g. location from the district).
  const structuredWarn = status === 'mapped_existing_field' && (targetCls === 'location' || targetCls === 'structured');

  const valid = status !== 'mapped_existing_field' ? (!NEEDS_REASON.has(status) || reason.trim().length > 0)
    : (canonical.trim().length > 0 && reason.trim().length > 0);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      await decideField({
        platform: field.platform, source_path: field.source_path, status,
        canonical_field: status === 'mapped_existing_field' ? canonical : null,
        reason: reason.trim() || null,
      });
      onSaved(); onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="absolute inset-0 bg-charcoal/30" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white h-full shadow-xl overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-sand/40 sticky top-0 bg-white">
          <h2 className="text-sm font-semibold text-charcoal">{isAr ? 'قرار الحقل' : 'Field decision'}</h2>
          <button onClick={onClose} className="text-charcoal/40 hover:text-charcoal"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* evidence */}
          <div className="bg-sand/5 rounded-xl p-3">
            <div className="font-mono text-[13px] text-charcoal">{field.source_path}</div>
            {field.source_label && <div className="text-[12px] text-charcoal/50">{field.source_label}</div>}
            <div className="flex flex-wrap gap-1 mt-2">
              {exampleList(field.example_values, 6).map((ex, i) => (
                <span key={i} className="bg-white border border-sand/40 text-charcoal/70 text-[11px] px-1.5 py-0.5 rounded">{ex}</span>
              ))}
            </div>
            <div className="text-[11px] text-charcoal/45 mt-2">
              {isAr ? 'النوع' : 'type'}: <b>{field.raw_data_type ?? '—'}</b> · {isAr ? 'ظهر في' : 'seen in'} {field.occurrence_count ?? 0} · {field.page_section ?? '—'}
            </div>
          </div>

          {/* Open a real listing on the source platform to see the field in context. */}
          {sampleUrls.length > 0 && (
            <div className="rounded-xl border border-sand/40 p-3">
              <div className="text-[12px] text-charcoal/60 mb-2">
                {isAr ? `افتح إعلانًا حقيقيًا على ${field.platform} لرؤية الحقل في سياقه:` : `Open a real ${field.platform} listing to see the field in context:`}
              </div>
              <div className="flex flex-col gap-1.5">
                {sampleUrls.map((u, i) => (
                  <a key={i} href={u} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-[12px] text-copper hover:text-terracotta hover:underline truncate">
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate" dir="ltr">{decodeURIComponent(u.replace(/^https?:\/\//, ''))}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* disposition */}
          <div className="space-y-2">
            {OPTIONS.map((o) => (
              <label key={o.id} className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer ${status === o.id ? 'border-copper bg-copper/5' : 'border-sand/40 hover:bg-sand/5'}`}>
                <input type="radio" name="disp" checked={status === o.id} onChange={() => setStatus(o.id)} className="mt-1" />
                <div>
                  <div className="text-sm text-charcoal">{isAr ? o.ar : o.en}</div>
                  <div className="text-[11px] text-charcoal/45">{isAr ? o.hint_ar : o.hint_en}</div>
                </div>
              </label>
            ))}
          </div>

          {/* canonical picker */}
          {status === 'mapped_existing_field' && (
            <div>
              <label className="text-[12px] text-charcoal/60 block mb-1">{isAr ? 'الحقل المستهدف في وصل' : 'Target Wassell column'}</label>
              <select value={canonical} onChange={(e) => setCanonical(e.target.value)} className="form-input">
                <option value="">{isAr ? '— اختر —' : '— choose —'}</option>
                {targetFields.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              {typeMismatch && (
                <div className="flex items-start gap-1.5 text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-2 text-[12px]">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  {isAr ? `تحذير: نوع البيانات "${field.raw_data_type}" لا يبدو رقميًا لكن العمود المستهدف رقمي.` : `Warning: observed type "${field.raw_data_type}" isn't numeric but this target looks numeric.`}
                </div>
              )}
              {structuredWarn && (
                <div className="flex items-start gap-1.5 text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5 mt-2 text-[12px]">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  {targetCls === 'location'
                    ? (isAr
                        ? '«الموقع» حقلٌ جغرافي مركّب (مدينة/منطقة/حي) يبنيه التطبيق من الحي — لا يُملأ بنصٍّ خام. غالبًا الحقل الصحيح هو listing.district لا العنوان.'
                        : '“Location” is a composed geography field (city/region/district) the app builds from the district — a raw text value does NOT map here. The right source is usually listing.district, not the address.')
                    : (isAr
                        ? 'هذا حقلٌ مركّب (قائمة/بحث/متعدد) لا يُملأ بقيمة نصية مفردة مباشرة.'
                        : 'This is a composed field (multi-value / lookup) — a single raw scalar does not map directly into it.')}
                </div>
              )}
              {/* Live coerced preview: how real values would land in this column. */}
              {canonical && exampleList(field.example_values, 6).length > 0 && (
                <div className="mt-2 rounded-lg border border-sand/40 overflow-hidden">
                  <div className="text-[10px] uppercase text-charcoal/40 px-2.5 py-1 bg-sand/5">
                    {isAr ? `كيف ستظهر في «${canonical}»` : `How real values land in “${canonical}”`}
                  </div>
                  {exampleList(field.example_values, 6).map((ex, i) => {
                    const r = coercePreview(ex, targetTypes[canonical] ?? 'text');
                    return (
                      <div key={i} className="flex items-center justify-between gap-2 px-2.5 py-1 text-[12px] border-t border-sand/20">
                        <span className="font-mono text-charcoal/60 truncate max-w-[150px]">{ex}</span>
                        <span className="text-charcoal/30">→</span>
                        <span className={`font-mono truncate max-w-[130px] ${r.ok ? 'text-emerald-700' : 'text-rose-600'}`}>{r.out}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* reason */}
          <div>
            <label className="text-[12px] text-charcoal/60 block mb-1">
              {isAr ? 'السبب' : 'Reason'}{NEEDS_REASON.has(status) && <span className="text-rose-500"> *</span>}
            </label>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="form-input"
              placeholder={isAr ? 'لماذا هذا القرار؟' : 'Why this decision?'} />
          </div>

          {error && <div className="flex items-center gap-1.5 text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5 text-[12px]"><AlertTriangle className="w-3.5 h-3.5" />{error}</div>}
        </div>

        <div className="flex gap-2 px-5 py-4 border-t border-sand/40 sticky bottom-0 bg-white">
          <Button onClick={save} disabled={!valid || saving}>{saving ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'حفظ القرار' : 'Save decision')}</Button>
          <Button variant="secondary" onClick={onClose}>{isAr ? 'إلغاء' : 'Cancel'}</Button>
        </div>
      </div>
    </div>
  );
}
