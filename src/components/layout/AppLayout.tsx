import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import GlobalChatComposer from '@/pages/Chats/components/GlobalChatComposer';
import JobsIndicator from '@/components/JobsIndicator';
import SalesNotifications from '@/components/SalesNotifications';

export default function AppLayout() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);

  // Tapping a push notification focuses the existing window and posts the
  // target path here, rather than the service worker calling client.navigate()
  // — that would force a full page reload and throw away in-memory state.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | undefined;
      if (data?.type !== 'navigate' || typeof data.url !== 'string') return;
      // Only ever accept same-origin in-app paths from the worker.
      if (!data.url.startsWith('/')) return;
      navigate(data.url);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  return (
    <div className="min-h-screen bg-cream-light overflow-x-hidden">
      <Sidebar
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
      />
      {mobileSidebarOpen && (
        <div
          className="sidebar-backdrop md:hidden"
          onClick={() => setMobileSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      <div className="main-content">
        <Header onMenuClick={() => setMobileSidebarOpen(true)} />
        {/* `safe-bottom` keeps the last row of content above the home
            indicator when running standalone from the Home Screen. */}
        <main className="safe-bottom px-4 md:px-8 py-6">
          <Outlet />
        </main>
      </div>
      {/* App-level WhatsApp composer — any phone WhatsApp action opens the chat
          popup here without navigating away from the current page. */}
      <GlobalChatComposer />
      {/* Floating background-jobs circle + panel (listing messages, media
          fan-outs, …). Hidden until a job exists. */}
      <JobsIndicator />
      {/* Pop-up notifications for hot new leads + customer replies (toast +
          browser Notification). Renders nothing. */}
      <SalesNotifications />
    </div>
  );
}
