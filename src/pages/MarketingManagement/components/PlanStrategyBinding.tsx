/**
 * Which strategy version a plan was written against.
 *
 * A plan is an argument, and the argument only makes sense against the version
 * of the strategy that was true when it was made. So the binding is to an exact
 * immutable version — never to "the strategy" as a moving target. When a newer
 * strategy is approved, existing plans do NOT follow it. Somebody has to decide
 * that the plan still holds under the new choices, and say why.
 *
 * That decision is this screen's Rebase action: explicit, confirmed, reasoned,
 * and appended to a history that is never rewritten. The database enforces the
 * same rule (mkt_tg_plan_needs_approved_strategy + the append-only link table),
 * so the UI is showing the rule rather than being it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link2, AlertTriangle, ArrowRight, History, Check } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { CaveatStrip, EmptyHint, fmtDate } from '@/pages/MarketingIntelligence/components/shared';
import { lbl } from '@/lib/marketingMgmt/labels';
import {
  fetchPlanStrategyContext, rebasePlanStrategy, savePlan,
  STRATEGY_STATUS_LABEL, PLAN_MISSING_LABEL,
  type MktPlan, type StrategyVersionRef, type PlanStrategyLink,
} from '@/lib/marketingMgmt/v2';

const FIELD = 'w-full rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] '
  + 'text-charcoal focus:border-copper focus:outline-none';
const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

const vName = (v: StrategyVersionRef, isAr: boolean) =>
  `${(isAr ? v.name_ar : v.name_en) || v.name_ar} v${v.version_number}`;

/** The identity line the spec asks for: name, version, approval status, and the
 *  two dates that make "which one was true then" answerable. */
function VersionLine({ v, isAr }: { v: StrategyVersionRef; isAr: boolean }) {
  const approved = v.status === 'approved';
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="truncate text-[13px] font-semibold text-charcoal">{vName(v, isAr)}</span>
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-semibold ${
          approved ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                   : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          {lbl(STRATEGY_STATUS_LABEL, v.status, isAr)}
        </span>
      </div>
      <div className="mt-0.5 text-[11px] text-charcoal/45">
        {isAr ? 'سارية من' : 'Effective'} {fmtDate(v.effective_date, isAr)}
        {' · '}
        {v.approved_at
          ? `${isAr ? 'اعتُمدت' : 'approved'} ${fmtDate(v.approved_at, isAr)}`
          : (isAr ? 'لم تُعتمد بعد' : 'not approved')}
      </div>
    </div>
  );
}

function HistoryList({ rows, versions, isAr }: {
  rows: PlanStrategyLink[]; versions: StrategyVersionRef[]; isAr: boolean;
}) {
  const users = useAppStore((s) => s.users);
  const name = (id: string | null) => {
    if (!id) return isAr ? 'بلا استراتيجية' : 'no strategy';
    const v = versions.find((x) => x.id === id);
    return v ? vName(v, isAr) : (isAr ? 'نسخة محذوفة' : 'a removed version');
  };
  if (rows.length === 0) {
    return (
      <EmptyHint>
        {isAr ? 'لم يُعَد ربط هذه الخطة بأي نسخة أخرى.'
              : 'This plan has never been rebased onto another version.'}
      </EmptyHint>
    );
  }
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => {
        const u = users.find((x) => x.id === r.changed_by_user_id);
        return (
          <li key={r.id} className="rounded-lg border border-sand/50 bg-white px-2.5 py-2">
            <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-charcoal/70">
              <span className="text-charcoal/45">{name(r.from_strategy_version_id)}</span>
              <ArrowRight className="h-3 w-3 shrink-0 text-charcoal/30" />
              <span className="font-medium">{name(r.to_strategy_version_id)}</span>
            </div>
            <div className="mt-0.5 text-[10.5px] text-charcoal/40">
              {fmtDate(r.changed_at, isAr)}
              {u ? ` · ${(isAr ? u.name_ar : u.name_en) || u.name_en}` : ''}
              {r.plan_status_at_change ? ` · ${r.plan_status_at_change}` : ''}
            </div>
            {r.reason && <p className="mt-1 text-[11.5px] text-charcoal/65">{r.reason}</p>}
          </li>
        );
      })}
    </ul>
  );
}

export function PlanStrategyBinding({ plan, isAr, onError, onToast, onChanged }: {
  plan: MktPlan; isAr: boolean; onError: (m: string) => void;
  onToast: (m: string) => void; onChanged: () => void;
}) {
  const [ctx, setCtx] = useState<Awaited<ReturnType<typeof fetchPlanStrategyContext>> | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [proposed, setProposed] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchPlanStrategyContext(plan.id).then(setCtx).catch((e) => onError(err(e)));
  }, [plan.id, onError]);
  useEffect(load, [load]);

  if (!ctx) return null;

  const bound = ctx.versions.find((v) => v.id === plan.strategy_version_id) ?? null;
  const current = ctx.current_approved;
  const isStale = !!bound && !!current && bound.id !== current.id;
  const blocked = (ctx.missing ?? []).filter(
    (m) => m === 'strategy_version' || m === 'approved_strategy_version');

  /** Binding a plan that has none is not a rebase — there is nothing to rebase
   *  FROM. It goes through the ordinary save, and the history trigger records
   *  it all the same. */
  const bindFirst = async (versionId: string) => {
    setBusy(true);
    try {
      await savePlan({ strategy_version_id: versionId }, plan.id);
      onToast(isAr ? 'رُبطت الخطة بالاستراتيجية' : 'Plan bound to the strategy');
      load(); onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const doRebase = async () => {
    if (!proposed) return;
    setBusy(true);
    try {
      await rebasePlanStrategy(plan.id, proposed, reason.trim() || undefined);
      onToast(isAr ? 'أُعيد ربط الخطة' : 'Plan rebased');
      setConfirming(false); setProposed(''); setReason('');
      load(); onChanged();
    } catch (e) { onError(err(e)); } finally { setBusy(false); }
  };

  const proposedV = ctx.versions.find((v) => v.id === proposed) ?? null;

  return (
    <div className="space-y-2 rounded-xl border border-sand/50 bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-copper" />
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-wide text-charcoal/45">
              {isAr ? 'نسخة الاستراتيجية' : 'Strategy version'}
            </div>
            {bound
              ? <VersionLine v={bound} isAr={isAr} />
              : <div className="text-[13px] font-semibold text-amber-700">
                  {isAr ? 'غير مربوطة بأي نسخة' : 'Not bound to any version'}
                </div>}
          </div>
        </div>
        <button type="button" onClick={() => setShowHistory((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] text-copper hover:underline">
          <History className="h-3.5 w-3.5" />
          {isAr ? `السجل (${ctx.history.length})` : `History (${ctx.history.length})`}
        </button>
      </div>

      {blocked.length > 0 && (
        <CaveatStrip>
          {isAr
            ? `لا يمكن اعتماد هذه الخطة أو تفعيلها: ${blocked.map((m) => lbl(PLAN_MISSING_LABEL, m, true)).join('، ')}.`
            : `This plan cannot be approved or activated: ${blocked.map((m) => lbl(PLAN_MISSING_LABEL, m, false)).join(', ')}.`}
        </CaveatStrip>
      )}

      {!bound && (
        <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-charcoal/55">
              {isAr ? 'اربطها بنسخة' : 'Bind to a version'}
            </span>
            <select value={proposed} onChange={(e) => setProposed(e.target.value)} className={FIELD}>
              <option value="">{isAr ? '— اختر نسخة —' : '— select a version —'}</option>
              {ctx.versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {vName(v, isAr)} — {lbl(STRATEGY_STATUS_LABEL, v.status, isAr)}
                  {current && v.id === current.id ? (isAr ? ' (الحالية)' : ' (current)') : ''}
                </option>))}
            </select>
          </label>
          <Button onClick={() => void bindFirst(proposed)} disabled={busy || !proposed}>
            <Check className="h-4 w-4" />{isAr ? 'ربط' : 'Bind'}
          </Button>
          {current && (
            <p className="text-[10.5px] leading-snug text-charcoal/45 sm:col-span-2">
              {isAr
                ? `النسخة المعتمدة حالياً: ${vName(current, true)}. لا تُربط الخطة تلقائياً — الاختيار قرار.`
                : `Currently approved: ${vName(current, false)}. Nothing is bound automatically — this is a decision.`}
            </p>
          )}
        </div>
      )}

      {bound && isStale && !confirming && (
        <div className="rounded-lg border border-sand/60 bg-cream-light px-3 py-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-charcoal/40" />
            <p className="text-[11.5px] leading-snug text-charcoal/65">
              {isAr
                ? `توجد نسخة أحدث معتمدة (${vName(current!, true)}). هذه الخطة تبقى مربوطة بنسختها الأصلية — وهو المقصود. أعد الربط فقط إذا راجعتها وقررت أنها ما زالت صالحة.`
                : `A newer version is approved (${vName(current!, false)}). This plan stays on the version it was written against — that is deliberate. Rebase only if you have reviewed it and decided it still holds.`}
            </p>
          </div>
          <button type="button" className="mt-1.5 text-[11.5px] font-medium text-copper hover:underline"
            onClick={() => { setProposed(current!.id); setConfirming(true); }}>
            {isAr ? 'إعادة ربط الخطة بنسخة أخرى…' : 'Rebase plan to another version…'}
          </button>
        </div>
      )}

      {bound && !isStale && !confirming && (
        <button type="button" className="text-[11.5px] text-charcoal/45 hover:text-copper hover:underline"
          onClick={() => setConfirming(true)}>
          {isAr ? 'إعادة ربط الخطة بنسخة أخرى…' : 'Rebase plan to another version…'}
        </button>
      )}

      {confirming && (
        <div className="space-y-2 rounded-lg border border-copper/40 bg-white p-2.5">
          <div className="text-[11.5px] font-semibold text-charcoal">
            {isAr ? 'تأكيد إعادة الربط' : 'Confirm rebase'}
          </div>

          <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
            <div className="rounded-lg border border-sand/50 bg-cream-light px-2.5 py-2">
              <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-charcoal/40">
                {isAr ? 'الحالية' : 'Current'}
              </div>
              {bound ? <VersionLine v={bound} isAr={isAr} />
                     : <span className="text-[12px] text-charcoal/45">{isAr ? 'لا شيء' : 'none'}</span>}
            </div>
            <ArrowRight className="mx-auto hidden h-4 w-4 text-charcoal/30 sm:block" />
            <div className="rounded-lg border border-copper/30 bg-copper/5 px-2.5 py-2">
              <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-charcoal/40">
                {isAr ? 'المقترحة' : 'Proposed'}
              </div>
              {proposedV ? <VersionLine v={proposedV} isAr={isAr} />
                         : <span className="text-[12px] text-charcoal/45">{isAr ? 'اختر نسخة' : 'pick a version'}</span>}
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-charcoal/55">
              {isAr ? 'النسخة الجديدة' : 'New version'}
            </span>
            <select value={proposed} onChange={(e) => setProposed(e.target.value)} className={FIELD}>
              <option value="">{isAr ? '— اختر —' : '— select —'}</option>
              {ctx.versions.filter((v) => v.id !== plan.strategy_version_id).map((v) => (
                <option key={v.id} value={v.id}>
                  {vName(v, isAr)} — {lbl(STRATEGY_STATUS_LABEL, v.status, isAr)}
                </option>))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-charcoal/55">
              {isAr ? 'السبب' : 'Reason'}
            </span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className={FIELD}
              placeholder={isAr ? 'ما الذي راجعته، ولماذا ما زالت الخطة صالحة تحت النسخة الجديدة؟'
                                : 'What did you review, and why does the plan still hold under the new version?'} />
          </label>

          {proposedV && proposedV.status !== 'approved' && (
            <CaveatStrip>
              {isAr
                ? 'هذه النسخة غير معتمدة. يمكن ربط مسودة بها، لكن لن تُعتمد الخطة أو تُفعَّل حتى تُعتمد النسخة.'
                : 'That version is not approved. A draft may be bound to it, but the plan cannot be approved or activated until the version is.'}
            </CaveatStrip>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={doRebase} disabled={busy || !proposed}>
              <Check className="h-4 w-4" />{isAr ? 'تأكيد إعادة الربط' : 'Confirm rebase'}
            </Button>
            <button type="button" onClick={() => { setConfirming(false); setReason(''); }}
              className="text-[11.5px] text-charcoal/50 hover:underline">
              {isAr ? 'إلغاء' : 'Cancel'}
            </button>
            <span className="text-[10.5px] text-charcoal/40">
              {isAr ? 'يُسجَّل من قام بذلك ومتى، ولا يُحذف السجل.'
                    : 'Who did this and when is recorded, and the record is never removed.'}
            </span>
          </div>
        </div>
      )}

      {showHistory && (
        <div className="pt-1">
          <HistoryList rows={ctx.history} versions={ctx.versions} isAr={isAr} />
        </div>
      )}
    </div>
  );
}
