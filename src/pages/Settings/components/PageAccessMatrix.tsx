/**
 * PageAccessMatrix — per-profile toggles for the custom (non-model) Sales
 * Operations pages registered in `src/lib/customPages.ts`.
 *
 * These surfaces aren't models, so they live outside the PermissionMatrix.
 * Each page has a `default_access` ('all' or 'admin'); the toggle here stores
 * an explicit override on the profile's `page_access` map only when it
 * DIVERGES from that default — so the stored shape stays minimal and a
 * profile that's never been touched keeps the default behavior.
 *
 * Admin profiles see every page regardless, so for an admin profile the
 * toggles render checked + disabled with an explanatory note.
 *
 * Purely controlled: receives the current map + emits the next one.
 */

import { useAppStore } from '@/stores/appStore';
import { CUSTOM_PAGES } from '@/lib/customPages';
import { EyeOff } from 'lucide-react';

interface Props {
  /** Current `profile.page_access` map (undefined → no overrides yet). */
  value?: Record<string, boolean>;
  onChange: (next: Record<string, boolean>) => void;
  /** When the edited profile is an admin, every page is forced on. */
  profileIsAdmin: boolean;
}

export default function PageAccessMatrix({ value, onChange, profileIsAdmin }: Props) {
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const access = value ?? {};

  const effective = (pageId: string, defaultAll: boolean): boolean => {
    if (profileIsAdmin) return true;
    const explicit = access[pageId];
    return typeof explicit === 'boolean' ? explicit : defaultAll;
  };

  const toggle = (pageId: string, defaultAll: boolean) => {
    const nextVal = !effective(pageId, defaultAll);
    const next = { ...access };
    // Keep the stored shape minimal: drop the key when it lands back on the
    // page's default, store an explicit boolean only when it diverges.
    if (nextVal === defaultAll) delete next[pageId];
    else next[pageId] = nextVal;
    onChange(next);
  };

  return (
    <div className="grid gap-1.5 grid-cols-1 sm:grid-cols-2">
      {CUSTOM_PAGES.map((pg) => {
        const Icon = pg.icon;
        const defaultAll = pg.default_access === 'all';
        const checked = effective(pg.id, defaultAll);
        return (
          <label
            key={pg.id}
            className={`flex items-center gap-2 px-2 py-1.5 rounded bg-white/60 border border-sand/20 ${
              profileIsAdmin ? 'cursor-default opacity-80' : 'cursor-pointer'
            }`}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={profileIsAdmin}
              onChange={() => toggle(pg.id, defaultAll)}
              className="w-4 h-4 rounded border-sand text-copper focus:ring-copper/30"
            />
            <Icon size={14} className="text-charcoal/50 shrink-0" />
            <span className="text-xs text-charcoal flex-1 truncate">
              {isAr ? pg.label_ar : pg.label_en}
            </span>
            {pg.default_access === 'admin' && (
              <span className="text-[9px] text-charcoal/40 italic shrink-0">
                {isAr ? 'للمدير افتراضياً' : 'admin by default'}
              </span>
            )}
            {!checked && !profileIsAdmin && (
              <span className="text-[10px] text-charcoal/50 inline-flex items-center gap-1 shrink-0">
                <EyeOff size={10} />
                {isAr ? 'مخفي' : 'hidden'}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}
