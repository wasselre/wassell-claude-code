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
} from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  MosContentType,
  MosGrant,
  MosProject,
  MosRole,
  MosUser,
  ROLE_LABELS,
  fetchBootstrap,
  fetchProjects,
  fetchRoles,
} from '@/lib/marketingOS/client';
import { initial, num } from './lib/format';
import {
  BrandMark, IconCalendar, IconCampaigns, IconContent, IconLibrary, IconMenu,
  IconMetrics, IconMyWork, IconOverview, IconSearch, IconSettings, IconShoot,
  IconSwap, IconTeam,
} from './components/icons';
import './mos.css';

/* ------------------------------------------------------------------ */
/* context                                                            */
/* ------------------------------------------------------------------ */

interface WorkspaceCtx {
  role: MosRole;
  appUserId: string | null;
  contentTypes: MosContentType[];
  projects: MosProject[];
  users: MosUser[];
  grants: MosGrant[];
  /** Re-read role grants after the Roles screen changes them. */
  reloadGrants: () => Promise<void>;
  /** A project's display name, or a short id when the project is gone. */
  projectName: (id: string | null | undefined) => string;
  typeLabel: (key: string) => string;
  isAr: boolean;
  ready: boolean;
  /** Rail badge counts, refreshed by the screens that know better. */
  setBadge: (key: 'mywork' | 'content', value: number | null) => void;
  can: (capability: Capability) => boolean;
}

/**
 * The capability matrix, mirrored from `wassell_mos_can` in the database.
 * It decides what the UI OFFERS. RLS decides what actually happens — this copy
 * exists so a writer isn't shown an approve button that would only 403.
 */
export type Capability =
  | 'read' | 'comment' | 'write_content' | 'assign' | 'schedule' | 'publish'
  | 'approve_creative' | 'approve_process' | 'approve_budget'
  | 'manage_assets' | 'enter_metrics' | 'review_performance' | 'manage_settings';

const MATRIX: Record<MosRole, Capability[]> = {
  administrator: ['read', 'comment', 'write_content', 'assign', 'schedule', 'publish',
    'approve_creative', 'approve_process', 'approve_budget', 'manage_assets',
    'enter_metrics', 'review_performance', 'manage_settings'],
  marketing_manager: ['read', 'comment', 'write_content', 'assign', 'schedule', 'publish',
    'approve_creative', 'approve_process', 'approve_budget', 'manage_assets',
    'enter_metrics', 'review_performance', 'manage_settings'],
  ceo: ['read', 'comment', 'approve_budget', 'review_performance'],
  ops_supervisor: ['read', 'comment', 'assign', 'schedule', 'publish', 'approve_process',
    'manage_assets', 'enter_metrics', 'review_performance'],
  writer: ['read', 'comment', 'write_content', 'schedule', 'publish'],
  montage: ['read', 'comment', 'write_content', 'manage_assets'],
  viewer: ['read'],
  none: [],
};

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
  badge?: 'mywork' | 'content';
  end?: boolean;
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
      { to: '/m', ar: 'نظرة عامة', en: 'Overview', Icon: IconOverview, end: true },
      { to: '/m/my-work', ar: 'مهامي', en: 'My work', Icon: IconMyWork, badge: 'mywork' },
      { to: '/m/team', ar: 'متابعة الفريق', en: 'Team work', Icon: IconTeam },
    ],
  },
  {
    ar: 'الإنتاج', en: 'Production',
    items: [
      { to: '/m/content', ar: 'المحتوى', en: 'Content', Icon: IconContent, badge: 'content' },
      { to: '/m/search', ar: 'البحث', en: 'Search', Icon: IconSearch },
      { to: '/m/calendar', ar: 'التقويم', en: 'Calendar', Icon: IconCalendar },
      { to: '/m/library', ar: 'مكتبة المواد', en: 'Asset library', Icon: IconLibrary },
      { to: '/m/shoots', ar: 'طلبات التصوير', en: 'Shoot requests', Icon: IconShoot },
    ],
  },
  {
    ar: 'الإنفاق', en: 'Spend',
    items: [
      { to: '/m/campaigns', ar: 'الحملات', en: 'Campaigns', Icon: IconCampaigns },
      { to: '/m/numbers', ar: 'أرقام الأسبوع', en: 'Weekly numbers', Icon: IconMetrics },
    ],
  },
  {
    ar: 'الإعداد', en: 'Setup',
    items: [
      { to: '/m/settings', ar: 'الإعدادات', en: 'Settings', Icon: IconSettings },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* shell                                                              */
/* ------------------------------------------------------------------ */

export default function MarketingWorkspace() {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const setLanguage = useAppStore((s) => s.setLanguage);
  const authEmail = useAppStore((s) => s.authEmail);
  const navigate = useNavigate();
  const location = useLocation();

  const [role, setRole] = useState<MosRole>('viewer');
  const [appUserId, setAppUserId] = useState<string | null>(null);
  const [contentTypes, setContentTypes] = useState<MosContentType[]>([]);
  const [projects, setProjects] = useState<MosProject[]>([]);
  const [users, setUsers] = useState<MosUser[]>([]);
  const [grants, setGrants] = useState<MosGrant[]>([]);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [badges, setBadges] = useState<{ mywork: number | null; content: number | null }>({
    mywork: null, content: null,
  });
  const [railOpen, setRailOpen] = useState(false);

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
          return { users: [] as MosUser[], grants: [] as MosGrant[] };
        }),
      ]);
      setRole(bootstrap.role);
      setAppUserId(bootstrap.app_user_id);
      setContentTypes(bootstrap.content_types);
      setProjects(projectsResult.projects);
      setUsers(rolesResult.users);
      setGrants(rolesResult.grants);
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e));
    } finally {
      setReady(true);
    }
  }, []);

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
    setUsers(res.users);
    setGrants(res.grants);
  }, []);

  const ctx: WorkspaceCtx = useMemo(() => ({
    role,
    appUserId,
    contentTypes,
    projects,
    users,
    grants,
    reloadGrants,
    isAr,
    ready,
    projectName: (id) => {
      if (!id) return isAr ? 'بلا مشروع' : 'No project';
      return projectMap.get(id) ?? (isAr ? 'مشروع محذوف' : 'Deleted project');
    },
    typeLabel: (key) => {
      const t = typeMap.get(key);
      if (!t) return key;
      return isAr ? t.label_ar : t.label_en;
    },
    setBadge: (key, value) => setBadges((b) => (b[key] === value ? b : { ...b, [key]: value })),
    can: (capability) => (MATRIX[role] ?? []).includes(capability),
  }), [role, appUserId, contentTypes, projects, users, grants, reloadGrants, isAr, ready, projectMap, typeMap]);

  const roleLabel = ROLE_LABELS[role] ? (isAr ? ROLE_LABELS[role].ar : ROLE_LABELS[role].en) : role;

  return (
    <Ctx.Provider value={ctx}>
      <div className="mos-root" data-workspace="marketing">
        <div
          className={`mos-rail-scrim${railOpen ? ' on' : ''}`}
          onClick={() => setRailOpen(false)}
          aria-hidden="true"
        />
        <aside className={`mos-rail${railOpen ? ' open' : ''}`}>
          <div className="brand">
            <BrandMark className="brand-mark" />
            <div className="brand-txt">
              <b>{isAr ? 'وصل' : 'Wassel'}</b>
              <span>{isAr ? 'التسويق' : 'Marketing'}</span>
            </div>
          </div>

          {/* The switcher — the one control that makes two workspaces one app. */}
          <button
            type="button"
            className="ws-switch"
            onClick={() => navigate('/')}
            title={isAr ? 'الانتقال إلى مساحة المبيعات' : 'Switch to the Sales workspace'}
          >
            <IconSwap />
            <span>
              {isAr ? 'مساحة التسويق' : 'Marketing workspace'}
              <span className="sw-sub">{isAr ? 'التبديل إلى المبيعات' : 'Switch to Sales'}</span>
            </span>
          </button>

          {NAV.map((group, gi) => (
            <div key={gi}>
              {group.ar && <div className="nav-sec">{isAr ? group.ar : group.en}</div>}
              {group.items.map((item) => (
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
          ))}

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

          <Outlet />
        </div>
      </div>
    </Ctx.Provider>
  );
}
