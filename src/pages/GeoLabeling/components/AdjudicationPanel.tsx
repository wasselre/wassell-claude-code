import { useEffect, useState } from 'react';
import Button from '@/components/ui/Button';
import { Loader2 } from 'lucide-react';
import {
  agreement, submitAdjudication, writeCanonical,
  type AgreementResult, type EnrichedSubject,
} from '../lib/client';

/**
 * Adjudicator surface: the disagreements that survived the blind rounds, each
 * field's Cohen's κ + confusion matrix, and the controls to record the canonical
 * answer — a per-field adjudication label, and the checkpoint's independent
 * canonical_expected_expression (the answer key, never the production compiler).
 */
export default function AdjudicationPanel({
  batchId, subjects, isAr, onToast,
}: {
  batchId: string;
  subjects: EnrichedSubject[];
  isAr: boolean;
  onToast: (msg: string, kind: 'success' | 'error') => void;
}) {
  const [agr, setAgr] = useState<AgreementResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [canon, setCanon] = useState<Record<string, string>>({});

  useEffect(() => {
    setLoading(true);
    agreement(batchId)
      .then(setAgr)
      .catch((e) => onToast(e instanceof Error ? e.message : String(e), 'error'))
      .finally(() => setLoading(false));
  }, [batchId, onToast]);

  const pickAdjudication = async (item_id: string, field: string, kind: string, value: string) => {
    try {
      await submitAdjudication({ batch_id: batchId, subject_kind: kind as never, subject_ref: item_id, field, value });
      onToast(isAr ? 'تم تسجيل القرار' : 'adjudication recorded', 'success');
    } catch (e) { onToast(e instanceof Error ? e.message : String(e), 'error'); }
  };

  const saveCanonical = async (checkpointId: string) => {
    const raw = canon[checkpointId] ?? '';
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { onToast(isAr ? 'JSON غير صالح' : 'invalid JSON', 'error'); return; }
    try {
      await writeCanonical({ batch_id: batchId, checkpoint_id: checkpointId, canonical_expected_expression: parsed });
      onToast(isAr ? 'تم حفظ التعبير المرجعي' : 'canonical expression saved', 'success');
    } catch (e) { onToast(e instanceof Error ? e.message : String(e), 'error'); }
  };

  const checkpointSubjects = subjects.filter((s) => s.subject.subject_kind === 'checkpoint');
  const kindByRef = new Map(subjects.map((s) => [s.subject.subject_ref, s.subject.subject_kind]));

  if (loading) return <div className="flex items-center gap-2 p-6 text-charcoal/50"><Loader2 className="animate-spin" size={16} />{isAr ? 'جارٍ حساب الاتفاق…' : 'computing agreement…'}</div>;
  if (!agr) return null;

  return (
    <div className="space-y-5">
      {/* Per-field agreement */}
      <div className="card overflow-hidden">
        <div className="border-b border-sand/30 bg-cream/40 px-4 py-2 text-sm font-bold text-charcoal">
          {isAr ? 'الاتفاق بين المُقيّمين (كابا)' : 'Inter-annotator agreement (κ)'}
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-sand/30 text-charcoal/50">
              <th className="px-3 py-1.5 text-start">{isAr ? 'الحقل' : 'Field'}</th>
              <th className="px-3 py-1.5">n</th>
              <th className="px-3 py-1.5">{isAr ? 'اتفاق خام' : 'Raw'}</th>
              <th className="px-3 py-1.5">κ</th>
            </tr>
          </thead>
          <tbody>
            {agr.per_field.map((f) => (
              <tr key={f.field} className="border-b border-sand/20">
                <td className="px-3 py-1.5 font-mono text-[11px] text-charcoal">{f.field}</td>
                <td className="px-3 py-1.5 text-center">{f.n}</td>
                <td className="px-3 py-1.5 text-center">{(f.raw_agreement * 100).toFixed(0)}%</td>
                <td className="px-3 py-1.5 text-center">
                  <span className={`rounded px-1.5 py-0.5 font-bold ${f.cohen_kappa >= 0.8 ? 'bg-emerald-100 text-emerald-700' : f.cohen_kappa >= 0.6 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}`}>
                    {f.cohen_kappa.toFixed(2)}
                  </span>
                </td>
              </tr>
            ))}
            {agr.per_field.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-4 text-center text-charcoal/40">{isAr ? 'لا توجد تسميات عمياء بعد' : 'no blind labels yet'}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Survivors — the genuine disagreements to adjudicate */}
      <div className="card p-4">
        <div className="mb-3 text-sm font-bold text-charcoal">
          {isAr ? 'الخلافات الباقية' : 'Surviving disagreements'} ({agr.survivors.length})
        </div>
        {agr.survivors.length === 0 ? (
          <p className="text-xs text-charcoal/40">{isAr ? 'لا خلافات — اتفاق كامل.' : 'no disagreements — full agreement.'}</p>
        ) : (
          <div className="space-y-2">
            {agr.survivors.map((s, i) => (
              <div key={`${s.item_id}.${s.field}.${i}`} className="rounded-lg border border-sand/40 bg-cream/20 p-2.5">
                <div className="mb-1.5 flex items-center justify-between">
                  <code className="text-[11px] text-charcoal">{s.field}</code>
                  <span className="rounded-full bg-terracotta/10 px-2 py-0.5 text-[10px] font-bold text-terracotta">
                    {s.must_confirm_condition}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-charcoal/50">{isAr ? 'اختر المرجع:' : 'pick canonical:'}</span>
                  {[s.labeler_a, s.labeler_b].filter((v, idx, arr) => arr.indexOf(v) === idx).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => pickAdjudication(s.item_id, s.field, kindByRef.get(s.item_id) ?? 'evidence', v)}
                      className="rounded-lg border border-copper/50 bg-white px-2.5 py-1 text-xs font-semibold text-copper hover:bg-copper hover:text-white"
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Canonical expected expression per checkpoint */}
      {checkpointSubjects.length > 0 && (
        <div className="card p-4">
          <div className="mb-1 text-sm font-bold text-charcoal">{isAr ? 'التعبير المرجعي المتوقع' : 'Canonical expected expression'}</div>
          <p className="mb-3 text-[11px] text-charcoal/50">
            {isAr
              ? 'مفتاح الإجابة المستقل لكل نقطة تحقق — يُكتب على geo_pref_checkpoints، وليس مخرج المُجمِّع الإنتاجي.'
              : 'The independent answer key per checkpoint — written onto geo_pref_checkpoints, never the production compiler output.'}
          </p>
          <div className="space-y-3">
            {checkpointSubjects.map((s) => (
              <div key={s.subject.subject_ref} className="rounded-lg border border-sand/40 p-2.5">
                <code className="text-[11px] text-charcoal/60">checkpoint {s.subject.subject_ref}</code>
                <textarea
                  value={canon[s.subject.subject_ref] ?? ''}
                  onChange={(e) => setCanon((c) => ({ ...c, [s.subject.subject_ref]: e.target.value }))}
                  placeholder='{"schema_version":"v7","groups":[]}'
                  rows={4}
                  className="mt-1.5 w-full rounded-lg border border-sand/50 bg-cream/20 p-2 font-mono text-[11px] text-charcoal focus:border-copper focus:outline-none"
                />
                <div className="mt-1.5 flex justify-end">
                  <Button variant="secondary" className="!py-1.5 !text-xs" onClick={() => saveCanonical(s.subject.subject_ref)}>
                    {isAr ? 'حفظ المفتاح' : 'Save answer key'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
