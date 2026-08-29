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
  PLATFORM_LABELS, ROLE_LABELS,
  createContent, deleteCampaigns, fetchCampaigns, fetchGoals,
  saveAdCreative, saveCampaign, saveCampaignTree, saveExecution, successMeasureSuffix,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Pill, Skeleton, Stat, Tone } from './components/kit';
import { IconCampaigns, IconMetrics, IconPlus } from './components/icons';
import ProjectMultiSelect from './components/ProjectMultiSelect';
import GoalMultiSelect from './components/GoalMultiSelect';
import CampaignExecutionsBuilder, {
  ExecDraft, execDraftComplete, execPlanBudget,
} from './components/CampaignExecutionsBuilder';
import CampaignContentBuilder, { type ContentDraft } from './components/CampaignContentBuilder';
import SuccessMeasuresEditor, {
  MeasureDraft, measuresToDrafts, draftsToMeasures, hasMeasureTarget,
} from './components/SuccessMeasuresEditor';
import { money, num, shortDate, whole } from './lib/format';
import { measureActual, pickMainMeasure } from './lib/measure';
import { campaignAutoName, executionAutoName } from './lib/autoName';
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
                        <th className="num" style={{ width: 82 }}>{isAr ? 'التكلفة' : 'Cost'}</th>
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
                        const cpl = !organic && !planning && spend > 0 && leads > 0
                          ? Math.round(spend / leads)
                          : null;
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
                            <td className="num">{num(c.content_count, isAr)}</td>
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

export function CampaignModal({
  campaign, isAr, onClose, onSaved,
}: {
  campaign?: MosCampaign | null;
  isAr: boolean;
  onClose: () => void;
  onSaved: (campaign: MosCampaign) => void;
}) {
  const { projects, projectName, contentTypes } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const isNew = !campaign;

  const [kind, setKind] = useState<MosCampaign['kind']>(campaign?.kind ?? 'paid');
  const [goal, setGoal] = useState(campaign?.goal ?? campaign?.name ?? '');
  const [goalIds, setGoalIds] = useState<string[]>(campaign?.goal_ids ?? []);
  const [projectIds, setProjectIds] = useState<string[]>(campaign?.project_ids ?? []);
  // The campaign's identity — auto-generated from type + goals + projects + date,
  // but fully editable. A blank name on a NEW campaign follows the live values
  // (see the sync effect); on edit it starts from the saved name and is left
  // alone. `nameEdited` flips once a human types or the record is an edit, so the
  // auto-sync never clobbers a hand-picked name.
  const [name, setName] = useState(campaign?.name ?? '');
  const [nameEdited, setNameEdited] = useState(!isNew);
  // Goals loaded by GoalMultiSelect — kept here to resolve id → name for the
  // auto-generated campaign name.
  const [goalsList, setGoalsList] = useState<MosGoal[]>([]);
  // Bulk content planned alongside a NEW campaign (created on save; empty for edit).
  const [drafts, setDrafts] = useState<ContentDraft[]>([]);
  const [ownerRole, setOwnerRole] = useState<string>(campaign?.owner_role ?? 'marketing_manager');
  const [startsOn, setStartsOn] = useState(campaign?.starts_on ?? '');
  const [endsOn, setEndsOn] = useState(campaign?.ends_on ?? '');
  const [budget, setBudget] = useState(campaign?.budget_total?.toString() ?? '');
  const [measures, setMeasures] = useState<MeasureDraft[]>(() => measuresToDrafts(campaign?.success_measures));
  const [status, setStatus] = useState<MosCampaign['status']>(campaign?.status ?? 'planning');
  // Paid + new: fully-configured executions (plan → ad sets → ads) that must be
  // complete before the parent can be created. Each execution can be saved as /
  // started from a TEMPLATE (see CampaignExecutionsBuilder).
  const [execDrafts, setExecDrafts] = useState<ExecDraft[]>([]);
  const [busy, setBusy] = useState(false);
  // In-app (not window.confirm) discard-guard for a dirty close.
  const [closeConfirm, setCloseConfirm] = useState(false);

  // Snapshot of the form's opening state, so a stray click on the backdrop (or
  // Escape) can't silently throw away work in progress. Compared field-by-field
  // below; the drafts/executions arrays start empty, so any planned content or
  // ad campaign already counts as dirty.
  const initial = useRef({
    kind: campaign?.kind ?? 'paid',
    name: campaign?.name ?? '',
    goal: campaign?.goal ?? campaign?.name ?? '',
    goalIds: JSON.stringify(campaign?.goal_ids ?? []),
    projectIds: JSON.stringify(campaign?.project_ids ?? []),
    ownerRole: campaign?.owner_role ?? 'marketing_manager',
    startsOn: campaign?.starts_on ?? '',
    endsOn: campaign?.ends_on ?? '',
    budget: campaign?.budget_total?.toString() ?? '',
    status: campaign?.status ?? 'planning',
    measures: JSON.stringify(measuresToDrafts(campaign?.success_measures)),
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
    || JSON.stringify(measures) !== initial.measures
    || drafts.length > 0
    || execDrafts.length > 0;

  // The auto-generated name from the current type + goals + projects + today.
  // Goal / project labels resolve from the loaded goals list + the workspace's
  // projectName; missing labels are simply dropped from the name.
  const goalLabels = useMemo(
    () => goalIds.map((id) => goalsList.find((g) => g.id === id)?.name ?? '').filter(Boolean),
    [goalIds, goalsList],
  );
  const projectLabels = useMemo(
    () => projectIds.map((id) => projectName(id)).filter(Boolean),
    [projectIds, projectName],
  );
  const computedName = useMemo(
    () => campaignAutoName({ kind, goalLabels, projectLabels, date: new Date(), isAr }),
    [kind, goalLabels, projectLabels, isAr],
  );

  // Keep the name in step with the live values until a human takes it over. The
  // date is captured once per mount (a re-render must not bump it), so only the
  // type / goals / projects drive the refresh here.
  useEffect(() => {
    if (!nameEdited) setName(computedName);
    // computedName already folds in kind/goals/projects; nameEdited gates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, goalLabels.join('|'), projectLabels.join('|'), nameEdited]);

  // Guarded close: while saving, ignore the request entirely; with unsaved
  // changes, confirm before discarding. Wired to the backdrop click, Escape, the
  // header ✕, and the Cancel button — so "click outside" can no longer wipe the
  // form without a deliberate confirmation. Matches SettingsWorkflows' pattern.
  const requestClose = useCallback((): void => {
    if (busy) return;
    // In-app confirm (dark, themed) instead of the browser's «app.wassel.re says»
    // dialog. Clean close when there is nothing unsaved.
    if (dirty) { setCloseConfirm(true); return; }
    onClose();
  }, [busy, dirty, onClose]);


  const totalBudget = budget.trim() === '' ? null : Number(budget);
  // Create is gated for a new paid campaign: at least one execution, and every
  // execution fully configured.
  const execGateOk = kind !== 'paid' || !isNew
    || (execDrafts.length > 0 && execDrafts.every(execDraftComplete));

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      addToast(
        isAr ? 'الحملة تحتاج اسمًا — وّلده تلقائيًا أو اكتبه.' : 'The campaign needs a name — auto-generate one or type it.',
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
    // A new paid campaign must ship with at least one FULLY-configured execution
    // (platform plan → ad set → ad). The button is already disabled, but guard.
    if (isNew && kind === 'paid' && !execGateOk) {
      addToast(
        isAr ? 'أضف حملة إعلانية واحدة على الأقل واملأ إعداداتها (المنصة، المجموعة، الإعلان).'
          : 'Add at least one ad campaign and fill its settings (platform, ad set, ad).',
        'error',
      );
      return;
    }
    setBusy(true);
    try {
      const res = await saveCampaign(
        {
          id: campaign?.id,
          // The name is the campaign's identity (auto-generated, editable); the
          // goal is now a separate human-readable description.
          name: name.trim(),
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
        // Executions are now created richly below (plan + ad sets + ads), not as
        // lite platform rows here.
        undefined,
      );

      // Paid + new: create each configured execution, then its ad-set/ad tree,
      // so ONE Create writes the whole campaign → executions → ad sets → ads.
      // A failure on one execution is surfaced but never rolls back the campaign.
      let execOk = 0;
      let execFail = 0;
      const createdExecIds: string[] = [];
      if (isNew && kind === 'paid' && res.item?.id) {
        for (const d of execDrafts) {
          try {
            const platformLabel = (isAr ? PLATFORM_LABELS[d.platform]?.ar : PLATFORM_LABELS[d.platform]?.en) ?? d.platform;
            const execRes = await saveExecution(res.item.id, {
              platform: d.platform,
              // Lineage label: «Paid ad campaign Meta - {campaign name}».
              label: executionAutoName({ platformLabel, parentName: name.trim(), isAr }),
              status: 'draft',
              budget: execPlanBudget(d),
              platform_settings: d.settings,
            });
            const execId = execRes.saved_id;
            if (execId) {
              createdExecIds.push(execId);
              await saveCampaignTree({
                execution_id: execId,
                ad_sets: d.adSets.map((s, i) => ({
                  name: s.name.trim(),
                  sort_order: i,
                  ads: s.ads.map((a) => {
                    const cap = a.caption.trim();
                    const assetKeys = a.asset
                      ? {
                          asset_id: a.asset.id,
                          asset_title: a.asset.title,
                          ...(a.asset.url ? { asset_url: a.asset.url } : {}),
                          ...(a.asset.thumb ? { asset_thumb: a.asset.thumb } : {}),
                        }
                      : {};
                    const merged = { ...(cap ? { message: cap } : {}), ...assetKeys };
                    return {
                      label: a.label.trim(),
                      content_id: a.contentId || null,
                      status: 'waiting',
                      ...(Object.keys(merged).length > 0 ? { creative: merged } : {}),
                    };
                  }),
                })),
              });
            }
            execOk += 1;
          } catch (err) {
            execFail += 1;
            console.error('[mos] execution create failed', err);
          }
        }
        if (execFail > 0) {
          addToast(
            isAr ? `تعذّر إنشاء ${num(execFail, true)} حملة إعلانية — أكملها من صفحة الحملة.`
              : `${execFail} ad campaign(s) failed — finish them from the campaign page.`,
            'error',
          );
        }
      }
      // Bulk content: create each planned piece linked to the just-created
      // campaign, so ONE save spins up the campaign AND its production line.
      // Mirrors the single-create path — content_create opens the first task.
      // A paid campaign's executions are AD channels («إعلانات ميتا»), not
      // organic feeds, so each piece gets a PAID placement (an mos_execution_ads
      // row) on every created execution — never a draft publication, which
      // would land an ad channel in the Placements tab's organic section.
      // A failure on one piece is surfaced but never rolls back the campaign
      // or its siblings.
      let contentOk = 0;
      let contentFail = 0;
      if (isNew && res.item?.id && drafts.length > 0) {
        for (const d of drafts) {
          try {
            const cres = await createContent({
              title: d.title.trim(),
              content_type_key: d.typeKey,
              project_ids: projectIds,
              campaign_id: res.item.id,
              // `purpose` is derived from placements now — not set here.
              // Notes land in the content's data.notes — the field the «الموجز» shows.
              data: { notes: d.notes.trim() || null },
            });
            const cid = cres.item?.id;
            if (cid) {
              for (const execId of createdExecIds) {
                await saveAdCreative(cid, { executionId: execId }, {});
              }
            }
            contentOk += 1;
          } catch (err) {
            contentFail += 1;
            console.error('[mos] bulk content create failed', err);
          }
        }
      }

      if (isNew) {
        const clauses: string[] = [];
        if (execOk > 0) clauses.push(isAr ? `${num(execOk, true)} حملات إعلانية` : `${execOk} ad campaigns`);
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
    <>
    <Modal
      title={isNew ? (isAr ? 'حملة جديدة' : 'New campaign') : (isAr ? 'تعديل الحملة' : 'Edit campaign')}
      sub={isAr
        ? 'هدف، ومدة، والمنصات التي ستعمل عليها. تُنشأ الحملات الإعلانية كمسودات.'
        : 'A goal, a duration, and the platforms it runs on. Ad campaigns are created as drafts.'}
      onClose={requestClose}
      footer={
        <>
          <span className="note">
            {isNew && kind === 'paid' && !execGateOk
              ? (isAr
                  ? 'أكمل إعدادات كل حملة إعلانية (المنصة، المجموعة، الإعلان) لتفعيل الإنشاء.'
                  : 'Finish every ad campaign’s settings (platform, ad set, ad) to enable Create.')
              : isAr
                ? 'لا شيء ينفق مالًا هنا. الحملات الإعلانية مسودات حتى يطلقها أحد على المنصة نفسها.'
                : 'Nothing here spends money. Ad campaigns stay drafts until someone launches them on the platform itself.'}
          </span>
          <button type="button" className="btn" onClick={requestClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy || !execGateOk}>
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
          autoFocus={isNew}
          placeholder={computedName}
        />
        <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 5 }}>
          {isAr
            ? 'يُولَّد تلقائيًا من النوع والأهداف والمشروع والتاريخ، ويمكنك تعديله. تُسمّى الحملات الإعلانية ومجموعاتها وإعلاناتها تلقائيًا تبعًا له.'
            : 'Auto-generated from type, goals, project and date — editable. Ad campaigns, ad sets and ads are named automatically from it.'}
        </div>
      </div>

      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>
          {isAr ? 'الوصف — اختياري' : 'Description — optional'}
        </div>
        <input
          className="inp"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder={isAr ? 'حملة مينا ٥٢ لعملاء أغسطس' : 'Mina 52 campaign for August leads'}
        />
        <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 5 }}>
          {isAr
            ? 'وصف حر يقرأه البشر. الأرقام والحكم على النجاح يأتيان من معايير النجاح أدناه.'
            : 'A free-text, human-readable note. The numbers and the success verdict come from the success measures below.'}
        </div>
      </div>

      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>
          {isAr ? 'الأهداف — ما الذي تخدمه الحملة' : 'Goals — what the campaign serves'}
        </div>
        <GoalMultiSelect value={goalIds} onChange={setGoalIds} isAr={isAr} onLoaded={setGoalsList} />
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
        <CampaignExecutionsBuilder drafts={execDrafts} onChange={setExecDrafts} isAr={isAr} campaignName={name} />
      )}

      <SuccessMeasuresEditor measures={measures} onChange={setMeasures} isAr={isAr} />

      {isNew && (
        <CampaignContentBuilder
          isAr={isAr}
          contentTypes={contentTypes}
          drafts={drafts}
          onChange={setDrafts}
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
          {kind === 'paid' && isNew && execDrafts.length > 0 && (
            <>
              {isAr
                ? `، و${num(execDrafts.length, true)} حملات إعلانية بمجموعاتها وإعلاناتها`
                : `, and ${execDrafts.length} ad campaigns with their ad sets & ads`}
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
