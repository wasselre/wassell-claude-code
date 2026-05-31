import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileRow, FolderRow } from '@/types';

export type SelectableKind = 'folder' | 'file';

export interface SelectableItem {
  kind: SelectableKind;
  id: string;
}

export type SelectMode = 'replace' | 'toggle' | 'range' | 'add';

interface UseFilesSelectionParams {
  folders: FolderRow[];
  files: FileRow[];
}

/**
 * Google-Drive-style multi-select state for the Files page.
 *
 * Folders + files share a single visual selection but live in separate sets so
 * downstream bulk actions can address them independently. The "visual order"
 * for shift+range selection is folders first (in the order they're rendered)
 * then files — matches how the page lays them out top-to-bottom.
 */
export function useFilesSelection({ folders, files }: UseFilesSelectionParams) {
  const [selectedFolderIds, setSelectedFolderIds] = useState<Set<string>>(() => new Set());
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(() => new Set());
  /** Last item interacted with — anchor for shift+click range select. */
  const anchorRef = useRef<SelectableItem | null>(null);

  // Linear sequence used by range selection. Recomputed on every render so it
  // tracks reorder/load. Cheap — these arrays are tiny in practice.
  const ordered: SelectableItem[] = [
    ...folders.map((f): SelectableItem => ({ kind: 'folder', id: f.id })),
    ...files.map((f): SelectableItem => ({ kind: 'file', id: f.id })),
  ];

  const isSelected = useCallback(
    (kind: SelectableKind, id: string): boolean =>
      kind === 'folder' ? selectedFolderIds.has(id) : selectedFileIds.has(id),
    [selectedFolderIds, selectedFileIds],
  );

  const totalSelected = selectedFolderIds.size + selectedFileIds.size;

  const clear = useCallback(() => {
    setSelectedFolderIds(new Set());
    setSelectedFileIds(new Set());
    anchorRef.current = null;
  }, []);

  /** Replace selection with exactly this set of items. */
  const replace = useCallback((items: SelectableItem[]) => {
    const fo = new Set<string>();
    const fi = new Set<string>();
    items.forEach((it) => (it.kind === 'folder' ? fo : fi).add(it.id));
    setSelectedFolderIds(fo);
    setSelectedFileIds(fi);
    anchorRef.current = items[items.length - 1] ?? null;
  }, []);

  /** Add items (never removes). Used by shift-marquee. */
  const add = useCallback((items: SelectableItem[]) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      items.forEach((it) => {
        if (it.kind === 'folder') next.add(it.id);
      });
      return next;
    });
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      items.forEach((it) => {
        if (it.kind === 'file') next.add(it.id);
      });
      return next;
    });
    if (items.length > 0) anchorRef.current = items[items.length - 1] ?? null;
  }, []);

  /** Toggle items in/out (used by ctrl/cmd-click and ctrl-marquee). */
  const toggleMany = useCallback((items: SelectableItem[]) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev);
      items.forEach((it) => {
        if (it.kind !== 'folder') return;
        if (next.has(it.id)) next.delete(it.id);
        else next.add(it.id);
      });
      return next;
    });
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      items.forEach((it) => {
        if (it.kind !== 'file') return;
        if (next.has(it.id)) next.delete(it.id);
        else next.add(it.id);
      });
      return next;
    });
    if (items.length > 0) anchorRef.current = items[items.length - 1] ?? null;
  }, []);

  /**
   * Pointer / keyboard click on a single item. The caller passes mode based on
   * modifier keys — see `clickMode` helper below.
   *
   * Returns true if the click was "consumed" by selection logic (so the caller
   * should suppress the underlying preview / navigate). False means "let your
   * default click action run."
   */
  const onItemClick = useCallback(
    (item: SelectableItem, mode: SelectMode): boolean => {
      if (mode === 'toggle') {
        toggleMany([item]);
        return true;
      }
      if (mode === 'range') {
        const anchor = anchorRef.current;
        if (!anchor) {
          // No anchor yet — treat as a plain select.
          replace([item]);
          return true;
        }
        const aIdx = ordered.findIndex((x) => x.kind === anchor.kind && x.id === anchor.id);
        const bIdx = ordered.findIndex((x) => x.kind === item.kind && x.id === item.id);
        if (aIdx < 0 || bIdx < 0) {
          replace([item]);
          return true;
        }
        const [lo, hi] = aIdx < bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
        const range = ordered.slice(lo, hi + 1);
        // Range select replaces; keeping the original anchor.
        const fo = new Set<string>();
        const fi = new Set<string>();
        range.forEach((it) => (it.kind === 'folder' ? fo : fi).add(it.id));
        setSelectedFolderIds(fo);
        setSelectedFileIds(fi);
        // Do NOT reset anchor here — Google Drive keeps the anchor across
        // successive shift-clicks.
        return true;
      }
      if (mode === 'add') {
        add([item]);
        return true;
      }
      // mode === 'replace'
      // If clicking the *only* selected item with no modifiers, treat as a
      // "deselect" so a plain click on already-selected feels right. But if
      // selection is empty, we return false so the card's default click
      // (preview / navigate) runs.
      const onlyMe =
        totalSelected === 1 &&
        ((item.kind === 'folder' && selectedFolderIds.has(item.id)) ||
          (item.kind === 'file' && selectedFileIds.has(item.id)));
      if (onlyMe) {
        // Plain click on the lone selected item → keep default behavior.
        return false;
      }
      if (totalSelected === 0) {
        // Nothing selected & no modifier — caller runs default behavior.
        // (We do NOT auto-select here; that would prevent ever opening a file
        // with a plain click, which would surprise existing users.)
        anchorRef.current = item;
        return false;
      }
      // Something else is selected; replace with just this one.
      replace([item]);
      return true;
    },
    [add, ordered, replace, selectedFileIds, selectedFolderIds, toggleMany, totalSelected],
  );

  const selectAll = useCallback(() => {
    setSelectedFolderIds(new Set(folders.map((f) => f.id)));
    setSelectedFileIds(new Set(files.map((f) => f.id)));
    const last = ordered[ordered.length - 1] ?? null;
    anchorRef.current = last;
  }, [folders, files, ordered]);

  // Global keyboard shortcuts: Escape clears, Ctrl/Cmd+A selects all.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack typing in inputs.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      if (e.key === 'Escape' && totalSelected > 0) {
        clear();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        selectAll();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [clear, selectAll, totalSelected]);

  return {
    selectedFolderIds,
    selectedFileIds,
    totalSelected,
    isSelected,
    onItemClick,
    clear,
    replace,
    add,
    toggleMany,
    selectAll,
  };
}

/** Convert a MouseEvent's modifier state into the selection mode. */
export function clickMode(e: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }): SelectMode {
  if (e.shiftKey) return 'range';
  if (e.ctrlKey || e.metaKey) return 'toggle';
  return 'replace';
}
