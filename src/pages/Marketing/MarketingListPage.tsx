import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Megaphone } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import StatusBadge from './components/StatusBadge';
import CreateOperationModal from './components/CreateOperationModal';
import type { MarketingOperation } from '@/types';

export default function MarketingListPage() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const operations = useAppStore((s) => s.marketingOperations);
  const reels = useAppStore((s) => s.reels);
  const posts = useAppStore((s) => s.posts);

  const [modalOpen, setModalOpen] = useState(false);

  const allProjectsModel = useMemo(() => models.find((m) => m.name === 'all_projects'), [models]);
  const allProjectRecords = useMemo(
    () => (allProjectsModel ? records[allProjectsModel.id] ?? [] : []),
    [allProjectsModel, records],
  );
  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of allProjectRecords) {
      const name =
        (r.data.project_name as string | undefined) ??
        (r.data.name as string | undefined) ??
        r.id;
      map.set(r.id, name);
    }
    return map;
  }, [allProjectRecords]);

  const sorted = useMemo(
    () => [...operations].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    [operations],
  );

  return (
    <div className="p-6 md:p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">
            {isAr ? 'العمليات التسويقية' : 'Marketing Operations'}
          </h1>
          <p className="text-sm text-charcoal/60 mt-1">
            {isAr
              ? 'إنشاء ومراجعة الريلز والمنشورات للمشاريع'
              : 'Create and review reels and posts for your projects'}
          </p>
        </div>
        <Button onClick={() => setModalOpen(true)}>
          <Plus size={16} />
          {isAr ? 'عملية جديدة' : 'New Operation'}
        </Button>
      </div>

      {sorted.length === 0 ? (
        <EmptyState isAr={isAr} onCreate={() => setModalOpen(true)} />
      ) : (
        <div className="bg-white rounded-xl border border-sand/50 overflow-hidden">
          <table className="w-full">
            <thead className="bg-cream/50 border-b border-sand/50">
              <tr>
                <Th>{isAr ? 'المشروع' : 'Project'}</Th>
                <Th>{isAr ? 'الحالة' : 'Status'}</Th>
                <Th>{isAr ? 'الريلز' : 'Reels'}</Th>
                <Th>{isAr ? 'المنشورات' : 'Posts'}</Th>
                <Th>{isAr ? 'تاريخ الإنشاء' : 'Created'}</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((op) => (
                <Row
                  key={op.id}
                  op={op}
                  projectName={projectNameById.get(op.project_record_id) ?? '—'}
                  reelsProgress={progress(reels, op.id, op.reels_settings?.count)}
                  postsProgress={progress(posts, op.id, op.posts_settings?.count)}
                  isAr={isAr}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateOperationModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}

function EmptyState({ isAr, onCreate }: { isAr: boolean; onCreate: () => void }) {
  return (
    <div className="bg-white rounded-xl border border-sand/50 p-16 text-center">
      <div className="w-16 h-16 rounded-full bg-copper/10 flex items-center justify-center mx-auto mb-4">
        <Megaphone size={28} className="text-copper" />
      </div>
      <h2 className="text-lg font-bold text-charcoal mb-1">
        {isAr ? 'لا توجد عمليات تسويقية بعد' : 'No marketing operations yet'}
      </h2>
      <p className="text-sm text-charcoal/60 mb-5">
        {isAr
          ? 'ابدأ بإنشاء عملية جديدة لاختيار مشروع وتوليد الريلز والمنشورات'
          : 'Start by creating a new operation — pick a project and generate reels and posts.'}
      </p>
      <Button onClick={onCreate}>
        <Plus size={16} />
        {isAr ? 'عملية جديدة' : 'New Operation'}
      </Button>
    </div>
  );
}

interface RowProps {
  op: MarketingOperation;
  projectName: string;
  reelsProgress: string;
  postsProgress: string;
  isAr: boolean;
}

function Row({ op, projectName, reelsProgress, postsProgress, isAr }: RowProps) {
  const locale = isAr ? 'ar-SA' : 'en-US';
  const date = new Date(op.created_at).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return (
    <tr className="border-b border-sand/30 hover:bg-cream/30 transition-colors">
      <td className="px-4 py-3 text-sm">
        <Link to={`/marketing/${op.id}`} className="font-semibold text-charcoal hover:text-copper">
          {projectName}
        </Link>
      </td>
      <td className="px-4 py-3"><StatusBadge status={op.status} /></td>
      <td className="px-4 py-3 text-sm text-charcoal/70">{reelsProgress}</td>
      <td className="px-4 py-3 text-sm text-charcoal/70">{postsProgress}</td>
      <td className="px-4 py-3 text-sm text-charcoal/60">{date}</td>
    </tr>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-start px-4 py-3 text-xs font-bold text-charcoal/60 uppercase tracking-wider">
      {children}
    </th>
  );
}

function progress(rows: { operation_id: string; status: string }[], operationId: string, expected?: number): string {
  if (!expected) return '—';
  const mine = rows.filter((r) => r.operation_id === operationId);
  const done = mine.filter((r) => ['draft_ready', 'approved', 'published'].includes(r.status)).length;
  return `${done}/${expected}`;
}
