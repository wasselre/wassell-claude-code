/**
 * Campaigns — design screens 14 and 19.
 *
 * The spend side. A campaign is an envelope of money and time; the content that
 * runs inside it stays in the content library rather than being copied here.
 * Cost per lead is COMPUTED from the executions, never typed — a number you can
 * type is a number that can disagree with its own inputs. Organic rows leave
 * the money columns as a dash: «—» means "does not apply", while ٠ would mean
 * "we spent and got nothing".
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  CAMPAIGN_STATUS_LABELS, EXEC_PURPOSE_LABELS, MosCampaign, MosGoal,
  PLATFORM_LABELS, ROLE_LABELS,
  createContent, fetchCampaigns, fetchGoals,
  saveCampaign, savePublication, successMeasureSuffix,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Pill, Skeleton, Stat, Tone } from './components/kit';
import { IconCampaigns, IconCheck, IconMetrics, IconPlus } from './components/icons';
import ProjectMultiSelect from './components/ProjectMultiSelect';
import GoalMultiSelect from './components/GoalMultiSelect';
import CampaignContentBuilder, { type ContentDraft } from './components/CampaignContentBuilder';
import SuccessMeasuresEditor, {
  MeasureDraft, measuresToDrafts, draftsToMeasures, hasMeasureTarget,
} from './components/SuccessMeasuresEditor';
import { money, num, shortDate } from './lib/format';
import { measureActual, pickMainMeasure } from './lib/measure';
import './styles/mobile-m4.css';

const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The mockup's status pills — the table reads «جارية», never «نشطة». */
const TABLE_STATUS: Record<string, { tone: Tone; ar: string; en: string }> = {
  active:    { tone: 'now',  ar: 'جارية',  en: 'Active' },
  planning:  { tone: 'idle', ar: 'مخططة', en: 'Planned' },
  done:      { tone: 'go',   ar: 'منتهية', en: 'Ended' },
  paused:    { tone: 'wait', ar: 'موقوفة', en: 'Paused' },
  cancelled: { tone: 'idle', ar: 'ملغاة',  en: 'Cancelled' },
};
const FALLBACK_STATUS = { tone: 'idle', ar: 'مخططة', en: 'Planned' } as const;

/**
 * The sub-line under the campaign name names the AD platform for paid
 * («ميتا · بحث جوجل») — transcribed shorter than PLATFORM_LABELS' formal
 * «إعلانات ميتا». Organic sub-lines name the feeds, via PLATFORM_LABELS.
 */
const SUB_PLATFORM: Record<string, { ar: string; en: string }> = {
  meta:   { ar: 'ميتا',     en: 'Meta' },
  google: { ar: 'بحث جوجل', en: 'Google search' },
};

function subPlatform(p: string, isAr: boolean): string {
  const l = SUB_PLATFORM[p] ?? PLATFORM_LABELS[p];
  return l ? (isAr ? l.ar : l.en) : p;
}

type StatusFilter = 'all' | 'active' | 'planning' | 'done';
type KindFilter = 'all' | 'paid' | 'organic';

/**
 * A measure value formatted for its unit — money for currency, «٪» for percent,
 * a plain count otherwise. Used for both the actual and the target on the card.
 */
function measureValue(v: number | null, unit: string, isAr: boolean): string {
  if (v === null || !Number.isFinite(v)) return '—';
  if (unit === 'currency') return money(v, isAr);
  if (unit === 'percent') return `${num(Math.round(v * 10) / 10, isAr)}٪`;
  return num(Math.round(v), isAr);
}

/** «٧٧٪ من الشهر مضى» — elapsed share of the campaign window, when dated. */
function timePctOf(c: MosCampaign): number | null {
  if (!c.starts_on || !c.ends_on) return null;
  const start = new Date(c.starts_on).getTime();
  const end = new Date(c.ends_on).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return Math.max(0, Math.min(100, Math.round(((Date.now() - start) / (end - start)) * 100)));
}

interface VerdictCard {
  big: string;
  sub: string;
  meterPct: number;
  meterColor: string;
  verdict: string;
  verdictClass: string; // '' (colored via style) or 'mute'
  verdictColor?: string;
}

/**
 * s48 phone2 — one dominant number and one judgment per campaign card,
 * derived from the same fields the table shows. «الرقم وحده على شاشة صغيرة
 * لا يكفي لاتخاذ موقف» — every card carries a verdict.
 */
function verdictCardOf(c: MosCampaign, isAr: boolean): VerdictCard {
  const spend = c.total_spend ?? 0;
  const budget = c.budget_total ?? 0;
  const timePct = timePctOf(c);
  // The card headlines the campaign's chosen MAIN success measure — never the
  // goal text (which is a free-text description now). The main measure is the
  // first one carrying a target (the editor stores the picked row first).
  const main = pickMainMeasure(c);
  const target = main?.threshold ?? null;
  const label = main ? (isAr ? main.label_ar : main.label_en) : '';

  if (c.kind === 'organic') {
    const count = c.content_count ?? 0;
    return {
      big: num(count, isAr),
      sub: target !== null
        ? isAr ? `من ${num(target, true)} ${label}` : `of ${num(target, false)} ${label}`
        : isAr ? 'عناصر محتوى' : 'content items',
      meterPct: target !== null && target > 0 ? Math.min(100, Math.round((count / target) * 100)) : 0,
      meterColor: 'var(--gold)',
      verdict: isAr ? 'لا ميزانية — حملة عضوية' : 'No budget — an organic campaign',
      verdictClass: 'mute',
    };
  }

  if (c.status === 'planning') {
    return {
      big: num(budget > 0 ? budget : null, isAr),
      sub: budget > 0
        ? isAr ? 'ريال ميزانية معتمدة' : 'SAR budget committed'
        : isAr ? 'الميزانية لاحقًا' : 'budget comes later',
      meterPct: 0,
      meterColor: 'var(--sand)',
      verdict: isAr ? 'مخططة — لم تُطلق' : 'Planned — not launched',
      verdictClass: 'mute',
    };
  }

  // Paid and launched. The live actual for the main measure's tracked source.
  const actual = main ? measureActual(main.source, c) : null;

  // Money out but the main measure has produced nothing yet — s48's «تحتاج قرارًا».
  if (main && target !== null && main.source !== 'none' && spend > 0 && (actual === null || actual === 0)) {
    return {
      big: measureValue(actual, main.unit, isAr),
      sub: isAr ? `على ${num(spend, true)} ريال` : `on ${num(spend, false)} SAR`,
      meterPct: budget > 0 ? Math.min(100, Math.round((spend / budget) * 100)) : 100,
      meterColor: 'var(--late)',
      verdict: isAr ? 'تحتاج قرارًا' : 'Needs a decision',
      verdictClass: '',
      verdictColor: 'var(--late)',
    };
  }

  // A trackable main measure with a live actual — pace it toward its target.
  if (main && target !== null && main.source !== 'none' && actual !== null) {
    if (main.direction === 'higher') {
      const pct = target > 0 ? Math.min(100, Math.round((actual / target) * 100)) : 0;
      const behind = timePct !== null && pct < timePct - 10;
      return {
        big: measureValue(actual, main.unit, isAr),
        sub: isAr
          ? `من ${measureValue(target, main.unit, true)} ${label} · ${num(pct, true)}٪`
          : `of ${measureValue(target, main.unit, false)} ${label} · ${pct}%`,
        meterPct: pct,
        meterColor: behind ? 'var(--late)' : 'var(--copper)',
        verdict: timePct === null
          ? isAr ? 'بلا مدة — لا وتيرة تُحسب' : 'No dates — no pace to compute'
          : behind
            ? isAr ? 'متأخرة عن الوتيرة' : 'Behind pace'
            : isAr ? 'على الوتيرة' : 'On pace',
        verdictClass: timePct === null ? 'mute' : '',
        verdictColor: timePct === null ? undefined : behind ? 'var(--late)' : 'var(--go)',
      };
    }
    // Lower-is-better cost/rate measure (CPL, CTR-lower…) — under target is good.
    const good = actual <= target;
    const suffix = successMeasureSuffix(main.direction, main.unit, isAr);
    return {
      big: measureValue(actual, main.unit, isAr),
      sub: isAr
        ? `الهدف ${measureValue(target, main.unit, true)} ${suffix}`
        : `target ${measureValue(target, main.unit, false)} ${suffix}`,
      meterPct: good ? 100 : Math.max(0, Math.min(100, Math.round((target / actual) * 100))),
      meterColor: good ? 'var(--go)' : 'var(--late)',
      verdict: good
        ? isAr ? 'تحت الهدف' : 'Under target'
        : isAr ? 'فوق الهدف' : 'Over target',
      verdictClass: '',
      verdictColor: good ? 'var(--go)' : 'var(--late)',
    };
  }

  // A main measure whose target has no live tracking yet (source 'none', or a
  // rate with no data yet) — show the target, no pace to judge.
  if (main && target !== null) {
    const suffix = successMeasureSuffix(main.direction, main.unit, isAr);
    return {
      big: measureValue(target, main.unit, isAr),
      sub: `${label} · ${suffix}`,
      meterPct: 0,
      meterColor: 'var(--sand)',
      verdict: isAr ? 'الهدف — بانتظار الأرقام' : 'Target — awaiting numbers',
      verdictClass: 'mute',
    };
  }

  // No success measure at all (a legacy row): judge the spend pace instead.
  const spendPct = budget > 0 ? Math.min(100, Math.round((spend / budget) * 100)) : 0;
  const under = timePct !== null && spendPct < timePct - 10;
  const over = timePct !== null && spendPct > timePct + 10;
  return {
    big: money(spend, isAr),
    sub: isAr ? 'المصروف · بلا معيار نجاح' : 'spent · no success measure',
    meterPct: spendPct,
    meterColor: over ? 'var(--late)' : under ? 'var(--wait)' : 'var(--copper)',
    verdict: timePct === null
      ? isAr ? 'بلا معيار نجاح' : 'No success measure'
      : over
        ? isAr ? 'إنفاق زائد' : 'Overspending'
        : under
          ? isAr ? 'إنفاق ناقص' : 'Underspending'
          : isAr ? 'على الوتيرة' : 'On pace',
    verdictClass: timePct === null ? 'mute' : '',
    verdictColor: timePct === null ? undefined : over ? 'var(--late)' : under ? 'var(--wait)' : 'var(--go)',
  };
}

export default function CampaignsPage() {
  const { isAr, can, projects, projectName } = useWorkspace();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [rows, setRows] = useState<MosCampaign[]>([]);
  const [goals, setGoals] = useState<MosGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [statusF, setStatusF] = useState<StatusFilter>('all');
  const [kindF, setKindF] = useState<KindFilter>('all');
  const [projectF, setProjectF] = useState('');
  const [goalF, setGoalF] = useState(searchParams.get('goal') ?? '');
  const [monthScope, setMonthScope] = useState(true);

  // Keep the goal filter reflected in the URL so it is shareable/back-navigable.
  const setGoalFilter = useCallback((id: string): void => {
    setGoalF(id);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('goal', id); else next.delete('goal');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = (await fetchCampaigns()).campaigns;
      setRows(list);
      // Goals power the filter dropdown + the active-filter label. Non-fatal:
      // a failed goals read just leaves the dropdown empty, campaigns still show.
      void fetchGoals()
        .then((g) => setGoals(g.goals))
        .catch((e: unknown) => console.error('campaign goals filter list failed', e));
      // Platform sub-lines now arrive on each campaign row (campaign.platforms),
      // computed server-side by campaign_list — no per-row detail fetch.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /* ── filters ────────────────────────────────────────────────────────── */

  const filtered = useMemo(() => rows.filter((c) =>
    (statusF === 'all' || c.status === statusF)
    && (kindF === 'all' || c.kind === kindF)
    && (!projectF || (c.project_ids ?? []).includes(projectF))
    && (!goalF || (c.goal_ids ?? []).includes(goalF)),
  ), [rows, statusF, kindF, projectF, goalF]);

  /* ── stats — scoped to this month while the month chip is on ────────── */

  const stats = useMemo(() => {
    const now = new Date();
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    const scoped = monthScope
      ? rows.filter((c) => {
          const s = c.starts_on ? new Date(c.starts_on) : null;
          const e = c.ends_on ? new Date(c.ends_on) : s;
          return s !== null && e !== null && s <= mEnd && e >= mStart;
        })
      : rows;
    const spent = scoped.reduce((a, c) => a + (c.total_spend ?? 0), 0);
    const budget = scoped.reduce((a, c) => a + (c.budget_total ?? 0), 0);
    const leads = scoped.reduce((a, c) => a + (c.total_leads ?? 0), 0);
    const qualified = scoped.reduce((a, c) => a + (c.total_qualified ?? 0), 0);
    const target = (metric: string): number | null => {
      const vals = scoped
        .filter((c) => c.success_metric === metric && c.success_threshold !== null)
        .map((c) => c.success_threshold as number);
      return vals.length > 0 ? Math.min(...vals) : null;
    };
    return {
      spent,
      budget,
      leads,
      qualified,
      spendPct: budget > 0 ? Math.round((spent / budget) * 100) : 0,
      qualPct: leads > 0 ? Math.round((qualified / leads) * 100) : 0,
      cpl: leads > 0 && spent > 0 ? Math.round(spent / leads) : null,
      cpq: qualified > 0 && spent > 0 ? Math.round(spent / qualified) : null,
      cplTarget: target('cpl'),
      cpqTarget: target('cpl_qualified'),
    };
  }, [rows, monthScope]);

  /* ── header sub: «أغسطس ٢٠٢٦ · ٦٠,٠٠٠ ريال ملتزم بها · حملتان جاريتان…» ── */

  const sub = useMemo(() => {
    const now = new Date();
    const active = rows.filter((c) => c.status === 'active').length;
    const planning = rows.filter((c) => c.status === 'planning').length;
    const committed = rows
      .filter((c) => c.status === 'active')
      .reduce((a, c) => a + (c.budget_total ?? 0), 0);
    if (!isAr) {
      return `${EN_MONTHS[now.getMonth()]} ${now.getFullYear()} · ${num(committed, false)} SAR committed · `
        + `${active} active${planning > 0 ? `, ${planning} planned` : ''}`;
    }
    const activePhrase = active === 0 ? 'لا حملات جارية'
      : active === 1 ? 'حملة جارية'
      : active === 2 ? 'حملتان جاريتان'
      : `${num(active, true)} حملات جارية`;
    const planningPhrase = planning === 0 ? ''
      : planning === 1 ? '، وواحدة مخططة'
      : planning === 2 ? '، وحملتان مخططتان'
      : `، و${num(planning, true)} مخططة`;
    return `${AR_MONTHS[now.getMonth()]} ${num(now.getFullYear(), true)} · ${num(committed, true)} ريال ملتزم بها · ${activePhrase}${planningPhrase}`;
  }, [rows, isAr]);

  const now = new Date();

  return (
    <>
      <PageHead title={isAr ? 'الحملات' : 'Campaigns'} sub={sub}>
        {can('approve_budget') && (
          <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
            <IconPlus />
            {isAr ? 'حملة جديدة' : 'New campaign'}
          </button>
        )}
      </PageHead>

      <div className="body">
        {error && <LoadError message={error} onRetry={() => void load()} isAr={isAr} />}
        {loading && rows.length === 0 && <Skeleton rows={5} />}

        {!loading && rows.length === 0 && !error && (
          <Empty
            title={isAr ? 'لا حملات بعد' : 'No campaigns yet'}
            body={isAr
              ? 'الحملة ظرف من المال والوقت. المحتوى يبقى في المكتبة ويُنسب إليها، فلا يُنسخ مرتين.'
              : 'A campaign is an envelope of money and time. Content stays in the library and is attributed to it, never copied.'}
          >
            {can('approve_budget') && (
              <button type="button" className="btn btn-p" onClick={() => setCreating(true)}>
                <IconPlus />
                {isAr ? 'حملة جديدة' : 'New campaign'}
              </button>
            )}
          </Empty>
        )}

        {rows.length > 0 && (
          <>
            <div className="grid g4" style={{ marginBottom: 18 }}>
              <Stat
                isAr={isAr}
                label={isAr ? 'المصروف هذا الشهر' : 'Spent this month'}
                value={stats.spent}
                detail={isAr
                  ? `من ${num(stats.budget, true)} ريال · ${num(stats.spendPct, true)}٪`
                  : `of ${num(stats.budget, false)} SAR · ${stats.spendPct}%`}
                meter={[{ pct: stats.spendPct, color: 'var(--copper)' }]}
              />
              <Stat
                isAr={isAr}
                label={isAr ? 'العملاء المحتملون' : 'Leads'}
                value={stats.leads}
                detail={isAr
                  ? `${num(stats.qualified, true)} مؤهلًا · ${num(stats.qualPct, true)}٪`
                  : `${num(stats.qualified, false)} qualified · ${stats.qualPct}%`}
                meter={[
                  { pct: stats.qualPct, color: 'var(--go)' },
                  { pct: 100 - stats.qualPct, color: 'var(--sand)' },
                ]}
              />
              <Stat
                isAr={isAr}
                label={isAr ? 'تكلفة العميل' : 'Cost per lead'}
                value={stats.cpl}
                detail={isAr
                  ? `ريال${stats.cplTarget !== null ? ` · المستهدف ${num(stats.cplTarget, true)}` : ''}`
                  : `SAR${stats.cplTarget !== null ? ` · target ${num(stats.cplTarget, false)}` : ''}`}
                meter={[{
                  pct: stats.cpl !== null && stats.cplTarget !== null
                    ? Math.min(100, Math.round((stats.cpl / stats.cplTarget) * 100))
                    : 100,
                  color: stats.cpl !== null && stats.cplTarget !== null && stats.cpl <= stats.cplTarget
                    ? 'var(--go)'
                    : 'var(--wait)',
                }]}
              />
              <Stat
                isAr={isAr}
                label={isAr ? 'تكلفة المؤهل' : 'Cost per qualified'}
                value={stats.cpq}
                detail={isAr
                  ? `ريال${stats.cpqTarget !== null ? ` · المستهدف ${num(stats.cpqTarget, true)}` : ''}`
                  : `SAR${stats.cpqTarget !== null ? ` · target ${num(stats.cpqTarget, false)}` : ''}`}
                meter={[{
                  pct: stats.cpq !== null && stats.cpqTarget !== null
                    ? Math.min(100, Math.round((stats.cpq / stats.cpqTarget) * 100))
                    : 100,
                  color: 'var(--copper)',
                }]}
              />
            </div>

            <div className="filt">
              <div className="seg">
                {(['all', 'active', 'planning', 'done'] as const).map((s) => (
                  <button key={s} type="button" className={statusF === s ? 'on' : ''} onClick={() => setStatusF(s)}>
                    {isAr
                      ? { all: 'الكل', active: 'نشطة', planning: 'مخططة', done: 'منتهية' }[s]
                      : { all: 'All', active: 'Active', planning: 'Planned', done: 'Ended' }[s]}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={`fbtn${monthScope ? ' on' : ''}`}
                onClick={() => setMonthScope((v) => !v)}
              >
                {monthScope ? (
                  <>
                    {(isAr ? AR_MONTHS : EN_MONTHS)[now.getMonth()]} {num(now.getFullYear(), isAr)}{' '}
                    <span className="x">×</span>
                  </>
                ) : (
                  isAr ? 'المدة: الكل' : 'Period: all'
                )}
              </button>
              <button
                type="button"
                className="fbtn"
                onClick={() => setKindF((k) => (k === 'all' ? 'paid' : k === 'paid' ? 'organic' : 'all'))}
              >
                {isAr
                  ? `النوع: ${{ all: 'الكل', paid: 'مدفوعة', organic: 'عضوية' }[kindF]}`
                  : `Type: ${{ all: 'all', paid: 'paid', organic: 'organic' }[kindF]}`}
              </button>
              <select className="fbtn" value={projectF} onChange={(e) => setProjectF(e.target.value)}>
                <option value="">{isAr ? 'المشروع: أي' : 'Project: any'}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.project_name ?? p.id.slice(0, 8)}</option>
                ))}
              </select>
              <select className="fbtn" value={goalF} onChange={(e) => setGoalFilter(e.target.value)}>
                <option value="">{isAr ? 'الهدف: أي' : 'Goal: any'}</option>
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
              <span style={{ marginInlineStart: 'auto', fontSize: 11.5, color: 'var(--mute)' }}>
                {isAr
                  ? 'أرقام المدفوع مُدخلة يدويًا حتى ربط المنصات'
                  : 'Paid numbers are entered by hand until the platforms are linked'}
              </span>
            </div>

            {filtered.length === 0 ? (
              <div style={{ padding: '22px 6px', color: 'var(--mute)', fontSize: 12.5 }}>
                {isAr ? 'لا حملات تطابق هذه المرشحات.' : 'No campaigns match these filters.'}
              </div>
            ) : (
              <div className="card m4-desk">
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th style={{ width: 66 }}>{isAr ? 'الرقم' : 'Ref'}</th>
                        <th>{isAr ? 'الحملة' : 'Campaign'}</th>
                        <th style={{ width: 74 }}>{isAr ? 'النوع' : 'Type'}</th>
                        <th style={{ width: 106 }}>{isAr ? 'المشروع' : 'Project'}</th>
                        <th style={{ width: 104 }}>{isAr ? 'المدة' : 'Duration'}</th>
                        <th style={{ width: 96 }}>{isAr ? 'الحالة' : 'Status'}</th>
                        <th style={{ width: 66 }}>{isAr ? 'المحتوى' : 'Content'}</th>
                        <th className="num" style={{ width: 96 }}>{isAr ? 'الميزانية' : 'Budget'}</th>
                        <th className="num" style={{ width: 88 }}>{isAr ? 'المصروف' : 'Spent'}</th>
                        <th className="num" style={{ width: 66 }}>{isAr ? 'العملاء' : 'Leads'}</th>
                        <th className="num" style={{ width: 82 }}>{isAr ? 'التكلفة' : 'Cost'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((c) => {
                        const st = TABLE_STATUS[c.status] ?? FALLBACK_STATUS;
                        const dimmed = c.status === 'done' || c.status === 'cancelled';
                        const planning = c.status === 'planning';
                        const organic = c.kind === 'organic';
                        const plats = c.platforms ?? [];
                        const subLine = plats.length > 0
                          ? plats.map((p) => subPlatform(p, isAr)).join(' · ')
                          : (isAr ? 'لم تُطلق' : 'Not launched yet');
                        const leads = c.total_leads ?? 0;
                        const spend = c.total_spend ?? 0;
                        const cpl = !organic && !planning && spend > 0 && leads > 0
                          ? Math.round(spend / leads)
                          : null;
                        const threshold = c.success_metric === 'cpl' ? c.success_threshold : null;
                        return (
                          <tr
                            key={c.id}
                            className="click"
                            style={dimmed ? { opacity: 0.65 } : undefined}
                            onClick={() => navigate(`/m/campaigns/${c.id}`)}
                          >
                            <td className="id">{c.ref ?? '—'}</td>
                            <td className="ttl">
                              {c.name}
                              {subLine && (
                                <div style={{ fontSize: 11, color: 'var(--mute)', fontWeight: 400, marginTop: 2 }}>
                                  {subLine}
                                </div>
                              )}
                            </td>
                            <td>
                              <span className="tag">
                                {c.kind === 'paid' ? (isAr ? 'مدفوعة' : 'Paid') : (isAr ? 'عضوية' : 'Organic')}
                              </span>
                            </td>
                            <td>{(() => {
                              const ids = c.project_ids ?? [];
                              if (ids.length === 0) return isAr ? 'كل المشاريع' : 'All projects';
                              const names = ids.map((id) => projectName(id));
                              if (names.length <= 2) return names.join(isAr ? '، ' : ', ');
                              return `${names.slice(0, 2).join(isAr ? '، ' : ', ')} +${num(names.length - 2, isAr)}`;
                            })()}</td>
                            <td>{duration(c, isAr)}</td>
                            <td><Pill tone={st.tone}>{isAr ? st.ar : st.en}</Pill></td>
                            <td className="num">{num(c.content_count, isAr)}</td>
                            <td className="num" style={organic || c.budget_total === null ? { color: 'var(--mute)' } : undefined}>
                              {organic
                                ? '—'
                                : c.budget_total !== null
                                  ? num(c.budget_total, isAr)
                                  : planning ? (isAr ? 'لاحقًا' : 'later') : '—'}
                            </td>
                            <td className="num" style={organic || c.total_spend === null ? { color: 'var(--mute)' } : undefined}>
                              {organic ? '—' : num(c.total_spend, isAr)}
                            </td>
                            <td className="num" style={planning || c.total_leads === null ? { color: 'var(--mute)' } : undefined}>
                              {planning ? '—' : num(c.total_leads, isAr)}
                            </td>
                            <td
                              className="num"
                              style={cpl === null
                                ? { color: 'var(--mute)' }
                                : threshold !== null
                                  ? { color: cpl <= threshold ? 'var(--go)' : 'var(--late)', fontWeight: 700 }
                                  : undefined}
                            >
                              {cpl === null ? '—' : num(cpl, isAr)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── s48 phone2 — the same rows as verdict cards (<760px) ── */}
            {filtered.length > 0 && (
              <div className="m4-mob">
                <div className="m4-cards">
                  {filtered.map((c) => {
                    const st = TABLE_STATUS[c.status] ?? FALLBACK_STATUS;
                    const dimmed = c.status === 'done' || c.status === 'cancelled';
                    const card = verdictCardOf(c, isAr);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className={`m4-vcard${dimmed ? ' dim' : ''}`}
                        onClick={() => navigate(`/m/campaigns/${c.id}`)}
                      >
                        <div className="m4-vtop">
                          <span className="id ltr">{c.ref ?? '—'}</span>
                          <span className="tag">
                            {c.kind === 'paid' ? (isAr ? 'مدفوعة' : 'Paid') : (isAr ? 'عضوية' : 'Organic')}
                          </span>
                          <Pill tone={st.tone}>{isAr ? st.ar : st.en}</Pill>
                        </div>
                        <div className="m4-vt">{c.name}</div>
                        <div className="m4-vnum">
                          <span className="n">{card.big}</span>
                          <span className="s">{card.sub}</span>
                        </div>
                        <div className="meter">
                          <i style={{ width: `${card.meterPct}%`, background: card.meterColor }} />
                        </div>
                        <div
                          className={`m4-verdict${card.verdictClass ? ` ${card.verdictClass}` : ''}`}
                          style={card.verdictColor ? { color: card.verdictColor } : undefined}
                        >
                          {card.verdict}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {creating && (
        <CampaignModal
          isAr={isAr}
          onClose={() => setCreating(false)}
          onSaved={(c) => { setCreating(false); navigate(`/m/campaigns/${c.id}`); }}
        />
      )}
    </>
  );
}

/** «١–٣١ أغسطس» inside one month; a range across months; «فبراير ٢٠٢٧» for an unlaunched plan. */
function duration(c: MosCampaign, isAr: boolean): string {
  const months = isAr ? AR_MONTHS : EN_MONTHS;
  const s = c.starts_on ? new Date(c.starts_on) : null;
  const e = c.ends_on ? new Date(c.ends_on) : null;
  if (c.status === 'planning' && s && s.getTime() > Date.now()) {
    return `${months[s.getMonth()]} ${num(s.getFullYear(), isAr)}`;
  }
  if (s && e) {
    if (s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth()) {
      return `${num(s.getDate(), isAr)}–${num(e.getDate(), isAr)} ${months[s.getMonth()]}`;
    }
    if (s.getFullYear() === e.getFullYear()) {
      return `${num(s.getDate(), isAr)} ${months[s.getMonth()]} – ${num(e.getDate(), isAr)} ${months[e.getMonth()]}`;
    }
    return `${num(s.getDate(), isAr)} ${months[s.getMonth()]} ${num(s.getFullYear(), isAr)} – ${num(e.getDate(), isAr)} ${months[e.getMonth()]} ${num(e.getFullYear(), isAr)}`;
  }
  if (s) return shortDate(c.starts_on, isAr);
  return '—';
}

/**
 * Screen 19 — the campaign brief, faithful to the design.
 *
 * The fork at the top matters: picking paid or organic changes the fields below
 * it, because a budget and a cost-per-lead are meaningless on an organic push.
 * There is deliberately NO name field — the goal sentence, written as a RESULT,
 * is the campaign's identity («زيادة الوعي» ليست هدفًا). The success criterion
 * is mandatory: a campaign without one cannot be judged, and every campaign in
 * the old sheet lacked it. Nothing here spends money — executions are created
 * as drafts until someone launches them on the platform itself.
 */
const SPLIT_PLATFORMS = ['meta', 'tiktok', 'google', 'snapchat', 'x'] as const;

interface SplitRow {
  on: boolean;
  purpose: string;
  budget: string;
}

export function CampaignModal({
  campaign, isAr, onClose, onSaved,
}: {
  campaign?: MosCampaign | null;
  isAr: boolean;
  onClose: () => void;
  onSaved: (campaign: MosCampaign) => void;
}) {
  const { projects, contentTypes } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const isNew = !campaign;

  const [kind, setKind] = useState<MosCampaign['kind']>(campaign?.kind ?? 'paid');
  const [goal, setGoal] = useState(campaign?.goal ?? campaign?.name ?? '');
  const [goalIds, setGoalIds] = useState<string[]>(campaign?.goal_ids ?? []);
  const [projectIds, setProjectIds] = useState<string[]>(campaign?.project_ids ?? []);
  // Bulk content planned alongside a NEW campaign (created on save; empty for edit).
  const [drafts, setDrafts] = useState<ContentDraft[]>([]);
  const [ownerRole, setOwnerRole] = useState<string>(campaign?.owner_role ?? 'marketing_manager');
  const [startsOn, setStartsOn] = useState(campaign?.starts_on ?? '');
  const [endsOn, setEndsOn] = useState(campaign?.ends_on ?? '');
  const [budget, setBudget] = useState(campaign?.budget_total?.toString() ?? '');
  const [measures, setMeasures] = useState<MeasureDraft[]>(() => measuresToDrafts(campaign?.success_measures));
  const [status, setStatus] = useState<MosCampaign['status']>(campaign?.status ?? 'planning');
  const [split, setSplit] = useState<Record<string, SplitRow>>(() =>
    Object.fromEntries(SPLIT_PLATFORMS.map((p) => [
      p,
      { on: p === 'meta', purpose: 'sales', budget: '' },
    ])),
  );
  const [busy, setBusy] = useState(false);

  const totalBudget = budget.trim() === '' ? null : Number(budget);
  const allocated = Object.values(split)
    .filter((r) => r.on && r.budget.trim() !== '')
    .reduce((a, r) => a + (Number(r.budget) || 0), 0);
  const unallocated = totalBudget === null ? null : totalBudget - allocated;
  const chosen = SPLIT_PLATFORMS.filter((p) => split[p]?.on);

  const patchSplit = (p: string, patch: Partial<SplitRow>): void =>
    setSplit((cur) => ({ ...cur, [p]: { ...(cur[p] ?? { on: false, purpose: 'sales', budget: '' }), ...patch } }));

  const submit = async (): Promise<void> => {
    if (!goal.trim()) {
      addToast(
        isAr ? 'اكتب وصفًا للحملة — هو اسمها في القوائم.' : 'Write a description — it is the campaign’s name in lists.',
        'error',
      );
      return;
    }
    // Every campaign must serve at least one goal (the server enforces this too).
    if (goalIds.length === 0) {
      addToast(
        isAr ? 'اربط الحملة بهدف واحد على الأقل.' : 'Link the campaign to at least one goal.',
        'error',
      );
      return;
    }
    // The design's note: معيار النجاح إلزامي. A paid campaign without a
    // criterion cannot be judged, so the form refuses it up front.
    if (kind === 'paid' && !hasMeasureTarget(measures)) {
      addToast(
        isAr ? 'حدّد معيار النجاح — حملة بلا معيار لا يمكن الحكم عليها.' : 'Set the success criterion — a campaign without one cannot be judged.',
        'error',
      );
      return;
    }
    // Every planned content piece needs a working title before we create it —
    // content_create rejects a blank one, so we catch it here with a clear line.
    if (isNew && drafts.some((d) => !d.title.trim())) {
      addToast(isAr ? 'أعطِ كل محتوى عنوانًا مبدئيًا.' : 'Give every content piece a working title.', 'error');
      return;
    }
    setBusy(true);
    try {
      const executions = isNew && kind === 'paid'
        ? chosen.map((p) => {
            const row = split[p];
            const purpose = EXEC_PURPOSE_LABELS[row?.purpose ?? ''];
            return {
              platform: p,
              label: purpose ? (isAr ? purpose.ar : purpose.en) : null,
              budget: row && row.budget.trim() !== '' ? Number(row.budget) : null,
            };
          })
        : undefined;

      const res = await saveCampaign(
        {
          id: campaign?.id,
          // The goal doubles as the list's short handle — no separate name.
          name: goal.trim(),
          goal: goal.trim(),
          // The goals this campaign serves (many-to-many; required, ≥1).
          goal_ids: goalIds,
          kind,
          // Multi-project: the server derives the primary project_id from this.
          project_ids: projectIds,
          owner_role: ownerRole || null,
          objective: kind === 'organic' ? 'awareness' : 'leads',
          status,
          starts_on: startsOn || null,
          ends_on: endsOn || null,
          budget_total: kind === 'paid' ? totalBudget : null,
          // The server derives the back-compat primary (success_metric /
          // success_threshold) from success_measures[0].
          success_measures: draftsToMeasures(measures),
        },
        executions,
      );
      // Bulk content: create each planned piece linked to the just-created
      // campaign, so ONE save spins up the campaign AND its production line.
      // Mirrors the single-create path — content_create opens the first task,
      // and each platform gets its own draft publication. A failure on one
      // piece is surfaced but never rolls back the campaign or its siblings.
      let contentOk = 0;
      let contentFail = 0;
      if (isNew && res.item?.id && drafts.length > 0) {
        for (const d of drafts) {
          try {
            const cres = await createContent({
              title: d.title.trim(),
              content_type_key: d.typeKey,
              project_ids: d.projectIds,
              campaign_id: res.item.id,
              purpose: d.purpose,
              target_publish_at: d.targetDate ? new Date(d.targetDate).toISOString() : null,
            });
            const cid = cres.item?.id;
            if (cid) {
              for (const p of d.platforms) await savePublication(cid, { platform: p, status: 'draft' });
            }
            contentOk += 1;
          } catch (err) {
            contentFail += 1;
            console.error('[mos] bulk content create failed', err);
          }
        }
      }

      if (isNew) {
        const execCount = executions?.length ?? 0;
        const clauses: string[] = [];
        if (execCount > 0) clauses.push(isAr ? `${num(execCount, true)} حملات إعلانية` : `${execCount} draft ad campaigns`);
        if (contentOk > 0) clauses.push(isAr ? `${num(contentOk, true)} محتوى` : `${contentOk} content ${contentOk === 1 ? 'piece' : 'pieces'}`);
        const tail = clauses.length > 0 ? (isAr ? ` مع ${clauses.join(' و')}` : ` with ${clauses.join(' and ')}`) : '';
        const failTail = contentFail > 0 ? (isAr ? ` (تعذّر إنشاء ${num(contentFail, true)})` : ` (${contentFail} failed)`) : '';
        addToast(
          isAr
            ? `أُنشئت الحملة ${res.item?.ref ?? ''}${tail}${failTail}.`
            : `Created campaign ${res.item?.ref ?? ''}${tail}${failTail}.`,
          contentFail > 0 ? 'error' : 'success',
        );
      } else {
        addToast(isAr ? 'حُفظت الحملة.' : 'Campaign saved.', 'success');
      }
      onSaved(res.item);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isNew ? (isAr ? 'حملة جديدة' : 'New campaign') : (isAr ? 'تعديل الحملة' : 'Edit campaign')}
      sub={isAr
        ? 'هدف، ومدة، والمنصات التي ستعمل عليها. تُنشأ الحملات الإعلانية كمسودات.'
        : 'A goal, a duration, and the platforms it runs on. Ad campaigns are created as drafts.'}
      onClose={onClose}
      footer={
        <>
          <span className="note">
            {isAr
              ? 'لا شيء ينفق مالًا هنا. الحملات الإعلانية مسودات حتى يطلقها أحد على المنصة نفسها.'
              : 'Nothing here spends money. Ad campaigns stay drafts until someone launches them on the platform itself.'}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy
              ? (isAr ? 'جارٍ الإنشاء…' : 'Working…')
              : isNew ? (isAr ? 'إنشاء الحملة' : 'Create campaign') : (isAr ? 'حفظ' : 'Save')}
          </button>
        </>
      }
    >
      <div>
        <div className="lbl" style={{ marginBottom: 7 }}>{isAr ? 'النوع' : 'Type'}</div>
        <div className="pick2">
          <button type="button" className={`p2${kind === 'paid' ? ' on' : ''}`} onClick={() => setKind('paid')}>
            <IconCampaigns />
            <div className="n4">{isAr ? 'مدفوعة' : 'Paid'}</div>
            <div className="s4">{isAr ? 'ميزانية وتكلفة مستهدفة' : 'a budget and a target cost'}</div>
          </button>
          <button type="button" className={`p2${kind === 'organic' ? ' on' : ''}`} onClick={() => setKind('organic')}>
            <IconMetrics />
            <div className="n4">{isAr ? 'عضوية' : 'Organic'}</div>
            <div className="s4">{isAr ? 'حجم ووصول' : 'volume and reach'}</div>
          </button>
        </div>
      </div>

      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>
          {isAr ? 'الوصف — بماذا تُعرَّف الحملة' : 'Description — what the campaign is'}
        </div>
        <input
          className="inp"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          autoFocus={isNew}
          placeholder={isAr ? 'حملة مينا ٥٢ لعملاء أغسطس' : 'Mina 52 campaign for August leads'}
        />
        <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 5 }}>
          {isAr
            ? 'وصف يقرأه البشر ويميّز الحملة في القوائم. الأرقام والحكم على النجاح يأتيان من معايير النجاح أدناه.'
            : 'A human-readable label that identifies the campaign in lists. The numbers and the success verdict come from the success measures below.'}
        </div>
      </div>

      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>
          {isAr ? 'الأهداف — ما الذي تخدمه الحملة' : 'Goals — what the campaign serves'}
        </div>
        <GoalMultiSelect value={goalIds} onChange={setGoalIds} isAr={isAr} />
        <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 5 }}>
          {isAr
            ? 'كل حملة تُربط بهدف واحد على الأقل. يمكن أن تخدم عدة أهداف.'
            : 'Every campaign links to at least one goal. It may serve several.'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'المشروع' : 'Project'} hint={isAr ? 'اختياري · متعدد' : 'optional · multiple'}>
          <ProjectMultiSelect
            projects={projects}
            value={projectIds}
            onChange={setProjectIds}
            isAr={isAr}
          />
        </Field>
        <Field label={isAr ? 'المسؤول' : 'Responsible'}>
          <select className="inp" value={ownerRole} onChange={(e) => setOwnerRole(e.target.value)}>
            {(['marketing_manager', 'ops_supervisor', 'writer', 'montage'] as const).map((r) => (
              <option key={r} value={r}>{isAr ? ROLE_LABELS[r].ar : ROLE_LABELS[r].en}</option>
            ))}
          </select>
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: kind === 'paid' ? '1fr 1fr 1fr' : '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'تبدأ' : 'Starts'}>
          <input type="date" className="inp ltr" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </Field>
        <Field label={isAr ? 'تنتهي' : 'Ends'}>
          <input type="date" className="inp ltr" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        </Field>
        {kind === 'paid' && (
          <Field label={isAr ? 'الميزانية الكلية' : 'Total budget'}>
            <div className="inp inp-row" style={{ padding: 0 }}>
              <input
                className="inp"
                style={{ border: 0, flex: 1 }}
                inputMode="numeric"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
              <span style={{ fontSize: 11, color: 'var(--mute)', paddingInlineEnd: 11 }}>
                {isAr ? 'ريال' : 'SAR'}
              </span>
            </div>
          </Field>
        )}
      </div>

      {kind === 'paid' && isNew && (
        <div>
          <div className="lbl" style={{ marginBottom: 7 }}>
            {isAr ? 'الحملات الإعلانية التي ستُنشأ' : 'The ad campaigns this will create'}
          </div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 38 }} />
                  <th>{isAr ? 'المنصة' : 'Platform'}</th>
                  <th style={{ width: 130 }}>{isAr ? 'الهدف' : 'Objective'}</th>
                  <th className="num" style={{ width: 122 }}>{isAr ? 'حصة الميزانية' : 'Budget share'}</th>
                </tr>
              </thead>
              <tbody>
                {SPLIT_PLATFORMS.map((p) => {
                  const row = split[p];
                  if (!row) return null;
                  return (
                    <tr key={p} style={row.on ? undefined : { opacity: 0.55 }}>
                      <td>
                        <button
                          type="button"
                          className={`pill ${row.on ? 'p-go' : 'p-idle'}`}
                          style={{ padding: '3px 6px', cursor: 'pointer' }}
                          onClick={() => patchSplit(p, { on: !row.on })}
                          aria-label={isAr ? `تفعيل ${PLATFORM_LABELS[p]?.ar ?? p}` : `Toggle ${PLATFORM_LABELS[p]?.en ?? p}`}
                        >
                          {row.on ? <IconCheck style={{ width: 11, height: 11 }} /> : '○'}
                        </button>
                      </td>
                      <td>{(isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p}</td>
                      <td>
                        {row.on ? (
                          <select
                            className="inp"
                            style={{ padding: '4px 8px', fontSize: 12 }}
                            value={row.purpose}
                            onChange={(e) => patchSplit(p, { purpose: e.target.value })}
                          >
                            {Object.keys(EXEC_PURPOSE_LABELS).map((k) => (
                              <option key={k} value={k}>
                                {isAr ? EXEC_PURPOSE_LABELS[k]?.ar : EXEC_PURPOSE_LABELS[k]?.en}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span style={{ color: 'var(--mute)' }}>—</span>
                        )}
                      </td>
                      <td className="num">
                        {row.on ? (
                          <input
                            className="inp"
                            style={{ padding: '4px 8px', fontSize: 12, textAlign: 'end' }}
                            inputMode="numeric"
                            value={row.budget}
                            onChange={(e) => patchSplit(p, { budget: e.target.value })}
                          />
                        ) : (
                          <span style={{ color: 'var(--mute)' }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* The remainder is shown in the warning tone rather than accepted
              silently — the design's whole point for this table. */}
          {totalBudget !== null && (
            <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 11, color: 'var(--mute)', flexWrap: 'wrap' }}>
              <span>
                {isAr ? 'موزّع ' : 'Allocated '}
                <b style={{ color: 'var(--ink)' }}>{num(allocated, isAr)}</b>
                {isAr ? ` من ${num(totalBudget, true)}` : ` of ${num(totalBudget, false)}`}
              </span>
              {unallocated !== null && unallocated !== 0 && (
                <span style={{ color: unallocated > 0 ? 'var(--wait)' : 'var(--late)', fontWeight: 700 }}>
                  {unallocated > 0
                    ? isAr
                      ? `${num(unallocated, true)} ريال غير موزّعة`
                      : `${num(unallocated, false)} SAR unallocated`
                    : isAr
                      ? `تجاوز بمقدار ${num(Math.abs(unallocated), true)} ريال`
                      : `over by ${num(Math.abs(unallocated), false)} SAR`}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <SuccessMeasuresEditor measures={measures} onChange={setMeasures} isAr={isAr} />

      {isNew && (
        <CampaignContentBuilder
          isAr={isAr}
          projects={projects}
          contentTypes={contentTypes}
          drafts={drafts}
          onChange={setDrafts}
          paid={kind === 'paid'}
          defaultProjectIds={projectIds}
        />
      )}

      {!isNew && (
        <Field label={isAr ? 'الحالة' : 'Status'}>
          <div className="seg" style={{ width: '100%' }}>
            {(['planning', 'active', 'paused', 'done'] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={status === s ? 'on' : ''}
                style={{ flex: 1, textAlign: 'center' }}
                onClick={() => setStatus(s)}
              >
                {isAr ? CAMPAIGN_STATUS_LABELS[s]?.ar : CAMPAIGN_STATUS_LABELS[s]?.en}
              </button>
            ))}
          </div>
        </Field>
      )}

      {isNew && (
        <div
          style={{
            background: 'var(--sand-2)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            padding: '11px 13px',
            fontSize: 11.5,
            color: 'var(--mute)',
            lineHeight: 1.9,
          }}
        >
          <b style={{ color: 'var(--ink)' }}>{isAr ? 'عند الإنشاء' : 'On create'}</b>
          {isAr ? ' — حملة برقم ' : ' — a campaign numbered '}
          <b style={{ color: 'var(--ink)' }} className="ltr">C-</b>
          {kind === 'paid' && chosen.length > 0 && (
            <>
              {isAr
                ? `، و${num(chosen.length, true)} حملات إعلانية كمسودات`
                : `, and ${chosen.length} draft ad campaigns`}
            </>
          )}
          {isAr
            ? '، ويُحكم عليها بمعايير النجاح أعلاه.'
            : ', judged by the success measures above.'}
          <br />
          {isAr
            ? (drafts.length > 0
                ? `و${num(drafts.length, true)} قطعة محتوى مربوطة بالحملة يبدأ مسار عملها فورًا.`
                : 'لم يُضف محتوى بعد — أضِفه أعلاه، أو لاحقًا من تبويب المحتوى.')
            : (drafts.length > 0
                ? `and ${drafts.length} content ${drafts.length === 1 ? 'piece' : 'pieces'} linked to it, whose ${drafts.length === 1 ? 'workflow starts' : 'workflows start'} immediately.`
                : 'No content added yet — add it above, or later from the Content tab.')}
        </div>
      )}
    </Modal>
  );
}
