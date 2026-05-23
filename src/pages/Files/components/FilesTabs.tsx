import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderHeart, Folders } from 'lucide-react';

/**
 * Two-tab switcher at the top of /files.
 *   - My Files  → /files
 *   - Shared    → /files/shared
 * Renders as a segmented pill control to match the Wassel design tokens.
 */
export default function FilesTabs() {
  const { t } = useTranslation();
  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-2xl bg-cream border border-sand/30">
      <NavLink
        to="/files"
        end
        className={({ isActive }) =>
          `inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all ${
            isActive
              ? 'bg-white text-copper shadow-sm shadow-copper/10'
              : 'text-charcoal/60 hover:text-charcoal'
          }`
        }
      >
        <Folders size={16} />
        <span>{t('files.tabs.my_files')}</span>
      </NavLink>
      <NavLink
        to="/files/shared"
        className={({ isActive }) =>
          `inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all ${
            isActive
              ? 'bg-white text-copper shadow-sm shadow-copper/10'
              : 'text-charcoal/60 hover:text-charcoal'
          }`
        }
      >
        <FolderHeart size={16} />
        <span>{t('files.tabs.shared_with_me')}</span>
      </NavLink>
    </div>
  );
}
