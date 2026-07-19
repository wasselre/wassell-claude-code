/**
 * CONFORMANCE FIXTURES for the geography localization contract (Issue #8).
 *
 * These cases are the contract. The canonical implementation
 * (`src/lib/geo/localizedName.ts`) and every runtime adapter that cannot import
 * it — worker, Supabase Edge, the public website — MUST produce identical
 * results for every case here. Adapters carry a test that walks this list.
 *
 * Every fixture is drawn from REAL production data shapes (verified 2026-07-19)
 * so the suite can never drift into a fictional schema — the previous test
 * fixtures declared geography models with `display_name` ONLY, which is why the
 * missing-`name_en` defect was invisible to CI for months.
 */

export interface GeoFixture {
  /** What this case pins down. */
  name: string;
  id: string;
  data: Record<string, unknown>;
  /** null = the record must NOT be fully localizable (English unavailable). */
  expect: { ar: string; enCanonical: string; enDisplay: string } | null;
}

export const GEO_FIXTURES: GeoFixture[] = [
  {
    name: 'district — the «Al-Muharraq» incident record; display_name wins for Arabic',
    id: 'e970534a-eace-0c3b-26b6-82068c51f8c7',
    data: { display_name: 'المهدية', name_ar: 'حي المهدية', name_en: 'Al Mahdiyah Dist.' },
    expect: { ar: 'المهدية', enCanonical: 'Al Mahdiyah Dist.', enDisplay: 'Al Mahdiyah' },
  },
  {
    name: 'city — Riyadh; the project-message «City: الرياض» regression',
    id: '44254a38-ce40-938f-17b7-55814a44e45c',
    data: { display_name: 'الرياض', name_ar: 'الرياض', name_en: 'Riyadh' },
    expect: { ar: 'الرياض', enCanonical: 'Riyadh', enDisplay: 'Riyadh' },
  },
  {
    name: 'district — Al Qairawan (the أدوار - يمام 9 project)',
    id: '5405e1c7-91e1-a36c-6135-52a0615a7cf7',
    data: { display_name: 'القيروان', name_ar: 'حي القيروان', name_en: 'Al Qairawan Dist.' },
    expect: { ar: 'القيروان', enCanonical: 'Al Qairawan Dist.', enDisplay: 'Al Qairawan' },
  },
  {
    name: 'region — NO display_name key at all (0/13 regions have one)',
    id: '9c0c7a82-738d-6456-2101-b7226cc84e20',
    data: { name_ar: 'منطقة الرياض', name_en: 'Riyadh Region' },
    expect: { ar: 'منطقة الرياض', enCanonical: 'Riyadh Region', enDisplay: 'Riyadh Region' },
  },
  {
    name: 'stored double-space is normalized, canonical still reflects the DB value',
    id: 'dup-asharai',
    data: { display_name: 'الشرائع', name_ar: 'حي الشرائع', name_en: 'Asharai  Dist.' },
    expect: { ar: 'الشرائع', enCanonical: 'Asharai Dist.', enDisplay: 'Asharai' },
  },
  {
    name: 'hand-seeded district with no boundary and no Dist. suffix',
    id: 'd15a0003-0000-4000-8000-000000000001',
    data: { display_name: 'الملك سلمان', name_ar: 'حي الملك سلمان', name_en: 'King Salman' },
    expect: { ar: 'الملك سلمان', enCanonical: 'King Salman', enDisplay: 'King Salman' },
  },
  {
    name: 'full "District" suffix is stripped for display',
    id: 'suffix-full-word',
    data: { name_ar: 'حي النرجس', name_en: 'Al Narjis District' },
    expect: { ar: 'حي النرجس', enCanonical: 'Al Narjis District', enDisplay: 'Al Narjis' },
  },
  {
    name: 'mid-string "District" is NOT stripped',
    id: 'suffix-midstring',
    data: { name_ar: 'حي التبريد', name_en: 'District Cooling Plant' },
    expect: { ar: 'حي التبريد', enCanonical: 'District Cooling Plant', enDisplay: 'District Cooling Plant' },
  },
  {
    name: 'a name that IS "District" is never emptied by stripping',
    id: 'suffix-only',
    data: { name_ar: 'الحي', name_en: 'District' },
    expect: { ar: 'الحي', enCanonical: 'District', enDisplay: 'District' },
  },
  {
    name: 'comma before the suffix is cleaned up',
    id: 'suffix-comma',
    data: { name_ar: 'حي العليا', name_en: 'Al Olaya, Dist.' },
    expect: { ar: 'حي العليا', enCanonical: 'Al Olaya, Dist.', enDisplay: 'Al Olaya' },
  },
  {
    name: 'MISSING name_en must fail — never silently fall back to Arabic',
    id: 'missing-en',
    data: { display_name: 'حي بلا إنجليزي', name_ar: 'حي بلا إنجليزي' },
    expect: null,
  },
  {
    name: 'BLANK name_en is treated as missing',
    id: 'blank-en',
    data: { display_name: 'حي فارغ', name_ar: 'حي فارغ', name_en: '   ' },
    expect: null,
  },
  {
    name: 'missing Arabic entirely must fail',
    id: 'missing-ar',
    data: { name_en: 'Somewhere' },
    expect: null,
  },
];

/** Values that must never appear in an LLM prompt or user-visible output. */
export const UUID_LEAK_SAMPLES = [
  '5405e1c7-91e1-a36c-6135-52a0615a7cf7',
  { region: '9c0c7a82-738d-6456-2101-b7226cc84e20', city: '44254a38-ce40-938f-17b7-55814a44e45c' },
  { location: { district: 'e970534a-eace-0c3b-26b6-82068c51f8c7' } },
  ['ok', { nested: ['d15a0003-0000-4000-8000-000000000001'] }],
];
