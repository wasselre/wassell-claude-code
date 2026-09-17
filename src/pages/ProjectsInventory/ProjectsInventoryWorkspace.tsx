/**
 * Projects & Inventory workspace shell.
 *
 * ONE sidebar entry → a workspace with section tabs: Command Center · Portfolio
 * · Market Registry · Update Operations. Portfolio and Market Registry REUSE the
 * mature existing pages (OurProjectsPortfolioPage / ProjectsListPage) unchanged;
 * Command Center and Update Operations are new sections in this folder.
 *
 * Access (decision #7): each section is gated by an access-only custom-page id
 * (`pi_*` in customPages.ts), so per-profile access is managed by the existing
 * Settings → Profiles system — never hardcoded by role here. The workspace route
 * itself is wrapped in RequirePageAccess pageId="projects_inventory" in App.tsx.
 * Underlying model RLS + field permissions still apply beneath these gates.
 */
import { useMemo } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { LayoutDashboard, Star, Building2, RefreshCw, Wrench } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useCanAccessPage } from '@/hooks/usePermission';
import type { CustomPageId } from '@/lib/customPages';
import OurProjectsPortfolioPage from '@/pages/Projects/OurProjectsPortfolioPage';
import CommandCenterSection from './sections/CommandCenterSection';
import MarketRegistrySection from './sections/MarketRegistrySection';
import UpdateOperationsSection from './sections/UpdateOperationsSection';
import RawAdminSection from './sections/RawAdminSection';

type SectionKey = 'command-center' | 'portfolio' | 'registry' | 'updates' | 'admin';

interface SectionDef {
  key: SectionKey;
  pageId: CustomPageId;
  icon: typeof LayoutDashboard;
  ar: string;
  en: string;
}

const SECTIONS: SectionDef[] = [
  { key: 'command-center', pageId: 'pi_command_center', icon: LayoutDashboard, ar: 'مركز القيادة', en: 'Command Center' },
  { key: 'portfolio', pageId: 'pi_portfolio', icon: Star, ar: 'المحفظة', en: 'Portfolio' },
  { key: 'registry', pageId: 'pi_market_registry', icon: Building2, ar: 'سجل السوق', en: 'Market Registry' },
  { key: 'updates', pageId: 'pi_update_operations', icon: RefreshCw, ar: 'عمليات التحديث', en: 'Update Operations' },
  { key: 'admin', pageId: 'pi_raw_admin', icon: Wrench, ar: 'الإدارة المتقدمة', en: 'Raw Admin' },
];

export default function ProjectsInventoryWorkspace() {
  const params = useParams();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language) === 'ar';

  // Per-section access — hooks are called unconditionally (fixed set of 4).
  const canCommand = useCanAccessPage('pi_command_center');
  const canPortfolio = useCanAccessPage('pi_portfolio');
  const canRegistry = useCanAccessPage('pi_market_registry');
  const canUpdates = useCanAccessPage('pi_update_operations');
  const canRawAdmin = useCanAccessPage('pi_raw_admin');
  const accessByKey: Record<SectionKey, boolean> = {
    'command-center': canCommand,
    portfolio: canPortfolio,
    registry: canRegistry,
    updates: canUpdates,
    admin: canRawAdmin,
  };

  const visibleSections = useMemo(() => SECTIONS.filter((s) => accessByKey[s.key]), [canCommand, canPortfolio, canRegistry, canUpdates, canRawAdmin]);

  const requested = (params.section as SectionKey | undefined) ?? undefined;
  // Resolve the active section: the requested one if accessible, else the first
  // accessible section. No accessible section → an honest empty state.
  const active: SectionKey | null = requested && accessByKey[requested]
    ? requested
    : (visibleSections[0]?.key ?? null);

  // Normalize the URL when no/invalid section was given but one is accessible.
  if (active && requested !== active) {
    return <Navigate to={`/projects-inventory/${active}`} replace />;
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-chocolate">{isAr ? 'المشاريع والمخزون' : 'Projects & Inventory'}</h1>
      </div>

      {/* Section tabs — only the sections this profile may access. */}
      {visibleSections.length > 0 && (
        <div className="flex gap-1 border-b border-sand/50 overflow-x-auto">
          {visibleSections.map((s) => {
            const Icon = s.icon;
            const isActive = s.key === active;
            return (
              <button
                key={s.key}
                onClick={() => navigate(`/projects-inventory/${s.key}`)}
                className={`px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors inline-flex items-center gap-1.5 ${
                  isActive ? 'border-copper text-copper' : 'border-transparent text-charcoal/50 hover:text-charcoal'
                }`}
              >
                <Icon size={15} />
                {isAr ? s.ar : s.en}
              </button>
            );
          })}
        </div>
      )}

      {/* Section body */}
      {active === 'command-center' && <CommandCenterSection isAr={isAr} />}
      {active === 'portfolio' && <OurProjectsPortfolioPage />}
      {active === 'registry' && <MarketRegistrySection isAr={isAr} />}
      {active === 'updates' && <UpdateOperationsSection isAr={isAr} />}
      {active === 'admin' && <RawAdminSection isAr={isAr} />}

      {active === null && (
        <div className="card p-10 text-center text-charcoal/50 text-sm">
          {isAr
            ? 'لا توجد أقسام متاحة لك في هذه المساحة. تواصل مع مسؤول النظام لمنح الصلاحية.'
            : 'No sections are available to you in this workspace. Ask an administrator for access.'}
        </div>
      )}
    </div>
  );
}
