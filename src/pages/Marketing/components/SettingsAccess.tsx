/**
 * Settings → Roles and permissions — ONE table (2026-10-04).
 *
 * Marketing runs on three roles (Manager, Writer, Montage). The screen used to
 * be two matrices — 18 surfaces × 5 roles with a three-state cycle, and 28
 * capabilities × 5 roles — most of whose rows controlled nothing any more
 * (calendar / goals / campaigns / numbers / roles had no screen left, and the
 * «read» level was never honoured by any page). Now:
 *
 *   • «ما يظهر» — the workspace tabs that can actually be hidden, as a tick:
 *     shown (surface level 'full') or hidden. The Manager sees everything by
 *     design (computeSurfaces), so that column is fixed.
 *   • «ما يستطيع فعله» — capabilities grouped into a few BUNDLES. A tick grants
 *     or revokes every capability in the bundle; a bundle that is partly held
 *     shows «جزئي» and a tick completes it. These are the same capabilities RLS
 *     enforces (wassell_mos_can), so a tick changes what the database allows.
 *
 * Fixed cells (never editable here): the read/comment base every role needs to
 * open the workspace at all, and the Manager's «settings and team» bundle —
 * removing that would lock the only role that can undo it out of this screen.
 * Any capability the server knows that no bundle lists shows as its own row,
 * so a newly-seeded capability can never become invisible.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  ACTIVE_PATH_ROLES, ROLE_LABELS, type MosPathRole, type SurfaceKey,
  fetchSurfaceMatrix, setSurface, fetchCapabilityMatrix, setCapability,
} from '@/lib/marketingOS/client';
import { LoadError, PageHead, Skeleton } from './kit';
import { IconBack, IconForward } from './icons';

interface Row { key: string; ar: string; en: string }

/** The tabs a role can be shown or not, grouped by the workspace tab they sit in. */
const SURFACE_GROUPS: Array<{ ar: string; en: string; rows: Array<Row & { key: SurfaceKey }> }> = [
  {
    ar: 'الشهر', en: 'The month',
    rows: [{ key: 'overview', ar: 'نظرة عامة', en: 'Overview' }],
  },
  {
    ar: 'العمل', en: 'Work',
    rows: [
      { key: 'mywork', ar: 'مهامي', en: 'My work' },
      { key: 'team', ar: 'عمل الفريق داخل «مهامي»', en: 'The team inside «My work»' },
      { key: 'performance', ar: 'مكتب الأداء', en: 'Performance desk' },
      { key: 'myperf', ar: 'ملفي', en: 'My profile' },
    ],
  },
  {
    ar: 'المحتوى', en: 'Content',
    rows: [
      { key: 'content', ar: 'المحتوى', en: 'Content' },
      { key: 'shoots', ar: 'طلبات التصوير', en: 'Shoot requests' },
      { key: 'library', ar: 'مكتبة المواد', en: 'Asset library' },
    ],
  },
  {
    ar: 'النشر', en: 'Publishing',
    rows: [
      { key: 'publishing', ar: 'لوحة النشر', en: 'Publishing board' },
      { key: 'organic', ar: 'نبض المنصات', en: 'Platform pulse' },
    ],
  },
  {
    ar: 'الإعدادات', en: 'Settings',
    rows: [{ key: 'settings', ar: 'الإعدادات', en: 'Settings' }],
  },
];

interface Bundle extends Row { caps: string[]; desc_ar: string; desc_en: string }

/** Always held by every role — the floor for opening the workspace at all. */
const BASE_CAPS = ['read', 'comment', 'compare_versions', 'view_activity', 'view_content_body'];

/** Settings & team — fixed ON for the Manager (lockout guard). */
const ADMIN_BUNDLE = 'admin';

const BUNDLES: Bundle[] = [
  {
    key: 'write', caps: ['write_content'],
    ar: 'العمل على المحتوى', en: 'Work on content',
    desc_ar: 'كتابة النصوص وتعديل المحتوى.', desc_en: 'Write and edit content.',
  },
  {
    key: 'files', caps: ['manage_assets'],
    ar: 'إدارة الملفات', en: 'Manage files',
    desc_ar: 'رفع المواد والتصاميم وتنظيمها.', desc_en: 'Upload and organise media and designs.',
  },
  {
    key: 'publish', caps: ['schedule', 'publish'],
    ar: 'الجدولة والنشر', en: 'Schedule and publish',
    desc_ar: 'تحديد مواعيد النشر وإرسال المنشورات.', desc_en: 'Set publish times and send posts out.',
  },
  {
    key: 'approve', caps: ['approve_creative', 'approve_process', 'approve_plan', 'rate_creative', 'revise_approved_content'],
    ar: 'الاعتماد', en: 'Approve',
    desc_ar: 'اعتماد العمل وخطة الشهر، وتقييم التصاميم، وإعادة فتح ما اعتُمد.',
    desc_en: 'Approve work and the month plan, rate creatives, reopen approved work.',
  },
  {
    key: 'assign', caps: ['assign', 'assign_task'],
    ar: 'توزيع المهام', en: 'Assign work',
    desc_ar: 'إسناد المهام للآخرين وإعادة ترتيبها.', desc_en: 'Hand tasks to others and reorder them.',
  },
  {
    key: 'ads', caps: ['plan_campaign', 'approve_budget', 'manage_paid_ads', 'decide_refresh', 'enter_metrics'],
    ar: 'الحملات والإعلانات', en: 'Campaigns and ads',
    desc_ar: 'تخطيط الحملات، توقيع الميزانية، إدارة إعلانات ميتا، وإدخال الأرقام.',
    desc_en: 'Plan campaigns, sign budgets, run Meta ads, enter numbers.',
  },
  {
    key: 'perf', caps: ['review_performance', 'view_team_kpis', 'manage_performance'],
    ar: 'الأداء', en: 'Performance',
    desc_ar: 'رؤية أرقام الفريق وقرارات الأداء.', desc_en: 'See team numbers and make performance decisions.',
  },
  {
    key: ADMIN_BUNDLE, caps: ['manage_settings', 'manage_roles', 'manage_capacity', 'delete_records'],
    ar: 'الإعدادات والفريق', en: 'Settings and team',
    desc_ar: 'تعديل الإعدادات والصلاحيات وطاقة العمل، وحذف السجلات.',
    desc_en: 'Change settings, permissions and capacity; delete records.',
  },
];

type BundleState = 'on' | 'off' | 'partial';

function Tick({ state }: { state: BundleState | 'fixed' }) {
  if (state === 'on' || state === 'fixed') return <span className="mk2 mk-f">✓</span>;
  if (state === 'partial') return <span className="mk2 mk-r">◐</span>;
  return <span className="mk2 mk-n">—</span>;
}

/**
 * embedded — rendered as the «أدوار التسويق» tab of the Sales app's Team & Access
 * page: the back-to-Marketing-settings crumb is dropped (that page has its own).
 */
export default function SettingsAccess({ canManage, isAr, embedded = false }: { canManage: boolean; isAr: boolean; embedded?: boolean }) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;

  const [roleKeys, setRoleKeys] = useState<string[]>([]);
  /** `${role}|${surface}` → shown. Absent = hidden. */
  const [shown, setShown] = useState<Set<string>>(new Set());
  /** `${role}|${capability}` granted. */
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [serverCaps, setServerCaps] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [surf, caps] = await Promise.all([fetchSurfaceMatrix(), fetchCapabilityMatrix()]);
      const live = new Set([...surf.roles, ...caps.roles].map((r) => r.key));
      setRoleKeys(ACTIVE_PATH_ROLES.filter((k) => live.has(k)));
      setShown(new Set(surf.cells.filter((c) => c.level !== 'hidden').map((c) => `${c.role_key}|${c.surface_key}`)));
      setGranted(new Set(caps.cells.map((c) => `${c.role_key}|${c.capability}`)));
      setServerCaps(caps.capabilities);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Safety net: a capability no bundle (or the base) names still gets a row.
  const bundles = useMemo<Bundle[]>(() => {
    const listed = new Set([...BASE_CAPS, ...BUNDLES.flatMap((b) => b.caps)]);
    const extra = serverCaps.filter((c) => !listed.has(c)).map((c) => ({
      key: `cap:${c}`, caps: [c], ar: c, en: c, desc_ar: '', desc_en: '',
    }));
    return [...BUNDLES, ...extra];
  }, [serverCaps]);

  const roleName = (r: string): string => {
    const l = ROLE_LABELS[r as MosPathRole];
    return l ? (isAr ? l.ar : l.en) : r;
  };

  const bundleState = (role: string, b: Bundle): BundleState => {
    const held = b.caps.filter((c) => granted.has(`${role}|${c}`)).length;
    if (held === 0) return 'off';
    return held === b.caps.length ? 'on' : 'partial';
  };

  const toggleSurface = async (role: string, surface: SurfaceKey): Promise<void> => {
    const key = `${role}|${surface}`;
    const was = shown.has(key);
    const flip = (on: boolean) => setShown((s) => {
      const copy = new Set(s);
      if (on) copy.add(key); else copy.delete(key);
      return copy;
    });
    flip(!was);
    setBusy(key);
    try {
      await setSurface(role, surface, was ? 'hidden' : 'full');
    } catch (e) {
      flip(was);
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggleBundle = async (role: string, b: Bundle): Promise<void> => {
    // A partial bundle completes; a full one clears.
    const grant = bundleState(role, b) !== 'on';
    const changing = b.caps.filter((c) => granted.has(`${role}|${c}`) !== grant);
    const busyKey = `${role}|${b.key}`;
    setBusy(busyKey);
    const done: string[] = [];
    try {
      // One at a time so a failure leaves an exact, reportable state.
      for (const c of changing) {
        await setCapability(role, c, grant);
        done.push(c);
        setGranted((s) => {
          const copy = new Set(s);
          if (grant) copy.add(`${role}|${c}`); else copy.delete(`${role}|${c}`);
          return copy;
        });
      }
    } catch (e) {
      addToast(
        (isAr ? `تغيّر ${done.length} من ${changing.length}: ` : `Changed ${done.length} of ${changing.length}: `)
          + (e instanceof Error ? e.message : String(e)),
        'error',
      );
    } finally {
      setBusy(null);
    }
  };

  const fixedFor = (role: string, b: Bundle): boolean => role === 'marketing_manager' && b.key === ADMIN_BUNDLE;

  return (
    <>
      <PageHead
        title={isAr ? 'الأدوار والصلاحيات' : 'Roles and permissions'}
        sub={isAr
          ? 'ثلاثة أدوار. علامة ✓ تعني نعم — اضغطها للتبديل. يسري التغيير عند فتح كل شخص للتطبيق من جديد.'
          : 'Three roles. ✓ means yes — tap it to switch. A change applies the next time each person opens the app.'}
        crumb={embedded ? undefined : (
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        )}
      />
      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={6} />}
        {!loading && !error && (
          <div className="card">
            <div className="tbl-wrap">
              <table className="mx">
                <thead>
                  <tr>
                    <th />
                    {roleKeys.map((r) => <th key={r}>{roleName(r)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  <tr className="sec">
                    <td colSpan={roleKeys.length + 1}>{isAr ? 'ما يظهر له' : 'What they see'}</td>
                  </tr>
                  {SURFACE_GROUPS.map((g) => g.rows.map((s, i) => (
                    <tr key={s.key}>
                      <td>
                        {i === 0 && <span style={{ color: 'var(--mute)' }}>{isAr ? g.ar : g.en} › </span>}
                        {isAr ? s.ar : s.en}
                      </td>
                      {roleKeys.map((r) => {
                        // The Manager sees every tab by design (computeSurfaces).
                        if (r === 'marketing_manager') {
                          return <td key={r}><span className="se-cell" style={{ cursor: 'default' }}><Tick state="fixed" /></span></td>;
                        }
                        const key = `${r}|${s.key}`;
                        return (
                          <td key={r}>
                            <button
                              type="button"
                              className="se-cell"
                              disabled={!canManage || busy !== null}
                              aria-pressed={shown.has(key)}
                              aria-label={`${roleName(r)} — ${isAr ? s.ar : s.en}`}
                              onClick={() => void toggleSurface(r, s.key)}
                            >
                              <Tick state={shown.has(key) ? 'on' : 'off'} />
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  )))}

                  <tr className="sec">
                    <td colSpan={roleKeys.length + 1}>{isAr ? 'ما يستطيع فعله' : 'What they can do'}</td>
                  </tr>
                  <tr>
                    <td>
                      {isAr ? 'الاطلاع والتعليق' : 'View and comment'}
                      <div style={{ fontSize: 11, color: 'var(--mute)' }}>
                        {isAr ? 'لكل الأدوار دائمًا — بدونها لا يفتح المساحة.' : 'Every role, always — without it the workspace will not open.'}
                      </div>
                    </td>
                    {roleKeys.map((r) => (
                      <td key={r}><span className="se-cell" style={{ cursor: 'default' }}><Tick state="fixed" /></span></td>
                    ))}
                  </tr>
                  {bundles.map((b) => (
                    <tr key={b.key}>
                      <td>
                        {isAr ? b.ar : b.en}
                        {(isAr ? b.desc_ar : b.desc_en) && (
                          <div style={{ fontSize: 11, color: 'var(--mute)' }}>{isAr ? b.desc_ar : b.desc_en}</div>
                        )}
                      </td>
                      {roleKeys.map((r) => {
                        if (fixedFor(r, b)) {
                          return <td key={r}><span className="se-cell" style={{ cursor: 'default' }}><Tick state="fixed" /></span></td>;
                        }
                        const st = bundleState(r, b);
                        return (
                          <td key={r}>
                            <button
                              type="button"
                              className="se-cell"
                              disabled={!canManage || busy !== null}
                              aria-pressed={st === 'on'}
                              aria-label={`${roleName(r)} — ${isAr ? b.ar : b.en}`}
                              title={st === 'partial' ? (isAr ? 'جزئي — اضغط لإكماله' : 'Partly — tap to complete') : undefined}
                              onClick={() => void toggleBundle(r, b)}
                            >
                              <Tick state={st} />
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-b" style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.8, borderTop: '1px solid var(--line-soft)' }}>
              {isAr
                ? 'الشهر، والجرد، والجاهزية، والتحليلات، والمنافسون مفتوحة لكل دور. «ما يستطيع فعله» تفرضه قاعدة البيانات نفسها، لا الأزرار فقط. من يشغل كل دور يُحدَّد في الإعدادات › الفريق والصلاحيات › الأشخاص.'
                : 'The month, inventory, readiness, analytics and competitors are open to every role. «What they can do» is enforced by the database itself, not just the buttons. Who holds each role is set in Settings › Team & Access › People.'}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
