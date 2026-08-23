/**
 * Pure helpers for ProjectFilePickerModal — kept free of React / store / I/O so
 * the grouping + merge + ordering logic is unit-testable in isolation.
 */
import type { FilePreviewKind } from '@/types';
import type { RecordFileEntry } from '@/lib/files/recordFiles';

export type PickerGroup = 'photo' | 'video' | 'document';

export interface PickerItem {
  /** files.id for CRM files, or the raw http URL for an external video. */
  ref: string;
  group: PickerGroup;
  name: string;
  isUrl: boolean;
  /** Signed thumbnail URL for image items (filled in later, best-effort). */
  thumb?: string;
}

export function groupOfKind(kind: FilePreviewKind): PickerGroup {
  if (kind === 'image') return 'photo';
  if (kind === 'video') return 'video';
  return 'document'; // pdf | audio | document | wassel_doc | archive | other
}

/** Best-effort display name for an external video URL. */
export function nameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const base = path.split('/').filter(Boolean).pop();
    return base ? decodeURIComponent(base) : url;
  } catch {
    return url;
  }
}

/**
 * Merge the record's linked files with external direct-video URLs into one
 * de-duplicated tile list.
 *   - one tile per FILE (a file linked via several mechanisms — e.g. main image
 *     + gallery — returns several edges; the first wins).
 *   - external video URLs (project_videos hosted links) have no files row, so
 *     they never appear in file_links and are appended as their own tiles.
 */
export function buildPickerItems(entries: RecordFileEntry[], externalVideoUrls: string[]): PickerItem[] {
  const seen = new Set<string>();
  const out: PickerItem[] = [];
  for (const e of entries) {
    if (seen.has(e.file.id)) continue;
    seen.add(e.file.id);
    out.push({
      ref: e.file.id,
      group: groupOfKind(e.file.kind),
      name: e.file.title || e.file.original_name || e.file.id,
      isUrl: false,
    });
  }
  for (const url of externalVideoUrls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ref: url, group: 'video', name: nameFromUrl(url), isUrl: true });
  }
  return out;
}

/** Selected refs in send order: photos, then videos, then documents (matches
 *  the historical gallery-then-video ride-along order). */
export function orderSelectedRefs(items: PickerItem[], selected: ReadonlySet<string>): string[] {
  const order: PickerGroup[] = ['photo', 'video', 'document'];
  const out: string[] = [];
  for (const g of order) for (const it of items) if (it.group === g && selected.has(it.ref)) out.push(it.ref);
  return out;
}
