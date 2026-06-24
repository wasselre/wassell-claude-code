// Generic webhook inbox. Any external system (e.g. a Supabase edge function
// running an AI agent, Zapier, a cron job, a CRM webhook) can POST JSON here
// and the app's workflow engine will pick it up via realtime and fire
// matching `on_webhook_received` workflows.
//
// URL: https://<project>.supabase.co/functions/v1/inbox/<slug>
//      (or query form: .../inbox?slug=<slug>)
// Method: POST
// Headers:
//   Content-Type: application/json (enforced)
//   X-Signature: <hex hmac-sha256(body, slug.secret)>  (optional; required when
//                 the slug has a non-null `secret` in webhook_slugs)
// Body: arbitrary JSON. The app's mapper UI lets users pick fields from this
//       body and map them into target records in the workflow editor.
//
// Auth: deployed with --no-verify-jwt because external systems typically
// don't have a Supabase session. The apikey header is not required (this is
// public). Per-slug secrecy is enforced via the optional X-Signature HMAC.
// Without a secret, the slug is effectively public — callable by anyone who
// knows the URL, no auth. Treat it like a webhook URL in Stripe/GitHub.

import { getServiceClient } from "../_shared/supabase.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }

  try {
    const slug = extractSlug(req);
    if (!slug) return json({ ok: false, error: "slug missing" }, 400);

    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return json({ ok: false, error: "server misconfigured" }, 500);
    // T2: identity-tagged service-role client (x-wassel-service='edge:inbox').
    const sb = getServiceClient("edge:inbox");

    // Look up the slug. Unknown or inactive slugs are rejected with 404 so an
    // attacker probing for valid slugs can't distinguish "disabled" from
    // "doesn't exist."
    const { data: slugRow, error: slugErr } = await sb
      .from("webhook_slugs")
      .select("id, slug, secret, is_active")
      .eq("slug", slug)
      .maybeSingle();
    if (slugErr) return json({ ok: false, error: slugErr.message }, 500);
    if (!slugRow || !slugRow.is_active) return json({ ok: false, error: "unknown slug" }, 404);

    const rawBody = await req.text();
    // Signature check (optional): if the slug has a secret, require X-Signature
    // to match HMAC-SHA256(rawBody, secret) in hex. We INSERT the payload
    // either way with signature_valid = false — the workflow engine can
    // decide whether to act on unsigned/invalid payloads, and a human can
    // audit failed signatures from the inbox view.
    let signatureValid: boolean | null = null;
    if (slugRow.secret) {
      const given = req.headers.get("X-Signature") ?? req.headers.get("x-signature") ?? "";
      const expected = await hmacSha256Hex(slugRow.secret, rawBody);
      signatureValid = timingSafeEquals(given, expected);
    }

    // Parse the body as JSON. Invalid JSON is still stored as `{ "__raw": "..." }`
    // so nothing is silently discarded — the user can see the garbled payload
    // in the inbox.
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        payload = { __value: payload };
      }
    } catch {
      payload = { __raw: rawBody.slice(0, 10_000) };
    }

    const forwarded = req.headers.get("x-forwarded-for") ?? "";
    const sourceIp = forwarded.split(",")[0]?.trim() || null;

    const { data: inserted, error: insErr } = await sb
      .from("webhook_payloads")
      .insert({
        slug: slugRow.slug,
        slug_id: slugRow.id,
        payload,
        signature_valid: signatureValid,
        source_ip: sourceIp,
      })
      .select("id")
      .single();
    if (insErr) return json({ ok: false, error: insErr.message }, 500);

    // Reject AFTER writing when the signature was supposed to match but didn't —
    // the record is there for audit, but the caller sees a 401 so they know
    // they need to fix their signing. A future option: add a flag on the slug
    // to drop invalid-signature payloads instead of recording them.
    if (slugRow.secret && !signatureValid) {
      return json({ ok: false, error: "invalid signature", payload_id: inserted.id }, 401);
    }

    return json({ ok: true, payload_id: inserted.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[inbox] failed:", msg);
    return json({ ok: false, error: msg.slice(0, 500) }, 500);
  }
});

function extractSlug(req: Request): string | null {
  const url = new URL(req.url);
  // /functions/v1/inbox/<slug>
  const pathParts = url.pathname.split("/").filter(Boolean);
  const inboxIdx = pathParts.indexOf("inbox");
  if (inboxIdx >= 0 && pathParts[inboxIdx + 1]) return pathParts[inboxIdx + 1];
  // or ?slug=<slug>
  const query = url.searchParams.get("slug");
  return query || null;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
