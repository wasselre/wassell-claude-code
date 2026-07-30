/**
 * The 7 emirate boundary relations (OSM ids, confirmed live against Overpass
 * 2026-07-30 by querying admin_level=4 inside the UAE country relation 307763).
 *
 * Its own module so both fetch.mjs and the process scripts can import it without
 * importing a script that runs work on load.
 *
 * `code` is ours, not OSM's: it namespaces every external id this pipeline mints
 * (`AE-DXB-D0001`) and keeps them stable across re-runs even if OSM renumbers.
 */
export const EMIRATES = [
  { osm_id: 3766481, code: 'AUH', name_en: 'Abu Dhabi', name_ar: 'أبو ظبي' },
  { osm_id: 3766483, code: 'DXB', name_en: 'Dubai', name_ar: 'دبي' },
  { osm_id: 3766486, code: 'SHJ', name_en: 'Sharjah', name_ar: 'الشارقة' },
  { osm_id: 3766482, code: 'AJM', name_en: 'Ajman', name_ar: 'عجمان' },
  { osm_id: 3766487, code: 'UAQ', name_en: 'Umm al-Quwain', name_ar: 'أم القيوين' },
  { osm_id: 3766485, code: 'RAK', name_en: 'Ras al-Khaimah', name_ar: 'رأس الخيمة' },
  { osm_id: 3766484, code: 'FUJ', name_en: 'Fujairah', name_ar: 'الفجيرة' },
];
