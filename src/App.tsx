import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { useEffect, lazy, Suspense, type ReactNode } from 'react';
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
import PresentationsListPage from '@/pages/Presentations/PresentationsListPage';
import PresentationDetailPage from '@/pages/Presentations/PresentationDetailPage';
import SettingsPage from '@/pages/Settings/SettingsPage';
import TranslationSettingsPage from '@/pages/Settings/TranslationSettingsPage';
import ProfilesPage from '@/pages/Settings/ProfilesPage';
import RolesPage from '@/pages/Settings/RolesPage';
import UsersPage from '@/pages/Settings/UsersPage';
import MenuArrangementPage from '@/pages/Settings/MenuArrangementPage';
import WebhookSlugsPage from '@/pages/Settings/WebhookSlugsPage';
import WhatsAppNumbersPage from '@/pages/Settings/WhatsAppNumbersPage';
import ChatsSplitPage from '@/pages/Chats/ChatsSplitPage';
import ChatTemplateFormPage from '@/pages/Chats/ChatTemplateFormPage';
import AiAgentPage from '@/pages/AiAgent/AiAgentPage';
import RequireAdmin from '@/components/guards/RequireAdmin';
import Login from '@/pages/Login';
import ResetPassword from '@/pages/auth/ResetPassword';

// Lazy-loaded so tldraw's bundle + stylesheet are only fetched when the
// whiteboard route is visited. Keeps the main app bundle lean.
const WhiteboardListPage = lazy(() => import('@/pages/Whiteboard/WhiteboardListPage'));
const WhiteboardEditorPage = lazy(() => import('@/pages/Whiteboard/WhiteboardEditorPage'));

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

/**
 * Dispatcher for `/model/:modelName/:recordId`. The `chats` system model
 * needs a custom detail UI (message thread + composer) instead of the
 * generic record form, so we swap the rendered page by modelName. Keying
 * on recordId remounts the page when the URL flips between chats for
 * clean local-state resets (same rationale as RecordFormPageRoute).
 */
function RecordDetailDispatcher() {
  const { modelName, recordId } = useParams();
  if (modelName === 'chats') {
    // ChatsSplitPage reads :recordId itself from useParams — no need to
    // pass it. Not keyed on recordId: the split page stays mounted while
    // the user navigates between conversations so its global Realtime
    // subscription doesn't flap, and the right-pane swap is keyed
    // internally.
    return <ChatsSplitPage />;
  }
  if (modelName === 'ai_chats') {
    // AiAgentPage is a split-pane chat UI just like ChatsSplitPage — it
    // reads :recordId from useParams and handles its own right-pane
    // mount keying.
    return <AiAgentPage />;
  }
  if (modelName === 'chat_templates') {
    // Custom editor — generic record form doesn't handle the file upload
    // + preview flow well. Keyed on recordId so prev/next nav across
    // templates cleanly resets the form's local state.
    return <ChatTemplateFormPage key={recordId ?? 'new'} />;
  }
  return <RecordFormPageRoute />;
}

/**
 * Dispatcher for `/model/:modelName/new`. Generic create uses RecordFormPage;
 * chat_templates swaps in the custom editor (same one used for edit).
 */
function RecordNewDispatcher() {
  const { modelName } = useParams();
  if (modelName === 'chat_templates') return <ChatTemplateFormPage key="new" />;
  return <RecordFormPage />;
}

/**
 * Dispatcher for `/model/:modelName`. The `chats` system model renders
 * as a purpose-built two-pane layout (list on the left, detail on the
 * right, updates live via a global Realtime subscription). Everything
 * else stays on the generic RecordListPage.
 */
function RecordListDispatcher() {
  const { modelName } = useParams();
  if (modelName === 'chats') {
    return <ChatsSplitPage />;
  }
  if (modelName === 'ai_chats') {
    return <AiAgentPage />;
  }
  return <RecordListPage />;
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
          <Route path="/model/:modelName" element={<RecordListDispatcher />} />
          <Route path="/model/:modelName/new" element={<RecordNewDispatcher />} />
          <Route path="/model/:modelName/:recordId" element={<RecordDetailDispatcher />} />
          <Route path="/builder" element={<RequireAdmin><ModelBuilderPage /></RequireAdmin>} />
          <Route path="/builder/:modelId" element={<RequireAdmin><ModelBuilderPage /></RequireAdmin>} />
          <Route path="/workflow" element={<RequireAdmin><WorkflowListPage /></RequireAdmin>} />
          <Route path="/workflow/logs" element={<RequireAdmin><WorkflowLogsPage /></RequireAdmin>} />
          <Route path="/workflow/logs/:runId" element={<RequireAdmin><WorkflowRunDetailPage /></RequireAdmin>} />
          <Route path="/workflow/:workflowId" element={<RequireAdmin><WorkflowEditorPage /></RequireAdmin>} />
          <Route path="/dashboards" element={<RequireAdmin><DashboardListPage /></RequireAdmin>} />
          <Route path="/dashboards/:dashboardId" element={<RequireAdmin><DashboardEditorPage /></RequireAdmin>} />
          <Route path="/presentations" element={<PresentationsListPage />} />
          <Route path="/presentations/:jobId" element={<PresentationDetailPage />} />
          <Route
            path="/whiteboard"
            element={
              <Suspense fallback={null}>
                <WhiteboardListPage />
              </Suspense>
            }
          />
          <Route
            path="/whiteboard/:boardId"
            element={
              <Suspense fallback={null}>
                <WhiteboardEditorPage />
              </Suspense>
            }
          />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/translations" element={<RequireAdmin><TranslationSettingsPage /></RequireAdmin>} />
          <Route path="/settings/profiles" element={<RequireAdmin><ProfilesPage /></RequireAdmin>} />
          <Route path="/settings/profiles/:profileId" element={<RequireAdmin><ProfilesPage /></RequireAdmin>} />
          <Route path="/settings/roles" element={<RequireAdmin><RolesPage /></RequireAdmin>} />
          <Route path="/settings/roles/:roleId" element={<RequireAdmin><RolesPage /></RequireAdmin>} />
          <Route path="/settings/users" element={<RequireAdmin><UsersPage /></RequireAdmin>} />
          <Route path="/settings/menu" element={<RequireAdmin><MenuArrangementPage /></RequireAdmin>} />
          <Route path="/settings/webhooks" element={<RequireAdmin><WebhookSlugsPage /></RequireAdmin>} />
          <Route path="/settings/whatsapp-numbers" element={<RequireAdmin><WhatsAppNumbersPage /></RequireAdmin>} />
        </Route>
      </Routes>
      <ToastContainer />
    </BrowserRouter>
  );
}
