/**
 * Phase 3 · B5 — one file, as a card.
 *
 * The grid is for visual types; the list (LibraryFileRow) is for documents.
 * Both are driven by the SAME row payload from `business_files_search`, so
 * switching layout never refetches.
 *
 * Thumbnails are batch-signed by the page for the whole visible slice (one
 * request, not sixty). A tile never signs its own URL — that was the pattern
 * the folder-first grid moved away from and it is not worth reintroducing for
 * a page that can show 60 images at once.
 */
import { useTranslation } from 'react-i18next';
import { Check, Link2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { formatBytes, kindAccent, kindIcon } from '@/lib/files/format';
import type { BusinessFileRow, FileDocumentTypeRow } from '@/types';
import LibraryBadges from './LibraryBadges';

interface Props {
  file: BusinessFileRow;
  types: FileDocumentTypeRow[];
  thumbUrl?: string | null;
  /** Highlighted as the detail-panel subject. */
  active: boolean;
  /** In the multi-select set. */
  selected: boolean;
  /** True when anything is selected — flips a plain click from "open" to
   *  "replace the selection with this one", exactly as Drive does. */
  selectionActive: boolean;
  onOpen: (f: BusinessFileRow) => void;
  onToggle: (f: BusinessFileRow, additive: boolean) => void;
}

export default function LibraryFileTile({ file, types, thumbUrl, active, selected, selectionActive, onOpen, onToggle }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const Icon = kindIcon[file.kind];
  const accent = kindAccent[file.kind];

  return (
    <button
      type="button"
      // The marquee hit-tests these two attributes.
      data-selectable-id={file.id}
      data-selectable-kind="file"
      onClick={(e) => {
        // Ctrl/Cmd or Shift always means "adjust the selection". A plain click
        // opens the file UNLESS a selection is already active, in which case it
        // replaces the selection — the Drive behaviour, and the one that makes
        // a mis-drag recoverable without reaching for the toolbar.
        if (e.ctrlKey || e.metaKey || e.shiftKey) { onToggle(file, true); return; }
        if (selectionActive) { onToggle(file, false); return; }
        onOpen(file);
      }}
      // `text-start` rather than text-left: the tile must read from the right
      // in Arabic, and a hard-coded side is the single most common way an RTL
      // layout breaks.
      className={`group relative text-start w-full rounded-2xl border bg-white overflow-hidden transition-all hover:shadow-md focus:outline-none focus:ring-2 focus:ring-copper/30 ${
        selected ? 'border-copper ring-2 ring-copper/30'
          : active ? 'border-copper ring-2 ring-copper/15'
          : 'border-sand/30'
      }`}
      aria-pressed={selected || active}
    >
      {/* Hover-revealed until something is selected, then always visible —
          otherwise there is no way to START a selection with the keyboard-free
          hand, and no way to see what is already in it while scrolling. */}
      <span
        role="checkbox"
        aria-checked={selected}
        aria-label={file.title}
        tabIndex={-1}
        onClick={(e) => { e.stopPropagation(); onToggle(file, true); }}
        className={`absolute top-2 start-2 z-10 w-5 h-5 rounded-md border flex items-center justify-center transition-opacity cursor-pointer ${
          selected ? 'bg-copper border-copper opacity-100'
                   : `bg-white/90 border-sand/60 ${selectionActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`
        }`}
      >
        {selected && <Check size={12} className="text-white" aria-hidden />}
      </span>
      <div className={`relative h-32 flex items-center justify-center ${accent.bg}`}>
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt=""
            loading="lazy"
            className="w-full h-full object-cover"
          />
        ) : (
          <Icon size={30} className={accent.fg} aria-hidden />
        )}
        {file.link_count > 0 && (
          <span
            className="absolute top-2 end-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-white/90 border border-sand/40 text-[10px] font-bold text-charcoal/70"
            title={t('files.library.linked_count', { count: file.link_count })}
          >
            <Link2 size={10} aria-hidden />
            {file.link_count}
          </span>
        )}
      </div>

      <div className="p-3 space-y-2">
        <div
          className="text-sm font-bold text-charcoal line-clamp-2 leading-snug"
          // Titles mix Arabic and Latin freely (a project name beside a unit
          // code). `dir="auto"` lets each title pick its own direction instead
          // of inheriting the page's and rendering the punctuation on the
          // wrong end.
          dir="auto"
          title={file.title}
        >
          {file.title}
        </div>
        <LibraryBadges file={file} types={types} max={2} />
        <div className="text-[11px] text-charcoal/45">{formatBytes(file.size_bytes, isAr)}</div>
      </div>
    </button>
  );
}
