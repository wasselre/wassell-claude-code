/**
 * The three campaign progress measures, and the three kinds of "nothing".
 *
 * The old screen showed one "Completion %" computed as published ÷ content.
 * With no content that is 0/0, which rendered as 0% — indistinguishable from a
 * campaign that planned twelve items and published none, and from one that
 * published none because nobody has collected the numbers yet. Three different
 * situations, one identical red zero.
 *
 * So there is no single percentage here. There are three measures, and each can
 * say it has no target or no data instead of claiming a result:
 *
 *   Deliverables   agreed units of work, done vs required
 *   Publication    of the content that IS approved, how much went out
 *   Outcome        the campaign's own target vs what was actually measured
 *
 * The states come straight from mkt_campaign_progress(); nothing is derived a
 * second time here, so the screen cannot disagree with the database.
 */
import type { ProgressState } from '@/lib/marketingMgmt/client';

const PCT = (done: number, total: number) =>
  total > 0 ? Math.round((done / total) * 100) : null;

/** One measure. Deliberately never renders a bare 0% for an unmeasured thing. */
export function ProgressMeter({ label, value, isAr, unitAr, unitEn }: {
  label: string; value: ProgressState | null | undefined; isAr: boolean;
  unitAr?: string; unitEn?: string;
}) {
  const unit = (isAr ? unitAr : unitEn) ?? '';

  let body: React.ReactNode;
  let bar: React.ReactNode = null;

  if (!value || value.state === 'no_target') {
    body = (
      <span className="text-[12px] text-charcoal/40">
        {isAr ? 'لا مستهدف محدد' : 'No target configured'}
      </span>
    );
  } else if (value.state === 'awaiting_data') {
    body = (
      <span className="text-[12px] text-amber-700">
        {isAr ? `بانتظار البيانات · المستهدف ${value.total.toLocaleString()}${unit ? ` ${unit}` : ''}`
              : `Awaiting performance data · target ${value.total.toLocaleString()}${unit ? ` ${unit}` : ''}`}
      </span>
    );
  } else {
    const pct = PCT(value.done, value.total);
    body = (
      <span className="text-[12.5px] tabular-nums text-charcoal">
        {isAr
          ? `${value.done.toLocaleString()} من ${value.total.toLocaleString()}${unit ? ` ${unit}` : ''}`
          : `${value.done.toLocaleString()} of ${value.total.toLocaleString()}${unit ? ` ${unit}` : ''}`}
        {pct !== null && <span className="text-charcoal/45"> · {pct}%</span>}
      </span>
    );
    bar = (
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sand/40">
        <div className="h-full rounded-full bg-copper"
          style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-sand/50 bg-cream-light px-3.5 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-charcoal/45">{label}</div>
      <div className="mt-1">{body}</div>
      {bar}
    </div>
  );
}

/** All three together — the campaign header block. */
export function CampaignProgressBlock({ progress, isAr }: {
  progress: {
    deliverables: ProgressState; publication: ProgressState; outcome: ProgressState;
    metric: string;
  } | null;
  isAr: boolean;
}) {
  return (
    <div className="grid gap-2.5 sm:grid-cols-3">
      <ProgressMeter isAr={isAr} value={progress?.deliverables}
        label={isAr ? 'المخرجات' : 'Deliverables'}
        unitAr="مخرج" unitEn="deliverables" />
      <ProgressMeter isAr={isAr} value={progress?.publication}
        label={isAr ? 'النشر' : 'Publication'}
        unitAr="عنصر معتمد" unitEn="approved items" />
      <ProgressMeter isAr={isAr} value={progress?.outcome}
        label={isAr ? 'النتيجة' : 'Outcome'}
        unitAr="عميل محتمل" unitEn="qualified leads" />
    </div>
  );
}
