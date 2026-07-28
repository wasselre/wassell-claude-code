/**
 * The three record cards.
 *
 * Each one answers the questions you actually ask about that kind of record. An
 * initiative is judged by whether anything is executing under it; a program by
 * whether it is keeping its rhythm; a campaign by what it targeted against what
 * it got. A single generic row for all three is what made them feel like the
 * same object with a different word on it.
 *
 * Absent data renders as an em dash. Nothing here turns a missing number into
 * zero — "0 leads" and "we never measured" are different facts and the card is
 * not allowed to blur them.
 */
import { Repeat, Megaphone, Coins, Target, AlertTriangle, User } from 'lucide-react';
import { lbl } from '@/lib/marketingMgmt/labels';
import { fmtDate } from '@/pages/MarketingIntelligence/components/shared';
import {
  CAMPAIGN_STATUS_LABEL, CAMPAIGN_CLASS_LABEL, INITIATIVE_STATUS_LABEL,
  PROGRAM_STATUS_LABEL, DECISION_LABEL, ATTENTION_FILTER_LABEL, FUNNEL_STAGE_LABEL,
  commitmentSentence,
  type Initiative, type Program, type MktGoal, type PlanRef,
} from '@/lib/marketingMgmt/v2';
import type { Campaign } from '@/lib/marketingMgmt/client';
import {
  Pill, ClassMissingBadge, ContextMissingBadge, dash, ownerName, attentionFlags,
  type AttentionKey,
} from './shared';

type User = { id: string; name_ar?: string | null; name_en?: string | null };

interface Ctx {
  isAr: boolean;
  users: User[];
  goals: MktGoal[];
  plans: PlanRef[];
  initiatives: Initiative[];
  onOpen: (kind: 'initiative' | 'program' | 'campaign', id: string) => void;
}

function Warnings({ flags, isAr, exclude = [] }: {
  flags: AttentionKey[]; isAr: boolean; exclude?: AttentionKey[];
}) {
  const shown = flags.filter((f) => !exclude.includes(f));
  if (shown.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <AlertTriangle className="h-3 w-3 text-amber-600" />
      {shown.map((f) => (
        <span key={f} className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800">
          {lbl(ATTENTION_FILTER_LABEL, f, isAr)}
        </span>))}
    </div>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] text-charcoal/45">{children}</span>;
}

const goalName = (goals: MktGoal[], id: string | null | undefined) =>
  (id ? goals.find((g) => g.id === id)?.name_ar ?? dash : dash);

const CARD = 'w-full rounded-xl border border-sand/50 bg-white p-3 text-start transition hover:border-copper/40';

export function InitiativeCard({ i, ctx, programs, campaigns }: {
  i: Initiative; ctx: Ctx; programs: Program[]; campaigns: Campaign[];
}) {
  const { isAr } = ctx;
  const kids = { programs: programs.length, campaigns: campaigns.length };
  const flags = attentionFlags('initiative', i, kids);
  const plan = ctx.plans.find((p) => p.id === i.plan_id);
  return (
    <button type="button" className={CARD} onClick={() => ctx.onOpen('initiative', i.id)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Target className="h-3.5 w-3.5 shrink-0 text-charcoal/30" />
          <span className="truncate text-[13px] font-medium text-charcoal">{i.name_ar}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {i.decision && <Pill map={DECISION_LABEL} value={i.decision} isAr={isAr} tone="warn" />}
          <Pill map={INITIATIVE_STATUS_LABEL} value={i.status} isAr={isAr}
            tone={i.status === 'active' ? 'good' : 'neutral'} />
        </span>
      </div>
      <div className="mt-0.5">
        <Meta>
          {plan?.name_ar ?? (isAr ? 'بلا خطة' : 'no plan')} · {goalName(ctx.goals, i.primary_goal_id)}
        </Meta>
      </div>
      {i.expected_contribution && (
        <p className="mt-1 line-clamp-2 text-[11.5px] text-charcoal/60">
          {isAr ? 'المساهمة المتوقعة: ' : 'Expected: '}{i.expected_contribution}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-charcoal/50">
        <span className="inline-flex items-center gap-1"><Repeat className="h-3 w-3" />{kids.programs}</span>
        <span className="inline-flex items-center gap-1"><Megaphone className="h-3 w-3" />
          {campaigns.filter((c) => c.campaign_class !== 'paid').length}</span>
        <span className="inline-flex items-center gap-1"><Coins className="h-3 w-3" />
          {campaigns.filter((c) => c.campaign_class === 'paid').length}</span>
        <span className="inline-flex items-center gap-1"><User className="h-3 w-3" />
          {ownerName(ctx.users, i.owner_user_id, isAr)}</span>
      </div>
      <Warnings flags={flags} isAr={isAr} />
    </button>
  );
}

export function ProgramCard({ p, ctx, output }: {
  p: Program; ctx: Ctx;
  /** Content this program originated, for current-period delivery. */
  output: Array<{ created_at: string }>;
}) {
  const { isAr } = ctx;
  const flags = attentionFlags('program', p);
  const parent = p.initiative_id
    ? ctx.initiatives.find((i) => i.id === p.initiative_id)?.name_ar ?? dash
    : null;
  const sentence = commitmentSentence(p, isAr);

  // Delivery this period, counted from real content rows. When there is no
  // commitment there is nothing to be behind on, so the card says that instead
  // of printing 0 / 0.
  let progress: string | null = null;
  let behind = false;
  if (p.commitment_count != null && p.commitment_unit) {
    const days = { day: 1, week: 7, month: 30, quarter: 91 }[p.commitment_unit] ?? 7;
    const since = new Date(Date.now() - days * (p.every_n_periods ?? 1) * 86400000).toISOString();
    const done = output.filter((c) => c.created_at >= since).length;
    progress = `${done} / ${p.commitment_count}`;
    behind = done < p.commitment_count;
  }

  return (
    <button type="button" className={CARD} onClick={() => ctx.onOpen('program', p.id)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Repeat className="h-3.5 w-3.5 shrink-0 text-charcoal/30" />
          <span className="truncate text-[13px] font-medium text-charcoal">{p.name_ar}</span>
        </span>
        <Pill map={PROGRAM_STATUS_LABEL} value={p.status} isAr={isAr}
          tone={p.status === 'active' ? 'good' : 'neutral'} />
      </div>
      <div className="mt-0.5">
        <Meta>
          {parent
            ? (isAr ? `ضمن مبادرة ${parent}` : `under ${parent}`)
            : (isAr ? 'مرتبط بالهدف مباشرة' : 'attached directly to the goal')}
          {' · '}{goalName(ctx.goals, p.primary_goal_id)}
        </Meta>
      </div>
      <p className="mt-1 text-[11.5px] text-charcoal/70">
        {sentence ?? (isAr ? 'بلا التزام متكرر' : 'no recurring commitment')}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-charcoal/50">
        <span>{(p.platforms as string[] | undefined)?.length
          ? (p.platforms as string[]).join(' · ') : dash}</span>
        <span className="inline-flex items-center gap-1"><User className="h-3 w-3" />
          {ownerName(ctx.users, p.owner_user_id, isAr)}</span>
        <span className={behind ? 'text-amber-700' : ''}>
          {isAr ? 'هذه الفترة: ' : 'this period: '}{progress ?? dash}
        </span>
      </div>
      <Warnings flags={flags} isAr={isAr} />
    </button>
  );
}

export function CampaignCard({ c, ctx }: { c: Campaign; ctx: Ctx }) {
  const { isAr } = ctx;
  const flags = attentionFlags('campaign', c);
  const cls = c.campaign_class ?? null;
  const contentCount = c.mkt_content_items?.length ?? null;
  const projects = c.mkt_internal_campaign_projects?.length ?? 0;
  const parent = c.initiative_id
    ? ctx.initiatives.find((i) => i.id === c.initiative_id)?.name_ar ?? dash
    : null;
  const deliverables = Array.isArray(c.deliverables) ? c.deliverables.length : 0;
  const actual = (c.actual_results ?? {}) as Record<string, unknown>;
  const actualLeads = typeof actual.leads === 'number' ? actual.leads : null;

  return (
    <button type="button" className={CARD} onClick={() => ctx.onOpen('campaign', c.id)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {cls === 'paid' ? <Coins className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                          : <Megaphone className="h-3.5 w-3.5 shrink-0 text-charcoal/30" />}
          <span className="truncate text-[13px] font-medium text-charcoal">
            <span className="tabular-nums text-charcoal/50">{c.code}</span> · {c.name_ar}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {cls ? <Pill map={CAMPAIGN_CLASS_LABEL} value={cls} isAr={isAr}
                   tone={cls === 'paid' ? 'warn' : 'neutral'} />
               : <ClassMissingBadge isAr={isAr} />}
          <Pill map={CAMPAIGN_STATUS_LABEL} value={c.status} isAr={isAr}
            tone={c.status === 'active' ? 'good' : 'neutral'} />
        </span>
      </div>
      <div className="mt-0.5">
        <Meta>
          {goalName(ctx.goals, c.primary_goal_id)}
          {parent ? ` · ${isAr ? 'ضمن' : 'under'} ${parent}` : ''}
          {c.funnel_stage ? ` · ${lbl(FUNNEL_STAGE_LABEL, c.funnel_stage, isAr)}` : ''}
        </Meta>
      </div>
      <div className="mt-0.5">
        <Meta>
          {c.start_date ? fmtDate(c.start_date, isAr) : dash} → {c.end_date ? fmtDate(c.end_date, isAr) : dash}
        </Meta>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-charcoal/50">
        <span className="inline-flex items-center gap-1"><User className="h-3 w-3" />
          {ownerName(ctx.users, c.owner_user_id, isAr)}</span>
        <span>{isAr ? 'مشاريع' : 'projects'} {projects || dash}</span>
        <span>{isAr ? 'مخرجات' : 'deliverables'} {deliverables || dash}</span>
        <span>{isAr ? 'محتوى' : 'content'} {contentCount ?? dash}</span>
        <span>
          {isAr ? 'عملاء مستهدف/فعلي' : 'leads target/actual'}{' '}
          {c.target_leads ?? dash} / {actualLeads ?? dash}
        </span>
      </div>
      {/* The class badge above already says the type is missing; repeating it in
          the warning row would read as two separate problems. */}
      <Warnings flags={flags} isAr={isAr} exclude={['class_missing']} />
      {c.needs_classification && <div className="mt-1"><ContextMissingBadge isAr={isAr} /></div>}
    </button>
  );
}

export type { Ctx as CardCtx };
