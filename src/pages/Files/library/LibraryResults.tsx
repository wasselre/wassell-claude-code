/**
 * Phase 3 · B5 — grouped results, in either layout, with server-side paging.
 *
 * ── GROUPING IS PAGE-LOCAL, AND SAYS SO ───────────────────────────────────
 * Pagination happens in the DATABASE (60 rows per page, spec §6). Grouping
 * happens HERE, over those 60 rows. So a section header reads "Floor plan (12)"
 * meaning twelve ON THIS PAGE, not twelve in the result — the true total for
 * that bucket is in the facet, and clicking the header applies it as a filter,
 * which IS the full-result answer.
 *
 * The alternative — grouping server-side across the whole result — would mean
 * either fetching every row (the load-everything-and-filter-in-JS pattern the
 * spec explicitly says not to copy from Marketing) or a second aggregate query
 * per grouping. Neither is worth it when the facet already holds the number.
 * What is NOT acceptable is showing a page-local count as if it were the total,
 * so the header carries the facet total beside it whenever one exists.
 */
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type {
  BusinessFileFacets,
  BusinessFileRow,
  FileDocumentTypeRow,
  LibraryGrouping,
  LibraryLayout,
  PageLinkSummary,
} from '@/types';
import { documentTypeLabel, modelLabel, monthLabel, ownerLabel } from './labels';
import LibraryFileTile from './LibraryFileTile';
import LibraryFileRow from './LibraryFileRow';

interface Props {
  rows: BusinessFileRow[];
  types: FileDocumentTypeRow[];
  facets: BusinessFileFacets | null;
  links: Map<string, PageLinkSummary[]>;
  linksLoading: boolean;
  thumbs: Record<string, string>;
  grouping: LibraryGrouping;
  layout: LibraryLayout;
  /** The detail-panel subject. */
  selectedId: string | null;
  /** The multi-select set. */
  selectedIds: Set<string>;
  onOpen: (f: BusinessFileRow) => void;
  onToggle: (f: BusinessFileRow, additive: boolean) => void;
  /** The grid container the marquee measures against. */
  gridRef: React.MutableRefObject<HTMLDivElement | null>;
  onGridMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  marquee: { x: number; y: number; w: number; h: number } | null;
  /** Clicking a section header narrows to that bucket — the section's page-local
   *  count becomes the whole result. */
  onDrillDown: (grouping: LibraryGrouping, key: string) => void;
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}

interface Section { key: string; label: string; rows: BusinessFileRow[]; facetTotal: number | null }

function buildSections(
  rows: BusinessFileRow[],
  grouping: LibraryGrouping,
  facets: BusinessFileFacets | null,
  links: Map<string, PageLinkSummary[]>,
  resolve: { type: (v: string) => string; owner: (v: string) => string; model: (v: string) => string; month: (v: string) => string },
  ungrouped: string,
): Section[] {
  if (grouping === 'none') {
    return [{ key: '__all__', label: '', rows, facetTotal: null }];
  }

  const buckets = new Map<string, BusinessFileRow[]>();
  const push = (k: string, r: BusinessFileRow) => {
    const cur = buckets.get(k);
    if (cur) cur.push(r);
    else buckets.set(k, [r]);
  };

  for (const r of rows) {
    if (grouping === 'document_type') push(r.document_type, r);
    else if (grouping === 'owner') push(r.owner_user_id, r);
    else if (grouping === 'month') push(r.created_at.slice(0, 7), r);
    else if (grouping === 'linked_model') {
      const ls = links.get(r.id);
      // A file linked to three models appears under all three. That is the
      // whole point of the many-to-many graph — showing it once under an
      // arbitrary "primary" model would be the folder model again.
      if (!ls || ls.length === 0) push('__none__', r);
      else for (const l of ls) push(l.model_name, r);
    }
  }

  const facetBucket =
    grouping === 'document_type' ? facets?.document_type
    : grouping === 'owner' ? facets?.owner_user_id
    : grouping === 'linked_model' ? facets?.linked_model
    : undefined;

  const out: Section[] = [];
  for (const [key, list] of buckets) {
    const label =
      key === '__none__' ? ungrouped
      : grouping === 'document_type' ? resolve.type(key)
      : grouping === 'owner' ? resolve.owner(key)
      : grouping === 'linked_model' ? resolve.model(key)
      : resolve.month(key);
    out.push({ key, label, rows: list, facetTotal: facetBucket?.[key] ?? null });
  }
  // Biggest first, then alphabetically — a stable order that puts the section
  // a user is most likely looking for at the top.
  out.sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label));
  return out;
}

export default function LibraryResults({
  rows, types, facets, links, linksLoading, thumbs, grouping, layout,
  selectedId, selectedIds, onOpen, onToggle, gridRef, onGridMouseDown, marquee,
  onDrillDown, page, pageSize, total, onPage,
}: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const users = useAppStore((s) => s.users);
  const models = useAppStore((s) => s.models);

  const sections = buildSections(
    rows, grouping, facets, links,
    {
      type: (v) => documentTypeLabel(v, types, isAr),
      owner: (v) => ownerLabel(v, users, isAr),
      model: (v) => modelLabel(v, models, isAr),
      month: (v) => monthLabel(v, isAr),
    },
    t('files.library.group.unlinked_bucket'),
  );

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  // In RTL the "next page" arrow must point LEFT, because the reading direction
  // is reversed. Swapping the glyph — not mirroring the whole control — is what
  // keeps the button order (previous, then next) matching the language.
  const PrevIcon = isAr ? ChevronRight : ChevronLeft;
  const NextIcon = isAr ? ChevronLeft : ChevronRight;

  return (
    <div
      ref={gridRef}
      onMouseDown={onGridMouseDown}
      // `relative` so the rectangle can be positioned in GRID-relative space —
      // the same space the hit-test works in, which is what keeps the box
      // pinned to the tiles it covers while the page scrolls under it.
      // Extra bottom padding while selecting keeps the floating bar off the
      // last row; padding only grows the scroll area, it does not move tiles.
      className={`space-y-6 relative select-none ${selectedIds.size > 0 ? 'pb-24' : ''}`}
    >
      {/* The >2px guard stops a zero-size box flashing on the frame the drag
          crosses the threshold. */}
      {marquee && (marquee.w > 2 || marquee.h > 2) && (
        <div
          aria-hidden
          // !mt-0 is load-bearing. This container is `space-y-6`, which injects
          // margin-top onto every non-first child — and as a later child the
          // overlay would inherit 24px and render BELOW where `top: marquee.y`
          // puts it, so the visible box would disagree with the hit-test by a
          // row. Carried over from FilesPage, which learned it the hard way.
          className="absolute z-20 pointer-events-none rounded-sm border border-copper/60 bg-copper/10 !mt-0"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}
      {sections.map((s) => (
        <section key={s.key}>
          {grouping !== 'none' && (
            <div className="flex items-baseline gap-2 mb-2.5">
              <button
                type="button"
                onClick={() => s.key !== '__none__' && onDrillDown(grouping, s.key)}
                disabled={s.key === '__none__'}
                className="text-xs font-bold text-charcoal/50 uppercase tracking-widest hover:text-copper disabled:hover:text-charcoal/50 disabled:cursor-default"
                dir="auto"
              >
                {s.label}
              </button>
              <span className="text-[11px] text-charcoal/35 tabular-nums">
                {s.facetTotal !== null && s.facetTotal !== s.rows.length
                  ? t('files.library.group.count_of_total', { shown: s.rows.length, total: s.facetTotal })
                  : t('files.library.group.count', { count: s.rows.length })}
              </span>
            </div>
          )}

          {layout === 'grid' ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
              {s.rows.map((f) => (
                <LibraryFileTile
                  key={`${s.key}:${f.id}`}
                  file={f}
                  types={types}
                  thumbUrl={thumbs[f.id] ?? null}
                  active={selectedId === f.id}
                  selected={selectedIds.has(f.id)}
                  selectionActive={selectedIds.size > 0}
                  onOpen={onOpen}
                  onToggle={onToggle}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl bg-white border border-sand/30 p-1.5">
              <div className="grid grid-cols-[auto_minmax(0,3fr)_minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_auto] gap-3 px-3 pb-1.5 text-[10px] font-bold uppercase tracking-widest text-charcoal/35">
                <span aria-hidden />
                <span>{t('files.library.col.title')}</span>
                <span>{t('files.library.col.type')}</span>
                <span className="inline-flex items-center gap-1">
                  {t('files.library.col.linked')}
                  {linksLoading && <Loader2 size={10} className="animate-spin" aria-hidden />}
                </span>
                <span>{t('files.library.col.owner')}</span>
                <span className="text-end">{t('files.library.col.date_size')}</span>
              </div>
              {s.rows.map((f) => (
                <LibraryFileRow
                  key={`${s.key}:${f.id}`}
                  file={f}
                  types={types}
                  links={links.get(f.id)}
                  active={selectedId === f.id}
                  selected={selectedIds.has(f.id)}
                  selectionActive={selectedIds.size > 0}
                  onOpen={onOpen}
                  onToggle={onToggle}
                />
              ))}
            </div>
          )}
        </section>
      ))}

      {/* Pagination. Always rendered when there is more than one page, at the
          bottom, showing the absolute range — "61–120 of 6,092" is the only
          part of this screen that tells you how deep you are. */}
      {pageCount > 1 && (
        <div className="flex items-center justify-between gap-3 pt-2">
          <span className="text-xs text-charcoal/50 tabular-nums">
            {t('files.library.page_range', { first, last, total })}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onPage(page - 1)}
              disabled={page <= 1}
              aria-label={t('files.library.prev_page')}
              className="p-2 rounded-lg bg-white border border-sand/40 text-charcoal/70 hover:bg-cream disabled:opacity-35 disabled:cursor-not-allowed"
            >
              <PrevIcon size={15} aria-hidden />
            </button>
            <span className="px-2 text-xs font-bold text-charcoal/70 tabular-nums">
              {t('files.library.page_of', { page, pages: pageCount })}
            </span>
            <button
              type="button"
              onClick={() => onPage(page + 1)}
              disabled={page >= pageCount}
              aria-label={t('files.library.next_page')}
              className="p-2 rounded-lg bg-white border border-sand/40 text-charcoal/70 hover:bg-cream disabled:opacity-35 disabled:cursor-not-allowed"
            >
              <NextIcon size={15} aria-hidden />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
