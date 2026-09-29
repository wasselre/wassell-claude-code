import { useTranslation } from 'react-i18next';
import { placementTitle } from '@/pages/GeoGrade/lib/placementLine';
import type { DistrictInfo } from '@/pages/GeoGrade/lib/shared';
import type { GeoRow } from '../lib/geoRows';
import CardTile, { TileGrid, type TileChip } from './CardTile';

/**
 * The places of a reading as tiles — shared by the chat's own places and a
 * call's places. Line 1 is the PLACE (short, bold) with a «يريد» / «لا يريد»
 * chip; line 2 the customer's words. The full placement sentence rides in the
 * tooltip. An unresolved place is never savable: muted, no box, «يحتاج تأكيد».
 * Presentational: the slide owns the ticked state.
 */

interface Props {
  rows: GeoRow[];
  names: Record<string, DistrictInfo>;
  isTicked: (r: GeoRow) => boolean;
  onToggle: (evidenceId: string) => void;
  /** Disables every box (e.g. while saving). */
  disabled: boolean;
  isAr: boolean;
}

export default function PlaceTiles({ rows, names, isTicked, onToggle, disabled, isAr }: Props) {
  const { t } = useTranslation();
  // Wants first, then does-not-want — the same grouping the lines had.
  const ordered = [
    ...rows.filter((r) => r.placement.polarity === 'include'),
    ...rows.filter((r) => r.placement.polarity === 'exclude'),
  ];
  return (
    <TileGrid>
      {ordered.map((r) => {
        const chip: TileChip = !r.savable
          ? { text: t('chats.prefs.needs_confirm'), tone: 'warn' }
          : r.placement.polarity === 'exclude'
            ? { text: t('chats.prefs.geo_not_wants'), tone: 'exclude' }
            : { text: t('chats.prefs.geo_wants'), tone: 'include' };
        return (
          <CardTile
            key={r.evidenceId}
            id={r.evidenceId}
            tickable={r.savable}
            ticked={isTicked(r)}
            disabled={disabled}
            onToggle={() => onToggle(r.evidenceId)}
            main={placementTitle(r.placement, names, isAr)}
            mainTitle={r.line.text}
            chips={[chip]}
            quote={r.span}
            doubt={r.doubt}
            title={r.savable ? undefined : t('chats.prefs.geo_not_savable')}
            ariaLabel={r.span}
            isAr={isAr}
          />
        );
      })}
    </TileGrid>
  );
}
