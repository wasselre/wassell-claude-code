import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import Badge from '@/components/ui/Badge';
import { collectViewFields, type ExpandedField } from '@/lib/sectionMirrorExpand';
import type { AppModel } from '@/types';

interface CardBuilderProps {
  model: AppModel;
  onChange: (model: AppModel) => void;
  /** Block edits when the model is frozen — see ModelEditor. */
  readOnly?: boolean;
}

export default function CardBuilder({ model, onChange, readOnly = false }: CardBuilderProps) {
  const { t } = useTranslation();
  const { language, models } = useAppStore();
  const isAr = language === 'ar';

  // Every selectable "field" — local fields PLUS the child fields surfaced
  // through each `section_mirror` container (so cards can show data mirrored in
  // from a linked record, e.g. a project's master fields). `section_mirror`
  // containers themselves are replaced by their children.
  const viewFields = useMemo(() => collectViewFields(model, models), [model, models]);
  const badgeFields = viewFields.filter((ef) => ef.field.type === 'dropdown' || ef.field.type === 'multiselect');

  const { card_config } = model;

  const update = (updates: Partial<typeof card_config>) => {
    onChange({ ...model, card_config: { ...card_config, ...updates } });
  };

  const titleField = viewFields.find((ef) => ef.id === card_config.title_field_id);
  const subtitleField = viewFields.find((ef) => ef.id === card_config.subtitle_field_id);
  const badgeField = viewFields.find((ef) => ef.id === card_config.badge_field_id);
  const shownFields = card_config.shown_field_ids
    .map((id) => viewFields.find((ef) => ef.id === id))
    .filter((ef): ef is ExpandedField => Boolean(ef));

  const toggleShownField = (fieldId: string) => {
    const ids = card_config.shown_field_ids.includes(fieldId)
      ? card_config.shown_field_ids.filter((id) => id !== fieldId)
      : [...card_config.shown_field_ids, fieldId];
    update({ shown_field_ids: ids });
  };

  return (
    <div
      className={`grid grid-cols-1 lg:grid-cols-2 gap-8 ${
        readOnly ? 'pointer-events-none select-none opacity-75' : ''
      }`}
      aria-disabled={readOnly || undefined}
    >
      {/* Config */}
      <div className="space-y-5">
        <div>
          <label className="block text-sm font-bold text-charcoal mb-1">{t('card.title_field')}</label>
          <select
            value={card_config.title_field_id ?? ''}
            onChange={(e) => update({ title_field_id: e.target.value || null })}
            className="form-input text-sm"
          >
            <option value="">—</option>
            {viewFields.map((ef) => (
              <option key={ef.id} value={ef.id}>
                {(isAr ? ef.field.label_ar : ef.field.label_en) +
                  (ef.kind === 'mirrored' ? (isAr ? ' — مرآة' : ' — mirrored') : '')}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-bold text-charcoal mb-1">{t('card.subtitle_field')}</label>
          <select
            value={card_config.subtitle_field_id ?? ''}
            onChange={(e) => update({ subtitle_field_id: e.target.value || null })}
            className="form-input text-sm"
          >
            <option value="">—</option>
            {viewFields.map((ef) => (
              <option key={ef.id} value={ef.id}>
                {(isAr ? ef.field.label_ar : ef.field.label_en) +
                  (ef.kind === 'mirrored' ? (isAr ? ' — مرآة' : ' — mirrored') : '')}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-bold text-charcoal mb-1">{t('card.badge_field')}</label>
          <select
            value={card_config.badge_field_id ?? ''}
            onChange={(e) => update({ badge_field_id: e.target.value || null })}
            className="form-input text-sm"
          >
            <option value="">—</option>
            {badgeFields.map((ef) => (
              <option key={ef.id} value={ef.id}>
                {(isAr ? ef.field.label_ar : ef.field.label_en) +
                  (ef.kind === 'mirrored' ? (isAr ? ' — مرآة' : ' — mirrored') : '')}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-bold text-charcoal mb-2">{t('card.additional_fields')}</label>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {viewFields
              .filter((ef) => ef.id !== card_config.title_field_id && ef.id !== card_config.subtitle_field_id && ef.id !== card_config.badge_field_id)
              .map((ef) => (
                <label key={ef.id} className="flex items-center gap-2 cursor-pointer py-0.5">
                  <input
                    type="checkbox"
                    checked={card_config.shown_field_ids.includes(ef.id)}
                    onChange={() => toggleShownField(ef.id)}
                    className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
                  />
                  <span className="text-sm text-charcoal">{isAr ? ef.field.label_ar : ef.field.label_en}</span>
                  {ef.kind === 'mirrored' && (
                    <span className="text-[9px] text-chocolate/60 bg-chocolate/8 px-1 py-0.5 rounded-full font-bold">
                      {isAr ? 'مرآة' : 'mirrored'}
                    </span>
                  )}
                </label>
              ))}
          </div>
        </div>
      </div>

      {/* Live Preview */}
      <div>
        <label className="block text-sm font-bold text-charcoal mb-2">{t('card.preview')}</label>
        <div className="record-card max-w-sm">
          {/* Color strip */}
          <div
            className="h-1"
            style={{
              backgroundColor: badgeField?.field.options?.[0]?.color ?? model.color,
            }}
          />
          <div className="p-4">
            {/* Badge */}
            {badgeField && badgeField.field.options?.[0] && (
              <div className="mb-2">
                <Badge
                  label={isAr ? badgeField.field.options[0].label_ar : badgeField.field.options[0].label_en}
                  color={badgeField.field.options[0].color}
                />
              </div>
            )}
            {/* Title */}
            <div className="text-base font-bold text-charcoal mb-0.5">
              {titleField
                ? (isAr ? titleField.field.label_ar : titleField.field.label_en)
                : (isAr ? 'العنوان' : 'Title')}
            </div>
            {/* Subtitle */}
            {subtitleField && (
              <div className="text-sm text-charcoal/50">
                {isAr ? subtitleField.field.label_ar : subtitleField.field.label_en}
              </div>
            )}
            {/* Divider + additional fields */}
            {shownFields.length > 0 && (
              <>
                <hr className="my-3 border-sand/40" />
                <div className="space-y-1.5">
                  {shownFields.map((ef) => (
                    <div key={ef.id} className="flex justify-between text-sm">
                      <span className="text-charcoal/50">{isAr ? ef.field.label_ar : ef.field.label_en}</span>
                      <span className="text-charcoal font-bold">—</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {/* Date */}
            <div className="mt-3 text-xs text-charcoal/30">
              {new Date().toLocaleDateString(isAr ? 'ar-SA' : 'en-US')}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
