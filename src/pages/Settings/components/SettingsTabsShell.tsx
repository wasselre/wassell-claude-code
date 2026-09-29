import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import BackToSettings from './BackToSettings';
import { SettingsEmbedded } from './settingsEmbed';

export interface SettingsTab {
  id: string;
  ar: string;
  en: string;
  icon: LucideIcon;
  render: () => ReactNode;
}

/**
 * A settings page made of tabs. The active tab lives in `?tab=` so a tab can be
 * linked to, bookmarked, and returned to from a sub-page (a profile / role
 * editor sends the admin back to `?tab=access` / `?tab=jobs`).
 */
export default function SettingsTabsShell({
  titleAr, titleEn, descAr, descEn, icon: Icon, color, tabs,
}: {
  titleAr: string;
  titleEn: string;
  descAr: string;
  descEn: string;
  icon: LucideIcon;
  color: string;
  tabs: SettingsTab[];
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const [params, setParams] = useSearchParams();
  const active = tabs.find((t) => t.id === params.get('tab')) ?? tabs[0]!;

  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('tab', id);
    setParams(next, { replace: true });
  };

  return (
    <div className="max-w-6xl">
      <BackToSettings />
      <div className="flex items-center gap-3 mb-5">
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${color}14` }}>
          <Icon size={24} style={{ color }} />
        </div>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-chocolate">{isAr ? titleAr : titleEn}</h1>
          <p className="text-sm text-charcoal/45">{isAr ? descAr : descEn}</p>
        </div>
      </div>

      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-sand/50 mb-6">
        {tabs.map((t) => {
          const TabIcon = t.icon;
          const on = t.id === active.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => select(t.id)}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap px-3.5 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
                on ? 'border-copper text-copper' : 'border-transparent text-charcoal/55 hover:text-charcoal'
              }`}
            >
              <TabIcon size={15} />
              {isAr ? t.ar : t.en}
            </button>
          );
        })}
      </div>

      <SettingsEmbedded>
        <div key={active.id}>{active.render()}</div>
      </SettingsEmbedded>
    </div>
  );
}
