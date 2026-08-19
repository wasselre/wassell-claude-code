/**
 * Phase 3 · B5 — the `/files` switch.
 *
 * The batch's rollback boundary, verbatim from the spec: "Feature flag returns
 * the folder-first page." This component IS that boundary, and it is one line
 * of logic on purpose — everything that could make the rollback partial (a
 * shared layout, a shared data fetch, a shared piece of state) is deliberately
 * absent. Flag off, and `/files` is byte-for-byte the page it was yesterday.
 *
 * The flag is re-read on every location change rather than once at mount, so
 * `?library=1` takes effect on navigation instead of needing a reload.
 */
import { useLocation } from 'react-router-dom';
import { filesLibraryEnabled } from '@/lib/files/libraryUrl';
import FilesPage from './FilesPage';
import FilesLibraryPage from './FilesLibraryPage';

export default function FilesRoot() {
  const location = useLocation();
  return filesLibraryEnabled(location.search) ? <FilesLibraryPage /> : <FilesPage />;
}
