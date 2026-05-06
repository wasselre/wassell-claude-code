import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';

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
    </div>
  );
}
