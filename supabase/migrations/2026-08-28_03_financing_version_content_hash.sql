-- content_hash lets the ingestion pipeline detect "did this actually change?"
-- without diffing every column. The reference-data migration added it to the
-- product/rate/regulatory version tables; tax and support-program versions were
-- missed and the seeder writes it uniformly for all version tables.
ALTER TABLE public.fin_tax_rule_versions        ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE public.fin_support_program_versions ADD COLUMN IF NOT EXISTS content_hash text;
