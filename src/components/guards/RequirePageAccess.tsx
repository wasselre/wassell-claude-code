import { useEffect, useRef, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { useCanAccessPage } from '@/hooks/usePermission';

/**
 * Gate for custom (non-model) pages whose access is controlled per-profile
 * via `profile.page_access` (see `src/lib/customPages.ts`).
 *
 * Mirrors `RequireAdmin`'s shape MINUS the AAL/MFA step: these are
 * operational surfaces meant to be grantable to non-admin sales staff, who
 * may legitimately be at aal1 — forcing MFA setup here would lock them out.
 * The genuinely sensitive config routes (builder, workflows, settings) keep
 * `RequireAdmin` and its MFA gate. Server-side RLS is unaffected; this is a
 * navigation/UX gate only.
 *
 * Not allowed → access-denied toast + redirect home. Renders null until the
 * store has initialized so we don't flash one path then redirect.
 */
export default function RequirePageAccess({
  pageId,
  children,
}: {
  pageId: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const initialized = useAppStore((s) => s.initialized);
  const addToast = useAppStore((s) => s.addToast);
  const allowed = useCanAccessPage(pageId);
  const toastedRef = useRef(false);

  useEffect(() => {
    if (!initialized) return;
    if (allowed) return;
    if (toastedRef.current) return;
    toastedRef.current = true;
    addToast(t('access.access_denied'), 'error');
  }, [initialized, allowed, addToast, t]);

  if (!initialized) return null;
  if (!allowed) return <Navigate to="/" replace />;
  return <>{children}</>;
}
