import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { useAppStore } from '@/stores/appStore';
import { isAuthAvailable } from '@/lib/auth';
import AppLayout from '@/components/layout/AppLayout';
import ToastContainer from '@/components/ui/Toast';
import HomePage from '@/pages/Home/HomePage';
import ModelBuilderPage from '@/pages/Builder/ModelBuilderPage';
import RecordListPage from '@/pages/Records/RecordListPage';
import RecordFormPage from '@/pages/Records/RecordFormPage';
import WorkflowListPage from '@/pages/Workflow/WorkflowListPage';
import WorkflowEditorPage from '@/pages/Workflow/WorkflowEditorPage';
import WorkflowLogsPage from '@/pages/Workflow/WorkflowLogsPage';
import WorkflowRunDetailPage from '@/pages/Workflow/WorkflowRunDetailPage';
import DashboardListPage from '@/pages/Dashboard/DashboardListPage';
import DashboardEditorPage from '@/pages/Dashboard/DashboardEditorPage';
import PublicDashboardPage from '@/pages/Dashboard/PublicDashboardPage';
import SettingsPage from '@/pages/Settings/SettingsPage';
import TranslationSettingsPage from '@/pages/Settings/TranslationSettingsPage';
import ProfilesPage from '@/pages/Settings/ProfilesPage';
import RolesPage from '@/pages/Settings/RolesPage';
import UsersPage from '@/pages/Settings/UsersPage';
import MenuArrangementPage from '@/pages/Settings/MenuArrangementPage';
import RequireAdmin from '@/components/guards/RequireAdmin';
import Login from '@/pages/Login';
import ResetPassword from '@/pages/auth/ResetPassword';

/**
 * Auth gate. Renders children only when:
 *   - the initial auth check has finished (`authReady`), AND
 *   - either auth is unavailable (local/dev mode) or a session exists.
 *
 * While the check is pending we render nothing — this is a one-time, <100ms
 * wait and avoids a flash of "logged out" before the cached Supabase session
 * is restored from localStorage.
 */
/**
 * Remounts `RecordFormPage` whenever the `:recordId` URL param changes.
 * The form stores heavy local state (formData, mirrorEdits, activeResearchViewId,
 * isDirty) that must reset cleanly when prev/next navigation jumps to another
 * record — keying on recordId gives us that remount for free, without
 * scattering resets across useEffects.
 */
function RecordFormPageRoute() {
  const { recordId } = useParams();
  return <RecordFormPage key={recordId ?? 'new'} />;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const authReady = useAppStore((s) => s.authReady);
  const authEmail = useAppStore((s) => s.authEmail);

  if (!authReady) return null;
  if (isAuthAvailable() && !authEmail) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  const initialize = useAppStore((s) => s.initialize);
  const bindAuth = useAppStore((s) => s.bindAuth);
  const language = useAppStore((s) => s.language);

  useEffect(() => {
    // bindAuth FIRST so initialize() sees the correct authEmail when resolving
    // the current user. Both are idempotent — safe on re-renders.
    void (async () => {
      await bindAuth();
      await initialize();
    })();
  }, [bindAuth, initialize]);

  useEffect(() => {
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = language;
  }, [language]);

  return (
    <BrowserRouter>
      <Routes>
        {/* ── Public routes (no auth required, no layout) ─────────────── */}
        <Route path="/login" element={<Login />} />
        <Route path="/auth/reset-password" element={<ResetPassword />} />
        <Route path="/public/dashboard/:token" element={<PublicDashboardPage />} />

        {/* ── Protected app routes (auth required, inside layout) ────── */}
        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<HomePage />} />
          <Route path="/model/:modelName" element={<RecordListPage />} />
          <Route path="/model/:modelName/new" element={<RecordFormPage />} />
          <Route path="/model/:modelName/:recordId" element={<RecordFormPageRoute />} />
          <Route path="/builder" element={<RequireAdmin><ModelBuilderPage /></RequireAdmin>} />
          <Route path="/builder/:modelId" element={<RequireAdmin><ModelBuilderPage /></RequireAdmin>} />
          <Route path="/workflow" element={<RequireAdmin><WorkflowListPage /></RequireAdmin>} />
          <Route path="/workflow/logs" element={<RequireAdmin><WorkflowLogsPage /></RequireAdmin>} />
          <Route path="/workflow/logs/:runId" element={<RequireAdmin><WorkflowRunDetailPage /></RequireAdmin>} />
          <Route path="/workflow/:workflowId" element={<RequireAdmin><WorkflowEditorPage /></RequireAdmin>} />
          <Route path="/dashboards" element={<RequireAdmin><DashboardListPage /></RequireAdmin>} />
          <Route path="/dashboards/:dashboardId" element={<RequireAdmin><DashboardEditorPage /></RequireAdmin>} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/translations" element={<RequireAdmin><TranslationSettingsPage /></RequireAdmin>} />
          <Route path="/settings/profiles" element={<RequireAdmin><ProfilesPage /></RequireAdmin>} />
          <Route path="/settings/profiles/:profileId" element={<RequireAdmin><ProfilesPage /></RequireAdmin>} />
          <Route path="/settings/roles" element={<RequireAdmin><RolesPage /></RequireAdmin>} />
          <Route path="/settings/roles/:roleId" element={<RequireAdmin><RolesPage /></RequireAdmin>} />
          <Route path="/settings/users" element={<RequireAdmin><UsersPage /></RequireAdmin>} />
          <Route path="/settings/menu" element={<RequireAdmin><MenuArrangementPage /></RequireAdmin>} />
        </Route>
      </Routes>
      <ToastContainer />
    </BrowserRouter>
  );
}
