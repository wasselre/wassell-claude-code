/**
 * اليوم الأول — design screen 45. The day-one empty state.
 *
 * Every other screen assumes 61 records exist; on day one there are none, and
 * that is the moment systems get abandoned. This block teaches instead of
 * apologising: an honest «فارغة — وهذا متوقع», a setup checklist whose ticks
 * come from REAL state (never decoration), a way in that starts from material
 * the company already paid for, and a plain statement of what the first create
 * sets in motion.
 *
 * No demo data, ever — fake records poison the first report and teach the team
 * not to trust the numbers. The emptiness here is honest and fills with the
 * first real work.
 *
 * Self-contained: reads the workspace context (projects, people, types) and
 * fetches bootstrap + the asset list itself. Secondary fetch failures keep the
 * checklist unticked and are logged — they never blank the block.
 */
// MOUNT: OverviewPage zero-state — wired by orchestrator
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MosAccount, MosAsset, WorkflowDef, fetchAssets, fetchBootstrap,
} from '@/lib/marketingOS/client';
import { useWorkspace } from '../MarketingWorkspace';
import { IconCheck, IconContent } from './icons';
import { num } from '../lib/format';
import '../styles/pages-remaining.css';

/** «٥ أدوار» with Arabic number agreement. */
function rolesAr(n: number): string {
  if (n === 1) return 'دور واحد';
  if (n === 2) return 'دوران';
  if (n <= 10) return `${num(n, true)} أدوار`;
  return `${num(n, true)} دورًا`;
}

/** «٤ أشخاص». */
function peopleAr(n: number): string {
  if (n === 1) return 'شخص واحد';
  if (n === 2) return 'شخصان';
  if (n <= 10) return `${num(n, true)} أشخاص`;
  return `${num(n, true)} شخصًا`;
}

/** «٤ مسارات». */
function pathsAr(n: number): string {
  if (n === 1) return 'مسار واحد';
  if (n === 2) return 'مساران';
  if (n <= 10) return `${num(n, true)} مسارات`;
  return `${num(n, true)} مسارًا`;
}

interface ChecklistRow {
  key: string;
  ok: boolean;
  /** The row someone should act on NEXT (ink title, copper box, primary CTA). */
  current?: boolean;
  /** Deliberately optional — «اربط منصة» renders muted even while unticked. */
  optional?: boolean;
  title: string;
  sub: string;
  action: string;
  primary?: boolean;
  onAction: () => void;
}

export default function EmptyDayOne() {
  const { isAr, projects, people, contentTypes, projectName, can } = useWorkspace();
  const navigate = useNavigate();

  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [accounts, setAccounts] = useState<MosAccount[]>([]);
  const [assets, setAssets] = useState<MosAsset[]>([]);
  const [checksReady, setChecksReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // Secondary state for the checklist ticks. Each settles on its own — a
      // failure leaves that check unticked (honest default) and is logged.
      const [bootstrap, assetList] = await Promise.all([
        fetchBootstrap().catch((e: unknown) => {
          console.error('[marketing] day-one checklist: bootstrap unavailable', e);
          return null;
        }),
        fetchAssets().catch((e: unknown) => {
          console.error('[marketing] day-one checklist: asset list unavailable', e);
          return null;
        }),
      ]);
      if (!alive) return;
      if (bootstrap) {
        setWorkflows(bootstrap.workflows);
        setAccounts(bootstrap.platform_accounts);
      }
      if (assetList) setAssets(assetList.assets);
      setChecksReady(true);
    })();
    return () => { alive = false; };
  }, []);

  /* ── the real state behind each tick ──────────────────────────── */

  const activePeople = useMemo(
    () => people.filter((p) => p.roles.some((r) => r !== 'viewer' && r !== 'none')),
    [people],
  );
  const distinctRoles = useMemo(() => {
    const s = new Set<string>();
    for (const p of activePeople) for (const r of p.roles) if (r !== 'viewer' && r !== 'none') s.add(r);
    return s.size;
  }, [activePeople]);
  const managerHolders = useMemo(
    () => people.filter((p) => p.roles.includes('marketing_manager')).length,
    [people],
  );

  const activeWorkflows = workflows.filter((w) => w.is_active).length;
  const activeTypes = contentTypes.filter((t) => t.is_active).length;
  const connected = accounts.some((a) => a.is_connected);

  const rolesOk = activePeople.length > 0;
  const workflowsOk = activeWorkflows > 0 && activeTypes > 0;
  const projectsOk = projects.length > 0;
  const assetsOk = assets.length > 0;

  /** The project with the most material — «ابدأ من مادة موجودة»'s entry point. */
  const topProject = useMemo(() => {
    const byProject = new Map<string, number>();
    for (const a of assets) {
      if (!a.project_id) continue;
      byProject.set(a.project_id, (byProject.get(a.project_id) ?? 0) + 1);
    }
    let best: { id: string; n: number } | null = null;
    for (const [id, n] of byProject) if (!best || n > best.n) best = { id, n };
    return best;
  }, [assets]);

  /* ── checklist rows — ticks from real state, never decoration ─── */

  const rows: ChecklistRow[] = [
    {
      key: 'roles',
      ok: rolesOk,
      title: isAr ? 'الأدوار وأشخاصها' : 'Roles and their people',
      sub: rolesOk
        ? isAr
          ? `${rolesAr(distinctRoles)} · ${peopleAr(activePeople.length)}${managerHolders === 1 ? ' · مدير التسويق بلا بديل' : ''}`
          : `${distinctRoles} roles · ${activePeople.length} people${managerHolders === 1 ? ' · the manager has no backup' : ''}`
        : isAr
          ? 'لا أدوار مسندة بعد — تُمنح من الإعدادات'
          : 'No roles granted yet — done in Settings',
      action: isAr ? 'مراجعة' : 'Review',
      onAction: () => navigate('/m/settings'),
    },
    {
      key: 'workflows',
      ok: workflowsOk,
      title: isAr ? 'مسارات العمل' : 'Workflows',
      sub: workflowsOk
        ? isAr
          ? `${pathsAr(activeWorkflows)} جاهزة لـ${num(activeTypes, true)} أنواع محتوى — عدّلها لاحقًا لا الآن`
          : `${activeWorkflows} paths ready for ${activeTypes} content types — tune them later, not now`
        : isAr
          ? 'لا مسارات مفعّلة بعد'
          : 'No active workflows yet',
      action: isAr ? 'مراجعة' : 'Review',
      onAction: () => navigate('/m/settings'),
    },
    {
      key: 'projects',
      ok: projectsOk,
      title: isAr ? 'المشاريع' : 'Projects',
      sub: projectsOk
        ? isAr
          ? `${num(projects.length, true)} مشروعًا مسحوبة من نظام العملاء — لا إدخال يدوي`
          : `${projects.length} projects pulled from the CRM — no manual entry`
        : isAr
          ? 'لا مشاريع بعد — تُسحب تلقائيًا من نظام العملاء'
          : 'No projects yet — they arrive from the CRM automatically',
      action: isAr ? 'عرض' : 'View',
      onAction: () => navigate('/m/library'),
    },
    {
      key: 'assets',
      ok: assetsOk,
      current: !assetsOk,
      title: isAr ? 'ارفع أول مواد' : 'Upload the first material',
      sub: assetsOk
        ? isAr
          ? `${num(assets.length, true)} مادة في المكتبة`
          : `${assets.length} items in the library`
        : isAr
          ? 'صور ومقاطع مشروع واحد تكفي للبدء — لا تنتظر اكتمال الأرشيف'
          : 'One project’s photos and clips are enough — don’t wait for a complete archive',
      action: assetsOk ? (isAr ? 'المكتبة' : 'Library') : (isAr ? 'رفع' : 'Upload'),
      primary: !assetsOk,
      onAction: () => navigate(assetsOk ? '/m/library' : '/m/library/upload'),
    },
    {
      key: 'platform',
      ok: connected,
      optional: true,
      title: isAr ? 'اربط منصة' : 'Connect a platform',
      sub: isAr
        ? 'اختياري تمامًا — النظام يعمل يدويًا بالكامل بدونها'
        : 'Entirely optional — the system runs fully manual without it',
      action: connected ? (isAr ? 'مراجعة' : 'Review') : (isAr ? 'لاحقًا' : 'Later'),
      onAction: () => navigate('/m/settings'),
    },
  ];

  const okCount = rows.filter((r) => r.ok).length;

  return (
    <div style={{ maxWidth: 760, margin: '10px auto 0' }}>
      {/* ── the honest empty block ──────────────────────────────────── */}
      <div className="empty" style={{ padding: '30px 28px', textAlign: 'start' }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <IconContent style={{ width: 30, height: 30, flex: '0 0 30px', color: 'var(--copper)' }} />
          <div>
            <h4 style={{ margin: 0, textAlign: 'start' }}>
              {isAr ? 'مكتبة المحتوى فارغة — وهذا متوقع' : 'The content library is empty — as expected'}
            </h4>
            <p style={{ margin: '8px 0 0', textAlign: 'start', maxWidth: '56ch' }}>
              {isAr
                ? 'كل شيء في هذه الوحدة يبدأ بعنصر محتوى واحد. أنشئ الأول وسيتولّى النظام الباقي: الرقم، ومسار العمل، وأول مهمة، ومن تُسند إليه.'
                : 'Everything in this module starts from one content item. Create the first and the system handles the rest: the reference, the workflow, the first task, and who it goes to.'}
            </p>
            {can('write_content') && (
              <div style={{ marginTop: 12 }}>
                <button type="button" className="btn btn-p btn-sm" onClick={() => navigate('/m/content')}>
                  {isAr ? 'محتوى جديد' : 'New content'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── الإعداد الأولي — ticks from real state ──────────────────── */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-h">
          <h4>{isAr ? 'الإعداد الأولي' : 'Initial setup'}</h4>
          <span className="r">
            {checksReady
              ? isAr ? `${num(okCount, true)} من ٥ مكتملة` : `${okCount} of 5 done`
              : isAr ? 'جارٍ الفحص…' : 'checking…'}
          </span>
        </div>
        <div className="card-b" style={{ display: 'grid', gap: 0, paddingTop: 0, paddingBottom: 0 }}>
          {rows.map((r) => (
            <div key={r.key} className={`ph-chk${r.ok ? ' ok2' : ''}`}>
              <span className="bx" style={!r.ok && r.current ? { borderColor: 'var(--copper)' } : undefined}>
                {r.ok && <IconCheck />}
              </span>
              <div style={{ flex: 1 }}>
                <div
                  className="tx2"
                  style={!r.ok ? { color: r.optional ? 'var(--mute)' : 'var(--ink)' } : undefined}
                >
                  {r.title}
                </div>
                <div className="mt3">{r.sub}</div>
              </div>
              <button
                type="button"
                className={`btn btn-sm${r.primary ? ' btn-p' : ' btn-d'}`}
                onClick={r.onAction}
              >
                {r.action}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* ── the way in + what the first create sets off ─────────────── */}
      <div className={assetsOk ? 'grid g2' : undefined} style={{ marginTop: 16 }}>
        {assetsOk && (
          <div className="card">
            <div className="card-h"><h4>{isAr ? 'ابدأ من مادة موجودة' : 'Start from existing material'}</h4></div>
            <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
              {isAr
                ? <>عندك {num(assets.length, true)} صورة ومقطعًا{topProject ? ` لـ${projectName(topProject.id)}` : ''} جاهزة في المكتبة. أسرع طريق لأول منشور أن تبدأ منها بدل البدء من فكرة تحتاج تصويرًا.</>
                : <>You already have {assets.length} photos and clips{topProject ? ` for ${projectName(topProject.id)}` : ''} in the library. The fastest first post starts from them, not from an idea that needs a shoot.</>}
              <div style={{ marginTop: 11 }}>
                <button type="button" className="btn btn-p btn-sm" onClick={() => navigate('/m/library')}>
                  {topProject
                    ? isAr ? `تصفّح مواد ${projectName(topProject.id)}` : `Browse ${projectName(topProject.id)} material`
                    : isAr ? 'تصفّح المكتبة' : 'Browse the library'}
                </button>
              </div>
            </div>
          </div>
        )}
        <div className="card">
          <div className="card-h"><h4>{isAr ? 'ماذا يحدث بعد أول إنشاء' : 'What happens after the first create'}</h4></div>
          <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
            <div className="rule"><span className="arw">←</span><span>{isAr ? 'يظهر السجل في «المحتوى» و«التقويم»' : 'The record appears in Content and the Calendar'}</span></div>
            <div className="rule"><span className="arw">←</span><span>{isAr ? 'تُفتح أول مهمة لدور الكاتب' : 'The first task opens for the Writer role'}</span></div>
            <div className="rule"><span className="arw">←</span><span>{isAr ? 'تظهر في «مهامي» عند من يشغل الدور' : 'It shows in My Work for whoever holds the role'}</span></div>
            <div className="rule"><span className="arw">←</span><span>{isAr ? '«نظرة عامة» تبقى فارغة حتى يتحرك شيء' : 'Overview stays empty until something moves'}</span></div>
          </div>
        </div>
      </div>

      {/* ── no demo data, ever ──────────────────────────────────────── */}
      <div
        style={{
          marginTop: 16, background: 'var(--sand-2)', border: '1px solid var(--line)',
          borderRadius: 9, padding: '13px 16px', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.9,
        }}
      >
        {isAr
          ? <><b>لا بيانات تجريبية.</b> بعض الأنظمة تملأ نفسها بمحتوى وهمي ليبدو حيًا؛ وهذا يفسد أول تقرير ويعلّم الفريق ألا يثق بالأرقام. الفراغ هنا صادق، ويُملأ بأول عمل حقيقي.</>
          : <><b>No demo data.</b> Some systems fill themselves with fake content to look alive; that poisons the first report and teaches the team not to trust the numbers. The emptiness here is honest, and it fills with the first real work.</>}
      </div>
    </div>
  );
}
