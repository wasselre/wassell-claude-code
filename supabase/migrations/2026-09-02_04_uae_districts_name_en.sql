-- ════════════════════════════════════════════════════════════════════════════
-- W6 (bilingual): fill name_en for the 9 UAE districts that were imported with
-- only an Arabic name. Geography names are OFFICIAL (never AI-invented at
-- runtime — resolveLocalizedName returns null when name_en is absent, so these
-- districts silently fell back to Arabic under an English label). These are
-- well-known UAE place names with standard English transliterations; filling
-- them makes the geo-name contract fully bilingual for the UAE too.
--
-- Keyed by id (stable) so a re-run is a harmless no-op. Idempotent: only fills
-- rows still missing an English name.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE public.districts AS d SET name_en = v.name_en
FROM (VALUES
  ('8ef8cf58-352d-2967-af2d-e5ef83774deb', 'Al Rifaah 1'),      -- الرفيعة 1 (Sharjah)
  ('65aac3aa-dfac-171c-5435-848a73d0e7e8', 'Al Rifaah 2'),      -- الرفيعة 2 (Sharjah)
  ('28fc66fc-2b4c-9ed5-6ed3-6324e1e93a63', 'Al Sidr'),          -- السدر (Fujairah)
  ('7f2d5fd1-cd41-052b-ab96-79285e244c58', 'Al Shamkha'),       -- الشامخة (Abu Dhabi)
  ('e43a03dd-142f-5f12-dc77-5ab8fcf13360', 'Marawah Island'),   -- جزيرة مروح (Abu Dhabi)
  ('e9caf155-6d00-3429-861a-ff81aac62339', 'Habhab'),           -- حبحب (Ras Al Khaimah)
  ('ef718c6c-c10c-0185-bca4-76316085f4db', 'Dibba'),            -- دبا (Fujairah)
  ('3760aad7-f136-ed14-b5cd-f32afc474500', 'Makan'),            -- مكن (Dubai)
  ('95520f9e-eb3b-a120-28e8-6db1ee407c03', 'Maidrah')           -- ميدرة (Ras Al Khaimah)
) AS v(id, name_en)
WHERE d.id = v.id::uuid
  AND (d.name_en IS NULL OR btrim(d.name_en) = '');
