import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { GeoRow } from '../lib/geoRows';

/**
 * «يريد / لا يريد» — the geography lines of a reading, grouped by polarity.
 * Presentational only: shared by the chat's own places (GeoPrefCard) and the
 * call audit's places (CallAuditSection). With `withBox` each savable line has
 * a tick box (the caller owns the ticked state); without it, a saved reading
 * shows a check mark per line.
 */

interface Props {
  rows: GeoRow[];
  withBox: boolean;
  isTicked: (r: GeoRow) => boolean;
  onToggle: (evidenceId: string) => void;
  /** Disables every box (e.g. while saving). */
  disabled: boolean;
  isAr: boolean;
}

export default function GeoLineGroups({ rows, withBox, isTicked, onToggle, disabled, isAr }: Props) {
  const { t } = useTranslation();
  const include = rows.filter((r) => r.placement.polarity === 'include');
  const exclude = rows.filter((r) => r.placement.polarity === 'exclude');

  const rowView = (r: GeoRow) => (
    <li key={r.evidenceId} className="flex items-start gap-2">
      {withBox ? (
        <input
          type="checkbox"
          className="mt-1 accent-copper shrink-0"
          checked={isTicked(r)}
          disabled={!r.savable || disabled}
          onChange={() => onToggle(r.evidenceId)}
          aria-label={r.span}
        />
      ) : (
        <Check size={12} className="mt-1 shrink-0 text-green-600" />
      )}
      <div className="min-w-0 flex-1">
        <p className={`text-[12px] leading-snug ${isTicked(r) || !withBox ? 'text-charcoal' : 'text-charcoal/40 line-through'}`}>
          <span className="font-bold text-chocolate" dir="auto">«{r.span}»</span>
          {' — '}
          <span className={r.line.tone === 'warn' ? 'text-amber-700' : ''}>{r.line.text}</span>
        </p>
        {!r.savable && withBox && (
          <p className="text-[10.5px] text-amber-700">{t('chats.prefs.geo_not_savable')}</p>
        )}
        {r.doubt && <p className="text-[10.5px] text-amber-700" dir={isAr ? 'rtl' : 'ltr'}>{r.doubt}</p>}
      </div>
    </li>
  );

  const group = (title: string, list: GeoRow[], tone: string) => list.length > 0 && (
    <div className="mt-1.5">
      <p className={`text-[11px] font-bold ${tone}`}>{title}</p>
      <ul className="mt-0.5 space-y-1">{list.map(rowView)}</ul>
    </div>
  );

  return (
    <>
      {group(t('chats.prefs.geo_wants'), include, 'text-emerald-700')}
      {group(t('chats.prefs.geo_not_wants'), exclude, 'text-red-700')}
    </>
  );
}
