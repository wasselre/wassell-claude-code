/**
 * Market Registry section — the full existing project-list experience
 * (ProjectsListPage: search, grid/list/map, filters, bulk select, position
 * badges) with a small sub-toggle to the read-only Sourcing Opportunities view.
 * Sourcing is a VIEW here, not a top-level sidebar destination (spec §3).
 */
import { useState } from 'react';
import { Building2, Compass } from 'lucide-react';
import ProjectsListPage from '@/pages/Projects/ProjectsListPage';
import SourcingView from './SourcingView';

type RegView = 'projects' | 'sourcing';

export default function MarketRegistrySection({ isAr }: { isAr: boolean }) {
  const [view, setView] = useState<RegView>('projects');

  const Toggle = ({ id, icon, ar, en }: { id: RegView; icon: React.ReactNode; ar: string; en: string }) => (
    <button
      onClick={() => setView(id)}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium inline-flex items-center gap-1.5 transition-colors ${
        view === id ? 'bg-copper text-white' : 'text-charcoal/60 hover:bg-cream'
      }`}
    >
      {icon}
      {isAr ? ar : en}
    </button>
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Toggle id="projects" icon={<Building2 size={15} />} ar="المشاريع" en="Projects" />
        <Toggle id="sourcing" icon={<Compass size={15} />} ar="فرص المصادر" en="Sourcing" />
      </div>
      {view === 'projects' ? <ProjectsListPage /> : <SourcingView isAr={isAr} />}
    </div>
  );
}
