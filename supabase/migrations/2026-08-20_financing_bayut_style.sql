-- ============================================================================
-- Financing calculator — Bayut-style rebuild (2026-08-20)
--
-- The V2 prequalification engine's UI + API were deleted on user decision
-- ("too complicated"); the app now ships a duplicate of bayut.sa's simple
-- listing-page calculator: pick a bank, price / down payment / term sliders,
-- FLAT-rate math done client-side.
--
-- This migration adds the ONE table the new calculator reads: a per-bank,
-- per-tenure flat-rate matrix, seeded verbatim from bayut.sa `GET /api/banks`
-- (scraped 2026-08-20). Rates are edited by SQL/Claude — no admin UI.
--
-- NOTHING IS DROPPED. financing_products / financing_rates / financing_rules /
-- financing_scenarios (V2) and the deprecated fin_* (V1) keep their data; they
-- are simply no longer read by any code. A later cleanup can drop them once
-- the user explicitly asks.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.financing_banks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name_ar     text NOT NULL,
  name_en     text NOT NULL,
  -- {"5": 0.0345, ..., "25": 0.041} — annual FLAT rate (decimal) per tenure years.
  rates       jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order  integer NOT NULL DEFAULT 100,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.financing_banks ENABLE ROW LEVEL SECURITY;

-- Readable by every signed-in user (the calculator is not sensitive — it holds
-- published bank rates, no customer data). Writes are service-role/SQL only:
-- no INSERT/UPDATE/DELETE policies exist on purpose.
DROP POLICY IF EXISTS financing_banks_read ON public.financing_banks;
CREATE POLICY financing_banks_read ON public.financing_banks
  FOR SELECT TO authenticated USING (true);

-- ── Seed (idempotent) ───────────────────────────────────────────────────────
-- Rates from bayut.sa, 2026-08-20. Riyad Bank publishes none there; Bayut
-- falls back to 3.60% — seeded explicitly. FAB's 16y=4.00% is Bayut's own
-- source value (their data-entry anomaly), kept verbatim.
INSERT INTO public.financing_banks (slug, name_ar, name_en, sort_order, rates) VALUES
  ('emirates-nbd', 'بنك الإمارات دبي الوطني', 'Emirates NBD', 1,
   '{"5":0.0345,"6":0.0365,"7":0.0365,"8":0.0365,"9":0.0365,"10":0.0365,"11":0.038,"12":0.038,"13":0.038,"14":0.038,"15":0.038,"16":0.0395,"17":0.0395,"18":0.0395,"19":0.0395,"20":0.0395,"21":0.041,"22":0.041,"23":0.041,"24":0.041,"25":0.041}'),
  ('al-jazira', 'بنك الجزيرة', 'Bank AlJazira', 2,
   '{"5":0.0346,"6":0.0346,"7":0.0346,"8":0.0346,"9":0.0346,"10":0.0355,"11":0.036,"12":0.0365,"13":0.037,"14":0.0375,"15":0.038,"16":0.0385,"17":0.039,"18":0.04,"19":0.0405,"20":0.0407,"21":0.0413,"22":0.0416,"23":0.042,"24":0.0424,"25":0.0426}'),
  ('fab', 'بنك أبوظبي الأول', 'FAB', 3,
   '{"5":0.0385,"6":0.0408,"7":0.0408,"8":0.0408,"9":0.0408,"10":0.0408,"11":0.042,"12":0.042,"13":0.042,"14":0.042,"15":0.042,"16":0.04,"17":0.0441,"18":0.0441,"19":0.0441,"20":0.0441,"21":0.0458,"22":0.0458,"23":0.0458,"24":0.0458,"25":0.0458}'),
  ('al-rajhi', 'مصرف الراجحي', 'Al Rajhi', 4,
   '{"5":0.0389,"6":0.0409,"7":0.0409,"8":0.0409,"9":0.0409,"10":0.0394,"11":0.0399,"12":0.0404,"13":0.0409,"14":0.0414,"15":0.0419,"16":0.0424,"17":0.0429,"18":0.0434,"19":0.0439,"20":0.0444,"21":0.0454,"22":0.0459,"23":0.0463,"24":0.0469,"25":0.0474}'),
  ('snb', 'البنك الأهلي السعودي', 'SNB', 5,
   '{"5":0.0383,"6":0.0385,"7":0.0389,"8":0.0392,"9":0.0395,"10":0.0399,"11":0.0404,"12":0.0409,"13":0.0415,"14":0.042,"15":0.0426,"16":0.0432,"17":0.0438,"18":0.0444,"19":0.045,"20":0.0456,"21":0.0463,"22":0.0469,"23":0.0475,"24":0.0482,"25":0.0487}'),
  ('riyad-bank', 'بنك الرياض', 'Riyad Bank', 6,
   '{"5":0.036,"6":0.036,"7":0.036,"8":0.036,"9":0.036,"10":0.036,"11":0.036,"12":0.036,"13":0.036,"14":0.036,"15":0.036,"16":0.036,"17":0.036,"18":0.036,"19":0.036,"20":0.036,"21":0.036,"22":0.036,"23":0.036,"24":0.036,"25":0.036}'),
  ('shl', 'الشركة السعودية لتمويل المساكن', 'SHL', 7,
   '{"5":0.055,"6":0.0556,"7":0.0564,"8":0.0571,"9":0.0578,"10":0.0586,"11":0.0593,"12":0.0601,"13":0.0608,"14":0.0616,"15":0.0623,"16":0.063,"17":0.0637,"18":0.0644,"19":0.0651,"20":0.0658,"21":0.0665,"22":0.0671,"23":0.0678,"24":0.0684,"25":0.0696}'),
  ('sab', 'البنك السعودي الأول', 'SAB', 8,
   '{"5":0.0315,"6":0.0315,"7":0.0315,"8":0.0315,"9":0.0315,"10":0.0345,"11":0.0345,"12":0.0355,"13":0.0355,"14":0.036,"15":0.036,"16":0.0365,"17":0.0365,"18":0.0375,"19":0.0375,"20":0.0379,"21":0.0395,"22":0.0398,"23":0.0401,"24":0.0404,"25":0.0406}'),
  ('dar-al-tamleek', 'دار التمليك', 'Dar Al Tamleek', 9,
   '{"5":0.052,"6":0.052,"7":0.052,"8":0.0539,"9":0.0546,"10":0.0553,"11":0.0553,"12":0.0553,"13":0.0553,"14":0.0553,"15":0.0586,"16":0.0586,"17":0.0586,"18":0.0586,"19":0.0586,"20":0.0619,"21":0.0619,"22":0.0619,"23":0.0619,"24":0.0619,"25":0.0619}'),
  ('bsf', 'البنك السعودي الفرنسي', 'BSF', 10,
   '{"5":0.036,"6":0.036,"7":0.036,"8":0.036,"9":0.036,"10":0.0365,"11":0.0365,"12":0.037,"13":0.0375,"14":0.038,"15":0.0385,"16":0.039,"17":0.0395,"18":0.04,"19":0.0405,"20":0.041,"21":0.0415,"22":0.042,"23":0.0425,"24":0.043,"25":0.0435}')
ON CONFLICT (slug) DO UPDATE
  SET name_ar = EXCLUDED.name_ar,
      name_en = EXCLUDED.name_en,
      sort_order = EXCLUDED.sort_order,
      rates = EXCLUDED.rates,
      updated_at = now();
