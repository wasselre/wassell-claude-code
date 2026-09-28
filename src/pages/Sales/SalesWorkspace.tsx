/**
 * Sales Workspace shell (D13).
 *
 * ONE sidebar entry → a workspace with section tabs: Overview · Clients ·
 * Work Queue · WhatsApp. Every section REUSES the mature existing pages
 * unchanged, so the lifecycle models are surfaced THROUGH the workspace:
 *   - Overview   → SalesManagerPage (manager health; No-Next-Action is live)
 *   - Clients    → MyClientsPage (rep book + mine/all scope + situation tabs)
 *   - Work Queue → MyTasksPage (actionable follow-ups / waiting / appointments)
 *   - WhatsApp   → ChatsSplitPage (Chats stays the top-level WhatsApp surface, D32)
 *
 * Access (decision #7): each section is gated by an access-only custom-page id
 * (`sw_*` in customPages.ts), managed in Settings → Profiles — never hardcoded
 * by role here. The workspace route is wrapped in RequirePageAccess
 * pageId="sales_workspace" in App.tsx; underlying model RLS still applies.
 *
 * Tools (SalesToolsMenu) — one «أدوات» menu in the header, on every section,
 * for the everyday actions: search for a client, book an appointment, record a
 * visit, Project Finder (moved here from the sidebar), the financing
 * calculator, a new WhatsApp chat, and a new client.
 *
 * Client 360 (ClientDetailPage), the guided Follow-up Workspace and a full
 * conversation view remain anchored DRILL-INS reached from these sections —
 * exactly like Portfolio → project page in Projects & Inventory.
 */
import { useMemo } from 'react';
import { useParams, useNavigate, Navigate } from 'react-router-dom';
import { BarChart3, UserCheck, ListChecks, MessageSquareText, SearchX } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useCanAccessPage } from '@/hooks/usePermission';
import type { CustomPageId } from '@/lib/customPages';
import SalesManagerPage from './SalesManagerPage';
import MyClientsPage from './MyClientsPage';
import MyTasksPage from './MyTasksPage';
import ChatsSplitPage from '@/pages/Chats/ChatsSplitPage';
import SalesToolsMenu from './components/SalesToolsMenu';
import UnansweredRequestsSection from './requests/UnansweredRequestsSection';

type SectionKey = 'overview' | 'clients' | 'work-queue' | 'whatsapp' | 'requests';

interface SectionDef {
  key: SectionKey;
  pageId: CustomPageId;
  icon: typeof BarChart3;
  ar: string;
  en: string;
}

const SECTIONS: SectionDef[] = [
  { key: 'overview', pageId: 'sw_overview', icon: BarChart3, ar: 'نظرة عامة', en: 'Overview' },
  { key: 'clients', pageId: 'sw_clients', icon: UserCheck, ar: 'العملاء', en: 'Clients' },
  { key: 'work-queue', pageId: 'sw_work_queue', icon: ListChecks, ar: 'قائمة العمل', en: 'Work Queue' },
  { key: 'whatsapp', pageId: 'sw_whatsapp', icon: MessageSquareText, ar: 'واتساب', en: 'WhatsApp' },
  { key: 'requests', pageId: 'sw_unanswered', icon: SearchX, ar: 'الطلبات غير المجابة', en: 'Unanswered Requests' },
];

export default function SalesWorkspace() {
  const params = useParams();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language) === 'ar';

  // Per-section access — hooks called unconditionally (fixed set of 5).
  const canOverview = useCanAccessPage('sw_overview');
  const canClients = useCanAccessPage('sw_clients');
  const canWorkQueue = useCanAccessPage('sw_work_queue');
  const canWhatsApp = useCanAccessPage('sw_whatsapp');
  const canRequests = useCanAccessPage('sw_unanswered');
  const accessByKey: Record<SectionKey, boolean> = {
    overview: canOverview,
    clients: canClients,
    'work-queue': canWorkQueue,
    whatsapp: canWhatsApp,
    requests: canRequests,
  };

  const visibleSections = useMemo(
    () => SECTIONS.filter((s) => accessByKey[s.key]),
    [canOverview, canClients, canWorkQueue, canWhatsApp, canRequests],
  );

  const requested = (params.section as SectionKey | undefined) ?? undefined;
  const active: SectionKey | null = requested && accessByKey[requested]
    ? requested
    : (visibleSections[0]?.key ?? null);

  // Normalize the URL when no/invalid section was given but one is accessible.
  if (active && requested !== active) {
    return <Navigate to={`/sales-workspace/${active}`} replace />;
  }

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-chocolate">{isAr ? 'المبيعات' : 'Sales'}</h1>
        {active !== null && <SalesToolsMenu />}
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
                onClick={() => navigate(`/sales-workspace/${s.key}`)}
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

      {/* Section body — full existing pages embedded as sections. */}
      {active === 'overview' && <SalesManagerPage />}
      {active === 'clients' && <MyClientsPage />}
      {active === 'work-queue' && <MyTasksPage />}
      {active === 'whatsapp' && <ChatsSplitPage />}
      {active === 'requests' && <UnansweredRequestsSection />}

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
