import { useState } from 'react';
import { Building2, MapPin, FileText, Video, ExternalLink } from 'lucide-react';
import Badge from '@/components/ui/Badge';
import { Screen, Kpi, Fact, Chips, OffPlanPill, ProjectImage } from '../hireUi';
import { PROJECT } from '../hireScenario';

type Tab = 'overview' | 'media' | 'location';

/** Step 3 — reviewing one recommended project during the call. */
export default function StepProjectDetail() {
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <Screen title={`المشروع — ${PROJECT.name}`} icon={<Building2 size={16} />} bodyClassName="p-4 sm:p-6 space-y-4">
      {/* hero */}
      <div className="overflow-hidden rounded-2xl border border-sand/40 bg-white shadow-sm">
        <div className="h-52 w-full sm:h-64">
          <ProjectImage variant="villaDay" className="h-full w-full" />
        </div>
        <div className="p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-charcoal sm:text-3xl">{PROJECT.name}</h1>
            <Badge label="مشاريعنا" color="#B8734F" />
            <OffPlanPill />
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-sm text-charcoal/60 sm:text-base">
            <MapPin size={15} /> {PROJECT.district} · <span className="text-charcoal/40">{PROJECT.developer}</span>
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-3 gap-2 md:grid-cols-4 lg:grid-cols-7">
        {PROJECT.kpis.map((k) => <Kpi key={k.label} label={k.label} value={k.value} tone={k.tone} />)}
      </div>

      {/* tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-sand/50">
        {([['overview', 'نظرة عامة'], ['media', 'الوسائط'], ['location', 'الموقع']] as [Tab, string][]).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium sm:text-base ${
              tab === k ? 'border-copper text-copper' : 'border-transparent text-charcoal/50 hover:text-charcoal'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card p-4 sm:p-5">
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-copper">تفاصيل المشروع</h3>
            {PROJECT.facts.map((f) => <Fact key={f.label} label={f.label} value={f.value} />)}
          </div>
          <div className="card space-y-4 p-4 sm:p-5">
            <div>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-copper">أنواع الوحدات</h3>
              <Chips items={PROJECT.unitTypes} />
            </div>
            <div>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-copper">المرافق</h3>
              <Chips items={PROJECT.amenities} />
            </div>
          </div>
        </div>
      )}

      {tab === 'media' && (
        <div className="card space-y-3 p-4 sm:p-5">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {PROJECT.galleryVariants.map((v, i) => (
              <div key={i} className="overflow-hidden rounded-xl border border-sand/50">
                <div className="h-28 w-full sm:h-32"><ProjectImage variant={v} className="h-full w-full" /></div>
                <div className="bg-white px-2 py-1 text-center text-[11px] text-charcoal/55">{PROJECT.gallery[i]}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-5 pt-1 text-sm font-semibold text-copper sm:text-base">
            <span className="inline-flex items-center gap-1.5"><FileText size={16} /> بروشور المشروع</span>
            <span className="inline-flex items-center gap-1.5"><Video size={16} /> فيديو المشروع</span>
            <span className="inline-flex items-center gap-1.5"><ExternalLink size={16} /> صفحة المشروع</span>
          </div>
        </div>
      )}

      {tab === 'location' && (
        <div className="card p-1">
          <div className="relative flex h-72 items-center justify-center overflow-hidden rounded-xl bg-[repeating-linear-gradient(45deg,#EDE1CF,#EDE1CF_14px,#F5EDE0_14px,#F5EDE0_28px)]">
            <div className="absolute inset-0 opacity-40" style={{ backgroundImage: 'linear-gradient(#D4B89655 1px,transparent 1px),linear-gradient(90deg,#D4B89655 1px,transparent 1px)', backgroundSize: '34px 34px' }} />
            <div className="relative flex flex-col items-center gap-1 text-charcoal/70">
              <MapPin size={36} className="text-copper" />
              <span className="text-base font-bold">{PROJECT.district}</span>
              <span className="text-sm text-charcoal/50">خريطة الموقع على وصل</span>
            </div>
          </div>
        </div>
      )}
    </Screen>
  );
}
