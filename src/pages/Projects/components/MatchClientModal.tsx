import { useState } from 'react';
import { Search, Sparkles } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import {
  fetchProjectFinder,
  FINDER_GROUP_KEYS,
  totalFinderMatches,
  type FinderResponse,
  type FinderGroupKey,
} from '@/lib/matching/projectFinder';
import { callProjectAi, finderCandidatesForNarration } from '@/lib/projects/projectAi';

interface MatchClientModalProps {
  open: boolean;
  onClose: () => void;
  isAr: boolean;
}

const GROUP_LABELS: Record<FinderGroupKey, { ar: string; en: string }> = {
  exact_district_matches: { ar: 'مطابقة الحي', en: 'Exact district' },
  nearby_district_matches: { ar: 'أحياء قريبة', en: 'Nearby districts' },
  same_city_matches: { ar: 'نفس المدينة', en: 'Same city' },
  broader_fallback: { ar: 'خيارات أوسع', en: 'Broader options' },
};

const BAND_COLOR: Record<string, string> = { strong: '#10B981', good: '#C09B5F', partial: '#F59E0B', weak: '#9CA3AF' };

/**
 * "Match client request" — collects requirements and runs the DETERMINISTIC
 * /api/project-finder (parse:false, explain:false). The engine returns ranked,
 * scored, boundary-verified candidates with deterministic per-card explanations.
 * The optional "AI summary" only NARRATES those results (match_explain) — it
 * cannot re-rank or add candidates.
 */
export default function MatchClientModal({ open, onClose, isAr }: MatchClientModalProps) {
  const [city, setCity] = useState('');
  const [district, setDistrict] = useState('');
  const [propertyType, setPropertyType] = useState('');
  const [budgetMin, setBudgetMin] = useState('');
  const [budgetMax, setBudgetMax] = useState('');
  const [bedrooms, setBedrooms] = useState('');
  const [busy, setBusy] = useState(false);
  const [resp, setResp] = useState<FinderResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiText, setAiText] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setErr(null);
    setResp(null);
    setAiText(null);
    try {
      const r = await fetchProjectFinder({
        requirements: {
          city: city.trim() || undefined,
          district: district.trim() || undefined,
          property_type: propertyType.trim() || undefined,
          budget_min: budgetMin ? Number(budgetMin) : undefined,
          budget_max: budgetMax ? Number(budgetMax) : undefined,
          bedrooms: bedrooms ? Number(bedrooms) : undefined,
        },
      });
      setResp(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const narrate = async () => {
    if (!resp) return;
    setAiBusy(true);
    setAiText(null);
    try {
      // Pass ONLY the deterministic results — the AI explains, never re-ranks.
      const candidates = finderCandidatesForNarration(resp);
      const text = await callProjectAi('match_explain', { requirements: resp.requirements, candidates }, isAr ? 'ar' : 'en');
      setAiText(text);
    } catch (e) {
      setAiText(e instanceof Error ? e.message : String(e));
    } finally {
      setAiBusy(false);
    }
  };

  const total = totalFinderMatches(resp);
  const inputCls = 'form-input text-sm';

  return (
    <Modal open={open} onClose={onClose} title={isAr ? 'مطابقة طلب عميل' : 'Match client request'} maxWidth="max-w-2xl">
      <div className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          <input className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} placeholder={isAr ? 'المدينة' : 'City'} />
          <input className={inputCls} value={district} onChange={(e) => setDistrict(e.target.value)} placeholder={isAr ? 'الحي' : 'District'} />
          <input className={inputCls} value={propertyType} onChange={(e) => setPropertyType(e.target.value)} placeholder={isAr ? 'نوع الوحدة' : 'Unit type'} />
          <input className={inputCls} type="number" value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)} placeholder={isAr ? 'الميزانية من' : 'Budget min'} />
          <input className={inputCls} type="number" value={budgetMax} onChange={(e) => setBudgetMax(e.target.value)} placeholder={isAr ? 'الميزانية إلى' : 'Budget max'} />
          <input className={inputCls} type="number" value={bedrooms} onChange={(e) => setBedrooms(e.target.value)} placeholder={isAr ? 'غرف النوم' : 'Bedrooms'} />
        </div>
        <Button variant="primary" onClick={run} disabled={busy}>
          <Search size={14} className="inline -mt-0.5 me-1" />
          {busy ? (isAr ? 'جارٍ البحث…' : 'Matching…') : (isAr ? 'بحث (محرك حتمي)' : 'Match (deterministic)')}
        </Button>

        {err && <p className="text-sm text-red-600">{err}</p>}

        {resp && (
          <div className="space-y-3 pt-2 border-t border-sand/40">
            {resp.metadata.needs_preferences ? (
              <p className="text-sm text-charcoal/60">{isAr ? 'أدخل تفضيلات العميل (الموقع/الميزانية/النوع).' : 'Enter client preferences (location/budget/type).'}</p>
            ) : total === 0 ? (
              <p className="text-sm text-charcoal/60">{isAr ? 'لا توجد مشاريع مطابقة.' : 'No matching projects.'}</p>
            ) : (
              <>
                {FINDER_GROUP_KEYS.map((k) =>
                  resp.groups[k].length === 0 ? null : (
                    <div key={k}>
                      <div className="text-xs font-bold uppercase tracking-wide text-charcoal/40 mb-1">{isAr ? GROUP_LABELS[k].ar : GROUP_LABELS[k].en}</div>
                      <div className="space-y-1.5">
                        {resp.groups[k].map((m) => (
                          <div key={m.project_id} className="bg-cream/60 rounded-lg p-2.5 border border-sand/40">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-bold text-charcoal text-sm">{m.project_name}</span>
                              <Badge label={`${m.match_band} · ${Math.round(m.score)}`} color={BAND_COLOR[m.match_band] ?? '#9CA3AF'} />
                            </div>
                            {m.explanation && <p className="text-xs text-charcoal/60 mt-1">{m.explanation}</p>}
                            {m.data_gaps.length > 0 && (
                              <p className="text-[11px] text-amber-600 mt-1">{isAr ? 'بيانات ناقصة: ' : 'Data gaps: '}{m.data_gaps.join('، ')}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ),
                )}
                <div className="pt-1">
                  <Button variant="secondary" className="text-sm" onClick={narrate} disabled={aiBusy}>
                    <Sparkles size={14} className="inline -mt-0.5 me-1" />
                    {aiBusy ? (isAr ? 'جارٍ الشرح…' : 'Explaining…') : (isAr ? 'شرح الذكاء الاصطناعي' : 'AI explanation')}
                  </Button>
                  {aiText && <div className="mt-2 bg-white rounded-lg p-3 text-sm text-charcoal whitespace-pre-wrap border border-sand/50">{aiText}</div>}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
