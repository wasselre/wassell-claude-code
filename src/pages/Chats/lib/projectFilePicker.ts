/**
 * Pure helpers for ProjectFilePickerModal — kept free of React / store / I/O so
 * the grouping + merge + ordering logic is unit-testable in isolation.
 */
import type { BusinessFileRow, FilePreviewKind } from '@/types';

export type PickerGroup = 'photo' | 'video' | 'document';

/**
 * Unit-plan / floor-plan files are excluded from the send-to-customer picker:
 * they are the bulk of a project's linked images (4,002 floor_plan vs 2,735
 * gallery corpus-wide) and are internal drawings a rep does not send in a
 * project intro — signing a thumbnail for each one is what made this step slow.
 *
 * Keyed off what the file IS (`document_type` — authoritative, and it can differ
 * from the link role: a floor plan linked as a marketing asset is still a floor
 * plan) plus the new required primary type (`unit_plan`). Kept here, pure and
 * tested, so the rule has one home.
 */
const UNIT_PLAN_DOC_TYPES = new Set(['floor_plan']);
export function isUnitPlanFile(
  file: Pick<BusinessFileRow, 'document_type' | 'primary_category'>,
): boolean {
  return UNIT_PLAN_DOC_TYPES.has(file.document_type) || file.primary_category === 'unit_plan';
}

export interface PickerItem {
  /** files.id for CRM files, or the raw http URL for an external video. */
  ref: string;
  group: PickerGroup;
  /** The file's true kind — so the preview can route a PDF to the in-app viewer
   *  reliably, even when its name is a title (no `.pdf`) and its mime is blank. */
  kind: FilePreviewKind;
  name: string;
  isUrl: boolean;
  /** Signed thumbnail URL for image items (filled in later, best-effort). Small
   *  transformed image when Storage transforms are on, else the full URL. */
  thumb?: string;
  /** Full-size signed URL — the onError fallback if the transformed thumb fails
   *  (e.g. image transformation not enabled on the project). */
  thumbFull?: string;
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
/** The minimal file shape the picker tiles need — satisfied by both the full
 *  RecordFileEntry and the lean SendableFile path (listSendableProjectFiles). */
type PickerSource = { file: Pick<BusinessFileRow, 'id' | 'kind' | 'title' | 'original_name'> };

export function buildPickerItems(entries: PickerSource[], externalVideoUrls: string[]): PickerItem[] {
  const seen = new Set<string>();
  const out: PickerItem[] = [];
  for (const e of entries) {
    if (seen.has(e.file.id)) continue;
    seen.add(e.file.id);
    out.push({
      ref: e.file.id,
      group: groupOfKind(e.file.kind),
      kind: e.file.kind,
      name: e.file.title || e.file.original_name || e.file.id,
      isUrl: false,
    });
  }
  for (const url of externalVideoUrls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ref: url, group: 'video', kind: 'video', name: nameFromUrl(url), isUrl: true });
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
