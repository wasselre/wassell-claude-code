import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { v4 as uuid } from 'uuid';
import { Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useDebouncedTranslation } from '@/hooks/useDebouncedTranslation';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import IconPickerModal from './IconPickerModal';
import { getIconComponent } from '@/components/layout/Sidebar';
import { MAPS_CONFIG_DEFAULT } from '@/types';
import type { AppModel } from '@/types';

const COLOR_PRESETS = [
  '#B8734F', '#8E4E3A', '#C09B5F', '#4A2C2A', '#4A4E54', '#D4B896',
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899',
  '#14B8A6', '#F97316', '#6366F1', '#84CC16',
];

interface CreateModelModalProps {
  open: boolean;
  onClose: () => void;
}

export default function CreateModelModal({ open, onClose }: CreateModelModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { saveModel, groups, saveGroup, language } = useAppStore();
  const isAr = language === 'ar';

  const [name, setName] = useState('');
  const [icon, setIcon] = useState('database');
  const [color, setColor] = useState('#B8734F');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState('');
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Live translate the model name as the user types — fills both labels
  // and the snake_case slug. Status drives the submit button state so the
  // user never saves a half-translated model.
  const modelTranslation = useDebouncedTranslation(name, { kind: 'model' });
  const groupTranslation = useDebouncedTranslation(newGroupName, {
    kind: 'group',
    enabled: showNewGroup,
  });

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      // Block save until we have a real translation. translateNow() is a
      // no-op if the debounce already settled — otherwise it forces an
      // immediate fetch. Throws on failure (toast already shown).
      const modelLabels = modelTranslation.result ?? (await modelTranslation.translateNow());

      let finalGroupId = groupId;
      if (showNewGroup && newGroupName.trim()) {
        const groupLabels = groupTranslation.result ?? (await groupTranslation.translateNow());
        const newGroup = {
          id: uuid(),
          label_ar: groupLabels.label_ar,
          label_en: groupLabels.label_en,
          order: groups.length,
        };
        saveGroup(newGroup);
        finalGroupId = newGroup.id;
      }

      const baseSectionLabels = isAr
        ? { label_ar: 'معلومات عامة', label_en: 'General Information' }
        : { label_ar: 'معلومات عامة', label_en: 'General Information' };

      const baseSectionId = uuid();
      const model: AppModel = {
        id: uuid(),
        name: modelLabels.name,
        label_ar: modelLabels.label_ar,
        label_en: modelLabels.label_en,
        icon,
        color,
        group_id: finalGroupId,
        is_system: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        card_config: {
          title_field_id: null,
          subtitle_field_id: null,
          badge_field_id: null,
          shown_field_ids: [],
        },
        maps_config: { ...MAPS_CONFIG_DEFAULT },
        schema: {
          section_selector_field_id: null,
          sections: [
            {
              id: baseSectionId,
              ...baseSectionLabels,
              order: 0,
              is_base: true,
              color: color,
              fields: [],
            },
          ],
        },
      };

      saveModel(model);
      resetForm();
      onClose();
      navigate(`/builder/${model.id}`);
    } catch {
      // Translation failure — already toasted by the hook. Stay on the modal.
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setName('');
    setIcon('database');
    setColor('#B8734F');
    setGroupId(null);
    setNewGroupName('');
    setShowNewGroup(false);
  };

  const SelectedIcon = getIconComponent(icon);

  const modelStatus = modelTranslation.status;
  const groupStatus = groupTranslation.status;
  const previewLabel = modelTranslation.result
    ? (isAr ? modelTranslation.result.label_en : modelTranslation.result.label_ar)
    : null;
  const previewSlug = modelTranslation.result?.name ?? null;

  const submitDisabled =
    submitting ||
    !name.trim() ||
    modelStatus === 'pending' ||
    modelStatus === 'error' ||
    (showNewGroup && newGroupName.trim() && (groupStatus === 'pending' || groupStatus === 'error'));

  return (
    <>
      <Modal
        open={open}
        onClose={() => { resetForm(); onClose(); }}
        title={t('builder.new_model')}
        footer={
          <>
            <Button variant="ghost" onClick={() => { resetForm(); onClose(); }} disabled={submitting}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={!!submitDisabled}>
              {submitting || modelStatus === 'pending' ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" />
                  {isAr ? 'جارٍ الترجمة…' : 'Translating…'}
                </span>
              ) : (
                t('common.create')
              )}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input
            label={isAr ? 'اسم النموذج' : 'Model Name'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            dir={isAr ? 'rtl' : 'ltr'}
            placeholder={isAr ? 'مثال: العملاء' : 'e.g. Clients'}
          />
          {name.trim() && (
            <div className="text-xs text-charcoal/55 -mt-2 ps-0.5 leading-relaxed">
              {modelStatus === 'pending' && (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 size={11} className="animate-spin" />
                  {isAr ? 'يترجم تلقائياً…' : 'Auto-translating…'}
                </span>
              )}
              {modelStatus === 'success' && previewLabel && (
                <span dir={isAr ? 'ltr' : 'rtl'}>
                  {isAr ? `الإنجليزية: ${previewLabel}` : `العربية: ${previewLabel}`}
                  {previewSlug && (
                    <span className="ms-2 font-mono text-charcoal/40" dir="ltr">· {previewSlug}</span>
                  )}
                </span>
              )}
              {modelStatus === 'error' && (
                <span className="text-red-500">
                  {isAr ? 'تعذرت الترجمة — حاول مجدداً' : 'Translation failed — try again'}
                </span>
              )}
            </div>
          )}

          {/* Icon + Color row */}
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-sm font-bold text-charcoal mb-1">
                {t('builder.select_icon')}
              </label>
              <button
                onClick={() => setShowIconPicker(true)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-sand/30 hover:bg-cream transition-colors"
              >
                <SelectedIcon size={20} style={{ color }} />
                <span className="text-sm text-charcoal/60">{icon}</span>
              </button>
            </div>
            <div className="flex-1">
              <label className="block text-sm font-bold text-charcoal mb-1">
                {t('builder.select_color')}
              </label>
              <div className="flex flex-wrap gap-1.5">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={`w-6 h-6 rounded-full border-2 transition-transform ${
                      c === color ? 'border-charcoal scale-125' : 'border-transparent'
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Group selector */}
          <div>
            <label className="block text-sm font-bold text-charcoal mb-1">
              {t('builder.select_group')}
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => { setGroupId(null); setShowNewGroup(false); }}
                className={`pill ${groupId === null && !showNewGroup ? 'active' : ''}`}
              >
                {t('builder.no_group')}
              </button>
              {groups.map((g) => (
                <button
                  key={g.id}
                  onClick={() => { setGroupId(g.id); setShowNewGroup(false); }}
                  className={`pill ${groupId === g.id ? 'active' : ''}`}
                >
                  {isAr ? g.label_ar : g.label_en}
                </button>
              ))}
              <button
                onClick={() => { setShowNewGroup(true); setGroupId(null); }}
                className={`pill ${showNewGroup ? 'active' : ''}`}
              >
                + {t('builder.new_group')}
              </button>
            </div>
            {showNewGroup && (
              <div className="mt-3">
                <Input
                  placeholder={isAr ? 'اسم المجموعة' : 'Group name'}
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  dir={isAr ? 'rtl' : 'ltr'}
                />
                {newGroupName.trim() && groupStatus === 'pending' && (
                  <div className="text-xs text-charcoal/55 mt-1 ps-0.5 inline-flex items-center gap-1.5">
                    <Loader2 size={11} className="animate-spin" />
                    {isAr ? 'يترجم اسم المجموعة…' : 'Translating group name…'}
                  </div>
                )}
                {groupStatus === 'error' && (
                  <div className="text-xs text-red-500 mt-1 ps-0.5">
                    {isAr ? 'تعذرت ترجمة اسم المجموعة' : 'Group name translation failed'}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </Modal>

      <IconPickerModal
        open={showIconPicker}
        onClose={() => setShowIconPicker(false)}
        onSelect={setIcon}
        selected={icon}
      />
    </>
  );
}
