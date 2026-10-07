-- السليمانية is central Riyadh, not north.
--
-- It sat in the curated Riyadh NORTH override AND in the coordinate-based
-- center set, and the sales agent's region count checks north first — so a
-- «وسط الرياض» customer heard «ما عندنا تاون هاوس بالوسط» 30 seconds after
-- being sent جزيل (in السليمانية), and a north search offered it as north
-- (review 2026-10-07, two chats). Removing the north row leaves it in center.
DELETE FROM public.geo_zone_overrides
 WHERE city_id = '3' AND zone = 'north'
   AND district_id = '97b09fa7-6b5d-df9c-881b-81da36eda190';
