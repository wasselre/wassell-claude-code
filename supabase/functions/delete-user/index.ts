// delete-user — admin-only Edge Function that deletes a user's Supabase Auth
// identity (the auth.users row) using the service-role key. Mirror image of
// invite-user.
//
// Why this exists:
// The app's "Delete user" button only removes the app-level public.users row
// (via the store's supabaseDelete). The browser has NO way to delete the
// auth.users identity — that requires the service-role key, which must never
// reach the client. Without this function a deleted user's email stays
// registered in Supabase Auth forever, so re-inviting that same email fails
// with `email_exists` (a 422 that surfaces in the app as the opaque "Edge
// Function returned a non-2xx status code"). This function closes that gap:
// an authenticated admin can remove the Auth identity so the email is freed
// for a fresh invite.
//
// Auth: the caller's Supabase JWT is forwarded; we verify the caller is an
// admin (`wassell_is_admin`) before touching the admin API. Non-admins get a
// 403. Gateway JWT verification is OFF (verify_jwt = false in
// supabase/config.toml), same as invite-user — the function does its own
// Bearer + getUser + admin check, and turning the gateway off means auth
// failures return a CORS-bearing JSON error the browser can read instead of an
// opaque "Failed to send a request to the Edge Function".
//
// Body: `{ "auth_uid"?: "<uuid>", "email": "<addr>" }`
//   - auth_uid: the auth.users.id to delete (the frontend reads it from
//     public.users.auth_uid). Used directly when present.
//   - If auth_uid is absent/null we resolve the id from `email` via the admin
//     user list — covers orphaned identities whose public.users row was
//     already removed.
// Returns: `{ ok: true, deleted: boolean }` (deleted=false when there was no
// Auth identity to remove) or `{ ok: false, error: "..." }`.
//
// Idempotent: deleting an email with no Auth identity returns
// `{ ok:true, deleted:false }`, so re-running is always safe.
//
// Deploy: `supabase functions deploy delete-user`.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

// Resolve an auth user id by email when the caller didn't pass auth_uid (e.g.
// an orphaned identity whose public.users row was already removed). The org is
// small so a single large page covers it; we still loop defensively to a cap.
async function findAuthIdByEmail(
  adminClient: SupabaseClient,
  email: string,
): Promise<string | null> {
  const target = email.trim().toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const match = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (match) return match.id;
    if (data.users.length < perPage) break; // last page reached
  }
  return null;
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
  let body: { auth_uid?: string | null; email?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400);
  }
  const email = (body.email ?? "").trim().toLowerCase();
  let authUid = (body.auth_uid ?? "").trim();

  // Defense in depth: never let an admin delete their OWN Auth identity through
  // this path — that would lock them out mid-session. The app's last-admin
  // guard already blocks the common case; this is a backstop.
  if (authUid && authUid === userData.user.id) {
    return json({ ok: false, error: "cannot_delete_self" }, 400);
  }

  // Resolve the target id from email when not provided.
  if (!authUid) {
    if (!email || !email.includes("@")) {
      return json({ ok: false, error: "missing_identifier" }, 400);
    }
    try {
      const resolved = await findAuthIdByEmail(adminClient, email);
      if (!resolved) {
        // No Auth identity for this email — nothing to delete. Idempotent OK.
        return json({ ok: true, deleted: false });
      }
      authUid = resolved;
    } catch (e) {
      return json(
        { ok: false, error: `lookup_failed: ${e instanceof Error ? e.message : String(e)}` },
        500,
      );
    }
    if (authUid === userData.user.id) {
      return json({ ok: false, error: "cannot_delete_self" }, 400);
    }
  }

  // Delete the Auth identity. admin.deleteUser cascades the auth-schema
  // dependents (identities, sessions, refresh tokens). public.users has NO FK
  // to auth.users, so the app row is unaffected — the store removes it
  // separately.
  const { error: delErr } = await adminClient.auth.admin.deleteUser(authUid);
  if (delErr) {
    const msg = delErr.message ?? String(delErr);
    // "User not found" → already gone; treat as success (idempotent).
    if (/not\s*found/i.test(msg)) {
      return json({ ok: true, deleted: false });
    }
    return json({ ok: false, error: msg }, 400);
  }

  return json({ ok: true, deleted: true });
});
