/**
 * Settings → Roles and permissions — design screen 33, extended.
 *
 * TWO axes, edited in ONE place (they used to disagree — the screen showed
 * only surfaces while the real gates were hardcoded capabilities):
 *
 *   • Surfaces (visibility) — which sections appear in a role's rail. Three
 *     states: ● full · ○ read · — hidden. "Hidden" removes the rail item,
 *     not a button that refuses.
 *   • Capabilities (actions) — what a role can DO inside those surfaces
 *     (write content, approve a budget, see a script…). On or off. These are
 *     the SAME capabilities RLS enforces (wassell_mos_can), so a toggle here
 *     changes both the buttons the role sees and what the database allows.
 *
 * Every cell is EDITABLE (requires the 'manage_roles' capability); changes
 * apply on everyone's next boot (the rail/capabilities are read at bootstrap).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  ROLE_LABELS, MosPathRole, SurfaceKey, SurfaceLevel,
  fetchSurfaceMatrix, setSurface,
  fetchCapabilityMatrix, setCapability,
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

/**
 * The capabilities, grouped by the kind of work they authorize. These mirror
 * the CAPABILITIES list in api/marketing-os.ts and the seed in migration
 * 2026-08-06_01_role_capabilities.sql — keep the three in sync.
 */
const CAPABILITY_GROUPS: Array<{ ar: string; en: string; keys: Array<{ key: string; ar: string; en: string }> }> = [
  {
    ar: 'الاطلاع والتفاعل', en: 'View & interact',
    keys: [
      { key: 'read', ar: 'الاطلاع', en: 'View' },
      { key: 'comment', ar: 'التعليق', en: 'Comment' },
      { key: 'view_content_body', ar: 'رؤية النص والمشاهد', en: 'See script & scenes' },
      { key: 'view_activity', ar: 'رؤية النشاط والتعليقات', en: 'See activity & comments' },
      { key: 'compare_versions', ar: 'مقارنة النسخ', en: 'Compare versions' },
    ],
  },
  {
    ar: 'الإنتاج', en: 'Produce',
    keys: [
      { key: 'write_content', ar: 'كتابة المحتوى', en: 'Write content' },
      { key: 'manage_assets', ar: 'إدارة المواد', en: 'Manage assets' },
    ],
  },
  {
    ar: 'الجدولة والنشر', en: 'Schedule & publish',
    keys: [
      { key: 'assign', ar: 'الإسناد وإعادة الترتيب', en: 'Assign & reorder' },
      { key: 'schedule', ar: 'الجدولة', en: 'Schedule' },
      { key: 'publish', ar: 'النشر', en: 'Publish' },
    ],
  },
  {
    ar: 'الاعتماد', en: 'Approvals',
    keys: [
      { key: 'approve_creative', ar: 'اعتماد الإبداع', en: 'Approve creative' },
      { key: 'approve_process', ar: 'اعتماد الإجراءات', en: 'Approve process' },
      { key: 'approve_budget', ar: 'اعتماد الميزانية', en: 'Approve budget' },
    ],
  },
  {
    ar: 'القياس', en: 'Measurement',
    keys: [
      { key: 'enter_metrics', ar: 'إدخال الأرقام', en: 'Enter metrics' },
      { key: 'review_performance', ar: 'مراجعة الأداء', en: 'Review performance' },
    ],
  },
  {
    ar: 'الإدارة', en: 'Administration',
    keys: [
      { key: 'manage_settings', ar: 'إدارة الإعدادات', en: 'Manage settings' },
      { key: 'manage_roles', ar: 'إدارة الأدوار والصلاحيات', en: 'Manage roles & permissions' },
    ],
  },
];

const NEXT_LEVEL: Record<SurfaceLevel, SurfaceLevel> = { full: 'read', read: 'hidden', hidden: 'full' };

/**
 * s49 phone2 — the one-line answer to «ماذا يرى هذا الدور؟», shown above the
 * selected role's list. The approval split is the design's core rule: creative
 * to the marketing manager, process to the ops supervisor, nothing to the CEO.
 */
const ROLE_NOTES: Record<string, { ar: string; en: string }> = {
  ceo: {
    ar: 'لا يعتمد أي محتوى إطلاقًا، ويوقّع الميزانيات فوق الحد فقط.',
    en: 'Approves no content at all, and only signs budgets above the threshold.',
  },
  marketing_manager: {
    ar: 'يعتمد العمل نفسه — الفكرة والنص والنسخة والتصميم والمونتاج النهائي.',
    en: 'Approves the work itself — the idea, the script, the copy, the design and the final cut.',
  },
  ops_supervisor: {
    ar: 'يعتمد الإجراءات — اكتمال المواد، وصحة الجدولة، والتقاط الرابط. ولا يعتمد أي عمل إبداعي.',
    en: 'Approves process — material completeness, schedule correctness, capturing the publish link. Never creative work.',
  },
  writer: {
    ar: 'ينتج — يكتب الأفكار والنصوص، ولا يعتمد شيئًا.',
    en: 'Produces — writes ideas and scripts, approves nothing.',
  },
  montage: {
    ar: 'ينتج — يصمم ويحرّر، ولا يعتمد شيئًا.',
    en: 'Produces — designs and edits, approves nothing.',
  },
};

/** The mobile group headings, in the mockup's order and wording. */
const LEVEL_GROUPS: Array<{ level: SurfaceLevel; ar: string; en: string }> = [
  { level: 'full',   ar: 'وصول كامل',    en: 'Full access' },
  { level: 'read',   ar: 'للاطلاع فقط',  en: 'Read only' },
  { level: 'hidden', ar: 'غير ظاهر',     en: 'Not visible' },
];

type MatrixKind = 'surfaces' | 'capabilities';

function LevelMark({ level }: { level: SurfaceLevel }) {
  if (level === 'full') return <span className="mk2 mk-f">●</span>;
  if (level === 'read') return <span className="mk2 mk-r">○</span>;
  return <span className="mk2 mk-n">—</span>;
}

function CapMark({ on }: { on: boolean }) {
  return on ? <span className="mk2 mk-f">●</span> : <span className="mk2 mk-n">—</span>;
}

export default function SettingsAccess({ canManage, isAr }: { canManage: boolean; isAr: boolean }) {
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const Back = isAr ? IconForward : IconBack;

  const [matrix, setMatrix] = useState<MatrixKind>('surfaces');

  const [roles, setRoles] = useState<Array<{ key: string; role_id: string }>>([]);
  const [serverSurfaces, setServerSurfaces] = useState<string[]>([]);
  const [cells, setCells] = useState<Map<string, SurfaceLevel>>(new Map());
  // Capabilities: a flat set of `${role}|${capability}` keys that are granted.
  const [serverCaps, setServerCaps] = useState<string[]>([]);
  const [capCells, setCapCells] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** s49 phone2 — the role the phone list is answering for. */
  const [mobRole, setMobRole] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [surf, caps] = await Promise.all([fetchSurfaceMatrix(), fetchCapabilityMatrix()]);
      setRoles(surf.roles);
      setServerSurfaces(surf.surfaces);
      const m = new Map<string, SurfaceLevel>();
      for (const c of surf.cells) m.set(`${c.role_key}|${c.surface_key}`, c.level);
      setCells(m);
      setServerCaps(caps.capabilities);
      const cap = new Set<string>();
      for (const c of caps.cells) cap.add(`${c.role_key}|${c.capability}`);
      setCapCells(cap);
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
  const surfaceGroups = useMemo(() => {
    const grouped = new Set(SURFACE_GROUPS.flatMap((g) => g.keys.map((k) => k.key as string)));
    const leftovers = serverSurfaces.filter((s) => !grouped.has(s));
    if (leftovers.length === 0) return SURFACE_GROUPS;
    return [...SURFACE_GROUPS, {
      ar: 'أخرى', en: 'Other',
      keys: leftovers.map((s) => ({ key: s as SurfaceKey, ar: s, en: s })),
    }];
  }, [serverSurfaces]);

  // Same safety net for capabilities: any server capability the grouping misses
  // still shows, so a newly-seeded capability never becomes invisible/un-editable.
  const capabilityGroups = useMemo(() => {
    const grouped = new Set(CAPABILITY_GROUPS.flatMap((g) => g.keys.map((k) => k.key)));
    const leftovers = serverCaps.filter((c) => !grouped.has(c));
    if (leftovers.length === 0) return CAPABILITY_GROUPS;
    return [...CAPABILITY_GROUPS, {
      ar: 'أخرى', en: 'Other',
      keys: leftovers.map((c) => ({ key: c, ar: c, en: c })),
    }];
  }, [serverCaps]);

  const activeGroups = matrix === 'surfaces' ? surfaceGroups : capabilityGroups;
  const cellCount = useMemo(
    () => activeGroups.reduce((n, g) => n + g.keys.length, 0),
    [activeGroups],
  );

  const levelOf = (roleKey: string, surfaceKey: string): SurfaceLevel =>
    cells.get(`${roleKey}|${surfaceKey}`) ?? 'hidden';
  const capOf = (roleKey: string, capability: string): boolean =>
    capCells.has(`${roleKey}|${capability}`);

  const cycle = async (roleKey: string, surfaceKey: string): Promise<void> => {
    const current = levelOf(roleKey, surfaceKey);
    const next = NEXT_LEVEL[current];
    // Optimistic — the click must feel like flipping a switch, not filing a form.
    setCells((m) => new Map(m).set(`${roleKey}|${surfaceKey}`, next));
    try {
      await setSurface(roleKey, surfaceKey as SurfaceKey, next);
    } catch (e) {
      setCells((m) => new Map(m).set(`${roleKey}|${surfaceKey}`, current));
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const toggleCap = async (roleKey: string, capability: string): Promise<void> => {
    const current = capOf(roleKey, capability);
    const next = !current;
    const key = `${roleKey}|${capability}`;
    setCapCells((s) => {
      const copy = new Set(s);
      if (next) copy.add(key); else copy.delete(key);
      return copy;
    });
    try {
      await setCapability(roleKey, capability, next);
    } catch (e) {
      setCapCells((s) => {
        const copy = new Set(s);
        if (current) copy.add(key); else copy.delete(key);
        return copy;
      });
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const sub = isAr
    ? `${num(columns.length, true)} أدوار · ${num(cellCount, true)} ${matrix === 'surfaces' ? 'شاشة' : 'صلاحية'} · التعديل يسري فورًا على كل من يشغل الدور`
    : `${columns.length} roles · ${cellCount} ${matrix === 'surfaces' ? 'surfaces' : 'capabilities'} · changes apply on everyone's next load`;

  return (
    <>
      <PageHead
        title={isAr ? 'الأدوار والصلاحيات' : 'Roles and permissions'}
        sub={sub}
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
          <>
          {/* ── Which axis are we editing? Surfaces = what's in the rail;
                Capabilities = what the role can do inside it. ───────────── */}
          <div className="seg" style={{ marginBottom: 14, display: 'inline-flex', gap: 4 }}>
            <button
              type="button"
              className={`fbtn${matrix === 'surfaces' ? ' on' : ''}`}
              onClick={() => setMatrix('surfaces')}
            >
              {isAr ? 'الشاشات' : 'Surfaces'}
            </button>
            <button
              type="button"
              className={`fbtn${matrix === 'capabilities' ? ' on' : ''}`}
              onClick={() => setMatrix('capabilities')}
            >
              {isAr ? 'الصلاحيات' : 'Capabilities'}
            </button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--mute)', marginBottom: 12, lineHeight: 1.7 }}>
            {matrix === 'surfaces'
              ? isAr
                ? 'الشاشات تتحكم فيما يظهر في شريط الدور فقط. ما يستطيع الدور فعله تحدده «الصلاحيات».'
                : 'Surfaces control only what appears in the role\'s rail. What the role can DO is set under "Capabilities".'
              : isAr
                ? 'الصلاحيات تحدد ما يستطيع الدور فعله فعلاً — وهي نفسها التي تفرضها قاعدة البيانات، فالتبديل هنا يغيّر الأزرار وما تسمح به القاعدة معًا.'
                : 'Capabilities are what a role can actually do — the very ones the database enforces, so a toggle here changes both the buttons and what the database allows.'}
          </div>

          {/* ── s49 phone2 — one role at a time, a list of what it sees/does. ── */}
          <div className="m4-mob m4-roles">
            {(() => {
              const activeRole = mobRole ?? columns[0] ?? null;
              if (!activeRole) return null;
              const note = ROLE_NOTES[activeRole];
              const roleName = ROLE_LABELS[activeRole as MosPathRole]
                ? (isAr ? ROLE_LABELS[activeRole as MosPathRole].ar : ROLE_LABELS[activeRole as MosPathRole].en)
                : activeRole;
              const allKeys = activeGroups.flatMap((g) => g.keys);
              return (
                <>
                  <div className="m4-rolechips">
                    {columns.map((r) => (
                      <button
                        key={r}
                        type="button"
                        className={`fbtn${r === activeRole ? ' on' : ''}`}
                        onClick={() => setMobRole(r)}
                      >
                        {ROLE_LABELS[r as MosPathRole]
                          ? (isAr ? ROLE_LABELS[r as MosPathRole].ar : ROLE_LABELS[r as MosPathRole].en)
                          : r}
                      </button>
                    ))}
                  </div>
                  {note && (
                    <div className="m4-rolenote">
                      <b>{roleName}</b> {isAr ? note.ar : note.en}
                    </div>
                  )}
                  {matrix === 'surfaces'
                    ? LEVEL_GROUPS.map((lg) => {
                        const rows = allKeys.filter((s) => levelOf(activeRole, s.key) === lg.level);
                        if (rows.length === 0) return null;
                        return (
                          <div key={lg.level}>
                            <div className="lbl" style={{ margin: '14px 0 8px' }}>{isAr ? lg.ar : lg.en}</div>
                            <div className={`card m4-permcard${lg.level === 'hidden' ? ' dim' : ''}`}>
                              {rows.map((s) => (
                                <button
                                  key={s.key}
                                  type="button"
                                  className="m4-permrow"
                                  disabled={!canManage}
                                  title={canManage ? (isAr ? 'كامل ← قراءة ← مخفي — اضغط للتبديل' : 'Full → read → hidden — tap to cycle') : undefined}
                                  onClick={() => void cycle(activeRole, s.key)}
                                >
                                  <LevelMark level={lg.level} />
                                  <span className="t">{isAr ? s.ar : s.en}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })
                    : ([true, false] as const).map((on) => {
                        const rows = allKeys.filter((c) => capOf(activeRole, c.key) === on);
                        if (rows.length === 0) return null;
                        return (
                          <div key={String(on)}>
                            <div className="lbl" style={{ margin: '14px 0 8px' }}>
                              {on ? (isAr ? 'مسموح' : 'Allowed') : (isAr ? 'غير مسموح' : 'Not allowed')}
                            </div>
                            <div className={`card m4-permcard${on ? '' : ' dim'}`}>
                              {rows.map((c) => (
                                <button
                                  key={c.key}
                                  type="button"
                                  className="m4-permrow"
                                  disabled={!canManage}
                                  title={canManage ? (isAr ? 'اضغط للتبديل' : 'Tap to toggle') : undefined}
                                  onClick={() => void toggleCap(activeRole, c.key)}
                                >
                                  <CapMark on={on} />
                                  <span className="t">{isAr ? c.ar : c.en}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                  <div className="m4-permhint">
                    {matrix === 'surfaces'
                      ? (canManage
                          ? isAr
                            ? 'اللمس يبدّل: كامل ← قراءة ← مخفي. «مخفي» تعني أن العنصر غير موجود في قائمة الدور أصلًا — لا زرًّا يرفض.'
                            : 'Tapping cycles: full → read → hidden. "Hidden" means the item simply does not exist in that role\'s menu — not a button that refuses.'
                          : isAr
                            ? '«مخفي» تعني أن العنصر غير موجود في قائمة الدور أصلًا — لا زرًّا يرفض.'
                            : '"Hidden" means the item simply does not exist in that role\'s menu — not a button that refuses.')
                      : (canManage
                          ? isAr ? 'اللمس يبدّل السماح. الصلاحية نفسها تفرضها قاعدة البيانات.' : 'Tapping toggles the grant. The capability is enforced by the database.'
                          : isAr ? 'الصلاحية تفرضها قاعدة البيانات.' : 'The capability is enforced by the database.')}
                  </div>
                </>
              );
            })()}
          </div>

          <div className="se-split m4-desk">
            <div className="card" style={{ flex: 1, minWidth: 0 }}>
              <div className="tbl-wrap">
                <table className="mx">
                  <thead>
                    <tr>
                      <th>{matrix === 'surfaces' ? (isAr ? 'الشاشة أو الإجراء' : 'Surface or action') : (isAr ? 'الصلاحية' : 'Capability')}</th>
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
                    {activeGroups.map((g) => (
                      [
                        <tr key={`sec-${g.en}`} className="sec">
                          <td colSpan={columns.length + 1}>{isAr ? g.ar : g.en}</td>
                        </tr>,
                        ...g.keys.map((s) => (
                          <tr key={s.key}>
                            <td>{isAr ? s.ar : s.en}</td>
                            {columns.map((r) => (
                              <td key={r}>
                                {matrix === 'surfaces' ? (
                                  <button
                                    type="button"
                                    className="se-cell"
                                    disabled={!canManage}
                                    title={isAr ? 'كامل ← قراءة ← مخفي — اضغط للتبديل' : 'Full → read → hidden — click to cycle'}
                                    onClick={() => void cycle(r, s.key)}
                                  >
                                    <LevelMark level={levelOf(r, s.key)} />
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="se-cell"
                                    disabled={!canManage}
                                    title={isAr ? 'اضغط للتبديل' : 'Click to toggle'}
                                    onClick={() => void toggleCap(r, s.key)}
                                  >
                                    <CapMark on={capOf(r, s.key)} />
                                  </button>
                                )}
                              </td>
                            ))}
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
                  {matrix === 'surfaces' ? (
                    <>
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
                    </>
                  ) : (
                    <>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <span className="mk2 mk-f">●</span>
                        <span>{isAr ? 'مسموح — يستطيع تنفيذها' : 'Allowed — the role can do this'}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <span className="mk2 mk-n">—</span>
                        <span>{isAr ? 'غير مسموح' : 'Not allowed'}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--mute)', paddingTop: 9, borderTop: '1px solid var(--line-soft)', lineHeight: 1.75 }}>
                        {isAr
                          ? 'الصلاحيات نفسها تفرضها قاعدة البيانات (RLS)، لا الواجهة فقط — فإزالة صلاحية تمنع الفعل فعلاً، لا تخفي زرًّا فحسب.'
                          : 'Capabilities are enforced by the database (RLS), not just the UI — revoking one actually blocks the action, it does not merely hide a button.'}
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="card" style={{ borderColor: 'color-mix(in srgb, var(--copper) 34%, transparent)' }}>
                <div className="card-h" style={{ background: 'color-mix(in srgb, var(--copper) 7%, transparent)' }}>
                  <h4>{isAr ? 'الشاشة مقابل الصلاحية' : 'Surface vs capability'}</h4>
                </div>
                <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
                  {isAr ? (
                    <>
                      <b>الشاشة</b> تقرر ما يظهر في الشريط. <b>الصلاحية</b> تقرر ما يمكن فعله داخله.
                      <div style={{ marginTop: 9 }}>
                        قد يرى الدور شاشة «المحتوى» (شاشة) دون أن يستطيع كتابة النص (صلاحية) — وهذا مقصود.
                      </div>
                    </>
                  ) : (
                    <>
                      A <b>surface</b> decides what shows in the rail. A <b>capability</b> decides what can be done inside it.
                      <div style={{ marginTop: 9 }}>
                        A role can see the Content surface (surface) yet be unable to write the script (capability) — by design.
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="card">
                <div className="card-h"><h4>{isAr ? 'الصلاحية مقابل مسار العمل' : 'Capability vs workflow'}</h4></div>
                <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
                  {isAr ? (
                    <>
                      <b>الصلاحية تحدد ما تستطيع فعله؛ ومسار العمل يحدد من ينقل المهمة.</b> من يملك «كتابة المحتوى» يستطيع تعديل النص في أي مرحلة كتابة — لا يشترط أن تكون المرحلة عنده. لكن <b>اعتماد المهمة أو إرسالها للخطوة التالية</b> يبقى لصاحب المرحلة الحالية (أو المدير/المسؤول).
                    </>
                  ) : (
                    <>
                      <b>The capability decides what you can do; the workflow decides who moves the task.</b> Anyone with &quot;write content&quot; can edit the text at any writing stage — the stage need not be theirs. But <b>submitting or approving the task</b> to the next step stays with whoever&apos;s stage it currently is (or a manager/admin).
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
          </>
        )}
      </div>
    </>
  );
}
