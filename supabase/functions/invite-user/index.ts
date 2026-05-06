// invite-user — admin-only Edge Function that emails an invite link to a
// new user using Supabase's `auth.admin.inviteUserByEmail`.
//
// Why this exists:
// Before this function, the client called `auth.signInWithOtp({ email,
// shouldCreateUser: true })` directly. That works only when the project's
// "Allow new users to sign up" setting is ON, which means anyone with the
// project URL can self-register. Moving the invite path to a service-role
// edge function lets us turn project-level signups OFF and require an
// authenticated admin to invite.
//
// Auth: the caller's Supabase JWT is forwarded; the function verifies the
// caller is an admin (`profiles.is_admin = true`) before invoking the
// admin API. Non-admin calls get a 403.
//
// Body: `{ "email": "<invitee@example>", "redirect_to": "<optional url>" }`
// Returns: `{ "ok": true }` on success or `{ "ok": false, "error": "..." }`.
//
// Deploy: `supabase functions deploy invite-user`. The function is
// auto-protected by the gateway requiring a Supabase JWT (no
// --no-verify-jwt flag) so unauthenticated callers can't reach it.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ ok: false, error: "edge_function_not_configured" }, 500);
  }

  // Verify the caller is an authenticated admin.
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ ok: false, error: "missing_auth" }, 401);
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ ok: false, error: "invalid_session" }, 401);
  }

  // Resolve the caller's profile + admin flag via the SQL helper. We could
  // also query the `users`/`profiles` tables directly; using the helper
  // keeps the admin definition in one place.
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data: isAdminData, error: isAdminErr } = await adminClient.rpc(
    "wassell_is_admin",
    { auth_user_id: userData.user.id },
  );
  if (isAdminErr) {
    return json({ ok: false, error: `admin_check_failed: ${isAdminErr.message}` }, 500);
  }
  if (!isAdminData) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  // Parse body.
  let body: { email?: string; redirect_to?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400);
  }
  const email = (body.email ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return json({ ok: false, error: "invalid_email" }, 400);
  }
  const redirect = body.redirect_to ?? undefined;

  // Issue the invite via the admin API. inviteUserByEmail creates the
  // auth.users row (or returns the existing one) and emails them a magic
  // link that lands on `redirect_to` after click. Idempotent — re-inviting
  // an existing user just emails a fresh link.
  const { error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(
    email,
    { redirectTo: redirect },
  );
  if (inviteErr) {
    return json({ ok: false, error: inviteErr.message }, 400);
  }

  return json({ ok: true });
});
