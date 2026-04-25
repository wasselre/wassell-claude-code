import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { Plus, Pencil, Trash2, Zap, ScrollText, Sparkles } from 'lucide-react';
import Button from '@/components/ui/Button';

export default function WorkflowListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { workflows, models, language, saveWorkflow, deleteWorkflow, addToast } = useAppStore();
  const isAr = language === 'ar';

  const getModelName = (modelId: string) => {
    const m = models.find((mod) => mod.id === modelId);
    return m ? (isAr ? m.label_ar : m.label_en) : '—';
  };

  const eventLabels: Record<string, string> = {
    create: t('workflow.event_create'),
    update: t('workflow.event_update'),
    delete: t('workflow.event_delete'),
  };

  const toggleActive = (wf: typeof workflows[0]) => {
    saveWorkflow({ ...wf, is_active: !wf.is_active });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-charcoal">{t('workflow.title')}</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/workflow/logs')}
            className="pill text-charcoal/60 border-sand/30 hover:bg-cream-light"
          >
            <ScrollText size={14} />
            {isAr ? 'السجلات' : 'Logs'}
          </button>
          <button
            onClick={() => navigate('/workflow/agent')}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-gradient-to-br from-amber-400 to-copper text-white hover:shadow-lg hover:shadow-copper/30 transition-all text-sm font-bold"
            title={isAr ? 'أنشئ قاعدة بمحادثة طبيعية' : 'Build a workflow by chatting in natural language'}
          >
            <Sparkles size={14} />
            {isAr ? 'مساعد ذكي' : 'AI Builder'}
          </button>
          <Button onClick={() => navigate('/workflow/new')}>
            <Plus size={16} />
            {t('workflow.new')}
          </Button>
        </div>
      </div>

      {workflows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-charcoal/30">
          <Zap size={48} className="mb-4" />
          <p className="text-lg font-bold">{t('workflow.no_workflows')}</p>
          <p className="text-sm">{t('workflow.create_first')}</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {workflows.map((wf) => (
            <div key={wf.id} className="card p-6 flex items-center justify-between">
              <div>
                <h3 className="font-bold text-charcoal">{isAr ? wf.label_ar : wf.label_en}</h3>
                <p className="text-sm text-charcoal/50 mt-1">
                  {getModelName(wf.trigger_model_id)} — {eventLabels[wf.trigger_event] ?? wf.trigger_event}
                </p>
                <p className="text-xs text-charcoal/30 mt-1">
                  {(() => {
                    const branches = wf.branches ?? [];
                    const branchCount = branches.length;
                    const actionCount = branches.length > 0
                      ? branches.reduce((sum, b) => sum + b.actions.length, 0)
                      : wf.actions.length;
                    const parts: string[] = [];
                    if (branchCount > 1) {
                      parts.push(isAr ? `${branchCount} فرع` : `${branchCount} branches`);
                    }
                    parts.push(isAr ? `${actionCount} إجراء` : `${actionCount} action${actionCount === 1 ? '' : 's'}`);
                    return parts.join(' · ');
                  })()}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={wf.is_active}
                    onChange={() => toggleActive(wf)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-sand/50 rounded-full peer peer-checked:bg-copper peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border after:rounded-full after:h-5 after:w-5 after:transition-all" />
                </label>
                <button
                  onClick={() => navigate(`/workflow/${wf.id}`)}
                  className="p-2 rounded-lg hover:bg-cream text-charcoal/40 hover:text-charcoal"
                >
                  <Pencil size={16} />
                </button>
                <button
                  onClick={() => { deleteWorkflow(wf.id); addToast(t('toast.deleted'), 'success'); }}
                  className="p-2 rounded-lg hover:bg-red-50 text-charcoal/40 hover:text-red-500"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
