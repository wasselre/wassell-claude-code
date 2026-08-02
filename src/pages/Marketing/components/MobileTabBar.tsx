/**
 * The phone tab bar + the «المزيد» sheet — design screens 46 and 48.
 *
 * Four tabs: اليوم · المحتوى · التصوير · المزيد. The first three go straight
 * to the surfaces a phone-first role lives in; the fourth opens a rounded-top
 * sheet that reaches every REMAINING surface, grouped the way the desktop rail
 * groups them (s48: «كما في الشريط الجانبي للحاسوب»).
 *
 * Everything is FILTERED by the workspace surface matrix — a hidden surface is
 * absent, never disabled (s48's note: «الرفض بعد اللمس إهانة صغيرة متكررة»).
 * The bar itself only exists below 760px; the media query in mobile-shell.css
 * hides it entirely on desktop.
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ROLE_LABELS, type SurfaceKey } from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { initial, roleAvatarClass } from '../lib/format';
import '../styles/mobile-shell.css';

/* ------------------------------------------------------------------ */
/* icons — the EXACT paths drawn in s46/s48, not Lucide substitutes   */
/* ------------------------------------------------------------------ */

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'aria-hidden': true,
} as const;

/* Tab glyphs (s46/s48 .ph-tabs). */
const iconToday = (
  <svg {...base}><path d="M9 11l3 3 6-6" /><rect x="3" y="4" width="18" height="16" rx="2.5" /></svg>
);
const iconContent = <svg {...base}><path d="M4 6h16M4 12h16M4 18h10" /></svg>;
const iconShoot = (
  <svg {...base}><path d="M3 8h4l2-3h6l2 3h4v12H3z" /><circle cx="12" cy="13" r="3.5" /></svg>
);
const iconMore = <svg {...base}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;

/* Sheet row glyphs (s48's list). */
const iconOverview = (
  <svg {...base}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </svg>
);
const iconTeam = (
  <svg {...base}><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0112 0M16 11a3 3 0 100-6M18 20a5 5 0 00-2-4" /></svg>
);
const iconSearch = (
  <svg {...base}><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" /></svg>
);
const iconCalendar = (
  <svg {...base}><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
);
const iconLibrary = (
  <svg {...base}><rect x="3" y="4" width="18" height="14" rx="2.5" /><path d="M3 14l4.5-4 4 3.5L15 10l6 5.5" /></svg>
);
const iconNumbers = <svg {...base}><path d="M3 17l5-6 4 3 4-6 5 5" /><path d="M3 21h18" /></svg>;
const iconCampaigns = (
  <svg {...base}><path d="M3 11v3l14 5V6L3 11z" /><path d="M17 9a3 3 0 010 6" /></svg>
);
const iconSettings = (
  <svg {...base}>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2.2" />
    <circle cx="10" cy="17" r="2.2" />
  </svg>
);
const iconBell = (
  <svg {...base} className="muted"><path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6M10 20h4" /></svg>
);

/* ------------------------------------------------------------------ */
/* navigation model                                                   */
/* ------------------------------------------------------------------ */

interface TabDef {
  to: string;
  ar: string;
  en: string;
  surface: SurfaceKey;
  icon: JSX.Element;
}

/** The three direct tabs. المزيد is rendered separately — it is always there. */
const TABS: TabDef[] = [
  { to: '/m/my-work', ar: 'اليوم', en: 'Today', surface: 'mywork', icon: iconToday },
  { to: '/m/content', ar: 'المحتوى', en: 'Content', surface: 'content', icon: iconContent },
  { to: '/m/shoots', ar: 'التصوير', en: 'Shoots', surface: 'shoots', icon: iconShoot },
];

interface SheetLink {
  to: string;
  ar: string;
  en: string;
  surface: SurfaceKey | 'search';
  icon: JSX.Element;
}

interface SheetGroup {
  ar: string;
  en: string;
  items: SheetLink[];
}

/**
 * Every surface the three tabs do NOT reach, grouped as s48 groups them.
 * Labels are the workspace NAV's own bilingual labels.
 */
const SHEET_GROUPS: SheetGroup[] = [
  {
    ar: 'المتابعة', en: 'Follow-up',
    items: [
      { to: '/m', ar: 'نظرة عامة', en: 'Overview', surface: 'overview', icon: iconOverview },
      { to: '/m/team', ar: 'متابعة الفريق', en: 'Team work', surface: 'team', icon: iconTeam },
    ],
  },
  {
    ar: 'الإنتاج', en: 'Production',
    items: [
      { to: '/m/search', ar: 'البحث', en: 'Search', surface: 'search', icon: iconSearch },
      { to: '/m/calendar', ar: 'التقويم', en: 'Calendar', surface: 'calendar', icon: iconCalendar },
      { to: '/m/library', ar: 'مكتبة المواد', en: 'Asset library', surface: 'library', icon: iconLibrary },
    ],
  },
  {
    ar: 'الإنفاق', en: 'Spend',
    items: [
      { to: '/m/campaigns', ar: 'الحملات', en: 'Campaigns', surface: 'campaigns', icon: iconCampaigns },
      { to: '/m/numbers', ar: 'أرقام الأسبوع', en: 'Weekly numbers', surface: 'numbers', icon: iconNumbers },
    ],
  },
  {
    ar: 'الإعداد', en: 'Setup',
    items: [
      { to: '/m/settings', ar: 'الإعدادات', en: 'Settings', surface: 'settings', icon: iconSettings },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* component                                                          */
/* ------------------------------------------------------------------ */

export default function MobileTabBar() {
  const { role, surfaces, people, appUserId, isAr, ready } = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);

  // Navigating closes the sheet — same rule as the rail drawer.
  useEffect(() => { setOpen(false); }, [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Hidden = absent, never disabled. Before bootstrap lands everything shows,
  // mirroring the rail's own navVisible — no flash-removal on boot.
  const anyVisible = Object.values(surfaces).some((l) => l !== 'hidden');
  const visible = (s: SurfaceKey | 'search'): boolean => {
    if (!ready) return true;
    if (s === 'search') return anyVisible;
    return surfaces[s] !== 'hidden';
  };

  const tabs = TABS.filter((t) => visible(t.surface));

  const pathname = location.pathname;
  const isActive = (to: string): boolean => pathname === to || pathname.startsWith(`${to}/`);
  // المزيد lights whenever the sheet is open or the route is one it reaches
  // (نظرة عامة، الحساب، التقويم…) — s46 shows it active on حسابي.
  const moreActive = open || !TABS.some((t) => isActive(t.to));

  const go = (to: string): void => {
    setOpen(false);
    navigate(to);
  };

  const roleLabel = ROLE_LABELS[role] ? (isAr ? ROLE_LABELS[role].ar : ROLE_LABELS[role].en) : role;
  const person = people.find((p) => p.user_id === appUserId) ?? null;
  const personName = person
    ? ((isAr ? person.name_ar : person.name_en) ?? person.name_ar ?? person.name_en ?? person.email)
    : null;

  return (
    <>
      <nav className="mos-tabbar" aria-label={isAr ? 'التنقل السفلي' : 'Bottom navigation'}>
        {tabs.map((t) => (
          <button
            key={t.to}
            type="button"
            className={`mos-tab${isActive(t.to) ? ' on' : ''}`}
            onClick={() => go(t.to)}
            aria-current={isActive(t.to) ? 'page' : undefined}
          >
            {t.icon}
            {isAr ? t.ar : t.en}
          </button>
        ))}
        <button
          type="button"
          className={`mos-tab${moreActive ? ' on' : ''}`}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          {iconMore}
          {isAr ? 'المزيد' : 'More'}
        </button>
      </nav>

      {open && (
        <>
          <button
            type="button"
            className="mos-sheet-scrim"
            aria-label={isAr ? 'إغلاق' : 'Close'}
            onClick={() => setOpen(false)}
          />
          <div className="mos-sheet" role="dialog" aria-modal="true" aria-label={isAr ? 'المزيد' : 'More'}>
            <div className="mos-sheet-handle" aria-hidden="true" />
            <div className="mos-sheet-head">
              <h4>{isAr ? 'المزيد' : 'More'}</h4>
              <div className="sub">
                {personName
                  ? (isAr ? `${roleLabel} · يشغله ${personName}` : `${roleLabel} · held by ${personName}`)
                  : roleLabel}
              </div>
            </div>

            {SHEET_GROUPS.map((group) => {
              const items = group.items.filter((i) => visible(i.surface));
              if (items.length === 0) return null;
              return (
                <div key={group.en}>
                  <div className="lbl mos-sheet-lbl">{isAr ? group.ar : group.en}</div>
                  <div className="card mos-sheet-card">
                    {items.map((item) => (
                      <button key={item.to} type="button" className="mos-sheet-row" onClick={() => go(item.to)}>
                        {item.icon}
                        <span className="t">{isAr ? item.ar : item.en}</span>
                        <span className="c">‹</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* الحساب — always reachable, regardless of the surface matrix. */}
            <div className="lbl mos-sheet-lbl">{isAr ? 'الحساب' : 'Account'}</div>
            <div className="card mos-sheet-card">
              <button type="button" className="mos-sheet-row" onClick={() => go('/m/account')}>
                <span className={`av ${roleAvatarClass(role)}`}>{initial(personName ?? roleLabel)}</span>
                <span className="t">{personName ? `${personName} · ${roleLabel}` : roleLabel}</span>
                <span className="c">‹</span>
              </button>
              <button type="button" className="mos-sheet-row" onClick={() => go('/m/account')}>
                {iconBell}
                <span className="t">{isAr ? 'الإشعارات' : 'Notifications'}</span>
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
