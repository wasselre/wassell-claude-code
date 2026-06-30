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
  /** Write `location_items` (district + geo-element preferences). */
  onItemsChange: (items: LocationItem[]) => void;
  isAr: boolean;
  disabled?: boolean;
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
 * There is no second, competing district selector — the cascade is capped at city.
 */
export default function ClientLocationField({
  field, value, onChange, itemsValue, onItemsChange, isAr, disabled,
}: ClientLocationFieldProps) {
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
        items={parseLocationItems(itemsValue)}
        onChange={onItemsChange}
        locationField={field}
        locationValue={value}
        isAr={isAr}
        disabled={disabled}
      />
    </div>
  );
}
