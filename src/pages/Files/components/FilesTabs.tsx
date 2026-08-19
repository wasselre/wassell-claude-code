import { NavLink, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FolderHeart, Folders, LibraryBig } from 'lucide-react';
import { filesLibraryEnabled } from '@/lib/files/libraryUrl';

/**
 * The tab switcher at the top of /files. Its shape depends on the B5 flag:
 *
 *   flag OFF  →  My Files · Shared with me          (exactly as before)
 *   flag ON   →  Library · Legacy folders · Shared with me
 *
 * "Legacy folders" is the word the spec uses and it is doing work: folders are
 * frozen, not deleted (B9 disables creation; nothing is ever removed), and
 * naming the tab honestly is how people learn that metadata is now the place
 * things live. The 468 files that ARE in a folder, and the three permission
 * grants that cascade through one, keep working untouched.
 */
export default function FilesTabs() {
  const { t } = useTranslation();
  const location = useLocation();
  const libraryOn = filesLibraryEnabled(location.search);

  const cls = ({ isActive }: { isActive: boolean }) =>
    `inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all ${
      isActive
        ? 'bg-white text-copper shadow-sm shadow-copper/10'
        : 'text-charcoal/60 hover:text-charcoal'
    }`;

  return (
    <div className="inline-flex items-center gap-1 p-1 rounded-2xl bg-cream border border-sand/30">
      <NavLink to="/files" end className={cls}>
        {libraryOn ? <LibraryBig size={16} aria-hidden /> : <Folders size={16} aria-hidden />}
        <span>{libraryOn ? t('files.tabs.library') : t('files.tabs.my_files')}</span>
      </NavLink>

      {libraryOn && (
        <NavLink to="/files/folders" className={cls}>
          <Folders size={16} aria-hidden />
          <span>{t('files.tabs.legacy_folders')}</span>
        </NavLink>
      )}

      <NavLink to="/files/shared" className={cls}>
        <FolderHeart size={16} aria-hidden />
        <span>{t('files.tabs.shared_with_me')}</span>
      </NavLink>
    </div>
  );
}
