import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import LocationCascadeField from './LocationCascadeField';
import LocationItemsEditor from '@/components/LocationItemsEditor';
import { parseLocationItems, type LocationItem } from '@/lib/geo/locationItems';
import type { ModelField } from '@/types';

interface ClientLocationFieldProps {
  /** The clients `location` field (country → region → city → district levels). */
  field: ModelField;
  /** Current compound value of the location cascade. */
  value: unknown;
  /** Write the location cascade value (base country/region/city). */
  onChange: (value: unknown) => void;
  /** Raw `location_items` from the record (parsed internally). */
  itemsValue: unknown;
  /** Sibling-field writer — persists `location_items` (and, when migrating legacy
   *  cascade districts, clears the old `location.district` in the same patch). */
  onPatch: (patch: Record<string, unknown>) => void;
  isAr: boolean;
  disabled?: boolean;
}

/** District record ids stored on the OLD cascade's district level (array or scalar). */
function legacyDistrictIds(loc: unknown): string[] {
  const c = loc && typeof loc === 'object' && !Array.isArray(loc) ? (loc as Record<string, unknown>) : {};
  const d = c.district;
  if (Array.isArray(d)) return d.filter((x): x is string => typeof x === 'string' && x !== '');
  return typeof d === 'string' && d ? [d] : [];
}

/** The location compound with the legacy district level removed. */
function withoutDistrict(loc: unknown): Record<string, unknown> {
  const c = loc && typeof loc === 'object' && !Array.isArray(loc) ? { ...(loc as Record<string, unknown>) } : {};
  delete c.district;
  return c;
}

/**
 * The ONE unified location section for a client. A single bordered box:
 *   1. the base cascade — country → region → city (district level is hidden; it
 *      lives in `location_items` as chips, not the cascade),
 *   2. a one-line hint,
 *   3. the saved district / geo-element preference chips + "+ Add district" /
 *      "+ Add element" controls (the embedded `LocationItemsEditor`).
 *
 * Base city stays in the `location` field value; district + geo-element rules go
 * to `clients.data.location_items` (what the deterministic Project Finder reads).
 *
 * BACKWARD COMPAT: older clients picked districts on the OLD cascade, stored in
 * `location.district`. The cascade is now capped at city, so those would be
 * invisible here. We surface them as district chips (merged for display) so nothing
 * looks lost; the moment the user edits the chips, they're migrated into
 * `location_items` and `location.district` is cleared (one source of truth, and
 * removing a chip actually removes the district instead of leaving it on the old
 * cascade where the finder would still read it).
 */
export default function ClientLocationField({
  field, value, onChange, itemsValue, onPatch, isAr, disabled,
}: ClientLocationFieldProps) {
  const records = useAppStore((s) => s.records);

  // Resolve the districts model (last cascade level) for chip labels.
  const districtsModelId = useMemo(() => {
    const levels = field.location_levels ?? [];
    return levels[levels.length - 1]?.model_id ?? null;
  }, [field]);

  const resolveDistrictLabel = (id: string): string => {
    const recs = districtsModelId ? records[districtsModelId] ?? [] : [];
    const data = recs.find((r) => r.id === id)?.data ?? {};
    const dn = data.display_name ?? (isAr ? data.name_ar : data.name_en) ?? data.name_en ?? data.name_ar;
    return typeof dn === 'string' && dn.trim() ? dn : id;
  };

  const parsed = useMemo(() => parseLocationItems(itemsValue), [itemsValue]);

  // Legacy cascade districts NOT already represented as district items → synthetic
  // chips so they stay visible. Stable id so React keys + dedup don't churn.
  const legacyIds = useMemo(() => {
    const have = new Set(parsed.filter((i) => i.kind === 'district').map((i) => i.district_id));
    return legacyDistrictIds(value).filter((id) => !have.has(id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, parsed]);

  const legacyItems: LocationItem[] = legacyIds.map((id) => ({
    id: `legacy-district-${id}`,
    kind: 'district',
    polarity: 'include',
    district_id: id,
    district_label: resolveDistrictLabel(id),
  }));

  const displayItems = legacyItems.length ? [...parsed, ...legacyItems] : parsed;

  // On ANY item change, persist the full list. When legacy cascade districts were
  // showing, migrate them: write them into location_items (those still present in
  // `next`) AND clear `location.district` so there's a single source of truth and a
  // removed chip is truly gone (not still read off the old cascade by the finder).
  const handleItemsChange = (next: LocationItem[]) => {
    if (legacyIds.length) onPatch({ location_items: next, location: withoutDistrict(value) });
    else onPatch({ location_items: next });
  };

  return (
    <div className="rounded-xl border border-sand/40 bg-cream/20 p-3 space-y-2.5">
      <LocationCascadeField field={field} value={value} onChange={onChange} maxLevelKey="city" />
      <p className="text-[11px] leading-5 text-charcoal/50">
        {isAr
          ? 'اختر المدينة أولاً، ثم أضف الأحياء أو العناصر القريبة.'
          : 'Pick the city first, then add districts or nearby elements.'}
      </p>
      <LocationItemsEditor
        embedded
        items={displayItems}
        onChange={handleItemsChange}
        locationField={field}
        locationValue={value}
        isAr={isAr}
        disabled={disabled}
      />
    </div>
  );
}
