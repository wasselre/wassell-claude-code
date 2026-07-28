/**
 * Campaigns — the EXECUTION view of the same campaign records the Portfolio
 * shows strategically.
 *
 * There is one campaign table, one classification, one set of API actions and
 * one edit component. This screen and the Portfolio differ only in the question
 * they answer:
 *
 *   Portfolio  how does this ladder up — plan, goal, initiative, portfolio health
 *   Campaigns  what is running right now — status, content, delivery
 *
 * This tab used to have its OWN create form, which asked the user to invent a
 * code and never asked for a plan, a goal or an organic/paid type. That was the
 * second creation path, and it is the reason the portfolio filled with campaigns
 * attached to nothing. Creation now happens in one place; this screen sends you
 * there rather than quietly making a different kind of campaign.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Plus, Search } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { Section, Stat, EmptyHint, Spinner, CaveatStrip }
  from '@/pages/MarketingIntelligence/components/shared';
import { lbl } from '@/lib/marketingMgmt/labels';
import {
  fetchCampaign, STATUS_LABEL,
  type Campaign, type ContentStatus, type CampaignContentRow,
} from '@/lib/marketingMgmt/client';
import {
  fetchPortfolioMap, CAMPAIGN_STATUS_LABEL, CAMPAIGN_CLASS_LABEL, CAMPAIGN_PURPOSE_LABEL,
  PLAN_STATUS_LABEL,
  type PlanRef, type MktGoal, type Initiative,
} from '@/lib/marketingMgmt/v2';
import { CampaignCard, type CardCtx } from './portfolio/cards';
import { RecordDrawer } from './portfolio/RecordDrawer';
import { CampaignProgressBlock } from './portfolio/progress';
import { CampaignStatusBar } from './portfolio/StatusBar';
import { err } from './portfolio/shared';

const STATUSES = ['draft', 'planned', 'active', 'paused', 'completed', 'cancelled', 'archived'] as const;

/** The list tabs. `needs` and `archived` are views, not statuses — a campaign
 *  needing attention can be in any live status, which is exactly why it needs
 *  its own tab rather than being buried in "All". */
type Tab = 'all' | 'organic' | 'paid' | 'active' | 'needs' | 'archived';

type Detail = Awaited<ReturnType<typeof fetchCampaign>>;

/** A content group that says WHY these items belong to the campaign. Merging
 *  them invisibly is how "campaign content" stopped meaning anything. */
function ContentGroup({ title, hint, rows, isAr, onOpen }: {
  title: string; hint: string; rows: CampaignContentRow[]; isAr: boolean;
  onOpen: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-2">
        <h4 className="text-[12px] font-semibold text-charcoal/70">{title}</h4>
        <span className="text-[11px] tabular-nums text-charcoal/40">{rows.length}</span>
      </div>
      <p className="mb-1.5 text-[10.5px] leading-snug text-charcoal/45">{hint}</p>
      <ul className="divide-y divide-sand/40 rounded-lg border border-sand/50 bg-white">
        {rows.map((it) => (
          <li key={`${it.id}-${it.usage_id ?? 'own'}`}>
            <button type="button" onClick={() => onOpen(it.id)}
              className="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-start hover:bg-cream-light">
              <span className="min-w-0 truncate text-[12.5px] text-charcoal">
                {it.content_number} · {it.title}
              </span>
              <span className="shrink-0 text-[11px] text-charcoal/50">
                {lbl(STATUS_LABEL as Record<string, { ar: string; en: string }>, it.status as ContentStatus, isAr)}
              </span>
            </button>
          </li>))}
      </ul>
    </div>
  );
}

export default function CampaignsTab({ isAr, onOpenContent, onGoToPortfolio }: {
  isAr: boolean;
  onOpenContent: (id: string) => void;
  /** Creation lives in the Portfolio, which is the only place that can ask for
   *  a plan and a goal. This screen points there instead of forking the path. */
  onGoToPortfolio?: () => void;
}) {
  const { users, addToast } = useAppStore();
  const [rows, setRows] = useState<Campaign[]>([]);
  const [plans, setPlans] = useState<PlanRef[]>([]);
  const [goals, setGoals] = useState<MktGoal[]>([]);
  const [inits, setInits] = useState<Initiative[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [status, setStatus] = useState<string>('');
  const [planId, setPlanId] = useState<string>('');
  const [purpose, setPurpose] = useState<string>('');
  const [owner, setOwner] = useState<string>('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback((spinner = false) => {
    if (spinner) setLoading(true);
    setError(null);
    // The SAME payload the Portfolio reads, so the two screens cannot disagree
    // about a campaign's class, plan or goal.
    fetchPortfolioMap()
      .then((r) => { setRows(r.campaigns); setPlans(r.plans); setGoals(r.goals); setInits(r.initiatives); })
      .catch((e) => setError(err(e)))
      .finally(() => { if (spinner) setLoading(false); });
  }, []);
  useEffect(() => { load(true); }, [load]);

  const openDetail = async (id: string) => {
    setBusy(true);
    try { setDetail(await fetchCampaign(id)); }
    catch (e) { setError(err(e)); }
    finally { setBusy(false); }
  };

  /** The plan this screen is operating under. Defaults to the ACTIVE plan, so
   *  opening Campaigns lands on what is actually running rather than on every
   *  campaign ever created. */
  const activePlan = useMemo(
    () => plans.find((p) => p.status === 'active') ?? null, [plans]);
  useEffect(() => { if (!planId && activePlan) setPlanId(activePlan.id); }, [activePlan, planId]);
  const plan = plans.find((p) => p.id === planId) ?? null;

  const goalName = (id: string | null | undefined) =>
    goals.find((g) => g.id === id)?.name_ar ?? '';
  const initName = (id: string | null | undefined) =>
    inits.find((i) => i.id === id)?.name_ar ?? '';

  /** Archived campaigns are excluded everywhere except their own tab: they are
   *  history, and leaving them in "All" makes every count read high. */
  const scoped = useMemo(() => rows.filter((c) => {
    if (planId && c.plan_id !== planId) return false;
    return true;
  }), [rows, planId]);

  const shown = useMemo(() => scoped.filter((c) => {
    const archived = c.status === 'archived';
    if (tab === 'archived') { if (!archived) return false; }
    else if (archived) return false;

    if (tab === 'organic' && c.campaign_class !== 'organic') return false;
    if (tab === 'paid' && c.campaign_class !== 'paid') return false;
    if (tab === 'active' && c.status !== 'active') return false;
    if (tab === 'needs' && !(c.needs_classification || !c.campaign_class)) return false;

    if (status && c.status !== status) return false;
    if (purpose && c.campaign_type !== purpose) return false;
    if (owner && c.owner_user_id !== owner) return false;
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      const hay = `${c.code} ${c.name_ar} ${c.name_en ?? ''} ${goalName(c.primary_goal_id)} ${initName(c.initiative_id)}`;
      if (!hay.toLowerCase().includes(t)) return false;
    }
    return true;
  }), [scoped, tab, status, purpose, owner, q, goals, inits]);

  const counts = useMemo(() => {
    const live = scoped.filter((c) => c.status !== 'archived');
    return {
      organic: live.filter((c) => c.campaign_class === 'organic').length,
      paid: live.filter((c) => c.campaign_class === 'paid').length,
      active: live.filter((c) => c.status === 'active').length,
      planned: live.filter((c) => c.status === 'planned').length,
      needs: live.filter((c) => c.needs_classification || !c.campaign_class).length,
      archived: scoped.filter((c) => c.status === 'archived').length,
    };
  }, [scoped]);

  const ctx: CardCtx = {
    isAr, users, goals, plans, initiatives: inits,
    onOpen: (_kind, id) => setOpen(id),
  };

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;

  if (detail) {
    const c = detail.campaign;
    const k = detail.counts;
    const owner = users.find((u) => u.id === c.owner_user_id);
    return (
      <div className="space-y-4">
        <Button variant="secondary" onClick={() => setDetail(null)}>
          <ArrowLeft className={`h-4 w-4 ${isAr ? 'rotate-180' : ''}`} />{isAr ? 'كل الحملات' : 'All campaigns'}
        </Button>
        {error && <CaveatStrip>{error}</CaveatStrip>}

        <Section title={`${c.code} · ${isAr ? c.name_ar : (c.name_en ?? c.name_ar)}`}
          subtitle={[
            lbl(CAMPAIGN_CLASS_LABEL, c.campaign_class ?? '', isAr) || (isAr ? 'النوع غير محدد' : 'Class not set'),
            c.campaign_type ? lbl(CAMPAIGN_PURPOSE_LABEL, c.campaign_type, isAr) : (isAr ? 'الغرض غير محدد' : 'Purpose not set'),
          ].join(' · ')}
          right={<Button variant="secondary" onClick={() => setOpen(c.id)} disabled={busy}>
            {isAr ? 'تحرير' : 'Edit'}</Button>}>

          <div className="mb-3">
            <CampaignStatusBar campaignId={c.id} status={c.status} next={detail.next_statuses}
              isAr={isAr} onChanged={() => { load(); void openDetail(c.id); }}
              onError={(m) => addToast(m, 'error')} onToast={(m) => addToast(m, 'success')} />
          </div>

          {/* Three measures, never one percentage. Each says what it does not
              know rather than rendering an unearned zero. */}
          <CampaignProgressBlock progress={detail.progress} isAr={isAr} />

          <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Stat label={isAr ? 'المسؤول' : 'Owner'}
              value={owner ? ((isAr ? owner.name_ar : owner.name_en) || owner.name_en) : null}
              hint={owner ? undefined : (isAr ? 'غير محدد' : 'unassigned')} />
            <Stat label={isAr ? 'الفترة' : 'Period'}
              value={c.start_date && c.end_date ? `${c.start_date} → ${c.end_date}` : null} />
            <Stat label={isAr ? 'محتوى فريد' : 'Unique content'} value={k ? k.unique_content_count : null} />
            {c.campaign_class === 'paid' && (
              <Stat label={isAr ? 'الميزانية' : 'Budget'}
                value={c.budget === null || c.budget === undefined ? null : Math.round(c.budget).toLocaleString()} />
            )}
          </div>

          {c.objective && (
            <p className="mt-3 rounded-lg border border-sand/50 bg-cream-light px-3 py-2 text-[12.5px] leading-relaxed text-charcoal/75">
              <span className="block text-[10.5px] font-medium uppercase tracking-wide text-charcoal/45">
                {isAr ? 'الهدف التجاري' : 'Business objective'}
              </span>
              {c.objective}
            </p>
          )}
        </Section>

        <Section title={isAr ? 'محتوى الحملة' : 'Campaign content'}
          subtitle={k ? (isAr
            ? `${k.unique_content_count} عنصراً فريداً · منتج ${k.produced_content_count} · معاد استخدامه ${k.reused_content_count} · قديم ${k.legacy_content_count} · إبداعات مدفوعة ${k.paid_creative_count}`
            : `${k.unique_content_count} unique · ${k.produced_content_count} produced · ${k.reused_content_count} reused · ${k.legacy_content_count} legacy · ${k.paid_creative_count} paid creatives`)
            : undefined}>
          {detail.content.length === 0 ? (
            <EmptyHint>{isAr ? 'لا محتوى مرتبط — أنشئ محتوى واربطه بهذه الحملة' : 'No linked content yet'}</EmptyHint>
          ) : (
            <div className="space-y-3">
              <ContentGroup isAr={isAr} onOpen={onOpenContent} rows={detail.produced_content}
                title={isAr ? 'أُنتج لهذه الحملة' : 'Produced for this campaign'}
                hint={isAr ? 'مصدره الأصلي هذه الحملة.' : 'This campaign is its production origin.'} />
              <ContentGroup isAr={isAr} onOpen={onOpenContent} rows={detail.reused_content}
                title={isAr ? 'أُعيد استخدامه هنا' : 'Reused by this campaign'}
                hint={isAr ? 'أُنتج في مكان آخر واستُخدم هنا — المصدر الأصلي لا يتغير.'
                           : 'Produced elsewhere and used here; its origin is unchanged.'} />
              <ContentGroup isAr={isAr} onOpen={onOpenContent} rows={detail.legacy_content}
                title={isAr ? 'ارتباط قديم' : 'Legacy-linked'}
                hint={isAr ? 'مرتبط بالحقل القديم campaign_id قبل فصل المصدر عن الاستخدام.'
                           : 'Linked through the old campaign_id, before origin and usage were separated.'} />
            </div>
          )}
        </Section>

        <Section title={isAr ? 'سجل الحالات' : 'Status history'}
          subtitle={isAr ? 'سجل غير قابل للتعديل أو الحذف' : 'Append-only — never edited or deleted'}>
          {detail.status_history.length === 0 ? (
            <EmptyHint>{isAr ? 'لا سجل بعد' : 'No history yet'}</EmptyHint>
          ) : (
            <ul className="space-y-1.5">
              {detail.status_history.map((h) => {
                const u = users.find((x) => x.id === h.changed_by_user_id);
                return (
                  <li key={h.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-sand/50 bg-white px-2.5 py-1.5 text-[11.5px]">
                    <span className="text-charcoal/45">
                      {h.from_status ? lbl(CAMPAIGN_STATUS_LABEL, h.from_status, isAr) : (isAr ? 'أُنشئت' : 'created')}
                    </span>
                    <span className="text-charcoal/30">→</span>
                    <span className="font-medium text-charcoal">{lbl(CAMPAIGN_STATUS_LABEL, h.to_status, isAr)}</span>
                    <span className="text-charcoal/40">
                      {new Date(h.changed_at).toLocaleString(isAr ? 'ar-SA' : 'en-GB')}
                      {u ? ` · ${(isAr ? u.name_ar : u.name_en) || u.name_en}` : ''}
                    </span>
                  </li>);
              })}
            </ul>
          )}
        </Section>

        <RecordDrawer target={open ? { kind: 'campaign', id: open } : null} isAr={isAr}
          plans={plans} goals={goals} initiatives={inits}
          onClose={() => setOpen(null)} onChanged={() => { load(); void openDetail(c.id); }}
          onError={(m) => addToast(m, 'error')} onToast={(m) => addToast(m, 'success')} />
      </div>
    );
  }

  return (
    <>
      <Section title={isAr ? 'الحملات' : 'Campaigns'}
        subtitle={isAr ? 'نفس سجلات المحفظة — هذه الشاشة للتشغيل اليومي، والمحفظة للهيكل الاستراتيجي'
                       : 'The same records as the Portfolio — this screen is day-to-day execution, the Portfolio is the strategic structure'}
        right={onGoToPortfolio && (
          <Button variant="secondary" onClick={onGoToPortfolio}>
            <Plus className="h-4 w-4" />{isAr ? 'حملة جديدة (من المحفظة)' : 'New campaign (in Portfolio)'}
          </Button>)}>
        {error && <div className="mb-3"><CaveatStrip>{error}</CaveatStrip></div>}

        {/* Plan context. Campaigns are executed INSIDE a plan period, so the
            screen states which plan it is showing rather than mixing every plan
            into one list and leaving the counts unattributable. */}
        <div className="mb-3 rounded-xl border border-sand/50 bg-cream-light px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <select value={planId} onChange={(e) => setPlanId(e.target.value)}
              className="rounded-lg border border-sand/60 bg-white px-2.5 py-1 text-[12.5px] font-medium text-charcoal focus:border-copper focus:outline-none">
              <option value="">{isAr ? 'كل الخطط' : 'All plans'}</option>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name_ar}{activePlan && p.id === activePlan.id ? (isAr ? ' (النشطة)' : ' (active)') : ''}
                </option>))}
            </select>
            {plan ? (
              <span className="text-[11.5px] text-charcoal/55">
                {plan.period_start} → {plan.period_end}
                <span className="mx-1.5 text-charcoal/25">·</span>
                {lbl(PLAN_STATUS_LABEL, plan.status, isAr)}
              </span>
            ) : (
              <span className="text-[11.5px] text-charcoal/40">
                {isAr ? 'بلا سياق خطة — تُعرض كل الحملات' : 'No plan context — showing every campaign'}
              </span>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] tabular-nums text-charcoal/60">
            <span>{isAr ? 'عضوية' : 'Organic'} <b className="text-charcoal">{counts.organic}</b></span>
            <span>{isAr ? 'مدفوعة' : 'Paid'} <b className="text-charcoal">{counts.paid}</b></span>
            <span>{isAr ? 'نشطة' : 'Active'} <b className="text-charcoal">{counts.active}</b></span>
            <span>{isAr ? 'مخططة' : 'Planned'} <b className="text-charcoal">{counts.planned}</b></span>
            <span className={counts.needs > 0 ? 'text-amber-700' : ''}>
              {isAr ? 'تحتاج انتباهاً' : 'Need attention'} <b>{counts.needs}</b>
            </span>
          </div>
        </div>

        <div className="mb-2 flex flex-wrap gap-1">
          {([
            ['all', isAr ? 'الكل' : 'All', null],
            ['organic', isAr ? 'عضوية' : 'Organic', counts.organic],
            ['paid', isAr ? 'مدفوعة' : 'Paid', counts.paid],
            ['active', isAr ? 'نشطة' : 'Active', counts.active],
            ['needs', isAr ? 'تحتاج انتباهاً' : 'Needs attention', counts.needs],
            ['archived', isAr ? 'مؤرشفة' : 'Archived', counts.archived],
          ] as const).map(([k, label, n]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={`rounded-full px-2.5 py-1 text-[11.5px] font-medium transition ${
                tab === k ? 'bg-copper text-white' : 'bg-cream-light text-charcoal/60 hover:bg-sand/30'}`}>
              {label}{n !== null ? ` ${n}` : ''}
            </button>))}
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="relative">
            <Search className={`absolute top-2 h-3.5 w-3.5 text-charcoal/30 ${isAr ? 'right-2' : 'left-2'}`} />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={isAr ? 'بحث بالرمز أو الاسم أو الهدف أو المبادرة' : 'Search code, name, goal or initiative'}
              className={`w-64 rounded-lg border border-sand/60 bg-white py-1.5 text-[12.5px] text-charcoal focus:border-copper focus:outline-none ${
                isAr ? 'pe-7 ps-2.5' : 'ps-7 pe-2.5'}`} />
          </span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] text-charcoal focus:border-copper focus:outline-none">
            <option value="">{isAr ? 'كل الحالات' : 'Any status'}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{lbl(CAMPAIGN_STATUS_LABEL, s, isAr)}</option>)}
          </select>
          <select value={purpose} onChange={(e) => setPurpose(e.target.value)}
            className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] text-charcoal focus:border-copper focus:outline-none">
            <option value="">{isAr ? 'كل الأغراض' : 'Any purpose'}</option>
            {Object.keys(CAMPAIGN_PURPOSE_LABEL).map((p) => (
              <option key={p} value={p}>{lbl(CAMPAIGN_PURPOSE_LABEL, p, isAr)}</option>))}
          </select>
          <select value={owner} onChange={(e) => setOwner(e.target.value)}
            className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] text-charcoal focus:border-copper focus:outline-none">
            <option value="">{isAr ? 'كل المسؤولين' : 'Any owner'}</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.name_en}</option>))}
          </select>
          <span className="text-[11.5px] tabular-nums text-charcoal/45">
            {shown.length} / {scoped.length}
          </span>
        </div>

        {shown.length === 0 ? (
          <EmptyHint>{isAr ? 'لا حملات مطابقة' : 'No matching campaigns'}</EmptyHint>
        ) : (
          <div className="space-y-2">
            {shown.map((c) => (
              <div key={c.id} className="relative">
                <CampaignCard c={c} ctx={ctx} />
                <button type="button" onClick={() => void openDetail(c.id)} disabled={busy}
                  className={`absolute top-2 text-[11px] font-medium text-copper hover:underline disabled:opacity-40 ${
                    isAr ? 'left-3' : 'right-3'}`}>
                  {isAr ? 'التشغيل' : 'Execution'}
                </button>
              </div>))}
          </div>
        )}
      </Section>

      <RecordDrawer target={open ? { kind: 'campaign', id: open } : null} isAr={isAr}
        plans={plans} goals={goals} initiatives={inits}
        onClose={() => setOpen(null)} onChanged={load}
        onError={(m) => addToast(m, 'error')} onToast={(m) => addToast(m, 'success')} />
    </>
  );
}
