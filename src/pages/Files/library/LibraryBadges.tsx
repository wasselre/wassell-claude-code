/**
 * Phase 3 · B5 — the badge ladder.
 *
 * Spec §6, verbatim: "Badges in priority order — unlinked → expired →
 * duplicate → status → type." Marketing's badge ladder, retargeted at file
 * health, and the ORDER is the point: a tile has room for two badges, so the
 * first thing you see about a file should be the thing most likely to need
 * doing something about.
 *
 * `duplicate` is deliberately NOT rendered per row. `checksum_sha256` is NULL
 * for every file uploaded before B7 (back-computing it would mean downloading
 * 6.3 GB), so a "duplicate" badge today would mark the handful of files that
 * happen to have a checksum and silently miss every real duplicate — worse
 * than no badge. The facet counter still exposes it as a filter, where the
 * partial coverage is visible rather than implied.
 */
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import type { BusinessFileRow, FileDocumentTypeRow } from '@/types';
import { documentTypeLabel, statusLabel } from './labels';

interface Props {
  file: BusinessFileRow;
  types: FileDocumentTypeRow[];
  /** Tiles show at most two badges; the detail panel shows all of them. */
  max?: number;
  /** The LIST layout carries document type in its own column, so repeating it
   *  as the last badge is pure duplication — every row read "Gallery image
   *  Gallery image". Health badges still show, because those have no column. */
  hideType?: boolean;
}

type Badge = { key: string; text: string; tone: 'warn' | 'bad' | 'muted' | 'type' };

const TONE: Record<Badge['tone'], string> = {
  warn:  'bg-amber-500/15 text-amber-800 border-amber-500/25',
  bad:   'bg-red-500/15 text-red-700 border-red-500/25',
  muted: 'bg-charcoal/10 text-charcoal/70 border-charcoal/15',
  type:  'bg-copper/10 text-copper border-copper/20',
};

export function badgesFor(
  file: BusinessFileRow,
  types: FileDocumentTypeRow[],
  isAr: boolean,
  t: (k: string, o?: Record<string, unknown>) => string,
): Badge[] {
  const out: Badge[] = [];

  // "Unlinked TO ME": both halves of a link are RLS-gated, so a file can carry
  // edges the caller cannot see. The label says "not linked" rather than
  // "orphaned" for exactly that reason.
  if (file.link_count === 0) {
    out.push({ key: 'unlinked', tone: 'warn', text: t('files.library.badge.unlinked') });
  }
  if (file.valid_until && new Date(file.valid_until).getTime() < Date.now()) {
    out.push({ key: 'expired', tone: 'bad', text: t('files.library.badge.expired') });
  }
  if (file.status !== 'active') {
    out.push({ key: 'status', tone: 'muted', text: statusLabel(file.status, t as never) });
  }
  if (file.confidentiality === 'restricted') {
    out.push({ key: 'restricted', tone: 'bad', text: t('files.library.badge.restricted') });
  }
  out.push({
    key: 'type',
    tone: 'type',
    text: documentTypeLabel(file.document_type, types, isAr),
  });
  return out;
}

export default function LibraryBadges({ file, types, max, hideType }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const all = badgesFor(file, types, isAr, t).filter((b) => !(hideType && b.key === 'type'));
  const shown = typeof max === 'number' ? all.slice(0, max) : all;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {shown.map((b) => (
        <span
          key={b.key}
          className={`inline-flex items-center px-1.5 py-0.5 rounded-md border text-[10px] font-bold leading-none ${TONE[b.tone]}`}
        >
          {b.text}
        </span>
      ))}
      {typeof max === 'number' && all.length > max && (
        <span className="text-[10px] font-bold text-charcoal/40">+{all.length - max}</span>
      )}
    </div>
  );
}
