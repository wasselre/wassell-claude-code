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
  /** True when this document is the project's brochure (`primary_category` =
   *  'brochure', or the name says so). Drives the bulk picker's default: only
   *  the brochure is pre-checked, not every document. */
  isBrochure: boolean;
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
 *  RecordFileEntry and the lean SendableFile path (listSendableProjectFiles).
 *  `primary_category` is included so the tile can tell a brochure apart. */
type PickerSource = { file: Pick<BusinessFileRow, 'id' | 'kind' | 'title' | 'original_name' | 'primary_category'> };

/** A document reads as a brochure when its name says so (AR «بروشور»/«كتيّب» or
 *  EN «brochure»). Name is the STRONGEST signal — it's what the rep titled it. */
const BROCHURE_NAME_RE = /بروشور|كتي(?:ّ)?ب|brochure/i;
export function isBrochureName(name: string): boolean {
  return BROCHURE_NAME_RE.test(name);
}
/** A document is a brochure when its primary Document Type is `brochure`, or its
 *  name says so. Note: in practice several of a project's marketing PDFs get
 *  typed `brochure` by the file-enrichment AI (marketing plan, spec sheet…), so
 *  this is a WIDE net — `defaultBulkSelection` narrows it to ONE. */
export function isBrochureFile(
  file: Pick<BusinessFileRow, 'primary_category'>,
  name: string,
): boolean {
  return file.primary_category === 'brochure' || isBrochureName(name);
}

export function buildPickerItems(entries: PickerSource[], externalVideoUrls: string[]): PickerItem[] {
  const seen = new Set<string>();
  const out: PickerItem[] = [];
  for (const e of entries) {
    if (seen.has(e.file.id)) continue;
    seen.add(e.file.id);
    const name = e.file.title || e.file.original_name || e.file.id;
    const group = groupOfKind(e.file.kind);
    out.push({
      ref: e.file.id,
      group,
      kind: e.file.kind,
      name,
      isUrl: false,
      isBrochure: group === 'document' && isBrochureFile(e.file, name),
    });
  }
  for (const url of externalVideoUrls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ref: url, group: 'video', kind: 'video', name: nameFromUrl(url), isUrl: true, isBrochure: false });
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

/**
 * Bulk-send order: documents (PDFs) FIRST, then photos, then videos. The bulk
 * project flow sends the text message on its own first, so this media list is
 * appended after it — giving the customer the intended
 * **text → PDF → pictures** sequence. Distinct from `orderSelectedRefs`
 * (photo-first) which the single-project ride-along keeps for back-compat.
 */
export function orderSelectedRefsBulk(items: PickerItem[], selected: ReadonlySet<string>): string[] {
  const order: PickerGroup[] = ['document', 'photo', 'video'];
  const out: string[] = [];
  for (const g of order) for (const it of items) if (it.group === g && selected.has(it.ref)) out.push(it.ref);
  return out;
}

/**
 * Default checkbox selection for the BULK picker: exactly ONE brochure document
 * + the FIRST THREE photos. A project can carry a marketing plan, spec sheet,
 * info sheet… (several of which the file-enrichment AI also tags `brochure`), so
 * pre-checking every brochure-typed document would still tick a pile of them —
 * we narrow to one: prefer the document whose NAME says «بروشور»/brochure (the
 * real project brochure), else the first document typed `primary_category`
 * ='brochure', else no document. Videos and every other document start
 * unchecked. Photos arrive hero-first because `resolveProjectFacts` prepends
 * `main_image`, so "first three" = hero + next two — the "top 3" pre-selection.
 * The rep can still tick/untick anything (including adding another document).
 */
export const BULK_DEFAULT_PHOTO_COUNT = 3;
export function defaultBulkSelection(items: PickerItem[]): Set<string> {
  const out = new Set<string>();
  let photos = 0;
  for (const it of items) {
    if (it.group === 'photo' && photos < BULK_DEFAULT_PHOTO_COUNT) {
      out.add(it.ref);
      photos++;
    }
  }
  // ONE brochure: a name-titled brochure wins over a merely type-classified one.
  const brochures = items.filter((it) => it.group === 'document' && it.isBrochure);
  const chosen = brochures.find((it) => isBrochureName(it.name)) ?? brochures[0];
  if (chosen) out.add(chosen.ref);
  return out;
}
