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
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import {
  CAMPAIGN_STATUS_LABELS, EXEC_PURPOSE_LABELS, MosCampaign,
  PLATFORM_LABELS, ROLE_LABELS, SUCCESS_METRIC_LABELS,
  fetchCampaignDetail, fetchCampaigns, fetchPublications, saveCampaign,
} from '@/lib/marketingOS/client';
import { useWorkspace } from './MarketingWorkspace';
import { Empty, Field, LoadError, Modal, PageHead, Pill, Skeleton, Stat, Tone } from './components/kit';
import { IconCampaigns, IconCheck, IconMetrics, IconPlus } from './components/icons';
import { num, shortDate } from './lib/format';

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

export default function CampaignsPage() {
  const { isAr, can, projects, projectName } = useWorkspace();
  const navigate = useNavigate();

  const [rows, setRows] = useState<MosCampaign[]>([]);
  const [platforms, setPlatforms] = useState<Map<string, string[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [statusF, setStatusF] = useState<StatusFilter>('all');
  const [kindF, setKindF] = useState<KindFilter>('all');
  const [projectF, setProjectF] = useState('');
  const [monthScope, setMonthScope] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = (await fetchCampaigns()).campaigns;
      setRows(list);
      // The platform sub-lines need each campaign's executions (paid) or its
      // content's publications (organic). Resolved in the background so the
      // table never waits on the N+1 detail calls.
      void resolvePlatforms(list)
        .then(setPlatforms)
        .catch((e: unknown) => console.error('campaign platform lines failed', e));
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
    && (!projectF || c.project_id === projectF),
  ), [rows, statusF, kindF, projectF]);

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
              <div className="card">
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
                        const plats = platforms.get(c.id);
                        const subLine = plats === undefined
                          ? ''
                          : plats.length > 0
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
                            <td>{c.project_id ? projectName(c.project_id) : (isAr ? 'كل المشاريع' : 'All projects')}</td>
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
 * The platform sub-line under each campaign name. Paid campaigns name their
 * executions' ad platforms; organic ones name the feeds their attributed
 * content publishes to. A campaign with neither reads «لم تُطلق».
 */
async function resolvePlatforms(list: MosCampaign[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const pubs = (await fetchPublications()).publications;
  await Promise.all(list.map(async (c) => {
    try {
      const d = await fetchCampaignDetail(c.id);
      const set = new Set<string>();
      if (c.kind === 'paid') {
        for (const x of d.executions) if (x.platform) set.add(x.platform);
      }
      if (set.size === 0) {
        const ids = new Set(d.content.map((r) => r.id));
        for (const p of pubs) {
          if (ids.has(p.content_id) && p.status !== 'cancelled' && p.platform) set.add(p.platform);
        }
      }
      map.set(c.id, Array.from(set));
    } catch (e) {
      // One campaign's detail failing must not blank the whole column — that
      // row's sub-line falls back to «لم تُطلق», and the failure stays loud.
      console.error(`campaign platforms failed for ${c.id}`, e);
    }
  }));
  return map;
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
  const { projects } = useWorkspace();
  const addToast = useAppStore((s) => s.addToast);
  const isNew = !campaign;

  const [kind, setKind] = useState<MosCampaign['kind']>(campaign?.kind ?? 'paid');
  const [goal, setGoal] = useState(campaign?.goal ?? campaign?.name ?? '');
  const [projectId, setProjectId] = useState(campaign?.project_id ?? '');
  const [ownerRole, setOwnerRole] = useState<string>(campaign?.owner_role ?? 'marketing_manager');
  const [startsOn, setStartsOn] = useState(campaign?.starts_on ?? '');
  const [endsOn, setEndsOn] = useState(campaign?.ends_on ?? '');
  const [budget, setBudget] = useState(campaign?.budget_total?.toString() ?? '');
  const [metric, setMetric] = useState(campaign?.success_metric ?? 'cpl_qualified');
  const [threshold, setThreshold] = useState(campaign?.success_threshold?.toString() ?? '');
  const [status, setStatus] = useState<MosCampaign['status']>(campaign?.status ?? 'planning');
  const [split, setSplit] = useState<Record<string, SplitRow>>(() =>
    Object.fromEntries(SPLIT_PLATFORMS.map((p) => [
      p,
      { on: p === 'meta', purpose: 'lead_form', budget: '' },
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
    setSplit((cur) => ({ ...cur, [p]: { ...(cur[p] ?? { on: false, purpose: 'lead_form', budget: '' }), ...patch } }));

  const submit = async (): Promise<void> => {
    if (!goal.trim()) {
      addToast(
        isAr ? 'اكتب الهدف كنتيجة — هو ما تُقاس به الحملة.' : 'Write the goal as a result — it is what the campaign is judged by.',
        'error',
      );
      return;
    }
    // The design's note: معيار النجاح إلزامي. A paid campaign without a
    // criterion cannot be judged, so the form refuses it up front.
    if (kind === 'paid' && threshold.trim() === '') {
      addToast(
        isAr ? 'حدّد معيار النجاح — حملة بلا معيار لا يمكن الحكم عليها.' : 'Set the success criterion — a campaign without one cannot be judged.',
        'error',
      );
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
          kind,
          project_id: projectId || null,
          owner_role: ownerRole || null,
          objective: kind === 'organic' ? 'awareness' : 'leads',
          status,
          starts_on: startsOn || null,
          ends_on: endsOn || null,
          budget_total: kind === 'paid' ? totalBudget : null,
          success_metric: metric || null,
          success_threshold: threshold.trim() === '' ? null : Number(threshold),
        },
        executions,
      );
      addToast(
        isNew
          ? isAr
            ? `أُنشئت الحملة ${res.item?.ref ?? ''} و${num(executions?.length ?? 0, true)} تنفيذات كمسودات.`
            : `Created campaign ${res.item?.ref ?? ''} with ${executions?.length ?? 0} draft executions.`
          : isAr ? 'حُفظت الحملة.' : 'Campaign saved.',
        'success',
      );
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
        ? 'هدف، ومدة، والمنصات التي ستعمل عليها. تُنشأ التنفيذات كمسودات.'
        : 'A goal, a duration, and the platforms it runs on. Executions are created as drafts.'}
      onClose={onClose}
      footer={
        <>
          <span className="note">
            {isAr
              ? 'لا شيء ينفق مالًا هنا. التنفيذات مسودات حتى يطلقها أحد على المنصة نفسها.'
              : 'Nothing here spends money. Executions stay drafts until someone launches them on the platform itself.'}
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
          {isAr ? 'الهدف — اكتبه كنتيجة' : 'The goal — write it as a result'}
        </div>
        <input
          className="inp"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          autoFocus={isNew}
          placeholder={isAr ? '١٥٠ عميلًا مؤهلًا لمينا ٥٢ خلال أغسطس' : '150 qualified leads for Mina 52 during August'}
        />
        <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 5 }}>
          {isAr
            ? 'هذا يصبح الهدف الذي تُقاس به الحملة. «زيادة الوعي» ليست هدفًا.'
            : 'This becomes what the campaign is measured against. “Raise awareness” is not a goal.'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 13 }}>
        <Field label={isAr ? 'المشروع' : 'Project'}>
          <select className="inp" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{isAr ? 'بدون' : 'None'}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.project_name ?? p.id.slice(0, 8)}</option>
            ))}
          </select>
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
            {isAr ? 'التنفيذات التي ستُنشأ' : 'The executions this will create'}
          </div>
          <div style={{ border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 38 }} />
                  <th>{isAr ? 'المنصة' : 'Platform'}</th>
                  <th style={{ width: 130 }}>{isAr ? 'الغرض' : 'Purpose'}</th>
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

      <div>
        <div className="lbl" style={{ marginBottom: 6 }}>{isAr ? 'معيار النجاح' : 'Success criterion'}</div>
        <div style={{ display: 'flex', gap: 11, flexWrap: 'wrap' }}>
          <select className="inp" style={{ flex: 1, minWidth: 180 }} value={metric} onChange={(e) => setMetric(e.target.value)}>
            {Object.keys(SUCCESS_METRIC_LABELS).map((k) => (
              <option key={k} value={k}>
                {isAr ? SUCCESS_METRIC_LABELS[k]?.ar : SUCCESS_METRIC_LABELS[k]?.en}
              </option>
            ))}
          </select>
          <div className="inp inp-row" style={{ width: 170, padding: 0 }}>
            <input
              className="inp"
              style={{ border: 0, flex: 1 }}
              inputMode="numeric"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
            <span style={{ fontSize: 11, color: 'var(--mute)', paddingInlineEnd: 11, whiteSpace: 'nowrap' }}>
              {metric === 'leads' || metric === 'reach'
                ? isAr ? 'أو أكثر' : 'or more'
                : isAr ? 'ريال أو أقل' : 'SAR or less'}
            </span>
          </div>
        </div>
      </div>

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
                ? `، و${num(chosen.length, true)} تنفيذات كمسودات`
                : `, and ${chosen.length} draft executions`}
            </>
          )}
          {isAr
            ? '، وهدف يُقاس بمعياره أعلاه.'
            : ', and a goal judged by the criterion above.'}
          <br />
          {isAr
            ? 'لا يُربط أي محتوى بعد؛ يُنسب المحتوى القائم من تبويب المحتوى.'
            : 'No content is linked yet; existing content is attributed from the Content tab.'}
        </div>
      )}
    </Modal>
  );
}
