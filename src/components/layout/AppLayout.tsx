import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import ResearchPromptModal from '@/components/ResearchPromptModal';

export default function AppLayout() {
  return (
    <div className="min-h-screen bg-cream-light">
      <Sidebar />
      <div className="main-content">
        <Header />
        <main className="px-8 py-6">
          <Outlet />
        </main>
      </div>
      <ResearchPromptModal />
    </div>
  );
}
