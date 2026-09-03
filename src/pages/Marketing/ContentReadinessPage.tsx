/**
 * Content readiness — does each of OUR projects have its required marketing
 * assets? A planning/gap view, sibling of Content inventory.
 *
 * The rule, per project: exactly 1 BROCHURE + 3 HERO images, counted on the
 * file's single MAIN type (`primary_category`, the AI-set "what is this file").
 * Per unit: 1 PLAN (`units.unit_plan`). The page shows, per project, whether each
 * is met, warns on missing / duplicate, and drills into a project's units to show
 * which are missing a plan. Read-only — fixing a gap is done in the Files library
 * (correct a file's type) or by uploading the missing file.
 *
 * Data: api/marketing-os `content_readiness` (SQL rollup `mkt_content_readiness`)
 * + `content_readiness_units` for the drill-down.
 *
 * Note: `hero_image` is a brand-new main type; the enrichment AI assigns it to
 * the best 3 photos per project in a later step, so hero counts read 0/3
 * everywhere until then — surfaced with a banner, not hidden.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ContentReadinessProject,
  ContentReadinessTotals,
  ReadinessUnit,
  fetchContentReadiness,
  fetchContentReadinessUnits,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, LoadError, PageHead, Skeleton } from './components/kit';
import { num } from './lib/format';

const OK = '#1a9e5f';
const BAD = '#d64545';
const WARN = '#C09B5F';

const HERO_TARGET = 3;

type Filter = 'all' | 'brochure' | 'units';

type Status = 'ok' | 'missing' | 'over' | 'under';
function statusColor(s: Status): string {
  return s === 'ok' ? OK : s === 'missing' ? BAD : WARN;
}

export default function ContentReadinessPage() {
  const { isAr } = useWorkspace();
  const navigate = useNavigate();

  const [projects, setProjects] = useState<ContentReadinessProject[]>([]);
  const [totals, setTotals] = useState<ContentReadinessTotals | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [drill, setDrill] = useState<ContentReadinessProject | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchContentReadiness();
      setProjects(res.projects);
      setTotals(res.totals);
      setModelId(res.model_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /** Open the Files library filtered to one project so a rep can correct a
   *  file's type. Client-side nav so the marketing shell is not re-booted. */
  const openFiles = useCallback(
    (projectId: string): void => {
      const sp = new URLSearchParams();
      sp.set('model', 'all_projects');
      if (modelId) sp.set('mid', modelId);
      sp.set('rid', projectId);
      sp.set('group', 'primary_category');
      navigate(`/m/library?${sp.toString()}`);
    },
    [modelId, navigate],
  );

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    let rows = projects;
    if (term) rows = rows.filter((p) => p.name.toLowerCase().includes(term));
    if (filter === 'brochure') rows = rows.filter((p) => p.brochure_count !== 1);
    else if (filter === 'units') rows = rows.filter((p) => p.units_missing_plan > 0);
    return [...rows].sort((a, b) => {
      // Most "needs attention" first: missing brochure, then duplicate, then unit gaps.
      const score = (p: ContentReadinessProject) =>
        (p.brochure_count === 0 ? 100 : 0) +
        (p.brochure_count >= 2 ? 50 : 0) +
        Math.min(40, p.units_missing_plan);
      return score(b) - score(a) || a.name.localeCompare(b.name);
    });
  }, [projects, q, filter]);

  const sub = totals
    ? isAr
      ? `${num(totals.brochure_ok, true)} جاهز · ${num(totals.brochure_missing, true)} بلا كتيّب · ${num(totals.brochure_over, true)} مكرّر · ${num(totals.units_missing_plan, true)} وحدة بلا مخطط`
      : `${totals.brochure_ok} ready · ${totals.brochure_missing} no brochure · ${totals.brochure_over} duplicate · ${totals.units_missing_plan} units missing a plan`
    : isAr ? 'الملفات المطلوبة لكل مشروع من مشاريعنا' : 'The required files for each of our projects';

  return (
    <>
      <PageHead title={isAr ? 'جاهزية المحتوى' : 'Content readiness'} sub={sub}>
        <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={loading}>
          {isAr ? 'تحديث' : 'Refresh'}
        </button>
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && projects.length === 0 && <Skeleton rows={6} />}

        {totals && projects.length > 0 && <SummaryStrip totals={totals} isAr={isAr} />}

        {projects.length > 0 && (
          <div
            className="hero-note"
            style={{
              margin: '12px 0', padding: '8px 12px', borderRadius: 8,
              background: 'rgba(192,155,95,0.12)', color: 'var(--ink, #4A4E54)',
              fontSize: 13, border: '1px solid rgba(192,155,95,0.35)',
            }}
          >
            {isAr
              ? 'الصور الرئيسية (الهيرو) تُختار تلقائيًا بالذكاء الاصطناعي في خطوة لاحقة، لذلك تظهر ٠/٣ الآن لجميع المشاريع.'
              : 'Hero images are auto-selected by AI in a later step, so they read 0/3 for every project for now.'}
          </div>
        )}

        {projects.length > 0 && (
          <div
            className="filt"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', margin: '14px 0' }}
          >
            <input
              className="inp"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={isAr ? 'ابحث عن مشروع…' : 'Search a project…'}
              style={{ maxWidth: 240 }}
            />
            <div className="seg">
              <button type="button" className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
                {isAr ? 'الكل' : 'All'}
              </button>
              <button type="button" className={filter === 'brochure' ? 'on' : ''} onClick={() => setFilter('brochure')}>
                {isAr ? 'مشاكل الكتيّب' : 'Brochure issues'}
              </button>
              <button type="button" className={filter === 'units' ? 'on' : ''} onClick={() => setFilter('units')}>
                {isAr ? 'نقص المخططات' : 'Unit-plan gaps'}
              </button>
            </div>
          </div>
        )}

        {!loading && projects.length === 0 && !error && (
          <Empty
            title={isAr ? 'لا مشاريع' : 'No projects'}
            body={isAr
              ? 'لا توجد مشاريع معروضة (is_public) لعرض جاهزيتها بعد.'
              : 'There are no marketed (is_public) projects to check yet.'}
          />
        )}

        {visible.length === 0 && projects.length > 0 && (
          <Empty
            title={isAr ? 'لا نتائج' : 'Nothing matches'}
            body={isAr ? 'جرّب مصطلح بحث آخر أو غيّر المرشّح.' : 'Try another search or filter.'}
          />
        )}

        {visible.length > 0 && (
          <div className="grid" style={{ gap: 14, gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
            {visible.map((p) => (
              <ProjectCard key={p.id} p={p} isAr={isAr} onFiles={() => openFiles(p.id)} onUnits={() => setDrill(p)} />
            ))}
          </div>
        )}
      </div>

      {drill && (
        <UnitsModal project={drill} isAr={isAr} onClose={() => setDrill(null)} />
      )}
    </>
  );
}

/* ── Summary strip ─────────────────────────────────────────────────────── */

function SummaryStrip({ totals, isAr }: { totals: ContentReadinessTotals; isAr: boolean }) {
  const tiles: Array<{ k: string; v: string; c?: string }> = [
    { k: isAr ? 'المشاريع' : 'Projects', v: num(totals.projects, isAr) },
    { k: isAr ? 'كتيّب جاهز' : 'Brochure ready', v: num(totals.brochure_ok, isAr), c: OK },
    { k: isAr ? 'بلا كتيّب' : 'No brochure', v: num(totals.brochure_missing, isAr), c: totals.brochure_missing ? BAD : undefined },
    { k: isAr ? 'كتيّب مكرّر' : 'Duplicate brochure', v: num(totals.brochure_over, isAr), c: totals.brochure_over ? WARN : undefined },
    { k: isAr ? 'صور هيرو جاهزة' : 'Hero ready', v: num(totals.hero_ok, isAr), c: totals.hero_ok ? OK : undefined },
    { k: isAr ? 'إجمالي الوحدات' : 'Total units', v: num(totals.total_units, isAr) },
    { k: isAr ? 'وحدات بلا مخطط' : 'Units missing a plan', v: num(totals.units_missing_plan, isAr), c: totals.units_missing_plan ? WARN : undefined },
  ];
  return (
    <div className="grid" style={{ gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
      {tiles.map((t) => (
        <div key={t.k} className="stat">
          <div className="k">{t.k}</div>
          <div className="v" style={t.c ? { color: t.c } : undefined}>{t.v}</div>
        </div>
      ))}
    </div>
  );
}

/* ── Per-project card ──────────────────────────────────────────────────── */

function StatusRow({
  label, value, status, isAr, onClick,
}: {
  label: string;
  value: string;
  status: Status;
  isAr: boolean;
  onClick?: () => void;
}) {
  const color = statusColor(status);
  const icon = status === 'ok' ? '✓' : status === 'missing' ? '✕' : '!';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '7px 4px', background: 'transparent', border: 'none',
        cursor: onClick ? 'pointer' : 'default', textAlign: isAr ? 'right' : 'left',
        borderRadius: 6,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 20, height: 20, borderRadius: '50%', flex: '0 0 auto',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: color, color: '#fff', fontSize: 12, fontWeight: 700,
        }}
      >
        {icon}
      </span>
      <span style={{ flex: 1, fontSize: 13, color: 'var(--ink, #4A4E54)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 700, color }}>{value}</span>
    </button>
  );
}

function ProjectCard({
  p, isAr, onFiles, onUnits,
}: {
  p: ContentReadinessProject;
  isAr: boolean;
  onFiles: () => void;
  onUnits: () => void;
}) {
  const brochureStatus: Status = p.brochure_count === 1 ? 'ok' : p.brochure_count === 0 ? 'missing' : 'over';
  const brochureValue = p.brochure_count === 1
    ? (isAr ? 'جاهز' : 'Ready')
    : p.brochure_count === 0
      ? (isAr ? 'مفقود' : 'Missing')
      : (isAr ? `${num(p.brochure_count, true)} — اختر واحدًا` : `${p.brochure_count} — pick one`);

  const heroStatus: Status = p.hero_count === HERO_TARGET ? 'ok' : p.hero_count > HERO_TARGET ? 'over' : 'under';
  const heroValue = `${num(p.hero_count, isAr)}/${num(HERO_TARGET, isAr)}`;

  const unitStatus: Status = p.total_units === 0
    ? 'under'
    : p.units_missing_plan === 0 ? 'ok' : 'under';
  const unitValue = p.total_units === 0
    ? (isAr ? 'لا وحدات' : 'No units')
    : isAr
      ? `${num(p.units_with_plan, true)}/${num(p.total_units, true)} · ينقص ${num(p.units_missing_plan, true)}`
      : `${p.units_with_plan}/${p.total_units} · ${p.units_missing_plan} missing`;

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8, color: 'var(--ink, #4A4E54)' }}>
        {p.name || (isAr ? 'مشروع' : 'Project')}
      </div>
      <StatusRow label={isAr ? 'كتيّب (المطلوب: ١)' : 'Brochure (need 1)'} value={brochureValue} status={brochureStatus} isAr={isAr} onClick={onFiles} />
      <StatusRow label={isAr ? 'صور هيرو (المطلوب: ٣)' : 'Hero images (need 3)'} value={heroValue} status={heroStatus} isAr={isAr} onClick={onFiles} />
      <StatusRow label={isAr ? 'مخططات الوحدات' : 'Unit plans'} value={unitValue} status={unitStatus} isAr={isAr} onClick={p.total_units > 0 ? onUnits : undefined} />
    </div>
  );
}

/* ── Units drill-down modal ────────────────────────────────────────────── */

function UnitsModal({
  project, isAr, onClose,
}: {
  project: ContentReadinessProject;
  isAr: boolean;
  onClose: () => void;
}) {
  const [units, setUnits] = useState<ReadinessUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyMissing, setOnlyMissing] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchContentReadinessUnits(project.id)
      .then((r) => { if (!cancelled) setUnits(r.units); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [project.id]);

  const shown = onlyMissing ? units.filter((u) => !u.has_plan) : units;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
      dir={isAr ? 'rtl' : 'ltr'}
    >
      <div className="card" style={{ width: '100%', maxWidth: 520, maxHeight: '85vh', display: 'flex', flexDirection: 'column', padding: 0 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--line, #E5DED2)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>{project.name}</div>
            <div style={{ fontSize: 12, color: '#8A8F98' }}>
              {isAr
                ? `${num(project.units_with_plan, true)} من ${num(project.total_units, true)} وحدة بها مخطط · ينقص ${num(project.units_missing_plan, true)}`
                : `${project.units_with_plan} of ${project.total_units} units have a plan · ${project.units_missing_plan} missing`}
            </div>
          </div>
          <button type="button" className="btn btn-sm" onClick={onClose}>{isAr ? 'إغلاق' : 'Close'}</button>
        </div>

        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--line, #E5DED2)' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
            {isAr ? 'إظهار الوحدات بلا مخطط فقط' : 'Only units missing a plan'}
          </label>
        </div>

        <div style={{ overflowY: 'auto', padding: '8px 8px 12px' }}>
          {loading && <Skeleton rows={5} />}
          {error && <div style={{ color: BAD, padding: 12, fontSize: 13 }}>{error}</div>}
          {!loading && !error && shown.length === 0 && (
            <div style={{ padding: 16, textAlign: 'center', color: '#8A8F98', fontSize: 13 }}>
              {onlyMissing
                ? (isAr ? 'كل الوحدات بها مخطط 🎉' : 'Every unit has a plan 🎉')
                : (isAr ? 'لا وحدات' : 'No units')}
            </div>
          )}
          {!loading && !error && shown.map((u) => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px' }}>
              <span
                aria-hidden
                style={{
                  width: 16, height: 16, borderRadius: '50%', flex: '0 0 auto',
                  background: u.has_plan ? OK : BAD, color: '#fff', fontSize: 10, fontWeight: 700,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {u.has_plan ? '✓' : '✕'}
              </span>
              <span style={{ flex: 1, fontSize: 13 }}>{u.label}</span>
              <span style={{ fontSize: 12, color: u.has_plan ? OK : BAD }}>
                {u.has_plan ? (isAr ? 'به مخطط' : 'has plan') : (isAr ? 'بلا مخطط' : 'no plan')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
