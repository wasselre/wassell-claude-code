/**
 * Verify the Supabase user JWT on incoming requests to `api/haberchat/*`.
 *
 * The SPA attaches its Supabase session access_token as `Authorization: Bearer <jwt>`.
 * This helper validates that JWT against Supabase and returns the user id +
 * email, or throws `AuthError` (handler translates to 401/500 response).
 *
 * We do NOT use `SUPABASE_SERVICE_ROLE_KEY` here — an anon-key client is
 * sufficient for `auth.getUser(jwt)`, which validates the JWT's signature on
 * Supabase's side. Service role is reserved for the webhook handler that
 * needs to write data on behalf of every user (bypassing RLS).
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { logApiRequest } from './activityLogger.js';

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let clientSingleton: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (clientSingleton) return clientSingleton;
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  // Accept either the non-prefixed anon key (added to Vercel for server use)
  // or the VITE_ prefixed one already in the project — Vercel exposes both
  // to Edge functions. No secrets leak to the browser since neither value is
  // read from `import.meta.env` here.
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new AuthError(500, 'Supabase env vars missing: SUPABASE_URL + (SUPABASE_ANON_KEY or VITE_SUPABASE_ANON_KEY)');
  }
  clientSingleton = createClient(url, anonKey, { auth: { persistSession: false } });
  return clientSingleton;
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
}

/**
 * Throws `AuthError(401)` if the request is unauthenticated.
 * Throws `AuthError(500)` if Supabase env vars aren't configured.
 */
export async function verifySupabaseJWT(req: Request): Promise<AuthenticatedUser> {
  const auth = req.headers.get('Authorization');
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
    throw new AuthError(401, 'missing bearer token');
  }
  const jwt = auth.slice(7).trim();
  if (!jwt) throw new AuthError(401, 'empty bearer token');

  const { data, error } = await getClient().auth.getUser(jwt);
  if (error || !data.user) {
    throw new AuthError(401, 'invalid token');
  }
  return { userId: data.user.id, email: data.user.email ?? '' };
}

/**
 * Convenience wrapper: run `handler` only if the request has a valid Supabase
 * JWT. On auth failure, respond with a plain JSON error.
 *
 * Also writes one row into `activity_log` (category='api') per request so the
 * unified /logs timeline shows method, path, status code, duration, and the
 * actor. Logging is fire-and-forget — the response is returned to the caller
 * without waiting for the insert. Streaming responses (SSE) are logged with
 * status 200 at handler-return time; the underlying stream may continue
 * after this point.
 *
 * Usage at the top of each api/haberchat/*.ts file:
 *   export default async function (req: Request) {
 *     return withAuth(req, async (_user) => { ...real work... });
 *   }
 */
export async function withAuth(
  req: Request,
  handler: (user: AuthenticatedUser) => Promise<Response>,
): Promise<Response> {
  const startedAt = Date.now();
  let user: AuthenticatedUser | null = null;
  let response: Response;
  let errorMessage: string | undefined;
  try {
    user = await verifySupabaseJWT(req);
    response = await handler(user);
  } catch (err) {
    if (err instanceof AuthError) {
      response = jsonError(err.status, err.message);
      errorMessage = err.message;
    } else {
      errorMessage = err instanceof Error ? err.message : String(err);
      response = jsonError(500, errorMessage);
    }
  }
  // Fire-and-forget — never block the response on the audit-log insert.
  void logApiRequest({
    req,
    user,
    status: response.status,
    duration_ms: Date.now() - startedAt,
    error: errorMessage,
  });
  return response;
}

export function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function jsonOk<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
