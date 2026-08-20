/**
 * The Marketing Workspace shell.
 *
 * This is a SECOND workspace, not a page inside the Sales one. It renders
 * outside `AppLayout` — its own rail, its own header, its own visual system —
 * and the switcher at the top of the rail is how you move between the two.
 * The Sales workspace is untouched by anything in this folder.
 *
 * It also carries the workspace-wide context (role, content types, project
 * names) so a screen change is a fetch of ITS data only. The old module
 * re-bootstrapped the world on every navigation; that is the "it always
 * reloads" complaint, and this is the structural answer to it.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
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
} from '@/lib/marketingOS/client';
import { initial, num } from './lib/format';
import {
  IconCalendar, IconCampaigns, IconContent, IconGoals, IconLibrary, IconMenu,
  IconMetrics, IconMyWork, IconOverview, IconPulse, IconSearch, IconSend,
  IconSettings, IconShoot, IconTeam,
} from './components/icons';
import NotificationBell from './components/NotificationBell';
import { getEntityFieldText, useRecordTranslationVersion } from '@/lib/recordTranslation/store';
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher';
import MobileTabBar from './components/MobileTabBar';
import './mos.css';
import './styles/rail-badges.css';
// The m4-* responsive classes (mobile cards, .m4-mob/.m4-desk visibility) are
// used across many marketing pages but the stylesheet was imported only by
// CampaignsPage. After route-level code-splitting, landing directly on another
// page (e.g. a campaign detail) loaded the classes with NO styles — so the
// mobile-only cards leaked onto desktop as unstyled, run-together text. Import
// it in the always-loaded workspace shell so every /m page has it.
import './styles/mobile-m4.css';

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
  | 'view_content_body' | 'view_activity' | 'compare_versions';

const Ctx = createContext<WorkspaceCtx | null>(null);

export function useWorkspace(): WorkspaceCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWorkspace must be used inside the Marketing workspace');
  return v;
}

/* ------------------------------------------------------------------ */
/* navigation                                                         */
/* ------------------------------------------------------------------ */

interface NavItem {
  to: string;
  ar: string;
  en: string;
  Icon: (p: Record<string, unknown>) => JSX.Element;
  badge?: BadgeKey;
  end?: boolean;
  /**
   * The surface_access row that governs this item. 'hidden' removes the item
   * from the rail entirely — no disabled button leading to a refusal. 'search'
   * is not a matrix surface: it shows whenever ANY surface is visible.
   */
  surface: SurfaceKey | 'search';
}

interface NavGroup {
  ar: string | null;
  en: string | null;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    ar: null, en: null,
    items: [
      { to: '/m', ar: 'نظرة عامة', en: 'Overview', Icon: IconOverview, end: true, surface: 'overview' },
      { to: '/m/my-work', ar: 'مهامي', en: 'My work', Icon: IconMyWork, badge: 'mywork', surface: 'mywork' },
      { to: '/m/team', ar: 'متابعة الفريق', en: 'Team work', Icon: IconTeam, surface: 'team' },
    ],
  },
  {
    ar: 'المدفوعة', en: 'Paid',
    items: [
      { to: '/m/goals', ar: 'الأهداف', en: 'Goals', Icon: IconGoals, surface: 'goals' },
      { to: '/m/campaigns', ar: 'الحملات', en: 'Campaigns', Icon: IconCampaigns, badge: 'campaigns', surface: 'campaigns' },
      { to: '/m/numbers', ar: 'أرقام الأسبوع', en: 'Weekly numbers', Icon: IconMetrics, surface: 'numbers' },
    ],
  },
  {
    ar: 'العضوية', en: 'Organic',
    items: [
      { to: '/m/organic', ar: 'نبض المنصات', en: 'Platform pulse', Icon: IconPulse, surface: 'organic' },
      { to: '/m/publishing', ar: 'لوحة النشر', en: 'Publishing board', Icon: IconSend, surface: 'publishing' },
    ],
  },
  {
    ar: 'الإنتاج', en: 'Production',
    items: [
      { to: '/m/content', ar: 'المحتوى', en: 'Content', Icon: IconContent, badge: 'content', surface: 'content' },
      { to: '/m/search', ar: 'البحث', en: 'Search', Icon: IconSearch, surface: 'search' },
      { to: '/m/calendar', ar: 'التقويم', en: 'Calendar', Icon: IconCalendar, surface: 'calendar' },
      { to: '/m/library', ar: 'مكتبة المواد', en: 'Asset library', Icon: IconLibrary, surface: 'library' },
      { to: '/m/shoots', ar: 'طلبات التصوير', en: 'Shoot requests', Icon: IconShoot, surface: 'shoots' },
    ],
  },
  {
    ar: 'الإعداد', en: 'Setup',
    items: [
      { to: '/m/settings', ar: 'الإعدادات', en: 'Settings', Icon: IconSettings, surface: 'settings' },
    ],
  },
];

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

/** The rail and a page-shaped skeleton, so booting looks like loading. */
function BootShell({ isAr }: { isAr: boolean }) {
  return (
    <div className="mos-root">
      <aside className="mos-rail">
        <div className="brand">
          <img src="/assets/wassel-icon-white.png" className="brand-mark" style={{ objectFit: 'contain' }} alt="Wassel" />
          <div className="brand-txt">
            <b>{isAr ? 'وصل' : 'Wassel'}</b>
            <span>{isAr ? 'التسويق' : 'Marketing'}</span>
          </div>
        </div>
      </aside>
      <div className="mos-main">
        <div className="phead">
          <div style={{ width: '100%' }}>
            <div className="sk" style={{ height: 24, width: 180 }} />
            <div className="sk" style={{ height: 12, width: 260, marginTop: 8 }} />
          </div>
        </div>
        <div className="body">
          <div className="grid g4" style={{ marginBottom: 18 }}>
            {[0, 1, 2, 3].map((i) => <div key={i} className="sk" style={{ height: 96 }} />)}
          </div>
          <div className="sk" style={{ height: 220 }} />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* shell                                                              */
/* ------------------------------------------------------------------ */

export default function MarketingWorkspace() {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const setLanguage = useAppStore((s) => s.setLanguage);
  const authEmail = useAppStore((s) => s.authEmail);
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
  const [contentTypes, setContentTypes] = useState<MosContentType[]>([]);
  const [projects, setProjects] = useState<MosProject[]>([]);
  const [people, setPeople] = useState<RolePerson[]>([]);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [badges, setBadges] = useState<Record<BadgeKey, number | null>>({
    mywork: null, content: null, campaigns: null,
  });
  const [railOpen, setRailOpen] = useState(false);

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

  // Closing the drawer on navigation is what makes the mobile rail usable —
  // every screen is reachable on a phone (decision 6: «الجميع»).
  useEffect(() => { setRailOpen(false); }, [location.pathname]);

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

  // A hidden surface removes its rail item entirely — no disabled button
  // leading to a refusal (the matrix's whole point). Search is not a matrix
  // surface: it shows whenever the caller can see anything at all.
  const anySurfaceVisible = Object.values(surfaces).some((l) => l !== 'hidden');
  const navVisible = (item: NavItem): boolean => {
    if (!ready) return true; // don't flash-remove items before bootstrap lands
    if (item.surface === 'search') return anySurfaceVisible;
    return surfaces[item.surface] !== 'hidden';
  };

  return (
    <Ctx.Provider value={ctx}>
      <div className="mos-root" data-workspace="marketing">
        {/* A real <button>, not a <div>: iOS Safari does not fire click/tap on
            a plain non-interactive element without `cursor: pointer`, so a
            <div> scrim leaves the drawer stuck open on iPhone (the same reason
            the المزيد sheet scrim is a button). */}
        <button
          type="button"
          className={`mos-rail-scrim${railOpen ? ' on' : ''}`}
          onClick={() => setRailOpen(false)}
          aria-label={isAr ? 'إغلاق القائمة' : 'Close menu'}
          tabIndex={railOpen ? 0 : -1}
        />
        <aside className={`mos-rail${railOpen ? ' open' : ''}`}>
          <div className="brand">
            <img src="/assets/wassel-icon-white.png" className="brand-mark" style={{ objectFit: 'contain' }} alt="Wassel" />
            <div className="brand-txt">
              <b>{isAr ? 'وصل' : 'Wassel'}</b>
              <span>{isAr ? 'التسويق' : 'Marketing'}</span>
            </div>
            <NotificationBell />
          </div>

          {/* The switcher — the one control that makes two workspaces one app. */}
          <WorkspaceSwitcher variant="marketing" canAccessMarketing isAr={isAr} />

          {NAV.map((group, gi) => {
            const items = group.items.filter(navVisible);
            if (items.length === 0) return null;
            return (
              <div key={gi}>
                {group.ar && <div className="nav-sec">{isAr ? group.ar : group.en}</div>}
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) => `navi${isActive ? ' on' : ''}`}
                  >
                    <item.Icon />
                    {isAr ? item.ar : item.en}
                    {item.badge && badges[item.badge] !== null && (
                      <span className="ct">{num(badges[item.badge], isAr)}</span>
                    )}
                  </NavLink>
                ))}
              </div>
            );
          })}

          <div className="rail-foot">
            <div className="av">{initial(roleLabel)}</div>
            <div style={{ minWidth: 0 }}>
              <b style={{ fontSize: 12 }}>{roleLabel}</b>
              <small style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                {authEmail ?? ''}
              </small>
            </div>
            <button
              type="button"
              onClick={() => setLanguage(isAr ? 'en' : 'ar')}
              className="btn btn-sm"
              style={{ marginInlineStart: 'auto', background: 'transparent', color: 'var(--rail-ink)', borderColor: 'rgba(255,255,255,.2)' }}
            >
              {isAr ? 'EN' : 'ع'}
            </button>
          </div>
        </aside>

        <div className="mos-main">
          {/* The burger only exists below 760px; on desktop the rail is always on. */}
          <button
            type="button"
            className="mos-burger"
            onClick={() => setRailOpen(true)}
            aria-label={isAr ? 'فتح القائمة' : 'Open menu'}
          >
            <IconMenu style={{ width: 18, height: 18 }} />
          </button>

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

          {role === 'viewer' && ready && !bootError && (
            <div style={{ padding: '14px 26px 0' }}>
              <div className="notice">
                {isAr
                  ? 'دورك الحالي «مطّلع» — يمكنك رؤية كل شيء دون تعديله. تُمنح الأدوار من الإعدادات ← الأدوار.'
                  : 'Your role is Viewer — you can see everything and change nothing. Roles are granted in Settings → Roles.'}
              </div>
            </div>
          )}

          {/* Hold the page until the workspace bootstrap lands. Rendering it
              early flashed the defaults — the raw content-type key in the Type
              column and "viewer" in the rail — which reads as a bug even
              though it corrects itself a moment later. */}
          {ready ? (
            <Outlet />
          ) : (
            <div className="body">
              <div className="sk" style={{ height: 26, width: 200, marginBottom: 16 }} />
              <div className="grid g4" style={{ marginBottom: 18 }}>
                {[0, 1, 2, 3].map((i) => <div key={i} className="sk" style={{ height: 96 }} />)}
              </div>
              <div className="sk" style={{ height: 200 }} />
            </div>
          )}
        </div>

        {/* Bottom tab bar — visible only <760px (mobile-shell.css); items are
            filtered by surface access inside the component. */}
        <MobileTabBar />
      </div>
    </Ctx.Provider>
  );
}
