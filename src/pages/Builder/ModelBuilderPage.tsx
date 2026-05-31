import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import ModelList from './components/ModelList';
import ModelEditor from './components/ModelEditor';
import BackToSettings from '@/pages/Settings/components/BackToSettings';
import { Hammer, PanelLeftOpen, PanelLeftClose } from 'lucide-react';

export default function ModelBuilderPage() {
  const { modelId } = useParams();
  const { t } = useTranslation();
  const { models } = useAppStore();
  const selectedModel = modelId ? models.find((m) => m.id === modelId) : null;
  // Collapse the model list by default on mobile so the editor has room. Desktop
  // users still see the full list on first load.
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= 768,
  );

  return (
    <div className="flex flex-col md:flex-row -m-4 md:-m-6 min-h-[calc(100vh-64px)]">
      {/* Model list sidebar — full-width top strip on mobile, 256px side rail on desktop.
          Stays collapsed by default on mobile so the editor has room; users open it
          to pick a different model, then it auto-collapses via the onSelect callback. */}
      {sidebarOpen ? (
        <div className="w-full md:w-64 shrink-0 bg-white border-b md:border-b-0 md:border-e border-sand/30 overflow-y-auto flex flex-col max-h-[60vh] md:max-h-none">
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
          <ModelList selectedModelId={modelId} onSelect={() => setSidebarOpen(false)} />
        </div>
      ) : (
        <div className="w-full md:w-10 shrink-0 bg-white border-b md:border-b-0 md:border-e border-sand/30 flex md:flex-col items-center justify-between md:justify-start px-3 md:px-0 py-2 md:pt-3">
          <button
            onClick={() => setSidebarOpen(true)}
            className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-cream text-charcoal/40 hover:text-charcoal transition-colors"
            title={t('common.expand')}
          >
            <PanelLeftOpen size={16} />
            <span className="md:hidden text-xs font-bold">{t('builder.title')}</span>
          </button>
        </div>
      )}

      {/* Editor area */}
      <div className="flex-1 p-4 md:p-6 flex flex-col overflow-hidden">
        <BackToSettings />
        {selectedModel ? (
          <ModelEditor model={selectedModel} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center py-16 md:py-0 text-charcoal/40">
            <Hammer size={48} className="mb-4" />
            <p className="text-lg font-bold text-center px-4">{t('builder.select_empty')}</p>
          </div>
        )}
      </div>
    </div>
  );
}
