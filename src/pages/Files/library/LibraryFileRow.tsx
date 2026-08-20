/**
 * Phase 3 · B5 — one file, as a list row.
 *
 * Spec §6 names the columns: "title, type, linked records, owner, date, size."
 * "Linked records" is the interesting one — it is not on the search payload
 * (which carries a COUNT), so the page resolves it for the whole visible slice
 * in one query and passes the result down. A row that has not received its
 * links yet shows the count it does have rather than a spinner: the count is
 * already true, and a flicker between two true values is worse than one.
 */
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { formatBytes, kindAccent, kindIcon } from '@/lib/files/format';
import type { BusinessFileRow, FileDocumentTypeRow, PageLinkSummary } from '@/types';
import { documentTypeLabel, ownerLabel, shortDate } from './labels';
import LibraryBadges from './LibraryBadges';

interface Props {
  file: BusinessFileRow;
  types: FileDocumentTypeRow[];
  links: PageLinkSummary[] | undefined;
  active: boolean;
  selected: boolean;
  selectionActive: boolean;
  onOpen: (f: BusinessFileRow) => void;
  onToggle: (f: BusinessFileRow, additive: boolean) => void;
}

export default function LibraryFileRow({ file, types, links, active, selected, selectionActive, onOpen, onToggle }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const users = useAppStore((s) => s.users);
  const Icon = kindIcon[file.kind];
  const accent = kindAccent[file.kind];

  const linkText = links
    ? links.length === 0
      ? '—'
      : links
          .map((l) => `${(isAr ? l.model_label_ar : l.model_label_en) || l.model_name} (${l.count})`)
          .join('، ')
    : file.link_count === 0
      ? '—'
      : t('files.library.linked_count', { count: file.link_count });

  return (
    <button
      type="button"
      data-selectable-id={file.id}
      data-selectable-kind="file"
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) { onToggle(file, true); return; }
        if (selectionActive) { onToggle(file, false); return; }
        onOpen(file);
      }}
      className={`w-full text-start grid grid-cols-[auto_minmax(0,3fr)_minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_auto] items-center gap-3 px-3 py-2.5 rounded-xl border transition-colors hover:bg-cream focus:outline-none focus:ring-2 focus:ring-copper/30 ${
        selected ? 'border-copper bg-copper/10'
          : active ? 'border-copper/40 bg-copper/5'
          : 'border-transparent'
      }`}
      aria-pressed={selected || active}
    >
      <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${accent.bg}`}>
        <Icon size={15} className={accent.fg} aria-hidden />
      </span>

      <span className="min-w-0">
        <span className="block text-sm font-bold text-charcoal truncate" dir="auto" title={file.title}>
          {file.title}
        </span>
        <span className="block mt-0.5">
          <LibraryBadges file={file} types={types} max={2} hideType />
        </span>
      </span>

      <span className="text-xs text-charcoal/70 truncate" dir="auto">
        {documentTypeLabel(file.document_type, types, isAr)}
      </span>

      <span className="text-xs text-charcoal/60 truncate" dir="auto" title={linkText}>
        {linkText}
      </span>

      <span className="text-xs text-charcoal/60 truncate" dir="auto">
        {ownerLabel(file.owner_user_id, users, isAr)}
      </span>

      <span className="text-xs text-charcoal/45 whitespace-nowrap text-end">
        {shortDate(file.created_at, isAr)}
        <span className="block text-[11px]">{formatBytes(file.size_bytes, isAr)}</span>
      </span>
    </button>
  );
}
