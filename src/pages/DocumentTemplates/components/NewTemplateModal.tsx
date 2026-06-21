import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { createDocument } from '@/lib/documents/client';
import { renderDocumentHtml } from '@/lib/documents/render';
import { linkableModels } from '@/lib/documents/links';
import { createTemplateBinding } from '@/lib/documents/templateRegistry';
import { startersForModel, buildStarterContent, type RecordDocStarter } from '@/lib/documents/recordDocTemplates';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** Create a new document template: choose a target model + optional starter,
 *  instantiate it as an ordinary wassel_doc, bind it, and open the editor. */
export default function NewTemplateModal({ open, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);

  const pickableModels = useMemo(() => linkableModels(models), [models]);
  const [modelId, setModelId] = useState('');
  const [starterId, setStarterId] = useState('blank');
  const [labelAr, setLabelAr] = useState('');
  const [labelEn, setLabelEn] = useState('');
  const [busy, setBusy] = useState(false);

  const selectedModel = pickableModels.find((m) => m.id === modelId);
  const starters = selectedModel ? startersForModel(selectedModel.name) : [];

  const applyStarter = (s: RecordDocStarter | null) => {
    if (s) {
      setStarterId(s.id);
      setLabelAr(s.labelAr);
      setLabelEn(s.labelEn);
    } else {
      setStarterId('blank');
    }
  };

  const onPickModel = (id: string) => {
    setModelId(id);
    // Auto-apply the first starter for this model, if any.
    const next = pickableModels.find((m) => m.id === id);
    const first = next ? startersForModel(next.name)[0] : undefined;
    applyStarter(first ?? null);
  };

  const canCreate = !!modelId && (labelAr.trim() || labelEn.trim()) && !busy;

  const handleCreate = async () => {
    if (!selectedModel) return;
    setBusy(true);
    try {
      const starter = starters.find((s) => s.id === starterId);
      const contentJson = starter ? (buildStarterContent(starter, isAr) as Record<string, unknown>) : EMPTY_DOC;
      const contentHtml = renderDocumentHtml(contentJson as never);
      const title = (isAr ? labelAr : labelEn) || labelEn || labelAr;
      const file = await createDocument({ title, contentJson, contentHtml });
      await createTemplateBinding({
        fileId: file.id,
        modelId: selectedModel.id,
        templateKey: starter?.templateKey || slugify(labelEn || labelAr) || `template_${Date.now()}`,
        labelAr: labelAr.trim() || labelEn.trim(),
        labelEn: labelEn.trim() || labelAr.trim(),
        isDefault: true, // first/most-recent becomes the model's default; adjust on the list page
      });
      onCreated();
      navigate(`/files/doc/${file.id}`);
    } catch {
      /* surfaced by the services */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={t('templates.new')}
      maxWidth="max-w-md"
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!canCreate} onClick={() => void handleCreate()}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : null}
            {busy ? t('templates.creating') : t('templates.create_open')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="text-xs font-bold text-charcoal/50 mb-1 block">{t('templates.bind_model')}</label>
          <select value={modelId} onChange={(e) => onPickModel(e.target.value)} className="form-input w-full">
            <option value="">—</option>
            {pickableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {isAr ? m.label_ar : m.label_en}
              </option>
            ))}
          </select>
        </div>

        {selectedModel && (
          <div>
            <label className="text-xs font-bold text-charcoal/50 mb-1 block">{t('templates.starter')}</label>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => applyStarter(null)}
                className={`px-3 py-1.5 rounded-lg text-sm border ${
                  starterId === 'blank' ? 'border-copper bg-copper/10 text-copper font-bold' : 'border-sand/40 text-charcoal/70'
                }`}
              >
                {t('templates.starter_blank')}
              </button>
              {starters.map((s) => (
                <button
                  key={s.id}
                  onClick={() => applyStarter(s)}
                  className={`px-3 py-1.5 rounded-lg text-sm border ${
                    starterId === s.id ? 'border-copper bg-copper/10 text-copper font-bold' : 'border-sand/40 text-charcoal/70'
                  }`}
                >
                  {isAr ? s.labelAr : s.labelEn}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-bold text-charcoal/50 mb-1 block">{t('templates.label_ar')}</label>
            <input value={labelAr} onChange={(e) => setLabelAr(e.target.value)} className="form-input w-full" dir="rtl" />
          </div>
          <div>
            <label className="text-xs font-bold text-charcoal/50 mb-1 block">{t('templates.label_en')}</label>
            <input value={labelEn} onChange={(e) => setLabelEn(e.target.value)} className="form-input w-full" dir="ltr" />
          </div>
        </div>
      </div>
    </Modal>
  );
}
