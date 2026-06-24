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
// Deploy: `supabase functions deploy invite-user`. Gateway JWT verification
// is OFF for this function (verify_jwt = false in supabase/config.toml). This
// is deliberate: the function does its OWN auth — it requires a Bearer token,
// validates it with auth.getUser(), and checks wassell_is_admin — so the
// gateway check was redundant. Worse, when the gateway rejected a bad/expired
// JWT it returned a 401 WITHOUT CORS headers; the browser then surfaced that
// as an opaque "Failed to send a request to the Edge Function" (a
// FunctionsFetchError) instead of the real reason. With the gateway out of the
// way, every auth failure now comes back as a proper JSON body + CORS headers
// the client can read. Do NOT flip verify_jwt back on without restoring a
// CORS-bearing gateway error — you'd reintroduce the masked-error bug.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getServiceClient } from "../_shared/supabase.ts";

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
  // T2: identity-tagged service-role client (x-wassel-service='edge:invite-user').
  const adminClient = getServiceClient("edge:invite-user");

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
  const { data: inviteData, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(
    email,
    { redirectTo: redirect },
  );
  if (inviteErr) {
    return json({ ok: false, error: inviteErr.message }, 400);
  }

  // Atomically bind public.users.auth_uid → auth.users.id while we still
  // hold service-role access. Without this, the invitee's first sign-in
  // has to bind itself via the bind_my_auth_uid() RPC — that works too
  // and is the heal-on-reload path for users invited before this fix
  // landed, but binding here means the magic link works immediately
  // without depending on the client running RPC successfully.
  //
  // Guard: only fill NULL slots (`.is('auth_uid', null)`). Re-invites
  // are no-ops on the binding. We never overwrite an existing auth_uid
  // — that would allow account hijack via a recycled email.
  //
  // The match is by email (the only thing public.users + auth.users
  // share at this point). If the admin hasn't yet created a row in
  // public.users with this email, the UPDATE touches zero rows and
  // the invite still works — the user will get an access-denied state
  // on first sign-in, which is the correct behavior (an admin must
  // provision them first).
  const invitedAuthId = inviteData?.user?.id;
  if (invitedAuthId) {
    const { error: bindErr } = await adminClient
      .from("users")
      .update({ auth_uid: invitedAuthId, updated_at: new Date().toISOString() })
      .eq("email", email)
      .is("auth_uid", null);
    if (bindErr) {
      // Don't fail the invite over the bind — the magic link is already
      // out. The bind_my_auth_uid() RPC will heal on first sign-in.
      // Log so an operator can investigate (visible in Edge Function
      // logs under the Supabase dashboard).
      console.error(
        `invite-user: bind auth_uid failed for ${email} (auth_uid=${invitedAuthId}): ${bindErr.message}`,
      );
    }
  }

  return json({ ok: true });
});
