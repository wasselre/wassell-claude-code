import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import GlobalChatComposer from '@/pages/Chats/components/GlobalChatComposer';
import JobsIndicator from '@/components/JobsIndicator';
import SalesNotifications from '@/components/SalesNotifications';

export default function AppLayout() {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);

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
        <main className="px-4 md:px-8 py-6">
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
