import { useCallback, useEffect, useMemo, useState } from 'react';
import { Globe, Loader2, RefreshCw } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { fetchProposals } from './lib/client';
import type { ProposalView, ReviewOutcome } from './lib/types';
import ProposalList from './components/ProposalList';
import ProposalDetail from './components/ProposalDetail';

/**
 * The rep-facing REVIEW SURFACE for the Geography Understanding Ability.
 *
 * Left: the queue of open (pending / needs-confirm) proposals the review-first
 * pipeline produced. Right: for the selected one — the source evidence with the
 * exact quoted spans, the interpreted preferences (editable), the resolved
 * geography it would add to the client, the confidence/gate reasons, and the
 * confirm / edit / reject / must-confirm actions. Confirm + edit are the ONLY
 * sanctioned writes to a client's location preferences, and they are server-side
 * and audited (see api/geo-preference/review.ts).
 */
export default function GeoReviewPage() {
  const isAr = useAppStore((s) => s.language) === 'ar';
  const [proposals, setProposals] = useState<ProposalView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchProposals();
      setProposals(rows);
      setSelectedId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : rows[0]?.id ?? null));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(() => proposals.find((p) => p.id === selectedId) ?? null, [proposals, selectedId]);

  const handleResolved = useCallback((outcome: ReviewOutcome) => {
    setProposals((prev) => {
      const next = prev.filter((p) => p.id !== outcome.proposalId);
      setSelectedId((cur) => (cur === outcome.proposalId ? next[0]?.id ?? null : cur));
      return next;
    });
  }, []);

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-charcoal">
            <Globe size={20} className="text-copper" />
            {isAr ? 'مراجعة التفضيلات الجغرافية' : 'Geography preference review'}
          </h1>
          <p className="mt-0.5 text-sm text-charcoal/50">
            {isAr
              ? 'أكِّد أو عدِّل أو ارفض ما فهمه النظام من موقع العميل قبل تطبيقه.'
              : "Confirm, edit, or reject what the system understood about a client's location before it applies."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-sand/40 bg-white px-3 py-1.5 text-sm text-charcoal/70 hover:bg-cream disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {isAr ? 'تحديث' : 'Refresh'}
        </button>
      </div>

      {loading && proposals.length === 0 ? (
        <div className="flex h-64 items-center justify-center text-charcoal/50">
          <Loader2 size={22} className="animate-spin" />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">{error}</div>
      ) : proposals.length === 0 ? (
        <div className="rounded-xl border border-sand/30 bg-white p-10 text-center">
          <Globe size={28} className="mx-auto mb-2 text-charcoal/20" />
          <p className="text-charcoal/60">{isAr ? 'لا توجد اقتراحات بانتظار المراجعة.' : 'No proposals waiting for review.'}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
          <div className="card p-5">
            <h2 className="mb-3 text-sm font-bold text-charcoal/70">
              {isAr ? `قائمة الانتظار (${proposals.length})` : `Queue (${proposals.length})`}
            </h2>
            <ProposalList proposals={proposals} selectedId={selectedId} onSelect={setSelectedId} isAr={isAr} />
          </div>
          <div className="card p-5">
            {selected ? (
              <ProposalDetail proposal={selected} isAr={isAr} onResolved={handleResolved} />
            ) : (
              <p className="text-sm text-charcoal/50">{isAr ? 'اختر اقتراحاً من القائمة.' : 'Select a proposal from the queue.'}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
