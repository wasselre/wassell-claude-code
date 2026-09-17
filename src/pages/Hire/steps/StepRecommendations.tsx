import { useEffect, useRef, useState } from 'react';
import {
  MapPin, Wallet, Ruler, BedDouble, PackageCheck, Loader2, Eye, Send,
} from 'lucide-react';
import { Screen, SourcePill, BandBadge, OffPlanPill, Spec, ProjectImage } from '../hireUi';
import { RECOMMENDATIONS, JOURNEY_FILTERS, type ProjectCard } from '../hireScenario';

/** Step 2 — Wassel matches the preferences to projects (~5s), then shows cards. */
export default function StepRecommendations() {
  const [phase, setPhase] = useState<'searching' | 'done'>('searching');
  const started = useRef(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !started.current) {
        started.current = true;
        setTimeout(() => setPhase('done'), 2200);
      }
    }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref}>
      <Screen
        title="المشاريع المرشّحة"
        icon={<PackageCheck size={16} />}
        right={
          <div className="hidden flex-wrap items-center gap-1.5 sm:flex">
            {JOURNEY_FILTERS.map((f) => (
              <span key={f} className="rounded-full bg-copper/10 px-2 py-0.5 text-[11px] font-semibold text-copper">{f}</span>
            ))}
          </div>
        }
      >
        {phase === 'searching' ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <Loader2 size={34} className="animate-spin text-copper" />
            <div className="text-base font-bold text-chocolate">وصل يطابق تفضيلات العميل…</div>
            <div className="text-sm text-charcoal/55">يفحص 312 مشروعًا ووحداتها المتاحة</div>
            <div className="mt-1 h-2 w-64 overflow-hidden rounded-full bg-sand/40">
              <div className="h-full animate-[hire-bar_2.2s_ease-in-out_forwards] rounded-full bg-gradient-to-r from-gold to-copper" />
            </div>
          </div>
        ) : (
          <div className="hire-fade space-y-5">
            <SectionLabel ours>مشاريعنا</SectionLabel>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {RECOMMENDATIONS.filter((r) => r.source === 'ours').map((r) => <Card key={r.id} r={r} />)}
            </div>
            <SectionLabel>خيارات أخرى</SectionLabel>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {RECOMMENDATIONS.filter((r) => r.source === 'general').map((r) => <Card key={r.id} r={r} />)}
            </div>
          </div>
        )}
      </Screen>
    </div>
  );
}

function SectionLabel({ children, ours }: { children: string; ours?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`rounded-full px-3 py-1 text-sm font-bold ${ours ? 'bg-green-600 text-white' : 'bg-sand/40 text-charcoal/60'}`}>{children}</span>
      <span className="h-px flex-1 bg-sand/40" />
    </div>
  );
}

function Card({ r }: { r: ProjectCard }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-sand/50 bg-white shadow-md">
      <div className="relative h-44 w-full">
        <ProjectImage variant={r.image} className="h-full w-full" />
        <div className="absolute bottom-2 start-2 flex flex-wrap gap-1.5">
          <SourcePill source={r.source} />
          {r.offPlan && <OffPlanPill />}
        </div>
        <div className="absolute top-2 end-2">
          <BandBadge band={r.band} score={r.score} />
        </div>
      </div>

      <div className="p-4">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-lg font-bold text-charcoal">{r.name}</h4>
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-sm text-charcoal/55">
          <MapPin size={13} className="text-copper" /> {r.district}، {r.city}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-cream/40 p-3">
          <Spec icon={<Wallet size={14} />} label="السعر" value={r.price} />
          <Spec icon={<Ruler size={14} />} label="المساحة" value={r.area} />
          <Spec icon={<BedDouble size={14} />} label="الغرف" value={r.bedrooms} />
          <Spec icon={<PackageCheck size={14} />} label="متاح" value={r.available} />
        </div>

        <p className="mt-3 text-sm leading-relaxed text-charcoal/70">
          <span className="font-semibold text-copper">لماذا هذا المشروع؟ </span>{r.reason}
        </p>

        <div className="mt-4 flex gap-2">
          <span className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-copper px-4 py-2.5 text-sm font-bold text-white">
            <Eye size={15} /> عرض المشروع
          </span>
          <span className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-sand/60 bg-white px-4 py-2.5 text-sm font-bold text-charcoal/75">
            <Send size={15} /> إرسال
          </span>
        </div>
      </div>
    </div>
  );
}
