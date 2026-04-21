import { useEffect, useRef, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin } from '@/hooks/usePermission';

/**
 * Gate for admin-only routes. Non-admins are redirected to `/` with an
 * access-denied toast. Renders null before the store is initialized so we
 * don't briefly redirect and then re-render.
 */
export default function RequireAdmin({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const initialized = useAppStore((s) => s.initialized);
  const addToast = useAppStore((s) => s.addToast);
  const isAdmin = useIsAdmin();
  const toastedRef = useRef(false);

  useEffect(() => {
    if (!initialized) return;
    if (isAdmin) return;
    if (toastedRef.current) return;
    toastedRef.current = true;
    addToast(t('access.access_denied'), 'error');
  }, [initialized, isAdmin, addToast, t]);

  if (!initialized) return null;
  if (!isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}
