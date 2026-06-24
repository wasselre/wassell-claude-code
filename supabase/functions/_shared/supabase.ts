// Service-role Supabase client for edge functions.
// Bypasses RLS; only use inside functions — never ship the key to the browser.

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

// Cache one client per service name (each edge function is its own isolate, so
// the map holds at most a couple of entries).
const cache = new Map<string, SupabaseClient>();

/**
 * Service-role client for edge functions, tagged with caller identity (T2).
 * `serviceName` should be `edge:<function>` (e.g. 'edge:invite-user') so a
 * looping/storming edge call is attributable in Postgres logs. Defaults to
 * 'edge:unknown' to stay backward-compatible with any no-arg caller.
 */
export function getServiceClient(serviceName = "edge:unknown"): SupabaseClient {
  const hit = cache.get(serviceName);
  if (hit) return hit;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from env");
  }
  const client = createClient(url, key, {
    auth: { persistSession: false },
    global: {
      headers: {
        "x-wassel-service": serviceName,
        "x-wassel-build": Deno.env.get("WASSEL_EDGE_BUILD") ?? "unknown",
        "x-wassel-instance": Deno.env.get("DENO_REGION") ?? "unknown",
      },
    },
  });
  cache.set(serviceName, client);
  return client;
}

export function functionUrl(name: string): string {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new Error("SUPABASE_URL missing from env");
  return `${url}/functions/v1/${name}`;
}

// Edge-function → edge-function calls use the service-role key as the bearer
// token so the target function's auth middleware lets it through. We register
// the background promise with EdgeRuntime.waitUntil so Deno Deploy keeps the
// isolate alive until it resolves — plain fire-and-forget would get killed
// when the parent function returns its response.
export async function invokeFunction(name: string, body: unknown): Promise<void> {
  // Use the legacy anon JWT stored as INTERNAL_JWT for the Authorization header.
  // Under the new Supabase API key scheme, both SUPABASE_ANON_KEY (sb_publishable_*)
  // and SUPABASE_SERVICE_ROLE_KEY (sb_secret_*) are NOT JWTs and get rejected by
  // the edge function gateway's verify_jwt check. The downstream function still
  // uses its own SERVICE_ROLE_KEY for the DB client, so DB-level access is fine.
  const key = Deno.env.get("INTERNAL_JWT");
  if (!key) throw new Error("INTERNAL_JWT missing from env");
  const p = fetch(functionUrl(name), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  }).then(async (r) => {
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error(`[invokeFunction] ${name} returned ${r.status}:`, text.slice(0, 300));
    }
  }).catch((err) => {
    console.error(`[invokeFunction] ${name} failed:`, err);
  });
  // deno-lint-ignore no-explicit-any
  const runtime = (globalThis as any).EdgeRuntime;
  if (runtime && typeof runtime.waitUntil === "function") {
    runtime.waitUntil(p);
  } else {
    await p;
  }
}
