import { GitCompareArrows, Trophy, AlertTriangle, Check } from 'lucide-react';
import type { ComparisonPayload, ComparisonProject } from '@/lib/matching/cards';

/**
 * Renders a project comparison (emit_comparison) as a side-by-side card with a
 * verdict. Deterministic scores/bands come from compare_projects. Rendered inside
 * the Sales Assistant chat, beneath the assistant message.
 */
export default function ComparisonCard({ payload, isAr }: { payload: ComparisonPayload; isAr: boolean }) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const specKeys = Array.from(
    payload.projects.reduce((set, p) => {
      Object.keys(p.specs).forEach((k) => set.add(k));
      return set;
    }, new Set<string>()),
  );
  const SPEC_LABEL: Record<string, { ar: string; en: string }> = {
    district: { ar: 'الموقع', en: 'Location' }, city: { ar: 'المدينة', en: 'City' },
    unit_types: { ar: 'النوع', en: 'Type' }, price_range: { ar: 'السعر', en: 'Price' },
    area_range: { ar: 'المساحة', en: 'Area' }, bedrooms: { ar: 'الغرف', en: 'Bedrooms' },
    bathrooms: { ar: 'دورات المياه', en: 'Bathrooms' }, available_units: { ar: 'المتاح', en: 'Available' },
  };

  return (
    <div className="mt-2 w-full max-w-[88%] self-start rounded-2xl border border-copper/30 bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-copper/10 border-b border-copper/20">
        <GitCompareArrows size={16} className="text-copper shrink-0" />
        <div className="text-sm font-bold text-charcoal">{payload.title || L('مقارنة المشاريع', 'Project comparison')}</div>
      </div>

      <div className="p-3 space-y-3">
        {payload.customer_need && (
          <div className="text-xs text-charcoal/60">{L('احتياج العميل: ', 'Customer need: ')}{payload.customer_need}</div>
        )}

        <div className="overflow-x-auto rounded-lg border border-sand/50">
          <table className="w-full text-xs">
            <thead className="bg-cream/50 border-b border-sand/40">
              <tr>
                <th className="text-start px-2.5 py-1.5 text-[10px] font-bold text-charcoal/50 uppercase">{L('البند', 'Field')}</th>
                {payload.projects.map((p) => (
                  <th key={p.project_id ?? p.project_name} className="text-start px-2.5 py-1.5">
                    <div className="flex items-center gap-1 font-bold text-charcoal">
                      {payload.recommended_project_id && p.project_id === payload.recommended_project_id && (
                        <Trophy size={11} className="text-copper" />
                      )}
                      <span>{p.project_name}</span>
                    </div>
                    {p.requires_verification && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] text-amber-700">
                        <AlertTriangle size={9} /> {L('يحتاج تحقق', 'verify')}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {payload.projects.some((p) => p.score != null) && (
                <Row label={L('التقييم', 'Fit')} projects={payload.projects} render={(p) =>
                  p.score != null ? <BandPill band={p.match_band} score={p.score} isAr={isAr} /> : '—'} />
              )}
              {specKeys.map((k) => (
                <Row key={k} label={SPEC_LABEL[k] ? L(SPEC_LABEL[k].ar, SPEC_LABEL[k].en) : k}
                  projects={payload.projects} render={(p) => p.specs[k] ?? '—'} />
              ))}
            </tbody>
          </table>
        </div>

        {/* strengths / weaknesses */}
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(payload.projects.length, 3)}, minmax(0,1fr))` }}>
          {payload.projects.map((p) => (
            <div key={(p.project_id ?? p.project_name) + '-sw'} className="rounded-lg bg-cream/30 p-2 text-[11px]">
              <div className="font-bold text-charcoal/80 mb-1 truncate">{p.project_name}</div>
              {p.strengths.map((s, i) => (
                <div key={'s' + i} className="flex gap-1 text-green-700"><span>+</span><span>{s}</span></div>
              ))}
              {p.weaknesses.map((s, i) => (
                <div key={'w' + i} className="flex gap-1 text-charcoal/50"><span>−</span><span>{s}</span></div>
              ))}
            </div>
          ))}
        </div>

        {payload.verdict && (
          <div className="rounded-lg border border-copper/30 bg-copper/5 p-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-copper uppercase tracking-wider mb-0.5">
              <Check size={12} /> {L('التوصية', 'Verdict')}
            </div>
            <div className="text-sm text-charcoal whitespace-pre-wrap">{payload.verdict}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, projects, render }: { label: string; projects: ComparisonProject[]; render: (p: ComparisonProject) => React.ReactNode }) {
  return (
    <tr className="border-b border-sand/25 last:border-0 align-top">
      <td className="px-2.5 py-1.5 text-charcoal/50 whitespace-nowrap">{label}</td>
      {projects.map((p) => (
        <td key={(p.project_id ?? p.project_name) + label} className="px-2.5 py-1.5 text-charcoal/90">{render(p)}</td>
      ))}
    </tr>
  );
}

function BandPill({ band, score, isAr }: { band?: 'strong' | 'good' | 'partial'; score: number; isAr: boolean }) {
  const map = {
    strong: { cls: 'bg-green-100 text-green-700', ar: 'قوية', en: 'Strong' },
    good: { cls: 'bg-copper/15 text-copper', ar: 'جيدة', en: 'Good' },
    partial: { cls: 'bg-gray-100 text-gray-600', ar: 'جزئية', en: 'Partial' },
  } as const;
  const e = map[band ?? 'partial'];
  return <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${e.cls}`}>{isAr ? e.ar : e.en} · {score}</span>;
}
