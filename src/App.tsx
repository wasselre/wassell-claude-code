import { BrowserRouter, Routes, Route, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useEffect, lazy, Suspense, type ReactNode } from 'react';
import { useAppStore } from '@/stores/appStore';
import { isAuthAvailable } from '@/lib/auth';
import AppLayout from '@/components/layout/AppLayout';
import ToastContainer from '@/components/ui/Toast';
import UpdateBanner from '@/components/UpdateBanner';
const HomePage = lazy(() => import('@/pages/Home/HomePage'));
const ModelBuilderPage = lazy(() => import('@/pages/Builder/ModelBuilderPage'));
const BuilderAgentPage = lazy(() => import('@/pages/Builder/BuilderAgentPage'));
const RecordListPage = lazy(() => import('@/pages/Records/RecordListPage'));
const RecordFormPage = lazy(() => import('@/pages/Records/RecordFormPage'));
const WorkflowListPage = lazy(() => import('@/pages/Workflow/WorkflowListPage'));
const WorkflowEditorPage = lazy(() => import('@/pages/Workflow/WorkflowEditorPage'));
const WorkflowAgentPage = lazy(() => import('@/pages/Workflow/WorkflowAgentPage'));
const WorkflowLogsPage = lazy(() => import('@/pages/Workflow/WorkflowLogsPage'));
const WorkflowRunDetailPage = lazy(() => import('@/pages/Workflow/WorkflowRunDetailPage'));
const DashboardListPage = lazy(() => import('@/pages/Dashboard/DashboardListPage'));
const DashboardEditorPage = lazy(() => import('@/pages/Dashboard/DashboardEditorPage'));
const ScheduledReportsPage = lazy(() => import('@/pages/Dashboard/ScheduledReportsPage'));
const PublicDashboardPage = lazy(() => import('@/pages/Dashboard/PublicDashboardPage'));
const SettingsPage = lazy(() => import('@/pages/Settings/SettingsPage'));
const LogsPage = lazy(() => import('@/pages/Logs/LogsPage'));
const TranslationSettingsPage = lazy(() => import('@/pages/Settings/TranslationSettingsPage'));
const ProfilesPage = lazy(() => import('@/pages/Settings/ProfilesPage'));
const RolesPage = lazy(() => import('@/pages/Settings/RolesPage'));
const UsersPage = lazy(() => import('@/pages/Settings/UsersPage'));
const AuditLogPage = lazy(() => import('@/pages/Settings/AuditLogPage'));
const GeoElementsPage = lazy(() => import('@/pages/Settings/GeoElementsPage'));
const MarketingOpsPage = lazy(() => import('@/pages/Settings/MarketingOpsPage'));
const ContentIntelligencePage = lazy(() => import('@/pages/Settings/ContentIntelligencePage'));
const MarketingAdvertisersPage = lazy(() => import('@/pages/Settings/MarketingAdvertisersPage'));
const ProfilePage = lazy(() => import('@/pages/ProfilePage'));
const MenuArrangementPage = lazy(() => import('@/pages/Settings/MenuArrangementPage'));
const WebhookSlugsPage = lazy(() => import('@/pages/Settings/WebhookSlugsPage'));
const WhatsAppNumbersPage = lazy(() => import('@/pages/Settings/WhatsAppNumbersPage'));
const WhatsAppAiPage = lazy(() => import('@/pages/Settings/WhatsAppAiPage'));
const WhatsAppPermissionsPage = lazy(() => import('@/pages/Settings/WhatsAppPermissionsPage'));
const DocumentTemplatesPage = lazy(() => import('@/pages/DocumentTemplates/DocumentTemplatesPage'));
const WebsiteSettingsPage = lazy(() => import('@/pages/Settings/WebsiteSettingsPage'));
const ProjectDetailsListPage = lazy(() => import('@/pages/Settings/ProjectDetailsListPage'));
const ProjectDetailsBridgePage = lazy(() => import('@/pages/Settings/ProjectDetailsBridgePage'));
const ChatsSplitPage = lazy(() => import('@/pages/Chats/ChatsSplitPage'));
const ChatTemplateFormPage = lazy(() => import('@/pages/Chats/ChatTemplateFormPage'));
import RetiredAssistantNotice from '@/components/RetiredAssistantNotice';
import { isRetiredModel } from '@/lib/featureFlags';
import { useDeepLinkRecordPending } from '@/hooks/useDeepLinkRecord';
import { Loader2 } from 'lucide-react';
const FollowUpWorkspacePage = lazy(() => import('@/pages/Followups/FollowUpWorkspacePage'));
const SuggestedProjectsPage = lazy(() => import('@/pages/Followups/SuggestedProjectsPage'));
const ClientProjectsPage = lazy(() => import('@/pages/Clients/ClientProjectsPage'));
const ProjectsListPage = lazy(() => import('@/pages/Projects/ProjectsListPage'));
const ProjectDetailPage = lazy(() => import('@/pages/Projects/ProjectDetailPage'));
const ClientsListPage = lazy(() => import('@/pages/Clients/ClientsListPage'));
const ClientDetailPage = lazy(() => import('@/pages/Clients/ClientDetailPage'));
const OurProjectsPortfolioPage = lazy(() => import('@/pages/Projects/OurProjectsPortfolioPage'));
const SalesValuationReviewPage = lazy(() => import('@/pages/SalesValuation/ReviewDetailPage'));
const SalesValuationQueuePage = lazy(() => import('@/pages/SalesValuation/QueuePage'));
const SalesValuationBoardPage = lazy(() => import('@/pages/SalesValuation/CorrectionBoardPage'));
const SalesValuationCorrectionDetailPage = lazy(() => import('@/pages/SalesValuation/CorrectionDetailPage'));
const SalesValuationCoachingPage = lazy(() => import('@/pages/SalesValuation/CoachingPage'));
const SalesValuationCategoriesPage = lazy(() => import('@/pages/SalesValuation/CategoriesPage'));
const SalesValuationSettingsPage = lazy(() => import('@/pages/SalesValuation/SettingsPage'));
const SalesTasksPage = lazy(() => import('@/pages/Sales/SalesTasksPage'));
const MyClientsPage = lazy(() => import('@/pages/Sales/MyClientsPage'));
const MyTasksPage = lazy(() => import('@/pages/Sales/MyTasksPage'));
const SalesProcessStudioPage = lazy(() => import('@/pages/SalesProcess/SalesProcessStudioPage'));
const SalesManagerPage = lazy(() => import('@/pages/Sales/SalesManagerPage'));
const MarketIntelligencePage = lazy(() => import('@/pages/MarketIntelligence/MarketIntelligencePage'));
const MarketAutomationPage = lazy(() => import('@/pages/MarketAutomation/MarketAutomationPage'));
const MarketingIntelligencePage = lazy(() => import('@/pages/MarketingIntelligence/MarketingIntelligencePage'));
// ── The Marketing WORKSPACE ────────────────────────────────────────────
// A second workspace, not a page inside the Sales one: it mounts OUTSIDE
// AppLayout with its own shell, rail and visual system, under /m. The switcher
// in each shell's header is how you move between the two.
import MarketingWorkspace, { RequireMarketingWorkspace } from '@/pages/Marketing/MarketingWorkspace';
const MarketingOverviewPage = lazy(() => import('@/pages/Marketing/OverviewPage'));
const MarketingWorkPage = lazy(() => import('@/pages/Marketing/WorkPage'));
const MarketingTeamPage = lazy(() => import('@/pages/Marketing/TeamPage'));
const MarketingAssetDetailPage = lazy(() => import('@/pages/Marketing/AssetDetailPage'));
const MarketingShootRequestPage = lazy(() => import('@/pages/Marketing/ShootRequestPage'));
const MarketingLibraryUnusedPage = lazy(() => import('@/pages/Marketing/LibraryUnusedPage'));
const MarketingAccountPage = lazy(() => import('@/pages/Marketing/AccountPage'));
const MarketingContentListPage = lazy(() => import('@/pages/Marketing/ContentListPage'));
const MarketingSearchPage = lazy(() => import('@/pages/Marketing/SearchPage'));
const MarketingContentDetailPage = lazy(() => import('@/pages/Marketing/ContentDetailPage'));
const MarketingCalendarPage = lazy(() => import('@/pages/Marketing/CalendarPage'));
const MarketingCampaignsPage = lazy(() => import('@/pages/Marketing/CampaignsPage'));
const MarketingGoalsPage = lazy(() => import('@/pages/Marketing/GoalsPage'));
const MarketingCampaignDetailPage = lazy(() => import('@/pages/Marketing/CampaignDetailPage'));
const MarketingExecutionDetailPage = lazy(() => import('@/pages/Marketing/ExecutionDetailPage'));
const MarketingUploadPage = lazy(() => import('@/pages/Marketing/UploadPage'));
const MarketingShootsPage = lazy(() => import('@/pages/Marketing/ShootsPage'));
const MarketingNumbersPage = lazy(() => import('@/pages/Marketing/NumbersPage'));
const MarketingOrganicPulsePage = lazy(() => import('@/pages/Marketing/OrganicPulsePage'));
const MarketingPublishingBoardPage = lazy(() => import('@/pages/Marketing/PublishingBoardPage'));
import MarketingSettingsPage, { SettingsSectionPage } from '@/pages/Marketing/SettingsPage';
const ProjectFinderPage = lazy(() => import('@/pages/ProjectFinder/ProjectFinderPage'));
const FinancingPage = lazy(() => import('@/pages/Financing/FinancingPage'));
const PostsContentPage = lazy(() => import('@/pages/PostsContent/PostsContentPage'));
const SalesStudioHomePage = lazy(() => import('@/pages/SalesStudio/SalesStudioHomePage'));
const ProcessJourneyPage = lazy(() => import('@/pages/SalesStudio/ProcessJourneyPage'));
const ExperimentsPage = lazy(() => import('@/pages/SalesStudio/ExperimentsPage'));
const ExperimentDetailPage = lazy(() => import('@/pages/SalesStudio/ExperimentDetailPage'));
const FilesPage = lazy(() => import('@/pages/Files/FilesPage'));
const FilesRoot = lazy(() => import('@/pages/Files/FilesRoot'));
const FilesAiReviewPage = lazy(() => import('@/pages/Files/FilesAiReviewPage'));
const FilesLibraryPage = lazy(() => import('@/pages/Files/FilesLibraryPage'));
const DocumentEditorPage = lazy(() => import('@/pages/Documents/DocumentEditorPage'));
const PublicShareFilePage = lazy(() => import('@/pages/PublicShare/PublicShareFilePage'));
const RateVisitPage = lazy(() => import('@/pages/PublicRate/RateVisitPage'));
import RequireAdmin from '@/components/guards/RequireAdmin';
import RequirePageAccess from '@/components/guards/RequirePageAccess';
import RequireWorkflowView from '@/components/guards/RequireWorkflowView';
import Login from '@/pages/Login';
import ResetPassword from '@/pages/auth/ResetPassword';
import MfaSetup from '@/pages/auth/MfaSetup';

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
/** Boot-time loading state for a deep-linked record detail page. */
function RecordBootLoading() {
  const isAr = useAppStore((s) => s.language) === 'ar';
  return (
    <div className="flex h-[60vh] items-center justify-center gap-2 text-charcoal/50">
      <Loader2 size={18} className="animate-spin" />
      <span className="text-sm">{isAr ? 'جارٍ تحميل السجل…' : 'Loading record…'}</span>
    </div>
  );
}

/**
 * Phase 3 · B8 follow-up (2026-08-20) — the Marketing Library GRID is retired
 * in favour of the canonical Files Library.
 *
 * The marketing assets were already one shared `files` row each (B8), so this
 * changes only which UI you land in, not the data. The grid (LibraryPage.tsx)
 * is gone; `/m/library` now EMBEDS the unified Files Library — the same page
 * `/files` renders — but mounted INSIDE the Marketing shell so opening the
 * Asset library never ejects the user out of `/m` into another section. It is
 * passed `basePath="/m/library"` (so its URL state stays under /m) and
 * `defaultView="marketing"` (so it opens scoped to marketing intake). The
 * upload, "unused assets" and per-asset detail screens under /m/library/* are
 * KEPT and still match their own, more specific routes.
 */
function MarketingAssetLibrary() {
  return <FilesLibraryPage basePath="/m/library" defaultView="marketing" />;
}

function RecordDetailDispatcher() {
  const { modelName, recordId } = useParams();
  const [searchParams] = useSearchParams();
  // Deep-link fast path: on a hard load the records tail lands seconds after
  // first paint, so a directly-opened record page would flash "not found".
  // The hook fires a targeted single-row fetch (lands in ~one round-trip) and
  // tells us to show a loading state until the record is in the store (or the
  // tail finishes, for ids that genuinely don't exist). Hook stays ABOVE the
  // conditional returns (React #310 — see reference_followup_deeplink_hooks_crash).
  const recordPending = useDeepLinkRecordPending(modelName, recordId);
  // Retired assistants + archived modules — unwired (data preserved in DB).
  if (isRetiredModel(modelName)) return <RetiredAssistantNotice />;
  if (recordPending) return <RecordBootLoading />;
  if (modelName === 'followups' && searchParams.get('generic') !== '1') {
    // Custom guided "Follow-up Workspace" replaces the generic form. The
    // generic form stays reachable for advanced editing via ?generic=1 (the
    // workspace's "Advanced Fields" / "Edit Full Preferences" escape hatch).
    return <FollowUpWorkspacePage key={recordId ?? 'new'} />;
  }
  if (modelName === 'clients' && recordId !== 'new') {
    // Custom Client 360 cockpit replaces the generic form. ClientDetailPage
    // handles the ?generic=1 escape hatch itself (generic form + a
    // back-to-workspace bar) — the header's "Advanced view" button sets it.
    // New-record create stays on the generic form (RecordNewDispatcher).
    return <ClientDetailPage key={recordId ?? 'new'} />;
  }
  if (modelName === 'sales_valuation_reviews' && searchParams.get('generic') !== '1') {
    // Custom manager review screen replaces the generic form — a clean
    // decision interface (summary + evidence modals + progressive decision
    // panel). The generic form stays reachable via ?generic=1 for admin edits.
    return <SalesValuationReviewPage key={recordId ?? 'new'} />;
  }
  if (modelName === 'sales_correction_tasks' && searchParams.get('generic') !== '1') {
    // Custom correction-task detail (context / action / rep response / manager
    // approval). Generic form stays reachable via ?generic=1.
    return <SalesValuationCorrectionDetailPage key={recordId ?? 'new'} />;
  }
  if (modelName === 'chats') {
    // ChatsSplitPage reads :recordId itself from useParams — no need to
    // pass it. Not keyed on recordId: the split page stays mounted while
    // the user navigates between conversations so its global Realtime
    // subscription doesn't flap, and the right-pane swap is keyed
    // internally.
    return <ChatsSplitPage />;
  }
  if (modelName === 'chat_templates') {
    // Custom editor — generic record form doesn't handle the file upload
    // + preview flow well. Keyed on recordId so prev/next nav across
    // templates cleanly resets the form's local state.
    return <ChatTemplateFormPage key={recordId ?? 'new'} />;
  }
  if ((modelName === 'all_projects' || modelName === 'our_projects') && recordId !== 'new') {
    // Custom Project detail (hero + KPIs + 7 tabs). Drives from the all_projects
    // master directly, or — for our_projects — from the linked master plus the
    // portfolio sales layer. Falls back to the generic form when ?generic=1
    // (its "Edit" action). New-record create stays on the generic form.
    return <ProjectDetailPage key={`${modelName}:${recordId}`} />;
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
  // Retired assistants + archived modules — unwired (data preserved in DB).
  if (isRetiredModel(modelName)) return <RetiredAssistantNotice />;
  if (modelName === 'chats') {
    return <ChatsSplitPage />;
  }
  if (modelName === 'clients') {
    // Custom Clients cockpit (KPIs + filters + sales-prioritized list). Falls
    // back to the generic table/export view when ?generic=1.
    return <ClientsListPage />;
  }
  if (modelName === 'all_projects') {
    // Custom Projects experience (KPIs + filters + cards/list/map). The page
    // itself falls back to the generic table/export view when ?generic=1.
    return <ProjectsListPage />;
  }
  if (modelName === 'our_projects') {
    // Curated sales portfolio dashboard over all_projects. Falls back to the
    // generic list when ?generic=1.
    return <OurProjectsPortfolioPage />;
  }
  // Singleton-config models — the list view is meaningless (always exactly
  // one record) and confusing (looks like a normal model, but isn't). Punt
  // straight to /settings/website which then opens the singleton's edit form.
  // Belt-and-suspenders alongside the Sidebar `SETTINGS_ONLY_MODEL_NAMES`
  // filter — covers direct URL hits, old bookmarks, and shared links.
  if (modelName === 'site_settings') {
    return <Navigate to="/settings/website" replace />;
  }
  // project_details list view is meaningless on its own — the records are
  // sidecars of all_projects, so picking by project is what makes sense.
  // Punt to the project picker (Settings card entry point).
  if (modelName === 'project_details') {
    return <Navigate to="/settings/project-details" replace />;
  }
  // Sales Valuation operation — each model in the تقييم المبيعات group renders a
  // purpose-built operational screen instead of the generic record list.
  if (modelName === 'sales_valuation_reviews') return <SalesValuationQueuePage />;
  if (modelName === 'sales_correction_tasks') return <SalesValuationBoardPage />;
  if (modelName === 'sales_rep_daily_valuations') return <SalesValuationCoachingPage />;
  if (modelName === 'sales_mistake_categories') return <SalesValuationCategoriesPage />;
  if (modelName === 'sales_valuation_settings') return <SalesValuationSettingsPage />;
  return <RecordListPage />;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const authReady = useAppStore((s) => s.authReady);
  const authEmail = useAppStore((s) => s.authEmail);

  // Show a spinner (not a blank screen) while the session restores — otherwise a
  // cold launch from a push notification renders NOTHING until auth is ready,
  // which reads as "the app opened to a blank page".
  if (!authReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-cream-light">
        <Loader2 size={26} className="animate-spin text-copper" />
      </div>
    );
  }
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
      {/* Outer boundary for the lazy PUBLIC routes (share / rate / public
          dashboard). Authenticated pages resolve at AppLayout's own inner
          Suspense (which keeps the shell), so this only shows for the handful
          of no-layout public pages. */}
      <Suspense
        fallback={
          <div className="min-h-screen flex items-center justify-center bg-cream-light">
            <Loader2 size={24} className="animate-spin text-copper" />
          </div>
        }
      >
      <Routes>
        {/* ── Public routes (no auth required, no layout) ─────────────── */}
        <Route path="/login" element={<Login />} />
        <Route path="/auth/reset-password" element={<ResetPassword />} />
        <Route path="/auth/mfa-setup" element={<MfaSetup />} />
        <Route path="/public/dashboard/:token" element={<PublicDashboardPage />} />
        <Route path="/share/:token" element={<PublicShareFilePage />} />
        <Route path="/rate/:token" element={<RateVisitPage />} />

        {/* ── Protected app routes (auth required, inside layout) ────── */}
        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<HomePage />} />
          {/* Phase 3 · B5. /files is the Business Files Library when the flag
              is on and the folder-first page when it is off — FilesRoot is the
              whole of that switch, and the batch's rollback boundary. */}
          <Route path="/files" element={<FilesRoot />} />
          <Route path="/files/shared" element={<FilesPage forceShared />} />
          {/* Document editor — full-page, lives at /files/doc/:fileId so the
              breadcrumb back-arrow stays inside the Files hierarchy. Must
              come BEFORE /files/:folderId so the literal "doc" segment
              doesn't get matched as a folder id. */}
          <Route path="/files/doc/:fileId" element={<DocumentEditorPage />} />
          {/* AI review queue — a literal segment, so it must precede
              /files/:folderId. Its own page, always available (the Library
              flag is on for everyone). */}
          <Route path="/files/ai-review" element={<FilesAiReviewPage />} />
          {/* Legacy folders root. Also a literal segment, so it must precede
              /files/:folderId — otherwise "folders" is read as a folder id. */}
          <Route path="/files/folders" element={<FilesPage />} />
          {/* Unchanged, so every existing /files/<uuid> deep link — bookmarks,
              links pasted in WhatsApp, the breadcrumb — keeps working. */}
          <Route path="/files/:folderId" element={<FilesPage />} />
          {/* Sales Operations pages — per-profile access via profile.page_access
              (see src/lib/customPages.ts). Defaults preserve prior behavior:
              tasks = open to all, process + manager = admin-only by default,
              but each is now grantable/revocable per profile in Settings. */}
          {/* Sales Rep workspace — profile-assignable simplified surfaces
              (my_clients / my_tasks). Opt-in via Settings → Profiles. */}
          <Route path="/sales/my-clients" element={<RequirePageAccess pageId="my_clients"><MyClientsPage /></RequirePageAccess>} />
          <Route path="/sales/my-tasks" element={<RequirePageAccess pageId="my_tasks"><MyTasksPage /></RequirePageAccess>} />
          <Route path="/sales/tasks" element={<RequirePageAccess pageId="sales_tasks"><SalesTasksPage /></RequirePageAccess>} />
          {/* Sales Studio 2.0 — strategy layer (process library → journey, experiments).
              Sub-routes share the sales_studio page-access gate. */}
          <Route path="/sales/studio" element={<RequirePageAccess pageId="sales_studio"><SalesStudioHomePage /></RequirePageAccess>} />
          <Route path="/sales/studio/experiments" element={<RequirePageAccess pageId="sales_studio"><ExperimentsPage /></RequirePageAccess>} />
          <Route path="/sales/studio/experiments/:experimentId" element={<RequirePageAccess pageId="sales_studio"><ExperimentDetailPage /></RequirePageAccess>} />
          <Route path="/sales/studio/processes/:processId" element={<RequirePageAccess pageId="sales_studio"><ProcessJourneyPage /></RequirePageAccess>} />
          <Route path="/sales/process" element={<RequirePageAccess pageId="sales_process"><SalesProcessStudioPage /></RequirePageAccess>} />
          <Route path="/sales/manager" element={<RequirePageAccess pageId="sales_manager"><SalesManagerPage /></RequirePageAccess>} />
          <Route path="/market-intelligence" element={<RequirePageAccess pageId="market_intelligence"><MarketIntelligencePage /></RequirePageAccess>} />
          <Route path="/market-automation" element={<RequirePageAccess pageId="market_automation"><MarketAutomationPage /></RequirePageAccess>} />
          <Route path="/marketing-intelligence" element={<RequirePageAccess pageId="marketing_intelligence"><MarketingIntelligencePage /></RequirePageAccess>} />
          {/* The old in-Sales marketing page is gone. Anyone with a bookmark
              (or a profile whose sidebar still points here) lands in the new
              workspace instead of on a blank route. */}
          <Route path="/marketing-management" element={<Navigate to="/m" replace />} />
          <Route path="/marketing-management/*" element={<Navigate to="/m" replace />} />
          {/* Standalone Project Finder — structured-field discovery tool, no client required. */}
          <Route path="/project-finder" element={<RequirePageAccess pageId="project_finder"><ProjectFinderPage /></RequirePageAccess>} />
          {/* Financing calculator. Query params let a client / project / unit
              page deep-link straight into a pre-filled scenario. */}
          <Route path="/financing" element={<RequirePageAccess pageId="financing_calculator"><FinancingPage /></RequirePageAccess>} />
          {/* Marketing content writer — project-grounded social/brochure posts. */}
          <Route path="/marketing/posts" element={<RequirePageAccess pageId="posts_content"><PostsContentPage /></RequirePageAccess>} />
          <Route path="/model/:modelName" element={<RecordListDispatcher />} />
          <Route path="/model/:modelName/new" element={<RecordNewDispatcher />} />
          {/* Full-page Suggested Projects finder, scoped to a follow-up (same tab;
              "Done" returns to the follow-up record). Must precede the generic
              :recordId detail route. */}
          <Route path="/model/followups/:recordId/projects" element={<SuggestedProjectsPage />} />
          {/* Same finder, scoped to a CLIENT directly (from the Client 360 header;
              "Done" returns to the client profile). Also precedes the generic route. */}
          <Route path="/model/clients/:recordId/projects" element={<ClientProjectsPage />} />
          <Route path="/model/:modelName/:recordId" element={<RecordDetailDispatcher />} />
          <Route path="/builder" element={<RequireAdmin><ModelBuilderPage /></RequireAdmin>} />
          <Route path="/builder/agent" element={<RequireAdmin><BuilderAgentPage /></RequireAdmin>} />
          <Route path="/builder/:modelId" element={<RequireAdmin><ModelBuilderPage /></RequireAdmin>} />
          <Route path="/workflow" element={<RequireAdmin><WorkflowListPage /></RequireAdmin>} />
          <Route path="/workflow/agent" element={<RequireAdmin><WorkflowAgentPage /></RequireAdmin>} />
          {/* Run history is viewable by workflow-view profiles (read-only);
              the Builder/list/agent routes below stay admin-only. */}
          <Route path="/workflow/logs" element={<RequireWorkflowView><WorkflowLogsPage /></RequireWorkflowView>} />
          <Route path="/workflow/logs/:runId" element={<RequireWorkflowView><WorkflowRunDetailPage /></RequireWorkflowView>} />
          {/* Editor opens read-only for workflow-view profiles (admins edit).
              The page + canvas render disabled for non-admins; RLS also blocks
              any write. The list / agent routes above stay admin-only. */}
          <Route path="/workflow/:workflowId" element={<RequireWorkflowView><WorkflowEditorPage /></RequireWorkflowView>} />
          <Route path="/dashboards" element={<RequireAdmin><DashboardListPage /></RequireAdmin>} />
          <Route path="/dashboards/:dashboardId" element={<RequireAdmin><DashboardEditorPage /></RequireAdmin>} />
          <Route path="/scheduled-reports" element={<RequireAdmin><ScheduledReportsPage /></RequireAdmin>} />
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
          <Route path="/settings/audit-log" element={<RequireAdmin><AuditLogPage /></RequireAdmin>} />
          <Route path="/settings/geo-elements" element={<RequireAdmin><GeoElementsPage /></RequireAdmin>} />
          <Route path="/settings/marketing-ops" element={<RequireAdmin><MarketingOpsPage /></RequireAdmin>} />
          <Route path="/settings/content-intelligence" element={<RequireAdmin><ContentIntelligencePage /></RequireAdmin>} />
          <Route path="/settings/marketing-advertisers" element={<RequireAdmin><MarketingAdvertisersPage /></RequireAdmin>} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/settings/menu" element={<RequireAdmin><MenuArrangementPage /></RequireAdmin>} />
          <Route path="/settings/webhooks" element={<RequireAdmin><WebhookSlugsPage /></RequireAdmin>} />
          <Route path="/settings/whatsapp-numbers" element={<RequireAdmin><WhatsAppNumbersPage /></RequireAdmin>} />
          <Route path="/settings/whatsapp-ai" element={<RequireAdmin><WhatsAppAiPage /></RequireAdmin>} />
          <Route path="/settings/whatsapp-permissions" element={<RequireAdmin><WhatsAppPermissionsPage /></RequireAdmin>} />
          <Route path="/settings/document-templates" element={<RequireAdmin><DocumentTemplatesPage /></RequireAdmin>} />
          <Route path="/settings/website" element={<RequireAdmin><WebsiteSettingsPage /></RequireAdmin>} />
          <Route path="/settings/project-details" element={<RequireAdmin><ProjectDetailsListPage /></RequireAdmin>} />
          <Route path="/settings/project-details/:projectId" element={<RequireAdmin><ProjectDetailsBridgePage /></RequireAdmin>} />
          <Route path="/logs" element={<RequireAdmin><LogsPage /></RequireAdmin>} />
        </Route>

        {/* ── The Marketing workspace ────────────────────────────────────
            Mounted OUTSIDE AppLayout on purpose: it brings its own shell,
            rail, header and design system, and the Sales workspace is left
            exactly as it was. Same auth gate, same page-access id, so
            nobody's permissions have to be re-granted. */}
        <Route
          element={
            <RequireAuth>
              {/* Same page-access id as the shared guard, but it renders the
                  workspace shell while the store boots instead of a blank
                  page — there is no surrounding layout here to fill it. */}
              <RequireMarketingWorkspace>
                <MarketingWorkspace />
              </RequireMarketingWorkspace>
            </RequireAuth>
          }
        >
          <Route path="/m" element={<MarketingOverviewPage />} />
          <Route path="/m/my-work" element={<MarketingWorkPage />} />
          <Route path="/m/team" element={<MarketingTeamPage />} />
          <Route path="/m/search" element={<MarketingSearchPage />} />
          <Route path="/m/content" element={<MarketingContentListPage />} />
          <Route path="/m/content/:contentId" element={<MarketingContentDetailPage />} />
          <Route path="/m/calendar" element={<MarketingCalendarPage />} />
          <Route path="/m/library" element={<MarketingAssetLibrary />} />
          <Route path="/m/library/upload" element={<MarketingUploadPage />} />
          <Route path="/m/library/unused" element={<MarketingLibraryUnusedPage />} />
          <Route path="/m/library/:assetId" element={<MarketingAssetDetailPage />} />
          <Route path="/m/shoots" element={<MarketingShootsPage />} />
          <Route path="/m/shoots/:requestId" element={<MarketingShootRequestPage />} />
          <Route path="/m/account" element={<MarketingAccountPage />} />
          <Route path="/m/goals" element={<MarketingGoalsPage />} />
          <Route path="/m/campaigns" element={<MarketingCampaignsPage />} />
          <Route path="/m/campaigns/:campaignId" element={<MarketingCampaignDetailPage />} />
          {/* The bottom layer — screen 21. Literal "exec" segment keeps it
              from ever being read as a campaign id. */}
          <Route path="/m/campaigns/:campaignId/exec/:executionId" element={<MarketingExecutionDetailPage />} />
          <Route path="/m/numbers" element={<MarketingNumbersPage />} />
          <Route path="/m/organic" element={<MarketingOrganicPulsePage />} />
          <Route path="/m/publishing" element={<MarketingPublishingBoardPage />} />
          <Route path="/m/settings" element={<MarketingSettingsPage />} />
          <Route path="/m/settings/:section" element={<SettingsSectionPage />} />
          {/* A wrong /m/* path lands on the workspace's own front door rather
              than on a blank screen inside a shell that already rendered. */}
          <Route path="/m/*" element={<Navigate to="/m" replace />} />
        </Route>
      </Routes>
      </Suspense>
      <ToastContainer />
      <UpdateBanner />
    </BrowserRouter>
  );
}
