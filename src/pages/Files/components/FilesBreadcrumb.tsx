import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ChevronLeft, Home } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { filesLibraryEnabled } from '@/lib/files/libraryUrl';
import type { FolderRow } from '@/types';

interface Props {
  /** All folders the caller can see — used to walk the parent chain. */
  folders: FolderRow[];
  /** Currently-open folder id, or null when at root. */
  currentFolderId: string | null;
  /** When true, the root crumb says "Shared with me" instead of "My Files". */
  sharedRoot?: boolean;
}

export default function FilesBreadcrumb({ folders, currentFolderId, sharedRoot = false }: Props) {
  const { t } = useTranslation();
  const location = useLocation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const Chevron = isAr ? ChevronLeft : ChevronRight;
  // With the B5 Library on, `/files` is the Library — so the folder root crumb
  // has to point at the Legacy folders tab instead, or climbing out of a
  // folder silently leaves the folder browser altogether.
  const foldersRoot = filesLibraryEnabled(location.search) ? '/files/folders' : '/files';

  // Walk the chain root → leaf. Cap at 10 to avoid pathological loops.
  const chain: FolderRow[] = [];
  let cursor = folders.find((f) => f.id === currentFolderId) ?? null;
  let safety = 10;
  while (cursor && safety-- > 0) {
    chain.unshift(cursor);
    cursor = cursor.parent_folder_id ? folders.find((f) => f.id === cursor!.parent_folder_id) ?? null : null;
  }

  const rootLabel = sharedRoot
    ? t('files.breadcrumb.shared_root')
    : foldersRoot === '/files/folders'
      ? t('files.tabs.legacy_folders')
      : t('files.breadcrumb.root');
  const rootHref = sharedRoot ? '/files/shared' : foldersRoot;

  return (
    <nav className="flex items-center gap-1 text-sm flex-wrap" aria-label="breadcrumb">
      <Link
        to={rootHref}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-charcoal/60 hover:text-charcoal hover:bg-cream transition-colors"
      >
        <Home size={14} />
        <span className="font-bold">{rootLabel}</span>
      </Link>
      {chain.map((folder, ix) => {
        const isLast = ix === chain.length - 1;
        return (
          <div key={folder.id} className="flex items-center gap-1">
            <Chevron size={14} className="text-charcoal/30" />
            {isLast ? (
              <span className="px-2 py-1 text-charcoal font-bold truncate max-w-[14rem]">
                {folder.name}
              </span>
            ) : (
              <Link
                to={`/files/${folder.id}`}
                className="px-2 py-1 rounded-lg text-charcoal/60 hover:text-charcoal hover:bg-cream transition-colors font-bold truncate max-w-[12rem]"
              >
                {folder.name}
              </Link>
            )}
          </div>
        );
      })}
    </nav>
  );
}
