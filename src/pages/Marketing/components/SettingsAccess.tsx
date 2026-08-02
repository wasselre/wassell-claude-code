/**
 * Settings → Roles and permissions — design screen 33.
 *
 * The permission table lives inside the product, not in a message. Every row
 * is a surface, every column a role, every cell one of three states:
 *   ● full — sees and edits      ○ read — sees, cannot edit
 *   — hidden — absent from that role's rail entirely (no button that leads to
 *     a refusal message).
 *
 * Cells are EDITABLE: a click cycles full → read → hidden via `surface_set`,
 * optimistically, and the change is effective immediately for everyone holding
 * the role — the rail consults the same surface_access rows on boot.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  ROLE_LABELS, MosPathRole, SurfaceKey, SurfaceLevel,
  fetchSurfaceMatrix, setSurface,
} from '@/lib/marketingOS/client';
import { LoadError, PageHead, Skeleton } from './kit';
import { IconBack, IconForward } from './icons';
import { num } from '../lib/format';

/** Canonical column order — the mockup's, from most senior to most hands-on. */
const COLUMN_ORDER: MosPathRole[] = ['ceo', 'marketing_manager', 'ops_supervisor', 'writer', 'montage'];

/** The rail's surfaces, grouped the way the mockup groups its rows. */
const SURFACE_GROUPS: Array<{ ar: string; en: string; keys: Array<{ key: SurfaceKey; ar: string; en: string }> }> = [
  {
    ar: 'لوحات المتابعة', en: 'Dashboards',
    keys: [
      { key: 'overview', ar: 'نظرة عامة', en: 'Overview' },
      { key: 'mywork', ar: 'مهامي', en: 'My work' },
      { key: 'team', ar: 'متابعة الفريق', en: 'Team work' },
    ],
  },
  {
    ar: 'الإنتاج', en: 'Production',
    keys: [
      { key: 'content', ar: 'المحتوى', en: 'Content' },
      { key: 'calendar', ar: 'التقويم', en: 'Calendar' },
      { key: 'library', ar: 'مكتبة المواد', en: 'Asset library' },
      { key: 'shoots', ar: 'طلبات التصوير', en: 'Shoot requests' },
    ],
  },
  {
    ar: 'الإنفاق', en: 'Spend',
    keys: [
      { key: 'campaigns', ar: 'الحملات', en: 'Campaigns' },
      { key: 'numbers', ar: 'أرقام الأسبوع', en: 'Weekly numbers' },
    ],
  },
  {
    ar: 'الإعداد', en: 'Setup',
    keys: [
      { key: 'settings', ar: 'الإعدادات', en: 'Settings' },
      { key: 'roles', ar: 'الأدوار والصلاحيات', en: 'Roles and permissions' },
    ],
  },
];

const NEXT_LEVEL: Record<SurfaceLevel, SurfaceLevel> = { full: 'read', read: 'hidden', hidden: 'full' };

function LevelMark({ level }: { level: SurfaceLevel }) {
  if (level === 'full') return <span className="mk2 mk-f">●</span>;
  if (level === 'read') return <span className="mk2 mk-r">○</span>;
  return <span className="mk2 mk-n">—</span>;
}

export default function SettingsAccess({ canManage, isAr }: { canManage: boolean; isAr: boolean }) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;

  const [roles, setRoles] = useState<Array<{ key: string; role_id: string }>>([]);
  const [serverSurfaces, setServerSurfaces] = useState<string[]>([]);
  const [cells, setCells] = useState<Map<string, SurfaceLevel>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchSurfaceMatrix();
      setRoles(res.roles);
      setServerSurfaces(res.surfaces);
      const m = new Map<string, SurfaceLevel>();
      for (const c of res.cells) m.set(`${c.role_key}|${c.surface_key}`, c.level);
      setCells(m);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const columns = useMemo(() => {
    const known = COLUMN_ORDER.filter((k) => roles.some((r) => r.key === k));
    const extra = roles.map((r) => r.key).filter((k) => !(COLUMN_ORDER as string[]).includes(k));
    return [...known, ...extra];
  }, [roles]);

  // Any surface the server knows that the grouping above doesn't — rendered in
  // a trailing group so a new surface key can never silently vanish.
  const groups = useMemo(() => {
    const grouped = new Set(SURFACE_GROUPS.flatMap((g) => g.keys.map((k) => k.key as string)));
    const leftovers = serverSurfaces.filter((s) => !grouped.has(s));
    if (leftovers.length === 0) return SURFACE_GROUPS;
    return [...SURFACE_GROUPS, {
      ar: 'أخرى', en: 'Other',
      keys: leftovers.map((s) => ({ key: s as SurfaceKey, ar: s, en: s })),
    }];
  }, [serverSurfaces]);

  const surfaceCount = useMemo(() => groups.reduce((n, g) => n + g.keys.length, 0), [groups]);

  const levelOf = (roleKey: string, surfaceKey: string): SurfaceLevel =>
    cells.get(`${roleKey}|${surfaceKey}`) ?? 'hidden';

  const cycle = async (roleKey: string, surfaceKey: SurfaceKey): Promise<void> => {
    const current = levelOf(roleKey, surfaceKey);
    const next = NEXT_LEVEL[current];
    // Optimistic — the click must feel like flipping a switch, not filing a form.
    setCells((m) => new Map(m).set(`${roleKey}|${surfaceKey}`, next));
    try {
      await setSurface(roleKey, surfaceKey, next);
      // TODO(client): the workspace ctx exposes no surface refresh (reloadGrants
      // covers people only) — everyone's rail picks the change up on the next
      // boot. Orchestrator to wire a reloadSurfaces on MarketingWorkspace.
    } catch (e) {
      setCells((m) => new Map(m).set(`${roleKey}|${surfaceKey}`, current));
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  return (
    <>
      <PageHead
        title={isAr ? 'الأدوار والصلاحيات' : 'Roles and permissions'}
        sub={
          isAr
            ? `${num(columns.length, true)} أدوار · ${num(surfaceCount, true)} شاشة · التعديل يسري فورًا على كل من يشغل الدور`
            : `${columns.length} roles · ${surfaceCount} surfaces · changes apply immediately to everyone holding the role`
        }
        crumb={
          <button type="button" onClick={() => navigate('/m/settings')}>
            <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الإعدادات' : 'Settings'}
          </button>
        }
      />
      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && <Skeleton rows={6} />}
        {!loading && !error && (
          <div className="se-split">
            <div className="card" style={{ flex: 1, minWidth: 0 }}>
              <div className="tbl-wrap">
                <table className="mx">
                  <thead>
                    <tr>
                      <th>{isAr ? 'الشاشة أو الإجراء' : 'Surface or action'}</th>
                      {columns.map((r) => (
                        <th key={r}>
                          {ROLE_LABELS[r as MosPathRole]
                            ? (isAr ? ROLE_LABELS[r as MosPathRole].ar : ROLE_LABELS[r as MosPathRole].en)
                            : r}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => (
                      [
                        <tr key={`sec-${g.en}`} className="sec">
                          <td colSpan={columns.length + 1}>{isAr ? g.ar : g.en}</td>
                        </tr>,
                        ...g.keys.map((s) => (
                          <tr key={s.key}>
                            <td>{isAr ? s.ar : s.en}</td>
                            {columns.map((r) => {
                              const level = levelOf(r, s.key);
                              return (
                                <td key={r}>
                                  <button
                                    type="button"
                                    className="se-cell"
                                    disabled={!canManage}
                                    title={
                                      isAr
                                        ? 'كامل ← قراءة ← مخفي — اضغط للتبديل'
                                        : 'Full → read → hidden — click to cycle'
                                    }
                                    onClick={() => void cycle(r, s.key)}
                                  >
                                    <LevelMark level={level} />
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        )),
                      ]
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="se-side">
              <div className="card">
                <div className="card-h"><h4>{isAr ? 'الرموز' : 'Legend'}</h4></div>
                <div className="card-b" style={{ display: 'grid', gap: 11, fontSize: 12 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span className="mk2 mk-f">●</span>
                    <span>{isAr ? 'كامل — يرى ويعدّل' : 'Full — sees and edits'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span className="mk2 mk-r">○</span>
                    <span>{isAr ? 'قراءة فقط — يرى ولا يعدّل' : 'Read only — sees, cannot edit'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span className="mk2 mk-n">—</span>
                    <span>{isAr ? 'مخفي — غير موجود في قائمته أصلًا' : 'Hidden — absent from their rail entirely'}</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--mute)', paddingTop: 9, borderTop: '1px solid var(--line-soft)', lineHeight: 1.75 }}>
                    {isAr
                      ? '«مخفي» لا تعني زرًا يعطي رسالة رفض. تعني أن العنصر غير موجود في الشريط الجانبي — فلا يتعلم أحد وجود أبواب مغلقة.'
                      : '"Hidden" is not a button that answers with a refusal. The item simply does not exist in the sidebar — nobody learns there are locked doors.'}
                  </div>
                </div>
              </div>

              <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--copper) 34%, transparent)' }}>
                <div className="card-h" style={{ background: 'color-mix(in srgb, var(--copper) 7%, transparent)' }}>
                  <h4>{isAr ? 'لماذا صفّان للاعتماد؟' : 'Why two approval rows?'}</h4>
                </div>
                <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
                  {isAr ? (
                    <>
                      كانت كل مراجعة تذهب لمدير التسويق، وقالت البيانات إن <b>خمسة من تسعة أيام</b> تضيع في الانتظار عنده.
                      <div style={{ marginTop: 9 }}>
                        فصل «هل المواد مكتملة؟» و«هل الجدولة صحيحة؟» إلى مشرف العمليات يقلّص طابور المدير إلى النصف تقريبًا <b>دون أن يفقد أي سيطرة على العمل نفسه</b>.
                      </div>
                      <div style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--line-soft)', color: 'var(--mute)' }}>
                        عكسه إعداد واحد لكل خطوة في صفحة مسارات العمل.
                      </div>
                    </>
                  ) : (
                    <>
                      Every review used to go to the Marketing Manager, and the data said <b>five of nine days</b> were lost waiting on him.
                      <div style={{ marginTop: 9 }}>
                        Splitting &quot;is the material complete?&quot; and &quot;is the schedule right?&quot; off to the Operations Supervisor roughly halves the manager&apos;s queue <b>without losing any control over the work itself</b>.
                      </div>
                      <div style={{ marginTop: 9, paddingTop: 9, borderTop: '1px solid var(--line-soft)', color: 'var(--mute)' }}>
                        Undoing it is one setting per step on the Workflows page.
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="card">
                <div className="card-h"><h4>{isAr ? 'ماذا لو تعارضت؟' : 'What if they conflict?'}</h4></div>
                <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
                  {isAr ? (
                    <>
                      إذا منح الدور صلاحية ومنعها مسار العمل، <b>يفوز مسار العمل</b>. الكاتب يملك صلاحية الكتابة، لكنه لا يستطيع تعديل نص في مرحلة المونتاج — لأن السجل ليس عنده.
                    </>
                  ) : (
                    <>
                      When the role grants something and the workflow forbids it, <b>the workflow wins</b>. The writer holds write permission, yet cannot edit a script during the editing stage — because the record is not with them.
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
