import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import LookupCombobox from './LookupCombobox';
import type { LocationLevel, ModelField } from '@/types';

interface LocationCascadeFieldProps {
  field: ModelField;
  value: unknown; // compound: single { key: id } | multi { key: id[] }
  onChange: (value: unknown) => void;
}

// Singular display label per geography level. Falls back to the level's model
// label when the key isn't one of the known geography roles.
const LEVEL_LABELS: Record<string, { ar: string; en: string }> = {
  region: { ar: 'المنطقة', en: 'Region' },
  city: { ar: 'المدينة', en: 'City' },
  district: { ar: 'الحي', en: 'District' },
};

/**
 * Guided region → city → district picker. Each level is gated by its parent:
 * a child level is disabled until its parent has a selection, and its candidate
 * list is filtered to records whose `parent_link_field` holds one of the parent's
 * selected ids. Changing/clearing a parent prunes now-orphaned descendant picks.
 *
 * Single mode (`location_multi` false) stores `{ region: id, city: id, district: id }`;
 * multi mode stores `{ region: id[], city: id[], district: id[] }`.
 */
export default function LocationCascadeField({ field, value, onChange }: LocationCascadeFieldProps) {
  const { models, records, language } = useAppStore();
  const isAr = language === 'ar';
  const multi = !!field.location_multi;
  const levels = field.location_levels ?? [];

  const compound: Record<string, string | string[]> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, string | string[]>)
      : {};

  const idsOf = (key: string): string[] => {
    const v = compound[key];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    return typeof v === 'string' && v ? [v] : [];
  };

  // Resolve the slug on a child level's records that points at its parent level.
  // Config wins; otherwise auto-detect the child model's first lookup field whose
  // target is the parent level's model (cities.region_lookup, districts.city_lookup).
  const parentLinkFor = useMemo(() => {
    return (level: LocationLevel, parent: LocationLevel | null): string | null => {
      if (level.parent_link_field) return level.parent_link_field;
      if (!parent) return null;
      const model = models.find((m) => m.id === level.model_id);
      const lf = model?.schema.sections
        .flatMap((s) => s.fields)
        .find((f) => f.type === 'lookup' && f.lookup_model_id === parent.model_id);
      return lf?.name ?? null;
    };
  }, [models]);

  const levelLabel = (level: LocationLevel): string => {
    const known = LEVEL_LABELS[level.key];
    if (known) return isAr ? known.ar : known.en;
    const model = models.find((m) => m.id === level.model_id);
    return model ? (isAr ? model.label_ar : model.label_en) : level.key;
  };

  const setLevel = (idx: number, newIds: string[]) => {
    const current = levels[idx];
    if (!current) return;
    const next: Record<string, string | string[] | undefined> = { ...compound };
    next[current.key] = multi ? newIds : newIds[0];

    // Cascade-prune deeper levels: each child keeps only the picks whose parent
    // link still points at a selected parent id (and clears entirely if the
    // parent emptied).
    for (let d = idx + 1; d < levels.length; d++) {
      const child = levels[d]!;
      const parent = levels[d - 1]!;
      const plf = parentLinkFor(child, parent);
      const parentVal = next[parent.key];
      const parentIds = new Set(
        Array.isArray(parentVal) ? parentVal : typeof parentVal === 'string' && parentVal ? [parentVal] : [],
      );
      const childVal = next[child.key];
      const childIds = Array.isArray(childVal) ? childVal : typeof childVal === 'string' && childVal ? [childVal] : [];
      let kept: string[];
      if (parentIds.size === 0) {
        kept = [];
      } else if (plf) {
        const childRecs = records[child.model_id] ?? [];
        kept = childIds.filter((id) => {
          const rec = childRecs.find((r) => r.id === id);
          const pv = rec ? rec.data[plf] : undefined;
          return typeof pv === 'string' && parentIds.has(pv);
        });
      } else {
        kept = childIds;
      }
      next[child.key] = multi ? kept : kept[0];
    }

    const cleaned: Record<string, string | string[]> = {};
    for (const lv of levels) {
      const v = next[lv.key];
      if (multi) {
        if (Array.isArray(v) && v.length) cleaned[lv.key] = v;
      } else if (typeof v === 'string' && v) {
        cleaned[lv.key] = v;
      }
    }
    onChange(Object.keys(cleaned).length ? cleaned : undefined);
  };

  if (levels.length === 0) {
    return <div className="text-sm text-red-400">{isAr ? 'لم يتم إعداد حقل الموقع' : 'Location field not configured'}</div>;
  }

  return (
    <div className="space-y-2">
      {levels.map((level, idx) => {
        const parent = idx > 0 ? levels[idx - 1] ?? null : null;
        const plf = parent ? parentLinkFor(level, parent) : null;
        const parentIds = parent ? idsOf(parent.key) : null;
        const disabled = idx > 0 && (!parentIds || parentIds.length === 0);
        const predicate =
          idx > 0 && plf && parentIds && parentIds.length
            ? (rec: { id: string; data: Record<string, unknown> }) => {
                const pv = rec.data[plf];
                return typeof pv === 'string' && parentIds.includes(pv);
              }
            : undefined;
        const disabledHint = parent
          ? isAr
            ? `اختر ${levelLabel(parent)} أولاً`
            : `Pick the ${levelLabel(parent).toLowerCase()} first`
          : undefined;
        const selected = idsOf(level.key);
        return (
          <div key={level.key}>
            <label className="block text-xs font-bold text-charcoal/50 mb-1">{levelLabel(level)}</label>
            <LookupCombobox
              lookupModelId={level.model_id}
              lookupDisplayField={level.display_field}
              isMulti={multi}
              value={multi ? selected : selected[0]}
              onChange={(v) => setLevel(idx, Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : [])}
              candidatePredicate={predicate}
              disabled={disabled}
              disableCreate
              placeholder={disabled ? disabledHint : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}
