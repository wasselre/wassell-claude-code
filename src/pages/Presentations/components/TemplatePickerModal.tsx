import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import Modal from '@/components/ui/Modal';
import { getIconComponent } from '@/components/layout/Sidebar';
import InputForm from './InputForm';
import type { PresentationTemplate } from '@/types';

interface TemplatePickerModalProps {
  open: boolean;
  onClose: () => void;
  /** When provided, pre-selects this record on the form and hides the record picker. */
  lockedRecordId?: string | null;
  /** When set, limits the catalog to templates whose `record_binding.model_slug`
   *  matches. Used by the record-page "Generate deck" button so the user only
   *  sees templates applicable to the record they're on. */
  filterByModelSlug?: string | null;
  /** Called after a job is successfully queued. The caller typically navigates
   *  to /presentations/:jobId. */
  onJobQueued?: (jobId: string) => void;
}

export default function TemplatePickerModal({
  open,
  onClose,
  lockedRecordId,
  filterByModelSlug,
  onJobQueued,
}: TemplatePickerModalProps) {
  const { t } = useTranslation();
  const {
    presentationTemplates,
    queuePresentationJob,
    addToast,
    language,
  } = useAppStore();
  const isAr = language === 'ar';

  const [picked, setPicked] = useState<PresentationTemplate | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const available = presentationTemplates
    .filter((tpl) => tpl.is_available)
    .filter((tpl) => {
      if (!filterByModelSlug) return true;
      return tpl.record_binding?.model_slug === filterByModelSlug;
    });

  // Auto-advance: when there's exactly one template available (common case
  // when invoked from a record page with a single matching template), skip
  // the picker step and drop straight into the input form. The user can
  // still hit × to close the modal.
  useEffect(() => {
    if (!open) return;
    if (picked) return;
    if (available.length === 1) {
      setPicked(available[0]!);
    }
  }, [open, picked, available]);

  const handleClose = (): void => {
    setPicked(null);
    setSubmitting(false);
    onClose();
  };

  const handleSubmit = async (args: {
    templateId: string;
    recordId: string | null;
    inputs: Record<string, unknown>;
  }): Promise<void> => {
    setSubmitting(true);
    try {
      const job = await queuePresentationJob({
        templateId: args.templateId,
        recordId: args.recordId,
        inputs: args.inputs,
      });
      addToast(
        isAr ? 'تمت إضافة العرض إلى قائمة الانتظار' : 'Deck queued',
        'success',
      );
      handleClose();
      if (onJobQueued) onJobQueued(job.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast(msg, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={
        picked
          ? isAr ? picked.label_ar : picked.label_en
          : t('presentations.pick_template')
      }
      maxWidth="max-w-2xl"
    >
      {!picked ? (
        <div className="space-y-3">
          {available.length === 0 ? (
            <div className="text-center py-10 text-charcoal/40">
              <p className="text-sm">
                {isAr
                  ? 'لا توجد قوالب متاحة. قم بإنشاء قالب في Claude Code أولاً.'
                  : 'No templates available. Create one in Claude Code first.'}
              </p>
            </div>
          ) : (
            available.map((tpl) => {
              const Icon = getIconComponent(tpl.icon);
              const label = isAr ? tpl.label_ar : tpl.label_en;
              const description = isAr ? tpl.description_ar : tpl.description_en;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => setPicked(tpl)}
                  className="w-full text-start p-4 rounded-xl border border-sand/40 hover:border-copper hover:bg-cream/40 transition-all"
                >
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-copper/10 flex items-center justify-center shrink-0">
                      <Icon size={18} className="text-copper" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-bold text-charcoal">{label}</h3>
                        {typeof tpl.estimated_duration_seconds === 'number' && (
                          <span className="text-xs text-charcoal/40">
                            {isAr
                              ? `~${Math.round(tpl.estimated_duration_seconds / 60)} دقيقة`
                              : `~${Math.round(tpl.estimated_duration_seconds / 60)} min`}
                          </span>
                        )}
                      </div>
                      {description && (
                        <p className="text-sm text-charcoal/50 mt-1">{description}</p>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      ) : (
        <InputForm
          template={picked}
          lockedRecordId={lockedRecordId ?? null}
          onSubmit={handleSubmit}
          onCancel={() => setPicked(null)}
          submitting={submitting}
        />
      )}
    </Modal>
  );
}
