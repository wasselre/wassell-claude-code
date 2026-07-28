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
  type Campaign, type ContentItem, type ContentTask, type ContentStatus,
} from '@/lib/marketingMgmt/client';
import {
  fetchPortfolioMap, CAMPAIGN_STATUS_LABEL,
  type PlanRef, type MktGoal, type Initiative,
} from '@/lib/marketingMgmt/v2';
import { CampaignCard, type CardCtx } from './portfolio/cards';
import { RecordDrawer } from './portfolio/RecordDrawer';
import { err } from './portfolio/shared';

const STATUSES = ['draft', 'planned', 'active', 'paused', 'completed', 'cancelled'] as const;

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
  const [detail, setDetail] = useState<{ campaign: Campaign; content: ContentItem[]; tasks: ContentTask[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
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
    try { const r = await fetchCampaign(id); setDetail({ campaign: r.campaign, content: r.content, tasks: r.tasks }); }
    catch (e) { setError(err(e)); }
    finally { setBusy(false); }
  };

  const shown = useMemo(() => rows.filter((c) => {
    if (status && c.status !== status) return false;
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      if (!`${c.code} ${c.name_ar} ${c.name_en ?? ''}`.toLowerCase().includes(t)) return false;
    }
    return true;
  }), [rows, status, q]);

  const ctx: CardCtx = {
    isAr, users, goals, plans, initiatives: inits,
    onOpen: (_kind, id) => setOpen(id),
  };

  if (loading) return <Spinner label={isAr ? 'جارٍ التحميل…' : 'Loading…'} />;

  if (detail) {
    const c = detail.campaign;
    const published = detail.content.filter((x) => x.status === 'published').length;
    const pct = detail.content.length > 0 ? Math.round((published / detail.content.length) * 100) : null;
    return (
      <div className="space-y-4">
        <Button variant="secondary" onClick={() => setDetail(null)}>
          <ArrowLeft className={`h-4 w-4 ${isAr ? 'rotate-180' : ''}`} />{isAr ? 'كل الحملات' : 'All campaigns'}
        </Button>
        {error && <CaveatStrip>{error}</CaveatStrip>}
        <Section title={`${c.code} · ${isAr ? c.name_ar : (c.name_en ?? c.name_ar)}`}
          subtitle={lbl(CAMPAIGN_STATUS_LABEL, c.status, isAr)}
          right={<Button variant="secondary" onClick={() => setOpen(c.id)} disabled={busy}>
            {isAr ? 'تحرير' : 'Edit'}</Button>}>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-6">
            <Stat label={isAr ? 'المحتوى' : 'Content'} value={detail.content.length || null} />
            <Stat label={isAr ? 'نُشر' : 'Published'} value={published || null} />
            <Stat label={isAr ? 'الإنجاز' : 'Completion'} value={pct === null ? null : `${pct}%`}
              hint={pct === null ? (isAr ? 'لا محتوى مخطط' : 'no content planned') : undefined}
              tone={pct === null ? 'muted' : 'default'} />
            <Stat label={isAr ? 'المهام' : 'Tasks'} value={detail.tasks.length || null} />
            <Stat label={isAr ? 'هدف العملاء' : 'Lead target'} value={c.target_leads} />
            <Stat label={isAr ? 'الميزانية' : 'Budget'}
              value={c.budget === null ? null : Math.round(c.budget).toLocaleString()} />
          </div>
          <p className="mt-2 text-[11px] text-charcoal/45">
            {isAr ? 'الحالة والحقول الاستراتيجية تُحرَّر من نفس اللوحة المستخدمة في المحفظة.'
                  : 'Status and strategic fields are edited from the same panel the Portfolio uses.'}
          </p>
        </Section>
        <Section title={isAr ? 'محتوى الحملة' : 'Campaign content'}>
          {detail.content.length === 0 ? (
            <EmptyHint>{isAr ? 'لا محتوى مرتبط — أنشئ محتوى واربطه بهذه الحملة' : 'No linked content yet'}</EmptyHint>
          ) : (
            <ul className="divide-y divide-sand/40">
              {detail.content.map((it) => (
                <li key={it.id}>
                  <button type="button" onClick={() => onOpenContent(it.id)}
                    className="flex w-full items-center justify-between gap-2 py-2.5 text-start hover:bg-cream-light">
                    <span className="min-w-0 truncate text-[13px] text-charcoal">{it.content_number} · {it.title}</span>
                    <span className="shrink-0 text-[11.5px] text-charcoal/50">
                      {lbl(STATUS_LABEL as Record<string, { ar: string; en: string }>, it.status as ContentStatus, isAr)}
                    </span>
                  </button>
                </li>))}
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

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="relative">
            <Search className={`absolute top-2 h-3.5 w-3.5 text-charcoal/30 ${isAr ? 'right-2' : 'left-2'}`} />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={isAr ? 'بحث بالرمز أو الاسم' : 'Search by code or name'}
              className={`w-56 rounded-lg border border-sand/60 bg-white py-1.5 text-[12.5px] text-charcoal focus:border-copper focus:outline-none ${
                isAr ? 'pe-7 ps-2.5' : 'ps-7 pe-2.5'}`} />
          </span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}
            className="rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] text-charcoal focus:border-copper focus:outline-none">
            <option value="">{isAr ? 'كل الحالات' : 'Any status'}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{lbl(CAMPAIGN_STATUS_LABEL, s, isAr)}</option>)}
          </select>
          <span className="text-[11.5px] tabular-nums text-charcoal/45">
            {shown.length} / {rows.length}
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
