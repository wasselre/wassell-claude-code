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
 * Send an invite / sign-in link. Used by the admin "Add user" flow:
 * after creating the in-app `users` row, we email the invitee a magic
 * link. Clicking it creates the Supabase Auth account (if missing),
 * signs them in, and lands them on `/auth/reset-password` so they set
 * a password before entering the app. After that, every subsequent
 * sign-in uses email + password via the Login page.
 *
 * The password-setup page works off the session the magic-link click
 * establishes — `updateUser({ password })` accepts any active session,
 * not just a recovery one.
 *
 * Re-sending is harmless — Supabase sends a fresh link (subject to
 * its rate limits). Resending to a user who already has a password
 * still works as a passwordless sign-in; they can skip the setup page
 * or re-set the password.
 *
 * Requires the Supabase project's "Allow new users to sign up" setting
 * to be enabled; otherwise the call fails with "Signups not allowed".
 */
export async function inviteUser(
  email: string,
  redirectTo?: string,
): Promise<AuthVoidResult> {
  if (!supabase) return { error: NOT_CONFIGURED_ERR };
  const target = redirectTo ?? `${window.location.origin}/auth/reset-password`;
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true, emailRedirectTo: target },
  });
  return { error: error ? mapAuthError(error) : null };
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
  if (lower.includes('password') && lower.includes('short')) {
    return 'Password must be at least 6 characters.';
  }
  return msg;
}
