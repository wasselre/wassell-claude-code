import { useTranslation } from 'react-i18next';
import Modal from '@/components/ui/Modal';
import { getIconComponent } from '@/components/layout/Sidebar';

const ICON_NAMES = [
  'users', 'contact', 'phone-call', 'building-2', 'target', 'star', 'file-search',
  'database', 'globe', 'folder', 'briefcase', 'calendar', 'mail',
  'truck', 'home', 'map-pin', 'clipboard', 'tag', 'layers',
  'grid', 'box', 'package', 'activity', 'zap', 'bell',
  'flag', 'heart', 'award', 'shield',
];

interface IconPickerModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (icon: string) => void;
  selected?: string;
}

export default function IconPickerModal({ open, onClose, onSelect, selected }: IconPickerModalProps) {
  const { t } = useTranslation();

  return (
    <Modal open={open} onClose={onClose} title={t('builder.select_icon')}>
      <div className="grid grid-cols-7 gap-2">
        {ICON_NAMES.map((name) => {
          const Icon = getIconComponent(name);
          const isSelected = name === selected;
          return (
            <button
              key={name}
              onClick={() => {
                onSelect(name);
                onClose();
              }}
              className={`p-3 rounded-lg transition-colors flex items-center justify-center ${
                isSelected
                  ? 'bg-copper text-white'
                  : 'hover:bg-cream text-charcoal'
              }`}
            >
              <Icon size={22} />
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
