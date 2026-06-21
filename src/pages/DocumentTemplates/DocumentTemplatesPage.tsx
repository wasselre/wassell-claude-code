import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FileText, Plus, Pencil, Star, Trash2, Loader2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import ConfirmModal from '@/components/ui/ConfirmModal';
import { useAppStore } from '@/stores/appStore';
import {
  listTemplates,
  setDefaultTemplate,
  deleteTemplateBinding,
  type DocumentTemplateBinding,
} from '@/lib/documents/templateRegistry';
import NewTemplateModal from './components/NewTemplateModal';

export default function DocumentTemplatesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const addToast = useAppStore((s) => s.addToast);

  const [templates, setTemplates] = useState<DocumentTemplateBinding[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DocumentTemplateBinding | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const modelLabel = useMemo(() => {
    const map = new Map(models.map((m) => [m.id, isAr ? m.label_ar : m.label_en]));
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [models, isAr]);

  const refresh = async () => {
    try {
      setTemplates(await listTemplates());
    } catch {
      /* surfaced by the service */
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const makeDefault = async (tpl: DocumentTemplateBinding) => {
    setBusyId(tpl.id);
    try {
      await setDefaultTemplate(tpl.model_id, tpl.id);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      await deleteTemplateBinding(deleteTarget.id);
      addToast(isAr ? 'تم الحذف' : 'Deleted', 'success');
      setDeleteTarget(null);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="max-w-4xl">
      <div className="flex items-start justify-between gap-3 mb-8">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-terracotta/10 flex items-center justify-center">
            <FileText size={24} className="text-terracotta" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-chocolate">{t('templates.page_title')}</h1>
            <p className="text-sm text-charcoal/40">{t('templates.subtitle')}</p>
          </div>
        </div>
        <Button variant="primary" onClick={() => setShowNew(true)}>
          <Plus size={16} />
          {t('templates.new')}
        </Button>
      </div>

      {loaded && templates.length === 0 && (
        <div className="card p-8 text-center text-charcoal/40">
          <FileText size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">{t('templates.none')}</p>
        </div>
      )}

      <div className="space-y-2">
        {templates.map((tpl) => (
          <div
            key={tpl.id}
            className="card p-4 flex items-center gap-3"
          >
            <FileText size={18} className="text-copper shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-charcoal truncate">{isAr ? tpl.label_ar : tpl.label_en}</span>
                {tpl.is_default && (
                  <span className="text-[0.625rem] font-bold px-2 py-0.5 rounded-full bg-copper/10 text-copper">
                    {t('templates.default_pill')}
                  </span>
                )}
                {!tpl.is_active && (
                  <span className="text-[0.625rem] font-bold px-2 py-0.5 rounded-full bg-charcoal/10 text-charcoal/50">
                    {t('templates.archived_pill')}
                  </span>
                )}
              </div>
              <div className="text-xs text-charcoal/40 mt-0.5">
                {t('templates.for_model')} {modelLabel(tpl.model_id)}
              </div>
            </div>

            {!tpl.is_default && (
              <button
                onClick={() => void makeDefault(tpl)}
                disabled={busyId === tpl.id}
                className="shrink-0 p-2 rounded-lg hover:bg-cream text-charcoal/50 hover:text-copper"
                title={t('templates.set_default')}
              >
                {busyId === tpl.id ? <Loader2 size={16} className="animate-spin" /> : <Star size={16} />}
              </button>
            )}
            <button
              onClick={() => navigate(`/files/doc/${tpl.file_id}`)}
              className="shrink-0 p-2 rounded-lg hover:bg-cream text-charcoal/50 hover:text-copper"
              title={t('templates.edit')}
            >
              <Pencil size={16} />
            </button>
            <button
              onClick={() => setDeleteTarget(tpl)}
              className="shrink-0 p-2 rounded-lg hover:bg-red-50 text-charcoal/50 hover:text-red-500"
              title={t('templates.delete')}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>

      {showNew && (
        <NewTemplateModal
          open
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            void refresh();
          }}
        />
      )}

      <ConfirmModal
        open={!!deleteTarget}
        title={t('templates.delete')}
        message={t('templates.delete_confirm')}
        confirmLabel={t('templates.delete')}
        cancelLabel={t('common.cancel')}
        busy={busyId === deleteTarget?.id}
        onConfirm={() => void confirmDelete()}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
