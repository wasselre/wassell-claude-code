import CardTile, { TileGrid, type TileChip } from './CardTile';

/**
 * Preference lines (budget, unit type, area, …) as tiles — shared by the chat's
 * own preferences and a call's. Line 1 the field, line 2 the value, line 3 the
 * customer's words. Presentational: the slide owns the ticked state.
 */

export interface SpecTileItem {
  slug: string;
  label: string;
  value: string;
  quote: string | null;
  ticked: boolean;
  /** Box shown but not changeable (e.g. logged since the call). */
  locked: boolean;
  chip?: TileChip;
  /** Tooltip — what is saved today and what saving does. */
  title?: string;
}

export default function SpecTiles({ items, onToggle, disabled, isAr }: {
  items: SpecTileItem[];
  onToggle: (slug: string) => void;
  /** Disables every box (e.g. while saving). */
  disabled: boolean;
  isAr: boolean;
}) {
  return (
    <TileGrid>
      {items.map((it) => (
        <CardTile
          key={it.slug}
          id={it.slug}
          tickable
          ticked={it.ticked}
          disabled={disabled || it.locked}
          onToggle={() => onToggle(it.slug)}
          eyebrow={it.label}
          main={it.value}
          chips={it.chip ? [it.chip] : []}
          quote={it.quote}
          title={it.title}
          ariaLabel={it.label}
          isAr={isAr}
        />
      ))}
    </TileGrid>
  );
}
