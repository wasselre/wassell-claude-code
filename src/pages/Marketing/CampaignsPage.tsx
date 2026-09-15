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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  CAMPAIGN_STATUS_LABELS, MosCampaign, MosGoal,
  PLATFORM_LABELS,
  commitCampaignPlan, deleteCampaigns, fetchCampaigns, fetchGoals,
  previewCampaignPlan, reviseCampaignPlan, saveCampaign, successMeasureSuffix,
  type MosPlanEnvelope, type MosPlanRequestInput,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Pill, Skeleton, Stat, Tone } from './components/kit';
import { IconCampaigns, IconContent, IconMetrics, IconPlus } from './components/icons';
import ProjectMultiSelect from './components/ProjectMultiSelect';
import GoalMultiSelect from './components/GoalMultiSelect';
import CampaignRequirementsStep from './components/CampaignRequirementsStep';
import PlanPreview from './components/PlanPreview';
import SuccessMeasuresEditor, {
  MeasureDraft, measuresToDrafts, draftsToMeasures, hasMeasureTarget,
} from './components/SuccessMeasuresEditor';
import {
  buildPlanGrid, buildPlanRequest, creativeTotalsText, diffPlans, emptyRequirements,
  itemsToDrop, mergeLockedPlacements, parseCommitConflict, pickText, planSignature,
  requirementsProblems, swapPlacements,
  type CommitConflict, type LockedPlacement, type PlanAlternative, type PlanDiffEntry,
  type RequirementsDraft,
} from './lib/planPresentation';
import { money, num, pct, shortDate, whole } from './lib/format';
import { measureActual, pickMainMeasure } from './lib/measure';
import { campaignAutoName } from './lib/autoName';
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
      sub: isAr ? `على ${num(whole(spend), true)} ريال` : `on ${num(whole(spend), false)} SAR`,
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

/** The Meta-sync holder is infrastructure — never selectable for deletion. */
const isSyncHolder = (c: MosCampaign): boolean => (c.ref ?? '').startsWith('meta-sync:');

export default function CampaignsPage() {
  const { isAr, can, projects, projectName } = useWorkspace();
  const navigate = useNavigate();
  const addToast = useAppStore((s) => s.addToast);
  const [searchParams, setSearchParams] = useSearchParams();

  const [rows, setRows] = useState<MosCampaign[]>([]);
  const [goals, setGoals] = useState<MosGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // false = closed · 'choose' = the scratch-or-template chooser · {seed} = the
  // campaign form (seed prefills from a picked template, null = from scratch).
  const [creating, setCreating] = useState(false);
  const [statusF, setStatusF] = useState<StatusFilter>('all');
  const [kindF, setKindF] = useState<KindFilter>('all');
  const [projectF, setProjectF] = useState('');
  const [goalF, setGoalF] = useState(searchParams.get('goal') ?? '');
  const [monthScope, setMonthScope] = useState(true);

  // Multi-select for bulk delete (desktop table) — same pattern as ContentListPage.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const canDelete = can('delete_records');

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
      setSelected(new Set());
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

  /* ── bulk delete (desktop table) ────────────────────────────────────── */

  // Prune the selection whenever the visible set changes — a row hidden by a
  // filter change must never ride invisibly into an irreversible bulk delete.
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(filtered.map((c) => c.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [filtered]);

  const selectable = useMemo(() => filtered.filter((c) => !isSyncHolder(c)), [filtered]);
  const allFilteredSelected = selectable.length > 0 && selectable.every((c) => selected.has(c.id));
  const toggleAll = (): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) selectable.forEach((c) => next.delete(c.id));
      else selectable.forEach((c) => next.add(c.id));
      return next;
    });
  };
  const toggleOne = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const bulkDelete = async (): Promise<void> => {
    if (selected.size === 0 || deleting) return;
    setDeleting(true);
    try {
      const res = await deleteCampaigns([...selected]);
      addToast(
        isAr ? `حُذفت ${num(res.deleted, true)} حملة.` : `Deleted ${res.deleted} campaign(s).`,
        'success',
      );
      setSelected(new Set());
      setConfirmOpen(false);
      await load();
    } catch (e) {
      // 409s arrive with a bilingual message (Meta holder / client attributions).
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setDeleting(false);
    }
  };

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
    // Round money to whole riyals — spend from Meta insights carries halalas
    // (e.g. 1264.22), and the Stat card renders this value raw, so the decimal
    // misread as "1,264022" (the "spend this month" bug).
    const spent = Math.round(scoped.reduce((a, c) => a + (c.total_spend ?? 0), 0));
    const budget = Math.round(scoped.reduce((a, c) => a + (c.budget_total ?? 0), 0));
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

            {canDelete && selected.size > 0 && (
              <div
                className="card m4-desk"
                style={{ padding: '10px 14px', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 10 }}
              >
                <b style={{ fontSize: 12.5 }}>
                  {isAr ? `${num(selected.size, true)} محدد` : `${selected.size} selected`}
                </b>
                <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set())}>
                  {isAr ? 'إلغاء التحديد' : 'Clear'}
                </button>
                <button
                  type="button"
                  className="btn btn-d btn-sm"
                  style={{ marginInlineStart: 'auto' }}
                  onClick={() => setConfirmOpen(true)}
                >
                  {isAr ? `حذف (${num(selected.size, true)})` : `Delete (${selected.size})`}
                </button>
              </div>
            )}

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
                        {canDelete && (
                          <th style={{ width: 34 }}>
                            <input
                              type="checkbox"
                              checked={allFilteredSelected}
                              onChange={toggleAll}
                              aria-label={isAr ? 'تحديد الكل' : 'Select all'}
                            />
                          </th>
                        )}
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
                        <th className="num" style={{ width: 82 }}>{isAr ? 'تكلفة العميل' : 'Cost / lead'}</th>
                        <th className="num" style={{ width: 84 }}>{isAr ? 'الظهور' : 'Impressions'}</th>
                        <th className="num" style={{ width: 66 }}>CTR</th>
                        <th className="num" style={{ width: 70 }}>{isAr ? 'النقرات' : 'Clicks'}</th>
                        <th className="num" style={{ width: 66 }}>CPC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((c) => {
                        const st = TABLE_STATUS[c.live_status ?? c.status] ?? FALLBACK_STATUS;
                        const dimmed = c.status === 'done' || c.status === 'cancelled';
                        const planning = c.status === 'planning';
                        const organic = c.kind === 'organic';
                        const plats = c.platforms ?? [];
                        const subLine = plats.length > 0
                          ? plats.map((p) => subPlatform(p, isAr)).join(' · ')
                          : (isAr ? 'لم تُطلق' : 'Not launched yet');
                        const leads = c.total_leads ?? 0;
                        const spend = c.total_spend ?? 0;
                        // Results show whenever the executions have REPORTED them
                        // — never gated on the hand-set status. A campaign left
                        // as «مخططة» while its Meta ads already ran used to blank
                        // its leads (C-041: 5 leads, C-026: 169 leads rendered as
                        // «—»), which read as "the sync is broken".
                        const hasResults = c.total_spend !== null || c.total_leads !== null
                          || c.total_impressions !== null || c.total_clicks !== null;
                        const cpl = !organic && spend > 0 && leads > 0
                          ? Math.round(spend / leads)
                          : null;
                        const impressions = c.total_impressions ?? 0;
                        const clicks = c.total_clicks ?? 0;
                        const ctr = !organic && impressions > 0 ? (clicks / impressions) * 100 : null;
                        const cpc = !organic && spend > 0 && clicks > 0 ? spend / clicks : null;
                        const threshold = c.success_metric === 'cpl' ? c.success_threshold : null;
                        return (
                          <tr
                            key={c.id}
                            className="click"
                            style={{
                              ...(dimmed ? { opacity: 0.65 } : undefined),
                              ...(selected.has(c.id)
                                ? { background: 'color-mix(in srgb, var(--copper) 9%, transparent)' }
                                : undefined),
                            }}
                            onClick={() => navigate(`/m/campaigns/${c.id}`)}
                          >
                            {canDelete && (
                              <td onClick={(e) => e.stopPropagation()} style={{ cursor: 'default' }}>
                                <input
                                  type="checkbox"
                                  checked={selected.has(c.id)}
                                  disabled={isSyncHolder(c)}
                                  title={isSyncHolder(c)
                                    ? (isAr ? 'بنية أساسية للمزامنة — لا تُحذف' : 'Sync infrastructure — cannot be deleted')
                                    : undefined}
                                  onChange={() => toggleOne(c.id)}
                                  aria-label={isAr ? `تحديد ${c.name}` : `Select ${c.name}`}
                                />
                              </td>
                            )}
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
                            {/* The count doubles as the door to the library,
                                filtered to this campaign's content. */}
                            <td className="num" onClick={(e) => e.stopPropagation()} style={{ cursor: 'default' }}>
                              <button
                                type="button"
                                className="btn btn-sm"
                                title={isAr ? 'عرض محتوى هذه الحملة' : 'Show this campaign\u2019s content'}
                                onClick={() => navigate(`/m/content?campaign=${c.id}`)}
                              >
                                <IconContent style={{ width: 12, height: 12 }} />
                                {num(c.content_count, isAr)}
                              </button>
                            </td>
                            <td className="num" style={organic || c.budget_total === null ? { color: 'var(--mute)' } : undefined}>
                              {organic
                                ? '—'
                                : c.budget_total !== null
                                  ? num(c.budget_total, isAr)
                                  : planning ? (isAr ? 'لاحقًا' : 'later') : '—'}
                            </td>
                            <td className="num" style={organic || c.total_spend === null ? { color: 'var(--mute)' } : undefined}>
                              {organic ? '—' : num(whole(c.total_spend), isAr)}
                            </td>
                            <td className="num" style={c.total_leads === null ? { color: 'var(--mute)' } : undefined}>
                              {hasResults ? num(c.total_leads ?? 0, isAr) : '—'}
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
                            <td className="num" style={!hasResults || organic ? { color: 'var(--mute)' } : undefined}>
                              {organic || !hasResults ? '—' : num(impressions, isAr)}
                            </td>
                            <td className="num" style={ctr === null ? { color: 'var(--mute)' } : undefined}>
                              {ctr === null ? '—' : pct(ctr, isAr, 1)}
                            </td>
                            <td className="num" style={!hasResults || organic ? { color: 'var(--mute)' } : undefined}>
                              {organic || !hasResults ? '—' : num(clicks, isAr)}
                            </td>
                            <td className="num" style={cpc === null ? { color: 'var(--mute)' } : undefined}>
                              {cpc === null ? '—' : num(Math.round(cpc * 100) / 100, isAr)}
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

      {confirmOpen && (
        <Modal
          title={isAr ? 'حذف الحملات' : 'Delete campaigns'}
          sub={isAr
            ? `ستُحذف ${num(selected.size, true)} حملة نهائيًا مع إعلاناتها وتعليقاتها وسجل أحداثها — لا يمكن التراجع. المحتوى والمهام تبقى وتُفصل عنها فقط.`
            : `${selected.size} campaign(s) will be permanently deleted with their executions, comments and event log — this cannot be undone. Content and tasks survive and are only detached.`}
          onClose={() => { if (!deleting) setConfirmOpen(false); }}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirmOpen(false)} disabled={deleting}>
                {isAr ? 'إلغاء' : 'Cancel'}
              </button>
              <button type="button" className="btn btn-d" onClick={() => void bulkDelete()} disabled={deleting}>
                {deleting
                  ? isAr ? 'جارٍ الحذف…' : 'Deleting…'
                  : isAr ? `حذف ${num(selected.size, true)}` : `Delete ${selected.size}`}
              </button>
            </>
          }
        >
          <div style={{ fontSize: 12.5, color: 'var(--mute)', lineHeight: 1.8 }}>
            {[...selected]
              .map((id) => rows.find((c) => c.id === id))
              .filter((c): c is MosCampaign => c !== undefined)
              .map((c) => (
                <div key={c.id}>
                  <span className="id ltr" style={{ marginInlineEnd: 6 }}>{c.ref ?? '—'}</span>
                  {c.name}
                </div>
              ))}
          </div>
        </Modal>
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
 * Screen 19 — the campaign brief, now a THREE-STEP WIZARD for a new campaign.
 *
 *   1. Requirements — the fork (paid / organic), the goal it serves, and the
 *      quantities: which projects, how many posts and videos of each, on which
 *      platforms, over which dates, how often.
 *   2. Plan preview — the scheduling engine's answer, planned against the LIVE
 *      workload: what gets made, who it lands on, when production must start,
 *      what the feed will look like, and what is in the way.
 *   3. Approve — the only step that writes.
 *
 * The old builder created content rows the moment you pressed Create, so a
 * campaign existed before anyone knew whether the team could produce it. Now
 * nothing at all is created until step 3, and the approval is checked twice:
 * once by re-planning against the live ledger, and once by the database's own
 * capacity re-check. Either can refuse with a 409 — and when it does, the
 * refreshed plan is shown with its differences highlighted. We never re-submit
 * automatically; a plan a human has not read is a plan nobody approved.
 *
 * Editing an EXISTING campaign stays a plain form: a campaign envelope's name,
 * dates and budget are not a scheduling question, and re-planning a live
 * campaign belongs on the campaign page where its current plan lives.
 */

type WizardStep = 'requirements' | 'preview' | 'approve';

export function CampaignModal({
  campaign, isAr, onClose, onSaved,
}: {
  campaign?: MosCampaign | null;
  isAr: boolean;
  onClose: () => void;
  onSaved: (campaign: MosCampaign) => void;
}) {
  if (campaign) {
    return <EditCampaignForm campaign={campaign} isAr={isAr} onClose={onClose} onSaved={onSaved} />;
  }
  return <NewCampaignWizard isAr={isAr} onClose={onClose} onSaved={onSaved} />;
}

/* ------------------------------------------------------------------ */
/* the wizard (new campaigns)                                         */
/* ------------------------------------------------------------------ */

function NewCampaignWizard({
  isAr, onClose, onSaved,
}: {
  isAr: boolean;
  onClose: () => void;
  onSaved: (campaign: MosCampaign) => void;
}) {
  const { projects, projectName, people } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);

  const [step, setStep] = useState<WizardStep>('requirements');

  // ── the campaign envelope's own fields ──────────────────────────────
  const [kind, setKind] = useState<MosCampaign['kind']>('paid');
  const [goal, setGoal] = useState('');
  const [goalIds, setGoalIds] = useState<string[]>([]);
  const [goalsList, setGoalsList] = useState<MosGoal[]>([]);
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  // Written, never asked: the dropdown is gone (2026-09-15) and nothing reads
  // this as an assignment, but the column stays populated rather than NULL so
  // existing readers (the campaign header, the row tone in kit.tsx) keep working.
  const ownerRole = 'marketing_manager';
  const [budget, setBudget] = useState('');
  const [measures, setMeasures] = useState<MeasureDraft[]>(() => measuresToDrafts(undefined));

  // ── the planning requirements ───────────────────────────────────────
  const [req, setReq] = useState<RequirementsDraft>(() => emptyRequirements('paid'));

  // ── the plan under review ───────────────────────────────────────────
  const [envelope, setEnvelope] = useState<MosPlanEnvelope | null>(null);
  const [planInput, setPlanInput] = useState<MosPlanRequestInput | null>(null);
  const [locks, setLocks] = useState<LockedPlacement[]>([]);
  const [dropped, setDropped] = useState<string[]>([]);
  /** The plan the human actually read. A commit may only ever apply THIS one. */
  const [reviewedSignature, setReviewedSignature] = useState<string | null>(null);
  const [diff, setDiff] = useState<PlanDiffEntry[] | null>(null);
  const [conflict, setConflict] = useState<CommitConflict | null>(null);
  /** Set once the envelope exists, so a retry never creates a second campaign. */
  const [createdCampaign, setCreatedCampaign] = useState<MosCampaign | null>(null);

  const [busy, setBusy] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);

  // The type fork rewrites the planning defaults (paid plans ad channels and a
  // refresh policy; organic plans feeds and a frequency), so switching it
  // resets the requirements rather than leaving a half-paid draft behind.
  const switchKind = (next: MosCampaign['kind']): void => {
    if (next === kind) return;
    setKind(next);
    setReq(emptyRequirements(next === 'paid' ? 'paid' : 'organic'));
    setEnvelope(null);
    setPlanInput(null);
    setReviewedSignature(null);
    setDiff(null);
    setConflict(null);
  };

  const goalLabels = useMemo(
    () => goalIds.map((id) => goalsList.find((g) => g.id === id)?.name ?? '').filter(Boolean),
    [goalIds, goalsList],
  );
  const projectLabels = useMemo(
    () => req.projectIds.map((id) => projectName(id)).filter(Boolean),
    [req.projectIds, projectName],
  );
  const computedName = useMemo(
    () => campaignAutoName({ kind, goalLabels, projectLabels, date: new Date(), isAr }),
    [kind, goalLabels, projectLabels, isAr],
  );
  useEffect(() => {
    if (!nameEdited) setName(computedName);
    // computedName already folds in kind/goals/projects; nameEdited gates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, goalLabels.join('|'), projectLabels.join('|'), nameEdited]);

  const dirty = goalIds.length > 0 || goal.trim() !== '' || nameEdited
    || req.projectIds.length > 0 || req.rangeStart !== '' || req.rangeEnd !== ''
    || envelope !== null || measures.length > 0;

  const requestClose = useCallback((): void => {
    if (busy) return;
    if (dirty) { setCloseConfirm(true); return; }
    onClose();
  }, [busy, dirty, onClose]);

  /* ---------------- step 1 → 2: ask the engine ---------------------- */

  const envelopeProblems = (): string[] => {
    const out: string[] = [];
    if (!name.trim()) out.push(isAr ? 'الحملة تحتاج اسمًا.' : 'The campaign needs a name.');
    if (goalIds.length === 0) out.push(isAr ? 'اربط الحملة بهدف واحد على الأقل.' : 'Link the campaign to at least one goal.');
    if (kind === 'paid' && !hasMeasureTarget(measures)) {
      out.push(isAr
        ? 'حدّد معيار النجاح — حملة بلا معيار لا يمكن الحكم عليها.'
        : 'Set the success criterion — a campaign without one cannot be judged.');
    }
    return out;
  };

  const runPreview = async (
    draft: RequirementsDraft,
    opts: { lockedPlacements?: LockedPlacement[]; droppedItemKeys?: string[]; campaignId?: string | null } = {},
  ): Promise<MosPlanEnvelope | null> => {
    const input = buildPlanRequest(draft, {
      campaignId: opts.campaignId ?? createdCampaign?.id ?? null,
      lockedPlacements: opts.lockedPlacements ?? locks,
      droppedItemKeys: opts.droppedItemKeys ?? dropped,
      projectNameOf: (id) => projectName(id),
    });
    setBusy(true);
    try {
      const res = await previewCampaignPlan(input);
      setEnvelope(res);
      setPlanInput(input);
      setReviewedSignature(planSignature(res.plan));
      setConflict(null);
      setDiff(null);
      return res;
    } catch (e) {
      // Loud, always: a preview that silently fails is a manager staring at a
      // stale plan and believing it.
      console.error('[mos] campaign_plan_preview failed', e);
      addToast(e instanceof Error ? e.message : String(e), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const goToPreview = async (): Promise<void> => {
    const problems = [
      ...envelopeProblems(),
      ...requirementsProblems(req).map((p) => pickText(p, isAr)),
    ];
    if (problems.length > 0) { addToast(problems[0] ?? '', 'error'); return; }
    const res = await runPreview(req);
    if (res) setStep('preview');
  };

  /* ---------------- revise: pins and alternatives ------------------- */

  const onSwap = async (platform: string, aKey: string, bKey: string): Promise<void> => {
    if (!envelope) return;
    const cells = buildPlanGrid(envelope.plan.items, platform).cells;
    const pins = swapPlacements(cells, aKey, bKey, platform);
    if (pins.length === 0) return;
    const merged = mergeLockedPlacements(locks, pins);
    setLocks(merged);
    setBusy(true);
    try {
      const res = await reviseCampaignPlan(envelope.plan_id, {
        locked_placements: merged,
        dropped_item_keys: dropped,
      });
      setEnvelope(res);
      setReviewedSignature(planSignature(res.plan));
      setDiff(null);
    } catch (e) {
      console.error('[mos] campaign_plan_revise failed', e);
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const onAlternative = async (alt: PlanAlternative): Promise<void> => {
    if (alt.kind === 'earliest_start' && alt.rangeStart && alt.rangeEnd) {
      const next = { ...req, rangeStart: alt.rangeStart, rangeEnd: alt.rangeEnd };
      setReq(next);
      await runPreview(next);
      return;
    }
    if (alt.kind === 'fewer_items' && alt.maxItems !== undefined && envelope) {
      const keys = itemsToDrop(envelope.plan, alt.maxItems);
      setDropped(keys);
      await runPreview(req, { droppedItemKeys: keys });
    }
  };

  /* ---------------- step 3: the only writes --------------------------- */

  const commit = async (planId: string): Promise<boolean> => {
    try {
      await commitCampaignPlan(planId);
      return true;
    } catch (e) {
      const c = parseCommitConflict(e);
      if (!c) {
        console.error('[mos] campaign_plan_commit failed', e);
        addToast(e instanceof Error ? e.message : String(e), 'error');
        return false;
      }
      // A 409 is not a retry — it is a new plan the human has not read yet.
      console.error('[mos] campaign_plan_commit conflict', c.kind, c.diff);
      setConflict(c);
      if (c.plan && envelope) {
        setDiff(diffPlans(envelope.plan, c.plan));
        setEnvelope({ ...envelope, plan: c.plan });
        setReviewedSignature(null);
      }
      setStep('preview');
      addToast(pickText(c.message, isAr), 'error');
      return false;
    }
  };

  const approve = async (): Promise<void> => {
    if (!envelope || !planInput) return;
    setBusy(true);
    try {
      // 1. The envelope. Created here and NOT before, so an abandoned wizard
      //    leaves nothing behind. Kept in state so a failed commit never makes
      //    a second campaign on the next attempt.
      let parent = createdCampaign;
      if (!parent) {
        const saved = await saveCampaign({
          name: name.trim(),
          goal: goal.trim(),
          goal_ids: goalIds,
          kind,
          project_ids: req.projectIds,
          owner_role: ownerRole || null,
          objective: kind === 'organic' ? 'awareness' : 'leads',
          status: 'planning',
          starts_on: req.rangeStart || null,
          ends_on: req.rangeEnd || null,
          budget_total: kind === 'paid' && budget.trim() !== '' ? Number(budget) : null,
          success_measures: draftsToMeasures(measures),
        }, undefined);
        if (!saved.item?.id) {
          addToast(isAr ? 'تعذّر إنشاء الحملة.' : 'The campaign could not be created.', 'error');
          return;
        }
        parent = saved.item;
        setCreatedCampaign(saved.item);
      }

      // 2. The stored plan was planned with `campaign_id = null`; the commit
      //    materialises against the input it stored, so it must be re-planned
      //    bound to the campaign. That re-plan reads the LIVE ledger, so it can
      //    legitimately differ from what was on screen — in which case we show
      //    the difference and wait, rather than committing something unseen.
      const bound = await runPreviewBound(parent.id);
      if (!bound) return;
      if (reviewedSignature !== null && planSignature(bound.plan) !== reviewedSignature) {
        setDiff(diffPlans(envelope.plan, bound.plan));
        setStep('preview');
        addToast(
          isAr
            ? 'تغيّر الحمل أثناء المراجعة — راجع الخطة المحدَّثة ثم اعتمدها.'
            : 'The workload changed while you were reviewing — read the refreshed plan, then approve it.',
          'error',
        );
        return;
      }
      if (!bound.plan.feasible) {
        addToast(
          isAr ? 'الخطة المحدَّثة لم تعد قابلة للتنفيذ. راجعها.' : 'The refreshed plan is no longer feasible. Review it.',
          'error',
        );
        setStep('preview');
        return;
      }

      // 3. The write.
      const ok = await commit(bound.plan_id);
      if (!ok) return;
      addToast(
        isAr
          ? `اعتُمدت خطة الحملة ${parent.ref ?? ''} — أُنشئ المحتوى وحُجزت أيام الفريق.`
          : `Approved the plan for ${parent.ref ?? ''} — content created and the team’s days reserved.`,
        'success',
      );
      onSaved(parent);
    } finally {
      setBusy(false);
    }
  };

  /**
   * A preview bound to the just-created campaign. Separate from `runPreview`
   * only because it must not clear `reviewedSignature` — that value is what the
   * approval is checked against.
   */
  const runPreviewBound = async (campaignId: string): Promise<MosPlanEnvelope | null> => {
    const input = buildPlanRequest(req, {
      campaignId,
      lockedPlacements: locks,
      droppedItemKeys: dropped,
      projectNameOf: (id) => projectName(id),
    });
    try {
      const res = await previewCampaignPlan(input);
      setEnvelope(res);
      setPlanInput(input);
      return res;
    } catch (e) {
      console.error('[mos] campaign_plan_preview (bound) failed', e);
      addToast(e instanceof Error ? e.message : String(e), 'error');
      return null;
    }
  };

  /** Approve the plan currently on screen, after a 409 or a drifted re-plan. */
  const approveRefreshed = async (): Promise<void> => {
    if (!envelope) return;
    setReviewedSignature(planSignature(envelope.plan));
    setDiff(null);
    setConflict(null);
    setBusy(true);
    try {
      const ok = await commit(envelope.plan_id);
      if (!ok) return;
      const parent = createdCampaign;
      addToast(
        isAr ? 'اعتُمدت الخطة المحدَّثة.' : 'The refreshed plan was approved.',
        'success',
      );
      if (parent) onSaved(parent);
      else onClose();
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- render ------------------------------------------- */

  const plan = envelope?.plan ?? null;
  const stepIndex = step === 'requirements' ? 1 : step === 'preview' ? 2 : 3;
  const stepTitle = step === 'requirements'
    ? (isAr ? 'المتطلبات' : 'Requirements')
    : step === 'preview' ? (isAr ? 'معاينة الخطة' : 'Plan preview') : (isAr ? 'الاعتماد' : 'Approve');

  return (
    <>
      <Modal
        wide
        title={isAr ? `حملة جديدة · ${stepTitle}` : `New campaign · ${stepTitle}`}
        sub={isAr
          ? `الخطوة ${num(stepIndex, true)} من ٣ — لا يُنشأ أي شيء قبل الاعتماد في الخطوة الثالثة.`
          : `Step ${stepIndex} of 3 — nothing is created until you approve in step 3.`}
        onClose={requestClose}
        footer={
          <>
            <span className="note">
              {step === 'requirements' && (isAr
                ? 'المطلوب كمية، لا قائمة: المحرّك يوزّع البنود على الأيام ويحسب من ينتجها.'
                : 'State a quantity, not a list: the engine spreads the items across the days and works out who produces them.')}
              {step === 'preview' && (isAr
                ? 'هذه معاينة محسوبة على الحمل الحقيقي. لا سجل واحد مكتوب حتى الآن.'
                : 'This preview is computed against the real workload. Not one record has been written yet.')}
              {step === 'approve' && (isAr
                ? 'الاعتماد يُنشئ المحتوى ويحجز أيام الفريق ويكتب مواعيد النشر.'
                : 'Approving creates the content, reserves the team’s days, and writes the publishing dates.')}
            </span>
            {step !== 'requirements' && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setStep(step === 'approve' ? 'preview' : 'requirements')}
              >
                {isAr ? 'رجوع' : 'Back'}
              </button>
            )}
            <button type="button" className="btn" onClick={requestClose} disabled={busy}>
              {isAr ? 'إلغاء' : 'Cancel'}
            </button>
            {step === 'requirements' && (
              <button type="button" className="btn btn-p" disabled={busy} onClick={() => void goToPreview()}>
                {busy ? (isAr ? 'جارٍ الحساب…' : 'Planning…') : (isAr ? 'معاينة الخطة' : 'Preview the plan')}
              </button>
            )}
            {step === 'preview' && (
              <>
                <button type="button" className="btn" disabled={busy} onClick={() => void runPreview(req)}>
                  {isAr ? 'إعادة الحساب' : 'Re-plan'}
                </button>
                {(diff && diff.length > 0) || conflict ? (
                  <button type="button" className="btn btn-p" disabled={busy} onClick={() => void approveRefreshed()}>
                    {busy ? (isAr ? 'جارٍ الاعتماد…' : 'Approving…') : (isAr ? 'اعتمد الخطة المحدَّثة' : 'Approve the refreshed plan')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-p"
                    disabled={busy || !plan || !plan.feasible}
                    onClick={() => setStep('approve')}
                    title={plan && !plan.feasible
                      ? (isAr ? 'لا يمكن اعتماد خطة غير قابلة للتنفيذ.' : 'An infeasible plan cannot be approved.')
                      : undefined}
                  >
                    {isAr ? 'متابعة للاعتماد' : 'Continue to approve'}
                  </button>
                )}
              </>
            )}
            {step === 'approve' && (
              <button type="button" className="btn btn-p" disabled={busy} onClick={() => void approve()}>
                {busy ? (isAr ? 'جارٍ الاعتماد…' : 'Approving…') : (isAr ? 'اعتماد وإنشاء' : 'Approve and create')}
              </button>
            )}
          </>
        }
      >
        {/* ── the step rail ───────────────────────────────────────────── */}
        <div className="seg" style={{ width: '100%' }}>
          {([
            ['requirements', isAr ? '١ · المتطلبات' : '1 · Requirements'],
            ['preview', isAr ? '٢ · معاينة الخطة' : '2 · Plan preview'],
            ['approve', isAr ? '٣ · الاعتماد' : '3 · Approve'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={step === key ? 'on' : ''}
              style={{ flex: 1, textAlign: 'center' }}
              disabled={busy
                || (key !== 'requirements' && !envelope)
                || (key === 'approve' && !(plan && plan.feasible))}
              onClick={() => setStep(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {step === 'requirements' && (
          <>
            <div>
              <div className="lbl" style={{ marginBottom: 7 }}>{isAr ? 'النوع' : 'Type'}</div>
              <div className="pick2">
                <button type="button" className={`p2${kind === 'paid' ? ' on' : ''}`} onClick={() => switchKind('paid')}>
                  <IconCampaigns />
                  <div className="n4">{isAr ? 'مدفوعة' : 'Paid'}</div>
                  <div className="s4">{isAr ? 'ميزانية وتحديث أسبوعي للتصاميم' : 'a budget and a weekly creative refresh'}</div>
                </button>
                <button type="button" className={`p2${kind === 'organic' ? ' on' : ''}`} onClick={() => switchKind('organic')}>
                  <IconMetrics />
                  <div className="n4">{isAr ? 'عضوية' : 'Organic'}</div>
                  <div className="s4">{isAr ? 'جدول نشر على المنصات' : 'a publishing schedule across the feeds'}</div>
                </button>
              </div>
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                <div className="lbl">{isAr ? 'اسم الحملة' : 'Campaign name'}</div>
                <button
                  type="button"
                  className="fbtn"
                  style={{ fontSize: 11, padding: '3px 9px' }}
                  onClick={() => { setNameEdited(false); setName(computedName); }}
                  title={isAr ? 'إعادة توليد الاسم من الحقول' : 'Regenerate from the fields'}
                >
                  ↻ {isAr ? 'توليد تلقائي' : 'Auto'}
                </button>
              </div>
              <input
                className="inp"
                value={name}
                onChange={(e) => { setName(e.target.value); setNameEdited(true); }}
                autoFocus
                placeholder={computedName}
              />
            </div>

            <div>
              <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'الوصف — اختياري' : 'Description — optional'}</div>
              <input
                className="inp"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder={isAr ? 'حملة مينا ٥٢ لعملاء أغسطس' : 'Mina 52 campaign for August leads'}
              />
            </div>

            <div>
              <div className="lbl" style={{ marginBottom: 6 }}>
                {isAr ? 'الأهداف — ما الذي تخدمه الحملة' : 'Goals — what the campaign serves'}
              </div>
              <GoalMultiSelect value={goalIds} onChange={setGoalIds} isAr={isAr} onLoaded={setGoalsList} />
            </div>

            {/* «المسؤول» was a dropdown here until 2026-09-15. Nothing reads
                `owner_role` on a campaign as an assignment — work is assigned
                by the workflow's own role steps and the capacity ledger — so
                it was a required choice that changed nothing. It is written as
                `marketing_manager` and no longer asked. */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 13 }}>
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

            <CampaignRequirementsStep
              draft={req}
              onChange={setReq}
              projects={projects}
              projectName={projectName}
              isAr={isAr}
            />

            <SuccessMeasuresEditor measures={measures} onChange={setMeasures} isAr={isAr} />
          </>
        )}

        {step === 'preview' && plan && planInput && (
          <>
            {conflict && (
              <div className="notice bad" role="alert">
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  {conflict.kind === 'capacity_conflict'
                    ? (isAr ? 'رفضت قاعدة البيانات الاعتماد: السعة' : 'The database refused the approval: capacity')
                    : (isAr ? 'رفضت قاعدة البيانات الاعتماد: تغيّرت الخطة' : 'The database refused the approval: the plan changed')}
                </div>
                <div>{pickText(conflict.message, isAr)}</div>
                <div style={{ marginTop: 6 }}>
                  {isAr
                    ? 'لم يُكتب شيء. اقرأ الخطة المحدَّثة أدناه، ثم اعتمدها صراحةً.'
                    : 'Nothing was written. Read the refreshed plan below, then approve it explicitly.'}
                </div>
              </div>
            )}
            <PlanPreview
              plan={plan}
              input={planInput}
              people={people}
              projectName={projectName}
              isAr={isAr}
              busy={busy}
              diff={diff}
              onAlternative={(alt) => void onAlternative(alt)}
              onSwap={(platform, a, b) => void onSwap(platform, a, b)}
            />
          </>
        )}

        {step === 'approve' && plan && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="notice">
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {isAr ? 'ما الذي سيحدث عند الاعتماد' : 'What approving does'}
              </div>
              <div>
                {isAr
                  ? 'تُنشأ الحملة الأم وحملة فرعية لكل منصة، وقطعة محتوى لكل بند بمواعيدها، وتُحجز أيام الفريق في التقويم، وتُكتب دفعات النشر. لا يُفتح أي مهمة قبل موعد بدء إنتاجها، ولا يُنشر شيء تلقائيًا.'
                  : 'It creates the parent campaign and one child per platform, a content piece per item with its dates, reservations on the team’s calendar, and the publishing batches. No task opens before its production start, and nothing publishes by itself.'}
              </div>
            </div>

            <div className="grid g4" style={{ gap: 13 }}>
              <Stat isAr={isAr} label={isAr ? 'قطع محتوى' : 'Content pieces'} value={plan.totals.items} />
              <Stat isAr={isAr} label={isAr ? 'حملات فرعية' : 'Child campaigns'} value={req.platforms.length} />
              <Stat isAr={isAr} label={isAr ? 'دفعات نشر' : 'Publishing batches'} value={plan.totals.batches} />
              <Stat isAr={isAr} label={isAr ? 'حجوزات عمل' : 'Work reservations'} value={plan.reservations.length} />
            </div>

            <div className="card">
              <div className="card-h"><h4>{isAr ? 'الحملة' : 'The campaign'}</h4></div>
              <div className="card-b" style={{ fontSize: 12.5, lineHeight: 2 }}>
                <div><b>{isAr ? 'الاسم' : 'Name'}:</b> {name.trim() || '—'}</div>
                <div><b>{isAr ? 'النوع' : 'Type'}:</b> {kind === 'paid' ? (isAr ? 'مدفوعة' : 'Paid') : (isAr ? 'عضوية' : 'Organic')}</div>
                <div>
                  <b>{isAr ? 'المدى' : 'Range'}:</b>{' '}
                  <span className="ltr">{req.rangeStart} → {req.rangeEnd}</span>
                </div>
                <div>
                  <b>{isAr ? 'المنصات' : 'Platforms'}:</b>{' '}
                  {req.platforms.map((p) => (isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p).join(' · ')}
                </div>
                {kind === 'paid' && plan.totals.creatives && (
                  <div><b>{isAr ? 'التصاميم' : 'Creatives'}:</b> {creativeTotalsText(plan.totals.creatives, isAr)}</div>
                )}
              </div>
            </div>

            {createdCampaign && (
              <div className="notice">
                {isAr
                  ? `أُنشئت الحملة ${createdCampaign.ref ?? ''} في محاولة سابقة ولم تُعتمد خطتها بعد — لن تُنشأ حملة ثانية.`
                  : `Campaign ${createdCampaign.ref ?? ''} was created on an earlier attempt and its plan is not approved yet — a second campaign will not be created.`}
              </div>
            )}
          </div>
        )}
      </Modal>

      {closeConfirm && (
        <Modal
          title={isAr ? 'تجاهل التغييرات؟' : 'Discard changes?'}
          sub={isAr ? 'لديك متطلبات أو خطة لم تُعتمد.' : 'You have requirements or a plan that were never approved.'}
          onClose={() => setCloseConfirm(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setCloseConfirm(false)}>
                {isAr ? 'متابعة التحرير' : 'Keep editing'}
              </button>
              <button type="button" className="btn btn-d" onClick={() => { setCloseConfirm(false); onClose(); }}>
                {isAr ? 'تجاهل وإغلاق' : 'Discard & close'}
              </button>
            </>
          }
        >
          <div style={{ fontSize: 13, color: 'var(--mute)', lineHeight: 1.9 }}>
            {createdCampaign
              ? (isAr
                  ? `الحملة ${createdCampaign.ref ?? ''} أُنشئت بالفعل وستبقى بلا خطة معتمدة. الخطة نفسها لم تُكتب.`
                  : `Campaign ${createdCampaign.ref ?? ''} already exists and will stay without an approved plan. The plan itself was never written.`)
              : (isAr
                  ? 'لم يُنشأ شيء بعد — الإغلاق الآن لا يترك أي سجل خلفه.'
                  : 'Nothing has been created yet — closing now leaves no record behind.')}
          </div>
        </Modal>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* the plain edit form (existing campaigns)                           */
/* ------------------------------------------------------------------ */

function EditCampaignForm({
  campaign, isAr, onClose, onSaved,
}: {
  campaign: MosCampaign;
  isAr: boolean;
  onClose: () => void;
  onSaved: (campaign: MosCampaign) => void;
}) {
  const { projects } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);

  const [kind, setKind] = useState<MosCampaign['kind']>(campaign.kind);
  const [goal, setGoal] = useState(campaign.goal ?? campaign.name ?? '');
  const [goalIds, setGoalIds] = useState<string[]>(campaign.goal_ids ?? []);
  const [projectIds, setProjectIds] = useState<string[]>(campaign.project_ids ?? []);
  const [name, setName] = useState(campaign.name ?? '');
  const ownerRole = campaign.owner_role ?? 'marketing_manager';
  const [startsOn, setStartsOn] = useState(campaign.starts_on ?? '');
  const [endsOn, setEndsOn] = useState(campaign.ends_on ?? '');
  const [budget, setBudget] = useState(campaign.budget_total?.toString() ?? '');
  const [measures, setMeasures] = useState<MeasureDraft[]>(() => measuresToDrafts(campaign.success_measures));
  const [status, setStatus] = useState<MosCampaign['status']>(campaign.status);
  const [busy, setBusy] = useState(false);
  const [closeConfirm, setCloseConfirm] = useState(false);

  const initial = useRef({
    kind: campaign.kind,
    name: campaign.name ?? '',
    goal: campaign.goal ?? campaign.name ?? '',
    goalIds: JSON.stringify(campaign.goal_ids ?? []),
    projectIds: JSON.stringify(campaign.project_ids ?? []),
    ownerRole: campaign.owner_role ?? 'marketing_manager',
    startsOn: campaign.starts_on ?? '',
    endsOn: campaign.ends_on ?? '',
    budget: campaign.budget_total?.toString() ?? '',
    status: campaign.status,
    measures: JSON.stringify(measuresToDrafts(campaign.success_measures)),
  }).current;

  const dirty = kind !== initial.kind
    || name !== initial.name
    || goal !== initial.goal
    || JSON.stringify(goalIds) !== initial.goalIds
    || JSON.stringify(projectIds) !== initial.projectIds
    || ownerRole !== initial.ownerRole
    || startsOn !== initial.startsOn
    || endsOn !== initial.endsOn
    || budget !== initial.budget
    || status !== initial.status
    || JSON.stringify(measures) !== initial.measures;

  const requestClose = useCallback((): void => {
    if (busy) return;
    if (dirty) { setCloseConfirm(true); return; }
    onClose();
  }, [busy, dirty, onClose]);

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      addToast(isAr ? 'الحملة تحتاج اسمًا.' : 'The campaign needs a name.', 'error');
      return;
    }
    if (goalIds.length === 0) {
      addToast(isAr ? 'اربط الحملة بهدف واحد على الأقل.' : 'Link the campaign to at least one goal.', 'error');
      return;
    }
    if (kind === 'paid' && !hasMeasureTarget(measures)) {
      addToast(
        isAr ? 'حدّد معيار النجاح — حملة بلا معيار لا يمكن الحكم عليها.'
          : 'Set the success criterion — a campaign without one cannot be judged.',
        'error',
      );
      return;
    }
    setBusy(true);
    try {
      const res = await saveCampaign({
        id: campaign.id,
        name: name.trim(),
        goal: goal.trim(),
        goal_ids: goalIds,
        kind,
        project_ids: projectIds,
        owner_role: ownerRole || null,
        objective: kind === 'organic' ? 'awareness' : 'leads',
        status,
        starts_on: startsOn || null,
        ends_on: endsOn || null,
        budget_total: kind === 'paid' ? (budget.trim() === '' ? null : Number(budget)) : null,
        success_measures: draftsToMeasures(measures),
      }, undefined);
      addToast(isAr ? 'حُفظت الحملة.' : 'Campaign saved.', 'success');
      onSaved(res.item);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        title={isAr ? 'تعديل الحملة' : 'Edit campaign'}
        sub={isAr
          ? 'الظرف نفسه — الاسم والمدة والميزانية. جدولة المحتوى تُعاد من صفحة الحملة.'
          : 'The envelope itself — name, duration, budget. Content scheduling is re-planned from the campaign page.'}
        onClose={requestClose}
        footer={
          <>
            <span className="note">
              {isAr
                ? 'لا شيء ينفق مالًا هنا. تعديل التواريخ لا يعيد جدولة المحتوى المُعتمد.'
                : 'Nothing here spends money. Changing the dates does not re-schedule approved content.'}
            </span>
            <button type="button" className="btn" onClick={requestClose} disabled={busy}>
              {isAr ? 'إلغاء' : 'Cancel'}
            </button>
            <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
              {busy ? (isAr ? 'جارٍ الحفظ…' : 'Working…') : (isAr ? 'حفظ' : 'Save')}
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

        <Field label={isAr ? 'اسم الحملة' : 'Campaign name'}>
          <input className="inp" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label={isAr ? 'الوصف — اختياري' : 'Description — optional'}>
          <input className="inp" value={goal} onChange={(e) => setGoal(e.target.value)} />
        </Field>

        <div>
          <div className="lbl" style={{ marginBottom: 6 }}>
            {isAr ? 'الأهداف — ما الذي تخدمه الحملة' : 'Goals — what the campaign serves'}
          </div>
          <GoalMultiSelect value={goalIds} onChange={setGoalIds} isAr={isAr} />
        </div>

        {/* The «المسؤول» dropdown that sat beside this went on 2026-09-15 —
            see the wizard above. The campaign keeps whatever `owner_role` it
            already had; it is simply not asked again. */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 13 }}>
          <Field label={isAr ? 'المشروع' : 'Project'} hint={isAr ? 'اختياري · متعدد' : 'optional · multiple'}>
            <ProjectMultiSelect projects={projects} value={projectIds} onChange={setProjectIds} isAr={isAr} />
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

        <SuccessMeasuresEditor measures={measures} onChange={setMeasures} isAr={isAr} />

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
      </Modal>

      {closeConfirm && (
        <Modal
          title={isAr ? 'تجاهل التغييرات؟' : 'Discard changes?'}
          sub={isAr ? 'لديك تغييرات غير محفوظة في هذه الحملة.' : 'You have unsaved changes on this campaign.'}
          onClose={() => setCloseConfirm(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setCloseConfirm(false)}>
                {isAr ? 'متابعة التحرير' : 'Keep editing'}
              </button>
              <button type="button" className="btn btn-d" onClick={() => { setCloseConfirm(false); onClose(); }}>
                {isAr ? 'تجاهل وإغلاق' : 'Discard & close'}
              </button>
            </>
          }
        >
          <div style={{ fontSize: 13, color: 'var(--mute)', lineHeight: 1.9 }}>
            {isAr ? 'سيُفقد ما لم يُحفظ إن أغلقت الآن.' : 'Anything unsaved will be lost if you close now.'}
          </div>
        </Modal>
      )}
    </>
  );
}
