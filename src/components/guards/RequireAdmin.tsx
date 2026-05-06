import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin } from '@/hooks/usePermission';
import { getCurrentAal, isAuthAvailable } from '@/lib/auth';

/**
 * Gate for admin-only routes.
 *
 * Three failure paths:
 *   1. Non-admin → redirect to `/` with an access-denied toast.
 *   2. Admin but session is aal1 (MFA not yet completed for this
 *      session) → redirect to `/auth/mfa-setup` carrying the original
 *      path in `location.state.from` so MfaSetup can return them after
 *      verification. MFA gating is skipped when auth isn't configured
 *      (local dev / offline mode).
 *   3. Admin + aal2 → render the children.
 *
 * Renders null while we're still resolving the AAL so we don't briefly
 * flash one path and then redirect.
 */
export default function RequireAdmin({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const location = useLocation();
  const initialized = useAppStore((s) => s.initialized);
  const addToast = useAppStore((s) => s.addToast);
  const isAdmin = useIsAdmin();
  const toastedRef = useRef(false);

  // null while the AAL is still resolving.
  const [aal, setAal] = useState<'aal1' | 'aal2' | 'skip' | null>(null);

  useEffect(() => {
    if (!initialized || !isAdmin) {
      setAal(null);
      return;
    }
    // No Supabase Auth means there's no AAL to enforce — local dev fallback.
    if (!isAuthAvailable()) {
      setAal('skip');
      return;
    }
    let cancelled = false;
    void (async () => {
      const result = await getCurrentAal();
      if (cancelled) return;
      setAal((result.currentLevel as 'aal1' | 'aal2' | null) ?? 'aal1');
    })();
    return () => {
      cancelled = true;
    };
  }, [initialized, isAdmin]);

  useEffect(() => {
    if (!initialized) return;
    if (isAdmin) return;
    if (toastedRef.current) return;
    toastedRef.current = true;
    addToast(t('access.access_denied'), 'error');
  }, [initialized, isAdmin, addToast, t]);

  if (!initialized) return null;
  if (!isAdmin) return <Navigate to="/" replace />;
  // Admin: wait for AAL probe to finish before deciding.
  if (aal === null) return null;
  if (aal === 'aal1') {
    // Don't bounce in a loop if we're already on the MFA setup page.
    if (location.pathname === '/auth/mfa-setup') return <>{children}</>;
    return <Navigate to="/auth/mfa-setup" state={{ from: location.pathname }} replace />;
  }
  return <>{children}</>;
}
