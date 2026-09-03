import { useMemo, useState } from 'react';
import { Ban, Check, HelpCircle, Loader2, Pencil, RotateCcw, User } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { submitReview } from '../lib/client';
import { cloneExpression, isEdited, clauseCount } from '../lib/describe';
import type { GeoPreferenceDTO, ProposalView, ReviewAction, ReviewOutcome } from '../lib/types';
import EvidencePanel from './EvidencePanel';
import GateReasons from './GateReasons';
import GeometrySummary from './GeometrySummary';
import ExpressionEditor from './ExpressionEditor';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-charcoal/40">{title}</h3>
      {children}
    </section>
  );
}

export default function ProposalDetail({
  proposal,
  isAr,
  onResolved,
}: {
  proposal: ProposalView;
  isAr: boolean;
  onResolved: (outcome: ReviewOutcome) => void;
}) {
  const addToast = useAppStore((s) => s.addToast);
  const [working, setWorking] = useState<GeoPreferenceDTO>(() => cloneExpression(proposal.expression));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<ReviewAction | null>(null);

  const edited = useMemo(() => isEdited(proposal.expression, working), [proposal.expression, working]);
  const canApply = clauseCount(working) > 0;

  const run = async (action: ReviewAction) => {
    setBusy(action);
    try {
      const outcome = await submitReview({
        proposalId: proposal.id,
        action,
        note: note.trim() || null,
        finalExpression: action === 'edit' ? working : null,
        expectedVersion: proposal.version,
      });
      addToast(
        action === 'reject' ? (isAr ? 'تم رفض الاقتراح' : 'Proposal rejected')
          : action === 'must_confirm' ? (isAr ? 'بانتظار تأكيد العميل' : 'Marked for customer confirmation')
            : (isAr ? 'تم تطبيق التفضيل على العميل' : 'Preference applied to the client'),
        'success',
      );
      onResolved(outcome);
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  // Apply = confirm as-is, OR edit when the reviewer changed the expression.
  const applyAction: ReviewAction = edited ? 'edit' : 'confirm';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-lg font-bold text-charcoal">
            <User size={18} className="text-copper" />
            {proposal.client_name || (isAr ? 'عميل غير معروف' : 'Unknown client')}
          </div>
          <div className="mt-0.5 text-xs text-charcoal/45">
            {isAr ? 'أُنشئ' : 'Created'} {new Date(proposal.created_at).toLocaleString(isAr ? 'ar' : 'en')}
            {' · '}{isAr ? 'الإجراء المقترح' : 'proposed'}: <span className="font-bold">{proposal.proposed_action}</span>
            {proposal.status === 'must_confirm' && (
              <span className="ms-2 rounded bg-amber-100 px-1.5 py-0.5 font-bold text-amber-700">
                {isAr ? 'يحتاج تأكيد' : 'needs confirm'}
              </span>
            )}
          </div>
        </div>
        {proposal.edited && (
          <span className="rounded-lg bg-gold/15 px-2 py-1 text-xs font-bold text-terracotta">
            {isAr ? 'مُعدَّل سابقاً' : 'previously edited'}
          </span>
        )}
      </div>

      <Section title={isAr ? 'الدليل المصدري (ما قاله العميل)' : 'Source evidence (what the client said)'}>
        <EvidencePanel evidence={proposal.evidence} isAr={isAr} />
      </Section>

      <Section title={isAr ? 'التفضيلات المُفسَّرة — عدِّل قبل التطبيق' : 'Interpreted preferences — adjust before applying'}>
        <ExpressionEditor working={working} onChange={setWorking} isAr={isAr} />
        {edited && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
            <span>{isAr ? 'ستُعاد ترجمة تعديلاتك على الخادم عند التطبيق.' : 'Your edits are re-resolved on the server when applied.'}</span>
            <button
              type="button"
              onClick={() => setWorking(cloneExpression(proposal.expression))}
              className="inline-flex items-center gap-1 font-bold hover:underline"
            >
              <RotateCcw size={12} /> {isAr ? 'تراجع' : 'reset'}
            </button>
          </div>
        )}
      </Section>

      <Section title={isAr ? 'الجغرافيا المُطابَقة (سيُضاف للعميل)' : 'Resolved geography (added to the client)'}>
        <GeometrySummary items={proposal.preview_items} geometry={proposal.geometry_summary} isAr={isAr} />
      </Section>

      <Section title={isAr ? 'إشارات الثقة والبوابة' : 'Confidence & gate signals'}>
        <GateReasons reasons={proposal.gate_reasons} isAr={isAr} />
      </Section>

      <Section title={isAr ? 'ملاحظة المراجع (اختياري)' : 'Reviewer note (optional)'}>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder={isAr ? 'سبب القرار…' : 'Reason for the decision…'}
          className="w-full rounded-lg border border-sand/40 bg-white px-3 py-2 text-sm text-charcoal focus:border-copper focus:outline-none focus:ring-2 focus:ring-copper/20"
        />
      </Section>

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 border-t border-sand/20 pt-4">
        <Button variant="primary" disabled={busy !== null || !canApply} onClick={() => run(applyAction)}>
          {busy === 'confirm' || busy === 'edit' ? <Loader2 size={15} className="animate-spin" />
            : edited ? <Pencil size={15} /> : <Check size={15} />}
          {edited ? (isAr ? 'تطبيق التعديلات' : 'Apply edits') : (isAr ? 'تأكيد وتطبيق' : 'Confirm & apply')}
        </Button>
        <Button variant="secondary" disabled={busy !== null} onClick={() => run('must_confirm')}>
          {busy === 'must_confirm' ? <Loader2 size={15} className="animate-spin" /> : <HelpCircle size={15} />}
          {isAr ? 'يحتاج تأكيد العميل' : 'Needs customer confirm'}
        </Button>
        <Button variant="danger" disabled={busy !== null} onClick={() => run('reject')}>
          {busy === 'reject' ? <Loader2 size={15} className="animate-spin" /> : <Ban size={15} />}
          {isAr ? 'رفض' : 'Reject'}
        </Button>
      </div>
      {!canApply && (
        <p className="text-xs text-amber-600">
          {isAr ? 'لا توجد معايير قابلة للتطبيق — يمكنك الرفض أو طلب تأكيد العميل.' : 'No applicable rules — you can reject or ask for customer confirmation.'}
        </p>
      )}
    </div>
  );
}
