/**
 * Shared parts of the Marketing Portfolio: the drawer, the small presentation
 * primitives, and the derivations every view has to agree on.
 *
 * The important one is `attentionFlags`. There are two completely different
 * ways a record can be incomplete and the old screen said the same thing about
 * both:
 *
 *   campaign_class IS NULL      → we were never told whether it is organic
 *                                 or paid.  "النوع غير محدد"
 *   needs_classification = true → it has no plan or no primary goal, so it is
 *                                 not connected to anything strategic.
 *                                 "السياق الاستراتيجي ناقص"
 *
 * An explicitly organic campaign with no goal is the SECOND thing, and calling
 * it "unclassified" told the user its type was unknown when it was not. Every
 * badge, filter and count below keeps them apart.
 */
import { useEffect } from 'react';
import { X } from 'lucide-react';
import { lbl } from '@/lib/marketingMgmt/labels';
import {
  PORTFOLIO_MISSING_LABEL, CLASS_MISSING_LABEL, CONTEXT_MISSING_LABEL,
  type Initiative, type Program, type PortfolioKind,
} from '@/lib/marketingMgmt/v2';
import type { Campaign } from '@/lib/marketingMgmt/client';

export const FIELD = 'w-full rounded-lg border border-sand/60 bg-white px-2.5 py-1.5 text-[12.5px] '
  + 'text-charcoal focus:border-copper focus:outline-none disabled:bg-cream-light/60 disabled:text-charcoal/50';

export const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A value that was never recorded renders as an em dash, never as zero. */
export const dash = '—';

export function Field({ label, children, span = '', hint }: {
  label: string; children: React.ReactNode; span?: string; hint?: string;
}) {
  return (
    <label className={`block ${span}`}>
      <span className="mb-1 block text-[11px] font-medium text-charcoal/55">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[10.5px] text-charcoal/40">{hint}</span>}
    </label>
  );
}

export function Pill({ map, value, isAr, tone = 'neutral' }: {
  map: Record<string, { ar: string; en: string }>; value: string | null | undefined;
  isAr: boolean; tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  if (!value) return <span className="text-charcoal/35">{dash}</span>;
  const cls = tone === 'good' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-800'
    : tone === 'bad' ? 'border-red-200 bg-red-50 text-red-700'
    : 'border-sand/60 bg-white text-charcoal/60';
  return (
    <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[10.5px] ${cls}`}>
      {lbl(map, value, isAr)}
    </span>
  );
}

/** The two incompleteness badges, which are never the same badge. */
export function ClassMissingBadge({ isAr }: { isAr: boolean }) {
  return (
    <span className="inline-block whitespace-nowrap rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10.5px] text-red-700">
      {isAr ? CLASS_MISSING_LABEL.ar : CLASS_MISSING_LABEL.en}
    </span>
  );
}
export function ContextMissingBadge({ isAr }: { isAr: boolean }) {
  return (
    <span className="inline-block whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10.5px] text-amber-800">
      {isAr ? CONTEXT_MISSING_LABEL.ar : CONTEXT_MISSING_LABEL.en}
    </span>
  );
}

/** What the DATABASE will refuse to activate without, in the user's language. */
export function MissingChips({ missing, isAr, title }: {
  missing: string[]; isAr: boolean; title?: string;
}) {
  if (missing.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-2.5">
      <div className="text-[12px] font-medium text-amber-900">
        {title ?? (isAr ? 'لا يمكن التفعيل قبل استكمال:' : 'Cannot be activated until you fill in:')}
      </div>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {missing.map((m) => (
          <li key={m} className="rounded-full border border-amber-300 bg-white px-2 py-0.5 text-[11px] text-amber-900">
            {lbl(PORTFOLIO_MISSING_LABEL, m, isAr)}
          </li>))}
      </ul>
    </div>
  );
}

/** A right-side sheet. Focused, so creating or editing one record does not push
 *  the whole portfolio down the page the way the old inline form did. */
export function Drawer({ open, title, subtitle, onClose, children, footer, isAr }: {
  open: boolean; title: string; subtitle?: string; onClose: () => void;
  children: React.ReactNode; footer?: React.ReactNode; isAr: boolean;
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <button type="button" aria-label={isAr ? 'إغلاق' : 'Close'} onClick={onClose}
        className="flex-1 bg-charcoal/30" />
      <div className={`flex h-full w-full max-w-[560px] flex-col bg-cream shadow-2xl ${isAr ? 'order-first' : ''}`}>
        <div className="flex items-start justify-between gap-3 border-b border-sand/50 px-4 py-3">
          <div className="min-w-0">
            <h3 className="truncate text-[14px] font-semibold text-charcoal">{title}</h3>
            {subtitle && <p className="mt-0.5 text-[11.5px] text-charcoal/50">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose}
            className="rounded-lg p-1 text-charcoal/40 hover:bg-sand/30 hover:text-charcoal">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="border-t border-sand/50 bg-cream-light/60 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ── derivations every view agrees on ───────────────────────────────────────

export type AttentionKey =
  | 'class_missing' | 'plan_missing' | 'goal_missing' | 'owner_missing'
  | 'dates_missing' | 'commitment_missing' | 'deliverables_missing' | 'no_execution';

export interface PortfolioRow {
  kind: PortfolioKind;
  id: string;
  name: string;
  /** Only campaigns have one. */
  code?: string;
  row: Initiative | Program | Campaign;
  flags: AttentionKey[];
}

const jsonLen = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/** Exactly the questions the Needs-Attention filters ask, answered per record.
 *  Deriving them in one place is what keeps the filter chips' counts and the
 *  cards' warning badges from disagreeing. */
export function attentionFlags(kind: PortfolioKind, row: Initiative | Program | Campaign,
  children?: { programs: number; campaigns: number }): AttentionKey[] {
  const f: AttentionKey[] = [];
  const r = row as Partial<Campaign & Program & Initiative>;
  if (kind === 'campaign' && (r.campaign_class ?? null) === null) f.push('class_missing');
  if (!r.plan_id) f.push('plan_missing');
  if (!r.primary_goal_id) f.push('goal_missing');
  if (!r.owner_user_id) f.push('owner_missing');
  if (kind === 'campaign' && (!r.start_date || !r.end_date)) f.push('dates_missing');
  if (kind === 'program' && (r.commitment_count == null || !r.commitment_unit)) f.push('commitment_missing');
  if (kind === 'campaign' && jsonLen(r.deliverables) === 0) f.push('deliverables_missing');
  if (kind === 'initiative' && children && children.programs + children.campaigns === 0) f.push('no_execution');
  return f;
}

/** Campaign class, as a value the caller can switch on without re-deriving it. */
export const campaignClass = (c: Campaign): 'organic' | 'paid' | null => c.campaign_class ?? null;

/** A person's name for the interface language, or the honest dash. */
export function ownerName(
  users: Array<{ id: string; name_ar?: string | null; name_en?: string | null }>,
  id: string | null | undefined, isAr: boolean,
): string {
  if (!id) return dash;
  const u = users.find((x) => x.id === id);
  if (!u) return dash;
  return (isAr ? u.name_ar || u.name_en : u.name_en || u.name_ar) || dash;
}
