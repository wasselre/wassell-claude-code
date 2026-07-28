/**
 * Strategic context on a content item: plan, goal, pillar, purpose, and the ONE
 * production origin — plus the usage links that record reuse.
 *
 * Origin is fixed at creation and reuse never rewrites it. A video made by the
 * Weekly Analytics program, posted organically and later run as a paid ad, still
 * has origin = that program; the paid run is a usage row. Rewriting the origin
 * would erase which part of the operation actually produced the thing.
 *
 * The approval gate is shown live: the database returns exactly what is missing,
 * and this panel lists it in the user's language instead of letting the user
 * discover it as a rejection.
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Link2, Plus } from 'lucide-react';
import Button from '@/components/ui/Button';
import { Section } from '@/pages/MarketingIntelligence/components/shared';
import { lbl } from '@/lib/marketingMgmt/labels';
import {
  fetchPlanningOverview, fetchPortfolio, fetchPillars, fetchMissingContext, addContentUsage,
  MISSING_CONTEXT_LABEL, ORIGIN_KIND_LABEL, GOAL_CATEGORY_LABEL,
  type MktPlan, type MktGoal, type Initiative, type Program, type ContentPillar,
} from '@/lib/marketingMgmt/v2';
import { updateContent, type ContentItem, type Campaign } from '@/lib/marketingMgmt/client';

const FIELD = 'w-full rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] '
  + 'text-charcoal focus:border-copper focus:outline-none';
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Item = ContentItem & {
  plan_id?: string | null; primary_goal_id?: string | null; primary_pillar_id?: string | null;
  strategic_purpose?: string | null; origin_kind?: string | null;
  origin_program_id?: string | null; origin_campaign_id?: string | null;
  reactive_trigger?: string | null;
};

export function ContentContextPanel({ item, isAr, onSaved, onError }: {
  item: Item; isAr: boolean;
  /** The UPDATED row, merged in place by the page — no refetch per field. */
  onSaved: (updated: ContentItem) => void;
  onError: (m: string) => void;
}) {
  const [plans, setPlans] = useState<MktPlan[]>([]);
  const [goals, setGoals] = useState<MktGoal[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [initiatives, setInitiatives] = useState<Initiative[]>([]);
  const [pillars, setPillars] = useState<ContentPillar[]>([]);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [uf, setUf] = useState<Record<string, string>>({ usage_kind: 'paid_ad' });

  useEffect(() => {
    fetchPlanningOverview().then((o) => {
      setPlans(o.plans);
      setGoals(o.plans.flatMap((p) => p.mkt_goals ?? []));
    }).catch(() => {});
    fetchPortfolio().then((p) => {
      setPrograms(p.programs); setCampaigns(p.campaigns); setInitiatives(p.initiatives);
    }).catch(() => {});
    fetchPillars().then((r) => setPillars(r.pillars)).catch(() => {});
  }, []);

  const refreshMissing = useCallback(() => {
    fetchMissingContext(item.id).then((r) => setMissing(r.missing)).catch(() => setMissing(null));
  }, [item.id]);
  // Re-check the gate whenever a context field changes, not on a timestamp the
  // type does not carry. These are exactly the inputs mkt_content_missing_context
  // reads, so the list stays in step with what the database would say.
  useEffect(refreshMissing, [refreshMissing, item.plan_id, item.primary_goal_id,
    item.primary_pillar_id, item.strategic_purpose, item.origin_kind,
    item.target_audience, item.cta_destination, item.cta]);

  const save = async (patch: Record<string, unknown>, key: string) => {
    setSaving((s) => new Set(s).add(key));
    try { const r = await updateContent(item.id, patch); onSaved(r.item); refreshMissing(); }
    catch (e) { onError(err(e)); }
    finally { setSaving((s) => { const n = new Set(s); n.delete(key); return n; }); }
  };

  /** Origin is one choice: setting a kind clears the FK that no longer applies,
   *  because the database CHECK requires the label and the reference to agree. */
  const setOrigin = (kind: string, ref?: string) => {
    void save({
      origin_kind: kind || null,
      origin_program_id: kind === 'program' ? (ref ?? item.origin_program_id ?? null) : null,
      origin_campaign_id: kind === 'campaign' ? (ref ?? item.origin_campaign_id ?? null) : null,
    }, 'origin');
  };

  const addUsage = async () => {
    if (!uf.target) return;
    const [k, id] = uf.target.split(':');
    try {
      await addContentUsage({
        content_item_id: item.id, usage_kind: uf.usage_kind,
        campaign_id: k === 'camp' ? id : null,
        program_id: k === 'prog' ? id : null,
        initiative_id: k === 'init' ? id : null,
        note: uf.note || null,
      });
      // A usage link is not part of the content row, so there is nothing to
      // merge and nothing to refetch. The form closing is the confirmation.
      setAdding(false); setUf({ usage_kind: 'paid_ad' });
    } catch (e) { onError(err(e)); }
  };

  const planGoals = goals.filter((g) => !item.plan_id || g.plan_id === item.plan_id);
  const dot = (k: string) => saving.has(k) ? <span className="ms-1 text-copper">•</span> : null;

  return (
    <Section title={isAr ? 'السياق الاستراتيجي' : 'Strategic context'}
      subtitle={isAr ? 'مصدر إنتاج واحد يُثبَّت عند الإنشاء — إعادة الاستخدام تُسجَّل ولا تغيّره'
                     : 'One production origin, fixed at creation — reuse is recorded and never rewrites it'}>

      {missing !== null && (
        missing.length === 0 ? (
          <div className="mb-3 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-2.5 text-[12.5px] text-emerald-800">
            <CheckCircle2 className="h-4 w-4" />
            {isAr ? 'السياق مكتمل — هذا المحتوى مؤهل للاعتماد والجدولة'
                  : 'Context complete — this content can be approved and scheduled'}
          </div>
        ) : (
          <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-2.5">
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-amber-900">
              <AlertTriangle className="h-4 w-4" />
              {isAr ? 'لا يمكن الاعتماد أو الجدولة قبل استكمال:' : 'Cannot be approved or scheduled until you fill in:'}
            </div>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {missing.map((m) => (
                <li key={m} className="rounded-full border border-amber-300 bg-white px-2 py-0.5 text-[11px] text-amber-900">
                  {lbl(MISSING_CONTEXT_LABEL, m, isAr)}
                </li>))}
            </ul>
          </div>
        )
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-charcoal/55">{isAr ? 'الخطة' : 'Plan'}{dot('plan')}</span>
          <select defaultValue={item.plan_id ?? ''} className={FIELD}
            onChange={(e) => void save({ plan_id: e.target.value || null }, 'plan')}>
            <option value="">{isAr ? '— بلا خطة —' : '— no plan —'}</option>
            {plans.map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-charcoal/55">{isAr ? 'الهدف الرئيسي' : 'Primary goal'}{dot('goal')}</span>
          <select defaultValue={item.primary_goal_id ?? ''} className={FIELD}
            onChange={(e) => void save({ primary_goal_id: e.target.value || null }, 'goal')}>
            <option value="">{isAr ? '— بلا هدف —' : '— no goal —'}</option>
            {planGoals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name_ar} · {lbl(GOAL_CATEGORY_LABEL, g.goal_category, isAr)}
              </option>))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-charcoal/55">{isAr ? 'المحور الرئيسي' : 'Primary pillar'}{dot('pillar')}</span>
          <select defaultValue={item.primary_pillar_id ?? ''} className={FIELD}
            onChange={(e) => void save({ primary_pillar_id: e.target.value || null }, 'pillar')}>
            <option value="">{isAr ? '— بلا محور —' : '— none —'}</option>
            {pillars.map((p) => <option key={p.id} value={p.id}>{isAr ? p.name_ar : p.name_en}</option>)}
          </select>
        </label>

        <label className="block sm:col-span-2 lg:col-span-3">
          <span className="mb-1 block text-[11px] font-medium text-charcoal/55">
            {isAr ? 'الغرض الاستراتيجي' : 'Strategic purpose'}{dot('purpose')}
          </span>
          <textarea rows={2} defaultValue={item.strategic_purpose ?? ''} className={FIELD}
            placeholder={isAr ? 'لماذا يستحق هذا المحتوى وقت الفريق؟' : 'Why is this worth the team’s time?'}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v !== (item.strategic_purpose ?? '')) void save({ strategic_purpose: v || null }, 'purpose');
            }} />
        </label>
      </div>

      {/* ── origin ── */}
      <div className="mt-3 border-t border-sand/40 pt-3">
        <div className="mb-1.5 text-[11px] font-medium text-charcoal/55">
          {isAr ? 'مصدر الإنتاج' : 'Production origin'}{dot('origin')}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {['program', 'campaign', 'reactive', 'standalone'].map((k) => (
            <button key={k} type="button" onClick={() => setOrigin(k)}
              className={`rounded-lg border px-2.5 py-1 text-[11.5px] transition-colors ${
                item.origin_kind === k
                  ? 'border-copper bg-copper/10 font-medium text-copper-500'
                  : 'border-sand/60 bg-white text-charcoal/55 hover:border-copper/40'}`}>
              {lbl(ORIGIN_KIND_LABEL, k, isAr)}
            </button>))}
        </div>

        {item.origin_kind === 'program' && (
          <select defaultValue={item.origin_program_id ?? ''} className={`${FIELD} mt-2 max-w-[280px]`}
            onChange={(e) => setOrigin('program', e.target.value)}>
            <option value="">{isAr ? '— اختر البرنامج —' : '— select the program —'}</option>
            {programs.map((p) => <option key={p.id} value={p.id}>{p.name_ar}</option>)}
          </select>
        )}
        {item.origin_kind === 'campaign' && (
          <select defaultValue={item.origin_campaign_id ?? ''} className={`${FIELD} mt-2 max-w-[280px]`}
            onChange={(e) => setOrigin('campaign', e.target.value)}>
            <option value="">{isAr ? '— اختر الحملة —' : '— select the campaign —'}</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name_ar}</option>)}
          </select>
        )}
        {item.origin_kind === 'reactive' && (
          <input defaultValue={item.reactive_trigger ?? ''} className={`${FIELD} mt-2 max-w-[360px]`}
            placeholder={isAr ? 'ما الحدث الذي استدعى هذا المحتوى الآن؟' : 'What event made this urgent now?'}
            onBlur={(e) => void save({ reactive_trigger: e.target.value.trim() || null }, 'origin')} />
        )}
      </div>

      {/* ── usage ── */}
      <div className="mt-3 border-t border-sand/40 pt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11px] font-medium text-charcoal/55">
            {isAr ? 'إعادة الاستخدام' : 'Reuse'}
          </span>
          <button type="button" onClick={() => setAdding((v) => !v)}
            className="text-[11.5px] font-medium text-copper hover:underline">
            {isAr ? '+ استخدام' : '+ usage'}
          </button>
        </div>

        {adding && (
          <div className="mb-2 grid gap-1.5 rounded-lg border border-copper/30 bg-white p-2.5 sm:grid-cols-4">
            <select value={uf.usage_kind} onChange={(e) => setUf({ ...uf, usage_kind: e.target.value })} className={FIELD}>
              <option value="paid_ad">{isAr ? 'إعلان مدفوع' : 'Paid ad'}</option>
              <option value="campaign">{isAr ? 'حملة أخرى' : 'Another campaign'}</option>
              <option value="program">{isAr ? 'برنامج آخر' : 'Another program'}</option>
              <option value="initiative">{isAr ? 'مبادرة' : 'Initiative'}</option>
            </select>
            <select value={uf.target ?? ''} onChange={(e) => setUf({ ...uf, target: e.target.value })}
              className={`${FIELD} sm:col-span-2`}>
              <option value="">{isAr ? '— الوجهة —' : '— target —'}</option>
              {campaigns.map((c) => <option key={c.id} value={`camp:${c.id}`}>{isAr ? 'حملة: ' : 'Campaign: '}{c.name_ar}</option>)}
              {programs.map((p) => <option key={p.id} value={`prog:${p.id}`}>{isAr ? 'برنامج: ' : 'Program: '}{p.name_ar}</option>)}
              {initiatives.map((i) => <option key={i.id} value={`init:${i.id}`}>{isAr ? 'مبادرة: ' : 'Initiative: '}{i.name_ar}</option>)}
            </select>
            <Button variant="secondary" onClick={addUsage} disabled={!uf.target}>
              <Plus className="h-4 w-4" />{isAr ? 'ربط' : 'Link'}
            </Button>
            <p className="text-[10.5px] text-charcoal/45 sm:col-span-4">
              {isAr ? 'هذا لا يغيّر مصدر الإنتاج — يسجّل استخداماً إضافياً فقط.'
                    : 'This does not change the production origin — it records an additional use.'}
            </p>
          </div>
        )}

        <p className="flex items-center gap-1.5 text-[11px] text-charcoal/45">
          <Link2 className="h-3 w-3" />
          {isAr ? 'كل استخدام يُحسب مرة واحدة في تجميع الأداء، مهما تعددت الأماكن.'
                : 'Each use counts once in performance roll-up, however many places it appears.'}
        </p>
      </div>
    </Section>
  );
}
