import { useTranslation } from 'react-i18next';
import { placementTitle } from '@/pages/GeoGrade/lib/placementLine';
import type { DistrictInfo } from '@/pages/GeoGrade/lib/shared';
import type { GeoRow } from '../lib/geoRows';
import CardTile, { TileGrid, type TileChip } from './CardTile';

/**
 * The places of a reading as tiles — shared by the chat's own places and a
 * call's places. Line 1 is the PLACE (short, bold) with a «يريد» / «لا يريد»
 * chip; line 2 the customer's words. The full placement sentence rides in the
 * tooltip. An unresolved place is never savable: muted, no box, «يحتاج تأكيد»;
 * nor is a side clip that keeps nothing (its chip and tooltip say why).
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
        // A side clip that saves nothing says why on the tile itself, not only
        // in its tooltip: «لا جزء على هذا الجانب» / «تعذّر حساب الجزء».
        const blockedText = r.blocked === 'side_empty'
          ? t('chats.prefs.geo_side_empty')
          : r.blocked === 'side_missing'
            ? t('chats.prefs.geo_side_missing')
            : r.blocked === 'band_no_side' ? t('chats.prefs.geo_band_no_side') : null;
        const chip: TileChip = !r.savable
          ? { text: blockedText ?? t('chats.prefs.needs_confirm'), tone: 'warn' }
          : r.placement.polarity === 'exclude'
            ? { text: t('chats.prefs.geo_not_wants'), tone: 'exclude' }
            : { text: t('chats.prefs.geo_wants'), tone: 'include' };
        // A resolved place that still cannot be saved (a side clip with no part
        // on that side, a road side with no side) says why in its own line, not
        // "no real place was picked".
        const notSavableWhy = r.placement.resolved ? r.line.text : t('chats.prefs.geo_not_savable');
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
            title={r.savable ? undefined : notSavableWhy}
            ariaLabel={r.span}
            isAr={isAr}
          />
        );
      })}
    </TileGrid>
  );
}
