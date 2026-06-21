import { useState } from 'react';
import { v4 as uuid } from 'uuid';
import { Trophy } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import type { SalesExperiment, SalesProcess, SalesProcessVersion } from '@/types';
import type { ExperimentComparison } from '@/lib/salesStudio';
import { RECOMMENDATION_LABEL } from '@/lib/salesStudio';
import { pick } from '../lib/labels';

type PromoteAction = 'promote_default' | 'create_process' | 'publish_active' | 'archive_variant' | 'keep_both';

/** Promote a winning experiment outcome into the process/version records safely. */
export default function PromoteWinnerModal({
  open, onClose, experiment, comparison,
}: {
  open: boolean;
  onClose: () => void;
  experiment: SalesExperiment;
  comparison: ExperimentComparison;
}) {
  const {
    language, salesProcesses, salesProcessVersions, currentUserId,
    setDefaultSalesProcess, publishSalesProcessVersion, saveSalesProcess, saveSalesProcessVersion, saveSalesExperiment, addToast,
  } = useAppStore();
  const isAr = language === 'ar';
  const [action, setAction] = useState<PromoteAction>('keep_both');
  const [busy, setBusy] = useState(false);

  const variantVersion = salesProcessVersions.find((v) => v.id === experiment.variant_process_version_id);
  const variantProcess = variantVersion ? salesProcesses.find((p) => p.id === variantVersion.sales_process_id) : undefined;

  const options: { id: PromoteAction; label: { ar: string; en: string }; desc: { ar: string; en: string }; disabled?: boolean }[] = [
    { id: 'promote_default', label: { ar: 'تعيين مسار المتغيّرة كافتراضي', en: 'Promote variant to default process' }, desc: { ar: 'يصبح مسار المجموعة المتغيّرة هو الافتراضي لكل عميل غير معيّن.', en: "The variant's process becomes the default for all unassigned clients." }, disabled: !variantProcess },
    { id: 'publish_active', label: { ar: 'نشر إصدار المتغيّرة كنشط', en: 'Publish variant as active version' }, desc: { ar: 'يصبح إصدار المتغيّرة هو النشط في مساره ويُؤرشف الإصدار السابق.', en: "The variant version becomes active in its process; the prior active is archived." }, disabled: !variantVersion },
    { id: 'create_process', label: { ar: 'إنشاء مسار جديد من المتغيّرة', en: 'Create a new process from variant' }, desc: { ar: 'ينسخ إعداد المتغيّرة إلى مسار جديد مستقل.', en: "Copies the variant's config into a brand-new standalone process." }, disabled: !variantVersion },
    { id: 'archive_variant', label: { ar: 'أرشفة إصدار المتغيّرة (رفض)', en: 'Archive the variant version (reject)' }, desc: { ar: 'يؤرشف إصدار المتغيّرة الخاسر.', en: 'Archives the losing variant version.' }, disabled: !variantVersion },
    { id: 'keep_both', label: { ar: 'الإبقاء على الاثنين', en: 'Keep both' }, desc: { ar: 'إنهاء التجربة دون تغيير أي مسار.', en: 'Complete the experiment without changing any process.' } },
  ];

  const run = async () => {
    setBusy(true);
    const now = new Date().toISOString();
    try {
      if (action === 'promote_default' && variantProcess) {
        await setDefaultSalesProcess(variantProcess.id);
      } else if (action === 'publish_active' && variantVersion) {
        await publishSalesProcessVersion(variantVersion.id);
      } else if (action === 'create_process' && variantVersion) {
        const processId = uuid();
        const versionId = uuid();
        const newProcess: SalesProcess = {
          id: processId,
          name_ar: `${isAr ? experiment.name_ar : experiment.name_en} — ${isAr ? 'فائز' : 'winner'}`,
          name_en: `${experiment.name_en} — winner`,
          description_ar: isAr ? experiment.hypothesis_ar ?? null : null,
          description_en: experiment.hypothesis_en ?? null,
          status: 'active', is_default: false, active_version_id: versionId,
          created_by: currentUserId, created_at: now, updated_at: now,
        };
        const newVersion: SalesProcessVersion = {
          id: versionId, sales_process_id: processId, version_number: 1, status: 'active',
          config_json: JSON.parse(JSON.stringify(variantVersion.config_json)),
          published_at: now, published_by: currentUserId, created_at: now, updated_at: now,
        };
        saveSalesProcess(newProcess);
        saveSalesProcessVersion(newVersion);
      } else if (action === 'archive_variant' && variantVersion) {
        saveSalesProcessVersion({ ...variantVersion, status: 'archived', updated_at: now });
      }
      // Mark the experiment completed + stamp a result summary.
      saveSalesExperiment({
        ...experiment,
        status: 'completed',
        result_summary_json: {
          promoted_action: action,
          recommendation: comparison.recommendation,
          winner: comparison.winner,
          primary_metric: comparison.primary_metric,
          decided_at: now,
        },
        updated_at: now,
      });
      addToast(isAr ? 'تم تنفيذ القرار' : 'Decision applied', 'success');
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isAr ? 'اعتماد نتيجة التجربة' : 'Promote experiment result'}
      maxWidth="max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>{isAr ? 'إلغاء' : 'Cancel'}</Button>
          <Button variant="primary" onClick={run} disabled={busy}>{isAr ? 'تنفيذ' : 'Apply'}</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-xl bg-copper/10 px-3 py-2 text-sm">
          <Trophy size={16} className="text-copper" />
          <span className="text-charcoal/80">{isAr ? 'التوصية: ' : 'Recommendation: '}<b>{pick(RECOMMENDATION_LABEL[comparison.recommendation], isAr)}</b></span>
        </div>
        {comparison.low_sample && (
          <p className="text-xs text-terracotta">{isAr ? 'تنبيه: حجم العينة صغير — القرار قد لا يكون موثوقًا.' : 'Note: low sample size — the decision may not be reliable.'}</p>
        )}
        <div className="space-y-2">
          {options.map((o) => (
            <label key={o.id} className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 ${action === o.id ? 'border-copper bg-copper/5' : 'border-sand/40'} ${o.disabled ? 'pointer-events-none opacity-40' : ''}`}>
              <input type="radio" name="promote" checked={action === o.id} disabled={o.disabled} onChange={() => setAction(o.id)} className="mt-0.5" />
              <span>
                <span className="block text-sm font-semibold text-charcoal">{pick(o.label, isAr)}</span>
                <span className="block text-xs text-charcoal/55">{pick(o.desc, isAr)}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
