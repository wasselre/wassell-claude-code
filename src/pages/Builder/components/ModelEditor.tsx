import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { getIconComponent } from '@/components/layout/Sidebar';
import { Trash2, Check, Loader2, Snowflake, Lock } from 'lucide-react';
import Button from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import SectionManager from './SectionManager';
import CardBuilder from './CardBuilder';
import MapsBuilder from './MapsBuilder';
import CustomButtonsTab from './CustomButtonsTab';
import FreezeModelModal from './FreezeModelModal';
import type { AppModel } from '@/types';

// Models excluded from Freeze because they have custom UIs that don't fit
// the generic record/form pattern (chats: dual-pane WhatsApp UI; ai_chats:
// inline message JSONB). Keep in sync with `is_freezable_model` in
// supabase/schema.sql.
const NON_FREEZABLE_MODELS = new Set(['chats', 'ai_chats']);

interface ModelEditorProps {
  model: AppModel;
}

export default function ModelEditor({ model }: ModelEditorProps) {
  const { t } = useTranslation();
  const { saveModel, deleteModel, language, addToast } = useAppStore();
  const isAr = language === 'ar';
  const [activeTab, setActiveTab] = useState<'fields' | 'card' | 'maps' | 'buttons'>('fields');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [showDelete, setShowDelete] = useState(false);
  const [showFreeze, setShowFreeze] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isFreezable = !NON_FREEZABLE_MODELS.has(model.name);
  const isFrozen = !!model.is_hardcoded;

  const handleModelChange = useCallback(
    (updated: AppModel) => {
      setSaveStatus('saving');
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        saveModel({ ...updated, updated_at: new Date().toISOString() });
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 1500);
      }, 800);
    },
    [saveModel],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleDelete = () => {
    deleteModel(model.id);
    addToast(t('toast.deleted'), 'success');
    setShowDelete(false);
    window.history.back();
  };

  const Icon = getIconComponent(model.icon);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: `${model.color}20` }}
          >
            <Icon size={22} style={{ color: model.color }} />
          </div>
          <div>
            <h2 className="text-xl font-bold text-charcoal">
              {isAr ? model.label_ar : model.label_en}
            </h2>
            <span className="text-xs text-charcoal/40 font-mono">{model.name}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Save indicator (hidden for frozen models — Builder is read-only). */}
          {!isFrozen && saveStatus === 'saving' && (
            <span className="flex items-center gap-1 text-xs text-charcoal/40">
              <Loader2 size={14} className="animate-spin" />
              {t('common.saving')}
            </span>
          )}
          {!isFrozen && saveStatus === 'saved' && (
            <span className="flex items-center gap-1 text-xs text-green-600">
              <Check size={14} />
              {t('common.saved')}
            </span>
          )}

          {/* Frozen pill — replaces the editing affordances when this model
              has been promoted to a dedicated table. */}
          {isFrozen && (
            <span
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-200 text-blue-800 text-xs font-bold"
              title={isAr ? 'هذا النموذج مجمّد — تعديل بنيته يتم عبر Claude' : 'Frozen — schema edits go through Claude'}
            >
              <Snowflake size={12} />
              {isAr ? 'مجمّد' : 'Frozen'}
              {model.table_name && (
                <span className="font-mono font-normal opacity-70">
                  · {model.table_name}
                </span>
              )}
            </span>
          )}

          {/* Freeze button — only when freezable AND not yet frozen. We keep
              system models freezable too (the user explicitly opted into
              that); only the custom-UI models in NON_FREEZABLE_MODELS are
              excluded. */}
          {isFreezable && !isFrozen && (
            <Button variant="ghost" onClick={() => setShowFreeze(true)}>
              <Snowflake size={16} />
              {isAr ? 'تجميد' : 'Freeze'}
            </Button>
          )}

          {/* Delete button — disabled for frozen models (the table is the
              source of truth now and dropping it should be deliberate). */}
          {!model.is_system && !isFrozen && (
            <Button variant="danger" onClick={() => setShowDelete(true)}>
              <Trash2 size={16} />
              {t('builder.delete_model')}
            </Button>
          )}
        </div>
      </div>

      {/* Read-only banner shown above tabs for frozen models so the user
          understands why the Builder UI is locked. */}
      {isFrozen && (
        <div className="mb-4 flex items-start gap-2 px-3 py-2 rounded-lg bg-blue-50 border border-blue-200 text-blue-900 text-sm">
          <Lock size={16} className="shrink-0 mt-0.5" />
          <div>
            <span className="font-bold">
              {isAr ? 'النموذج مجمّد — البنية للقراءة فقط.' : 'Model is frozen — schema is read-only.'}
            </span>{' '}
            <span className="opacity-80">
              {isAr
                ? 'لإضافة حقل أو تعديل البنية، اطلب من Claude كتابة ترحيل.'
                : 'To add a field or change the schema, ask Claude to write a migration.'}
            </span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-cream/50 p-1 rounded-lg w-fit">
        <button
          onClick={() => setActiveTab('fields')}
          className={`px-4 py-2 rounded-md text-sm font-bold transition-colors ${
            activeTab === 'fields'
              ? 'bg-white text-copper shadow-sm'
              : 'text-charcoal/50 hover:text-charcoal'
          }`}
        >
          {t('builder.fields_sections')}
        </button>
        <button
          onClick={() => setActiveTab('card')}
          className={`px-4 py-2 rounded-md text-sm font-bold transition-colors ${
            activeTab === 'card'
              ? 'bg-white text-copper shadow-sm'
              : 'text-charcoal/50 hover:text-charcoal'
          }`}
        >
          {t('builder.card_builder')}
        </button>
        <button
          onClick={() => setActiveTab('maps')}
          className={`px-4 py-2 rounded-md text-sm font-bold transition-colors ${
            activeTab === 'maps'
              ? 'bg-white text-copper shadow-sm'
              : 'text-charcoal/50 hover:text-charcoal'
          }`}
        >
          {t('builder.maps_builder')}
        </button>
        <button
          onClick={() => setActiveTab('buttons')}
          className={`px-4 py-2 rounded-md text-sm font-bold transition-colors ${
            activeTab === 'buttons'
              ? 'bg-white text-copper shadow-sm'
              : 'text-charcoal/50 hover:text-charcoal'
          }`}
        >
          {t('builder.custom_buttons')}
        </button>
      </div>

      {/* Tab Content — pass readOnly so each tab disables its editing
          affordances when the model is frozen. */}
      {activeTab === 'fields' && (
        <div className="flex-1 min-h-0">
          <SectionManager model={model} onChange={handleModelChange} readOnly={isFrozen} />
        </div>
      )}
      {activeTab === 'card' && (
        <div className="flex-1 overflow-y-auto">
          <CardBuilder model={model} onChange={handleModelChange} readOnly={isFrozen} />
        </div>
      )}
      {activeTab === 'maps' && (
        <div className="flex-1 overflow-y-auto">
          <MapsBuilder model={model} onChange={handleModelChange} readOnly={isFrozen} />
        </div>
      )}
      {activeTab === 'buttons' && (
        <div className="flex-1 overflow-y-auto">
          <CustomButtonsTab model={model} onChange={handleModelChange} readOnly={isFrozen} />
        </div>
      )}

      {/* Delete modal */}
      <Modal
        open={showDelete}
        onClose={() => setShowDelete(false)}
        title={t('builder.delete_model')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowDelete(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={handleDelete}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="text-charcoal">{t('builder.delete_model_confirm')}</p>
      </Modal>

      {/* Freeze modal — coercion preview + confirm step. */}
      <FreezeModelModal
        open={showFreeze}
        onClose={() => setShowFreeze(false)}
        model={model}
      />
    </div>
  );
}
