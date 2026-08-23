// OptionsBrief — a READ-ONLY memory aid showing the client's current property
// context at the top of the Follow-up Workspace: the main/focus option first (if
// one exists), then a couple of other live options. Eliminated options are never
// shown.
//
// Phase 1 scope is display only — no status changes, no "mark presented", no
// writes. The interactive Client Options lifecycle (presenting, eliminating,
// reactivating) stays where it already lives (clientOptions.ts + the finder /
// 360 surfaces) and is out of scope here.
//
// The read shape mirrors CallResultConfirmHost's optionCards: main_focus / is_main
// first, then highest match_score, capped small.

import { useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import OptionDetailModal from './OptionDetailModal';
import type { AppRecord } from '@/types';

/** Bilingual labels for the statuses we actually surface here (eliminated is excluded upstream). */
const STATUS_LABELS: Record<string, { ar: string; en: string; color: string }> = {
  main_focus: { ar: 'التركيز الرئيسي', en: 'Main focus', color: '#10B981' },
  reserved: { ar: 'محجوزة', en: 'Reserved', color: '#8E4E3A' },
  interested: { ar: 'مهتم', en: 'Interested', color: '#B8734F' },
  presented: { ar: 'تم العرض', en: 'Presented', color: '#3B82F6' },
  suitable: { ar: 'مناسبة', en: 'Suitable', color: '#C09B5F' },
  not_interested: { ar: 'غير مهتم', en: 'Not interested', color: '#8E4E3A' },
  closed: { ar: 'مغلقة', en: 'Closed', color: '#4A4E54' },
};

interface OptionCard {
  id: string;
  name: string;
  status: string | null;
  isMain: boolean;
  score: number | null;
}

interface OptionsBriefProps {
  clientId: string | null;
}

export default function OptionsBrief({ clientId }: OptionsBriefProps) {
  const { models, records, language } = useAppStore();
  const isAr = language === 'ar';
  const optionsModel = models.find((m) => m.name === 'client_property_options');
  const [openId, setOpenId] = useState<string | null>(null);
  const openOption = openId && optionsModel ? (records[optionsModel.id] ?? []).find((r) => r.id === openId) ?? null : null;

  const cards = useMemo<OptionCard[]>(() => {
    if (!optionsModel || !clientId) return [];
    const mine = (records[optionsModel.id] ?? []).filter(
      (r) => r.data.client_id === clientId && r.data.status !== 'eliminated',
    );
    const isMain = (r: AppRecord) => r.data.is_main === true || r.data.status === 'main_focus';
    const scoreOf = (r: AppRecord) =>
      typeof r.data.match_score === 'number' ? r.data.match_score : Number(r.data.match_score) || -1;
    // Main/focus first, then highest match_score. Keep it very small — a memory
    // aid, not the full Options tab.
    const sorted = [...mine].sort((a, b) => {
      if (isMain(a) !== isMain(b)) return isMain(a) ? -1 : 1;
      return scoreOf(b) - scoreOf(a);
    });
    return sorted.slice(0, 3).map((r) => ({
      id: r.id,
      name: String(r.data.source_name ?? '—'),
      status: (r.data.status as string) ?? null,
      isMain: isMain(r),
      score: typeof r.data.match_score === 'number' ? r.data.match_score : Number(r.data.match_score) || null,
    }));
  }, [optionsModel, records, clientId]);

  // Nothing to jog the rep's memory with — render nothing rather than an empty card.
  if (cards.length === 0) return null;

  return (
    <section className="card p-5">
      <h2 className="mb-3 text-sm font-bold text-chocolate">{isAr ? 'خيارات العميل' : 'Client Options'}</h2>
      <ul className="space-y-2">
        {cards.map((o) => {
          const label = o.status ? STATUS_LABELS[o.status] : null;
          return (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => setOpenId(o.id)}
                title={isAr ? 'عرض تفاصيل الخيار' : 'View option details'}
                className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-start transition hover:bg-cream ${
                  o.isMain ? 'border-[#10B981] bg-[#10B981]/10' : 'border-sand bg-white'
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-chocolate">{o.name}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {o.score != null ? <span className="text-xs text-charcoal/50">{Math.round(o.score)}%</span> : null}
                  {label ? (
                    <span className="badge" style={{ backgroundColor: `${label.color}1A`, color: label.color }}>
                      {isAr ? label.ar : label.en}
                    </span>
                  ) : null}
                  <ChevronLeft size={15} className={`text-charcoal/40 ${isAr ? '' : 'rotate-180'}`} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {openOption ? <OptionDetailModal option={openOption} onClose={() => setOpenId(null)} /> : null}
    </section>
  );
}
