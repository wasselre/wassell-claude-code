-- Profile preview ("view app as another profile") — per-user grant.
--
-- Adds users.can_preview_profiles, OFF by default. An admin enables it per
-- user from Settings → Users; granted users get a header switcher that makes
-- the CLIENT permission layer evaluate another profile (sidebar, pages,
-- actions, field rules, client-side scope re-filter). Pure UI perspective:
-- every RLS policy still runs against the real auth.uid(), so the preview
-- can only narrow what the user sees, never widen data access. No RLS or
-- policy changes are needed here.
--
-- Must be applied BEFORE deploying the app change: the SPA upserts whole
-- user rows (appStore.saveUser → supabaseUpsert('users', user)), and an
-- unknown column would fail the write.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS can_preview_profiles BOOLEAN NOT NULL DEFAULT false;
