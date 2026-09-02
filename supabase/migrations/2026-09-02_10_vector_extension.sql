-- pgvector for semantic retrieval (script exemplars, competitor visual search).
-- Supabase installs extensions into the `extensions` schema; every function that
-- touches vector columns sets search_path TO 'public','extensions'.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
