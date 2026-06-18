import { useEffect, useRef, type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { useCanViewWorkflows } from '@/hooks/usePermission';

/**
 * Gate for read-only workflow surfaces (the run-history pages). Allows admins
 * AND profiles with `can_view_workflows` (see permissions.canViewWorkflows).
 * Mirrors RequirePageAccess — redirect home + toast, no MFA step. The Workflow
 * Builder/list/agent routes keep `RequireAdmin`; this is only for viewing run
 * history. RLS is the real gate; this is navigation UX.
 */
export default function RequireWorkflowView({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const initialized = useAppStore((s) => s.initialized);
  const addToast = useAppStore((s) => s.addToast);
  const allowed = useCanViewWorkflows();
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
