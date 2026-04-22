import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { getIconComponent } from '@/components/layout/Sidebar';
import { Plus, Folder, Lock } from 'lucide-react';
import CreateModelModal from './CreateModelModal';

interface ModelListProps {
  selectedModelId?: string;
  onSelect?: () => void;
}

export default function ModelList({ selectedModelId, onSelect }: ModelListProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { models, groups, language } = useAppStore();
  const [showCreate, setShowCreate] = useState(false);
  const isAr = language === 'ar';

  const ungroupedModels = models.filter((m) => !m.group_id);
  const groupedModels = groups.map((g) => ({
    group: g,
    models: models.filter((m) => m.group_id === g.id),
  }));

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-sand/50">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-charcoal">{t('builder.model_list')}</h2>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-copper/10 text-copper hover:bg-copper/20 transition-colors text-sm font-bold"
        >
          <Plus size={16} />
          {t('builder.new_model')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {/* Ungrouped */}
        {ungroupedModels.map((model) => {
          const Icon = getIconComponent(model.icon);
          const isSelected = model.id === selectedModelId;
          return (
            <button
              key={model.id}
              onClick={() => {
                navigate(`/builder/${model.id}`);
                onSelect?.();
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-start ${
                isSelected
                  ? 'bg-copper/10 text-copper'
                  : 'text-charcoal hover:bg-cream'
              }`}
            >
              <div
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: model.color }}
              />
              <Icon size={16} className="shrink-0" />
              <span className="truncate font-bold">{isAr ? model.label_ar : model.label_en}</span>
              {model.is_system && <Lock size={12} className="shrink-0 text-charcoal/30" />}
            </button>
          );
        })}

        {/* Grouped */}
        {groupedModels.map(({ group, models: gModels }) => (
          <div key={group.id} className="pt-2">
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs font-bold text-charcoal/40 uppercase tracking-wider">
              <Folder size={12} />
              {isAr ? group.label_ar : group.label_en}
            </div>
            {gModels.map((model) => {
              const Icon = getIconComponent(model.icon);
              const isSelected = model.id === selectedModelId;
              return (
                <button
                  key={model.id}
                  onClick={() => {
                navigate(`/builder/${model.id}`);
                onSelect?.();
              }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors text-start ${
                    isSelected
                      ? 'bg-copper/10 text-copper'
                      : 'text-charcoal hover:bg-cream'
                  }`}
                >
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: model.color }}
                  />
                  <Icon size={16} className="shrink-0" />
                  <span className="truncate font-bold">{isAr ? model.label_ar : model.label_en}</span>
                  {model.is_system && <Lock size={12} className="shrink-0 text-charcoal/30" />}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <CreateModelModal open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  );
}
