import { useState, type ReactNode } from 'react';
import {
  Building2, MapPin, Wallet, Ruler, BedDouble, Bath, PackageCheck,
  Sparkles, Megaphone, AlertTriangle, HelpCircle, Copy, Check, Trophy,
} from 'lucide-react';
import type {
  RecommendationPayload, ProjectRecommendation, MatchBand, RecommendationSpecs,
} from '@/lib/matching/recommendation';

/**
 * Renders a FINAL project-matching recommendation (emitted by the matching agent
 * via emit_recommendation) as a structured card: overall summary, then one panel
 * per ranked pick (name + band + score, why it matches, key specs, selling
 * points, the ready-to-say pitch with a copy button, a verification warning for
 * all_projects picks, and questions to ask the customer). Display-only — the
 * salesperson reads it live on the call.
 */
export default function ProjectMatchCard({
  payload,
  isAr,
}: {
  payload: RecommendationPayload;
  isAr: boolean;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);

  return (
    <div className="mt-2 w-full max-w-[88%] self-start rounded-2xl border border-copper/30 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-copper/10 border-b border-copper/20">
        <Trophy size={16} className="text-copper shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-charcoal">
            {L('أفضل المطابقات', 'Best matches')}
          </div>
          {payload.summary && (
            <div className="text-xs text-charcoal/60 truncate">{payload.summary}</div>
          )}
        </div>
      </div>

      <div className="p-3 space-y-3">
        {payload.recommendations.map((rec, i) => (
          <RecPanel key={rec.project_id ?? i} rec={rec} rank={i + 1} isAr={isAr} />
        ))}

        {/* Overall questions to ask the customer */}
        {payload.questions_to_ask.length > 0 && (
          <div className="rounded-lg border border-sand/40 bg-cream/30 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-charcoal/60 uppercase tracking-wider mb-1.5">
              <HelpCircle size={13} className="text-copper" />
              {L('أسئلة لطرحها على العميل', 'Questions to ask the customer')}
            </div>
            <ul className="space-y-1">
              {payload.questions_to_ask.map((q, i) => (
                <li key={i} className="text-sm text-charcoal/80 flex gap-1.5">
                  <span className="text-copper">•</span>
                  <span>{q}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function RecPanel({ rec, rank, isAr }: { rec: ProjectRecommendation; rank: number; isAr: boolean }) {
  const L = (ar: string, en: string) => (isAr ? ar : en);

  return (
    <div className="rounded-xl border border-sand/50 overflow-hidden">
      {/* Verification banner (all_projects) */}
      {rec.requires_verification && (
        <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>
            {rec.warning ||
              L(
                'من قاعدة "كل المشاريع" (غير موثّقة) — تحقّق من السعر والتوفر والتفاصيل قبل عرضها على العميل.',
                'From the All Projects database (unverified) — verify price, availability, and details before offering to the customer.',
              )}
          </span>
        </div>
      )}

      {/* Title row */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-sand/30">
        <span className="flex items-center justify-center w-5 h-5 rounded-full bg-copper/15 text-copper text-[11px] font-bold shrink-0">
          {rank}
        </span>
        <Building2 size={14} className="text-charcoal/50 shrink-0" />
        <div className="font-bold text-sm text-charcoal min-w-0 flex-1 truncate">{rec.project_name}</div>
        <BandBadge band={rec.match_band} score={rec.score} isAr={isAr} />
      </div>

      <div className="p-3 space-y-2.5">
        {/* Why it matches */}
        {rec.why && (
          <div className="text-sm text-charcoal/90">
            <span className="font-bold text-charcoal/70">{L('لماذا يناسب: ', 'Why it fits: ')}</span>
            {rec.why}
          </div>
        )}

        {/* Same-city note */}
        {rec.match_type === 'same_city' && (
          <div className="flex items-center gap-1.5 text-xs text-charcoal/60 italic">
            <MapPin size={12} className="text-copper" />
            {L('لا يوجد تطابق في الحي المطلوب — بديل في نفس المدينة.', 'No match in the requested district — a same-city alternative.')}
          </div>
        )}
        {rec.match_type === 'stretch' && (
          <div className="flex items-center gap-1.5 text-xs text-charcoal/60 italic">
            <Wallet size={12} className="text-copper" />
            {L('أعلى قليلاً من الميزانية (خيار توسّعي).', 'Slightly above budget (a stretch option).')}
          </div>
        )}

        {/* Specs */}
        <SpecGrid specs={rec.specs} isAr={isAr} />

        {/* Selling points */}
        {rec.selling_points.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-charcoal/60 uppercase tracking-wider mb-1">
              <Sparkles size={12} className="text-copper" />
              {L('نقاط البيع', 'Selling points')}
            </div>
            <ul className="space-y-0.5">
              {rec.selling_points.map((p, i) => (
                <li key={i} className="text-sm text-charcoal/80 flex gap-1.5">
                  <span className="text-copper">•</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Pitch */}
        {rec.pitch && <PitchBlock pitch={rec.pitch} isAr={isAr} />}

        {/* Missing info */}
        {rec.missing_info.length > 0 && (
          <div className="text-xs text-charcoal/60">
            <span className="font-bold">{L('للتأكيد مع العميل: ', 'Confirm with customer: ')}</span>
            {rec.missing_info.join(' · ')}
          </div>
        )}
      </div>
    </div>
  );
}

function BandBadge({ band, score, isAr }: { band: MatchBand; score: number; isAr: boolean }) {
  const map: Record<MatchBand, { cls: string; ar: string; en: string }> = {
    strong: { cls: 'bg-green-100 text-green-700 border-green-200', ar: 'مطابقة قوية', en: 'Strong' },
    good: { cls: 'bg-copper/15 text-copper border-copper/30', ar: 'مطابقة جيدة', en: 'Good' },
    partial: { cls: 'bg-gray-100 text-gray-600 border-gray-200', ar: 'مطابقة جزئية', en: 'Partial' },
  };
  const e = map[band];
  return (
    <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-bold ${e.cls}`}>
      {isAr ? e.ar : e.en}
      <span className="opacity-70">· {score}</span>
    </span>
  );
}

function SpecGrid({ specs, isAr }: { specs: RecommendationSpecs; isAr: boolean }) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const rows: Array<{ icon: ReactNode; label: string; value?: string }> = [
    { icon: <MapPin size={12} />, label: L('الموقع', 'Location'), value: [specs.district, specs.city].filter(Boolean).join('، ') || undefined },
    { icon: <Building2 size={12} />, label: L('النوع', 'Type'), value: specs.unit_types },
    { icon: <Wallet size={12} />, label: L('السعر', 'Price'), value: specs.price_range },
    { icon: <Ruler size={12} />, label: L('المساحة', 'Area'), value: specs.area_range },
    { icon: <BedDouble size={12} />, label: L('الغرف', 'Bedrooms'), value: specs.bedrooms },
    { icon: <Bath size={12} />, label: L('دورات المياه', 'Bathrooms'), value: specs.bathrooms },
    { icon: <PackageCheck size={12} />, label: L('وحدات متاحة', 'Available'), value: specs.available_units },
  ];
  const present = rows.filter((r) => r.value && r.value.trim() !== '');
  if (present.length === 0) return null;
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-lg bg-cream/30 p-2.5">
      {present.map((r, i) => (
        <div key={i} className="flex items-start gap-1.5 text-xs">
          <span className="text-copper mt-0.5 shrink-0">{r.icon}</span>
          <div className="min-w-0">
            <div className="text-charcoal/50">{r.label}</div>
            <div className="text-charcoal/90 font-medium break-words">{r.value}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PitchBlock({ pitch, isAr }: { pitch: string; isAr: boolean }) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(pitch);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (insecure context / permissions) — the
      // text is still visible to read aloud, so this is a non-fatal degrade.
      setCopied(false);
    }
  }

  return (
    <div className="rounded-lg border border-copper/30 bg-copper/5 p-2.5">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5 text-[11px] font-bold text-copper uppercase tracking-wider">
          <Megaphone size={12} />
          {L('قل للعميل', 'Say to the customer')}
        </div>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 text-[11px] text-charcoal/60 hover:text-copper transition-colors"
          title={L('نسخ', 'Copy')}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? L('تم النسخ', 'Copied') : L('نسخ', 'Copy')}
        </button>
      </div>
      <div className="text-sm text-charcoal whitespace-pre-wrap leading-relaxed">{pitch}</div>
    </div>
  );
}
