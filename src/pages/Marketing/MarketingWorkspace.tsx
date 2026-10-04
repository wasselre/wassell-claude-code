/**
 * The Marketing Workspace shell.
 *
 * Since 2026-10-04 this is a tabbed workspace INSIDE the main app layout, like
 * «المبيعات»: the main sidebar carries an «التسويق» row, and this shell renders
 * a header plus six tabs (الشهر · المهام · المحتوى · النشر · التحليلات ·
 * المنافسون), each with sub-tabs for the pages folded into it. It used to sit
 * outside AppLayout with its own brown rail and a Sales/Marketing switcher.
 * The pages keep their own design system (mos.css, scoped under .mos-root),
 * pinned to its LIGHT token set in the app's palette (styles/mosInApp.css).
 *
 * It also carries the workspace-wide context (role, content types, project
 * names) so a screen change is a fetch of ITS data only. The old module
 * re-bootstrapped the world on every navigation; that is the "it always
 * reloads" complaint, and this is the structural answer to it.
 */
import {
  createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { useCanAccessPage } from '@/hooks/usePermission';
import {
  MosContentType,
  MosProject,
  MosRole,
  ROLE_LABELS,
  RolePerson,
  SurfaceKey,
  SurfaceLevel,
  fetchBootstrap,
  fetchCampaigns,
  fetchContentList,
  fetchProjects,
  fetchRoles,
  fetchWork,
  persistActiveRole,
  setPreviewRole,
} from '@/lib/marketingOS/client';
import { num } from './lib/format';
import {
  IconCalendar, IconContent, IconLibrary, IconMetrics, IconMyWork, IconSearch, IconSend, IconSettings,
} from './components/icons';
import { Radar } from 'lucide-react';
import NotificationBell from './components/NotificationBell';
import { getEntityFieldText, useRecordTranslationVersion } from '@/lib/recordTranslation/store';
import './mos.css';
import './styles/rail-badges.css';
// The m4-* responsive classes (mobile cards, .m4-mob/.m4-desk visibility) are
// used across many marketing pages but the stylesheet was imported only by
// CampaignsPage. After route-level code-splitting, landing directly on another
// page (e.g. a campaign detail) loaded the classes with NO styles — so the
// mobile-only cards leaked onto desktop as unstyled, run-together text. Import
// it in the always-loaded workspace shell so every /m page has it.
import './styles/mobile-m4.css';
import './styles/mosInApp.css';

/* ------------------------------------------------------------------ */
/* context                                                            */
/* ------------------------------------------------------------------ */

/**
 * The rail's numeric badges, exactly the three the approved mock pins
 * (rail-tpl in marketing-os-ar.html): مهامي = the caller's open-task count
 * («٤» — s02's «٤ مفتوحة»), المحتوى = library size («٦١» — s03's «٦١
 * عنصرًا»), الحملات = campaign count («٦»). Values COMPUTE from live data,
 * never from the mock's static numbers.
 */
type BadgeKey = 'mywork' | 'content' | 'campaigns';

interface WorkspaceCtx {
  /** The role the person is working AS right now (display; never authorization). */
  role: MosRole;
  activeRole: MosRole;
  setActiveRole: (role: MosRole) => void;
  /** Every mos role the caller holds — capability truth is the UNION of these. */
  roles: MosRole[];
  /** Per-surface visibility from the server's surface matrix. */
  surfaces: Record<SurfaceKey, SurfaceLevel>;
  appUserId: string | null;
  contentTypes: MosContentType[];
  projects: MosProject[];
  people: RolePerson[];
  /** Re-read role assignments after the Roles screen changes them. */
  reloadGrants: () => Promise<void>;
  /** A project's display name, or a short id when the project is gone. */
  projectName: (id: string | null | undefined) => string;
  typeLabel: (key: string) => string;
  isAr: boolean;
  ready: boolean;
  /** Rail badge counts — seeded at bootstrap, refreshed by the screens that know better. */
  setBadge: (key: BadgeKey, value: number | null) => void;
  can: (capability: Capability) => boolean;
}

/**
 * The known marketing capabilities. This is a TYPE only — the actual grant set
 * per user is DATA (`role_capabilities`), resolved server-side and shipped in
 * the bootstrap `me.capabilities`. `can()` (below) reads that; there is no
 * hand-maintained capability→role matrix in the client anymore.
 *
 * `wassell_mos_can(capability)` in the DB is the RLS gate; this list is what
 * the UI checks so a writer isn't shown an approve button that would only 403.
 * Keep the members in sync with the capabilities seeded in
 * `role_capabilities` (migration 2026-08-06_01_role_capabilities.sql).
 */
export type Capability =
  | 'read' | 'comment' | 'write_content' | 'assign' | 'assign_task' | 'schedule' | 'publish'
  | 'approve_creative' | 'approve_process' | 'approve_budget'
  | 'manage_assets' | 'enter_metrics' | 'review_performance'
  // Deleting any marketing record (content, scenes, campaigns, executions, ads,
  // assets, manual tasks) — its own gate, separate from the edit capabilities.
  | 'delete_records'
  | 'manage_settings' | 'manage_roles'
  // Sync + create/manage OUR Meta campaigns via the Marketing API (live spend).
  | 'manage_paid_ads'
  // Fine-grained view gates (replace the old hardcoded `role === 'ceo'` checks).
  | 'view_content_body' | 'view_activity' | 'compare_versions'
  // Performance & load system (2026-08-28): rate finished creatives, and run
  // the manager desk (discipline/leave/reward decisions, KPI goals, toggles).
  | 'rate_creative' | 'manage_performance'
  // Campaign planning (2026-09-14): preview a plan against the live workload,
  // commit it (which reserves people's days), settle a weekly creative refresh,
  // reopen an approved package, and edit capacity / holidays / step effort.
  | 'plan_campaign' | 'approve_plan' | 'decide_refresh'
  | 'revise_approved_content' | 'manage_capacity'
  // Team KPIs (2026-09-27): see the team's numbers on «مهامي» › «الفريق».
  | 'view_team_kpis';

const Ctx = createContext<WorkspaceCtx | null>(null);

export function useWorkspace(): WorkspaceCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkspace must be used inside the Marketing workspace');
  return v;
}

/* ------------------------------------------------------------------ */
/* navigation                                                         */
/* ------------------------------------------------------------------ */

interface SubTab {
  to: string;
  ar: string;
  en: string;
  /**
   * The surface_access row that governs this sub-tab. 'hidden' removes it —
   * no disabled button leading to a refusal. 'always' is not a matrix surface:
   * it shows whenever ANY surface is visible (الشهر and البحث always worked
   * that way; the server-side `month_*` actions carry their own gate).
   */
  surface: SurfaceKey | 'always';
}

interface WorkspaceTab {
  key: string;
  ar: string;
  en: string;
  Icon: (p: Record<string, unknown>) => JSX.Element;
  badge?: BadgeKey;
  subs: SubTab[];
  /** Extra address prefixes that belong to this tab (detail pages with no sub-tab). */
  owns?: string[];
  /** A page-access id the tab also needs (the main app's per-profile pages). */
  pageId?: string;
}

/**
 * Six tabs. Every page the old rail had (six main + nine «متقدم») sits under
 * one of them; Settings is a card on the main Settings page (and the gear
 * here), the Library is the Files library's marketing view, and Search is a
 * header button.
 */
const TABS: WorkspaceTab[] = [
  {
    key: 'month', ar: 'الشهر', en: 'The month', Icon: IconCalendar,
    subs: [
      { to: '/m/month', ar: 'الشهر', en: 'The month', surface: 'always' },
      { to: '/m/overview', ar: 'نظرة عامة', en: 'Overview', surface: 'overview' },
    ],
  },
  {
    key: 'work', ar: 'المهام', en: 'Tasks', Icon: IconMyWork, badge: 'mywork',
    subs: [
      { to: '/m/my-work', ar: 'مهامي', en: 'My work', surface: 'mywork' },
      { to: '/m/performance', ar: 'مكتب الأداء', en: 'Performance', surface: 'performance' },
      { to: '/m/me', ar: 'ملفي', en: 'My profile', surface: 'myperf' },
    ],
  },
  {
    key: 'content', ar: 'المحتوى', en: 'Content', Icon: IconContent, badge: 'content',
    subs: [
      { to: '/m/content', ar: 'المحتوى', en: 'Content', surface: 'content' },
      { to: '/m/content-inventory', ar: 'جرد المحتوى', en: 'Inventory', surface: 'content_inventory' },
      { to: '/m/content-readiness', ar: 'جاهزية المحتوى', en: 'Readiness', surface: 'content_readiness' },
      { to: '/m/shoots', ar: 'طلبات التصوير', en: 'Shoot requests', surface: 'shoots' },
    ],
    owns: ['/m/library'],
  },
  {
    key: 'publishing', ar: 'النشر', en: 'Publishing', Icon: IconSend,
    subs: [
      { to: '/m/publishing', ar: 'لوحة النشر', en: 'Publishing board', surface: 'publishing' },
      { to: '/m/organic', ar: 'نبض المنصات', en: 'Platform pulse', surface: 'organic' },
    ],
    owns: ['/m/releases'],
  },
  {
    key: 'analytics', ar: 'التحليلات', en: 'Analytics', Icon: IconMetrics,
    subs: [{ to: '/m/analytics', ar: 'التحليلات', en: 'Analytics', surface: 'analytics' }],
  },
  {
    key: 'competitors', ar: 'المنافسون', en: 'Competitors',
    Icon: () => <Radar size={16} />,
    subs: [{ to: '/m/competitors', ar: 'المنافسون', en: 'Competitors', surface: 'always' }],
    pageId: 'competitor_watch',
  },
];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/* ------------------------------------------------------------------ */
/* gate                                                               */
/* ------------------------------------------------------------------ */

/**
 * The workspace's own access gate.
 *
 * It exists instead of the shared `RequirePageAccess` for one reason: that
 * guard renders NOTHING while the store boots, which on a route with no
 * surrounding layout means a blank white page for as long as the boot takes.
 * The authorization decision is identical — same `page_access` id, same
 * redirect, same toast — but the waiting state is a shell rather than a void.
 */
export function RequireMarketingWorkspace({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const initialized = useAppStore((s) => s.initialized);
  const addToast = useAppStore((s) => s.addToast);
  const isAr = useAppStore((s) => s.language) === 'ar';
  const allowed = useCanAccessPage('marketing_management');
  const toasted = useRef(false);

  useEffect(() => {
    if (!initialized || allowed || toasted.current) return;
    toasted.current = true;
    addToast(t('access.access_denied'), 'error');
  }, [initialized, allowed, addToast, t]);

  if (!initialized) return <BootShell isAr={isAr} />;
  if (!allowed) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** A page-shaped skeleton inside the app layout, so booting looks like loading. */
function BootShell({ isAr }: { isAr: boolean }) {
  return (
    <div className="mos-root mos-embed-light mos-in-app">
      <div className="body" aria-label={isAr ? 'جارٍ تجهيز التسويق' : 'Loading Marketing'}>
        <div className="sk" style={{ height: 24, width: 180, marginBottom: 16 }} />
        <div className="grid g4" style={{ marginBottom: 18 }}>
          {[0, 1, 2, 3].map((i) => <div key={i} className="sk" style={{ height: 96 }} />)}
        </div>
        <div className="sk" style={{ height: 220 }} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* shell                                                              */
/* ------------------------------------------------------------------ */

export default function MarketingWorkspace() {
  const isAr = useAppStore((s) => s.language) === 'ar';
  // «المنافسون» is the Competitor Watch page, gated by ITS page-access id.
  const canCompetitors = useCanAccessPage('competitor_watch');
  const translationVersion = useRecordTranslationVersion();

  const location = useLocation();

  const [role, setRole] = useState<MosRole>('viewer');
  const [roles, setRoles] = useState<MosRole[]>(['viewer']);
  // The caller's capability set, resolved server-side (role_capabilities) and
  // shipped by bootstrap — the single source of truth `can()` reads.
  const [capabilities, setCapabilities] = useState<Set<Capability>>(() => new Set());
  const [surfaces, setSurfaces] = useState<Record<SurfaceKey, SurfaceLevel>>(
    () => ({}) as Record<SurfaceKey, SurfaceLevel>,
  );
  const [appUserId, setAppUserId] = useState<string | null>(null);
  // Admin-only "view as": is the caller a platform admin, and which role (if any)
  // is currently being previewed. Both come from the server bootstrap.
  const [isAdmin, setIsAdmin] = useState(false);
  const [previewRole, setPreviewRoleState] = useState<MosRole | null>(null);
  const [contentTypes, setContentTypes] = useState<MosContentType[]>([]);
  const [projects, setProjects] = useState<MosProject[]>([]);
  const [people, setPeople] = useState<RolePerson[]>([]);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [badges, setBadges] = useState<Record<BadgeKey, number | null>>({
    mywork: null, content: null, campaigns: null,
  });

  const applyBadge = useCallback((key: BadgeKey, value: number | null) => {
    setBadges((b) => (b[key] === value ? b : { ...b, [key]: value }));
  }, []);

  /**
   * Seed the rail badges the mock pins on مهامي / المحتوى / الحملات so the
   * rail reads like the approved design on EVERY screen, not only after
   * touring the app (WorkPage/ContentListPage still refresh their own badge
   * when visited). Runs after bootstrap so the resolved active-role header is
   * what work_list counts against. Each call settles independently — a
   * failure hides that badge (null) and is reported, never fatal to the
   * workspace.
   */
  const loadBadges = useCallback(async () => {
    const [work, contentList, campaignList] = await Promise.allSettled([
      fetchWork('mine'),
      fetchContentList({ limit: 500 }),
      fetchCampaigns(),
    ]);
    if (work.status === 'fulfilled') applyBadge('mywork', work.value.content.length);
    else console.error('[marketing] my-work rail badge unavailable', work.reason);
    if (contentList.status === 'fulfilled') applyBadge('content', contentList.value.content.length);
    else console.error('[marketing] content rail badge unavailable', contentList.reason);
    if (campaignList.status === 'fulfilled') applyBadge('campaigns', campaignList.value.campaigns.length);
    else console.error('[marketing] campaigns rail badge unavailable', campaignList.reason);
  }, [applyBadge]);

  const boot = useCallback(async () => {
    setBootError(null);
    try {
      // Projects are a nice-to-have label source; a failure there must not stop
      // the workspace from opening, so it is settled separately and reported.
      const [bootstrap, projectsResult, rolesResult] = await Promise.all([
        fetchBootstrap(),
        fetchProjects().catch((e: unknown) => {
          console.error('[marketing] project names unavailable', e);
          return { projects: [] as MosProject[] };
        }),
        fetchRoles().catch((e: unknown) => {
          console.error('[marketing] people directory unavailable', e);
          return { people: [] as RolePerson[], roles: [] };
        }),
      ]);
      // The server resolved the active role from the x-mos-active-role header
      // (sent from localStorage by the client) against the held roles — persist
      // the resolved value so later calls send a role that is actually held.
      persistActiveRole(bootstrap.me.active_role);
      setRole(bootstrap.me.active_role);
      setRoles(bootstrap.me.roles);
      setCapabilities(new Set(bootstrap.me.capabilities as Capability[]));
      setSurfaces(bootstrap.me.surfaces);
      setAppUserId(bootstrap.me.user_id);
      setIsAdmin(bootstrap.me.is_admin ?? false);
      setPreviewRoleState((bootstrap.me.preview_role as MosRole | null) ?? null);
      setContentTypes(bootstrap.content_types);
      setProjects(projectsResult.projects);
      setPeople(rolesResult.people);
      // Fire-and-forget: the badges fill in as they land; `ready` never waits.
      void loadBadges();
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e));
    } finally {
      setReady(true);
    }
  }, [loadBadges]);

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void boot();
  }, [boot]);


  const projectMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) if (p.project_name) m.set(p.id, p.project_name);
    return m;
  }, [projects]);

  const typeMap = useMemo(() => {
    const m = new Map<string, MosContentType>();
    for (const t of contentTypes) m.set(t.key, t);
    return m;
  }, [contentTypes]);

  const reloadGrants = useCallback(async () => {
    const res = await fetchRoles();
    setPeople(res.people);
  }, []);

  const setActiveRole = useCallback((next: MosRole) => {
    persistActiveRole(next);
    setRole(next);
    // مهامي counts against the ACTIVE role — refresh so the badge never lies
    // after a role switch (persistActiveRole above sets the header first).
    void loadBadges();
  }, [loadBadges]);

  // Admin "view as": persist the preview choice and hard-reload so the whole
  // workspace re-bootstraps with the new header — every surface, badge and
  // gated control then reflects the previewed role in one clean pass.
  const viewAs = useCallback((next: MosRole | null) => {
    setPreviewRole(next && next !== 'administrator' ? next : null);
    window.location.reload();
  }, []);

  const ctx: WorkspaceCtx = useMemo(() => ({
    role,
    activeRole: role,
    setActiveRole,
    roles,
    surfaces,
    appUserId,
    contentTypes,
    projects,
    people,
    reloadGrants,
    isAr,
    ready,
    projectName: (id) => {
      if (!id) return isAr ? 'بلا مشروع' : 'No project';
      // W6: render the project name in the UI language (translation, else source).
      const tr = getEntityFieldText(id, 'project_name', isAr ? 'ar' : 'en');
      return tr ?? projectMap.get(id) ?? (isAr ? 'مشروع محذوف' : 'Deleted project');
    },
    typeLabel: (key) => {
      const t = typeMap.get(key);
      if (!t) return key;
      return isAr ? t.label_ar : t.label_en;
    },
    setBadge: applyBadge,
    // Capability truth is the UNION over every held role, resolved server-side
    // from `role_capabilities` (see wassell_mos_capabilities). The client no
    // longer keeps its own copy of the matrix — this Set IS the server's answer.
    can: (capability) => capabilities.has(capability),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [role, roles, capabilities, surfaces, setActiveRole, appUserId, contentTypes, projects, people, reloadGrants, isAr, ready, projectMap, typeMap, applyBadge, translationVersion]);

  const roleLabel = ROLE_LABELS[role] ? (isAr ? ROLE_LABELS[role].ar : ROLE_LABELS[role].en) : role;

  // A hidden surface removes its sub-tab entirely — no disabled button leading
  // to a refusal (the matrix's whole point). 'always' shows whenever the caller
  // can see anything at all.
  const anySurfaceVisible = Object.values(surfaces).some((l) => l !== 'hidden');
  const subVisible = (sub: SubTab): boolean => {
    if (!ready) return true; // don't flash-remove tabs before bootstrap lands
    if (sub.surface === 'always') return anySurfaceVisible;
    return surfaces[sub.surface] !== 'hidden';
  };
  const visibleTabs = TABS
    .filter((tab) => !tab.pageId || (tab.pageId === 'competitor_watch' ? canCompetitors : true))
    // A tab gated by a page id (المنافسون) is decided by that page access
    // alone — Marketing surfaces say nothing about Competitor Watch.
    .map((tab) => ({ ...tab, subs: tab.pageId ? tab.subs : tab.subs.filter(subVisible) }))
    .filter((tab) => tab.subs.length > 0);
  const path = location.pathname;
  const activeTab = visibleTabs.find((tab) =>
    tab.subs.some((sub) => under(path, sub.to)) || (tab.owns ?? []).some((p) => under(path, p)));
  const onCompetitors = activeTab?.key === 'competitors';
  const showSettings = !ready || surfaces.settings !== 'hidden';
  const showLibrary = !ready || surfaces.library !== 'hidden';

  const headerButton = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-charcoal/70 bg-white border border-sand/50 hover:text-copper hover:border-copper/40 transition-colors';

  const skeleton = (
    <div className="body">
      <div className="sk" style={{ height: 26, width: 200, marginBottom: 16 }} />
      <div className="grid g4" style={{ marginBottom: 18 }}>
        {[0, 1, 2, 3].map((i) => <div key={i} className="sk" style={{ height: 96 }} />)}
      </div>
      <div className="sk" style={{ height: 200 }} />
    </div>
  );

  return (
    <Ctx.Provider value={ctx}>
      <div className="max-w-[1500px]" data-workspace="marketing">
        {/* Header — the workspace name, its tools, and the admin's role preview. */}
        <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-chocolate">{isAr ? 'التسويق' : 'Marketing'}</h1>
            <p className="text-xs text-charcoal/50 mt-0.5">
              {isAr ? 'دورك: ' : 'Your role: '}{roleLabel}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Link to="/m/search" className={headerButton}>
              <IconSearch style={{ width: 14, height: 14 }} /> {isAr ? 'البحث' : 'Search'}
            </Link>
            {showLibrary && (
              <Link to="/files?view=marketing" className={headerButton}>
                <IconLibrary style={{ width: 14, height: 14 }} /> {isAr ? 'المكتبة' : 'Library'}
              </Link>
            )}
            {showSettings && (
              <Link to="/m/settings" className={headerButton}>
                <IconSettings style={{ width: 14, height: 14 }} /> {isAr ? 'الإعدادات' : 'Settings'}
              </Link>
            )}
            {isAdmin && (
              <select
                aria-label={isAr ? 'معاينة كدور آخر' : 'View as another role'}
                value={previewRole ?? ''}
                onChange={(e) => viewAs((e.target.value || null) as MosRole | null)}
                className={`px-2 py-1.5 rounded-lg text-xs font-bold border cursor-pointer ${previewRole ? 'bg-copper text-white border-copper' : 'bg-white text-charcoal/70 border-sand/50'}`}
              >
                <option value="">{isAr ? '👁 حسابي (مدير النظام)' : '👁 My account (Admin)'}</option>
                {(['marketing_manager', 'ops_supervisor', 'writer', 'montage', 'ceo', 'viewer'] as MosRole[]).map((r) => (
                  <option key={r} value={r}>{isAr ? `👁 معاينة كـ ${ROLE_LABELS[r].ar}` : `👁 View as ${ROLE_LABELS[r].en}`}</option>
                ))}
              </select>
            )}
            {/* The bell keeps the Marketing design system for its pop-over. */}
            <span className="mos-root mos-embed-light mos-in-app mos-bell-host">
              <NotificationBell />
            </span>
          </div>
        </div>

        {/* Tabs — same pattern as the Sales workspace. */}
        <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-sand/50">
          {visibleTabs.map((tab) => {
            const on = tab.key === activeTab?.key;
            return (
              <NavLink
                key={tab.key}
                to={tab.subs[0]!.to}
                role="tab"
                aria-selected={on}
                className={`inline-flex items-center gap-1.5 whitespace-nowrap px-3.5 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                  on ? 'border-copper text-copper' : 'border-transparent text-charcoal/55 hover:text-charcoal'
                }`}
              >
                <tab.Icon style={{ width: 16, height: 16 }} />
                {isAr ? tab.ar : tab.en}
                {tab.badge && badges[tab.badge] !== null && (
                  <span className="text-[10px] font-bold px-1.5 rounded-full bg-copper/10 text-copper">
                    {num(badges[tab.badge], isAr)}
                  </span>
                )}
              </NavLink>
            );
          })}
        </div>

        {/* Sub-tabs — only when the tab holds more than one page. */}
        {activeTab && activeTab.subs.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto pt-3">
            {activeTab.subs.map((sub) => (
              <NavLink
                key={sub.to}
                to={sub.to}
                className={({ isActive }) => `whitespace-nowrap px-3 py-1 rounded-full text-xs font-bold transition-colors ${
                  isActive ? 'bg-copper text-white' : 'bg-white text-charcoal/60 border border-sand/50 hover:text-copper'
                }`}
              >
                {isAr ? sub.ar : sub.en}
              </NavLink>
            ))}
          </div>
        )}

        <div className="mt-4">
          {onCompetitors ? (
            // Competitor Watch brings its own design system (.cw-root); it is
            // NOT wrapped in the Marketing one.
            <Suspense fallback={<div className="py-16 text-center text-charcoal/40 text-sm">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>}>
              <Outlet />
            </Suspense>
          ) : (
            <div className="mos-root mos-embed-light mos-in-app rounded-2xl overflow-hidden">
              <div className="mos-main">
                {bootError && (
                  <div style={{ padding: '14px 26px 0' }}>
                    <div className="notice bad" role="alert">
                      <b>{isAr ? 'تعذّر تجهيز مساحة التسويق' : 'The Marketing workspace could not start'}</b>
                      <div style={{ overflowWrap: 'anywhere', marginTop: 4 }}>{bootError}</div>
                      <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => void boot()}>
                        {isAr ? 'إعادة المحاولة' : 'Try again'}
                      </button>
                    </div>
                  </div>
                )}

                {isAdmin && previewRole && ready && !bootError && (
                  <div style={{ padding: '14px 26px 0' }}>
                    <div className="notice" style={{ borderInlineStart: '4px solid var(--copper)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                      <span>
                        {isAr
                          ? `👁 تعاين الآن كـ «${ROLE_LABELS[previewRole]?.ar ?? previewRole}» — هذه هي واجهته. أنت لا تزال مدير النظام.`
                          : `👁 Previewing as “${ROLE_LABELS[previewRole]?.en ?? previewRole}” — this is their view. You are still the Admin.`}
                      </span>
                      <button type="button" className="btn btn-sm" style={{ marginInlineStart: 'auto' }} onClick={() => viewAs(null)}>
                        {isAr ? 'العودة لحسابك' : 'Back to your account'}
                      </button>
                    </div>
                  </div>
                )}

                {role === 'viewer' && !previewRole && ready && !bootError && (
                  <div style={{ padding: '14px 26px 0' }}>
                    <div className="notice">
                      {isAr
                        ? 'دورك الحالي «مطّلع» — يمكنك رؤية كل شيء دون تعديله. تُمنح الأدوار من الإعدادات ← الأدوار.'
                        : 'Your role is Viewer — you can see everything and change nothing. Roles are granted in Settings → Roles.'}
                    </div>
                  </div>
                )}

                {/* Hold the page until the workspace bootstrap lands — rendering
                    early flashed raw content-type keys and "viewer". The inner
                    Suspense keeps a page-chunk load inside this card. */}
                {ready ? <Suspense fallback={skeleton}><Outlet /></Suspense> : skeleton}
              </div>
            </div>
          )}
        </div>
      </div>
    </Ctx.Provider>
  );
}
