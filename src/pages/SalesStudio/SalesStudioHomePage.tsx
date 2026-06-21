import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layers, Plus, FlaskConical, Activity } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useIsAdmin } from '@/hooks/usePermission';
import type { SalesProcess } from '@/types';
import ProcessCard from './components/ProcessCard';
import CreateProcessModal from './components/CreateProcessModal';

/**
 * Sales Studio 2.0 home — the Process Library. Lists every Sales Process with
 * its funnel rollup + actions, and seeds the Default Sales Process on first open
 * (admin only). The strategy layer entry point.
 */
export default function SalesStudioHomePage() {
  const { language, salesProcesses, seedDefaultSalesProcess, initialized } = useAppStore();
  const isAr = language === 'ar';
  const isAdmin = useIsAdmin();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [dupSource, setDupSource] = useState<SalesProcess | null>(null);

  // Seed the default process the first time an admin opens Studio (idempotent —
  // the store no-ops when processes already exist; the DB unique index backs it up).
  useEffect(() => {
    if (initialized && isAdmin && salesProcesses.length === 0) {
      seedDefaultSalesProcess();
    }
  }, [initialized, isAdmin, salesProcesses.length, seedDefaultSalesProcess]);

  const ordered = useMemo(
    () => [...salesProcesses].sort((a, b) => {
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
      const rank = (s: string) => (s === 'active' ? 0 : s === 'draft' ? 1 : 2);
      if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
      return (isAr ? a.name_ar : a.name_en).localeCompare(isAr ? b.name_ar : b.name_en);
    }),
    [salesProcesses, isAr],
  );

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-copper-50 text-copper">
            <Layers size={22} />
          </span>
          <div>
            <h1 className="text-2xl font-bold text-chocolate">{isAr ? 'استوديو المبيعات' : 'Sales Studio'}</h1>
            <p className="mt-0.5 text-sm text-charcoal/60">
              {isAr ? 'طبقة استراتيجية المبيعات — صمّم المسارات وجرّبها وقِس أداءها' : 'The sales strategy layer — design processes, experiment, and measure'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate('/sales/studio/experiments')}
            className="inline-flex items-center gap-2 rounded-xl border border-sand/40 bg-white px-4 py-2.5 text-sm font-bold text-charcoal hover:bg-cream"
          >
            <FlaskConical size={16} className="text-copper" /> {isAr ? 'التجارب' : 'Experiments'}
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={() => { setDupSource(null); setCreateOpen(true); }}
              className="inline-flex items-center gap-2 rounded-xl bg-copper px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-terracotta"
            >
              <Plus size={16} /> {isAr ? 'مسار جديد' : 'Create Process'}
            </button>
          )}
        </div>
      </header>

      {ordered.length === 0 ? (
        <div className="card flex flex-col items-center justify-center gap-3 rounded-2xl p-12 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-copper/10 text-copper"><Activity size={28} /></span>
          <h2 className="text-lg font-bold text-chocolate">{isAr ? 'لا توجد مسارات بعد' : 'No sales processes yet'}</h2>
          <p className="max-w-md text-sm text-charcoal/55">
            {isAr
              ? 'سيظهر «مسار المبيعات الافتراضي» تلقائيًا. إن لم يظهر، أنشئ مسارًا جديدًا.'
              : 'The Default Sales Process will appear automatically. If it doesn’t, create a new one.'}
          </p>
          {isAdmin && (
            <button type="button" onClick={() => setCreateOpen(true)} className="mt-2 inline-flex items-center gap-2 rounded-xl bg-copper px-4 py-2.5 text-sm font-bold text-white hover:bg-terracotta">
              <Plus size={16} /> {isAr ? 'مسار جديد' : 'Create Process'}
            </button>
          )}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {ordered.map((p) => (
            <ProcessCard key={p.id} process={p} onDuplicate={(src) => { setDupSource(src); setCreateOpen(true); }} />
          ))}
        </div>
      )}

      <CreateProcessModal open={createOpen} onClose={() => setCreateOpen(false)} source={dupSource} />
    </div>
  );
}
