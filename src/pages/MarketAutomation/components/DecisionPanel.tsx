/**
 * Decision review — a FULL-PAGE focus mode for ruling on one field's meaning at a
 * time. Writes via the source_field_decide RPC (upserts the mapping + resolves the
 * gap). The publisher is a separate gated step, so a decision here never
 * auto-flows to market_listings. Prev/Next walk the filtered list; a progress bar,
 * XP, streak and level make a long queue feel like progress, not a slog.
 */
import { useEffect, useMemo, useState } from 'react';
import { X, AlertTriangle, ExternalLink, ChevronLeft, ChevronRight, Flame, Star, Trophy, PartyPopper } from 'lucide-react';
import Button from '@/components/ui/Button';
import { decideField, exampleList, coercePreview, fetchSampleListingUrls, type SampleListing, type CoerceClass, type Disposition, type FieldStatus } from '@/lib/marketAutomation/client';

const OPTIONS: { id: Disposition; ar: string; en: string; hint_ar: string; hint_en: string; emoji: string }[] = [
  { id: 'mapped_existing_field', ar: 'مطابقة لحقل قائم', en: 'Map to existing field', hint_ar: 'نفس معنى حقل موجود في وصل', hint_en: 'Same meaning as an existing Wassell column', emoji: '🔗' },
  { id: 'candidate_new_field', ar: 'حقل جديد (عالمي)', en: 'New universal field', hint_ar: 'مفهوم جديد يستحق عمودًا', hint_en: 'A genuinely new concept worth a column', emoji: '✨' },
  { id: 'reviewed_source_specific', ar: 'خاص بالمنصة', en: 'Platform-specific', hint_ar: 'بيانات خاصة بالمنصة تُحفظ كما هي', hint_en: 'Kept per-platform as-is', emoji: '🏷️' },
  { id: 'intentionally_ignored', ar: 'تجاهل', en: 'Ignore', hint_ar: 'لا نحتاجه', hint_en: 'Not needed', emoji: '🚫' },
  { id: 'technical_excluded', ar: 'بيانات تقنية', en: 'Technical junk', hint_ar: 'قيمة تقنية داخلية', hint_en: 'Internal technical value', emoji: '⚙️' },
  { id: 'review_required', ar: 'تأجيل للمراجعة', en: 'Hold for review', hint_ar: 'غير واضح بعد', hint_en: 'Not understood yet', emoji: '⏳' },
];
const NEEDS_REASON = new Set<Disposition>(['mapped_existing_field', 'candidate_new_field', 'review_required']);

// Rank ladder — a bit of flavour keyed off session XP.
function levelFor(xp: number): { n: number; ar: string; en: string } {
  const n = Math.floor(xp / 50) + 1;
  const names = [
    { ar: 'مبتدئ', en: 'Rookie' }, { ar: 'مُنظِّم', en: 'Sorter' }, { ar: 'خبير الحقول', en: 'Field Expert' },
    { ar: 'محترف', en: 'Pro' }, { ar: 'أسطورة البيانات', en: 'Data Legend' },
  ];
  const nm = names[Math.min(n - 1, names.length - 1)] ?? { ar: 'محترف', en: 'Pro' };
  return { n, ar: nm.ar, en: nm.en };
}

export default function DecisionPanel({
  field, targetFields, targetTypes, targetLabels, isAr,
  hasNext, hasPrev, position, xp, streak, decided, total, needsReview,
  onClose, onDecided, onNext, onPrev,
}: {
  field: FieldStatus;
  targetFields: string[];
  targetTypes: Record<string, CoerceClass>;
  targetLabels: Record<string, { ar: string; en: string }>;
  isAr: boolean;
  hasNext: boolean;
  hasPrev: boolean;
  position: { at: number; of: number } | null;
  xp: number;
  streak: number;
  decided: number;
  total: number;
  needsReview: number;
  onClose: () => void;
  /** Optimistic in-place update of the just-decided row; returns XP earned. */
  onDecided: (patch: Partial<FieldStatus> & { platform: string; source_path: string }) => number;
  onNext: () => void;
  onPrev: () => void;
}) {
  const [status, setStatus] = useState<Disposition>((field.authoritative_status as Disposition) || 'mapped_existing_field');
  const [canonical, setCanonical] = useState<string>(field.canonical_field ?? '');
  const [reason, setReason] = useState<string>(field.reason ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sampleUrls, setSampleUrls] = useState<SampleListing[]>([]);
  const [tagLabel, setTagLabel] = useState<string>(field.source_label ?? '');
  // Pulse the XP badge when we arrive on a fresh card after a save (streak>0).
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    fetchSampleListingUrls(field.platform, field.canonical_field, 6).then(setSampleUrls).catch(() => {});
  }, [field.platform, field.canonical_field]);

  useEffect(() => {
    if (streak > 0) { setPulse(true); const t = setTimeout(() => setPulse(false), 700); return () => clearTimeout(t); }
  }, [streak, field.source_path]);

  // Keyboard: ← / → walk the queue (respecting RTL), Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if ((e.target as HTMLElement)?.tagName === 'TEXTAREA' || (e.target as HTMLElement)?.tagName === 'INPUT') return;
      const back = isAr ? 'ArrowRight' : 'ArrowLeft';
      const fwd = isAr ? 'ArrowLeft' : 'ArrowRight';
      if (e.key === back && hasPrev) onPrev();
      if (e.key === fwd && hasNext) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isAr, hasPrev, hasNext, onPrev, onNext, onClose]);

  const targetCls = canonical ? targetTypes[canonical] : undefined;
  const typeMismatch = useMemo(
    () => status === 'mapped_existing_field' && targetCls === 'numeric'
      && field.raw_data_type != null && !['number', 'numeric', 'integer', 'float'].includes(field.raw_data_type),
    [status, targetCls, field.raw_data_type],
  );
  const structuredWarn = status === 'mapped_existing_field' && (targetCls === 'location' || targetCls === 'structured');
  const isMulti = status === 'mapped_existing_field' && targetCls === 'multi';

  const valid = status !== 'mapped_existing_field' ? (!NEEDS_REASON.has(status) || reason.trim().length > 0)
    : (canonical.trim().length > 0 && reason.trim().length > 0);

  const save = async (advance: boolean) => {
    setSaving(true); setError(null);
    const canon = status === 'mapped_existing_field' ? canonical : null;
    try {
      await decideField({
        platform: field.platform, source_path: field.source_path, status,
        canonical_field: canon,
        transformation: isMulti ? (tagLabel.trim() || null) : null,
        reason: reason.trim() || null,
      });
      onDecided({
        platform: field.platform, source_path: field.source_path,
        authoritative_status: status, canonical_field: canon, reason: reason.trim() || null,
        ...(isMulti && tagLabel.trim() ? { source_label: tagLabel.trim() } : {}),
      });
      if (advance && hasNext) onNext();
      else onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const pct = total > 0 ? Math.round((decided / total) * 100) : 0;
  const complete = needsReview === 0;
  const level = levelFor(xp);
  const examples = exampleList(field.example_values, 8);
  const platAr = field.source_label ?? (field.canonical_field ? targetLabels[field.canonical_field]?.ar : null);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-cream" dir={isAr ? 'rtl' : 'ltr'}>
      {/* ── top bar: title, position, gamification, progress ── */}
      <div className="border-b border-sand/40 bg-white/80 backdrop-blur px-4 sm:px-6 py-3">
        <div className="max-w-5xl mx-auto flex items-center gap-3 flex-wrap">
          <button onClick={onClose} className="text-charcoal/40 hover:text-charcoal shrink-0" title={isAr ? 'إغلاق' : 'Close'}><X className="w-5 h-5" /></button>
          <h2 className="text-sm font-semibold text-charcoal">{isAr ? 'مراجعة الحقول' : 'Field review'}</h2>
          {position && <span className="text-[12px] text-charcoal/45 tabular-nums">{position.at} / {position.of}</span>}

          <div className="flex items-center gap-2 ms-auto">
            <span title={isAr ? 'المستوى' : 'Level'} className="flex items-center gap-1 bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-2.5 py-1 text-[12px] font-medium">
              <Trophy className="w-3.5 h-3.5" />{isAr ? level.ar : level.en}
            </span>
            <span title={isAr ? 'قرارات هذه الجلسة' : 'Decisions this session'} className="flex items-center gap-1 bg-orange-50 text-orange-600 border border-orange-200 rounded-full px-2.5 py-1 text-[12px] font-medium tabular-nums">
              <Flame className="w-3.5 h-3.5" />{streak}
            </span>
            <span title={isAr ? 'نقاط الخبرة' : 'XP'} className={`flex items-center gap-1 bg-copper/10 text-copper border border-copper/30 rounded-full px-2.5 py-1 text-[12px] font-bold tabular-nums transition-transform duration-300 ${pulse ? 'scale-125' : 'scale-100'}`}>
              <Star className="w-3.5 h-3.5" />{xp}
            </span>
          </div>
        </div>
        {/* progress */}
        <div className="max-w-5xl mx-auto mt-2.5 flex items-center gap-3">
          <div className="flex-1 h-2 rounded-full bg-sand/25 overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-500 ${complete ? 'bg-emerald-500' : 'bg-copper'}`} style={{ width: `${pct}%` }} />
          </div>
          <span className={`text-[12px] tabular-nums shrink-0 ${complete ? 'text-emerald-700 font-medium' : 'text-charcoal/50'}`}>
            {complete
              ? (isAr ? '🎉 اكتملت المراجعة!' : '🎉 All reviewed!')
              : (isAr ? `${decided} من ${total} مُقرَّرة` : `${decided} of ${total} decided`)}
          </span>
        </div>
      </div>

      {/* ── body ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto p-4 sm:p-6">
          {complete && (
            <div className="flex items-center gap-2 text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 mb-5 text-sm">
              <PartyPopper className="w-5 h-5 shrink-0" />
              {isAr ? 'لا حقول بانتظار قرار — أحسنت! يمكنك مراجعة قراراتك السابقة أو الإغلاق.' : 'No fields awaiting a decision — great work! You can revisit past decisions or close.'}
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-5">
            {/* left: evidence + real listings */}
            <div className="space-y-4">
              <div className="bg-white border border-sand/40 rounded-2xl p-5">
                {platAr && <div className="text-lg font-bold text-charcoal">{platAr}</div>}
                <div className="font-mono text-[13px] text-charcoal/55 mt-0.5">{field.source_path}</div>
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {examples.length === 0
                    ? <span className="text-[12px] text-charcoal/35">{isAr ? 'لا أمثلة بعد' : 'No examples yet'}</span>
                    : examples.map((ex, i) => (
                      <span key={i} className="bg-sand/15 border border-sand/40 text-charcoal/75 text-[12px] px-2 py-0.5 rounded">{ex}</span>
                    ))}
                </div>
                <div className="text-[12px] text-charcoal/45 mt-3 flex flex-wrap gap-x-3 gap-y-1">
                  <span>{isAr ? 'النوع' : 'type'}: <b className="text-charcoal/70">{field.raw_data_type ?? '—'}</b></span>
                  <span>{isAr ? 'ظهر في' : 'seen in'} <b className="text-charcoal/70">{field.occurrence_count ?? 0}</b></span>
                  <span>{field.page_section ?? '—'}</span>
                </div>
              </div>

              {sampleUrls.length > 0 && (
                <div className="bg-white border border-sand/40 rounded-2xl p-5">
                  <div className="text-[12px] text-charcoal/60 mb-2">
                    {field.canonical_field
                      ? (isAr ? `افتح إعلانات حقيقية على ${field.platform} تُظهر قيمًا مختلفة لهذا الحقل:` : `Open real ${field.platform} listings showing different values:`)
                      : (isAr ? `افتح إعلانًا حقيقيًا على ${field.platform} لرؤية الحقل في سياقه:` : `Open a real ${field.platform} listing to see the field in context:`)}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {sampleUrls.map((s, i) => (
                      <a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-[12px] text-copper hover:text-terracotta hover:underline">
                        <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                        {s.value != null && <span className="shrink-0 font-mono text-[11px] bg-copper/10 text-copper rounded px-1.5 py-0.5">{s.value.slice(0, 24)}</span>}
                        <span className="truncate" dir="ltr">{decodeURIComponent(s.url.replace(/^https?:\/\//, ''))}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* right: the decision */}
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-2">
                {OPTIONS.map((o) => (
                  <label key={o.id} className={`flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer transition-colors ${status === o.id ? 'border-copper bg-copper/5 ring-1 ring-copper/20' : 'border-sand/40 hover:bg-sand/5'}`}>
                    <input type="radio" name="disp" checked={status === o.id} onChange={() => setStatus(o.id)} className="mt-1" />
                    <span className="text-lg leading-none mt-0.5">{o.emoji}</span>
                    <div>
                      <div className="text-sm font-medium text-charcoal">{isAr ? o.ar : o.en}</div>
                      <div className="text-[11px] text-charcoal/45">{isAr ? o.hint_ar : o.hint_en}</div>
                    </div>
                  </label>
                ))}
              </div>

              {status === 'mapped_existing_field' && (
                <div>
                  <label className="text-[12px] text-charcoal/60 block mb-1">{isAr ? 'الحقل المستهدف في وصل' : 'Target Wassell column'}</label>
                  <select value={canonical} onChange={(e) => setCanonical(e.target.value)} className="form-input">
                    <option value="">{isAr ? '— اختر —' : '— choose —'}</option>
                    {targetFields.map((f) => {
                      const lbl = targetLabels[f];
                      return <option key={f} value={f}>{lbl?.ar ? `${lbl.ar} — ${f}` : f}</option>;
                    })}
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
                            : '“Location” is a composed geography field the app builds from the district — a raw text value does NOT map here. The right source is usually listing.district, not the address.')
                        : (isAr
                            ? 'هذا حقلٌ مركّب (بحث/مرآة) لا يُملأ بقيمة نصية مفردة مباشرة.'
                            : 'This is a composed field (lookup / mirror) — a single raw scalar does not map directly into it.')}
                    </div>
                  )}
                  {isMulti && (
                    <div className="mt-2 space-y-1.5">
                      <div className="flex items-start gap-1.5 text-[12px] text-charcoal/65 bg-copper/5 border border-copper/25 rounded-lg px-2.5 py-1.5">
                        <span>{isAr
                          ? 'حقلٌ متعدد القيم (قائمة): عدّة حقول تُوجَّه إليه، وكل حقل يُضيف وسمًا إلى القائمة عند تحقّقه. اكتب الوسم الذي يُضيفه هذا الحقل:'
                          : 'A multi-value collector: many fields feed it, each adding a tag when set. Enter the tag this field adds:'}</span>
                      </div>
                      <input value={tagLabel} onChange={(e) => setTagLabel(e.target.value)} className="form-input" placeholder={isAr ? 'مثال: حديقة خلفية' : 'e.g. Backyard'} />
                    </div>
                  )}
                  {canonical && examples.length > 0 && (
                    <div className="mt-2 rounded-lg border border-sand/40 overflow-hidden">
                      <div className="text-[10px] uppercase text-charcoal/40 px-2.5 py-1 bg-sand/5">
                        {isAr ? `كيف ستظهر في «${canonical}»` : `How real values land in “${canonical}”`}
                      </div>
                      {examples.slice(0, 6).map((ex, i) => {
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

              <div>
                <label className="text-[12px] text-charcoal/60 block mb-1">
                  {isAr ? 'السبب' : 'Reason'}{NEEDS_REASON.has(status) && <span className="text-rose-500"> *</span>}
                </label>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="form-input" placeholder={isAr ? 'لماذا هذا القرار؟' : 'Why this decision?'} />
              </div>

              {error && <div className="flex items-center gap-1.5 text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5 text-[12px]"><AlertTriangle className="w-3.5 h-3.5" />{error}</div>}
            </div>
          </div>
        </div>
      </div>

      {/* ── bottom nav ── */}
      <div className="border-t border-sand/40 bg-white px-4 sm:px-6 py-3">
        <div className="max-w-5xl mx-auto flex items-center gap-2">
          <Button variant="secondary" onClick={onPrev} disabled={!hasPrev || saving}>
            {isAr ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            {isAr ? 'السابق' : 'Prev'}
          </Button>
          <div className="flex-1" />
          {hasNext ? (
            <>
              <Button variant="secondary" onClick={() => save(false)} disabled={!valid || saving}>{isAr ? 'حفظ وإغلاق' : 'Save & close'}</Button>
              <Button onClick={() => save(true)} disabled={!valid || saving}>
                {saving ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'حفظ والتالي' : 'Save & Next')}
                {!saving && (isAr ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />)}
              </Button>
            </>
          ) : (
            <Button onClick={() => save(false)} disabled={!valid || saving}>
              {saving ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : (isAr ? 'حفظ القرار' : 'Save decision')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>{isAr ? 'إغلاق' : 'Close'}</Button>
        </div>
      </div>
    </div>
  );
}
