import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import ModelList from './components/ModelList';
import ModelEditor from './components/ModelEditor';
import { Hammer, PanelLeftOpen, PanelLeftClose } from 'lucide-react';

export default function ModelBuilderPage() {
  const { modelId } = useParams();
  const { t } = useTranslation();
  const { models } = useAppStore();
  const selectedModel = modelId ? models.find((m) => m.id === modelId) : null;
  const [sidebarOpen, setSidebarOpen] = useState(true);

  return (
    <div className="flex -m-6 min-h-[calc(100vh-64px)]">
      {/* Model list sidebar — collapsible */}
      {sidebarOpen ? (
        <div className="w-64 shrink-0 bg-white border-e border-sand/30 overflow-y-auto flex flex-col">
          <div className="flex items-center justify-between px-3 pt-3">
            <span />
            <button
              onClick={() => setSidebarOpen(false)}
              className="p-1.5 rounded-lg hover:bg-cream text-charcoal/25 hover:text-charcoal transition-colors"
              title={t('common.collapse')}
            >
              <PanelLeftClose size={16} />
            </button>
          </div>
          <ModelList selectedModelId={modelId} />
        </div>
      ) : (
        <div className="w-10 shrink-0 bg-white border-e border-sand/30 flex flex-col items-center pt-3">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 rounded-lg hover:bg-cream text-charcoal/25 hover:text-charcoal transition-colors"
            title={t('common.expand')}
          >
            <PanelLeftOpen size={16} />
          </button>
        </div>
      )}

      {/* Editor area */}
      <div className="flex-1 p-6 flex flex-col overflow-hidden">
        {selectedModel ? (
          <ModelEditor model={selectedModel} />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-charcoal/40">
            <Hammer size={48} className="mb-4" />
            <p className="text-lg font-bold">{t('builder.select_empty')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
