/**
 * Campaign detail — design screens 15 (نظرة عامة), 20 (الحملات الإعلانية),
 * 39 (المحتوى), 40 (النتائج), plus the ملاحظات thread.
 *
 * Four levels on one screen: the goal, the platform executions under it, the
 * content each execution uses, and the result. «حملة» stops meaning three
 * different things — the campaign IS the goal; what runs on Meta is an
 * execution under it.
 *
 * Every sentence in «ماذا تقول الأرقام», the pace verdicts, the reallocation
 * banner and the results-gap verdict is GENERATED deterministically from the
 * on-screen numbers — no LLM, no randomness. Each rule's trigger condition is
 * transcribed from the mockups' own examples.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Bar, BarChart, Cell, ReferenceLine, ResponsiveContainer, XAxis, YAxis,
} from 'recharts';
import { useAppStore } from '@/stores/appStore';
import {
  CAMPAIGN_STATUS_LABELS, EXEC_STATUS_LABELS, MosAd, MosCampaign, MosCampaignEvent,
  MosCampaignOutcomes, MosComment, MosContentRow, MosDailyEntry, MosExecution,
  MosGoal, MosPublication,
  PLATFORM_LABELS, ROLE_LABELS, SUCCESS_METRIC_LABELS, successMeasureSuffix,
  addCampaignEvent, budgetShift, deleteExecution, fetchCampaignDetail,
  fetchCampaignEvents, fetchCampaignOutcomes, fetchContentDetail, fetchContentList,
  fetchExecutionDetail, fetchPublications, saveCampaign, saveExecution, signCampaign,
  updateContent,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import {
  PlatformSettings, defaultPlatformSettings, getPlatformSchema, objectiveKeyOf, settingsSummary,
} from '@/lib/marketingOS/adPlatforms';
import { Field, LoadError, Modal, Pill, ReadField, Skeleton, StatusPill, Tone } from './components/kit';
import CommentThread from './components/CommentThread';
import NewContentModal from './components/NewContentModal';
import SuccessMeasuresEditor, {
  MeasureDraft, measuresToDrafts, draftsToMeasures,
} from './components/SuccessMeasuresEditor';
import AudiencePicker from './components/AudiencePicker';
import GoalMultiSelect from './components/GoalMultiSelect';
import ProjectLink from './components/ProjectLink';
import { IconBack, IconForward } from './components/icons';
import { money, monthOf, num, shortDate, whole } from './lib/format';
import { measureActual, pickVolumeMeasure } from './lib/measure';
import './styles/campaign-detail.css';

type Tab = 'overview' | 'executions' | 'content' | 'results' | 'notes';

/** The mockups' platform colour squares (s15 table, s20 card headers). */
export const PLATFORM_DOT: Record<string, string> = {
  meta: '#C13584',
  instagram: '#C13584',
  tiktok: 'var(--ink)',
  x: 'var(--ink)',
  google: '#4285F4',
  snapchat: '#C8B400',
  youtube: '#B8342A',
  whatsapp: '#2E7D4F',
  website: 'var(--copper)',
};

/**
 * What an execution's ad set is FOR — the `purpose` column's display labels
 * (s15: «نموذج عملاء», «زيارات», «وصول»). Keys are the API's enum.
 */
export const PURPOSE_PILL_LABELS: Record<string, { ar: string; en: string }> = {
  conversion:  { ar: 'نموذج عملاء',     en: 'Lead form' },
  traffic:     { ar: 'زيارات',          en: 'Traffic' },
  awareness:   { ar: 'وصول',            en: 'Reach' },
  retargeting: { ar: 'إعادة استهداف',   en: 'Retargeting' },
};

const PLATFORMS = ['meta', 'tiktok', 'google', 'snapchat', 'instagram', 'x', 'youtube'] as const;

const DAY_MS = 86_400_000;

/** Elapsed / total / remaining days of the campaign window. */
function campaignDays(c: MosCampaign): { total: number; elapsed: number; left: number } | null {
  if (!c.starts_on || !c.ends_on) return null;
  const start = new Date(c.starts_on).getTime();
  const end = new Date(c.ends_on).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const total = Math.round((end - start) / DAY_MS) + 1;
  const elapsed = Math.max(0, Math.min(total, Math.floor((Date.now() - start) / DAY_MS) + 1));
  return { total, elapsed, left: total - elapsed };
}

/** Sources whose target is a cumulative volume the pace/gap chart can track
 *  (a higher-is-better count). Cost/rate measures are judged on their own line. */
/** «٣٨٪» / "38%". */
function pctStr(v: number, isAr: boolean): string {
  return isAr ? `${num(Math.round(v), true)}٪` : `${Math.round(v)}%`;
}

/** «٢.١ مليون ريال» over a million; plain money below it. */
function compactMoney(v: number | null | undefined, isAr: boolean): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1_000_000) {
    const m = Math.round(v / 100_000) / 10;
    return isAr ? `${num(m, true)} مليون ريال` : `${num(m, false)}M SAR`;
  }
  return money(v, isAr);
}

/** «٤ إعلانات» / «إعلان واحد» — the s20 card-count tag. */
function adsCountLabel(n: number, isAr: boolean): string {
  if (!isAr) return n === 1 ? '1 ad' : `${n} ads`;
  if (n === 0) return 'بلا إعلانات';
  if (n === 1) return 'إعلان واحد';
  if (n === 2) return 'إعلانان';
  if (n <= 10) return `${num(n, true)} إعلانات`;
  return `${num(n, true)} إعلانًا`;
}

/** «٩ عناصر مرتبطة» — the s39 header tag. */
function linkedItemsLabel(n: number, isAr: boolean): string {
  if (!isAr) return n === 1 ? '1 linked item' : `${n} linked items`;
  if (n === 1) return 'عنصر واحد مرتبط';
  if (n === 2) return 'عنصران مرتبطان';
  if (n <= 10) return `${num(n, true)} عناصر مرتبطة`;
  return `${num(n, true)} عنصرًا مرتبطًا`;
}

/** «٢ ما زالا في الإنتاج» — the s39 header pill. */
function inProductionLabel(n: number, isAr: boolean): string {
  if (!isAr) return n === 1 ? '1 still in production' : `${n} still in production`;
  if (n === 1) return 'واحد ما زال في الإنتاج';
  if (n === 2) return '٢ ما زالا في الإنتاج';
  return `${num(n, true)} ما زالت في الإنتاج`;
}

/** Whole days since an ISO stamp — «منذ ٤ أيام». */
function sinceLabel(iso: string | null | undefined, isAr: boolean): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const n = Math.max(0, Math.round((Date.now() - t) / DAY_MS));
  if (isAr) {
    if (n === 0) return 'منذ اليوم';
    if (n === 1) return 'منذ يوم';
    if (n === 2) return 'منذ يومين';
    if (n <= 10) return `منذ ${num(n, true)} أيام`;
    return `منذ ${num(n, true)} يومًا`;
  }
  return n === 0 ? 'today' : `${n} day${n === 1 ? '' : 's'} ago`;
}

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Per-execution derived numbers — the s20 card and the s15 table share them. */
interface ExecStat {
  exec: MosExecution;
  cpq: number | null;
  spendPct: number | null;
  adsCount: number;
  /** cpq ≥ 2× the best measured cpq — the mockup's red-card criterion. */
  weak: boolean;
  /** Spent money, produced zero qualified — the dimmed «بلا مؤهلين» card. */
  noQual: boolean;
  isBestCpq: boolean;
  isMaxQualified: boolean;
}

/**
 * Per-content rollups. For a PAID campaign these are summed from every ad
 * campaign the item runs in (spend/leads/qualified). For an ORGANIC campaign
 * the item earns reach, not spend, so the numbers come from the item's
 * publications instead (impressions/engagement/enquiries — the same readings
 * the Numbers screen captures per publication).
 */
interface ContentStat {
  row: MosContentRow;
  platforms: string[];
  spend: number | null;
  leads: number | null;
  qualified: number | null;
  cpq: number | null;
  /** Organic-only: summed from the item's published publications. */
  impressions: number | null;
  engagement: number | null;
  enquiries: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  watch: boolean;
  wrongProject: boolean;
  waiting: boolean;
}

export default function CampaignDetailPage() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const navigate = useNavigate();
  const { isAr, can, people, typeLabel, contentTypes } = useWorkspace();
  const users = people.map((p) => ({ id: p.user_id, name_ar: p.name_ar, name_en: p.name_en }));
  const addToast = useAppStore((s) => s.addToast);

  const [item, setItem] = useState<MosCampaign | null>(null);
  const [executions, setExecutions] = useState<MosExecution[]>([]);
  const [content, setContent] = useState<MosContentRow[]>([]);
  const [comments, setComments] = useState<MosComment[]>([]);
  const [events, setEvents] = useState<MosCampaignEvent[]>([]);
  const [goals, setGoals] = useState<MosGoal[]>([]);
  const [outcomes, setOutcomes] = useState<MosCampaignOutcomes | null>(null);
  const [outcomesError, setOutcomesError] = useState<string | null>(null);
  const [adsByExec, setAdsByExec] = useState<Record<string, MosAd[]>>({});
  const [dailyByExec, setDailyByExec] = useState<Record<string, MosDailyEntry[]>>({});
  const [pubsByContent, setPubsByContent] = useState<Record<string, MosPublication[]>>({});
  const [pubError, setPubError] = useState<string | null>(null);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [angles, setAngles] = useState<Record<string, string | null> | null>(null);
  const [anglesError, setAnglesError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [platFilter, setPlatFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [briefEditing, setBriefEditing] = useState(false);
  const [execEditing, setExecEditing] = useState<MosExecution | null>(null);
  const [execAdding, setExecAdding] = useState(false);
  const [addingContent, setAddingContent] = useState(false);
  const [linking, setLinking] = useState(false);
  const [shift, setShift] = useState<{ from: string; to: string; amount: number | null } | null>(null);
  const [pickDaily, setPickDaily] = useState(false);
  const [busy, setBusy] = useState(false);

  /** The ads + daily entries live one layer down — fan out per execution. */
  const enrich = useCallback(async (execs: MosExecution[]): Promise<void> => {
    setEnrichError(null);
    const ads: Record<string, MosAd[]> = {};
    const daily: Record<string, MosDailyEntry[]> = {};
    const failed: string[] = [];
    await Promise.all(execs.map(async (x) => {
      try {
        const res = await fetchExecutionDetail(x.id);
        ads[x.id] = res.ads;
        daily[x.id] = res.daily;
      } catch (e) {
        // Partial failure degrades VISIBLY: the notice below names the rows
        // whose ads are missing, and the retry re-runs the whole fan-out.
        console.error(`[marketing] execution enrich failed for ${x.id}`, e);
        failed.push(x.label ?? x.platform);
      }
    }));
    setAdsByExec(ads);
    setDailyByExec(daily);
    if (failed.length > 0) setEnrichError(failed.join(isAr ? '، ' : ', '));
  }, [isAr]);

  /**
   * Organic campaigns have no ad campaigns — their numbers live on each linked
   * item's publications. Fan out per content and keep the latest reading per
   * publication (mirrors the paid `enrich` fan-out over executions).
   */
  const enrichOrganic = useCallback(async (rows: MosContentRow[]): Promise<void> => {
    setPubError(null);
    const map: Record<string, MosPublication[]> = {};
    const failed: string[] = [];
    await Promise.all(rows.map(async (r) => {
      try {
        map[r.id] = (await fetchPublications(r.id)).publications;
      } catch (e) {
        // Partial failure degrades VISIBLY: the notice names the items whose
        // numbers are missing, and the retry re-runs the whole fan-out.
        console.error(`[marketing] organic publications enrich failed for ${r.id}`, e);
        failed.push(r.ref ?? r.title);
      }
    }));
    setPubsByContent(map);
    if (failed.length > 0) setPubError(failed.join(isAr ? '، ' : ', '));
  }, [isAr]);

  const load = useCallback(async (): Promise<void> => {
    if (!campaignId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchCampaignDetail(campaignId);
      setItem(res.item);
      setExecutions(res.executions);
      setContent(res.content);
      setComments(res.comments);
      setEvents(res.events);
      setGoals(res.goals);
      setAngles(null);
      setAnglesError(null);
      if (res.item.kind === 'organic') {
        setAdsByExec({});
        setDailyByExec({});
        void enrichOrganic(res.content);
      } else {
        setPubsByContent({});
        void enrich(res.executions);
      }
      void (async () => {
        try {
          const o = await fetchCampaignOutcomes(campaignId);
          setOutcomes(o.outcomes);
          setOutcomesError(null);
        } catch (e) {
          // «ما بعد الإعلان» shows the failure inside its own card.
          console.error('[marketing] campaign outcomes unavailable', e);
          setOutcomesError(e instanceof Error ? e.message : String(e));
        }
      })();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [campaignId, enrich, enrichOrganic]);

  useEffect(() => { void load(); }, [load]);

  /** The «ما الذي تغيّر» ledger, re-read after any action that appends to it. */
  const refreshEvents = useCallback(async (): Promise<void> => {
    if (!campaignId) return;
    try {
      setEvents((await fetchCampaignEvents(campaignId)).events);
    } catch (e) {
      console.error('[marketing] campaign events refresh failed', e);
      addToast(
        isAr ? 'تعذّر تحديث سجل «ما الذي تغيّر».' : 'Could not refresh the change ledger.',
        'error',
      );
    }
  }, [campaignId, addToast, isAr]);

  /** The coverage card needs each item's angle — fetched lazily, once. */
  useEffect(() => {
    if (tab !== 'content' || angles !== null || content.length === 0) return;
    let cancelled = false;
    void (async () => {
      const map: Record<string, string | null> = {};
      try {
        await Promise.all(content.map(async (c) => {
          const d = await fetchContentDetail(c.id);
          map[c.id] = d.item.angle ?? null;
        }));
        if (!cancelled) setAngles(map);
      } catch (e) {
        // The card degrades to its angle-free rules and SAYS so.
        console.error('[marketing] content angles unavailable', e);
        if (!cancelled) {
          setAngles({});
          setAnglesError(isAr ? 'تعذّر تحميل زوايا المحتوى.' : 'Content angles could not load.');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [tab, angles, content, isAr]);

  const days = useMemo(() => (item ? campaignDays(item) : null), [item]);
  const primaryMeasure = useMemo(() => (item ? pickVolumeMeasure(item) : null), [item]);
  const target = primaryMeasure?.threshold ?? null;

  const execStats = useMemo<ExecStat[]>(() => {
    const base: ExecStat[] = executions.map((exec) => ({
      exec,
      cpq: exec.spend !== null && exec.qualified !== null && exec.qualified > 0
        ? exec.spend / exec.qualified
        : null,
      spendPct: exec.budget !== null && exec.budget > 0 && exec.spend !== null
        ? (exec.spend / exec.budget) * 100
        : null,
      adsCount: (adsByExec[exec.id] ?? []).length,
      weak: false,
      noQual: (exec.spend ?? 0) > 0 && exec.qualified === 0,
      isBestCpq: false,
      isMaxQualified: false,
    }));
    const measured = base.filter((s) => s.cpq !== null);
    if (measured.length > 0) {
      const best = measured.reduce((a, b) => ((a.cpq ?? 0) <= (b.cpq ?? 0) ? a : b));
      if (measured.length > 1) best.isBestCpq = true;
      for (const s of measured) {
        if (s !== best && (s.cpq ?? 0) >= 2 * (best.cpq ?? 0)) s.weak = true;
      }
    }
    const withQual = base.filter((s) => (s.exec.qualified ?? 0) > 0);
    if (withQual.length > 1) {
      withQual.reduce((a, b) => ((a.exec.qualified ?? 0) >= (b.exec.qualified ?? 0) ? a : b))
        .isMaxQualified = true;
    }
    return base;
  }, [executions, adsByExec]);

  const bestStat = useMemo<ExecStat | null>(() => {
    const m = execStats.filter((s) => s.cpq !== null);
    return m.length === 0 ? null : m.reduce((a, b) => ((a.cpq ?? 0) <= (b.cpq ?? 0) ? a : b));
  }, [execStats]);

  const weakStat = useMemo<ExecStat | null>(() => {
    const w = execStats.filter((s) => s.weak);
    return w.length === 0 ? null : w.reduce((a, b) => ((a.cpq ?? 0) >= (b.cpq ?? 0) ? a : b));
  }, [execStats]);

  /** s20's banner: what moving the weak row's remainder would buy. */
  const realloc = useMemo(() => {
    if (!weakStat || !bestStat || weakStat.cpq === null || bestStat.cpq === null) return null;
    const remaining = (weakStat.exec.budget ?? 0) - (weakStat.exec.spend ?? 0);
    if (remaining <= 0) return null;
    return {
      remaining,
      gainTo: Math.round(remaining / bestStat.cpq),
      gainStay: Math.round(remaining / weakStat.cpq),
    };
  }, [weakStat, bestStat]);

  const contentStats = useMemo<ContentStat[]>(() => {
    const add = (s: number | null, v: number | null): number | null =>
      (v === null ? s : (s ?? 0) + v);
    const organic = item?.kind === 'organic';
    return content.map((row) => {
      const wrongProject = Boolean(
        row.project_id && item?.project_id && row.project_id !== item.project_id,
      );

      // ── Organic: reach from the item's own publications, not ad spend. ──
      if (organic) {
        const published = (pubsByContent[row.id] ?? []).filter((p) => p.status === 'published');
        let impressions: number | null = null;
        let engagement: number | null = null;
        let enquiries: number | null = null;
        let likes: number | null = null;
        let comments: number | null = null;
        let saves: number | null = null;
        for (const p of published) {
          impressions = add(impressions, p.latest_views);
          engagement = add(engagement, p.latest_engagement);
          enquiries = add(enquiries, p.latest_enquiries);
          likes = add(likes, p.latest_likes);
          comments = add(comments, p.latest_comments);
          saves = add(saves, p.latest_saves);
        }
        const uniq = Array.from(new Set(published.map((p) => p.platform)));
        return {
          row,
          platforms: uniq,
          spend: null,
          leads: null,
          qualified: null,
          cpq: null,
          impressions,
          engagement,
          enquiries,
          likes,
          comments,
          saves,
          watch: false,
          wrongProject,
          // Nothing is published yet — the piece is still in production.
          waiting: uniq.length === 0,
        };
      }

      // ── Paid: summed from every ad campaign the item runs in. ──
      const platforms: string[] = [];
      let spend: number | null = null;
      let leads: number | null = null;
      let qualified: number | null = null;
      let watch = false;
      for (const x of executions) {
        const ads = adsByExec[x.id] ?? [];
        const mine = ads.filter((a) => a.content_id === row.id);
        const viaExec = x.content_id === row.id;
        if (mine.length > 0 || viaExec) platforms.push(x.platform);
        for (const a of mine) {
          spend = add(spend, a.spend);
          leads = add(leads, a.leads);
          qualified = add(qualified, a.qualified);
          if (a.status === 'watch') watch = true;
        }
        // Envelope-level executions (no ads yet) still attribute their numbers.
        if (viaExec && ads.length === 0) {
          spend = add(spend, x.spend);
          leads = add(leads, x.leads);
          qualified = add(qualified, x.qualified);
        }
      }
      const uniq = Array.from(new Set(platforms));
      return {
        row,
        platforms: uniq,
        spend,
        leads,
        qualified,
        cpq: spend !== null && qualified !== null && qualified > 0 ? spend / qualified : null,
        impressions: null,
        engagement: null,
        enquiries: null,
        likes: null,
        comments: null,
        saves: null,
        watch,
        wrongProject,
        waiting: uniq.length === 0,
      };
    });
  }, [content, executions, adsByExec, pubsByContent, item]);

  /**
   * «الأفضل أداءً» — computed, never assigned. Paid: most qualified, tie →
   * cheapest. Organic: most impressions, tie → most engagement.
   */
  const bestContentId = useMemo<string | null>(() => {
    if (item?.kind === 'organic') {
      const measured = contentStats.filter((s) => (s.impressions ?? 0) > 0);
      if (measured.length < 2) return null;
      const best = measured.reduce((a, b) => {
        if ((a.impressions ?? 0) !== (b.impressions ?? 0)) {
          return (a.impressions ?? 0) > (b.impressions ?? 0) ? a : b;
        }
        return (a.engagement ?? 0) >= (b.engagement ?? 0) ? a : b;
      });
      return best.row.id;
    }
    const measured = contentStats.filter((s) => (s.qualified ?? 0) > 0);
    if (measured.length < 2) return null;
    const best = measured.reduce((a, b) => {
      if ((a.qualified ?? 0) !== (b.qualified ?? 0)) {
        return (a.qualified ?? 0) > (b.qualified ?? 0) ? a : b;
      }
      return (a.cpq ?? Number.POSITIVE_INFINITY) <= (b.cpq ?? Number.POSITIVE_INFINITY) ? a : b;
    });
    return best.row.id;
  }, [contentStats, item]);

  /** Cumulative qualified per recorded day, across every execution (s40). */
  const cumulative = useMemo(() => {
    if (!item) return [];
    const byDay = new Map<string, number>();
    for (const x of executions) {
      for (const d of dailyByExec[x.id] ?? []) {
        byDay.set(d.day, (byDay.get(d.day) ?? 0) + (d.qualified ?? 0));
      }
    }
    const sorted = Array.from(byDay.keys()).sort();
    const start = item.starts_on ? new Date(item.starts_on).getTime() : null;
    let run = 0;
    return sorted.map((day) => {
      run += byDay.get(day) ?? 0;
      const t = new Date(day).getTime();
      const dayNo = start !== null && !Number.isNaN(t)
        ? Math.floor((t - start) / DAY_MS) + 1
        : new Date(day).getDate();
      return { label: num(dayNo, isAr), cum: run };
    });
  }, [item, executions, dailyByExec, isAr]);

  /** Weekly cost per qualified (s40's second chart). */
  const weekly = useMemo(() => {
    if (!item) return [];
    const start = item.starts_on ? new Date(item.starts_on).getTime() : null;
    const byWeek = new Map<number, { spend: number; qualified: number }>();
    for (const x of executions) {
      for (const d of dailyByExec[x.id] ?? []) {
        const t = new Date(d.day).getTime();
        if (Number.isNaN(t)) continue;
        const idx = start !== null
          ? Math.max(0, Math.floor((t - start) / (7 * DAY_MS)))
          : Math.floor(t / (7 * DAY_MS));
        const cur = byWeek.get(idx) ?? { spend: 0, qualified: 0 };
        cur.spend += d.spend ?? 0;
        cur.qualified += d.qualified ?? 0;
        byWeek.set(idx, cur);
      }
    }
    const rows = Array.from(byWeek.entries())
      .sort((a, b) => a[0] - b[0])
      .filter(([, w]) => w.qualified > 0 && w.spend > 0)
      .map(([, w]) => Math.round(w.spend / w.qualified));
    if (rows.length === 0) return [];
    const min = Math.min(...rows);
    return rows.map((v) => ({
      v,
      label: num(v, isAr),
      color: v / min < 1.5 ? 'var(--go)' : v / min < 1.8 ? 'var(--wait)' : 'var(--late)',
    }));
  }, [item, executions, dailyByExec, isAr]);

  const pname = useCallback(
    (platform: string): string =>
      (isAr ? PLATFORM_LABELS[platform]?.ar : PLATFORM_LABELS[platform]?.en) ?? platform,
    [isAr],
  );

  /* ── actions ─────────────────────────────────────────────────────── */

  const toggleCampaign = async (): Promise<void> => {
    if (!item) return;
    const next: MosCampaign['status'] = item.status === 'active' ? 'paused' : 'active';
    setBusy(true);
    try {
      const res = await saveCampaign({ id: item.id, status: next });
      setItem(res.item);
      addToast(
        next === 'paused'
          ? isAr ? 'أُوقفت الحملة مؤقتًا.' : 'Campaign paused.'
          : isAr ? 'استُؤنفت الحملة.' : 'Campaign resumed.',
        'success',
      );
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const pauseAll = async (): Promise<void> => {
    if (!item) return;
    const running = executions.filter((x) => x.status === 'running');
    if (running.length === 0) return;
    setBusy(true);
    try {
      let rows: MosExecution[] = executions;
      for (const x of running) {
        rows = (await saveExecution(item.id, { id: x.id, status: 'paused' })).executions;
      }
      setExecutions(rows);
      addToast(
        isAr ? `أُوقفت ${num(running.length, true)} من الحملات الإعلانية.` : `Paused ${running.length} ad campaigns.`,
        'success',
      );
      void refreshEvents();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const sign = async (): Promise<void> => {
    if (!item) return;
    setBusy(true);
    try {
      const res = await signCampaign(item.id);
      setItem(res.campaign);
      addToast(isAr ? 'وُقّعت ميزانية الحملة.' : 'Campaign budget signed.', 'success');
      void refreshEvents();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  /** «فك» — the link goes; the history and the ledger line stay. */
  const unlinkContent = async (row: MosContentRow): Promise<void> => {
    if (!item) return;
    try {
      await updateContent(row.id, { campaign_id: null });
      await addCampaignEvent(item.id, {
        kind: 'content_unlinked',
        summary_ar: `فُكّ ربط «${row.ref ?? row.title}» عن الحملة — أرقامه التاريخية محفوظة.`,
        summary_en: `Unlinked "${row.ref ?? row.title}" from the campaign — its history is kept.`,
        detail: { content_id: row.id },
      });
      setContent((cur) => cur.filter((c) => c.id !== row.id));
      addToast(
        isAr ? 'فُكّ الربط. المحتوى لم يُحذف ولم تُمسّ حملة أخرى.' : 'Unlinked. The content is not deleted; no other campaign is touched.',
        'success',
      );
      void refreshEvents();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const exportCsv = (): void => {
    if (!item) return;
    const rows: string[] = ['execution,platform,day,spend,leads,qualified'];
    for (const x of executions) {
      for (const d of dailyByExec[x.id] ?? []) {
        rows.push([
          csvCell(x.label ?? ''), x.platform, d.day,
          d.spend ?? '', d.leads ?? '', d.qualified ?? '',
        ].join(','));
      }
    }
    if (rows.length === 1) {
      addToast(isAr ? 'لا أرقام يومية للتصدير بعد.' : 'No daily numbers to export yet.', 'info');
      return;
    }
    // The BOM keeps Excel reading the Arabic labels as UTF-8.
    const blob = new Blob(['﻿', rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `campaign-${item.ref ?? item.id}-daily.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /* ── guards (all hooks are above this line) ──────────────────────── */

  if (loading && !item) return <div className="body"><Skeleton rows={6} /></div>;
  if (error && !item) {
    return <div className="body"><LoadError message={error} onRetry={() => void load()} isAr={isAr} /></div>;
  }
  if (!item) {
    return (
      <div className="body">
        <div className="notice">{isAr ? 'الحملة غير موجودة.' : 'That campaign does not exist.'}</div>
      </div>
    );
  }

  /* ── header derivations ──────────────────────────────────────────── */

  const Back = isAr ? IconForward : IconBack;
  const isOrganic = item.kind === 'organic';
  const spend = item.total_spend ?? null;
  const budget = item.budget_total ?? null;
  const qualified = item.total_qualified ?? 0;
  // A paid campaign is judged on qualified leads; an organic one on reach. The
  // organic total is summed from the linked content's publications, because the
  // campaign rollup (mos_campaign_v) only counts ad-campaign impressions, which
  // an organic campaign has none of.
  const organicImpressions = contentStats.reduce((s, c) => s + (c.impressions ?? 0), 0);
  // The goal's numbers come from the primary VOLUME measure — its target, its
  // label as the unit, and the actual it tracks. With no such measure the goal
  // is a pure description: we still show the campaign's headline count (reach for
  // organic, qualified for paid) but with no target line to compare against.
  const goalProgress = primaryMeasure
    ? (measureActual(primaryMeasure.source, item, organicImpressions, isOrganic) ?? 0)
    : (isOrganic ? organicImpressions : qualified);
  const goalUnitAr = primaryMeasure ? primaryMeasure.label_ar : (isOrganic ? 'مشاهدة' : 'مؤهلًا');
  const goalUnitEn = primaryMeasure ? primaryMeasure.label_en : (isOrganic ? 'views' : 'qualified');
  // Campaign-level reach for the organic «ما بعد النشر» card — summed from the
  // linked content's publications, NULL when nothing has been read yet (so an
  // unmeasured metric shows «—», not a misleading ٠).
  const sumOrNull = (vals: Array<number | null>): number | null => {
    let any = false;
    let sum = 0;
    for (const v of vals) if (v !== null) { any = true; sum += v; }
    return any ? sum : null;
  };
  const organicReach = {
    impressions: sumOrNull(contentStats.map((c) => c.impressions)),
    likes: sumOrNull(contentStats.map((c) => c.likes)),
    comments: sumOrNull(contentStats.map((c) => c.comments)),
    saves: sumOrNull(contentStats.map((c) => c.saves)),
    engagement: sumOrNull(contentStats.map((c) => c.engagement)),
    enquiries: sumOrNull(contentStats.map((c) => c.enquiries)),
  };
  const inProduction = content.filter((c) => c.status_key !== 'done').length;

  // The status shown reflects reality: live_status (derived from the executions'
  // real platform state) wins over the hand-set lifecycle, so a "planning"
  // campaign whose Meta ads are actually running reads as active.
  const effStatus = item.live_status ?? item.status;
  const statusPill = effStatus === 'active' && days
    ? {
        tone: 'now' as Tone,
        text: isAr
          ? `جارية · اليوم ${num(days.elapsed, true)} من ${num(days.total, true)}`
          : `Live · day ${days.elapsed} of ${days.total}`,
      }
    : {
        tone: (effStatus === 'active' ? 'now' : effStatus === 'done' ? 'live' : 'idle') as Tone,
        text: (isAr ? CAMPAIGN_STATUS_LABELS[effStatus]?.ar : CAMPAIGN_STATUS_LABELS[effStatus]?.en)
          ?? effStatus,
      };

  const crumbTail: Record<Tab, { ar: string; en: string } | null> = {
    overview: null,
    executions: { ar: 'الحملات الإعلانية', en: 'Ad campaigns' },
    content: { ar: 'المحتوى', en: 'Content' },
    results: { ar: 'النتائج', en: 'Results' },
    notes: { ar: 'ملاحظات', en: 'Notes' },
  };

  // Organic campaigns have no paid ad-platform buys, so the Ad campaigns tab, its
  // overview card, and the budget-shift control are all hidden for them — an
  // organic campaign runs through content, not ad campaigns. (`isOrganic` is
  // derived up in the header block, above the goal-progress math.)
  const allTabs: Array<{ key: Tab; ar: string; en: string; badge?: number }> = [
    { key: 'overview', ar: 'نظرة عامة', en: 'Overview' },
    { key: 'executions', ar: 'الحملات الإعلانية', en: 'Ad campaigns', badge: executions.length || undefined },
    { key: 'content', ar: 'المحتوى', en: 'Content', badge: content.length || undefined },
    { key: 'results', ar: 'النتائج', en: 'Results' },
    { key: 'notes', ar: 'ملاحظات', en: 'Notes' },
  ];
  const tabs = allTabs.filter((t) => !(isOrganic && t.key === 'executions'));

  // Every measure the campaign is judged by. Falls back to the legacy scalar
  // pair for any row created before the multi-measure column existed.
  const successMeasures = Array.isArray(item.success_measures) ? item.success_measures : [];
  const successText = successMeasures.length > 0
    ? successMeasures
        .map((m) => `${isAr ? m.label_ar : m.label_en} — ${
          m.threshold !== null ? num(m.threshold, isAr) : '—'} ${successMeasureSuffix(m.direction, m.unit, isAr)}`)
        .join(isAr ? '، ' : ', ')
    : item.success_metric && SUCCESS_METRIC_LABELS[item.success_metric]
      ? `${isAr
          ? SUCCESS_METRIC_LABELS[item.success_metric]?.ar
          : SUCCESS_METRIC_LABELS[item.success_metric]?.en} — ${
          item.success_threshold !== null ? num(item.success_threshold, isAr) : '—'} ${
          item.success_metric === 'leads' || item.success_metric === 'reach'
            ? isAr ? 'أو أكثر' : 'or more'
            : isAr ? 'ريال أو أقل' : 'SAR or less'}`
      : isAr ? 'غير محدد — لا يمكن الحكم على الحملة' : 'Not set — the campaign cannot be judged';

  /* «مقابل الهدف» pace math (s15) — `goalProgress` is qualified (paid) or reach (organic). */
  const targetPct = target !== null && target > 0 ? Math.min(100, (goalProgress / target) * 100) : null;
  const timePct = days && days.total > 0 ? (days.elapsed / days.total) * 100 : null;
  const projection = days && days.elapsed > 0
    ? Math.round((goalProgress / days.elapsed) * days.total)
    : null;
  const onPace = target !== null && projection !== null && projection >= target;

  /* s40 gap math. */
  const requiredToday = target !== null && days && days.total > 0
    ? Math.round((target * days.elapsed) / days.total)
    : null;
  const gap = requiredToday !== null ? requiredToday - goalProgress : null;
  const needDaily = target !== null && days && days.left > 0
    ? Math.round((target - goalProgress) / days.left)
    : null;
  const dailyRate = days && days.elapsed > 0
    ? Math.round((goalProgress / days.elapsed) * 10) / 10
    : null;

  /* «ماذا تقول الأرقام» — each sentence is a transcribed rule (s15). */
  const numberRules: JSX.Element[] = [];
  if (bestStat && bestStat.cpq !== null) {
    const budgets = execStats
      .map((s) => s.exec.budget)
      .filter((b): b is number => b !== null && b > 0);
    const smallestBudget = bestStat.exec.budget !== null && budgets.length > 1
      && bestStat.exec.budget === Math.min(...budgets);
    numberRules.push(
      <span key="best">
        {isAr
          ? `${pname(bestStat.exec.platform)} أرخص مؤهل عند ${num(Math.round(bestStat.cpq), true)} ريالًا${smallestBudget ? '، وميزانيته الأصغر' : ''}.`
          : `${pname(bestStat.exec.platform)} has the cheapest qualified at ${num(Math.round(bestStat.cpq), false)} SAR${smallestBudget ? ', on the smallest budget' : ''}.`}
      </span>,
    );
  }
  if (weakStat && bestStat && weakStat.cpq !== null && bestStat.cpq !== null) {
    const ratio = Math.round((weakStat.cpq / bestStat.cpq) * 10) / 10;
    const remaining = (weakStat.exec.budget ?? 0) - (weakStat.exec.spend ?? 0);
    numberRules.push(
      <span key="weak">
        {isAr
          ? `${pname(weakStat.exec.platform)} يكلّف ${num(ratio, true)} ضعف ${pname(bestStat.exec.platform)} لكل مؤهل.${remaining > 0 ? ` تبقى ${num(remaining, true)} ريال فيه.` : ''}`
          : `${pname(weakStat.exec.platform)} costs ${num(ratio, false)}× ${pname(bestStat.exec.platform)} per qualified.${remaining > 0 ? ` ${num(remaining, false)} SAR remain in it.` : ''}`}
      </span>,
    );
  }
  for (const s of execStats) {
    if (!s.noQual) continue;
    numberRules.push(
      <span key={`noq-${s.exec.id}`}>
        {isAr
          ? `${pname(s.exec.platform)} لم ينتج أي مؤهل على ${num(s.exec.spend, true)} ريال.`
          : `${pname(s.exec.platform)} produced no qualified on ${num(s.exec.spend, false)} SAR.`}
      </span>,
    );
  }
  for (const s of contentStats) {
    if (!s.wrongProject) continue;
    numberRules.push(
      <span key={`wp-${s.row.id}`}>
        {isAr
          ? <>{' '}<span className="ltr">{s.row.ref ?? s.row.title}</span> يعمل تحت المشروع الخطأ — إنفاقه غير منسوب.</>
          : <>{' '}<span className="ltr">{s.row.ref ?? s.row.title}</span> runs under the wrong project — its spend is unattributed.</>}
      </span>,
    );
  }

  /* s39 coverage rules («ما ينقص هذه الحملة»). */
  const coverageRules: JSX.Element[] = [];
  if (angles !== null) {
    const angleOf = (id: string): string | null => {
      const a = angles[id];
      return a && a.trim() !== '' ? a.trim() : null;
    };
    const workingAngles = Array.from(new Set(
      contentStats.filter((s) => !s.waiting).map((s) => angleOf(s.row.id)).filter((a): a is string => a !== null),
    ));
    const waitingAngles = Array.from(new Set(
      contentStats.filter((s) => s.waiting).map((s) => angleOf(s.row.id)).filter((a): a is string => a !== null),
    ));
    const missingAngles = waitingAngles.filter((a) => !workingAngles.includes(a));
    if (workingAngles.length > 0) {
      coverageRules.push(
        <span key="angles">
          {isAr
            ? <>كل المحتوى العامل <b>عن {workingAngles.join(' و')}</b>.{missingAngles.length > 0 ? <>{' '}لا شيء عن {missingAngles[0]} بعد.</> : null}</>
            : <>Every working item is <b>about {workingAngles.join(' and ')}</b>.{missingAngles.length > 0 ? <> Nothing about {missingAngles[0]} yet.</> : null}</>}
        </span>,
      );
    }
    const stuck = contentStats.find((s) => s.waiting);
    if (stuck) {
      const stuckAngle = angleOf(stuck.row.id);
      const stage = (isAr ? stuck.row.current_step_label_ar : stuck.row.current_step_label_en)
        ?? (isAr ? 'المراجعة' : 'review');
      coverageRules.push(
        <span key="stuck">
          {isAr
            ? <><span className="ltr">{stuck.row.ref ?? stuck.row.title}</span>{stuckAngle ? <> هو محتوى «{stuckAngle}» الوحيد، وهو</> : ' ما زال في الإنتاج —'} معطّل عند «{stage}» {sinceLabel(stuck.row.updated_at, true)}.</>
            : <><span className="ltr">{stuck.row.ref ?? stuck.row.title}</span>{stuckAngle ? <> is the only "{stuckAngle}" item, and it is</> : ' is still in production —'} stalled at "{stage}" {sinceLabel(stuck.row.updated_at, false)}.</>}
        </span>,
      );
    }
  }
  const usedTypes = new Set(content.map((c) => c.content_type_key));
  const missingType = contentTypes.filter((t) => t.is_active && !usedTypes.has(t.key))
    .sort((a, b) => Number(b.label_ar.includes('شهادة')) - Number(a.label_ar.includes('شهادة')))[0] ?? null;
  const missingTypeLabel = missingType ? (isAr ? missingType.label_ar : missingType.label_en) : null;

  /* «إعادة التوزيع المقترحة» names. */
  const weakName = weakStat ? pname(weakStat.exec.platform) : null;
  const bestName = bestStat ? pname(bestStat.exec.platform) : null;

  // Paid: the platforms its ad campaigns run on. Organic: the platforms its
  // content was actually published to (from the per-item publication rollup).
  const platformsInPlay = isOrganic
    ? Array.from(new Set(contentStats.flatMap((s) => s.platforms)))
    : Array.from(new Set(executions.map((x) => x.platform)));
  const filteredContent = platFilter === 'all'
    ? contentStats
    : contentStats.filter((s) => s.platforms.includes(platFilter));

  const openDailyEntry = (): void => {
    if (executions.length === 1 && executions[0]) {
      navigate(`/m/campaigns/${item.id}/exec/${executions[0].id}?tab=daily`);
      return;
    }
    setPickDaily(true);
  };

  /* ── render ──────────────────────────────────────────────────────── */

  return (
    <>
      <div className="rhead">
        <div className="top">
          <div style={{ minWidth: 0 }}>
            <div className="crumb">
              <button type="button" onClick={() => navigate('/m/campaigns')}>
                <Back style={{ width: 11, height: 11, verticalAlign: -1 }} /> {isAr ? 'الحملات' : 'Campaigns'}
              </button>
              <span className="sep">/</span>
              <span className="ltr">{item.ref}</span>
              {crumbTail[tab] && (
                <>
                  <span className="sep">/</span>
                  <span>{isAr ? crumbTail[tab]?.ar : crumbTail[tab]?.en}</span>
                </>
              )}
            </div>
            <h3>{item.name}</h3>
            <div className="chips">
              {tab === 'content' ? (
                <>
                  <span className="tag">{linkedItemsLabel(content.length, isAr)}</span>
                  {inProduction > 0 && <Pill tone="wait">{inProductionLabel(inProduction, isAr)}</Pill>}
                </>
              ) : tab === 'results' ? (
                <>
                  <Pill tone={statusPill.tone}>
                    {days
                      ? isAr ? `اليوم ${num(days.elapsed, true)} من ${num(days.total, true)}` : `Day ${days.elapsed} of ${days.total}`
                      : statusPill.text}
                  </Pill>
                  <span className="tag tag-t">{isAr ? 'أرقام مُدخلة يدويًا' : 'numbers entered by hand'}</span>
                </>
              ) : tab === 'executions' ? (
                <>
                  <span className="tag">
                    {item.kind === 'organic' ? (isAr ? 'عضوية' : 'Organic') : (isAr ? 'مدفوعة' : 'Paid')}
                  </span>
                  <Pill tone={statusPill.tone}>{statusPill.text}</Pill>
                  <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                    {isAr
                      ? `${num(spend === null ? null : Math.round(spend), true)} من ${num(budget === null ? null : Math.round(budget), true)} ريال`
                      : `${num(spend === null ? null : Math.round(spend), false)} of ${num(budget === null ? null : Math.round(budget), false)} SAR`}
                  </span>
                </>
              ) : (
                <>
                  <span className="tag">
                    {item.kind === 'organic' ? (isAr ? 'عضوية' : 'Organic') : (isAr ? 'مدفوعة' : 'Paid')}
                  </span>
                  <ProjectLink projectIds={item.project_ids ?? []} />
                  <Pill tone={statusPill.tone}>{statusPill.text}</Pill>
                  <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                    {isAr ? 'المسؤول ' : 'Owner '}
                    <b style={{ color: 'var(--ink)', fontWeight: 700 }}>
                      {item.owner_role && ROLE_LABELS[item.owner_role]
                        ? isAr ? ROLE_LABELS[item.owner_role].ar : ROLE_LABELS[item.owner_role].en
                        : '—'}
                    </b>
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="acts">
            {tab === 'executions' ? (
              <>
                {can('enter_metrics') && (
                  <button
                    type="button"
                    className="btn btn-d"
                    disabled={busy || executions.every((x) => x.status !== 'running')}
                    onClick={() => void pauseAll()}
                  >
                    {isAr ? 'إيقاف الكل' : 'Pause all'}
                  </button>
                )}
                {can('enter_metrics') && (
                  <button type="button" className="btn btn-p" onClick={() => setExecAdding(true)}>
                    {isAr ? 'إضافة حملة إعلانية' : 'Add an ad campaign'}
                  </button>
                )}
              </>
            ) : tab === 'content' ? (
              <>
                {can('write_content') && (
                  <button type="button" className="btn btn-d" onClick={() => setAddingContent(true)}>
                    {isAr ? 'طلب محتوى جديد' : 'Request new content'}
                  </button>
                )}
                {can('write_content') && (
                  <button type="button" className="btn btn-p" onClick={() => setLinking(true)}>
                    {isAr ? 'ربط محتوى قائم' : 'Link existing content'}
                  </button>
                )}
              </>
            ) : tab === 'results' ? (
              <>
                <button type="button" className="btn btn-d" onClick={exportCsv}>
                  {isAr ? 'تصدير' : 'Export'}
                </button>
                {can('enter_metrics') && (
                  <button
                    type="button"
                    className="btn btn-p"
                    disabled={executions.length === 0}
                    onClick={openDailyEntry}
                  >
                    {isAr ? 'إدخال أرقام اليوم' : 'Enter today’s numbers'}
                  </button>
                )}
              </>
            ) : (
              <>
                {can('approve_budget') && (
                  <button type="button" className="btn btn-d" disabled={busy} onClick={() => void toggleCampaign()}>
                    {item.status === 'active'
                      ? isAr ? 'إيقاف مؤقت' : 'Pause'
                      : isAr ? 'استئناف' : 'Resume'}
                  </button>
                )}
                {!isOrganic && can('approve_budget') && (
                  <button
                    type="button"
                    className="btn btn-p"
                    disabled={executions.length < 2}
                    onClick={() => setShift({ from: '', to: '', amount: null })}
                  >
                    {isAr ? 'تحويل ميزانية' : 'Shift budget'}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        <div className="tabs">
          {tabs.map((t) => (
            <button key={t.key} type="button" className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
              {isAr ? t.ar : t.en}
              {t.badge ? <span className="b">{num(t.badge, isAr)}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="body">
        {/* ── s15 — overview ─────────────────────────────────────────── */}
        {tab === 'overview' && (
          <div style={{ display: 'grid', gap: 16 }}>
            {item.requires_signature && !item.signed_by_user_id && (
              <div className="cd-sign">
                <span>
                  <b>{isAr ? 'ميزانية تنتظر التوقيع.' : 'A budget awaits signature.'}</b>{' '}
                  {isAr
                    ? `ميزانية هذه الحملة (${money(item.budget_total, true)}) تتجاوز حد التوقيع ولا تنطلق قبل توقيع الرئيس التنفيذي.`
                    : `This campaign's budget (${money(item.budget_total, false)}) crosses the signature threshold and does not launch before the CEO signs.`}
                </span>
                {can('approve_budget') && (
                  <button type="button" className="btn btn-p btn-sm" disabled={busy} onClick={() => void sign()}>
                    {isAr ? 'توقيع الميزانية' : 'Sign the budget'}
                  </button>
                )}
              </div>
            )}

            <div className="cd-oview">
              <div className="cd-main">
                {/* الموجز */}
                <div className="card">
                  <div className="card-h">
                    <h4>{isAr ? 'الموجز' : 'The brief'}</h4>
                    <span className="r">
                      {isAr
                        ? `حُدّد ${shortDate(item.created_at, true)}${events.length === 0 ? ' · دون تغيير' : ''}`
                        : `Set ${shortDate(item.created_at, false)}${events.length === 0 ? ' · unchanged' : ''}`}
                    </span>
                    {can('approve_budget') && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ marginInlineStart: 10 }}
                        onClick={() => setBriefEditing(true)}
                      >
                        {isAr ? 'تعديل' : 'Edit'}
                      </button>
                    )}
                  </div>
                  <div className="card-b cd-goalgrid">
                    <ReadField label={isAr ? 'الوصف' : 'Description'}>{item.goal ?? item.name}</ReadField>
                    <ReadField label={isAr ? 'الأهداف' : 'Goals'}>
                      {goals.length === 0 ? '—' : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {goals.map((g) => (
                            <span
                              key={g.id}
                              className="tag"
                              title={g.description ?? undefined}
                              style={{ background: 'color-mix(in srgb, var(--copper) 12%, transparent)' }}
                            >
                              {g.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </ReadField>
                    <ReadField label={isAr ? 'الجمهور' : 'Audience'}>
                      {item.audience ?? '—'}
                      {item.audience_details && item.audience_details.trim() !== '' && (
                        <div style={{ fontSize: 11.5, color: 'var(--mute)', fontWeight: 400, marginTop: 3, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                          {item.audience_details}
                        </div>
                      )}
                    </ReadField>
                    <ReadField label={isAr ? 'معيار النجاح' : 'Success criterion'}>{successText}</ReadField>
                  </div>
                </div>

                {/* الحملات الإعلانية للمنصات — paid only: an organic campaign runs
                    through content, not ad-platform buys, so it has no ad campaigns. */}
                {!isOrganic && (
                <div className="card">
                  <div className="card-h">
                    <h4>{isAr ? 'الحملات الإعلانية للمنصات' : 'Platform ad campaigns'}</h4>
                    <span className="r">
                      {isAr
                        ? `${num(executions.length, true)} تعمل تحت هذا الهدف`
                        : `${executions.length} running under this goal`}
                    </span>
                    {can('enter_metrics') && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ marginInlineStart: 10 }}
                        onClick={() => setExecAdding(true)}
                      >
                        {isAr ? 'إضافة حملة إعلانية' : 'Add an ad campaign'}
                      </button>
                    )}
                  </div>
                  {executions.length === 0 ? (
                    <p style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--mute)' }}>
                      {isAr
                        ? 'لا حملات إعلانية بعد. أضف صفًّا لكل منصة تعمل تحت هذا الهدف.'
                        : 'No ad campaigns yet. Add one row per platform running under this goal.'}
                    </p>
                  ) : (
                    <>
                    <div className="tbl-wrap m4-desk">
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>{isAr ? 'الحملة الإعلانية' : 'Ad campaign'}</th>
                            <th style={{ width: 92 }}>{isAr ? 'الغرض' : 'Purpose'}</th>
                            <th className="num" style={{ width: 64 }}>{isAr ? 'المحتوى' : 'Content'}</th>
                            <th className="num" style={{ width: 88 }}>{isAr ? 'الميزانية' : 'Budget'}</th>
                            <th className="num" style={{ width: 82 }}>{isAr ? 'المصروف' : 'Spent'}</th>
                            <th className="num" style={{ width: 62 }}>{isAr ? 'العملاء' : 'Leads'}</th>
                            <th className="num" style={{ width: 70 }}>{isAr ? 'المؤهلون' : 'Qualified'}</th>
                            <th className="num" style={{ width: 86 }}>{isAr ? 'تكلفة المؤهل' : 'Cost/qual.'}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {execStats.map((s) => (
                            <tr
                              key={s.exec.id}
                              className="click"
                              onClick={() => navigate(`/m/campaigns/${item.id}/exec/${s.exec.id}`)}
                            >
                              <td>
                                <div className="cd-plat">
                                  <span
                                    className="cd-dot"
                                    style={{ background: PLATFORM_DOT[s.exec.platform] ?? 'var(--copper)' }}
                                  />
                                  <b>{pname(s.exec.platform)}</b>
                                </div>
                              </td>
                              <td>
                                {s.exec.purpose && PURPOSE_PILL_LABELS[s.exec.purpose]
                                  ? isAr ? PURPOSE_PILL_LABELS[s.exec.purpose]?.ar : PURPOSE_PILL_LABELS[s.exec.purpose]?.en
                                  : '—'}
                              </td>
                              <td className="num">{s.adsCount > 0 ? num(s.adsCount, isAr) : '—'}</td>
                              <td className="num">{num(s.exec.budget, isAr)}</td>
                              <td className="num">{num(s.exec.spend, isAr)}</td>
                              <td className="num">{num(s.exec.leads, isAr)}</td>
                              <td className="num">{num(s.exec.qualified, isAr)}</td>
                              <td
                                className="num"
                                style={s.cpq === null
                                  ? { color: 'var(--mute)' }
                                  : s.weak
                                    ? { color: 'var(--late)', fontWeight: 700 }
                                    : { color: 'var(--go)', fontWeight: 700 }}
                              >
                                {s.cpq === null ? '—' : num(Math.round(s.cpq), isAr)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* s32 phone2 — the same rows as cards: cost per
                        qualified is the dominant number because it is the
                        number the decision is made on. */}
                    <div className="m4-mob" style={{ padding: '10px 12px 12px' }}>
                      <div className="m4-cards">
                        {execStats.map((s) => {
                          const x = s.exec;
                          const remaining = (x.budget ?? 0) - (x.spend ?? 0);
                          const under = !s.weak && !s.noQual
                            && s.spendPct !== null && timePct !== null && s.spendPct < timePct - 10;
                          const ratio = s.weak && bestStat && bestStat.cpq !== null && s.cpq !== null
                            ? Math.round((s.cpq / bestStat.cpq) * 10) / 10
                            : null;
                          const pill = s.weak
                            ? { tone: 'late' as Tone, text: isAr ? 'أداء ضعيف' : 'Weak performer' }
                            : s.noQual
                              ? { tone: 'idle' as Tone, text: isAr ? 'بلا مؤهلين' : 'No qualified' }
                              : under
                                ? { tone: 'wait' as Tone, text: isAr ? 'إنفاق ناقص' : 'Underspending' }
                                : x.status === 'running'
                                  ? { tone: 'go' as Tone, text: isAr ? 'على الوتيرة' : 'On pace' }
                                  : {
                                      tone: 'idle' as Tone,
                                      text: (isAr ? EXEC_STATUS_LABELS[x.status]?.ar : EXEC_STATUS_LABELS[x.status]?.en)
                                        ?? x.status,
                                    };
                          return (
                            <button
                              key={x.id}
                              type="button"
                              className={`m4-vcard${s.weak ? ' late2' : ''}${s.noQual ? ' dim' : ''}`}
                              onClick={() => navigate(`/m/campaigns/${item.id}/exec/${x.id}`)}
                            >
                              <div className="m4-vtop">
                                <span
                                  className="m4-vdot"
                                  style={{ background: PLATFORM_DOT[x.platform] ?? 'var(--copper)' }}
                                />
                                <span className="m4-vname">{pname(x.platform)}</span>
                                <Pill tone={pill.tone}>{pill.text}</Pill>
                              </div>
                              {!s.noQual && (
                                <>
                                  <div className="m4-vnum">
                                    <span
                                      className="n lg"
                                      style={{
                                        color: s.cpq === null
                                          ? 'var(--mute)'
                                          : s.weak ? 'var(--late)' : 'var(--go)',
                                      }}
                                    >
                                      {s.cpq === null ? '—' : num(Math.round(s.cpq), isAr)}
                                    </span>
                                    <span className="s">
                                      {isAr ? 'ريال لكل مؤهل' : 'SAR per qualified'}
                                      {ratio !== null && bestName
                                        ? isAr
                                          ? ` · ${num(ratio, true)} ضعف ${bestName}`
                                          : ` · ${num(ratio, false)}× ${bestName}`
                                        : s.isBestCpq
                                          ? isAr ? ' · الأرخص' : ' · the cheapest'
                                          : ''}
                                    </span>
                                  </div>
                                  <div className="meter">
                                    <i
                                      style={{
                                        width: `${Math.min(100, Math.max(0, s.spendPct ?? 0))}%`,
                                        background: s.weak ? 'var(--late)' : under ? 'var(--wait)' : 'var(--copper)',
                                      }}
                                    />
                                  </div>
                                </>
                              )}
                              <div className="m4-vstats">
                                <span>
                                  {s.weak
                                    ? isAr
                                      ? <>تبقّى <b>{num(Math.max(0, remaining), true)}</b> ريال</>
                                      : <><b>{num(Math.max(0, remaining), false)}</b> SAR remain</>
                                    : x.budget !== null
                                      ? isAr
                                        ? <>صُرف <b>{num(whole(x.spend), true)}</b> من {num(whole(x.budget), true)}</>
                                        : <><b>{num(whole(x.spend), false)}</b> of {num(whole(x.budget), false)} spent</>
                                      : isAr
                                        ? <>صُرف <b>{num(whole(x.spend), true)}</b> ريال</>
                                        : <><b>{num(whole(x.spend), false)}</b> SAR spent</>}
                                </span>
                                <span>{isAr ? `${num(x.leads, true)} عميلًا` : `${num(x.leads, false)} leads`}</span>
                                <span>{isAr ? `${num(x.qualified, true)} مؤهلًا` : `${num(x.qualified, false)} qualified`}</span>
                              </div>
                              {s.weak && bestStat && bestName && remaining > 0 && can('approve_budget') && (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  className="btn btn-p btn-sm m4-vact"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setShift({ from: x.id, to: bestStat.exec.id, amount: remaining });
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      setShift({ from: x.id, to: bestStat.exec.id, amount: remaining });
                                    }
                                  }}
                                >
                                  {isAr
                                    ? `حوّل الـ${num(remaining, true)} إلى ${bestName}`
                                    : `Shift the ${num(remaining, false)} to ${bestName}`}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    </>
                  )}
                </div>
                )}

                {/* المحتوى المستخدم */}
                <div className="card">
                  <div className="card-h">
                    <h4>{isAr ? 'المحتوى المستخدم' : 'Content in use'}</h4>
                    <span className="r">
                      {isAr
                        ? `${num(content.length, true)} عناصر · مُشار إليها، غير منسوخة`
                        : `${content.length} items · referenced, never copied`}
                    </span>
                  </div>
                  {content.length === 0 ? (
                    <p style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--mute)' }}>
                      {isAr
                        ? 'لا محتوى مرتبطًا بهذه الحملة بعد.'
                        : 'No content attributed to this campaign yet.'}
                    </p>
                  ) : (
                    <div className="tbl-wrap">
                      <table className="tbl">
                        <tbody>
                          {contentStats.map((s) => (
                            <tr
                              key={s.row.id}
                              className="click"
                              onClick={() => navigate(`/m/content/${s.row.id}`)}
                            >
                              <td style={{ width: 64 }} className="id">{s.row.ref ?? '—'}</td>
                              <td className="ttl">{s.row.title}</td>
                              <td style={{ width: 200 }}>
                                {s.waiting
                                  ? <span className="tag tag-t">{isAr ? 'في الانتظار' : 'Waiting'}</span>
                                  : s.platforms.map((p) => (
                                      <span key={p} className="tag" style={{ marginInlineEnd: 4 }}>{pname(p)}</span>
                                    ))}
                              </td>
                              <td style={{ width: 100 }} className="num">
                                {isOrganic
                                  ? (s.impressions === null
                                    ? <span style={{ color: 'var(--mute)' }}>—</span>
                                    : isAr ? `${num(s.impressions, true)} مشاهدة` : `${s.impressions} views`)
                                  : (s.leads === null
                                    ? <span style={{ color: 'var(--mute)' }}>—</span>
                                    : isAr ? `${num(s.leads, true)} عميلًا` : `${s.leads} leads`)}
                              </td>
                              <td style={{ width: 126 }}>
                                {s.row.id === bestContentId ? (
                                  <Pill tone="go">{isAr ? 'الأفضل أداءً' : 'Best performer'}</Pill>
                                ) : s.wrongProject ? (
                                  <Pill tone="late">{isAr ? 'المشروع الخطأ' : 'Wrong project'}</Pill>
                                ) : s.waiting ? (
                                  <Pill tone="wait">{isAr ? 'ما زال في المراجعة' : 'Still in review'}</Pill>
                                ) : null}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              <div className="cd-side">
                {/* مقابل الهدف */}
                <div className="card">
                  <div className="card-h"><h4>{isAr ? 'مقابل الهدف' : 'Against the goal'}</h4></div>
                  <div className="card-b">
                    <div className="cd-vs-line">
                      <span className="cd-bignum">{num(goalProgress, isAr)}</span>
                      <span className="cd-vs-sub">
                        {target !== null
                          ? isAr ? `من ${num(target, true)} ${goalUnitAr}` : `of ${num(target, false)} ${goalUnitEn}`
                          : isAr ? goalUnitAr : goalUnitEn}
                      </span>
                    </div>
                    {target !== null && targetPct !== null && timePct !== null ? (
                      <>
                        <div className="meter" style={{ marginTop: 9, height: 5 }}>
                          <i style={{ width: `${targetPct}%`, background: 'var(--copper)' }} />
                        </div>
                        <div className="cd-vs-pcts">
                          <span>{isAr ? `${pctStr(targetPct, true)} من المستهدف` : `${pctStr(targetPct, false)} of target`}</span>
                          <span>{isAr ? `${pctStr(timePct, true)} من المدة مضى` : `${pctStr(timePct, false)} of the window gone`}</span>
                        </div>
                        {projection !== null && (
                          <div className="cd-projection">
                            <b style={{ color: onPace ? 'var(--go)' : 'var(--late)' }}>
                              {onPace ? (isAr ? 'على الوتيرة.' : 'On pace.') : (isAr ? 'متأخرة عن الوتيرة.' : 'Behind pace.')}
                            </b>{' '}
                            {isAr
                              ? <>بالمعدل الحالي سيُغلق {monthOf(item.ends_on, true) || 'الشهر'} عند <b>{num(projection, true)} {goalUnitAr}</b> تقريبًا — {pctStr((projection / target) * 100, true)} من المستهدف.</>
                              : <>At the current rate {monthOf(item.ends_on, false) || 'the month'} closes at roughly <b>{num(projection, false)} {goalUnitEn}</b> — {pctStr((projection / target) * 100, false)} of target.</>}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="cd-projection" style={{ color: 'var(--mute)' }}>
                        {isAr
                          ? 'لا وتيرة تُحسب — الهدف بلا رقم مستهدف أو بلا مدة.'
                          : 'No pace to compute — the goal has no numeric target or no dates.'}
                      </div>
                    )}
                  </div>
                </div>

                {/* ماذا تقول الأرقام */}
                <div className="card">
                  <div className="card-h"><h4>{isAr ? 'ماذا تقول الأرقام' : 'What the numbers say'}</h4></div>
                  <div className="card-b" style={{ display: 'grid', gap: 9 }}>
                    {numberRules.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.85 }}>
                        {isAr
                          ? 'تظهر الجمل حين تتوفر أرقام قابلة للمقارنة.'
                          : 'Sentences appear once there are numbers to compare.'}
                      </div>
                    ) : numberRules.map((r, i) => (
                      <div key={i} className="rule"><span className="arw">←</span>{r}</div>
                    ))}
                  </div>
                </div>

                {/* ما بعد الإعلان */}
                <div className="card">
                  <div className="card-h">
                    <h4>{isAr
                      ? (isOrganic ? 'ما بعد النشر' : 'ما بعد الإعلان')
                      : (isOrganic ? 'After publishing' : 'After the ad')}</h4>
                    <span className="r">
                      {isAr
                        ? (isOrganic ? 'من المنصات' : 'من نظام العملاء')
                        : (isOrganic ? 'from the platforms' : 'from the clients system')}
                    </span>
                  </div>
                  <div className="card-b" style={{ display: 'grid', gap: 8 }}>
                    {!isOrganic && outcomesError && (
                      <div style={{ fontSize: 11.5, color: 'var(--late)' }} role="alert">
                        {isAr ? 'تعذّر تحميل النتائج: ' : 'Outcomes failed to load: '}{outcomesError}
                      </div>
                    )}
                    {isOrganic ? (
                      <>
                        <div className="cd-kv"><span>{isAr ? 'المشاهدات' : 'Impressions'}</span><b>{num(organicReach.impressions, isAr)}</b></div>
                        <div className="cd-kv"><span>{isAr ? 'التفاعل' : 'Engagement'}</span><b>{num(organicReach.engagement, isAr)}</b></div>
                        <div className="cd-kv"><span>{isAr ? 'الإعجابات' : 'Likes'}</span><b>{num(organicReach.likes, isAr)}</b></div>
                        <div className="cd-kv"><span>{isAr ? 'التعليقات' : 'Comments'}</span><b>{num(organicReach.comments, isAr)}</b></div>
                        <div className="cd-kv"><span>{isAr ? 'الحفظ' : 'Saves'}</span><b>{num(organicReach.saves, isAr)}</b></div>
                        <div className="cd-kv top"><span>{isAr ? 'استفسارات' : 'Enquiries'}</span><b>{num(organicReach.enquiries, isAr)}</b></div>
                      </>
                    ) : (
                      <>
                        <div className="cd-kv"><span>{isAr ? 'عملاء محتملون' : 'Leads'}</span><b>{num(item.total_leads, isAr)}</b></div>
                        <div className="cd-kv"><span>{isAr ? 'مؤهلون' : 'Qualified'}</span><b>{num(item.total_qualified, isAr)}</b></div>
                        <div className="cd-kv"><span>{isAr ? 'مواعيد' : 'Appointments'}</span><b>{num(outcomes?.appointments ?? null, isAr)}</b></div>
                        <div className="cd-kv"><span>{isAr ? 'زيارات' : 'Visits'}</span><b>{num(outcomes?.visits ?? null, isAr)}</b></div>
                        <div className="cd-kv top"><span>{isAr ? 'حجوزات' : 'Reservations'}</span><b>{num(outcomes?.reservations ?? null, isAr)}</b></div>
                        <div className="cd-kv"><span>{isAr ? 'القيمة' : 'Value'}</span><b>{compactMoney(outcomes?.reservation_value ?? null, isAr)}</b></div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── s20 — executions ───────────────────────────────────────── */}
        {tab === 'executions' && (
          <>
            {enrichError && (
              <div className="notice bad" role="alert" style={{ marginBottom: 12 }}>
                {isAr ? 'تعذّر تحميل إعلانات: ' : 'Ads failed to load for: '}{enrichError}
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ marginInlineStart: 10 }}
                  onClick={() => void enrich(executions)}
                >
                  {isAr ? 'إعادة المحاولة' : 'Try again'}
                </button>
              </div>
            )}
            {executions.length === 0 ? (
              <p style={{ padding: 26, textAlign: 'center', fontSize: 13, color: 'var(--mute)' }}>
                {isAr
                  ? 'لا حملات إعلانية. الحملة هدف؛ وما يعمل على كل منصة حملةٌ إعلانية تحتها.'
                  : 'No ad campaigns. The campaign is a goal; what runs on each platform is an ad campaign under it.'}
              </p>
            ) : (
              <div style={{ display: 'grid', gap: 12 }}>
                {execStats.map((s) => {
                  const x = s.exec;
                  const remaining = (x.budget ?? 0) - (x.spend ?? 0);
                  const purposeLabel = x.purpose && PURPOSE_PILL_LABELS[x.purpose]
                    ? isAr ? PURPOSE_PILL_LABELS[x.purpose]?.ar : PURPOSE_PILL_LABELS[x.purpose]?.en
                    : null;
                  const meterColor = s.noQual
                    ? 'var(--sand)'
                    : s.weak
                      ? 'var(--late)'
                      : s.spendPct !== null && timePct !== null && s.spendPct < timePct - 10
                        ? 'var(--wait)'
                        : 'var(--copper)';
                  const pill = s.weak
                    ? { tone: 'late' as Tone, text: isAr ? 'أداء ضعيف' : 'Weak performer' }
                    : s.noQual
                      ? { tone: 'idle' as Tone, text: isAr ? 'بلا مؤهلين' : 'No qualified' }
                      : x.status === 'running'
                        ? { tone: 'now' as Tone, text: isAr ? 'تعمل' : 'Running' }
                        : x.status === 'ended'
                          ? { tone: 'live' as Tone, text: isAr ? 'منتهية' : 'Ended' }
                          : {
                              tone: 'idle' as Tone,
                              text: (isAr ? EXEC_STATUS_LABELS[x.status]?.ar : EXEC_STATUS_LABELS[x.status]?.en) ?? x.status,
                            };
                  let verdict: JSX.Element | null = null;
                  if (s.weak && x.budget !== null && days) {
                    verdict = (
                      <div className="cd-verdict" style={{ color: 'var(--mute)' }}>
                        {isAr
                          ? `تبقى ${num(Math.max(0, remaining), true)} ريال · ${num(days.left, true)} أيام`
                          : `${num(Math.max(0, remaining), false)} SAR remain · ${days.left} days`}
                      </div>
                    );
                  } else if (!s.noQual && s.spendPct !== null && timePct !== null) {
                    const under = s.spendPct < timePct - 10;
                    const over = s.spendPct > timePct + 10;
                    verdict = (
                      <div
                        className="cd-verdict"
                        style={{
                          color: under ? 'var(--wait)' : over ? 'var(--late)' : 'var(--go)',
                          fontWeight: 700,
                        }}
                      >
                        {isAr
                          ? `${under ? 'إنفاق ناقص' : over ? 'إنفاق زائد' : 'على الوتيرة'} · ${pctStr(s.spendPct, true)} صرف، ${pctStr(timePct, true)} من المدة`
                          : `${under ? 'Underspending' : over ? 'Overspending' : 'On pace'} · ${pctStr(s.spendPct, false)} spent, ${pctStr(timePct, false)} of the window`}
                      </div>
                    );
                  }
                  let note: { border: string; mute?: boolean; body: JSX.Element } | null = null;
                  if (s.weak && bestStat && bestStat.cpq !== null && s.cpq !== null) {
                    const ratio = Math.round((s.cpq / bestStat.cpq) * 10) / 10;
                    note = {
                      border: 'var(--late)',
                      body: isAr
                        ? <>{num(ratio, true)} ضعف تكلفة {bestName} لكل مؤهل. <b>التوصية: تحويل الـ{num(Math.max(0, remaining), true)} المتبقية إلى {bestName}.</b></>
                        : <>{num(ratio, false)}× {bestName}’s cost per qualified. <b>Recommendation: shift the remaining {num(Math.max(0, remaining), false)} to {bestName}.</b></>,
                    };
                  } else if (s.noQual) {
                    note = {
                      border: 'var(--line)',
                      mute: true,
                      body: isAr
                        ? <>{purposeLabel ? <>غرضه {purposeLabel}، فالمؤهلون لم يكونوا المقصد — لكن </> : null}{num(whole(x.spend), true)} ريال لم تنتج شيئًا قابلًا للقياس.</>
                        : <>{purposeLabel ? <>Its purpose is {purposeLabel.toLowerCase()}, so qualified were never the point — but </> : null}{num(whole(x.spend), false)} SAR produced nothing measurable.</>,
                    };
                  } else if (s.isBestCpq) {
                    const budgets = execStats
                      .map((e) => e.exec.budget)
                      .filter((b): b is number => b !== null && b > 0);
                    const smallest = x.budget !== null && budgets.length > 1 && x.budget === Math.min(...budgets);
                    note = {
                      border: 'var(--gold)',
                      body: isAr
                        ? <>أرخص مؤهل بين الحملات الإعلانية{smallest ? ' — على أصغر ميزانية' : ''}.</>
                        : <>The cheapest qualified of the ad campaigns{smallest ? ' — on the smallest budget' : ''}.</>,
                    };
                  } else if (s.isMaxQualified) {
                    const underThreshold = item.success_threshold !== null
                      && (item.success_metric === 'cpl_qualified' || item.success_metric === 'cpl')
                      && s.cpq !== null && s.cpq <= item.success_threshold;
                    note = {
                      border: 'var(--go)',
                      body: isAr
                        ? <>أعلى حجم مؤهلين بين الحملات الإعلانية{underThreshold ? <>. وتحت معيار النجاح {num(item.success_threshold, true)} ريالًا</> : null}.</>
                        : <>The highest qualified volume of the ad campaigns{underThreshold ? <>, under the {num(item.success_threshold, false)} SAR success bar</> : null}.</>,
                    };
                  }
                  return (
                    <div key={x.id} className={`card${s.weak ? ' cd-weak' : ''}${s.noQual ? ' cd-noqual' : ''}`}>
                      <div className="card-h">
                        <span
                          className="cd-dot lg"
                          style={{ background: PLATFORM_DOT[x.platform] ?? 'var(--copper)' }}
                        />
                        <h4>{pname(x.platform)}{x.label ? ` — ${x.label}` : ''}</h4>
                        <span className="tag">{adsCountLabel(s.adsCount, isAr)}</span>
                        {purposeLabel && <span className="tag">{purposeLabel}</span>}
                        {(() => {
                          const sp = settingsSummary(
                            x.platform,
                            (x.platform_settings ?? null) as PlatformSettings | null,
                            isAr,
                          );
                          return sp.length > 0 ? <span className="tag">{sp.slice(0, 2).join(' · ')}</span> : null;
                        })()}
                        {x.platform_campaign_id && (
                          <span
                            className="cd-platform-id"
                            style={{ fontSize: 11, color: 'var(--mute)' }}
                            title={isAr ? 'معرّف الحملة على ميتا' : 'Meta campaign id'}
                          >
                            {isAr ? 'حملة ميتا' : 'Meta campaign'}{' '}
                            <span className="ltr">#{x.platform_campaign_id}</span>
                          </span>
                        )}
                        <span style={{ marginInlineStart: 'auto' }}>
                          <Pill tone={pill.tone}>{pill.text}</Pill>
                        </span>
                        {can('enter_metrics') && (
                          <button type="button" className="btn btn-sm" onClick={() => setExecEditing(x)}>
                            {isAr ? 'تعديل' : 'Edit'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => navigate(`/m/campaigns/${item.id}/exec/${x.id}`)}
                        >
                          {isAr ? 'فتح' : 'Open'}
                        </button>
                      </div>
                      <div className="card-b cd-exec-b">
                        <div>
                          <div className="lbl">{isAr ? 'وتيرة الصرف' : 'Spend pace'}</div>
                          <div className="cd-vs-line" style={{ marginTop: 4 }}>
                            <span className="cd-pacenum">{money(x.spend, isAr)}</span>
                            <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
                              {x.budget !== null
                                ? isAr ? `من ${num(whole(x.budget), true)}` : `of ${num(whole(x.budget), false)}`
                                : isAr ? 'بلا ميزانية' : 'no budget'}
                            </span>
                          </div>
                          <div className="meter" style={{ marginTop: 7 }}>
                            <i
                              style={{
                                width: `${Math.min(100, Math.max(0, s.spendPct ?? 0))}%`,
                                background: meterColor,
                              }}
                            />
                          </div>
                          {verdict}
                        </div>
                        <div className="cd-stats">
                          <div>
                            <div className="lbl">{isAr ? 'عملاء' : 'Leads'}</div>
                            <div className="cd-statnum">{num(x.leads, isAr)}</div>
                          </div>
                          <div>
                            <div className="lbl">{isAr ? 'مؤهلون' : 'Qualified'}</div>
                            <div className="cd-statnum">{num(x.qualified, isAr)}</div>
                          </div>
                          <div>
                            <div className="lbl">{isAr ? 'تكلفة المؤهل' : 'Cost/qual.'}</div>
                            <div
                              className="cd-statnum"
                              style={{
                                color: s.cpq === null ? 'var(--mute)' : s.weak ? 'var(--late)' : 'var(--go)',
                              }}
                            >
                              {s.cpq === null ? '—' : num(Math.round(s.cpq), isAr)}
                            </div>
                          </div>
                          <div>
                            <div className="lbl">{isAr ? 'مواعيد' : 'Appointments'}</div>
                            <div className="cd-statnum">{num(null, isAr)}</div>
                          </div>
                        </div>
                        {note ? (
                          <div
                            className="cd-exec-note"
                            style={{
                              borderInlineStartColor: note.border,
                              ...(note.mute ? { color: 'var(--mute)' } : {}),
                            }}
                          >
                            {note.body}
                          </div>
                        ) : <div />}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {realloc && weakName && bestName && (
              <div className="cd-banner">
                <div className="tx">
                  <b>{isAr ? 'إعادة التوزيع المقترحة:' : 'Suggested reallocation:'}</b>{' '}
                  {isAr
                    ? <>{num(realloc.remaining, true)} ريال من {weakName} ← {bestName}. بتكلفة {bestName} الحالية لكل مؤهل يعني ذلك <b>نحو {num(realloc.gainTo, true)} مؤهلين إضافيين</b> قبل نهاية المدة، مقابل {num(realloc.gainStay, true)} تقريبًا لو بقيت مكانها.</>
                    : <>{num(realloc.remaining, false)} SAR from {weakName} → {bestName}. At {bestName}’s current cost per qualified that is <b>roughly {num(realloc.gainTo, false)} extra qualified</b> before the window closes, against about {num(realloc.gainStay, false)} if it stays put.</>}
                </div>
                {can('approve_budget') && weakStat && bestStat && (
                  <button
                    type="button"
                    className="btn btn-p btn-sm"
                    onClick={() => setShift({
                      from: weakStat.exec.id,
                      to: bestStat.exec.id,
                      amount: realloc.remaining,
                    })}
                  >
                    {isAr ? 'تحويل الميزانية' : 'Shift the budget'}
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {/* ── s39 — content ──────────────────────────────────────────── */}
        {tab === 'content' && (
          <>
            <div className="filt">
              <button
                type="button"
                className={`fbtn${platFilter === 'all' ? ' on' : ''}`}
                onClick={() => setPlatFilter('all')}
              >
                {isOrganic
                  ? (isAr ? 'كل المنصات' : 'All platforms')
                  : (isAr ? 'كل الحملات الإعلانية' : 'All ad campaigns')}
              </button>
              {platformsInPlay.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`fbtn${platFilter === p ? ' on' : ''}`}
                  onClick={() => setPlatFilter(p)}
                >
                  {pname(p)}
                </button>
              ))}
              <span className="cd-filtnote">
                {isOrganic
                  ? isAr
                    ? 'الأداء لكل عنصر يُجمَع من كل منصة نُشر عليها'
                    : 'Each item’s performance is summed from every platform it was published to'
                  : isAr
                    ? 'الأداء لكل عنصر يُجمَع من كل حملة إعلانية يعمل فيها'
                    : 'Each item’s performance is summed from every ad campaign it runs in'}
              </span>
            </div>
            {!isOrganic && enrichError && (
              <div className="notice bad" role="alert" style={{ marginBottom: 12 }}>
                {isAr ? 'تعذّر تحميل إعلانات: ' : 'Ads failed to load for: '}{enrichError}
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ marginInlineStart: 10 }}
                  onClick={() => void enrich(executions)}
                >
                  {isAr ? 'إعادة المحاولة' : 'Try again'}
                </button>
              </div>
            )}
            {isOrganic && pubError && (
              <div className="notice bad" role="alert" style={{ marginBottom: 12 }}>
                {isAr ? 'تعذّر تحميل أرقام النشر لـ: ' : 'Publication numbers failed to load for: '}{pubError}
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ marginInlineStart: 10 }}
                  onClick={() => void enrichOrganic(content)}
                >
                  {isAr ? 'إعادة المحاولة' : 'Try again'}
                </button>
              </div>
            )}
            <div className="card">
              {filteredContent.length === 0 ? (
                <p style={{ padding: 24, textAlign: 'center', fontSize: 13, color: 'var(--mute)' }}>
                  {isAr
                    ? 'لا محتوى هنا. الحملة لا تملك المحتوى — بل تشير إليه.'
                    : 'No content here. A campaign never owns content — it references it.'}
                </p>
              ) : (
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th style={{ width: 60 }}>{isAr ? 'الرقم' : 'Ref'}</th>
                        <th>{isAr ? 'المحتوى' : 'Content'}</th>
                        <th style={{ width: 80 }}>{isAr ? 'النوع' : 'Type'}</th>
                        <th style={{ width: 170 }}>
                          {isOrganic ? (isAr ? 'نُشر في' : 'Published on') : (isAr ? 'يعمل في' : 'Runs in')}
                        </th>
                        {isOrganic ? (
                          <>
                            <th className="num" style={{ width: 82 }}>{isAr ? 'المشاهدات' : 'Impressions'}</th>
                            <th className="num" style={{ width: 64 }}>{isAr ? 'الإعجابات' : 'Likes'}</th>
                            <th className="num" style={{ width: 64 }}>{isAr ? 'التعليقات' : 'Comments'}</th>
                            <th className="num" style={{ width: 60 }}>{isAr ? 'الحفظ' : 'Saves'}</th>
                          </>
                        ) : (
                          <>
                            <th className="num" style={{ width: 82 }}>{isAr ? 'أُنفق' : 'Spent'}</th>
                            <th className="num" style={{ width: 64 }}>{isAr ? 'عملاء' : 'Leads'}</th>
                            <th className="num" style={{ width: 70 }}>{isAr ? 'مؤهلون' : 'Qualified'}</th>
                          </>
                        )}
                        <th style={{ width: 110 }}>{isAr ? 'الحالة' : 'Status'}</th>
                        <th style={{ width: 60 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredContent.map((s) => {
                        const rowClass = s.row.id === bestContentId
                          ? 'hl click'
                          : s.wrongProject
                            ? 'cd-wrongrow click'
                            : s.waiting
                              ? 'cd-dim click'
                              : 'click';
                        return (
                          <tr key={s.row.id} className={rowClass} onClick={() => navigate(`/m/content/${s.row.id}`)}>
                            <td className="id">{s.row.ref ?? '—'}</td>
                            <td className="ttl">{s.row.title}</td>
                            <td><span className="tag">{typeLabel(s.row.content_type_key)}</span></td>
                            <td>
                              {s.waiting
                                ? (
                                  <span className="tag tag-t">
                                    {isOrganic
                                      ? (isAr ? 'لم يُنشر بعد' : 'Not published')
                                      : (isAr ? 'في الانتظار' : 'Waiting')}
                                  </span>
                                )
                                : s.platforms.map((p) => (
                                    <span key={p} className="tag" style={{ marginInlineEnd: 4 }}>{pname(p)}</span>
                                  ))}
                            </td>
                            {isOrganic ? (
                              <>
                                <td className="num">{num(s.impressions, isAr)}</td>
                                <td className="num">{num(s.likes, isAr)}</td>
                                <td className="num">{num(s.comments, isAr)}</td>
                                <td className="num">{num(s.saves, isAr)}</td>
                              </>
                            ) : (
                              <>
                                <td className="num">{num(s.spend === null ? null : Math.round(s.spend), isAr)}</td>
                                <td className="num">{num(s.leads, isAr)}</td>
                                <td className="num">{num(s.qualified, isAr)}</td>
                              </>
                            )}
                            <td>
                              {s.row.id === bestContentId ? (
                                <Pill tone="go">{isAr ? 'الأفضل' : 'Best'}</Pill>
                              ) : s.wrongProject ? (
                                <Pill tone="late">{isAr ? 'مشروع مختلف' : 'Different project'}</Pill>
                              ) : s.waiting ? (
                                <StatusPill row={s.row} isAr={isAr} />
                              ) : s.watch ? (
                                <Pill tone="wait">{isAr ? 'مراقبة' : 'Watching'}</Pill>
                              ) : (
                                <Pill tone="now">{isOrganic ? (isAr ? 'منشور' : 'Live') : (isAr ? 'يعمل' : 'Running')}</Pill>
                              )}
                            </td>
                            <td onClick={(e) => e.stopPropagation()}>
                              {!s.waiting && can('write_content') && (
                                <button
                                  type="button"
                                  className="btn btn-d btn-sm"
                                  onClick={() => void unlinkContent(s.row)}
                                >
                                  {isAr ? 'فك' : 'Unlink'}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="grid g2" style={{ marginTop: 16 }}>
              <div className="card">
                <div className="card-h"><h4>{isAr ? 'ما ينقص هذه الحملة' : 'What this campaign lacks'}</h4></div>
                <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)', display: 'grid', gap: 6 }}>
                  {anglesError && (
                    <div style={{ color: 'var(--late)', fontSize: 11.5 }} role="alert">{anglesError}</div>
                  )}
                  {angles === null && content.length > 0 ? (
                    <div className="sk" style={{ height: 34 }} />
                  ) : (
                    <>
                      {coverageRules.map((r, i) => (
                        <div key={i} className="rule"><span className="arw">←</span>{r}</div>
                      ))}
                      {missingTypeLabel && (
                        <div className="rule">
                          <span className="arw">←</span>
                          <span>
                            {isAr
                              ? `لا يوجد محتوى من نوع «${missingTypeLabel}» في هذه الحملة.`
                              : `There is no “${missingTypeLabel}” content in this campaign.`}
                          </span>
                        </div>
                      )}
                      {coverageRules.length === 0 && !missingTypeLabel && (
                        <div style={{ color: 'var(--mute)' }}>
                          {isAr
                            ? 'لا نواقص واضحة من البيانات الحالية.'
                            : 'No visible gaps from the current data.'}
                        </div>
                      )}
                      {missingTypeLabel && can('write_content') && (
                        <div style={{ marginTop: 11 }}>
                          <button type="button" className="btn btn-p btn-sm" onClick={() => setAddingContent(true)}>
                            {isAr ? `طلب محتوى ${missingTypeLabel}` : `Request ${missingTypeLabel} content`}
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="card">
                <div className="card-h"><h4>{isAr ? 'عن الربط والفك' : 'On linking and unlinking'}</h4></div>
                <div className="card-b" style={{ fontSize: 12, lineHeight: 1.9, color: 'var(--ink-2)' }}>
                  {isAr
                    ? <>«فك» يوقف عرض العنصر ضمن هذه الحملة ويحتفظ بأرقامه التاريخية. <b>لا يحذف المحتوى</b>، ولا يؤثر على نشره العضوي، ولا يمس أي حملة أخرى تستخدمه.</>
                    : <>“Unlink” stops showing the item inside this campaign and keeps its historical numbers. <b>It never deletes the content</b>, never touches its organic publishing, and never affects another campaign using it.</>}
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line-soft)', color: 'var(--mute)' }}>
                    {isAr
                      ? 'العنصر الواحد قد يعمل هنا كإعلان مدفوع، ويُنشر عضويًا، ويظهر في التقويم — سجل واحد في ثلاثة أمكنة.'
                      : 'One item can run here as a paid ad, publish organically, and appear on the calendar — one record in three places.'}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ── s40 — results ──────────────────────────────────────────── */}
        {tab === 'results' && (
          <>
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-h">
                <h4>{isAr ? 'التقدّم المتراكم مقابل الوتيرة المطلوبة' : 'Cumulative progress vs the required pace'}</h4>
                <span className="r">
                  {target !== null && days
                    ? isAr
                      ? `الهدف ${num(target, true)} · متبقٍ ${num(days.left, true)} أيام`
                      : `Target ${num(target, false)} · ${days.left} days left`
                    : isAr ? 'أرقام يومية من صفوف الحملات الإعلانية' : 'daily numbers from the ad-campaign rows'}
                </span>
              </div>
              <div className="card-b">
                {cumulative.length === 0 ? (
                  <p style={{ padding: 12, textAlign: 'center', fontSize: 12.5, color: 'var(--mute)' }}>
                    {isAr
                      ? 'لا أرقام يومية بعد — تُسجَّل من صفحة كل حملة إعلانية، تبويب «يوميًا».'
                      : 'No daily numbers yet — they are recorded on each ad-campaign page, under “Daily”.'}
                  </p>
                ) : (
                  <div className="cd-chartbox">
                    <ResponsiveContainer width="100%" height={172}>
                      <BarChart data={cumulative} margin={{ top: 22, left: 4, right: 4, bottom: 0 }}>
                        <XAxis
                          dataKey="label"
                          reversed={isAr}
                          tickLine={false}
                          axisLine={false}
                          tick={{ fontSize: 10, fill: 'var(--mute)' }}
                          interval="preserveStartEnd"
                        />
                        <YAxis
                          hide
                          domain={[0, Math.max(
                            target ?? 0,
                            requiredToday ?? 0,
                            ...cumulative.map((d) => d.cum),
                          ) * 1.06]}
                        />
                        {target !== null && (
                          <ReferenceLine
                            y={target}
                            stroke="var(--go)"
                            strokeDasharray="6 4"
                            strokeWidth={1.5}
                            label={{
                              value: isAr ? `الهدف ${num(target, true)}` : `Target ${num(target, false)}`,
                              position: isAr ? 'insideTopLeft' : 'insideTopRight',
                              fill: 'var(--go)',
                              fontSize: 10.5,
                              fontWeight: 700,
                            }}
                          />
                        )}
                        {requiredToday !== null && (
                          <ReferenceLine
                            y={requiredToday}
                            stroke="var(--wait)"
                            strokeDasharray="2 3"
                            strokeWidth={1.5}
                            label={{
                              value: isAr
                                ? `الوتيرة المطلوبة اليوم ${num(requiredToday, true)}`
                                : `Required pace today ${num(requiredToday, false)}`,
                              position: isAr ? 'insideTopRight' : 'insideTopLeft',
                              fill: 'var(--wait)',
                              fontSize: 10.5,
                              fontWeight: 700,
                            }}
                          />
                        )}
                        <Bar
                          dataKey="cum"
                          radius={[3, 3, 0, 0]}
                          isAnimationActive={false}
                          label={(props: unknown): JSX.Element => {
                            const { x, y, width, index, value } = props as {
                              x?: number; y?: number; width?: number; index?: number; value?: number;
                            };
                            if (
                              index !== cumulative.length - 1
                              || x === undefined || y === undefined || width === undefined || value === undefined
                            ) {
                              return <g />;
                            }
                            return (
                              <text
                                x={x + width / 2}
                                y={y - 6}
                                textAnchor="middle"
                                fontSize={11}
                                fontWeight={700}
                                fill="var(--terracotta)"
                              >
                                {num(value, isAr)}
                              </text>
                            );
                          }}
                        >
                          {cumulative.map((d, i) => (
                            <Cell
                              key={`${d.label}-${i}`}
                              fill={i >= cumulative.length - 2 ? 'var(--terracotta)' : 'var(--copper)'}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
                {target !== null && days && gap !== null && (
                  <div className="cd-gap">
                    {gap <= 0 ? (
                      <>
                        <b style={{ color: 'var(--go)' }}>{isAr ? 'لا فجوة.' : 'No gap.'}</b>{' '}
                        {isAr
                          ? `الحملة على الوتيرة المطلوبة — المعدل الحالي ${num(dailyRate, true)} ${goalUnitAr} يوميًا.`
                          : `The campaign is on the required pace — the current rate is ${num(dailyRate, false)} ${goalUnitEn} per day.`}
                      </>
                    ) : days.left === 0 ? (
                      <>
                        <b style={{ color: 'var(--late)' }}>
                          {isAr ? `الفجوة ${num(gap, true)} ${goalUnitAr}.` : `The gap is ${num(gap, false)} ${goalUnitEn}.`}
                        </b>{' '}
                        {isAr
                          ? `انتهت المدة عند ${num(goalProgress, true)} من ${num(target, true)}.`
                          : `The window closed at ${num(goalProgress, false)} of ${num(target, false)}.`}
                      </>
                    ) : (
                      <>
                        <b style={{ color: 'var(--late)' }}>
                          {isAr ? `الفجوة ${num(gap, true)} ${goalUnitAr}.` : `The gap is ${num(gap, false)} ${goalUnitEn}.`}
                        </b>{' '}
                        {isAr
                          ? <>لبلوغ الهدف يلزم {num(needDaily, true)} {goalUnitAr} يوميًا في الأيام الـ{num(days.left, true)} المتبقية، والمعدل الحالي {num(dailyRate, true)}.{' '}
                              {needDaily !== null && dailyRate !== null && needDaily > 2 * dailyRate
                                ? <>الهدف <b>غير قابل للتحقيق</b> بهذه الميزانية — والقرار الآن بين رفع الميزانية أو تعديل الهدف، لا انتظار نهاية الشهر.</>
                                : <>الهدف <b>ما زال ممكنًا</b> — إن ارتفعت الوتيرة الآن، لا في الأسبوع الأخير.</>}</>
                          : <>Reaching the target needs {num(needDaily, false)} {goalUnitEn} per day over the remaining {days.left} days; the current rate is {num(dailyRate, false)}.{' '}
                              {needDaily !== null && dailyRate !== null && needDaily > 2 * dailyRate
                                ? <>The target is <b>not reachable</b> on this budget — the decision now is raise the budget or amend the target, not wait for month-end.</>
                                : <>The target is <b>still reachable</b> — if the pace rises now, not in the final week.</>}</>}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Stacks to one column on phones — s52's rule: dashboards are
                stacked in priority order, never compressed. */}
            <div className="grid g3">
              <div className="card">
                <div className="card-h">
                  <h4>{isAr ? 'تكلفة العميل المؤهل' : 'Cost per qualified'}</h4>
                  <span className="r">{isAr ? 'أسبوعيًا' : 'weekly'}</span>
                </div>
                <div className="card-b">
                  {weekly.length === 0 ? (
                    <p style={{ fontSize: 12, color: 'var(--mute)', margin: 0 }}>
                      {isAr ? 'لا بيانات أسبوعية بعد.' : 'No weekly data yet.'}
                    </p>
                  ) : (
                    <>
                      <ResponsiveContainer width="100%" height={100}>
                        <BarChart data={weekly} margin={{ top: 2, left: 4, right: 4, bottom: 0 }}>
                          <XAxis
                            dataKey="label"
                            reversed={isAr}
                            tickLine={false}
                            axisLine={false}
                            tick={{ fontSize: 10, fill: 'var(--mute)' }}
                            interval={0}
                          />
                          <YAxis hide domain={[0, Math.max(...weekly.map((w) => w.v)) * 1.05]} />
                          <Bar dataKey="v" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                            {weekly.map((w, i) => <Cell key={i} fill={w.color} />)}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                      <div className="cd-week-note">
                        {(() => {
                          if (weekly.length < 2) {
                            return isAr ? 'أسبوع واحد فقط — لا اتجاه بعد.' : 'One week only — no trend yet.';
                          }
                          const rising = weekly.every((w, i) => i === 0 || w.v > (weekly[i - 1]?.v ?? 0));
                          const falling = weekly.every((w, i) => i === 0 || w.v < (weekly[i - 1]?.v ?? Number.POSITIVE_INFINITY));
                          if (rising) {
                            return isAr
                              ? 'تتصاعد أسبوعًا بعد أسبوع — علامة إرهاق جمهور، لا سوء إعلان.'
                              : 'Rising week after week — a sign of audience fatigue, not a bad ad.';
                          }
                          if (falling) {
                            return isAr
                              ? 'تنخفض أسبوعًا بعد أسبوع — الجمهور يستجيب بتكلفة أقل.'
                              : 'Falling week after week — the audience is responding at a lower cost.';
                          }
                          return isAr
                            ? 'متذبذبة أسبوعًا بعد أسبوع — لا اتجاه واضحًا بعد.'
                            : 'Oscillating week to week — no clear direction yet.';
                        })()}
                      </div>
                    </>
                  )}
                </div>
              </div>

              <div className="card">
                <div className="card-h"><h4>{isAr ? 'ما الذي تغيّر' : 'What changed'}</h4></div>
                <div className="card-b cd-events">
                  {events.length === 0 ? (
                    <div style={{ color: 'var(--mute)' }}>
                      {isAr ? 'لا تغييرات مسجلة بعد.' : 'No changes recorded yet.'}
                    </div>
                  ) : events.slice(0, 6).map((e) => (
                    <div key={e.id}>
                      <b>{shortDate(e.created_at, isAr)}</b> — {isAr ? e.summary_ar : e.summary_en ?? e.summary_ar}
                    </div>
                  ))}
                  <div className="auto">
                    {isAr
                      ? 'هذه العلامات تُلتقط تلقائيًا من تغيّرات الحملة نفسها، لا تُكتب يدويًا.'
                      : 'These marks are captured automatically from the campaign’s own changes — never written by hand.'}
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-h">
                  <h4>{isAr
                    ? (isOrganic ? 'ما بعد النشر' : 'ما بعد الإعلان')
                    : (isOrganic ? 'After publishing' : 'After the ad')}</h4>
                  <span className="r">
                    {isAr
                      ? (isOrganic ? 'من المنصات' : 'من نظام العملاء')
                      : (isOrganic ? 'from the platforms' : 'from the clients system')}
                  </span>
                </div>
                <div className="card-b" style={{ display: 'grid', gap: 8 }}>
                  {!isOrganic && outcomesError && (
                    <div style={{ fontSize: 11.5, color: 'var(--late)' }} role="alert">
                      {isAr ? 'تعذّر تحميل النتائج: ' : 'Outcomes failed to load: '}{outcomesError}
                    </div>
                  )}
                  {isOrganic ? (
                    <>
                      <div className="cd-kv"><span>{isAr ? 'المشاهدات' : 'Impressions'}</span><b>{num(organicReach.impressions, isAr)}</b></div>
                      <div className="cd-kv"><span>{isAr ? 'التفاعل' : 'Engagement'}</span><b>{num(organicReach.engagement, isAr)}</b></div>
                      <div className="cd-kv"><span>{isAr ? 'الإعجابات' : 'Likes'}</span><b>{num(organicReach.likes, isAr)}</b></div>
                      <div className="cd-kv"><span>{isAr ? 'التعليقات' : 'Comments'}</span><b>{num(organicReach.comments, isAr)}</b></div>
                      <div className="cd-kv"><span>{isAr ? 'الحفظ' : 'Saves'}</span><b>{num(organicReach.saves, isAr)}</b></div>
                      <div className="cd-kv top"><span>{isAr ? 'استفسارات' : 'Enquiries'}</span><b>{num(organicReach.enquiries, isAr)}</b></div>
                    </>
                  ) : (
                    <>
                      <div className="cd-kv"><span>{isAr ? 'مؤهلون' : 'Qualified'}</span><b>{num(item.total_qualified, isAr)}</b></div>
                      <div className="cd-kv"><span>{isAr ? 'مواعيد' : 'Appointments'}</span><b>{num(outcomes?.appointments ?? null, isAr)}</b></div>
                      <div className="cd-kv"><span>{isAr ? 'زيارات' : 'Visits'}</span><b>{num(outcomes?.visits ?? null, isAr)}</b></div>
                      <div className="cd-kv top"><span>{isAr ? 'حجوزات' : 'Reservations'}</span><b>{num(outcomes?.reservations ?? null, isAr)}</b></div>
                      <div className="cd-kv">
                        <span>{isAr ? 'تكلفة الحجز' : 'Cost per reservation'}</span>
                        <b>
                          {spend !== null && (outcomes?.reservations ?? 0) > 0
                            ? num(Math.round(spend / (outcomes?.reservations ?? 1)), isAr)
                            : '—'}
                        </b>
                      </div>
                      {gap !== null && gap > 0 && (outcomes?.reservations ?? 0) > 0 && (
                        <div className="cd-kv-note">
                          {isAr
                            ? <>رغم تعثّر هدف المؤهلين، الحجوزات تتحقق. <b>الهدف قد يكون هو الخطأ.</b></>
                            : <>The qualified target is slipping, yet reservations land. <b>The target may be the thing that’s wrong.</b></>}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* ── ملاحظات ────────────────────────────────────────────────── */}
        {tab === 'notes' && (
          <div className="card" style={{ maxWidth: 560 }}>
            <div className="card-b">
              <CommentThread
                target={{ campaignId: item.id }}
                comments={comments}
                tasks={[]}
                steps={[]}
                users={users}
                canComment={can('comment')}
                isAr={isAr}
                onChange={setComments}
              />
            </div>
          </div>
        )}
      </div>

      {briefEditing && (
        <BriefModal
          campaign={item}
          isAr={isAr}
          onClose={() => setBriefEditing(false)}
          onSaved={(c) => { setItem(c); setBriefEditing(false); void load(); }}
        />
      )}

      {(execEditing || execAdding) && campaignId && (
        <ExecutionModal
          campaignId={campaignId}
          execution={execEditing}
          content={content}
          isAr={isAr}
          onClose={() => { setExecEditing(null); setExecAdding(false); }}
          onSaved={(rows) => {
            setExecutions(rows);
            setExecEditing(null);
            setExecAdding(false);
            void enrich(rows);
            void refreshEvents();
          }}
        />
      )}

      {shift && campaignId && (
        <BudgetShiftModal
          campaignId={campaignId}
          executions={executions}
          preset={shift}
          isAr={isAr}
          pname={pname}
          onClose={() => setShift(null)}
          onDone={(rows) => {
            setExecutions(rows);
            setShift(null);
            void refreshEvents();
          }}
        />
      )}

      {linking && (
        <LinkContentModal
          campaignId={item.id}
          campaignRef={item.ref}
          existingIds={content.map((c) => c.id)}
          isAr={isAr}
          onClose={() => setLinking(false)}
          onLinked={() => { setLinking(false); void load(); }}
        />
      )}

      {pickDaily && (
        <Modal
          title={isAr ? 'إدخال أرقام اليوم' : 'Enter today’s numbers'}
          sub={isAr
            ? 'الأرقام اليومية تعيش على الحملة الإعلانية — اختر أيها تخصّه أرقام اليوم.'
            : 'Daily numbers live on the ad campaign — pick the one today’s numbers belong to.'}
          onClose={() => setPickDaily(false)}
        >
          <div className="cd-picklist">
            {executions.map((x) => (
              <button
                key={x.id}
                type="button"
                className="cd-pickrow"
                onClick={() => {
                  setPickDaily(false);
                  navigate(`/m/campaigns/${item.id}/exec/${x.id}?tab=daily`);
                }}
              >
                <span className="cd-dot" style={{ background: PLATFORM_DOT[x.platform] ?? 'var(--copper)' }} />
                <b>{pname(x.platform)}</b>
                {x.label && <span style={{ color: 'var(--mute)' }}>{x.label}</span>}
                <span style={{ marginInlineStart: 'auto', fontSize: 11.5, color: 'var(--mute)' }}>
                  {num(whole(x.spend), isAr)} / {num(whole(x.budget), isAr)}
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {addingContent && (
        <NewContentModal
          onClose={() => setAddingContent(false)}
          presetCampaign={item.id}
          presetProject={item.project_id}
          onCreated={(id) => navigate(`/m/content/${id}`)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* the brief — s15's goal card, editable                              */
/* ------------------------------------------------------------------ */

function BriefModal({
  campaign, isAr, onClose, onSaved,
}: {
  campaign: MosCampaign;
  isAr: boolean;
  onClose: () => void;
  onSaved: (campaign: MosCampaign) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [goal, setGoal] = useState(campaign.goal ?? campaign.name ?? '');
  const [goalIds, setGoalIds] = useState<string[]>(campaign.goal_ids ?? []);
  const [audienceId, setAudienceId] = useState<string | null>(campaign.audience_id ?? null);
  const [measures, setMeasures] = useState<MeasureDraft[]>(() => measuresToDrafts(campaign.success_measures));
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!goal.trim()) {
      addToast(
        isAr ? 'اكتب وصفًا للحملة — هو اسمها في القوائم.' : 'Write a description — it is the campaign’s name in lists.',
        'error',
      );
      return;
    }
    if (goalIds.length === 0) {
      addToast(
        isAr ? 'اربط الحملة بهدف واحد على الأقل.' : 'Link the campaign to at least one goal.',
        'error',
      );
      return;
    }
    setBusy(true);
    try {
      const res = await saveCampaign({
        id: campaign.id,
        goal: goal.trim(),
        name: goal.trim(),
        goal_ids: goalIds,
        // The saved audience is the source of truth; the server snapshots its name
        // into the `audience` text column. Sending null clears the link.
        audience_id: audienceId,
        success_measures: draftsToMeasures(measures),
      });
      addToast(isAr ? 'حُفظ الموجز.' : 'Brief saved.', 'success');
      onSaved(res.item);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isAr ? 'موجز الحملة' : 'The campaign brief'}
      sub={isAr
        ? 'وصف الحملة، ومن تخاطبه، وبأي عرض، وإلى أين يذهب.'
        : 'The campaign description, who it speaks to, with what offer, and where it lands.'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
          </button>
        </>
      }
    >
      <Field label={isAr ? 'الوصف — بماذا تُعرَّف الحملة' : 'Description — what the campaign is'}>
        <textarea className="inp" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} />
      </Field>
      <Field
        label={isAr ? 'الأهداف' : 'Goals'}
        hint={isAr ? 'هدف واحد على الأقل · متعدد' : 'at least one · multiple'}
      >
        <GoalMultiSelect value={goalIds} onChange={setGoalIds} isAr={isAr} />
      </Field>
      <SuccessMeasuresEditor measures={measures} onChange={setMeasures} isAr={isAr} />
      <Field label={isAr ? 'الجمهور' : 'Audience'}>
        <AudiencePicker
          audienceId={audienceId}
          legacyText={campaign.audience ?? null}
          onChange={setAudienceId}
          isAr={isAr}
        />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* the execution row — one per ad set, per platform                   */
/* ------------------------------------------------------------------ */

function ExecutionModal({
  campaignId, execution, content, isAr, onClose, onSaved,
}: {
  campaignId: string;
  execution: MosExecution | null;
  content: MosContentRow[];
  isAr: boolean;
  onClose: () => void;
  onSaved: (rows: MosExecution[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const { can } = useWorkspace();
  const [platform, setPlatform] = useState(execution?.platform ?? 'meta');
  // The one platform-settings field worth asking at creation time — the
  // platform's real objective enum. The full form lives on the detail page.
  const [objective, setObjective] = useState<string>(() => {
    const sch = getPlatformSchema(execution?.platform ?? 'meta');
    const s = execution?.platform_settings as PlatformSettings | null | undefined;
    if (sch && s) {
      const v = s[objectiveKeyOf(sch)];
      return typeof v === 'string' ? v : '';
    }
    return '';
  });
  const [label, setLabel] = useState(execution?.label ?? '');
  const [contentId, setContentId] = useState(execution?.content_id ?? '');
  const [status, setStatus] = useState<MosExecution['status']>(execution?.status ?? 'draft');
  const [purpose, setPurpose] = useState<string>(execution?.purpose ?? '');
  const [platformCampaignId, setPlatformCampaignId] = useState(execution?.platform_campaign_id ?? '');
  const [budget, setBudget] = useState(execution?.budget?.toString() ?? '');
  const [spend, setSpend] = useState(execution?.spend?.toString() ?? '');
  const [impressions, setImpressions] = useState(execution?.impressions?.toString() ?? '');
  const [clicks, setClicks] = useState(execution?.clicks?.toString() ?? '');
  const [leads, setLeads] = useState(execution?.leads?.toString() ?? '');
  const [qualified, setQualified] = useState(execution?.qualified?.toString() ?? '');
  const [busy, setBusy] = useState(false);

  // Blank is "not measured", not zero — same rule as the metric snapshots.
  const n = (s: string): number | null => (s.trim() === '' ? null : Number(s));

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      // Merge the objective into the stored settings without clobbering what
      // the detail-page form already captured; a fresh execution gets the
      // platform's seed defaults (e.g. Instagram-only placements).
      const schema = getPlatformSchema(platform);
      let platformSettings: PlatformSettings | undefined;
      if (schema) {
        const keep = execution && execution.platform === platform
          ? (execution.platform_settings as PlatformSettings | null) ?? null
          : null;
        platformSettings = { ...(keep ?? defaultPlatformSettings(platform)) };
        platformSettings[objectiveKeyOf(schema)] = objective || null;
      }
      const res = await saveExecution(campaignId, {
        id: execution?.id,
        platform,
        label: label || null,
        content_id: contentId || null,
        status,
        purpose: purpose || null,
        platform_campaign_id: platformCampaignId.trim() || null,
        budget: n(budget),
        spend: n(spend),
        impressions: n(impressions),
        clicks: n(clicks),
        leads: n(leads),
        qualified: n(qualified),
        ...(platformSettings ? { platform_settings: platformSettings } : {}),
      });
      addToast(isAr ? 'حُفظت الحملة الإعلانية.' : 'Ad campaign saved.', 'success');
      onSaved(res.executions);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!execution) return;
    setBusy(true);
    try {
      const res = await deleteExecution(campaignId, execution.id);
      addToast(isAr ? 'حُذفت الحملة الإعلانية.' : 'Ad campaign removed.', 'success');
      onSaved(res.executions);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={execution ? (isAr ? 'تعديل الحملة الإعلانية' : 'Edit ad campaign') : (isAr ? 'حملة إعلانية جديدة' : 'New ad campaign')}
      sub={isAr
        ? 'صف واحد لكل مجموعة إعلانية. الأرقام تُدخل يدويًا حتى تُربط المنصات.'
        : 'One row per ad set. Numbers are typed in by hand until the platforms are connected.'}
      onClose={onClose}
      wide
      footer={
        <>
          {execution && can('delete_records') && (
            <button type="button" className="btn btn-d" onClick={() => void remove()} disabled={busy}>
              {isAr ? 'حذف' : 'Delete'}
            </button>
          )}
          <span className="note">
            {isAr ? 'اترك أي خانة فارغة إن لم تُقس — الفارغ ليس صفرًا.' : 'Leave a box empty if it was not measured — empty is not zero.'}
          </span>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ الحفظ…' : 'Saving…') : isAr ? 'حفظ' : 'Save'}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'المنصة' : 'Platform'}>
          <select
            className="inp"
            value={platform}
            onChange={(e) => {
              setPlatform(e.target.value);
              // The objective enum belongs to the platform — a Meta value is
              // meaningless on TikTok, so a platform switch clears it.
              setObjective('');
            }}
          >
            {PLATFORMS.map((p) => (
              <option key={p} value={p}>
                {(isAr ? PLATFORM_LABELS[p]?.ar : PLATFORM_LABELS[p]?.en) ?? p}
              </option>
            ))}
          </select>
        </Field>
        {(() => {
          const sch = getPlatformSchema(platform);
          if (!sch) return null;
          const objField = sch.sections
            .flatMap((s) => s.fields)
            .find((f) => f.key === objectiveKeyOf(sch));
          if (!objField?.options) return null;
          return (
            <Field
              label={isAr ? 'هدف الحملة على المنصة' : 'Platform objective'}
              hint={isAr ? 'بقية الإعدادات من صفحة الحملة الإعلانية' : 'the rest is set on the ad-campaign page'}
            >
              <select className="inp" value={objective} onChange={(e) => setObjective(e.target.value)}>
                <option value="">{isAr ? 'غير محدد' : 'Not set'}</option>
                {objField.options.map((o) => (
                  <option key={o.value} value={o.value}>{isAr ? o.ar : o.en}</option>
                ))}
              </select>
            </Field>
          );
        })()}
        <Field label={isAr ? 'اسم المجموعة' : 'Ad set name'}>
          <input className="inp" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label={isAr ? 'الحالة' : 'Status'}>
          <select
            className="inp"
            value={status}
            onChange={(e) => setStatus(e.target.value as MosExecution['status'])}
          >
            {Object.keys(EXEC_STATUS_LABELS).map((k) => (
              <option key={k} value={k}>{isAr ? EXEC_STATUS_LABELS[k]?.ar : EXEC_STATUS_LABELS[k]?.en}</option>
            ))}
          </select>
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'الغرض' : 'Purpose'}>
          <select className="inp" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="">{isAr ? 'غير محدد' : 'Not specified'}</option>
            {Object.keys(PURPOSE_PILL_LABELS).map((k) => (
              <option key={k} value={k}>
                {isAr ? PURPOSE_PILL_LABELS[k]?.ar : PURPOSE_PILL_LABELS[k]?.en}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={isAr ? 'رقم الحملة على المنصة' : 'Platform campaign id'}
          hint={isAr ? 'ما يتيح سحب الأرقام آليًا لاحقًا' : undefined}
        >
          <input
            className="inp ltr"
            value={platformCampaignId}
            onChange={(e) => setPlatformCampaignId(e.target.value)}
          />
        </Field>
      </div>

      <Field label={isAr ? 'المحتوى الذي يعمل هنا' : 'The content running here'}>
        <select className="inp" value={contentId} onChange={(e) => setContentId(e.target.value)}>
          <option value="">{isAr ? 'غير محدد' : 'Not specified'}</option>
          {content.map((c) => (
            <option key={c.id} value={c.id}>{c.ref} · {c.title}</option>
          ))}
        </select>
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 13 }}>
        <Field label={isAr ? 'الميزانية' : 'Budget'}>
          <input className="inp" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </Field>
        <Field label={isAr ? 'المصروف' : 'Spent'}>
          <input className="inp" inputMode="numeric" value={spend} onChange={(e) => setSpend(e.target.value)} />
        </Field>
        <Field label={isAr ? 'الظهور' : 'Impressions'}>
          <input className="inp" inputMode="numeric" value={impressions} onChange={(e) => setImpressions(e.target.value)} />
        </Field>
        <Field label={isAr ? 'النقرات' : 'Clicks'}>
          <input className="inp" inputMode="numeric" value={clicks} onChange={(e) => setClicks(e.target.value)} />
        </Field>
        <Field label={isAr ? 'العملاء' : 'Leads'}>
          <input className="inp" inputMode="numeric" value={leads} onChange={(e) => setLeads(e.target.value)} />
        </Field>
        <Field label={isAr ? 'المؤهلون' : 'Qualified'}>
          <input className="inp" inputMode="numeric" value={qualified} onChange={(e) => setQualified(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* «تحويل الميزانية» — moves money between executions, logged          */
/* ------------------------------------------------------------------ */

function BudgetShiftModal({
  campaignId, executions, preset, isAr, pname, onClose, onDone,
}: {
  campaignId: string;
  executions: MosExecution[];
  preset: { from: string; to: string; amount: number | null };
  isAr: boolean;
  pname: (platform: string) => string;
  onClose: () => void;
  onDone: (rows: MosExecution[]) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [fromId, setFromId] = useState(preset.from);
  const [toId, setToId] = useState(preset.to);
  const [amount, setAmount] = useState(preset.amount !== null ? String(preset.amount) : '');
  const [busy, setBusy] = useState(false);

  const optionLabel = (x: MosExecution): string =>
    `${pname(x.platform)}${x.label ? ` — ${x.label}` : ''} · ${num(whole(x.spend), isAr)} / ${num(whole(x.budget), isAr)}`;

  const submit = async (): Promise<void> => {
    const value = Number(amount);
    if (!fromId || !toId || fromId === toId) {
      addToast(isAr ? 'اختر حملتين إعلانيتين مختلفتين.' : 'Pick two different ad campaigns.', 'error');
      return;
    }
    if (!Number.isFinite(value) || value <= 0) {
      addToast(isAr ? 'أدخل مبلغًا موجبًا.' : 'Enter a positive amount.', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await budgetShift(campaignId, fromId, toId, value);
      addToast(
        isAr ? 'حُوّلت الميزانية وسُجّلت في «ما الذي تغيّر».' : 'Budget shifted and recorded in the change ledger.',
        'success',
      );
      onDone(res.executions);
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isAr ? 'تحويل الميزانية' : 'Shift the budget'}
      sub={isAr
        ? 'ينقص من ميزانية حملة إعلانية ويزيد في أخرى — ويُسجَّل الحدث تلقائيًا.'
        : 'Takes from one ad campaign’s budget and adds to another — the event is logged automatically.'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {isAr ? 'إلغاء' : 'Cancel'}
          </button>
          <button type="button" className="btn btn-p" onClick={() => void submit()} disabled={busy}>
            {busy ? (isAr ? 'جارٍ التحويل…' : 'Shifting…') : isAr ? 'تحويل' : 'Shift'}
          </button>
        </>
      }
    >
      <Field label={isAr ? 'من' : 'From'}>
        <select className="inp" value={fromId} onChange={(e) => setFromId(e.target.value)}>
          <option value="">{isAr ? 'اختر الحملة الإعلانية المصدر' : 'Pick the source ad campaign'}</option>
          {executions.map((x) => (
            <option key={x.id} value={x.id}>{optionLabel(x)}</option>
          ))}
        </select>
      </Field>
      <Field label={isAr ? 'إلى' : 'To'}>
        <select className="inp" value={toId} onChange={(e) => setToId(e.target.value)}>
          <option value="">{isAr ? 'اختر الحملة الإعلانية الوجهة' : 'Pick the destination ad campaign'}</option>
          {executions.filter((x) => x.id !== fromId).map((x) => (
            <option key={x.id} value={x.id}>{optionLabel(x)}</option>
          ))}
        </select>
      </Field>
      <Field label={isAr ? 'المبلغ (ريال)' : 'Amount (SAR)'}>
        <input className="inp" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* «ربط محتوى قائم» — references, never copies (s39)                   */
/* ------------------------------------------------------------------ */

function LinkContentModal({
  campaignId, campaignRef, existingIds, isAr, onClose, onLinked,
}: {
  campaignId: string;
  campaignRef: string | null;
  existingIds: string[];
  isAr: boolean;
  onClose: () => void;
  onLinked: () => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [rows, setRows] = useState<MosContentRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchContentList({ limit: 300 });
        if (!cancelled) setRows(res.content.filter((c) => !existingIds.includes(c.id)));
      } catch (e) {
        console.error('[marketing] content list for link picker unavailable', e);
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
    // existingIds is a fresh array per render; the ids themselves only change with a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const link = async (row: MosContentRow): Promise<void> => {
    setBusyId(row.id);
    try {
      await updateContent(row.id, { campaign_id: campaignId });
      await addCampaignEvent(campaignId, {
        kind: 'content_linked',
        summary_ar: `رُبط «${row.ref ?? row.title}» بالحملة${campaignRef ? ` ${campaignRef}` : ''}.`,
        summary_en: `Linked "${row.ref ?? row.title}" to the campaign${campaignRef ? ` ${campaignRef}` : ''}.`,
        detail: { content_id: row.id },
      });
      addToast(isAr ? 'رُبط المحتوى — مُشار إليه، غير منسوخ.' : 'Content linked — referenced, never copied.', 'success');
      onLinked();
    } catch (e) {
      addToast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const needle = q.trim().toLowerCase();
  const filtered = (rows ?? []).filter((c) =>
    needle === ''
    || c.title.toLowerCase().includes(needle)
    || (c.ref ?? '').toLowerCase().includes(needle));

  return (
    <Modal
      title={isAr ? 'ربط محتوى قائم' : 'Link existing content'}
      sub={isAr
        ? 'الحملة تشير إلى المحتوى ولا تنسخه — والعنصر ينتقل إلى هذه الحملة.'
        : 'A campaign references content, never copies it — the item moves to this campaign.'}
      onClose={onClose}
    >
      <input
        className="inp"
        value={q}
        placeholder={isAr ? 'ابحث بالعنوان أو الرقم…' : 'Search by title or ref…'}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="cd-picklist" style={{ marginTop: 12 }}>
        {loadError ? (
          <div className="notice bad" role="alert">{loadError}</div>
        ) : rows === null ? (
          <Skeleton rows={4} />
        ) : filtered.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--mute)', textAlign: 'center', padding: 14 }}>
            {isAr ? 'لا نتائج.' : 'No results.'}
          </div>
        ) : filtered.map((c) => (
          <button
            key={c.id}
            type="button"
            className="cd-pickrow"
            disabled={busyId !== null}
            onClick={() => void link(c)}
          >
            <span className="id">{c.ref ?? '—'}</span>
            <span className="ttl" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {c.title}
            </span>
            {c.campaign_id && (
              <span className="tag tag-t" style={{ flex: 'none' }}>
                {isAr ? 'في حملة أخرى' : 'In another campaign'}
              </span>
            )}
            <span style={{ marginInlineStart: 'auto', flex: 'none', fontSize: 11.5, color: 'var(--copper)', fontWeight: 700 }}>
              {busyId === c.id ? (isAr ? 'جارٍ…' : '…') : isAr ? 'ربط' : 'Link'}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
