import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Building2, MapPin, Eye, EyeOff, ExternalLink, Plus, LayoutGrid, Globe, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import RecordListPage from '@/pages/Records/RecordListPage';
import {
  resolveProjectView, modelByName, fieldByCandidates, optionFor, formatPriceRange,
  asString, asFiniteNumber, type ProjectView, type OptionView,
} from '@/lib/projects/projectView';

interface PortfolioItem {
  ourId: string;
  ourData: Record<string, unknown>;
  linkedId: string | null;
  linked: ProjectView | null;
  status: OptionView | null;
  priority: OptionView | null;
  exclusive: OptionView | null;
  displayOrder: number | null;
  heroOverride: string | null;
  showOnWebsite: boolean;
}

// active first, then paused, sold_out, hidden; then display order; then name.
const STATUS_RANK: Record<string, number> = { active: 0, paused: 1, sold_out: 2, hidden: 3 };

export default function OurProjectsPortfolioPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { models, records, language } = useAppStore();
  const isAr = language === 'ar';

  const ourModel = modelByName(models, 'our_projects');
  const allModel = modelByName(models, 'all_projects');

  const statusField = fieldByCandidates(ourModel, ['portfolio_status']);
  const priorityField = fieldByCandidates(ourModel, ['sales_priority']);
  const exclusiveField = fieldByCandidates(ourModel, ['exclusive_status']);
  const projectField = fieldByCandidates(ourModel, ['project']);

  const items: PortfolioItem[] = useMemo(() => {
    if (!ourModel || !allModel) return [];
    const ourRecords = records[ourModel.id] ?? [];
    const allRecords = records[allModel.id] ?? [];
    const out = ourRecords.map((r): PortfolioItem => {
      const data = (r.data ?? {}) as Record<string, unknown>;
      const rawLink = projectField ? data[projectField.name] : null;
      const linkedId = Array.isArray(rawLink) ? (typeof rawLink[0] === 'string' ? rawLink[0] : null) : (typeof rawLink === 'string' ? rawLink : null);
      const linkedRec = linkedId ? allRecords.find((x) => x.id === linkedId) ?? null : null;
      const heroRaw = data.hero_image_override;
      return {
        ourId: r.id,
        ourData: data,
        linkedId,
        linked: linkedRec ? resolveProjectView({ models, records }, linkedRec) : null,
        status: optionFor(statusField, data.portfolio_status),
        priority: optionFor(priorityField, data.sales_priority),
        exclusive: optionFor(exclusiveField, data.exclusive_status),
        displayOrder: asFiniteNumber(data.website_display_order),
        heroOverride: typeof heroRaw === 'string' && /^https?:\/\//i.test(heroRaw) ? heroRaw : null,
        showOnWebsite: data.show_on_website === true,
      };
    });
    return out.sort((a, b) => {
      const ra = STATUS_RANK[a.status?.value ?? ''] ?? 9;
      const rb = STATUS_RANK[b.status?.value ?? ''] ?? 9;
      if (ra !== rb) return ra - rb;
      const da = a.displayOrder ?? Infinity;
      const db = b.displayOrder ?? Infinity;
      if (da !== db) return da - db;
      return (a.linked?.name ?? '').localeCompare(b.linked?.name ?? '');
    });
  }, [ourModel, allModel, records, models, projectField, statusField, priorityField, exclusiveField]);

  if (searchParams.get('generic') === '1') return <RecordListPage />;
  if (!ourModel) return <div className="p-8 text-charcoal/50">{isAr ? 'النموذج غير موجود' : 'Model not found'}</div>;

  const active = items.filter((i) => i.status?.value === 'active').length;
  const availableUnits = items.reduce((n, i) => n + (i.linked?.availableUnits ?? 0), 0);
  const unitCount = items.reduce((n, i) => n + (i.linked?.unitCount ?? 0), 0);
  const publicCount = items.filter((i) => i.showOnWebsite).length;
  const unlinked = items.filter((i) => !i.linked).length;

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">{isAr ? ourModel.label_ar : ourModel.label_en}</h1>
          <p className="text-sm text-charcoal/50">{isAr ? 'محفظة المبيعات المختارة فوق قاعدة المشاريع' : 'Curated sales portfolio over the project database'}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => navigate('/model/our_projects?generic=1')}>{isAr ? 'العرض الكلاسيكي' : 'Classic view'}</Button>
          <Button variant="primary" onClick={() => navigate('/model/our_projects/new')}>
            <Plus size={16} className="inline -mt-0.5 me-1" /> {isAr ? 'إضافة للمحفظة' : 'Add to portfolio'}
          </Button>
        </div>
      </div>

      {/* KPI summary */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <PortfolioKpi icon={<Building2 size={18} />} label={isAr ? 'إجمالي المحفظة' : 'Portfolio total'} value={items.length} tone="#B8734F" />
        <PortfolioKpi icon={<CheckCircle2 size={18} />} label={isAr ? 'نشطة' : 'Active'} value={active} tone="#10B981" />
        <PortfolioKpi icon={<LayoutGrid size={18} />} label={isAr ? 'الوحدات المتاحة' : 'Available units'} value={availableUnits.toLocaleString()} tone="#8E4E3A" />
        <PortfolioKpi icon={<Building2 size={18} />} label={isAr ? 'إجمالي الوحدات' : 'Total units'} value={unitCount.toLocaleString()} tone="#C09B5F" />
        <PortfolioKpi icon={<Globe size={18} />} label={isAr ? 'منشورة على الموقع' : 'Public on website'} value={publicCount} tone="#3B82F6" />
        <PortfolioKpi icon={<AlertTriangle size={18} />} label={isAr ? 'بدون مشروع مرتبط' : 'Unlinked'} value={unlinked} tone="#EF4444" />
      </div>

      {items.length === 0 ? (
        <div className="card p-16 text-center text-charcoal/40">{isAr ? 'لا توجد مشاريع في المحفظة بعد.' : 'No portfolio projects yet.'}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((item) => <PortfolioCard key={item.ourId} item={item} isAr={isAr} onOpenDetail={() => navigate(`/model/our_projects/${item.ourId}`)} onEdit={() => navigate(`/model/our_projects/${item.ourId}?generic=1`)} />)}
        </div>
      )}
    </div>
  );
}

function PortfolioKpi({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string | number; tone?: string }) {
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: (tone ?? '#B8734F') + '1A', color: tone ?? '#B8734F' }}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xl font-bold text-charcoal leading-none">{value}</div>
        <div className="text-xs text-charcoal/50 mt-1 truncate">{label}</div>
      </div>
    </div>
  );
}

function PortfolioCard({ item, isAr, onOpenDetail, onEdit }: { item: PortfolioItem; isAr: boolean; onOpenDetail: () => void; onEdit: () => void }) {
  const linked = item.linked;
  const heroUrl = item.heroOverride ?? linked?.imageUrl ?? null;
  const name = linked?.name ?? asString(item.ourData.project_name) ?? `#${item.ourId.slice(0, 8)}`;
  const dash = isAr ? 'غير متوفر' : 'N/A';

  return (
    <div className="card overflow-hidden flex flex-col">
      <div className="h-32 bg-gradient-to-br from-copper/25 to-terracotta/20 relative flex items-center justify-center cursor-pointer" onClick={onOpenDetail} title={isAr ? 'فتح التفاصيل' : 'Open details'}>
        {heroUrl ? <img src={heroUrl} alt={name} className="w-full h-full object-cover" loading="lazy" /> : <Building2 size={32} className="text-copper/40" />}
        <div className="absolute top-2 start-2 flex gap-1.5">
          {item.status && <Badge label={isAr ? item.status.label_ar : item.status.label_en} color={item.status.color ?? undefined} />}
        </div>
        <div className="absolute top-2 end-2 bg-white/90 rounded-full p-1" title={item.showOnWebsite ? (isAr ? 'منشور' : 'Public') : (isAr ? 'مخفي' : 'Hidden')}>
          {item.showOnWebsite ? <Eye size={14} className="text-green-600" /> : <EyeOff size={14} className="text-charcoal/40" />}
        </div>
        {item.displayOrder !== null && (
          <div className="absolute bottom-2 end-2 bg-white/90 rounded px-1.5 text-[11px] font-bold text-charcoal/60">#{item.displayOrder}</div>
        )}
      </div>
      <div className="p-3 flex-1 flex flex-col">
        <div className="font-bold text-charcoal truncate cursor-pointer hover:text-copper" onClick={onOpenDetail}>{name}</div>
        <div className="text-sm text-charcoal/50 flex items-center gap-1 mt-0.5">
          <MapPin size={13} /> <span className="truncate">{[linked?.district, linked?.city].filter(Boolean).join('، ') || dash}</span>
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {item.priority && <span className="text-[11px] px-1.5 py-0.5 rounded bg-cream text-charcoal/70 border border-sand/50">{isAr ? 'أولوية: ' : 'Priority: '}{isAr ? item.priority.label_ar : item.priority.label_en}</span>}
          {item.exclusive && <span className="text-[11px] px-1.5 py-0.5 rounded bg-cream text-charcoal/70 border border-sand/50">{isAr ? item.exclusive.label_ar : item.exclusive.label_en}</span>}
        </div>
        <div className="mt-2 text-sm">
          <span className="text-charcoal/40">{isAr ? 'السعر: ' : 'Price: '}</span>
          <span className="font-semibold text-charcoal">{formatPriceRange(linked?.priceRange ?? null, isAr) ?? dash}</span>
        </div>

        <div className="mt-3 pt-2 border-t border-sand/40">
          <Button variant="primary" className="w-full !py-1.5 text-sm" onClick={onOpenDetail}>
            <ExternalLink size={13} className="inline -mt-0.5 me-1" /> {isAr ? 'التفاصيل' : 'Details'}
          </Button>
        </div>
        <button onClick={onEdit} className="mt-1 text-[11px] text-charcoal/40 hover:text-copper">{isAr ? 'تحرير إعدادات المحفظة' : 'Edit portfolio settings'}</button>
      </div>
    </div>
  );
}
