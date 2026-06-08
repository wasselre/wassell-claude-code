/**
 * Thin wrapper around Supabase Auth.
 *
 * Why a wrapper instead of calling `supabase.auth.*` directly from components:
 *   1. Central place to translate Supabase error codes to user-friendly messages.
 *   2. Gracefully degrades when Supabase is not configured (returns a helpful
 *      error instead of crashing — matches the rest of the app's localStorage-
 *      first philosophy).
 *   3. Gives the store one stable import to subscribe to auth changes.
 *
 * All functions return plain data — NEVER throw — so call sites can show
 * errors inline without wrapping everything in try/catch.
 */
import type { AuthError, Session } from '@supabase/supabase-js';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from './supabase';

export interface AuthResult {
  session: Session | null;
  error: string | null;
}

export interface AuthVoidResult {
  error: string | null;
}

const NOT_CONFIGURED_ERR =
  'Authentication is not configured for this environment. Contact your administrator.';

/** Sign in with email + password. Returns the session on success. */
export async function signIn(email: string, password: string): Promise<AuthResult> {
  if (!supabase) return { session: null, error: NOT_CONFIGURED_ERR };
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  return {
    session: data.session,
    error: error ? mapAuthError(error) : null,
  };
}

/** Sign out the current user. Clears the Supabase session from localStorage too. */
export async function signOut(): Promise<AuthVoidResult> {
  if (!supabase) return { error: null };
  const { error } = await supabase.auth.signOut();
  return { error: error ? mapAuthError(error) : null };
}

/** Get the current session without making a network round-trip (reads cache). */
export async function getSession(): Promise<Session | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

/**
 * Send a password reset email. `redirectTo` is where the user lands after
 * clicking the link — must be whitelisted in Supabase Auth settings.
 */
export async function sendPasswordResetEmail(
  email: string,
  redirectTo?: string,
): Promise<AuthVoidResult> {
  if (!supabase) return { error: NOT_CONFIGURED_ERR };
  const target = redirectTo ?? `${window.location.origin}/auth/reset-password`;
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: target });
  return { error: error ? mapAuthError(error) : null };
}

/**
 * Send an invite / sign-in link via the `invite-user` Edge Function.
 *
 * The Edge Function uses the service-role key to call
 * `auth.admin.inviteUserByEmail`, which works regardless of the project's
 * "Allow new sign-ups" setting. This means project-level sign-ups can be
 * (and SHOULD be) turned OFF: the only way to create an account is via an
 * admin clicking "invite" in `/settings/users`.
 *
 * The function verifies the caller is an admin before issuing the invite,
 * so a non-admin user calling it directly gets a 403.
 *
 * Re-sending is harmless — Supabase issues a fresh link each time (subject
 * to per-email rate limits). The invitee lands on `/auth/reset-password`
 * after clicking the link so they can set a password.
 */
export async function inviteUser(
  email: string,
  redirectTo?: string,
): Promise<AuthVoidResult> {
  if (!supabase) return { error: NOT_CONFIGURED_ERR };
  const target = redirectTo ?? `${window.location.origin}/auth/reset-password`;
  // Get the active session so we can forward the JWT to the Edge Function.
  const session = await getSession();
  if (!session?.access_token) {
    return { error: 'You must be signed in to invite users.' };
  }
  try {
    const { data, error } = await supabase.functions.invoke('invite-user', {
      body: { email, redirect_to: target },
    });
    // When the function returns a non-2xx status, supabase-js puts a
    // FunctionsHttpError in `error` whose `.message` is the useless
    // "Edge Function returned a non-2xx status code" and leaves `data` null —
    // the real reason ({ ok:false, error }) is in the response body. Read it
    // out so the caller sees "...already been registered" / "rate limit"
    // instead of the generic string. (Same pattern as readFunctionError in
    // projectDetailsAi.ts.)
    if (error) return { error: await readEdgeFunctionError(error) };
    if (data && (data as { ok?: boolean }).ok === false) {
      return { error: mapEdgeFunctionError((data as { error?: string }).error ?? 'Invite failed.') };
    }
    return { error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}

/**
 * Pull the real error out of a failed `invite-user` / `delete-user`
 * invocation. supabase-js surfaces a non-2xx response as a FunctionsHttpError
 * whose `.message` is the generic "Edge Function returned a non-2xx status
 * code"; the actionable reason lives in the JSON body ({ ok:false, error }).
 */
async function readEdgeFunctionError(error: unknown): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.json();
      const real = (body as { error?: string } | null)?.error;
      if (real) return mapEdgeFunctionError(real);
    } catch {
      // Body wasn't JSON (e.g. a gateway 5xx). Fall through to the message below.
    }
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Turn raw GoTrue errors into clear, action-oriented messages. The ones we
 * actually hit: re-inviting an account that already exists (email_exists) and
 * Supabase's per-hour email cap. Shared by inviteUser + deleteAuthUser.
 */
function mapEdgeFunctionError(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes('already been registered') || m.includes('email_exists')) {
    return 'This email already has an account — no invite needed. If they are locked out, use "Send password reset" instead.';
  }
  if (m.includes('rate limit') || m.includes('for security purposes')) {
    return 'Too many emails were sent in a short window. Wait a minute and try again, or raise the cap in Supabase Auth → Rate Limits.';
  }
  return raw;
}

/**
 * Delete a user's Supabase Auth identity (the `auth.users` row) via the
 * `delete-user` Edge Function.
 *
 * The app's "Delete user" only removes the app-level `public.users` row; the
 * browser can't delete the Auth identity (that needs the service-role key).
 * Without this, the email stays registered in Supabase Auth and re-inviting it
 * later fails with `email_exists`. Call this right after removing the app row
 * so the email is freed for a future invite.
 *
 * Pass `authUid` (from `users.auth_uid`) when known — the function deletes it
 * directly. When it's null/unknown (e.g. an unbound row) the function resolves
 * the identity by email. Idempotent: deleting an already-gone identity returns
 * success.
 */
export async function deleteAuthUser(
  email: string,
  authUid?: string | null,
): Promise<AuthVoidResult> {
  if (!supabase) return { error: NOT_CONFIGURED_ERR };
  const session = await getSession();
  if (!session?.access_token) {
    return { error: 'You must be signed in to delete users.' };
  }
  try {
    const { data, error } = await supabase.functions.invoke('delete-user', {
      body: { email, auth_uid: authUid ?? null },
    });
    if (error) return { error: await readEdgeFunctionError(error) };
    if (data && (data as { ok?: boolean }).ok === false) {
      return { error: mapEdgeFunctionError((data as { error?: string }).error ?? 'Delete failed.') };
    }
    return { error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: msg };
  }
}

/** Update the current user's password. Only valid while a recovery session is active. */
export async function updatePassword(newPassword: string): Promise<AuthVoidResult> {
  if (!supabase) return { error: NOT_CONFIGURED_ERR };
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  return { error: error ? mapAuthError(error) : null };
}

/**
 * Subscribe to auth state changes (sign-in, sign-out, token refresh, password-
 * recovery links). Returns an unsubscribe function — always call it on cleanup.
 */
export function onAuthChange(
  callback: (session: Session | null) => void,
): () => void {
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
  return () => data.subscription.unsubscribe();
}

/** Extract the user's email from a session, or null if none. */
export function getSessionEmail(session: Session | null): string | null {
  return session?.user?.email ?? null;
}

/**
 * Extract the Supabase Auth user id (`auth.users.id`) from a session, or null
 * if none. Threaded into the store as `authUid` and persisted to
 * `users.auth_uid` on first sign-in. RLS policies key off this column.
 */
export function getSessionUid(session: Session | null): string | null {
  return session?.user?.id ?? null;
}

/** Whether Supabase Auth is usable in this environment. */
export function isAuthAvailable(): boolean {
  return supabase !== null;
}

// ────────────────────────────────────────────────────────────────────
// MFA (TOTP). Required for is_admin profiles per Phase 2 of the user-
// management plan. The Supabase project must have the TOTP factor
// enabled in Auth → Providers → MFA for these to work; otherwise
// `enroll` returns "MFA not enabled".
//
// Lifecycle:
//   1. Admin signs in → currentAal = 'aal1'.
//   2. RequireAdmin route guard sees aal !== 'aal2' and redirects to
//      /auth/mfa-setup.
//   3. If the user has no factor: enrollTotpFactor() → user scans the
//      QR code → verifyMfaEnrollment(factorId, code) → factor is
//      verified, session is upgraded to aal2.
//   4. If the user has a factor but the session is aal1 (e.g. they
//      just signed in fresh): challengeMfa() → user enters code →
//      verifyMfa() → session is upgraded to aal2.
// ────────────────────────────────────────────────────────────────────

export interface AalResult {
  /** 'aal1' | 'aal2' | null when not signed in. */
  currentLevel: 'aal1' | 'aal2' | null;
  /** What the next sign-in step requires. Useful for UX gating. */
  nextLevel: 'aal1' | 'aal2' | null;
  error: string | null;
}

/** Read the current Authenticator Assurance Level. aal1 = password only;
 *  aal2 = password + at least one verified factor (TOTP). */
export async function getCurrentAal(): Promise<AalResult> {
  if (!supabase) return { currentLevel: null, nextLevel: null, error: NOT_CONFIGURED_ERR };
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) return { currentLevel: null, nextLevel: null, error: mapAuthError(error) };
  return {
    currentLevel: (data?.currentLevel as 'aal1' | 'aal2' | null) ?? null,
    nextLevel: (data?.nextLevel as 'aal1' | 'aal2' | null) ?? null,
    error: null,
  };
}

export interface MfaFactor {
  id: string;
  friendly_name?: string | null;
  factor_type: 'totp' | 'phone';
  status: 'verified' | 'unverified';
}

/** List the user's verified + unverified MFA factors. */
export async function listMfaFactors(): Promise<{ factors: MfaFactor[]; error: string | null }> {
  if (!supabase) return { factors: [], error: NOT_CONFIGURED_ERR };
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) return { factors: [], error: mapAuthError(error) };
  // The API returns `totp` and `phone` arrays separately; flatten so callers
  // can iterate without caring about factor type.
  const totp = (data?.totp ?? []).map((f) => ({
    id: f.id,
    friendly_name: f.friendly_name ?? null,
    factor_type: 'totp' as const,
    status: f.status as 'verified' | 'unverified',
  }));
  return { factors: totp, error: null };
}

export interface EnrollTotpResult {
  factorId: string | null;
  /** Data URI for a QR code the user can scan in their authenticator app. */
  qrCode: string | null;
  /** Plain-text secret as a fallback when the QR can't be scanned. */
  secret: string | null;
  error: string | null;
}

/** Start TOTP enrollment. Returns the factor id + QR code; the user must
 *  scan it AND submit a code via `verifyMfaEnrollment` to complete. */
export async function enrollTotpFactor(friendlyName = 'Authenticator'): Promise<EnrollTotpResult> {
  if (!supabase) {
    return { factorId: null, qrCode: null, secret: null, error: NOT_CONFIGURED_ERR };
  }
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName,
  });
  if (error) {
    return { factorId: null, qrCode: null, secret: null, error: mapAuthError(error) };
  }
  return {
    factorId: data.id,
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
    error: null,
  };
}

/** Verify a freshly-enrolled factor with the first 6-digit code from the
 *  authenticator app. On success the session is automatically upgraded
 *  to aal2. */
export async function verifyMfaEnrollment(
  factorId: string,
  code: string,
): Promise<AuthVoidResult> {
  if (!supabase) return { error: NOT_CONFIGURED_ERR };
  const challenge = await supabase.auth.mfa.challenge({ factorId });
  if (challenge.error) return { error: mapAuthError(challenge.error) };
  const verify = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.data.id,
    code,
  });
  if (verify.error) return { error: mapAuthError(verify.error) };
  return { error: null };
}

/** Same as verifyMfaEnrollment but used for the routine sign-in flow when
 *  the factor already exists (challenge an existing factor). */
export async function challengeAndVerifyMfa(
  factorId: string,
  code: string,
): Promise<AuthVoidResult> {
  return verifyMfaEnrollment(factorId, code);
}

/** Remove a factor. Used by the self-service /profile page. */
export async function unenrollMfaFactor(factorId: string): Promise<AuthVoidResult> {
  if (!supabase) return { error: NOT_CONFIGURED_ERR };
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  return { error: error ? mapAuthError(error) : null };
}

// ────────────────────────────────────────────────────────────────────
// Error mapping — keeps Supabase's wire-format messages out of the UI.
// ────────────────────────────────────────────────────────────────────
function mapAuthError(err: AuthError | Error): string {
  const msg = (err.message ?? '').trim();
  if (!msg) return 'Unknown authentication error.';
  const lower = msg.toLowerCase();
  if (lower.includes('invalid login') || lower.includes('invalid credentials')) {
    return 'Invalid email or password.';
  }
  if (lower.includes('email not confirmed')) {
    return 'Please confirm your email before signing in.';
  }
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return 'Too many attempts. Please wait a minute and try again.';
  }
  if (lower.includes('user not found')) {
    return 'No account exists with that email.';
  }
  if (lower.includes('password') && (lower.includes('short') || lower.includes('weak'))) {
    return 'Password must be at least 12 characters.';
  }
  return msg;
}

/**
 * Minimum password length enforced on the client. Mirrors the project-level
 * Supabase setting (Auth → Password requirements). The Login + ResetPassword
 * pages use this for inline validation; the Edge Function / Supabase server
 * is the source of truth on enforcement.
 */
export const MIN_PASSWORD_LENGTH = 12;
