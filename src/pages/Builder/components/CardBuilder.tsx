import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import Badge from '@/components/ui/Badge';
import type { AppModel, ModelField } from '@/types';

interface CardBuilderProps {
  model: AppModel;
  onChange: (model: AppModel) => void;
}

export default function CardBuilder({ model, onChange }: CardBuilderProps) {
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';

  // Filter out section_mirror containers — they have no displayable single value
  // (their value is an object of child overrides). Mirrored children aren't
  // surfaced in the card builder yet.
  const allFields = model.schema.sections
    .flatMap((s) => s.fields)
    .filter((f) => f.type !== 'section_mirror');
  const dropdownFields = allFields.filter((f) => f.type === 'dropdown' || f.type === 'multiselect');

  const { card_config } = model;

  const update = (updates: Partial<typeof card_config>) => {
    onChange({ ...model, card_config: { ...card_config, ...updates } });
  };

  const titleField = allFields.find((f) => f.id === card_config.title_field_id);
  const subtitleField = allFields.find((f) => f.id === card_config.subtitle_field_id);
  const badgeField = allFields.find((f) => f.id === card_config.badge_field_id);
  const shownFields = card_config.shown_field_ids
    .map((id) => allFields.find((f) => f.id === id))
    .filter(Boolean) as ModelField[];

  const toggleShownField = (fieldId: string) => {
    const ids = card_config.shown_field_ids.includes(fieldId)
      ? card_config.shown_field_ids.filter((id) => id !== fieldId)
      : [...card_config.shown_field_ids, fieldId];
    update({ shown_field_ids: ids });
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
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
            {allFields.map((f) => (
              <option key={f.id} value={f.id}>{isAr ? f.label_ar : f.label_en}</option>
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
            {allFields.map((f) => (
              <option key={f.id} value={f.id}>{isAr ? f.label_ar : f.label_en}</option>
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
            {dropdownFields.map((f) => (
              <option key={f.id} value={f.id}>{isAr ? f.label_ar : f.label_en}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-bold text-charcoal mb-2">{t('card.additional_fields')}</label>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {allFields
              .filter((f) => f.id !== card_config.title_field_id && f.id !== card_config.subtitle_field_id && f.id !== card_config.badge_field_id)
              .map((f) => (
                <label key={f.id} className="flex items-center gap-2 cursor-pointer py-0.5">
                  <input
                    type="checkbox"
                    checked={card_config.shown_field_ids.includes(f.id)}
                    onChange={() => toggleShownField(f.id)}
                    className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
                  />
                  <span className="text-sm text-charcoal">{isAr ? f.label_ar : f.label_en}</span>
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
              backgroundColor: badgeField?.options?.[0]?.color ?? model.color,
            }}
          />
          <div className="p-4">
            {/* Badge */}
            {badgeField && badgeField.options?.[0] && (
              <div className="mb-2">
                <Badge
                  label={isAr ? badgeField.options[0].label_ar : badgeField.options[0].label_en}
                  color={badgeField.options[0].color}
                />
              </div>
            )}
            {/* Title */}
            <div className="text-base font-bold text-charcoal mb-0.5">
              {titleField
                ? (isAr ? titleField.label_ar : titleField.label_en)
                : (isAr ? 'العنوان' : 'Title')}
            </div>
            {/* Subtitle */}
            {subtitleField && (
              <div className="text-sm text-charcoal/50">
                {isAr ? subtitleField.label_ar : subtitleField.label_en}
              </div>
            )}
            {/* Divider + additional fields */}
            {shownFields.length > 0 && (
              <>
                <hr className="my-3 border-sand/40" />
                <div className="space-y-1.5">
                  {shownFields.map((f) => (
                    <div key={f.id} className="flex justify-between text-sm">
                      <span className="text-charcoal/50">{isAr ? f.label_ar : f.label_en}</span>
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
