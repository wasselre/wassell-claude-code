import { useAppStore } from '@/stores/appStore';

export interface RecordTab {
  id: string;
  label_ar: string;
  label_en: string;
  icon?: React.ReactNode;
}

interface RecordTabBarProps {
  tabs: RecordTab[];
  active: string;
  onChange: (id: string) => void;
}

/**
 * Tab strip rendered above record-form sections. Used to switch between the
 * record's own form and the embedded "Client Details" 360° view. Pure UI:
 * controlled, no internal state, no URL handling — the parent owns the active
 * tab state and is responsible for syncing it to `useSearchParams`.
 */
export default function RecordTabBar({ tabs, active, onChange }: RecordTabBarProps) {
  const isAr = useAppStore((s) => s.language === 'ar');

  if (tabs.length <= 1) return null;

  return (
    <div className="flex items-center gap-1 mb-6 border-b border-sand/40">
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`relative px-4 py-2.5 text-sm font-bold transition-colors ${
              isActive
                ? 'text-copper'
                : 'text-charcoal/50 hover:text-charcoal'
            }`}
          >
            <span className="inline-flex items-center gap-1.5">
              {tab.icon}
              {isAr ? tab.label_ar : tab.label_en}
            </span>
            {isActive && (
              <span className="absolute bottom-[-1px] start-0 end-0 h-[2px] bg-copper" />
            )}
          </button>
        );
      })}
    </div>
  );
}
